import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient, shuffleArray } from '../lib/linkedinClient.js'

// Non-US country names in job location strings. Jobs located outside the US are
// skipped — we only staff US positions. Blank/Remote locations are kept.
const NON_US_LOCATION_PATTERNS =
  /\b(Canada|Ontario|Quebec|British Columbia|Alberta|UK|United Kingdom|England|Scotland|Wales|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan|New Zealand|South Africa|Mexico|Argentina)\b/i

// ─── 60 LinkedIn search queries ────────────────────────────────────────────────
// Shuffled on every run. Each targets a specific role+industry combination so
// LinkedIn's keyword matching returns results (short, focused queries work better
// than long multi-keyword strings).

const LINKEDIN_STALE_QUERIES = [
  '"clinical research associate" pharmaceutical',
  '"clinical research associate" biotech',
  '"CRA" life sciences',
  '"CRA II" pharmaceutical',
  '"senior CRA" biotech',
  '"clinical trial manager" pharmaceutical',
  '"clinical trial manager" biotech',
  '"clinical trial manager" CRO',
  '"clinical operations manager" pharma',
  '"clinical operations director" biotech',
  '"regulatory affairs specialist" pharmaceutical',
  '"regulatory affairs specialist" biotech',
  '"regulatory affairs manager" life sciences',
  '"regulatory affairs director" pharma',
  '"regulatory submissions" specialist',
  '"biostatistician" pharmaceutical',
  '"biostatistician" clinical trials',
  '"senior biostatistician" pharma',
  '"principal biostatistician" biotech',
  '"statistical programmer" pharmaceutical',
  '"statistical programmer" clinical',
  '"SAS programmer" pharma',
  '"clinical data manager" pharmaceutical',
  '"clinical data manager" biotech',
  '"clinical data manager" life sciences',
  '"clinical data coordinator" pharma',
  '"medical monitor" pharmaceutical',
  '"medical monitor" clinical trials',
  '"medical affairs" director pharma',
  '"medical affairs" manager biotech',
  '"medical science liaison" pharmaceutical',
  '"pharmacovigilance" specialist pharmaceutical',
  '"pharmacovigilance" manager biotech',
  '"drug safety associate" pharmaceutical',
  '"drug safety" specialist pharma',
  '"quality assurance" specialist pharmaceutical',
  '"quality assurance" manager biotech GMP',
  '"quality engineer" pharma',
  '"validation engineer" pharmaceutical',
  '"validation specialist" biotech',
  '"clinical programmer" pharmaceutical',
  '"SDTM programmer" pharmaceutical',
  '"Medidata RAVE" programmer',
  '"clinical project manager" pharmaceutical',
  '"clinical project manager" biotech',
  '"clinical project manager" CRO',
  '"site monitor" pharmaceutical',
  '"study coordinator" clinical',
  '"clinical trial coordinator" pharmaceutical',
  '"data scientist" pharmaceutical',
  '"data scientist" clinical trials',
  '"HEOR" pharmaceutical',
  '"health economics outcomes research"',
  '"real world evidence" pharmaceutical',
  '"medical device" regulatory affairs',
  '"complaint specialist" pharmaceutical',
  '"quality control" pharmaceutical GMP',
  '"CMC" pharmaceutical manufacturing',
  '"publications" specialist pharmaceutical medical',
  '"clinical research coordinator" pharmaceutical',
]

// Exclude staffing/CRO competitor firms — those belong to competitor_job_posting
const COMPETITOR_FIRM_NAMES = new Set([
  'Actalent', 'Kelly Life Sciences', 'Alku', 'Black Diamond Networks',
  'Real Life Sciences', 'Oxford Global Resources', 'The Planet Group',
  'ICON plc', 'Advanced Clinical', 'Randstad Life Sciences',
  'Joule Staffing', 'Beacon Hill Staffing Group', 'ASGN Incorporated',
  'Net2Source', 'USTech Solutions', 'Yoh Services', 'Soliant Health',
  'Medix Staffing', 'Epic Staffing Group', 'Solomon Page',
  'Spectra Force', 'Mindlance', 'Green Key Resources',
  'Phaidon International', 'Peoplelink Group', 'Pacer Staffing',
  'ZP Group', 'Meet Staffing', 'Ampcus', 'ClinLab Staffing',
])

// Academic/hospital organisations — not relevant to BD pipeline
const ACADEMIC_PATTERNS =
  /university|college|hospital|medical center|health system|health centre|institute|foundation|children's|memorial|research center|\bnih\b|\bcdc\b|\bnci\b|\bmgh\b/i

// ─── Shared signal helpers ─────────────────────────────────────────────────────

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

// ─── Scoring ───────────────────────────────────────────────────────────────────

function computeScore(daysPosted) {
  let score = 15
  if (daysPosted >= 60) score += 3
  else if (daysPosted >= 30) score += 2
  return Math.min(score, 20)
}

// ─── Persist a single LinkedIn job as a stale_job_posting signal ───────────────

async function persistJobSignal(job) {
  const loc = job.job_location || ''
  if (loc && NON_US_LOCATION_PATTERNS.test(loc)) {
    console.log(`[staleJobTracker] FILTERED (non-US location): "${loc}" — ${job.job_title} @ ${job.company_name}`)
    return false
  }

  const company = await upsertCompany(supabase, { name: job.company_name })
  if (!company) return false

  const exists = await signalExists(company.id, 'stale_job_posting', job.source_url)
  if (exists) return false

  const score = computeScore(job.days_posted)
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id:      company.id,
    signal_type:     'stale_job_posting',
    signal_summary:  `"${job.job_title}" at ${job.company_name} posted for ${job.days_posted}+ days`,
    signal_detail: {
      company_name: job.company_name,
      job_title:    job.job_title,
      job_location: job.job_location,
      date_posted:  job.date_posted || today,
      days_posted:  job.days_posted,
      source_url:   job.source_url,
      job_board:    'linkedin',
      source:       'LinkedIn',
    },
    source_url:         job.source_url,
    source_name:        'LinkedIn',
    first_detected_at:  new Date().toISOString(),
    status:             'new',
    priority_score:     score,
    score_breakdown:    { base: 15, days_posted_boost: score - 15 },
    days_in_queue:      0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`Signal insert failed for ${job.company_name}/"${job.job_title}": ${error.message}`)
    return false
  }
  return true
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function run() {
  const { data: runEntry } = await supabase
    .from('agent_runs')
    .insert({
      agent_name:  'stale-job-tracker',
      status:      'running',
      started_at:  new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0

  try {
    // ── Initialise LinkedIn client — budget: 60 requests ────────────────────
    const linkedin = createLinkedInClient(60)

    if (!linkedin) {
      console.log('[StaleJobs] LinkedIn unavailable — nothing to do')
      await supabase.from('agent_runs').update({
        status: 'completed', completed_at: new Date().toISOString(), signals_found: 0,
        run_detail: { linkedin_available: false },
      }).eq('id', runId)
      return { signalsFound: 0, requestsUsed: 0 }
    }

    // Shuffle queries on every run so coverage rotates across daily runs
    const queries = shuffleArray(LINKEDIN_STALE_QUERIES)
    const dedup       = new Set()    // dedup by job URL within this run
    let liSignals     = 0
    const MAX_LI_SIGNALS    = 100
    const MAX_JOBS_PER_QUERY = 5

    for (const query of queries) {
      if (liSignals >= MAX_LI_SIGNALS) break
      if (linkedin.requestsUsed >= 60) {
        console.log(`[StaleJobs] Budget exhausted (${linkedin.requestsUsed} requests used)`)
        break
      }

      // 90-day window (r7776000) — captures genuinely stale postings (30+ days old)
      const results = await linkedin.searchJobs(query, null, 'r7776000')

      if (linkedin.botDetected) {
        console.log('[StaleJobs] Bot detected — stopping for today')
        break
      }

      let queryCount = 0
      for (const job of results) {
        if (liSignals >= MAX_LI_SIGNALS) break
        if (queryCount >= MAX_JOBS_PER_QUERY) break
        if (!job.jobUrl || dedup.has(job.jobUrl)) continue
        if (job.daysPosted < 30) continue
        if (!matchesRoleKeywords(job.title)) continue
        if (COMPETITOR_FIRM_NAMES.has(job.company)) continue
        if (ACADEMIC_PATTERNS.test(job.company)) continue
        if (NON_US_LOCATION_PATTERNS.test(job.location)) continue

        dedup.add(job.jobUrl)
        const inserted = await persistJobSignal({
          job_title:    job.title,
          company_name: job.company || 'Unknown',
          job_location: job.location || '',
          date_posted:  null,
          days_posted:  job.daysPosted,
          source_url:   job.jobUrl,
        })
        if (inserted) { signalsFound++; liSignals++ }
        queryCount++
      }
    }

    const requestsUsed = linkedin.requestsUsed

    await supabase.from('agent_runs').update({
      status:        'completed',
      completed_at:  new Date().toISOString(),
      signals_found: signalsFound,
      run_detail: {
        linkedin_requests_used: requestsUsed,
        linkedin_bot_detected:  linkedin.botDetected,
        total_candidate_jobs:   dedup.size,
        signals_saved:          signalsFound,
      },
    }).eq('id', runId)

    console.log(
      `[StaleJobs] Complete — ${requestsUsed} requests used, ${signalsFound} signals saved`
    )

    return { signalsFound, requestsUsed }
  } catch (err) {
    await supabase.from('agent_runs').update({
      status:        'failed',
      completed_at:  new Date().toISOString(),
      error_message: err.message,
    }).eq('id', runId)
    throw err
  }
}
