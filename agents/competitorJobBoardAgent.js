import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient } from '../lib/linkedinClient.js'
import * as cheerio from 'cheerio'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// 30 life sciences staffing firms only (no CROs/consulting firms).
// Upserted into competitor_firms when the table has fewer than 30 rows.

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

const BOT_UA = 'Mozilla/5.0 (compatible; BioSignalBot/1.0)'

// Non-US job location filter — used to skip non-US postings
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
 * Extract a Greenhouse, Lever, Jobvite, Workday, or iCIMS board slug
 * from career page HTML.
 *
 * @param {string} html
 * @returns {{ type: string, slug: string }|null}
 */
function detectAtsSlug(html) {
  // iCIMS / Workday: log and return a sentinel so callers can skip API attempts
  if (/\.icims\.com/i.test(html)) return { type: 'icims', slug: '' }
  // Extract Workday tenant slug from embedded URL (e.g. "acme.wd1.myworkdayjobs.com" → slug="acme")
  const wdMatch = html.match(/([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com/i)
  if (wdMatch) return { type: 'workday', slug: wdMatch[1].toLowerCase() }
  if (/myworkdayjobs\.com|workday\.com\/en-us\/applications/i.test(html)) return { type: 'workday', slug: '' }

  // Greenhouse embed pattern: ?for=slug (most common on career pages)
  const ghEmbedMatch = html.match(/boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i)
  if (ghEmbedMatch) return { type: 'greenhouse', slug: ghEmbedMatch[1] }

  // Greenhouse direct path
  const ghMatch = html.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9_-]+)/i)
  if (ghMatch && !['embed', 'v1', 'boards', 'jobs'].includes(ghMatch[1].toLowerCase())) {
    return { type: 'greenhouse', slug: ghMatch[1] }
  }

  const lvMatch = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i)
  if (lvMatch) return { type: 'lever', slug: lvMatch[1] }

  // Jobvite: jobs.jobvite.com/{company-id}
  const jvMatch = html.match(/jobs\.jobvite\.com\/([a-z0-9_-]+)/i)
  if (jvMatch) return { type: 'jobvite', slug: jvMatch[1] }

  return null
}

/**
 * Attempt to fetch job listings from a Workday-powered careers site.
 *
 * @param {string} firmSlug  Lowercase, no-punctuation firm identifier
 * @returns {Promise<Array<{title, location, applyUrl, description, ats_source}>>}
 */
async function fetchWorkdayJobs(firmSlug) {
  const tenants = [1, 5, 3, 2].map((n) => `https://${firmSlug}.wd${n}.myworkdayjobs.com/en-US/${firmSlug}_External`)
  console.log(`Workday: trying tenant URLs for slug "${firmSlug}"`)

  for (const tenantUrl of tenants) {
    let html = ''
    try {
      const resp = await fetch(tenantUrl, {
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      })
      console.log(`Workday tenant [${tenantUrl}]: HTTP ${resp.status}`)
      if (!resp.ok) continue
      html = await resp.text()
    } catch {
      continue
    }

    if (html.length < 200) continue

    // Try JSON-LD first
    const ldJobs = parseJsonLdJobs(html)
    if (ldJobs.length > 0) {
      console.log(`Workday [${firmSlug}]: ${ldJobs.length} JSON-LD jobs found`)
      return ldJobs
        .filter((j) => matchesRoleKeywords(j.title))
        .map((j) => ({ ...j, description: '', ats_source: 'workday' }))
    }

    // Try Workday's embedded wd-data JSON block
    const wdDataMatch = html.match(/<script[^>]+id=["']wd-data["'][^>]*>([\s\S]*?)<\/script>/i)
      || html.match(/window\.__APP_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/i)
    if (wdDataMatch) {
      try {
        const wdData = JSON.parse(wdDataMatch[1])
        const postings = wdData?.jobSearchResult?.data || wdData?.data || []
        const jobs = (Array.isArray(postings) ? postings : []).map((j) => ({
          title: j.title || j.jobTitle || j.job_title || '',
          location: j.locationsText || j.location || j.primaryLocation || '',
          applyUrl: j.externalPath ? `${tenantUrl}${j.externalPath}` : tenantUrl,
          description: '',
          ats_source: 'workday',
        })).filter((j) => j.title && matchesRoleKeywords(j.title))
        if (jobs.length > 0) {
          console.log(`Workday [${firmSlug}]: ${jobs.length} jobs from wd-data`)
          return jobs
        }
      } catch {
        // invalid JSON
      }
    }

    console.log(`Workday [${firmSlug}]: page loaded (${html.length} chars) but no job data parsed`)
    return [] // found a working tenant but couldn't parse jobs — don't try others
  }

  console.log(`Workday [${firmSlug}]: no working tenant URL found`)
  return []
}

/**
 * Best-effort LinkedIn job search for a firm. LinkedIn typically blocks
 * server-side requests; this is a graceful fallback only.
 *
 * @param {string} firmName
 * @returns {Promise<Array<{title, location, applyUrl, description, ats_source}>>}
 */
async function fetchLinkedInJobs(firmName) {
  const keyword = 'clinical research regulatory biostatistics'
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(firmName + ' ' + keyword)}&location=United+States`
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BOT_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(6000),
    })
    console.log(`LinkedIn [${firmName}]: HTTP ${resp.status}`)
    if (!resp.ok) return []
    const html = await resp.text()
    if (html.length < 500) return []

    const $ = cheerio.load(html)
    const jobs = []
    $('[class*="job-search-card"], [class*="result-card"], .base-card').each((_, el) => {
      if (jobs.length >= 5) return
      const $el = $(el)
      const title = $el.find('[class*="job-title"], h3').first().text().trim()
      if (!title || !matchesRoleKeywords(title)) return
      const location = $el.find('[class*="job-location"], [class*="location"]').first().text().trim()
      const href = $el.find('a').first().attr('href') || url
      jobs.push({
        title,
        location,
        applyUrl: href.startsWith('http') ? href : `https://www.linkedin.com${href}`,
        description: '',
        ats_source: 'linkedin',
      })
    })
    console.log(`LinkedIn [${firmName}]: ${jobs.length} matching jobs`)
    return jobs
  } catch (err) {
    console.log(`LinkedIn [${firmName}]: fetch failed (${err.message}) — skipping`)
    return []
  }
}

/**
 * Fetch actual job listings from Greenhouse, Lever, or Jobvite public API.
 * Returns array of { title, location, applyUrl, description, ats_source } objects.
 *
 * @param {{ type: string, slug: string }} ats
 * @returns {Promise<Array<{title, location, applyUrl, description, ats_source}>>}
 */
async function fetchAtsJobs(ats) {
  // Non-API ATS systems — log and return empty
  if (ats.type === 'icims') {
    console.log(`iCIMS detected — skipping (iCIMS does not have a public job listing API)`)
    return []
  }
  if (ats.type === 'workday') {
    return fetchWorkdayJobs(ats.slug)
  }

  try {
    let url, jobs = []
    if (ats.type === 'jobvite') {
      url = `https://jobs.jobvite.com/api/jobs?c=${ats.slug}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
      console.log(`Jobvite API [${ats.slug}]: HTTP ${resp.status}`)
      if (!resp.ok) return []
      const data = await resp.json()
      jobs = (data.jobs || data.requisitions || []).map((j) => ({
        title: j.title || j.jobTitle || '',
        location: j.location || j.jobLocation || '',
        applyUrl: j.applyUrl || j.url || url,
        description: String(j.description || j.jobDescription || '').replace(/<[^>]*>/g, '').slice(0, 500),
        ats_source: 'jobvite',
      }))
      const matched = jobs.filter((j) => matchesRoleKeywords(j.title))
      console.log(`Jobvite API [${ats.slug}]: ${jobs.length} total jobs, ${matched.length} matching`)
      return matched
    } else if (ats.type === 'greenhouse') {
      // ?content=true returns full job descriptions
      url = `https://boards-api.greenhouse.io/v1/boards/${ats.slug}/jobs?content=true`
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
      console.log(`Greenhouse API [${ats.slug}]: HTTP ${resp.status}`)
      if (!resp.ok) {
        const snippet = await resp.text().catch(() => '')
        console.log(`Greenhouse API [${ats.slug}]: error body: ${snippet.substring(0, 200)}`)
        return []
      }
      const text = await resp.text()
      console.log(`Greenhouse API [${ats.slug}]: response snippet: ${text.substring(0, 200)}`)
      const data = JSON.parse(text)
      jobs = (data.jobs || []).map((j) => ({
        title: j.title || '',
        location: j.location?.name || '',
        applyUrl: j.absolute_url || url,
        description: String(j.content || '').replace(/<[^>]*>/g, '').slice(0, 500),
        ats_source: 'greenhouse',
      }))
      console.log(`Greenhouse API [${ats.slug}]: all titles: ${jobs.map((j) => j.title).slice(0, 20).join(' | ')}`)
      const matched = jobs.filter((j) => matchesRoleKeywords(j.title))
      console.log(`Greenhouse API [${ats.slug}]: ${jobs.length} total jobs, ${matched.length} matching keywords`)
      return matched
    } else {
      // Lever
      url = `https://api.lever.co/v0/postings/${ats.slug}?mode=json`
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
      console.log(`Lever API [${ats.slug}]: HTTP ${resp.status}`)
      if (!resp.ok) return []
      const data = await resp.json()
      jobs = (Array.isArray(data) ? data : []).map((j) => ({
        title: j.text || '',
        location: j.categories?.location || j.workplaceType || '',
        applyUrl: j.hostedUrl || url,
        description: String(j.descriptionPlain || '').slice(0, 500),
        ats_source: 'lever',
      }))
      console.log(`Lever API [${ats.slug}]: all titles: ${jobs.map((j) => j.title).slice(0, 20).join(' | ')}`)
      const matched = jobs.filter((j) => matchesRoleKeywords(j.title))
      console.log(`Lever API [${ats.slug}]: ${jobs.length} total jobs, ${matched.length} matching keywords`)
      return matched
    }
  } catch (err) {
    console.warn(`ATS API error (${ats.type}/${ats.slug}): ${err.message}`)
    return []
  }
}

/**
 * Parse JSON-LD JobPosting schema blocks from HTML.
 *
 * @param {string} html
 * @returns {Array<{title, location, applyUrl}>}
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

/**
 * Scrape job listings from static career page HTML by looking for anchor tags
 * whose href contains job-specific URL path segments and whose text matches
 * life sciences role keywords.
 *
 * @param {string} html
 * @param {string} baseUrl  Used to resolve relative hrefs
 * @param {string} firmName Used for logging
 * @returns {Array<{title, location, applyUrl}>}
 */
function scrapeHtmlJobs(html, baseUrl, firmName) {
  const jobs = []
  const JOB_HREF_RE = /\/(job|opening|position|apply|posting|requisition|vacancy|role)s?\//i
  try {
    const $ = cheerio.load(html)
    $('nav, footer, script, style, header').remove()

    $('a[href]').each((_, el) => {
      if (jobs.length >= 10) return
      const $el = $(el)
      const href = $el.attr('href') || ''
      const title = $el.text().trim().replace(/\s+/g, ' ')
      if (!title || title.length < 5 || title.length > 150) return
      if (!matchesRoleKeywords(title)) return
      if (!JOB_HREF_RE.test(href) && !href) return

      let applyUrl = href
      if (!href.startsWith('http')) {
        try {
          applyUrl = href.startsWith('/')
            ? new URL(href, baseUrl).href
            : `${baseUrl.replace(/\/$/, '')}/${href}`
        } catch {
          applyUrl = baseUrl
        }
      }

      const $parent = $el.closest('li, div, article, tr')
      const locText = $parent
        .find('[class*="location"], [class*="city"], [class*="loc"]')
        .first()
        .text()
        .trim()

      jobs.push({ title: title.slice(0, 120), location: locText.slice(0, 80), applyUrl })
    })
  } catch (err) {
    console.warn(`HTML scrape error for ${firmName}: ${err.message}`)
  }
  return jobs
}

/**
 * Fetch job listings from a firm's career page using all available strategies.
 * Returns array of { title, location, applyUrl, description, ats_source }.
 * No client inference — returns job data only.
 *
 * @param {string} careersUrl
 * @param {string} firmName
 * @returns {Promise<Array<{title, location, applyUrl, description, ats_source}>>}
 */
async function fetchCareerPageJobs(careersUrl, firmName) {
  if (!careersUrl) return []

  let html = ''
  try {
    const resp = await fetch(careersUrl, {
      headers: { 'User-Agent': BOT_UA },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })
    if (!resp.ok) return []
    html = await resp.text()
  } catch {
    return []
  }

  if (html.length < 200) {
    console.log(`${firmName}: career page response too short (${html.length} chars)`)
    return []
  }

  // ── Strategy 1: ATS API (Greenhouse / Lever / Jobvite / Workday) ───────────
  const ats = detectAtsSlug(html)
  if (ats) {
    console.log(`${firmName}: detected ATS ${ats.type}/${ats.slug}`)
    const atsJobs = await fetchAtsJobs(ats)
    if (atsJobs.length > 0) {
      console.log(`${firmName}: ${atsJobs.length} ATS jobs via ${ats.type}`)
      return atsJobs
    }
  }

  // ── Strategy 2: JSON-LD JobPosting schema ──────────────────────────────────
  const ldJobs = parseJsonLdJobs(html)
  if (ldJobs.length > 0) {
    console.log(`${firmName}: ${ldJobs.length} JSON-LD jobs`)
    return ldJobs.map((j) => ({ ...j, description: '', ats_source: 'json-ld' }))
  }

  // ── Strategy 3: <a href> scan for job-path anchors ─────────────────────────
  const htmlJobs = scrapeHtmlJobs(html, careersUrl, firmName)
  if (htmlJobs.length > 0) {
    console.log(`${firmName}: ${htmlJobs.length} HTML-scraped jobs`)
    return htmlJobs.map((j) => ({ ...j, description: '', ats_source: 'html-scrape' }))
  }

  // ── LinkedIn fallback: best-effort for iCIMS / JS-rendered / unknown ATS ───
  const $check = cheerio.load(html)
  $check('nav, footer, script, style, header').remove()
  const visibleText = $check.text().replace(/\s+/g, ' ').trim()
  console.log(`${firmName}: no job listings found (${visibleText.length} chars visible) — trying LinkedIn fallback`)

  const liJobs = await fetchLinkedInJobs(firmName)
  if (liJobs.length > 0) {
    return liJobs
  }

  return []
}

// ─── Persist a single competitor activity signal ───────────────────────────────
// Dedup key is job URL + title hash per ISO week — one signal per unique job.

async function persistCompetitorSignal(firmName, jobUrl, jobTitle, jobLocation, jobDescription = '', atsSource = '') {
  // US-only: skip jobs with a non-US location
  if (jobLocation && NON_US_JOB_LOC.test(jobLocation)) {
    console.log(`[competitorJobBoard] FILTERED (non-US job location): "${jobLocation}" — ${jobTitle}`)
    return false
  }

  const firmCompany = await upsertCompany(supabase, { name: firmName })
  if (!firmCompany) return false

  // Dedup key: job URL + title slug per week
  const titleSlug = jobTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${jobUrl || 'https://biosignal.app'}#${titleSlug}-week-${weekNum}`
  const exists = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id: firmCompany.id,
    signal_type: 'competitor_job_posting',
    signal_summary: `${firmName}: "${jobTitle}"`,
    signal_detail: {
      job_title: jobTitle,
      job_location: jobLocation,
      posting_date: today,
      competitor_firm: firmName,
      job_url: jobUrl || '',
      job_description: jobDescription,
      ats_source: atsSource,
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
    console.log(`Competitor seed: ${seedResult.seeded} inserted, ${seedResult.skipped} skipped`)

    // ── Step 2: Load active firms from DB ───────────────────────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name, careers_url')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = allFirms || []
    console.log(`Competitor Job Board: processing ${firmsToCheck.length} active firms`)

    let firmsChecked = 0

    // ── Step 3: Initialise LinkedIn client (Source A) ────────────────────────
    // Max 10 LinkedIn requests per run (one per firm). Returns null when
    // LINKEDIN_EMAIL / LINKEDIN_PASSWORD are not set — fails gracefully.
    let linkedin = null;
    try {
      linkedin = await createLinkedInClient()
      if (linkedin) {
        console.log('[competitorJobBoard] LinkedIn client ready — will supplement career-page results')
      }
    } catch (err) {
      console.log(`[competitorJobBoard] LinkedIn init error: ${err.message} — continuing without LinkedIn`)
    }

    // ── Step 4: For each firm, fetch jobs and emit signals ───────────────────
    for (const firm of firmsToCheck) {
      firmsChecked++
      const jobs = await fetchCareerPageJobs(firm.careers_url, firm.name)

      if (jobs.length > 0) {
        // Emit one signal per matching job (capped at 5 per firm per run)
        for (const job of jobs.slice(0, 5)) {
          const inserted = await persistCompetitorSignal(
            firm.name,
            job.applyUrl || firm.careers_url,
            job.title,
            job.location || '',
            job.description || '',
            job.ats_source || '',
          )
          if (inserted) signalsFound++
        }
      }

      // ── LinkedIn Source A: supplement with LinkedIn job search ─────────────
      // Cap at first 10 firms to stay within the 10-request-per-run limit.
      if (linkedin?.isAvailable && firmsChecked <= 10) {
        try {
          const ROLE_KEYWORDS = 'clinical trial coordinator regulatory affairs CRA'
          const liJobs = await linkedin.searchJobs(ROLE_KEYWORDS, firm.name)
          let liInserted = 0
          for (const job of liJobs.slice(0, 5)) {
            if (!matchesRoleKeywords(job.title)) continue
            if (NON_US_JOB_LOC.test(job.location)) continue
            const inserted = await persistCompetitorSignal(
              firm.name,
              job.jobUrl || firm.careers_url,
              job.title,
              job.location || '',
              '',
              'linkedin',
            )
            if (inserted) { signalsFound++; liInserted++ }
          }
          if (liInserted > 0) {
            console.log(`${firm.name}: +${liInserted} LinkedIn jobs`)
          }
        } catch (err) {
          console.log(`[competitorJobBoard] LinkedIn error for ${firm.name}: ${err.message}`)
        }
      }

      console.log(`${firm.name}: ${jobs.length} matching jobs (career page)`)

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

    console.log(`Competitor Job Board Agent complete — signals: ${signalsFound}, firms checked: ${firmsChecked}`)

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
