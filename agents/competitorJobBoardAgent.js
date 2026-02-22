import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient, shuffleArray } from '../lib/linkedinClient.js'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// 30 life sciences staffing firms. Upserted into competitor_firms when the
// table has fewer than 30 rows. careers_url is kept for reference only —
// we no longer scrape career pages directly; LinkedIn is the sole source.

const COMPETITOR_FIRMS_SEED = [
  { name: 'Actalent',                  careers_url: 'https://www.actalentservices.com/careers' },
  { name: 'Kelly Life Sciences',        careers_url: 'https://kellyservices.com/us/jobs' },
  { name: 'Alku',                       careers_url: 'https://boards.greenhouse.io/alku' },
  { name: 'Black Diamond Networks',     careers_url: 'https://blackdiamondnetworks.com/jobs/' },
  { name: 'Real Life Sciences',         careers_url: 'https://reallifesciences.com/careers/' },
  { name: 'Oxford Global Resources',    careers_url: 'https://www.ogr.com/careers' },
  { name: 'The Planet Group',           careers_url: 'https://www.theplanetgroup.com/jobs' },
  { name: 'ICON plc',                   careers_url: 'https://careers.iconplc.com/jobs' },
  { name: 'Advanced Clinical',          careers_url: 'https://www.advancedclinical.com/careers/' },
  { name: 'Randstad Life Sciences',     careers_url: 'https://www.randstadlifesciences.com/jobs' },
  { name: 'Joule Staffing',             careers_url: 'https://www.joulesolutions.com/find-a-job' },
  { name: 'Beacon Hill Staffing Group', careers_url: 'https://www.beaconhillstaffing.com/jobs' },
  { name: 'ASGN Incorporated',          careers_url: 'https://www.asgn.com' },
  { name: 'Net2Source',                 careers_url: 'https://www.net2source.com/jobs/' },
  { name: 'USTech Solutions',           careers_url: 'https://ustechsolutions.com/jobs/' },
  { name: 'Yoh Services',               careers_url: 'https://www.yoh.com' },
  { name: 'Soliant Health',             careers_url: 'https://www.soliant.com/jobs/' },
  { name: 'Medix Staffing',             careers_url: 'https://www.medixteam.com/job-search/' },
  { name: 'Epic Staffing Group',        careers_url: 'https://www.epicstaffinggroup.com' },
  { name: 'Solomon Page',               careers_url: 'https://www.solomonpage.com/find-a-job/' },
  { name: 'Spectra Force',              careers_url: 'https://www.spectraforce.com/careers' },
  { name: 'Mindlance',                  careers_url: 'https://www.mindlance.com/careers/' },
  { name: 'Green Key Resources',        careers_url: 'https://www.greenkeyresources.com/find-a-job' },
  { name: 'Phaidon International',      careers_url: 'https://phaidoninternational.com/jobs' },
  { name: 'Peoplelink Group',           careers_url: 'https://peoplelinkgroup.com/job-seekers/' },
  { name: 'Pacer Staffing',             careers_url: 'https://www.pacerstaffing.com/job-seekers/' },
  { name: 'ZP Group',                   careers_url: 'https://zp.group/job-seekers/' },
  { name: 'Meet Staffing',              careers_url: 'https://meetstaffing.com/jobs/' },
  { name: 'Ampcus',                     careers_url: 'https://ampcus.com/jobs/' },
  { name: 'ClinLab Staffing',           careers_url: 'https://clinlabstaffing.com/job-seekers/' },
]

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
        .insert({ name: firm.name, careers_url: firm.careers_url, is_active: true })
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

  const { error } = await supabase.from('signals').insert({
    company_id:      firmCompany.id,
    signal_type:     'competitor_job_posting',
    signal_summary:  `${firmName}: "${jobTitle}"`,
    signal_detail: {
      job_title:       jobTitle,
      job_location:    jobLocation,
      posting_date:    today,
      competitor_firm: firmName,
      job_url:         jobUrl || '',
      job_description: jobDescription,
      ats_source:      'linkedin',
    },
    source_url:         sourceUrl,
    source_name:        'LinkedIn',
    first_detected_at:  new Date().toISOString(),
    status:             'new',
    priority_score:     15,
    score_breakdown:    { signal_strength: 15 },
    days_in_queue:      0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`Signal insert failed for ${firmName}: ${error.message}`)
    return false
  }
  return true
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
    // ── Step 1: Seed competitor firms table if needed ────────────────────────
    const seedResult = await seedCompetitorFirms()
    console.log(`Competitor seed: ${seedResult.seeded} upserted, ${seedResult.skipped} skipped`)

    // ── Step 2: Load active firms from DB and shuffle order ─────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name, careers_url')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = shuffleArray(allFirms || [])
    console.log(`[CompetitorJobs] Processing ${firmsToCheck.length} active firms (shuffled) — LinkedIn only`)

    // ── Step 3: Initialise LinkedIn client — budget: 60 requests ────────────
    const linkedin = createLinkedInClient(60)
    if (!linkedin) {
      console.log('[CompetitorJobs] LinkedIn unavailable — nothing to do')
      await supabase.from('agent_runs').update({
        status: 'completed', completed_at: new Date().toISOString(), signals_found: 0,
        run_detail: { firms_checked: 0, linkedin_available: false },
      }).eq('id', runId)
      return { signalsFound: 0, requestsUsed: 0, firmsChecked: 0, seedResult }
    }

    const ROLE_KEYWORDS = 'clinical trial coordinator regulatory affairs CRA'
    let firmsChecked = 0

    // ── Step 4: LinkedIn search for each firm — no career page fetching ──────
    for (const firm of firmsToCheck) {
      if (!linkedin.isAvailable) break
      if (linkedin.requestsUsed >= 60) {
        console.log(`[CompetitorJobs] Budget exhausted (${linkedin.requestsUsed} requests used)`)
        break
      }

      firmsChecked++
      const liJobs = await linkedin.searchJobs(ROLE_KEYWORDS, firm.name)

      if (linkedin.botDetected) {
        console.log('[CompetitorJobs] Bot detected — stopping for today')
        break
      }

      let liInserted = 0
      for (const job of liJobs.slice(0, 3)) {
        if (!matchesRoleKeywords(job.title)) continue
        if (NON_US_JOB_LOC.test(job.location)) continue

        // Fetch description via guest API (/jobs-guest/jobs/api/jobPosting/{id})
        let description = ''
        if (job.jobUrl && linkedin.isAvailable) {
          description = await linkedin.fetchJobDescription(job.jobUrl)
          if (linkedin.botDetected) {
            console.log('[CompetitorJobs] Bot detected during description fetch — stopping for today')
            break
          }
        }

        const inserted = await persistCompetitorSignal(
          firm.name, job.jobUrl || '', job.title, job.location || '', description,
        )
        if (inserted) { signalsFound++; liInserted++ }
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
