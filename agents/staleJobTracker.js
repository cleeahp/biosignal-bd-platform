import { supabase } from '../lib/supabase.js'
import * as cheerio from 'cheerio'

// ─── Target role keywords ───────────────────────────────────────────────────────
const SEARCH_KEYWORDS = [
  'Clinical Research Associate',
  'CRA',
  'Regulatory Affairs',
  'Quality Assurance Specialist',
  'Biostatistician',
  'Clinical Data Manager',
  'Medical Affairs',
  'Pharmacovigilance',
  'Clinical Trial Manager',
  'Validation Engineer',
]

const LIFE_SCIENCES_KEYWORDS = [
  'clinical research associate', 'cra', 'clinical research coordinator', 'crc',
  'clinical trial manager', 'regulatory affairs', 'quality assurance', 'qa specialist',
  'biostatistician', 'data manager', 'clinical data manager', 'pharmacovigilance',
  'drug safety', 'medical monitor', 'clinical operations', 'site monitor',
  'study coordinator', 'medical affairs', 'validation engineer', 'statistical programmer',
]

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function isLifeSciencesJob(title) {
  const t = title.toLowerCase()
  return LIFE_SCIENCES_KEYWORDS.some((kw) => t.includes(kw))
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

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

function daysSince(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

// ─── SOURCE 1: Indeed RSS ───────────────────────────────────────────────────────
// RSS format provides pubDate (original posting date) and company via <source> tag.
// fromage=30 returns jobs posted at least 30 days ago (the "stale" definition).
// Note: may return HTTP 403 from some IP ranges (Cloudflare blocks); agent
// gracefully skips to BioSpace when Indeed is unavailable.

async function fetchIndeedRss(keyword) {
  const jobs = []
  try {
    const q = encodeURIComponent(keyword)
    const url = `https://www.indeed.com/rss?q=${q}&l=&fromage=30&sort=date`
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!resp.ok) {
      console.warn(`  Indeed RSS returned HTTP ${resp.status} for "${keyword}" (may be blocked — BioSpace fallback active)`)
      return jobs
    }

    const xml = await resp.text()
    // Verify it's RSS (not a CAPTCHA/error HTML page)
    if (!xml.includes('<rss') && !xml.includes('<feed') && !xml.includes('<item>')) {
      console.warn(`  Indeed RSS response is not valid XML for "${keyword}"`)
      return jobs
    }

    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
    for (const item of items) {
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim()
      const link  = item.match(/<link>(.*?)<\/link>/s)?.[1]?.trim()
      const pubDateStr = item.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1]?.trim()
      const company = item.match(/<source[^>]*>(.*?)<\/source>/s)?.[1]?.trim()
        || item.match(/<author>(.*?)<\/author>/s)?.[1]?.trim()

      if (!title || !link) continue
      if (!isLifeSciencesJob(title)) continue

      const daysPosted = daysSince(pubDateStr) ?? 30
      const datePosted = pubDateStr
        ? new Date(pubDateStr).toISOString().split('T')[0]
        : null

      // Extract location from description if present
      const descRaw = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1] || ''
      const locMatch = descRaw.replace(/<[^>]+>/g, '').match(/([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})\b/)
      const location = locMatch?.[1] || ''

      jobs.push({
        title,
        company: company || 'Unknown Company',
        location,
        link,
        datePosted,
        daysPosted,
        source: 'Indeed',
      })
    }

    console.log(`  Indeed RSS "${keyword}": ${jobs.length} stale jobs found`)
  } catch (err) {
    console.warn(`  Indeed RSS fetch failed for "${keyword}": ${err.message}`)
  }
  return jobs
}

// ─── SOURCE 2: BioSpace ─────────────────────────────────────────────────────────
// BioSpace is server-side rendered. Jobs are in HTML with:
//   - Title in <span> inside <h3 class="lister__header">
//   - Company from <img class="lister__logo"> alt text (strip " logo" suffix)
//   - Age badge: <p class="badge" title="Added in the last N days">
// URL: https://www.biospace.com/jobs/?discipline=Clinical-Research
// We emit a signal for every unique Life Sciences job found at a company not
// already seen today; days_posted is extracted from the badge or estimated.

async function fetchBioSpaceJobs() {
  const jobs = []
  try {
    const resp = await fetch('https://www.biospace.com/jobs/?discipline=Clinical-Research', {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) {
      console.warn(`  BioSpace returned HTTP ${resp.status}`)
      return jobs
    }

    const html = await resp.text()
    const $ = cheerio.load(html)

    // Each job is in a div/article with id="item-{jobId}"
    $('[id^="item-"]').each((_, el) => {
      const $item = $(el)

      // Title: first <span> inside .lister__header
      const title = $item.find('.lister__header span').first().text().trim()
        || $item.find('h3 span').first().text().trim()
      if (!title || !isLifeSciencesJob(title)) return

      // Company: from logo alt text, stripping " logo" suffix
      let company = ''
      const logoAlt = $item.find('img.lister__logo, img[class*="logo"]').first().attr('alt') || ''
      if (logoAlt) {
        company = logoAlt.replace(/\s+logo\s*$/i, '').trim()
      }
      if (!company || company.length < 2) return // skip if no company found

      // Job URL: from href containing /job/
      let jobUrl = ''
      const linkHref = $item.find('a[href*="/job/"]').first().attr('href') || ''
      if (linkHref) {
        const cleanHref = linkHref.replace(/[\s\n\t]/g, '') // strip whitespace in href (BioSpace HTML quirk)
        jobUrl = cleanHref.startsWith('http') ? cleanHref : `https://jobs.biospace.com${cleanHref}`
      }
      if (!jobUrl) jobUrl = 'https://www.biospace.com/jobs/?discipline=Clinical-Research'

      // Days posted: from badge title "Added in the last N days"
      let daysPosted = 30 // default: treat as at-threshold
      const badgeTitle = $item.find('.badge[title], [class*="badge"][title]').first().attr('title') || ''
      const daysMatch = badgeTitle.match(/Added in the last (\d+) day/i)
      if (daysMatch) {
        daysPosted = parseInt(daysMatch[1], 10)
      }

      // Location: from any location element
      const location = $item.find('[class*="location"], [class*="city"]').first().text().trim() || ''

      jobs.push({ title, company, location, link: jobUrl, daysPosted, source: 'BioSpace', datePosted: null })
    })

    console.log(`  BioSpace: ${jobs.length} Life Sciences jobs found`)
  } catch (err) {
    console.warn(`  BioSpace fetch failed: ${err.message}`)
  }
  return jobs
}

// ─── Process a single job into a signal ────────────────────────────────────────

const WARMTH_SCORES = { active_client: 25, past_client: 18, in_ats: 10, new_prospect: 0 }

async function processJobSignal(job) {
  const company = await upsertCompany(job.company)
  if (!company) return false

  // Deduplicate: one signal per company+role per source URL
  const sourceUrl = job.link
  const alreadySignaled = await signalExists(company.id, 'stale_job_posting', sourceUrl)
  if (alreadySignaled) return false

  const warmthScore = WARMTH_SCORES[company.relationship_warmth] || 0
  // Priority boosts for older postings and warmer companies
  let signalStrength = 15
  if (job.daysPosted >= 60) signalStrength = 20
  else if (job.daysPosted >= 30) signalStrength = 17

  const priorityScore = Math.min(signalStrength + 15 + warmthScore, 100)
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id: company.id,
    signal_type: 'stale_job_posting',
    signal_summary: `"${job.title}" at ${job.company} has been posted for ${job.daysPosted}+ days — potential staffing need`,
    signal_detail: {
      company_name: job.company,
      job_title: job.title,
      job_location: job.location || 'Unknown',
      date_posted: job.datePosted || today,
      days_posted: job.daysPosted,
      source_url: job.link,
      job_board: job.source,
    },
    source_url: sourceUrl,
    source_name: job.source,
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: priorityScore,
    score_breakdown: {
      signal_strength: signalStrength,
      recency: 15,
      relationship_warmth: warmthScore,
      actionability: 0,
    },
    days_in_queue: 0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`  Signal insert failed for ${job.company}/"${job.title}": ${error.message}`)
    return false
  }
  return true
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function runStaleJobTracker() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'stale_job_tracker', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    const allJobs = []

    // ── Sources: Indeed RSS (3 keywords) + BioSpace in parallel ─────────────
    // Parallel fetch keeps total wall-clock time within Vercel's 30s function limit.
    // Indeed uses fromage=30 (30+ day old jobs); BioSpace is always available.
    const [indeedResults, bioSpaceResult] = await Promise.allSettled([
      Promise.all(SEARCH_KEYWORDS.slice(0, 3).map((kw) => fetchIndeedRss(kw))),
      fetchBioSpaceJobs(),
    ])

    if (indeedResults.status === 'fulfilled') {
      for (const jobs of indeedResults.value) allJobs.push(...jobs)
    } else {
      console.warn(`Indeed RSS batch failed: ${indeedResults.reason?.message}`)
    }

    if (bioSpaceResult.status === 'fulfilled') {
      allJobs.push(...bioSpaceResult.value)
    } else {
      console.warn(`BioSpace fetch failed: ${bioSpaceResult.reason?.message}`)
    }

    // Deduplicate by (company, title) to avoid processing same role twice from different sources
    const jobMap = new Map()
    for (const job of allJobs) {
      const key = `${job.company.toLowerCase()}|${job.title.toLowerCase()}`
      if (!jobMap.has(key)) {
        jobMap.set(key, job)
      }
    }

    // Cap to MAX_JOBS_PER_RUN to stay within Vercel's 30s function limit.
    // Each job requires 3-4 sequential DB calls; >25 jobs risks timeout.
    const MAX_JOBS_PER_RUN = 20
    const uniqueJobs = Array.from(jobMap.values()).slice(0, MAX_JOBS_PER_RUN)
    console.log(`Stale Job Tracker: processing ${uniqueJobs.length} unique jobs (${allJobs.length} total from all sources)`)

    for (const job of uniqueJobs) {
      const inserted = await processJobSignal(job)
      if (inserted) signalsFound++
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          total_jobs_found: allJobs.length,
          unique_jobs: uniqueJobs.length,
          indeed_jobs: allJobs.filter((j) => j.source === 'Indeed').length,
          biospace_jobs: allJobs.filter((j) => j.source === 'BioSpace').length,
        },
      })
      .eq('id', runId)

    console.log(`Stale Job Tracker complete. Signals: ${signalsFound}`)
    return { success: true, signalsFound, jobsFound: allJobs.length, jobsProcessed: uniqueJobs.length }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Stale Job Tracker failed:', error.message)
    return { success: false, error: error.message }
  }
}
