import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// This list is upserted into the competitor_firms table when fewer than 30
// records exist. Career URLs are verified reachable before insertion.

const COMPETITOR_FIRMS_SEED = [
  // URLs verified via HEAD request 2026-02-21
  { name: 'Actalent', careers_url: 'https://www.actalentservices.com/careers' },
  { name: 'Kelly Life Sciences', careers_url: 'https://kellyservices.com/us/jobs/life-sciences/' },
  { name: 'Alku', careers_url: 'https://www.alku.com/jobs/' },
  { name: 'Black Diamond Networks', careers_url: 'https://blackdiamondnetworks.com/jobs/' },
  { name: 'Real Life Sciences', careers_url: 'https://reallifesciences.com/careers/' },
  { name: 'Oxford Global Resources', careers_url: 'https://www.ogr.com/careers' },
  { name: 'The Planet Group', careers_url: 'https://www.theplanetgroup.com/jobs' },
  { name: 'ICON plc', careers_url: 'https://jobs.iconplc.com/jobs' },
  { name: 'Advanced Clinical', careers_url: 'https://www.advancedclinical.com/careers/' },
  { name: 'Randstad Life Sciences', careers_url: 'https://www.randstadusa.com/jobs/life-sciences' },
  { name: 'Joule Staffing', careers_url: 'https://www.joulesolutions.com/find-a-job' },
  { name: 'Beacon Hill Staffing Group', careers_url: 'https://www.beaconhillstaffing.com/jobs' },
  { name: 'ASGN Incorporated', careers_url: 'https://www.asgn.com' },
  { name: 'Net2Source', careers_url: 'https://www.net2source.com/jobs/' },
  { name: 'USTech Solutions', careers_url: 'https://ustechsolutions.com/jobs/' },
  { name: 'Yoh Services', careers_url: 'https://www.yoh.com' },
  { name: 'Soliant Health', careers_url: 'https://www.soliant.com/jobs/' },
  { name: 'Medix Staffing', careers_url: 'https://www.medixteam.com/job-search/' },
  { name: 'Epic Staffing Group', careers_url: 'https://www.epicstaffinggroup.com' },
  { name: 'Solomon Page', careers_url: 'https://www.solomonpage.com/find-a-job/' },
  { name: 'Spectra Force', careers_url: 'https://www.spectraforce.com/careers' },
  { name: 'Mindlance', careers_url: 'https://www.mindlance.com/careers/' },
  { name: 'Green Key Resources', careers_url: 'https://www.greenkeyresources.com/find-a-job' },
  { name: 'Phaidon International', careers_url: 'https://phaidoninternational.com/jobs' },
  { name: 'Peoplelink Group', careers_url: 'https://peoplelinkgroup.com/job-seekers/' },
  { name: 'Pacer Staffing', careers_url: 'https://www.pacerstaffing.com/job-seekers/' },
  { name: 'ZP Group', careers_url: 'https://zp.group/job-seekers/' },
  { name: 'Meet Staffing', careers_url: 'https://meetstaffing.com/jobs/' },
  { name: 'Ampcus', careers_url: 'https://ampcus.com/jobs/' },
  { name: 'ClinLab Staffing', careers_url: 'https://clinlabstaffing.com/job-seekers/' },
  { name: 'Medpace', careers_url: 'https://medpace.com/careers/open-positions/' },
  { name: 'Syneos Health', careers_url: 'https://jobs.syneoshealth.com' },
  { name: 'Fortrea', careers_url: 'https://careers.fortrea.com/jobs' },
  { name: 'Halloran Consulting', careers_url: 'https://www.halloran-consulting.com/careers' },
  { name: 'Premier Research', careers_url: 'https://premierresearch.com/careers/' },
  { name: 'Worldwide Clinical Trials', careers_url: 'https://worldwideclinicaltrials.com/careers/' },
  { name: 'IQVIA', careers_url: 'https://jobs.iqvia.com' },
  { name: 'Parexel', careers_url: 'https://parexel.com/careers' },
  { name: 'Labcorp Drug Development', careers_url: 'https://jobs.labcorp.com' },
  { name: 'ProPharma Group', careers_url: 'https://propharmagroup.com/careers/' },
  { name: 'TalentBurst', careers_url: 'https://talentburst.com/jobs/' },
  { name: 'KForce', careers_url: 'https://kforce.com/job-seekers/' },
  { name: 'WuXi AppTec Clinical', careers_url: 'https://wuxiclinical.com/careers' },
  { name: 'Charles River Laboratories', careers_url: 'https://careers.crl.com' },
  { name: 'Integrated Project Management', careers_url: 'https://ipmglobal.com/careers' },
]

const BOT_UA = 'Mozilla/5.0 (compatible; BioSignalBot/1.0)'

// Non-US country names. If the inferred client company name contains one of these
// it is likely a non-US entity — we only generate signals for US-based clients.
const NON_US_CLIENT_PATTERNS =
  /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan|GmbH|AG\b|NV\b|BV\b)\b/i

// ─── Shared signal helpers ─────────────────────────────────────────────────────

// upsertCompany imported from lib/supabase.js (shared ilike check-then-insert pattern)

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
// Only runs when the table has fewer than 30 rows. Each firm's career URL is
// verified with a HEAD request before being written to the database. HTTP 405
// (Method Not Allowed) is treated as success — the site is reachable.

async function seedCompetitorFirms() {
  const { count } = await supabase
    .from('competitor_firms')
    .select('*', { count: 'exact', head: true })

  if (count >= 30) return { seeded: 0, skipped: 0, skippedFirms: [] }

  let seeded = 0
  let skipped = 0
  const skippedFirms = []

  for (const firm of COMPETITOR_FIRMS_SEED) {
    try {
      const resp = await fetch(firm.careers_url, {
        method: 'HEAD',
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      })
      const ok = resp.status < 400 || resp.status === 405
      if (ok) {
        const { data: existingFirm } = await supabase
          .from('competitor_firms')
          .select('id')
          .ilike('name', firm.name)
          .maybeSingle()
        if (existingFirm) {
          await supabase
            .from('competitor_firms')
            .update({ is_active: true })
            .eq('id', existingFirm.id)
        } else {
          await supabase
            .from('competitor_firms')
            .insert({ name: firm.name, careers_url: firm.careers_url, is_active: true })
        }
        seeded++
      } else {
        skippedFirms.push({ name: firm.name, reason: `HTTP ${resp.status}` })
        skipped++
      }
    } catch (err) {
      skippedFirms.push({ name: firm.name, reason: err.message })
      skipped++
    }
    // Avoid hammering servers during bulk seed
    await new Promise((r) => setTimeout(r, 100))
  }

  return { seeded, skipped, skippedFirms }
}

// ─── ATS detection helpers ─────────────────────────────────────────────────────

/**
 * Extract a Greenhouse or Lever board slug from career page HTML.
 * Looks for embedded board URLs like boards.greenhouse.io/{slug} or jobs.lever.co/{slug}.
 *
 * @param {string} html
 * @returns {{ type: 'greenhouse'|'lever', slug: string }|null}
 */
function detectAtsSlug(html) {
  const ghMatch = html.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9_-]+)/i)
  if (ghMatch) return { type: 'greenhouse', slug: ghMatch[1] }
  const lvMatch = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i)
  if (lvMatch) return { type: 'lever', slug: lvMatch[1] }
  return null
}

/**
 * Fetch actual job listings from Greenhouse or Lever public API.
 * Returns array of { title, location, applyUrl } objects filtered by role keywords.
 *
 * @param {{ type: string, slug: string }} ats
 * @returns {Promise<Array<{title: string, location: string, applyUrl: string}>>}
 */
async function fetchAtsJobs(ats) {
  try {
    let url, jobs = []
    if (ats.type === 'greenhouse') {
      url = `https://boards-api.greenhouse.io/v1/boards/${ats.slug}/jobs`
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) })
      if (!resp.ok) return []
      const data = await resp.json()
      jobs = (data.jobs || []).map((j) => ({
        title: j.title || '',
        location: j.location?.name || '',
        applyUrl: j.absolute_url || url,
      }))
    } else {
      url = `https://api.lever.co/v0/postings/${ats.slug}?mode=json`
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) })
      if (!resp.ok) return []
      const data = await resp.json()
      jobs = (Array.isArray(data) ? data : []).map((j) => ({
        title: j.text || '',
        location: j.categories?.location || j.workplaceType || '',
        applyUrl: j.hostedUrl || url,
      }))
    }
    // Filter to life sciences roles matching our keyword list
    return jobs.filter((j) => matchesRoleKeywords(j.title))
  } catch {
    return []
  }
}

/**
 * Parse JSON-LD JobPosting schema blocks from HTML.
 * Returns matching jobs filtered by role keywords.
 *
 * @param {string} html
 * @returns {Array<{title: string, location: string, applyUrl: string}>}
 */
function parseJsonLdJobs(html) {
  const jobs = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      const schema = JSON.parse(m[1])
      const items = schema['@type'] === 'JobPosting'
        ? [schema]
        : (schema['@graph'] || []).filter((x) => x['@type'] === 'JobPosting')
      for (const item of items) {
        const title = item.title || item.name || ''
        if (!title || !matchesRoleKeywords(title)) continue
        const loc = item.jobLocation?.address?.addressLocality || ''
        const region = item.jobLocation?.address?.addressRegion || ''
        const location = [loc, region].filter(Boolean).join(', ')
        const applyUrl = item.url || item.sameAs || ''
        jobs.push({ title, location, applyUrl })
      }
    } catch {
      // invalid JSON-LD — skip
    }
  }
  return jobs
}

// ─── Client inference from career page HTML + companies table ─────────────────
// Strategy (in priority order):
//   1. Detect Greenhouse/Lever ATS embed → fetch actual job list via API
//   2. Parse JSON-LD JobPosting schema blocks
//   3. Scan HTML text for known Life Sciences company names (existing approach)

async function fetchCareerPageJobs(careersUrl, firmName, knownCompanyNames) {
  if (!careersUrl) return { jobs: [], likely_client: 'Unknown', confidence: 'low' }

  let html = ''
  try {
    const resp = await fetch(careersUrl, {
      headers: { 'User-Agent': BOT_UA },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })
    if (!resp.ok) return { jobs: [], likely_client: 'Unknown', confidence: 'low' }
    html = await resp.text()
  } catch {
    return { jobs: [], likely_client: 'Unknown', confidence: 'low' }
  }

  if (html.length < 500) return { jobs: [], likely_client: 'Unknown', confidence: 'low' }

  // ── Strategy 1: ATS API (Greenhouse / Lever) ──────────────────────────────
  const ats = detectAtsSlug(html)
  if (ats) {
    console.log(`${firmName}: detected ATS ${ats.type}/${ats.slug}`)
    const atsJobs = await fetchAtsJobs(ats)
    if (atsJobs.length > 0) {
      console.log(`${firmName}: ${atsJobs.length} ATS jobs via ${ats.type}`)
      const likely_client = inferClientFromText(
        atsJobs.map((j) => j.title).join(' '),
        firmName,
        knownCompanyNames
      )
      return { jobs: atsJobs, likely_client, confidence: likely_client !== 'Unknown' ? 'high' : 'low' }
    }
  }

  // ── Strategy 2: JSON-LD JobPosting schema ────────────────────────────────
  const ldJobs = parseJsonLdJobs(html)
  if (ldJobs.length > 0) {
    console.log(`${firmName}: ${ldJobs.length} JSON-LD jobs`)
    const likely_client = inferClientFromText(
      ldJobs.map((j) => j.title).join(' '),
      firmName,
      knownCompanyNames
    )
    return { jobs: ldJobs, likely_client, confidence: likely_client !== 'Unknown' ? 'medium' : 'low' }
  }

  // ── Strategy 3: company-name scan in HTML ─────────────────────────────────
  const likely_client = inferClientFromText(html, firmName, knownCompanyNames)
  return { jobs: [], likely_client, confidence: likely_client !== 'Unknown' ? 'medium' : 'low' }
}

/** Scan text for known company names — returns first match or 'Unknown'. */
function inferClientFromText(text, firmName, knownCompanyNames) {
  const textLower = text.toLowerCase()
  const firmLower = firmName.toLowerCase()
  for (const companyName of knownCompanyNames) {
    if (!companyName || companyName.length < 5) continue
    if (companyName.toLowerCase().includes(firmLower) || firmLower.includes(companyName.toLowerCase())) continue
    if (textLower.includes(companyName.toLowerCase())) return companyName
  }
  return 'Unknown'
}

// ─── Persist a single competitor activity signal ───────────────────────────────
// Dedup key is firm + ISO week so one signal per firm per week at most.

async function persistCompetitorSignal(firmName, careersUrl, likelyClient, confidence, jobTitle = 'Active life sciences hiring', jobLocation = '') {
  // US-only: skip signals where the inferred client is clearly a non-US entity
  if (likelyClient && likelyClient !== 'Unknown' && NON_US_CLIENT_PATTERNS.test(likelyClient)) {
    console.log(`[competitorJobBoard] FILTERED (non-US client): ${likelyClient} via ${firmName}`)
    return false
  }

  // US-only: skip jobs with a non-US location in the posting
  if (jobLocation) {
    const NON_US_JOB_LOC = /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan)\b/i
    if (NON_US_JOB_LOC.test(jobLocation)) {
      console.log(`[competitorJobBoard] FILTERED (non-US job location): "${jobLocation}" — ${jobTitle}`)
      return false
    }
  }

  const firmCompany = await upsertCompany(supabase, { name: firmName })
  if (!firmCompany) return false

  // Dedup key: careers URL + job title hash (one signal per unique job per firm)
  const dedupKey = careersUrl || 'https://biosignal.app'
  const titleSlug = jobTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${dedupKey}#${titleSlug}-week-${weekNum}`
  const exists = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const today = new Date().toISOString().split('T')[0]
  const clientNote = likelyClient !== 'Unknown' ? ` — likely client: ${likelyClient}` : ''

  const { error } = await supabase.from('signals').insert({
    company_id: firmCompany.id,
    signal_type: 'competitor_job_posting',
    signal_summary: `${firmName}: "${jobTitle}"${clientNote}`,
    signal_detail: {
      job_title: jobTitle,
      job_location: jobLocation,
      posting_date: today,
      competitor_firm: firmName,
      likely_client: likelyClient,
      likely_client_confidence: confidence,
      source_url: careersUrl || '',
    },
    source_url: sourceUrl,
    source_name: 'CareersPage',
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: 15,
    score_breakdown: { signal_strength: 15 },
    days_in_queue: 0,
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
      agent_name: 'competitor-job-board-agent',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0

  try {
    // ── Step 1: Seed competitor firms table if needed ────────────────────────
    const seedResult = await seedCompetitorFirms()
    console.log(
      `Competitor seed: ${seedResult.seeded} inserted, ${seedResult.skipped} skipped`
    )

    // ── Step 2: Load active firms from DB ───────────────────────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name, careers_url')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = allFirms || []
    console.log(
      `Competitor Job Board: processing ALL ${firmsToCheck.length} active firms this run`
    )

    let firmsChecked = 0

    // ── Step 3: Load known Life Sciences companies for client inference ──────
    const { data: knownCompanies } = await supabase
      .from('companies')
      .select('name')
      .eq('industry', 'Life Sciences')
      .limit(200)
    const knownCompanyNames = (knownCompanies || []).map((c) => c.name)
    console.log(`Loaded ${knownCompanyNames.length} known companies for client inference`)

    // ── Step 4: For each firm, detect ATS / parse JSON-LD / scan HTML ────────
    for (const firm of firmsToCheck) {
      firmsChecked++

      const { jobs, likely_client, confidence } = await fetchCareerPageJobs(
        firm.careers_url,
        firm.name,
        knownCompanyNames
      )

      if (jobs.length > 0) {
        // Emit one signal per matching job (capped at 5 per firm per run)
        for (const job of jobs.slice(0, 5)) {
          const inserted = await persistCompetitorSignal(
            firm.name,
            job.applyUrl || firm.careers_url,
            likely_client,
            confidence,
            job.title,
            job.location
          )
          if (inserted) signalsFound++
        }
      } else {
        // Fall back to firm-level "actively hiring" signal
        const inserted = await persistCompetitorSignal(
          firm.name,
          firm.careers_url,
          likely_client,
          confidence,
          'Active life sciences hiring',
          ''
        )
        if (inserted) signalsFound++
      }

      console.log(`${firm.name}: ${jobs.length} jobs, client="${likely_client}" (${confidence})`)

      // 400ms delay between firms — balanced against Vercel 300s timeout
      if (firmsChecked < firmsToCheck.length) {
        await new Promise((r) => setTimeout(r, 400))
      }
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          firms_checked: firmsChecked,
          total_active_firms: allFirms?.length ?? 0,
          seed_result: {
            seeded: seedResult.seeded,
            skipped: seedResult.skipped,
            skipped_firms: seedResult.skippedFirms,
          },
        },
      })
      .eq('id', runId)

    console.log(
      `Competitor Job Board Agent complete — signals: ${signalsFound}, firms checked: ${firmsChecked}`
    )

    return {
      signalsFound,
      firmsChecked,
      seedResult: {
        seeded: seedResult.seeded,
        skipped: seedResult.skipped,
        skippedFirms: seedResult.skippedFirms,
      },
    }
  } catch (err) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err.message,
      })
      .eq('id', runId)
    throw err
  }
}
