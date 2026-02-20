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

function calculatePriorityScore(signalType, isToday, warmth) {
  const signalStrength = SIGNAL_SCORES[signalType] || 15
  const recency = isToday ? 25 : 0
  const warmthScore = WARMTH_SCORES[warmth] || 0
  const actionability = 0 // no contact yet at detection time
  return Math.min(signalStrength + recency + warmthScore + actionability, 100)
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
    .insert({
      name: sponsorName,
      industry: 'Life Sciences',
      relationship_warmth: 'new_prospect',
    })
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

function extractSponsorName(study) {
  return (
    study?.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name || null
  )
}

function extractPhase(study) {
  const phases =
    study?.protocolSection?.designModule?.phases || []
  return phases
}

function extractNLocations(study) {
  return study?.protocolSection?.contactsLocationsModule?.locations?.length || 0
}

function extractPrimaryCompletionDate(study) {
  const d =
    study?.protocolSection?.statusModule?.primaryCompletionDateStruct?.date
  return d || null
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

async function fetchStudies(pageToken = null) {
  const params = new URLSearchParams({
    format: 'json',
    pageSize: '100',
    fields: [
      'NCTId',
      'BriefTitle',
      'OfficialTitle',
      'OverallStatus',
      'Phase',
      'LeadSponsorName',
      'PrimaryCompletionDate',
      'LocationCount',
      'StartDate',
    ].join(','),
  })

  // Filter for interventional Life Sciences studies updated recently.
  // ClinicalTrials.gov v2 uses Essie expression syntax for study type;
  // filter.studyType is not a valid v2 parameter (returns 400).
  params.set('filter.overallStatus', 'RECRUITING,ACTIVE_NOT_RECRUITING,COMPLETED,NOT_YET_RECRUITING')
  params.set('filter.advanced', 'AREA[StudyType]INTERVENTIONAL')

  if (pageToken) {
    params.set('pageToken', pageToken)
  }

  const url = `${CLINICALTRIALS_API}?${params.toString()}`
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
  })

  if (!resp.ok) {
    throw new Error(`ClinicalTrials API error ${resp.status}: ${await resp.text()}`)
  }

  const json = await resp.json()
  return { studies: json.studies || [], nextPageToken: json.nextPageToken || null }
}

function classifyStudy(study) {
  const signals = []
  const phases = extractPhase(study)
  const nLocations = extractNLocations(study)
  const primaryCompletionDate = extractPrimaryCompletionDate(study)
  const status = extractStudyStatus(study)
  const today = new Date()

  // Phase transition: study moving to Phase 2 or Phase 3
  if (phases.includes('PHASE2') || phases.includes('PHASE3')) {
    signals.push({
      type: 'clinical_trial_phase_transition',
      summary: `Phase ${phases.includes('PHASE3') ? '3' : '2'} trial detected: ${extractTitle(study)}`,
    })
  }

  // New IND: Phase 1 study
  if (phases.includes('PHASE1') && !phases.includes('PHASE2')) {
    signals.push({
      type: 'clinical_trial_new_ind',
      summary: `New Phase 1 IND study: ${extractTitle(study)}`,
    })
  }

  // Site activation: study has more than 10 locations
  if (nLocations > 10) {
    signals.push({
      type: 'clinical_trial_site_activation',
      summary: `Study has ${nLocations} active sites: ${extractTitle(study)}`,
    })
  }

  // Completion: primaryCompletionDate within 90 days
  if (primaryCompletionDate) {
    const completionDate = new Date(primaryCompletionDate)
    const daysUntilCompletion = Math.floor(
      (completionDate - today) / (1000 * 60 * 60 * 24)
    )
    if (daysUntilCompletion >= 0 && daysUntilCompletion <= 90) {
      signals.push({
        type: 'clinical_trial_completion',
        summary: `Trial completing in ${daysUntilCompletion} days: ${extractTitle(study)}`,
      })
    }
  }

  return signals
}

export async function runClinicalTrialMonitor() {
  let signalsFound = 0
  const runDetail = {}

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'clinical_trial_monitor', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    const today = new Date().toISOString().split('T')[0]
    let pageToken = null
    let pagesFetched = 0
    const MAX_PAGES = 5 // cap at 500 studies to stay within time limits

    do {
      const { studies, nextPageToken } = await fetchStudies(pageToken)
      pageToken = nextPageToken
      pagesFetched++

      for (const study of studies) {
        const sponsorName = extractSponsorName(study)
        if (!sponsorName) continue

        const nctId = extractNctId(study)
        const title = extractTitle(study)
        const signals = classifyStudy(study)

        if (signals.length === 0) continue

        const company = await upsertCompany(sponsorName)
        if (!company) continue

        for (const sig of signals) {
          const sourceUrl = nctId
            ? `https://clinicaltrials.gov/study/${nctId}`
            : 'https://clinicaltrials.gov'

          const alreadyExists = await signalExists(company.id, sig.type, sourceUrl)
          if (alreadyExists) continue

          const priorityScore = calculatePriorityScore(
            sig.type,
            true, // treat as detected today
            company.relationship_warmth
          )

          const { error: insertError } = await supabase.from('signals').insert({
            company_id: company.id,
            signal_type: sig.type,
            signal_summary: sig.summary,
            signal_detail: {
              nct_id: nctId,
              title,
              phases: extractPhase(study),
              n_locations: extractNLocations(study),
              primary_completion_date: extractPrimaryCompletionDate(study),
              sponsor: sponsorName,
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

      await new Promise((r) => setTimeout(r, 500))
    } while (pageToken && pagesFetched < MAX_PAGES)

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: { pages_fetched: pagesFetched, ...runDetail },
      })
      .eq('id', runId)

    console.log(`Clinical Trial Monitor complete. Signals generated: ${signalsFound}`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message,
      })
      .eq('id', runId)
    console.error('Clinical Trial Monitor failed:', error.message)
    return { success: false, error: error.message }
  }
}
