import { supabase } from '../lib/supabase.js'

// ─── Competitor firms to track ─────────────────────────────────────────────────
// careers_url stored for context / competitor_firms table
const SEED_COMPETITORS = [
  { name: 'Medpace',                  careers_url: 'https://www.medpace.com/careers/' },
  { name: 'Syneos Health',            careers_url: 'https://syneoshealth.com/careers' },
  { name: 'Fortrea',                  careers_url: 'https://careers.fortrea.com' },
  { name: 'Premier Research',         careers_url: 'https://premierresearch.com/careers' },
  { name: 'Worldwide Clinical Trials',careers_url: 'https://worldwideclinicaltrials.com/careers' },
  { name: 'ProPharma Group',          careers_url: 'https://propharmagroup.com/careers/' },
  { name: 'Advanced Clinical',        careers_url: 'https://www.advancedclinical.com/careers' },
  { name: 'Synteract',                careers_url: 'https://www.synteract.com/careers' },
  { name: 'Cytel',                    careers_url: 'https://cytel.com/about/careers' },
  { name: 'Veeva Systems',            careers_url: 'https://careers.veeva.com/' },
  { name: 'Labcorp Drug Development', careers_url: 'https://careers.labcorp.com/global/en' },
  { name: 'ICON plc',                 careers_url: 'https://careers.iconplc.com' },
  { name: 'Black Diamond Networks',   careers_url: 'https://www.blackdiamondnetworks.com/jobs' },
  { name: 'Soliant Health',           careers_url: 'https://www.soliant.com/jobs' },
  { name: 'Medix Staffing',           careers_url: 'https://medixteam.com/find-a-job' },
  { name: 'Solomon Page',             careers_url: 'https://solomonpage.com/our-disciplines/pharmaceutical-biotech' },
  { name: 'Mindlance',                careers_url: 'https://www.mindlance.com/' },
  { name: 'Green Key Resources',      careers_url: 'https://greenkeyresources.com/find-a-job' },
  { name: 'Phaidon International',    careers_url: 'https://www.phaidoninternational.com/jobs' },
  { name: 'ClinLab Staffing',         careers_url: 'https://www.clinlabstaffing.com/job-seekers' },
  { name: 'ALKU',                     careers_url: 'https://www.alku.com/jobs' },
  { name: 'Yoh Services',             careers_url: 'https://yoh.com/' },
  { name: 'Pacer Staffing',           careers_url: 'https://pacerstaffing.com/' },
  { name: 'Oxford Global Resources',  careers_url: 'https://ogcareers.com' },
  { name: 'Catalent',                 careers_url: 'https://careers.catalent.com' },
  { name: 'Spectraforce',             careers_url: 'https://spectraforce.com/' },
  { name: 'Randstad Life Sciences',   careers_url: 'https://www.randstadusa.com/jobs' },
  { name: 'Epic Staffing Group',      careers_url: 'https://epicstaffinggroup.com/' },
  { name: 'Precision Biosciences',    careers_url: 'https://www.precisionbiosciences.com/careers' },
]

// ─── ClinicalTrials.gov query search terms for each CRO ───────────────────────
// query.spons searches across sponsor + collaborator fields.
// Maps a short search term → canonical competitor firm name in SEED_COMPETITORS.
const CRO_CT_SEARCHES = [
  { query: 'Syneos Health', firmName: 'Syneos Health' },
  { query: 'ICON plc',      firmName: 'ICON plc' },
  { query: 'Fortrea',       firmName: 'Fortrea' },
  { query: 'Labcorp',       firmName: 'Labcorp Drug Development' },
  { query: 'Medpace',       firmName: 'Medpace' },
  { query: 'Premier Research', firmName: 'Premier Research' },
  { query: 'ProPharma',     firmName: 'ProPharma Group' },
]

const CLINICALTRIALS_API = 'https://clinicaltrials.gov/api/v2/studies'

const WARMTH_SCORES = { active_client: 25, past_client: 18, in_ats: 10, new_prospect: 0 }

async function upsertCompany(name) {
  if (!name || name.trim().length < 2) return null
  const cleanName = name.trim()

  const { data: existing } = await supabase
    .from('companies')
    .select('id, relationship_warmth')
    .ilike('name', cleanName)
    .maybeSingle()

  if (existing) return existing

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({ name: cleanName, industry: 'Life Sciences', relationship_warmth: 'new_prospect' })
    .select('id, relationship_warmth')
    .single()

  if (error) {
    console.warn(`Failed to insert company "${cleanName}": ${error.message}`)
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

async function seedCompetitorFirms() {
  for (const firm of SEED_COMPETITORS) {
    const { data: existing } = await supabase
      .from('competitor_firms')
      .select('id')
      .ilike('name', firm.name)
      .maybeSingle()

    if (!existing) {
      const { error } = await supabase.from('competitor_firms').insert({
        name: firm.name,
        careers_url: firm.careers_url,
        is_active: true,
      })
      if (error) console.warn(`Failed to seed ${firm.name}: ${error.message}`)
    } else {
      await supabase
        .from('competitor_firms')
        .update({ careers_url: firm.careers_url })
        .eq('id', existing.id)
    }
  }
}

// ─── SOURCE: ClinicalTrials.gov competitor intelligence ────────────────────────
// Uses query.spons to detect active RECRUITING/ACTIVE trials where a competitor
// CRO appears as sponsor or collaborator. The trial sponsor becomes the
// "likely client" — giving real BD intelligence: Syneos is working for BioMarin.

async function fetchCroTrials(cro) {
  const results = []
  try {
    const params = new URLSearchParams({
      format: 'json',
      pageSize: '10',
      fields: 'NCTId,Phase,OverallStatus,LeadSponsor,BriefTitle',
      'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING',
      'query.spons': cro.query,
    })
    params.set('filter.advanced', 'AREA[StudyType]INTERVENTIONAL')

    const resp = await fetch(`${CLINICALTRIALS_API}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })

    if (!resp.ok) {
      console.warn(`  CT.gov query "${cro.query}" returned HTTP ${resp.status}`)
      return results
    }

    const data = await resp.json()
    const studies = data.studies || []
    console.log(`  CT.gov "${cro.query}": ${studies.length} active trials`)

    for (const study of studies) {
      const ps = study.protocolSection || {}
      const nctId = ps.identificationModule?.nctId
      const phases = ps.designModule?.phases || []
      const status = ps.statusModule?.overallStatus || ''
      const sponsor = ps.sponsorCollaboratorsModule?.leadSponsor || {}
      const title = ps.identificationModule?.briefTitle || 'Unknown'

      if (!nctId) continue
      // Only Phase 2/3/4 trials are relevant for staffing signals
      if (!phases.some((p) => ['PHASE2', 'PHASE3', 'PHASE4'].includes(p))) continue
      // Skip if the sponsor IS the competitor (not useful: firm running own trial)
      if (sponsor.name && sponsor.name.toLowerCase().includes(cro.query.toLowerCase())) continue

      results.push({
        nctId,
        phases,
        status,
        sponsorName: sponsor.name || 'Unknown',
        sponsorClass: sponsor.class || 'UNKNOWN',
        title: title.length > 100 ? title.slice(0, 97) + '...' : title,
        firmName: cro.firmName,
        sourceUrl: `https://clinicaltrials.gov/study/${nctId}`,
      })
    }
  } catch (err) {
    console.warn(`  CT.gov fetch failed for "${cro.query}": ${err.message}`)
  }
  return results
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function runCompetitorJobBoardAgent() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'competitor_job_board_agent', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    await seedCompetitorFirms()

    const today = new Date().toISOString().split('T')[0]

    // Fetch active trials for all CROs in parallel
    console.log(`Competitor Job Board: querying ClinicalTrials.gov for ${CRO_CT_SEARCHES.length} CRO firms`)
    const trialSets = await Promise.all(CRO_CT_SEARCHES.map((cro) => fetchCroTrials(cro)))
    const allTrials = trialSets.flat()

    console.log(`  Found ${allTrials.length} Phase 2/3/4 trials across all CROs`)

    // Deduplicate: one signal per (competitor_firm × nctId) pair
    const seen = new Set()
    let firmsWithSignals = 0

    for (const trial of allTrials) {
      const dedupeKey = `${trial.firmName}|${trial.nctId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      // Get or create the competitor firm as a company record
      const firmCompany = await upsertCompany(trial.firmName)
      if (!firmCompany) continue

      // Dedup check: use phase-qualified URL to avoid collisions
      const phasesSuffix = trial.phases.sort().join('-')
      const sourceUrl = `${trial.sourceUrl}#competitor-${trial.firmName.replace(/\s+/g, '-').toLowerCase()}-${phasesSuffix}`
      const alreadySignaled = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
      if (alreadySignaled) continue

      const warmthScore = WARMTH_SCORES[firmCompany.relationship_warmth] || 0
      const priorityScore = Math.min(18 + 25 + warmthScore, 100)
      const phaseLabel = trial.phases.includes('PHASE3') ? 'Phase 3' : trial.phases.includes('PHASE4') ? 'Phase 4' : 'Phase 2'

      const { error: sigError } = await supabase.from('signals').insert({
        company_id: firmCompany.id,
        signal_type: 'competitor_job_posting',
        signal_summary: `${trial.firmName} running ${phaseLabel} trial for ${trial.sponsorName} — active CRO contract`,
        signal_detail: {
          job_title: `Clinical Research Staff (${phaseLabel})`,
          job_location: 'Multiple Sites',
          posting_date: today,
          competitor_firm: trial.firmName,
          likely_client: trial.sponsorName,
          likely_client_confidence: 'high',  // From actual CT.gov trial data
          source_url: trial.sourceUrl,
          trial_phase: phaseLabel,
          trial_status: trial.status,
          trial_title: trial.title,
          nct_id: trial.nctId,
        },
        source_url: sourceUrl,
        source_name: 'ClinicalTrials.gov',
        first_detected_at: new Date().toISOString(),
        status: 'new',
        priority_score: priorityScore,
        score_breakdown: {
          signal_strength: 18,
          recency: 25,
          relationship_warmth: warmthScore,
          actionability: 0,
        },
        days_in_queue: 0,
        is_carried_forward: false,
      })

      if (!sigError) {
        signalsFound++
        if (signalsFound <= firmsWithSignals + 1) firmsWithSignals++
      } else {
        console.warn(`  Signal insert failed for ${trial.firmName}/${trial.nctId}: ${sigError.message}`)
      }
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          cro_firms_queried: CRO_CT_SEARCHES.length,
          trials_found: allTrials.length,
          signals_inserted: signalsFound,
        },
      })
      .eq('id', runId)

    console.log(`Competitor Job Board Agent complete. Signals: ${signalsFound} (from ${allTrials.length} CRO trials)`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Competitor Job Board Agent failed:', error.message)
    return { success: false, error: error.message }
  }
}
