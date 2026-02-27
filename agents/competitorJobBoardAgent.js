import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient, shuffleArray } from '../lib/linkedinClient.js'
import { loadDismissalRules, checkDismissalExclusion } from '../lib/dismissalRules.js'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// 45 life sciences staffing firms. Upserted into competitor_firms when the
// table has fewer than 30 rows. LinkedIn is the sole job source — no career
// pages are scraped.

const COMPETITOR_FIRMS_SEED = [
  { name: 'Actalent' },
  { name: 'Kelly' },
  { name: 'Alku' },
  { name: 'Black Diamond Networks' },
  { name: 'Real Life Sciences' },
  { name: 'Oxford Global Resources' },
  { name: 'The Planet Group' },
  { name: 'Advanced Clinical' },
  { name: 'Randstad' },
  { name: 'Joule Staffing' },
  { name: 'Beacon Hill Staffing Group' },
  { name: 'Net2Source' },
  { name: 'USTech Solutions' },
  { name: 'Yoh Services' },
  { name: 'Soliant Health' },
  { name: 'Medix' },
  { name: 'Epic Staffing Group' },
  { name: 'Solomon Page' },
  { name: 'Spectra Force' },
  { name: 'Mindlance' },
  { name: 'Green Key Resources' },
  { name: 'Phaidon International' },
  { name: 'Peoplelink Group' },
  { name: 'Pacer Staffing' },
  { name: 'ZP Group' },
  { name: 'Meet Staffing' },
  { name: 'Ampcus' },
  { name: 'ClinLab Staffing' },
  { name: 'Adecco' },
  { name: 'Manpower' },
  { name: 'Hays' },
  { name: 'Insight Global' },
  { name: 'Planet Pharma' },
  { name: 'Proclinical' },
  { name: 'Real Staffing' },
  { name: 'GForce Life Sciences' },
  { name: 'EPM Scientific' },
  { name: 'ClinLab Solutions Group' },
  { name: 'Sci.bio' },
  { name: 'Gemini Staffing Consultants' },
  { name: 'Orbis Clinical' },
  { name: 'Scientific Search' },
  { name: 'TriNet Pharma' },
  { name: 'The Fountain Group' },
  { name: 'Hueman RPO' },
]

// CRO / non-staffing firms — jobs posted BY these companies must be skipped even
// if LinkedIn surfaces them in a staffing-firm search.
const CRO_PATTERNS =
  /\b(syneos|fortrea|labcorp|iqvia|propharma|premier\s+research|worldwide\s+clinical|halloran|medpace|ppd\b|parexel|covance|charles\s+river|wuxi|pra\s+health|pharmaceutical\s+product\s+development|icon\s+plc|icon\s+strategic|asgn)\b/i

// Non-US job location filter — skip non-US postings
const NON_US_JOB_LOC =
  /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan)\b/i

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

// ─── Competitor firm seeding ───────────────────────────────────────────────────
// Ensures competitor_firms table is populated. Runs only when row count < 30.

async function seedCompetitorFirms() {
  const { count } = await supabase
    .from('competitor_firms')
    .select('*', { count: 'exact', head: true })

  if (count >= 30) return { seeded: 0, skipped: 0, skippedFirms: [] }

  let seeded = 0
  let skipped = 0
  const skippedFirms = []

  for (const firm of COMPETITOR_FIRMS_SEED) {
    const { data: existing } = await supabase
      .from('competitor_firms')
      .select('id')
      .ilike('name', firm.name)
      .maybeSingle()

    if (existing) {
      await supabase.from('competitor_firms').update({ is_active: true }).eq('id', existing.id)
      seeded++
    } else {
      const { error } = await supabase
        .from('competitor_firms')
        .insert({ name: firm.name, is_active: true })
      if (error) {
        skippedFirms.push({ name: firm.name, reason: error.message })
        skipped++
      } else {
        seeded++
      }
    }
  }

  return { seeded, skipped, skippedFirms }
}

// Description fetching is handled by client.fetchJobDescription() which uses
// the /jobs-guest/jobs/api/jobPosting/{jobId} guest API endpoint.

// ─── Persist a single competitor activity signal ───────────────────────────────

async function persistCompetitorSignal(firmName, jobUrl, jobTitle, jobLocation, jobDescription = '') {
  if (jobLocation && NON_US_JOB_LOC.test(jobLocation)) {
    console.log(`[competitorJobBoard] FILTERED (non-US): "${jobLocation}" — ${jobTitle}`)
    return false
  }

  const firmCompany = await upsertCompany(supabase, { name: firmName })
  if (!firmCompany) return false

  // Dedup key: job URL + title slug per ISO week
  const titleSlug = jobTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
  const weekNum   = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${jobUrl || 'https://biosignal.app'}#${titleSlug}-week-${weekNum}`
  const exists    = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const today = new Date().toISOString().split('T')[0]

  const { data: insertedRow, error } = await supabase.from('signals').insert({
    company_id:      firmCompany.id,
    signal_type:     'competitor_job_posting',
    signal_summary:  `${firmName}: "${jobTitle}"`,
    signal_detail: {
      job_title:               jobTitle,
      job_location:            jobLocation,
      posting_date:            today,
      competitor_firm:         firmName,
      job_url:                 jobUrl || '',
      job_description:         jobDescription,
      ats_source:              'linkedin',
      inferred_client:         null,
    },
    source_url:         sourceUrl,
    source_name:        'LinkedIn',
    first_detected_at:  new Date().toISOString(),
    status:             'new',
    priority_score:     15,
    score_breakdown:    { signal_strength: 15 },
    days_in_queue:      0,
    is_carried_forward: false,
  }).select('id').single()

  if (error) {
    console.warn(`Signal insert failed for ${firmName}: ${error.message}`)
    return null
  }
  return insertedRow?.id ?? null
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function run() {
  const { data: runEntry } = await supabase
    .from('agent_runs')
    .insert({
      agent_name:  'competitor-job-board-agent',
      status:      'running',
      started_at:  new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0

  try {
    // ── Step 0: Load dismissal rules for auto-exclusion ──────────────────────
    const dismissalRules = await loadDismissalRules()
    console.log(`[CompetitorJobs] Loaded ${[...dismissalRules.values()].flat().length} active dismissal rules.`)

    // ── Step 1: Seed competitor firms table if needed ────────────────────────
    const seedResult = await seedCompetitorFirms()
    console.log(`Competitor seed: ${seedResult.seeded} upserted, ${seedResult.skipped} skipped`)

    // ── Step 2: Load active firms from DB and shuffle order ─────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = shuffleArray(allFirms || [])
    console.log(`[CompetitorJobs] Processing ${firmsToCheck.length} active firms (shuffled) — LinkedIn only`)

    // ── Step 3: Initialise LinkedIn client — budget: 60 requests ───────────
    // Budget breakdown (approx per run):
    //   ~30 searchJobs calls (one per firm)
    //   ~30 fetchJobDescription calls (1 per qualifying job)
    const linkedin = createLinkedInClient(60)
    if (!linkedin) {
      console.log('[CompetitorJobs] LinkedIn unavailable — nothing to do')
      await supabase.from('agent_runs').update({
        status: 'completed', completed_at: new Date().toISOString(), signals_found: 0,
        run_detail: { firms_checked: 0, linkedin_available: false },
      }).eq('id', runId)
      return { signalsFound: 0, requestsUsed: 0, firmsChecked: 0, seedResult }
    }

    // Rotate through 8 short role keywords — one per firm, cycling by index.
    // Short single-keyword queries avoid LinkedIn's multi-keyword matching failures
    // that produce empty pages. Over 8 daily runs, every firm gets every keyword.
    const ROLE_KEYWORD_ROTATION = [
      'CRA',
      'clinical research',
      'regulatory affairs',
      'biostatistician',
      'clinical trial',
      'medical affairs',
      'quality assurance',
      'data management',
    ]
    let firmsChecked = 0
    let firmIndex = 0

    // ── Step 4: LinkedIn search for each firm — no career page fetching ──────
    for (const firm of firmsToCheck) {
      if (!linkedin.isAvailable) break
      if (linkedin.requestsUsed >= 60) {
        console.log(`[CompetitorJobs] Budget exhausted (${linkedin.requestsUsed} requests used)`)
        break
      }

      firmsChecked++
      const singleKeyword = ROLE_KEYWORD_ROTATION[firmIndex % ROLE_KEYWORD_ROTATION.length]
      firmIndex++
      console.log(`[CompetitorJobs] Querying "${firm.name} ${singleKeyword}"`)
      const liJobs = await linkedin.searchJobs(singleKeyword, firm.name)

      if (linkedin.botDetected) {
        console.log('[CompetitorJobs] Bot detected — stopping for today')
        break
      }

      let liInserted = 0
      for (const job of liJobs.slice(0, 3)) {
        if (!matchesRoleKeywords(job.title)) continue
        if (NON_US_JOB_LOC.test(job.location)) continue

        // Skip jobs posted BY a CRO/non-staffing company (LinkedIn sometimes
        // surfaces CRO postings when searching for a staffing firm's keyword)
        if (job.company && CRO_PATTERNS.test(job.company)) {
          console.log(`[CompetitorJobs] FILTERED (CRO): "${job.company}" — ${job.title}`)
          continue
        }

        // Check dismissal rules BEFORE making any LinkedIn API calls
        const dismissCheck = checkDismissalExclusion(dismissalRules, 'competitor_job_posting', {
          role_title: job.title || '',
          location: job.location || '',
        })
        if (dismissCheck.excluded) {
          console.log(`[CompetitorJobs] AUTO-EXCLUDED (${dismissCheck.rule_type}): ${dismissCheck.rule_value}`)
          continue
        }

        // Fetch description via guest API (/jobs-guest/jobs/api/jobPosting/{id})
        let description = ''
        if (job.jobUrl && linkedin.isAvailable) {
          description = await linkedin.fetchJobDescription(job.jobUrl)
          if (linkedin.botDetected) {
            console.log('[CompetitorJobs] Bot detected during description fetch — stopping for today')
            break
          }
        }

        const insertedId = await persistCompetitorSignal(
          firm.name, job.jobUrl || '', job.title, job.location || '', description,
        )
        if (insertedId) {
          signalsFound++
          liInserted++
        }
      }

      console.log(`${firm.name}: ${liInserted} LinkedIn signals saved`)
      if (linkedin.botDetected) break
    }

    const requestsUsed = linkedin.requestsUsed

    await supabase.from('agent_runs').update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      signals_found: signalsFound,
      run_detail: {
        firms_checked:          firmsChecked,
        total_active_firms:     allFirms?.length ?? 0,
        linkedin_requests_used: requestsUsed,
        linkedin_bot_detected:  linkedin.botDetected,
        seed_result: {
          seeded:        seedResult.seeded,
          skipped:       seedResult.skipped,
          skipped_firms: seedResult.skippedFirms,
        },
      },
    }).eq('id', runId)

    console.log(
      `[CompetitorJobs] Complete — ${requestsUsed} requests used, ${signalsFound} signals saved`
    )

    return { signalsFound, requestsUsed, firmsChecked, seedResult }
  } catch (err) {
    await supabase.from('agent_runs').update({
      status:        'failed',
      completed_at:  new Date().toISOString(),
      error_message: err.message,
    }).eq('id', runId)
    throw err
  }
}
