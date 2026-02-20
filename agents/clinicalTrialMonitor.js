import { supabase } from '../lib/supabase.js'

const CLINICALTRIALS_API = 'https://clinicaltrials.gov/api/v2/studies'

const SIGNAL_SCORES = {
  clinical_trial_phase_transition: 30,
  clinical_trial_new_ind: 22,
  clinical_trial_site_activation: 25,
  clinical_trial_completion: 20,
}

const WARMTH_SCORES = {
  active_client: 25,
  past_client: 18,
  in_ats: 10,
  new_prospect: 0,
}

// Only include INDUSTRY-sponsored studies. Universities, NIH, NCI, VA, DoD,
// and other government/academic sponsors are excluded — our firm only staffs
// into private-sector Life Sciences companies.
const INDUSTRY_ONLY = true

function calculatePriorityScore(signalType, isToday, warmth) {
  const signalStrength = SIGNAL_SCORES[signalType] || 15
  const recency = isToday ? 25 : 0
  const warmthScore = WARMTH_SCORES[warmth] || 0
  return Math.min(signalStrength + recency + warmthScore, 100)
}

async function upsertCompany(sponsorName) {
  if (!sponsorName) return null

  const { data: existing } = await supabase
    .from('companies')
    .select('id, relationship_warmth')
    .ilike('name', sponsorName)
    .maybeSingle()

  if (existing) return existing

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({ name: sponsorName, industry: 'Life Sciences', relationship_warmth: 'new_prospect' })
    .select('id, relationship_warmth')
    .single()

  if (error) {
    console.warn(`Failed to insert company "${sponsorName}": ${error.message}`)
    return null
  }
  return newCompany
}

async function signalExists(companyId, signalType, sourceUrl) {
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', signalType)
    .eq('source_url', sourceUrl)
    .maybeSingle()
  return !!data
}

// ─── Extraction helpers ────────────────────────────────────────────────────────

function extractSponsor(study) {
  const sponsor = study?.protocolSection?.sponsorCollaboratorsModule?.leadSponsor || {}
  return {
    name: sponsor.name || null,
    class: sponsor.class || null, // 'INDUSTRY' | 'NIH' | 'OTHER_GOV' | 'FED' | 'INDIV' | 'OTHER' | 'UNKNOWN'
  }
}

function extractPhase(study) {
  return study?.protocolSection?.designModule?.phases || []
}

function extractNLocations(study) {
  return study?.protocolSection?.contactsLocationsModule?.locations?.length || 0
}

function extractPrimaryCompletionDate(study) {
  return study?.protocolSection?.statusModule?.primaryCompletionDateStruct?.date || null
}

function extractLastUpdateDate(study) {
  return study?.protocolSection?.statusModule?.lastUpdatePostDateStruct?.date || null
}

function extractNctId(study) {
  return study?.protocolSection?.identificationModule?.nctId || null
}

function extractTitle(study) {
  return (
    study?.protocolSection?.identificationModule?.briefTitle ||
    study?.protocolSection?.identificationModule?.officialTitle ||
    'Unknown Study'
  )
}

function extractStudyStatus(study) {
  return study?.protocolSection?.statusModule?.overallStatus || ''
}

// Infer phase_from based on current phase (what phase came before)
function inferPhaseFrom(phases) {
  if (phases.includes('PHASE3')) return 'Phase 2'
  if (phases.includes('PHASE2')) return 'Phase 1'
  if (phases.includes('PHASE4')) return 'Phase 3'
  return 'Unknown'
}

// Build a one-sentence study summary from title (briefTitle is already concise)
function buildStudySummary(study) {
  const title = extractTitle(study)
  // ClinicalTrials brief titles are typically descriptive enough; just return them
  return title.length > 120 ? title.slice(0, 117) + '...' : title
}

// ─── API fetch ─────────────────────────────────────────────────────────────────

async function fetchStudies(pageToken = null) {
  // Compute 14-day date range with actual ISO dates (Essie TODAY-14D syntax is invalid)
  const today = new Date().toISOString().split('T')[0]
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const params = new URLSearchParams({
    format: 'json',
    pageSize: '100',
    fields: [
      'NCTId',
      'BriefTitle',
      'OfficialTitle',
      'OverallStatus',
      'Phase',
      'SponsorsAndCollaborators', // includes leadSponsor.name AND leadSponsor.class
      'LastUpdatePostDate',        // lastUpdatePostDateStruct.date
      'PrimaryCompletionDate',
      'ContactsLocationsModule',
    ].join(','),
  })

  // INDUSTRY sponsors only: filter at API level for study type + 14-day recency.
  // Sponsor class filter is applied in code after fetch (more reliable than Essie).
  params.set('filter.overallStatus', 'RECRUITING,ACTIVE_NOT_RECRUITING')
  params.set('filter.advanced', `AREA[StudyType]INTERVENTIONAL AND AREA[LastUpdatePostDate]RANGE[${fourteenDaysAgo},${today}]`)

  if (pageToken) {
    params.set('pageToken', pageToken)
  }

  const url = `${CLINICALTRIALS_API}?${params.toString()}`
  const resp = await fetch(url, { headers: { Accept: 'application/json' } })

  if (!resp.ok) {
    throw new Error(`ClinicalTrials API error ${resp.status}: ${await resp.text()}`)
  }

  const json = await resp.json()
  return { studies: json.studies || [], nextPageToken: json.nextPageToken || null, totalCount: json.totalCount }
}

// ─── Signal classification ─────────────────────────────────────────────────────

function classifyStudy(study) {
  const signals = []
  const phases = extractPhase(study)
  const nLocations = extractNLocations(study)
  const primaryCompletionDate = extractPrimaryCompletionDate(study)
  const status = extractStudyStatus(study)
  const today = new Date()
  const nctId = extractNctId(study)
  const title = extractTitle(study)
  const dateUpdated = extractLastUpdateDate(study)
  const studySummary = buildStudySummary(study)

  // ── Phase transition: Phase 2 or Phase 3 study updated in last 14 days ──────
  // Treat Phase 2 study as potential Phase 1→2 transition.
  // Treat Phase 3 study as potential Phase 2→3 transition.
  if (phases.includes('PHASE2') || phases.includes('PHASE3') || phases.includes('PHASE4')) {
    const phaseTo = phases.includes('PHASE4') ? 'Phase 4' : phases.includes('PHASE3') ? 'Phase 3' : 'Phase 2'
    const phaseFrom = inferPhaseFrom(phases)
    signals.push({
      type: 'clinical_trial_phase_transition',
      summary: `Phase transition detected: ${phaseFrom} → ${phaseTo} for ${extractTitle(study)}`,
      detail_extra: { phase_from: phaseFrom, phase_to: phaseTo, date_updated: dateUpdated, study_summary: studySummary },
    })
  }

  // ── New IND: Phase 1 study (no Phase 2 co-listed) ───────────────────────────
  if (phases.includes('PHASE1') && !phases.includes('PHASE2')) {
    signals.push({
      type: 'clinical_trial_new_ind',
      summary: `New Phase 1 IND study: ${title}`,
      detail_extra: { date_updated: dateUpdated, study_summary: studySummary },
    })
  }

  // ── Site activation: > 10 locations ─────────────────────────────────────────
  if (nLocations > 10) {
    signals.push({
      type: 'clinical_trial_site_activation',
      summary: `Study activating ${nLocations} sites: ${title}`,
      detail_extra: { n_locations: nLocations, date_updated: dateUpdated, study_summary: studySummary },
    })
  }

  // ── Completion: primary completion within 90 days ────────────────────────────
  if (primaryCompletionDate) {
    const completionDate = new Date(primaryCompletionDate)
    const daysUntilCompletion = Math.floor((completionDate - today) / (1000 * 60 * 60 * 24))
    if (daysUntilCompletion >= 0 && daysUntilCompletion <= 90) {
      signals.push({
        type: 'clinical_trial_completion',
        summary: `Trial completing in ${daysUntilCompletion} days: ${title}`,
        detail_extra: {
          days_until_completion: daysUntilCompletion,
          primary_completion_date: primaryCompletionDate,
          date_updated: dateUpdated,
          study_summary: studySummary,
        },
      })
    }
  }

  return signals
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function runClinicalTrialMonitor() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'clinical_trial_monitor', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    let pageToken = null
    let pagesFetched = 0
    let studiesProcessed = 0
    let studiesSkippedNonIndustry = 0
    let studiesWithSignals = 0

    // 2 pages × 100 studies = ~200 studies per run.
    // Keeps total DB calls within Vercel serverless timeout (~16s).
    const MAX_PAGES = 2

    // In-run company cache: skip redundant SELECT for same sponsor across studies.
    const companyCache = new Map()

    async function getOrUpsertCompany(sponsorName) {
      if (companyCache.has(sponsorName)) return companyCache.get(sponsorName)
      const company = await upsertCompany(sponsorName)
      if (company) companyCache.set(sponsorName, company)
      return company
    }

    do {
      const { studies, nextPageToken, totalCount } = await fetchStudies(pageToken)
      if (pagesFetched === 0) {
        console.log(`Clinical Trial Monitor: API returned ${totalCount ?? '?'} total studies matching 14-day filter`)
      }
      pageToken = nextPageToken
      pagesFetched++
      studiesProcessed += studies.length

      for (const study of studies) {
        const sponsor = extractSponsor(study)
        if (!sponsor.name) continue

        // ── INDUSTRY-only filter ──────────────────────────────────────────────
        // If class is returned and is NOT INDUSTRY, skip (university/gov).
        // If class is null (field not returned), allow through conservatively.
        if (INDUSTRY_ONLY && sponsor.class && sponsor.class !== 'INDUSTRY') {
          studiesSkippedNonIndustry++
          continue
        }

        const nctId = extractNctId(study)
        const title = extractTitle(study)
        const signals = classifyStudy(study)

        if (signals.length === 0) continue
        studiesWithSignals++

        const company = await getOrUpsertCompany(sponsor.name)
        if (!company) continue

        for (const sig of signals) {
          const sourceUrl = nctId
            ? `https://clinicaltrials.gov/study/${nctId}`
            : 'https://clinicaltrials.gov'

          const alreadyExists = await signalExists(company.id, sig.type, sourceUrl)
          if (alreadyExists) continue

          const priorityScore = calculatePriorityScore(sig.type, true, company.relationship_warmth)

          const { error: insertError } = await supabase.from('signals').insert({
            company_id: company.id,
            signal_type: sig.type,
            signal_summary: sig.summary,
            signal_detail: {
              company_name: sponsor.name,
              nct_id: nctId,
              source_url: sourceUrl,
              // Phase transition specific fields
              ...(sig.detail_extra || {}),
              // Always include base fields
              phases: extractPhase(study),
              n_locations: extractNLocations(study),
              primary_completion_date: extractPrimaryCompletionDate(study),
            },
            source_url: sourceUrl,
            source_name: 'ClinicalTrials.gov',
            first_detected_at: new Date().toISOString(),
            status: 'new',
            priority_score: priorityScore,
            score_breakdown: {
              signal_strength: SIGNAL_SCORES[sig.type] || 15,
              recency: 25,
              relationship_warmth: WARMTH_SCORES[company.relationship_warmth] || 0,
              actionability: 0,
            },
            days_in_queue: 0,
            is_carried_forward: false,
          })

          if (!insertError) {
            signalsFound++
          } else {
            console.warn(`Signal insert failed: ${insertError.message}`)
          }
        }
      }

      if (pageToken && pagesFetched < MAX_PAGES) {
        await new Promise((r) => setTimeout(r, 200))
      }
    } while (pageToken && pagesFetched < MAX_PAGES)

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          pages_fetched: pagesFetched,
          studies_processed: studiesProcessed,
          studies_with_signals: studiesWithSignals,
          studies_skipped_non_industry: studiesSkippedNonIndustry,
        },
      })
      .eq('id', runId)

    console.log(`Clinical Trial Monitor complete. Signals: ${signalsFound} (skipped ${studiesSkippedNonIndustry} non-industry)`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Clinical Trial Monitor failed:', error.message)
    return { success: false, error: error.message }
  }
}
