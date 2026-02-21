/**
 * One-time backfill endpoint: re-queries ClinicalTrials.gov for all existing
 * clinical_trial_phase_transition signals and updates signal_detail with
 * correct phase_from, phase_to, and all other required fields.
 *
 * Run once after deployment: GET /api/backfill-clinical-phases
 * Idempotent — safe to call multiple times.
 */

import { supabase } from '../../lib/supabase.js'

const CT_API_BASE = 'https://clinicaltrials.gov/api/v2/studies'

// Normalize a stored phase label to the new readable format
function normalizePhaseLabel(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (/^PHASE(\d+)$/i.test(s)) return s.replace(/PHASE(\d+)/i, 'Phase $1')
  if (/^PRE[-_]CLINICAL$/i.test(s)) return 'Pre-Clinical'
  return s // already in new format
}

// Convert CT.gov phases array to human-readable label
function phasesArrayToLabel(phases) {
  if (!phases || phases.length === 0) return null

  const phaseMap = { PHASE1: 1, PHASE2: 2, PHASE3: 3, PHASE4: 4 }
  const normalised = phases.map((p) => p.toUpperCase().replace(/\s/g, ''))

  if (normalised.length === 1) {
    const n = phaseMap[normalised[0]]
    return n !== undefined ? `Phase ${n}` : normalised[0].replace(/^PHASE/i, 'Phase ')
  }

  return 'Phase ' + normalised.map((p) => phaseMap[p] ?? p.replace(/^PHASE/i, '')).join('/')
}

function inferPreviousPhase(phaseLabel) {
  if (!phaseLabel) return 'Pre-Clinical'
  const match = phaseLabel.match(/Phase (\d+)/)
  if (!match) return 'Pre-Clinical'
  const num = parseInt(match[1], 10)
  const prev = { 2: 'Phase 1', 3: 'Phase 2', 4: 'Phase 3' }
  return prev[num] || 'Pre-Clinical'
}

async function fetchStudyFromCT(nctId) {
  const fields = [
    'NCTId', 'BriefTitle', 'LeadSponsorName', 'LeadSponsorClass',
    'Phase', 'LastUpdatePostDate', 'OverallStatus',
    'LocationCount', 'EnrollmentCount', 'ConditionMeshTerm',
  ].join(',')

  const params = new URLSearchParams({ fields })
  const url = `${CT_API_BASE}/${nctId}?${params}`

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

function extractStudyDetail(study, nctId) {
  if (!study) return null

  const proto = study.protocolSection || {}
  const id = proto.identificationModule || {}
  const sponsor = proto.sponsorCollaboratorsModule || {}
  const status = proto.statusModule || {}
  const design = proto.designModule || {}
  const conditions = proto.conditionsModule || {}
  const interventions = proto.armsInterventionsModule || {}
  const contacts = proto.contactsLocationsModule || {}

  const leadSponsor = sponsor.leadSponsor || {}
  const phases = design.phases || []
  const meshTerms = conditions.meshes || []

  const conditionMeshTerm =
    meshTerms.length > 0
      ? meshTerms.map((m) => m.term)
      : conditions.conditions || []

  const primaryIntervention =
    (interventions.interventions || []).length > 0
      ? interventions.interventions[0].name
      : null

  let locationCount = 0
  if (typeof study.locationCount === 'number') {
    locationCount = study.locationCount
  } else if (Array.isArray(contacts.locations)) {
    locationCount = contacts.locations.length
  }

  const therapeuticArea =
    conditionMeshTerm.length > 0
      ? conditionMeshTerm[0]
      : (id.officialTitle || id.briefTitle || '').substring(0, 120)

  const studySummary = (() => {
    const condition = conditionMeshTerm[0] || id.briefTitle || 'an undisclosed indication'
    const intervention = primaryIntervention || 'an investigational agent'
    return `${condition} evaluating ${intervention}`
  })()

  const phaseLabel = phasesArrayToLabel(phases)
  const phaseFrom = inferPreviousPhase(phaseLabel)

  return {
    company_name: leadSponsor.name || '',
    sponsor_class: leadSponsor.class || 'INDUSTRY',
    phase_from: phaseFrom,
    phase_to: phaseLabel,
    date_updated: status.lastUpdatePostDateStruct?.date || null,
    study_summary: studySummary,
    nct_id: id.nctId || nctId,
    therapeutic_area: therapeuticArea,
    enrollment_count: design.enrollmentInfo?.count || null,
    num_sites: locationCount,
    source_url: `https://clinicaltrials.gov/study/${id.nctId || nctId}`,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fetch all clinical trial phase_transition signals
  const { data: signals, error: fetchError } = await supabase
    .from('signals')
    .select('id, signal_detail, source_url')
    .in('signal_type', [
      'clinical_trial_phase_transition',
      'clinical_trial_new_ind',
      'clinical_trial_site_activation',
      'clinical_trial_completion',
    ])

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message })
  }

  const results = {
    total: signals.length,
    updated: 0,
    normalized_only: 0,
    skipped_no_nct: 0,
    skipped_ct_error: 0,
    errors: [],
  }

  for (const signal of signals) {
    let detail = signal.signal_detail
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail) } catch { detail = {} }
    }
    detail = detail || {}

    // Extract NCT ID from signal_detail or source_url
    let nctId = detail.nct_id
    if (!nctId && signal.source_url) {
      const match = signal.source_url.match(/NCT\d{8}/i)
      if (match) nctId = match[0]
    }

    if (!nctId) {
      results.skipped_no_nct++
      continue
    }

    // Check if phase_from/phase_to are missing or in old format
    const phaseFromOld = !detail.phase_from || /^PHASE\d+$/i.test(detail.phase_from) || /^PRE.CLINICAL$/i.test(detail.phase_from)
    const phaseToOld = !detail.phase_to || /^PHASE\d+$/i.test(detail.phase_to)

    if (!phaseFromOld && !phaseToOld && detail.therapeutic_area && detail.study_summary) {
      // Data looks complete and in new format — no update needed
      continue
    }

    // If only format normalization needed (no CT.gov fetch required)
    if (!phaseFromOld && !phaseToOld) {
      // Just normalize format
      const updated = {
        ...detail,
        phase_from: normalizePhaseLabel(detail.phase_from),
        phase_to: normalizePhaseLabel(detail.phase_to),
      }
      const { error } = await supabase
        .from('signals')
        .update({ signal_detail: updated })
        .eq('id', signal.id)

      if (!error) results.normalized_only++
      else results.errors.push({ id: signal.id, error: error.message })
      continue
    }

    // Re-query ClinicalTrials.gov for complete data
    const study = await fetchStudyFromCT(nctId)
    if (!study) {
      // CT.gov fetch failed — at minimum normalize the format
      const fallbackDetail = {
        ...detail,
        phase_from: normalizePhaseLabel(detail.phase_from) || 'Pre-Clinical',
        phase_to: normalizePhaseLabel(detail.phase_to) || '?',
        nct_id: nctId,
      }
      const { error } = await supabase
        .from('signals')
        .update({ signal_detail: fallbackDetail })
        .eq('id', signal.id)

      if (error) results.errors.push({ id: signal.id, error: error.message })
      else results.skipped_ct_error++
      continue
    }

    const freshDetail = extractStudyDetail(study, nctId)
    if (!freshDetail) {
      results.skipped_ct_error++
      continue
    }

    // Preserve rep_notes if present
    const mergedDetail = {
      ...freshDetail,
      ...(detail.rep_notes ? { rep_notes: detail.rep_notes } : {}),
    }

    const { error: updateError } = await supabase
      .from('signals')
      .update({ signal_detail: mergedDetail })
      .eq('id', signal.id)

    if (updateError) {
      results.errors.push({ id: signal.id, nct_id: nctId, error: updateError.message })
    } else {
      results.updated++
      console.log(
        `[backfill] Updated ${signal.id} (${nctId}): phase_from="${freshDetail.phase_from}", phase_to="${freshDetail.phase_to}"`
      )
    }

    // Brief pause to avoid hammering CT.gov
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log('[backfill] Completed:', JSON.stringify(results))
  return res.status(200).json(results)
}
