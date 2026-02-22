/**
 * Target Company Jobs Agent
 *
 * Searches career pages of companies that already have active BD signals
 * (clinical trials, funding, M&A) and creates 'target_company_job' signals
 * for open CRO/clinical/regulatory roles.
 *
 * These are warm leads: the company already appears in our pipeline and is
 * now hiring — a strong indicator they need external support (CRO, staffing).
 */

import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient } from '../lib/linkedinClient.js'
import * as cheerio from 'cheerio'

const BOT_UA = 'Mozilla/5.0 (compatible; BioSignalBot/1.0)'
const MAX_COMPANIES_PER_RUN = 50

// Skip job locations outside the US
const NON_US_JOB_LOC =
  /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan)\b/i

// Why this company is a warm lead, based on the type of signal they have
const SIGNAL_REASON_MAP = {
  clinical_trial_phase_transition: 'Active clinical trial',
  clinical_trial_new_ind:          'New IND filed',
  funding_new_award:               'Recent funding',
  ma_transaction:                  'Recent M&A activity',
}

// ─── Domain / URL inference ────────────────────────────────────────────────────

/**
 * Strip legal and descriptor suffixes from a company name to derive a URL slug.
 * e.g. "Vertex Pharmaceuticals Inc." → "vertex"
 */
function nameToDomainSlug(companyName) {
  const cleaned = companyName
    .replace(/,?\s+(inc\.?|incorporated|corp\.?|corporation|llc|ltd\.?|limited|plc|pvt\.?)$/i, '')
    .replace(/\s+(pharmaceuticals?|therapeutics?|biosciences?|biologics?|biotech\b|biopharma|biopharmaceutical|genomics?|oncology|medical|healthcare|life sciences?)$/i, '')
    .trim()
  return cleaned.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Try a set of common career page URL patterns and return the first one that responds.
 * Returns null if no candidate responds with a non-error status.
 */
async function findCareersUrl(companyName, domain) {
  const domainBase = domain ? domain.replace(/^www\./, '') : null
  const nameSlug = nameToDomainSlug(companyName)

  const candidates = []
  if (domainBase) {
    candidates.push(
      `https://www.${domainBase}/careers`,
      `https://www.${domainBase}/jobs`,
      `https://careers.${domainBase}/`,
    )
  }
  if (nameSlug && nameSlug.length >= 4) {
    const nameBase = `${nameSlug}.com`
    if (nameBase !== domainBase) {
      candidates.push(
        `https://www.${nameBase}/careers`,
        `https://${nameBase}/careers`,
        `https://careers.${nameBase}/`,
      )
    }
  }

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      })
      if (resp.status < 400 || resp.status === 405) return url
    } catch {
      // try next candidate
    }
  }
  return null
}

// ─── ATS detection + job fetching ─────────────────────────────────────────────

/** Detect Greenhouse or Lever ATS board from career page HTML. */
function detectAtsBoard(html) {
  const ghEmbed = html.match(/boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i)
  if (ghEmbed) return { type: 'greenhouse', slug: ghEmbed[1] }

  const ghDirect = html.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9_-]+)/i)
  if (ghDirect && !['embed', 'v1', 'boards', 'jobs'].includes(ghDirect[1].toLowerCase())) {
    return { type: 'greenhouse', slug: ghDirect[1] }
  }

  const lever = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i)
  if (lever) return { type: 'lever', slug: lever[1] }

  return null
}

/** Fetch matching jobs from a Greenhouse or Lever ATS board. */
async function fetchAtsJobs(ats) {
  try {
    if (ats.type === 'greenhouse') {
      const resp = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ats.slug}/jobs`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return []
      const data = await resp.json()
      return (data.jobs || [])
        .map((j) => ({ title: j.title || '', location: j.location?.name || '', applyUrl: j.absolute_url || '' }))
        .filter((j) => j.title && matchesRoleKeywords(j.title))
    } else {
      const resp = await fetch(`https://api.lever.co/v0/postings/${ats.slug}?mode=json`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return []
      const data = await resp.json()
      return (Array.isArray(data) ? data : [])
        .map((j) => ({ title: j.text || '', location: j.categories?.location || '', applyUrl: j.hostedUrl || '' }))
        .filter((j) => j.title && matchesRoleKeywords(j.title))
    }
  } catch {
    return []
  }
}

/** Parse JSON-LD JobPosting schema blocks from HTML. */
function parseJsonLdJobs(html) {
  const jobs = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      const schema = JSON.parse(m[1])
      const items =
        schema['@type'] === 'JobPosting'
          ? [schema]
          : (schema['@graph'] || []).filter((x) => x['@type'] === 'JobPosting')
      for (const item of items) {
        const title = item.title || item.name || ''
        if (!title || !matchesRoleKeywords(title)) continue
        const loc = item.jobLocation?.address?.addressLocality || ''
        const region = item.jobLocation?.address?.addressRegion || ''
        jobs.push({ title, location: [loc, region].filter(Boolean).join(', '), applyUrl: item.url || item.sameAs || '' })
      }
    } catch {
      // invalid JSON-LD
    }
  }
  return jobs
}

/** Scrape anchor tags with job-path hrefs from static HTML. */
function scrapeHtmlJobs(html, baseUrl) {
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
      if (!JOB_HREF_RE.test(href)) return
      let applyUrl = href
      if (!href.startsWith('http')) {
        try {
          applyUrl = href.startsWith('/') ? new URL(href, baseUrl).href : `${baseUrl.replace(/\/$/, '')}/${href}`
        } catch {
          applyUrl = baseUrl
        }
      }
      jobs.push({ title: title.slice(0, 120), location: '', applyUrl })
    })
  } catch {
    // ignore scraping errors
  }
  return jobs
}

/**
 * Fetch matching job listings from a company's career page.
 * Priority: ATS API (Greenhouse/Lever) → JSON-LD → HTML scrape.
 */
async function fetchTargetCompanyJobs(careersUrl, companyName) {
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
  if (html.length < 200) return []

  // Strategy 1: ATS API
  const ats = detectAtsBoard(html)
  if (ats) {
    console.log(`[targetCompanyJobs] ${companyName}: ATS detected (${ats.type}/${ats.slug})`)
    const jobs = await fetchAtsJobs(ats)
    if (jobs.length > 0) return jobs
  }

  // Strategy 2: JSON-LD
  const ldJobs = parseJsonLdJobs(html)
  if (ldJobs.length > 0) return ldJobs

  // Strategy 3: HTML anchor scrape
  return scrapeHtmlJobs(html, careersUrl)
}

// ─── BioSpace stale jobs source ────────────────────────────────────────────────

/**
 * Parse a relative or fuzzy date string into an approximate days-ago number.
 * e.g. "30 days ago" → 30, "2 months ago" → 60, "Jan 15, 2026" → computed diff
 */
function parseDaysPosted(dateText) {
  if (!dateText) return 0
  const lower = dateText.toLowerCase()
  const daysMatch = lower.match(/(\d+)\s+day/)
  if (daysMatch) return parseInt(daysMatch[1])
  const weeksMatch = lower.match(/(\d+)\s+week/)
  if (weeksMatch) return parseInt(weeksMatch[1]) * 7
  const monthsMatch = lower.match(/(\d+)\s+month/)
  if (monthsMatch) return parseInt(monthsMatch[1]) * 30
  // Try absolute date parse
  try {
    const date = new Date(dateText)
    if (!isNaN(date.getTime())) {
      return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
    }
  } catch { /* ignore */ }
  return 0
}

/**
 * Fetch stale job listings from BioSpace for a given category.
 * Only returns jobs where days_posted >= 30 and role matches life sciences keywords.
 *
 * @param {'Biotechnology'|'Pharmaceutical'} category
 * @returns {Promise<Array<{title, company, location, jobUrl, daysPosted, category}>>}
 */
async function fetchBioSpaceJobs(category) {
  const url = `https://www.biospace.com/jobs/?category=${encodeURIComponent(category)}&days=30`
  const jobs = []
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BOT_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    })
    console.log(`[targetCompanyJobs] BioSpace ${category}: HTTP ${resp.status}`)
    if (!resp.ok) return jobs
    const html = await resp.text()
    const $ = cheerio.load(html)

    // Try common BioSpace job card selectors
    $('[data-testid="job-card"], .job-card, article[class*="job"], [class*="position-card"], li[class*="job-listing"]').each((_, el) => {
      if (jobs.length >= 50) return
      const $el = $(el)
      const title = $el.find('[data-testid="job-title"], .job-title, h2, h3, [class*="title"]').first().text().trim()
      const company = $el.find('[data-testid="company-name"], .company-name, [class*="company"]').first().text().trim()
      const location = $el.find('[data-testid="location"], .location, [class*="location"]').first().text().trim()
      const dateText = $el.find('time, [data-testid="date"], [class*="date"], [class*="posted"]').first().text().trim()
      const href = $el.find('a[href*="/jobs/"]').first().attr('href') || $el.find('a').first().attr('href') || ''
      const jobUrl = href.startsWith('http') ? href : `https://www.biospace.com${href}`

      if (!title || !matchesRoleKeywords(title)) return
      if (NON_US_JOB_LOC.test(location)) return

      const daysPosted = parseDaysPosted(dateText)
      if (daysPosted < 30) return

      jobs.push({ title, company, location, jobUrl, daysPosted, category })
    })

    // Fallback: scan JSON-LD if no cards found
    if (jobs.length === 0) {
      const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      let m
      while ((m = re.exec(html)) !== null) {
        try {
          const schema = JSON.parse(m[1])
          const items = schema['@type'] === 'JobPosting'
            ? [schema]
            : (schema['@graph'] || []).filter((x) => x['@type'] === 'JobPosting')
          for (const item of items) {
            if (jobs.length >= 50) break
            const title = item.title || item.name || ''
            if (!title || !matchesRoleKeywords(title)) continue
            const company = item.hiringOrganization?.name || ''
            const loc = item.jobLocation?.address?.addressLocality || ''
            const region = item.jobLocation?.address?.addressRegion || ''
            const location = [loc, region].filter(Boolean).join(', ')
            if (NON_US_JOB_LOC.test(location)) continue
            const datePosted = item.datePosted || ''
            const daysPosted = datePosted ? parseDaysPosted(datePosted) : 30
            if (daysPosted < 30) continue
            jobs.push({ title, company, location, jobUrl: item.url || url, daysPosted, category })
          }
        } catch { /* ignore */ }
      }
    }

    console.log(`[targetCompanyJobs] BioSpace ${category}: ${jobs.length} stale matching jobs`)
  } catch (err) {
    console.log(`[targetCompanyJobs] BioSpace ${category} fetch error: ${err.message}`)
  }
  return jobs
}

/**
 * Persist a stale_job_posting signal from BioSpace or LinkedIn.
 * Upserts the company if not already in DB.
 *
 * @param {{ company, title, location, jobUrl, daysPosted, category, source? }} job
 */
async function persistStaleJobSignal(job) {
  if (!job.company || job.company.length < 2) return false

  const company = await upsertCompany(supabase, { name: job.company })
  if (!company) return false

  const source = job.source || 'BioSpace'
  const titleSlug = job.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${job.jobUrl}#stale-${titleSlug}-week-${weekNum}`

  const { data: existing } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', company.id)
    .eq('signal_type', 'stale_job_posting')
    .eq('source_url', sourceUrl)
    .maybeSingle()
  if (existing) return false

  const today = new Date().toISOString().split('T')[0]
  const { error } = await supabase.from('signals').insert({
    company_id: company.id,
    signal_type: 'stale_job_posting',
    signal_summary: `${job.company}: "${job.title}" open ${job.daysPosted}+ days`,
    signal_detail: {
      company_name: job.company,
      job_title: job.title,
      job_location: job.location || '',
      job_url: job.jobUrl || '',
      days_posted: job.daysPosted,
      date_found: today,
      source,
      category: job.category || source,
    },
    source_url: sourceUrl,
    source_name: source,
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: 20,
    score_breakdown: { signal_strength: 20 },
    days_in_queue: 0,
    is_carried_forward: false,
  })
  return !error
}

// ─── Dedup helper ──────────────────────────────────────────────────────────────

async function targetJobSignalExists(companyId, titleSlug) {
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `biosignal://target-job/${companyId}/${titleSlug}/week-${weekNum}`
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', 'target_company_job')
    .eq('source_url', sourceUrl)
    .maybeSingle()
  return { exists: !!data, sourceUrl }
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function run() {
  const { data: runEntry } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'target-company-jobs-agent', status: 'running', started_at: new Date().toISOString() })
    .select()
    .single()
  const runId = runEntry?.id
  let signalsFound = 0

  try {
    // Step 1: Find companies that have active BD signals
    const { data: signalRows } = await supabase
      .from('signals')
      .select('company_id, signal_type')
      .in('signal_type', [
        'clinical_trial_phase_transition',
        'clinical_trial_new_ind',
        'funding_new_award',
        'ma_transaction',
      ])
      .in('status', ['new', 'carried_forward', 'claimed', 'contacted'])
      .order('created_at', { ascending: false })
      .limit(500)

    if (!signalRows || signalRows.length === 0) {
      console.log('[targetCompanyJobs] No signal companies found')
      await supabase.from('agent_runs').update({ status: 'completed', completed_at: new Date().toISOString(), signals_found: 0 }).eq('id', runId)
      return { signalsFound: 0, companiesChecked: 0 }
    }

    // Deduplicate: keep the most recent signal type per company
    const companySignalTypeMap = new Map()
    for (const row of signalRows) {
      if (!companySignalTypeMap.has(row.company_id)) {
        companySignalTypeMap.set(row.company_id, row.signal_type)
      }
    }

    const companyIds = [...companySignalTypeMap.keys()].slice(0, MAX_COMPANIES_PER_RUN)

    // Step 2: Load company details (name, domain)
    const { data: companies } = await supabase
      .from('companies')
      .select('id, name, domain')
      .in('id', companyIds)

    if (!companies || companies.length === 0) {
      console.log('[targetCompanyJobs] No company details found')
      await supabase.from('agent_runs').update({ status: 'completed', completed_at: new Date().toISOString(), signals_found: 0 }).eq('id', runId)
      return { signalsFound: 0, companiesChecked: 0 }
    }

    console.log(`[targetCompanyJobs] Checking ${companies.length} signal companies for open roles`)
    let companiesChecked = 0
    const today = new Date().toISOString().split('T')[0]

    for (const company of companies) {
      companiesChecked++
      const signalReason = SIGNAL_REASON_MAP[companySignalTypeMap.get(company.id)] || 'Signal company'

      // Step 3: Infer careers URL
      const careersUrl = await findCareersUrl(company.name, company.domain)
      if (!careersUrl) {
        console.log(`[targetCompanyJobs] ${company.name}: no careers URL found`)
        await new Promise((r) => setTimeout(r, 200))
        continue
      }

      console.log(`[targetCompanyJobs] ${company.name}: careers at ${careersUrl}`)

      // Step 4: Fetch matching jobs
      const jobs = await fetchTargetCompanyJobs(careersUrl, company.name)
      console.log(`[targetCompanyJobs] ${company.name}: ${jobs.length} matching jobs (reason: ${signalReason})`)

      // Step 5: Create signals (cap at 3 per company per run)
      for (const job of jobs.slice(0, 3)) {
        // US-only
        if (job.location && NON_US_JOB_LOC.test(job.location)) {
          console.log(`[targetCompanyJobs] FILTERED (non-US): "${job.location}" — ${job.title}`)
          continue
        }

        const titleSlug = job.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
        const { exists, sourceUrl } = await targetJobSignalExists(company.id, titleSlug)
        if (exists) continue

        const { error } = await supabase.from('signals').insert({
          company_id: company.id,
          signal_type: 'target_company_job',
          signal_summary: `${company.name} is hiring: "${job.title}"${job.location ? ` (${job.location})` : ''}`,
          signal_detail: {
            company_name: company.name,
            job_title: job.title,
            job_location: job.location || '',
            job_url: job.applyUrl || careersUrl,
            careers_url: careersUrl,
            date_found: today,
            signal_reason: signalReason,
          },
          source_url: sourceUrl,
          source_name: 'CareersPage',
          first_detected_at: new Date().toISOString(),
          status: 'new',
          priority_score: 25,
          score_breakdown: { signal_strength: 25 },
          days_in_queue: 0,
          is_carried_forward: false,
        })
        if (!error) signalsFound++
      }

      // Respect rate limits between companies
      await new Promise((r) => setTimeout(r, 500))
    }

    // ── Step 6: Initialise LinkedIn client (Source B) ────────────────────────
    let linkedin = null
    try {
      linkedin = await createLinkedInClient()
      if (linkedin) {
        console.log('[targetCompanyJobs] LinkedIn client ready — will search for stale roles')
      }
    } catch (err) {
      console.log(`[targetCompanyJobs] LinkedIn init error: ${err.message} — continuing without LinkedIn`)
    }

    // ── Step 7: BioSpace stale jobs (days_posted >= 30) ──────────────────────
    console.log('[targetCompanyJobs] Fetching stale jobs from BioSpace...')
    const [bioTechJobs, pharmaJobs] = await Promise.all([
      fetchBioSpaceJobs('Biotechnology').catch(() => []),
      fetchBioSpaceJobs('Pharmaceutical').catch(() => []),
    ])
    // Merge and deduplicate by jobUrl
    const allBioSpaceJobs = [...bioTechJobs, ...pharmaJobs]
      .filter((job, i, arr) => arr.findIndex((j) => j.jobUrl === job.jobUrl) === i)

    let staleSignalsFound = 0
    for (const job of allBioSpaceJobs) {
      const inserted = await persistStaleJobSignal(job)
      if (inserted) {
        signalsFound++
        staleSignalsFound++
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    console.log(`[targetCompanyJobs] BioSpace: ${allBioSpaceJobs.length} stale jobs processed, ${staleSignalsFound} new signals`)

    // ── Step 8: LinkedIn stale jobs (Source B — 30+ days, 20 jobs max) ───────
    let liStaleCount = 0
    if (linkedin?.isAvailable) {
      try {
        const ROLE_KEYWORDS = 'clinical research associate regulatory affairs clinical trial coordinator'
        const liJobs = await linkedin.searchJobs(ROLE_KEYWORDS)
        for (const job of liJobs) {
          if (liStaleCount >= 20) break
          if (!matchesRoleKeywords(job.title)) continue
          if (NON_US_JOB_LOC.test(job.location)) continue
          if ((job.daysPosted || 0) < 30) continue
          if (!job.company) continue
          const inserted = await persistStaleJobSignal({
            title:      job.title,
            company:    job.company,
            location:   job.location || '',
            jobUrl:     job.jobUrl || '',
            daysPosted: job.daysPosted || 30,
            source:     'LinkedIn',
          })
          if (inserted) { signalsFound++; liStaleCount++ }
          await new Promise((r) => setTimeout(r, 100))
        }
        console.log(`[targetCompanyJobs] LinkedIn Source B: ${liStaleCount} new stale job signals`)
      } catch (err) {
        console.log(`[targetCompanyJobs] LinkedIn Source B error: ${err.message}`)
      }
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          companies_checked:    companiesChecked,
          biospace_stale_jobs:  allBioSpaceJobs.length,
          linkedin_stale_jobs:  liStaleCount,
        },
      })
      .eq('id', runId)

    console.log(`[targetCompanyJobs] Done. ${signalsFound} new signals from ${companiesChecked} companies + BioSpace + LinkedIn.`)
    return { signalsFound, companiesChecked }
  } catch (err) {
    console.error('[targetCompanyJobs] Fatal error:', err.message)
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: err.message })
      .eq('id', runId)
    return { signalsFound: 0, companiesChecked: 0 }
  }
}
