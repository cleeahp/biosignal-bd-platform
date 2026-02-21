import { supabase } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import * as cheerio from 'cheerio'

const BOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ─── Shared signal helpers ─────────────────────────────────────────────────────

async function upsertCompany(name) {
  const { data } = await supabase
    .from('companies')
    .upsert({ name, industry: 'Life Sciences' }, { onConflict: 'name' })
    .select()
    .single()
  return data
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

// ─── Scoring ───────────────────────────────────────────────────────────────────

function computeScore(daysPosted) {
  let score = 15
  if (daysPosted >= 60) score += 3
  else if (daysPosted >= 30) score += 2
  return Math.min(score, 20)
}

// ─── SOURCE 1: PharmJobs.com ───────────────────────────────────────────────────
// Replaces BioSpace.com, which blocks server-side requests from Vercel IPs (0 bytes returned).
// PharmJobs uses server-rendered HTML with article.jlcol1 containers.

async function fetchPharmaJobsJobs() {
  const jobs = []
  let html
  try {
    const resp = await fetch('https://www.pharmajobs.com', {
      headers: {
        'User-Agent': BOT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!resp.ok) {
      console.warn(`PharmJobs HTTP ${resp.status}`)
      return jobs
    }
    html = await resp.text()
  } catch (err) {
    console.warn(`PharmJobs fetch error: ${err.message}`)
    return jobs
  }

  if (html.length < 1000) {
    console.warn(`PharmJobs: response too short (${html.length} chars) — may be blocked`)
    return jobs
  }

  const $ = cheerio.load(html)

  // PharmJobs structure: article.jlcol1 > a.title.joblink[title] (job title + href)
  //                                      > p.jobPostHeader span (company name)
  //                                      > p.jobPostCity span (location)
  $('article.jlcol1').each((_, el) => {
    const $item = $(el)

    const $titleLink = $item.find('a.title.joblink').first()
    const title = $titleLink.attr('title') || $titleLink.text().trim()
    if (!title || !matchesRoleKeywords(title)) return

    const companyName = $item.find('p.jobPostHeader span').first().text().trim()
    if (!companyName || companyName.length < 2) return

    const rawHref = $titleLink.attr('href') || ''
    const sourceUrl = rawHref.startsWith('http')
      ? rawHref
      : `https://www.pharmajobs.com${rawHref}`

    const location = $item.find('p.jobPostCity span').first().text().trim()

    jobs.push({
      job_title: title.substring(0, 120),
      company_name: companyName.substring(0, 100),
      job_location: location,
      date_posted: null,
      days_posted: 30,
      source_url: sourceUrl,
      job_board: 'pharmajobs',
    })
  })

  console.log(`PharmJobs: ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 2: MedZilla.com ────────────────────────────────────────────────────
// MedZilla has shifted to a blog/news format. We still attempt it but expect
// zero results; the function returns gracefully if content is unhelpful.

async function fetchMedZillaJobs() {
  const jobs = []

  const candidateUrls = [
    'https://www.medzilla.com/search.cfm',
    'https://www.medzilla.com/jobs/',
    'https://www.medzilla.com/',
  ]

  let html = null
  let successUrl = null

  for (const url of candidateUrls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': BOT_UA,
          Accept: 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(12000),
      })
      if (resp.ok) {
        const text = await resp.text()
        if (text.length > 500) {
          html = text
          successUrl = url
          console.log(`MedZilla: fetched ${html.length} chars from ${url}`)
          break
        }
        console.warn(`MedZilla ${url}: response too short (${text.length} chars)`)
      } else {
        console.warn(`MedZilla ${url}: HTTP ${resp.status}`)
      }
    } catch (err) {
      console.warn(`MedZilla ${url} fetch error: ${err.message}`)
    }
  }

  if (!html) {
    console.warn('MedZilla: no reachable URL found — skipping source')
    return jobs
  }

  const $ = cheerio.load(html)
  let parsed = 0

  // Strategy 1: table rows (MedZilla historically uses tables)
  $('table tr').each((_, el) => {
    if (parsed >= 30) return
    const $el = $(el)
    const $link = $el.find('a').first()
    const title = $link.text().trim()
    if (!title || title.length < 5 || !matchesRoleKeywords(title)) return

    const href = $link.attr('href') || ''
    const sourceUrl = href.startsWith('http')
      ? href
      : href
      ? `https://www.medzilla.com${href}`
      : successUrl

    const cells = $el.find('td')
    const companyName =
      cells.eq(1).text().trim() ||
      cells.eq(2).text().trim() ||
      'Unknown Company'

    jobs.push({
      job_title: title.substring(0, 120),
      company_name: companyName.substring(0, 100),
      job_location: cells.eq(3)?.text().trim() || '',
      date_posted: null,
      days_posted: 30,
      source_url: sourceUrl,
      job_board: 'medzilla',
    })
    parsed++
  })

  // Strategy 2: scan all anchors for matching job titles
  if (parsed === 0) {
    $('a').each((_, el) => {
      if (parsed >= 20) return
      const $el = $(el)
      const title = $el.text().trim()
      if (!title || title.length < 5 || title.length > 120) return
      if (!matchesRoleKeywords(title)) return

      const href = $el.attr('href') || ''
      if (!href || href === '#') return
      const sourceUrl = href.startsWith('http')
        ? href
        : `https://www.medzilla.com${href}`

      jobs.push({
        job_title: title.substring(0, 120),
        company_name: 'Unknown Company',
        job_location: '',
        date_posted: null,
        days_posted: 30,
        source_url: sourceUrl,
        job_board: 'medzilla',
      })
      parsed++
    })
  }

  console.log(`MedZilla: ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 3: ClinicalTrialsArena.com/jobs/ ──────────────────────────────────

async function fetchClinicalTrialsArenaJobs() {
  const jobs = []
  let html

  try {
    const resp = await fetch('https://www.clinicaltrialsarena.com/jobs/', {
      headers: {
        'User-Agent': BOT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!resp.ok) {
      console.warn(`ClinicalTrialsArena: HTTP ${resp.status}`)
      return jobs
    }
    html = await resp.text()
  } catch (err) {
    console.warn(`ClinicalTrialsArena fetch error: ${err.message}`)
    return jobs
  }

  if (html.length < 500) {
    console.warn(
      `ClinicalTrialsArena: response too short (${html.length} chars) — may be blocked`
    )
    return jobs
  }

  console.log(`ClinicalTrialsArena: fetched ${html.length} chars`)
  const $ = cheerio.load(html)
  let parsed = 0

  // Strategy 1: article or structured job listing containers
  $(
    'article, .job, [class*="job-post"], [class*="job-list"] li, .jobs-list__item, [class*="vacancy"], [class*="career"]'
  ).each((_, el) => {
    if (parsed >= 30) return
    const $el = $(el)

    const $titleLink = $el.find('h2 a, h3 a, h4 a, a[class*="title"]').first()
    const title =
      $titleLink.text().trim() ||
      $el.find('h2, h3, h4').first().text().trim()

    if (!title || !matchesRoleKeywords(title)) return

    const $link = $titleLink.length ? $titleLink : $el.find('a').first()
    const href = $link.attr('href') || ''
    const sourceUrl = href.startsWith('http')
      ? href
      : href
      ? `https://www.clinicaltrialsarena.com${href}`
      : 'https://www.clinicaltrialsarena.com/jobs/'

    const companyName =
      $el
        .find('[class*="company"], [class*="employer"], [class*="organisation"]')
        .first()
        .text()
        .trim() || 'Unknown Company'
    const location =
      $el.find('[class*="location"], [class*="city"]').first().text().trim() || ''

    jobs.push({
      job_title: title.substring(0, 120),
      company_name: companyName,
      job_location: location,
      date_posted: null,
      days_posted: 30,
      source_url: sourceUrl,
      job_board: 'clinicaltrialsarena',
    })
    parsed++
  })

  // Strategy 2: generic anchor scan for role keyword matches
  if (parsed === 0) {
    $('a').each((_, el) => {
      if (parsed >= 20) return
      const $el = $(el)
      const title = $el.text().trim()
      if (!title || title.length < 5 || title.length > 150) return
      if (!matchesRoleKeywords(title)) return

      const href = $el.attr('href') || ''
      if (!href || href === '#') return
      const sourceUrl = href.startsWith('http')
        ? href
        : `https://www.clinicaltrialsarena.com${href}`

      jobs.push({
        job_title: title.substring(0, 120),
        company_name: 'Unknown Company',
        job_location: '',
        date_posted: null,
        days_posted: 30,
        source_url: sourceUrl,
        job_board: 'clinicaltrialsarena',
      })
      parsed++
    })
  }

  console.log(`ClinicalTrialsArena: ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 4: Career site discovery via company domain inference ──────────────
// Fetches INDUSTRY sponsor company names from the companies table (populated by
// clinical trial signals), infers their corporate domain, tries common career
// page URL patterns, and scans for role keyword matches.
// Replaces the unreliable DuckDuckGo-based discovery approach.

/**
 * Infer a likely corporate domain from a company name.
 *
 * @param {string} name
 * @returns {string} e.g. "pfizer.com"
 */
function inferDomain(name) {
  return (
    name
      .toLowerCase()
      .replace(
        /\s*,?\s*\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|plc|gmbh|ag|nv|bv|sa|pty)\b\.?/gi,
        ''
      )
      .replace(/,\s*(usa|u\.s\.a|us|united states)$/i, '')
      .replace(/[^a-z0-9]/g, '') + '.com'
  )
}

async function discoverSponsorCareerPages() {
  const jobs = []

  // Step 1: Get INDUSTRY company names from our DB (confirmed CT.gov sponsors)
  let companyNames = []
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('name')
      .eq('industry', 'Life Sciences')
      .limit(30)

    if (error) {
      console.warn(`companies table query error: ${error.message}`)
    } else {
      companyNames = (data || []).map((c) => c.name).filter(Boolean)
    }
  } catch (err) {
    console.warn(`companies table fetch error: ${err.message}`)
  }

  // Fall back to CT.gov live query if table is empty
  if (companyNames.length === 0) {
    try {
      const params = new URLSearchParams({
        'query.term': 'AREA[InterventionType]interventional',
        'filter.advanced': 'AREA[LeadSponsorClass]INDUSTRY',
        'filter.overallStatus': 'RECRUITING',
        pageSize: '20',
        fields: 'NCTId,LeadSponsorName',
      })
      const resp = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (resp.ok) {
        const json = await resp.json()
        const seen = new Set()
        for (const study of json.studies || []) {
          const name =
            study.protocolSection?.sponsorsModule?.leadSponsor?.name ||
            study.protocolSection?.identificationModule?.leadSponsorName
          if (name && !seen.has(name)) {
            seen.add(name)
            companyNames.push(name)
          }
        }
      }
    } catch (err) {
      console.warn(`CT.gov fallback query error: ${err.message}`)
    }
  }

  const uniqueNames = [...new Set(companyNames)].slice(0, 15)
  if (uniqueNames.length === 0) return jobs

  console.log(`Career site discovery: checking ${uniqueNames.length} companies via domain inference`)

  let careerChecks = 0
  const MAX_CAREER_CHECKS = 6

  for (const companyName of uniqueNames) {
    if (careerChecks >= MAX_CAREER_CHECKS) break

    const domain = inferDomain(companyName)
    if (!domain || domain.length < 6) continue

    // Try common career page URL patterns in order
    const candidateUrls = [
      `https://${domain}/careers`,
      `https://${domain}/jobs`,
      `https://careers.${domain.replace(/\.com$/, '')}.com`,
    ]

    let careerUrl = null
    for (const url of candidateUrls) {
      try {
        const headResp = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': BOT_UA },
          signal: AbortSignal.timeout(5000),
          redirect: 'follow',
        })
        if (headResp.status < 400 || headResp.status === 405) {
          careerUrl = url
          break
        }
      } catch {
        // Try next candidate
      }
    }

    if (!careerUrl) {
      console.log(`No career URL found for ${companyName} (domain: ${domain})`)
      continue
    }

    // Fetch and scan career page for role keyword matches
    careerChecks++
    try {
      const careerResp = await fetch(careerUrl, {
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(8000),
      })
      if (!careerResp.ok) {
        console.warn(`Career page fetch HTTP ${careerResp.status} for ${companyName}`)
        continue
      }
      const careerHtml = await careerResp.text()
      const $c = cheerio.load(careerHtml)

      $c('nav, footer, script, style').remove()

      let found = false
      $c('a, h1, h2, h3, h4, li').each((_, el) => {
        if (found) return
        const text = $c(el).text().trim()
        if (!text || text.length < 5 || text.length > 200) return
        if (!matchesRoleKeywords(text)) return

        const href = $c(el).attr('href') || ''
        const jobUrl = href.startsWith('http')
          ? href
          : href
          ? `https://${domain}${href}`
          : careerUrl

        const locMatch = text.match(/([A-Z][a-zA-Z\s]{1,25},\s*[A-Z]{2})\b/)
        jobs.push({
          job_title: text.replace(/\s+/g, ' ').slice(0, 120),
          company_name: companyName,
          job_location: locMatch ? locMatch[1].trim() : '',
          date_posted: null,
          days_posted: 30,
          source_url: jobUrl,
          job_board: 'company_career_site',
        })
        found = true
      })

      if (!found) {
        console.log(`No matching roles on ${careerUrl} for ${companyName}`)
      }
    } catch (err) {
      console.warn(`Career page fetch failed for ${companyName}: ${err.message}`)
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  console.log(`Career site discovery: checked ${careerChecks} companies, found ${jobs.length} signals`)
  return jobs
}

// ─── Persist a single job as a signal ─────────────────────────────────────────

async function persistJobSignal(job) {
  const company = await upsertCompany(job.company_name)
  if (!company) return false

  const exists = await signalExists(company.id, 'stale_job_posting', job.source_url)
  if (exists) return false

  const score = computeScore(job.days_posted)
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id: company.id,
    signal_type: 'stale_job_posting',
    signal_summary: `"${job.job_title}" at ${job.company_name} posted for ${job.days_posted}+ days on ${job.job_board}`,
    signal_detail: {
      company_name: job.company_name,
      job_title: job.job_title,
      job_location: job.job_location,
      date_posted: job.date_posted || today,
      days_posted: job.days_posted,
      source_url: job.source_url,
      job_board: job.job_board,
    },
    source_url: job.source_url,
    source_name: job.job_board,
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: score,
    score_breakdown: { base: 15, days_posted_boost: score - 15 },
    days_in_queue: 0,
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
      agent_name: 'stale-job-tracker',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0
  const sourceCounts = { pharmajobs: 0, medzilla: 0, clinicalTrialsArena: 0, careerSites: 0 }

  try {
    const allJobs = []

    // ── Source 1: PharmJobs.com (replaces blocked BioSpace) ───────────────────
    const pharmaJobsJobs = await fetchPharmaJobsJobs()
    for (const job of pharmaJobsJobs) {
      job._source = 'pharmajobs'
      allJobs.push(job)
    }

    // ── Source 2: MedZilla.com ─────────────────────────────────────────────────
    const medZillaJobs = await fetchMedZillaJobs()
    for (const job of medZillaJobs) {
      job._source = 'medzilla'
      allJobs.push(job)
    }

    // ── Source 3: ClinicalTrialsArena.com/jobs/ ────────────────────────────────
    const ctArenaJobs = await fetchClinicalTrialsArenaJobs()
    for (const job of ctArenaJobs) {
      job._source = 'clinicalTrialsArena'
      allJobs.push(job)
    }

    // ── Source 4: Company career pages via domain inference ────────────────────
    const careerSiteJobs = await discoverSponsorCareerPages()
    for (const job of careerSiteJobs) {
      job._source = 'careerSites'
      allJobs.push(job)
    }

    // Deduplicate by (company_name, source_url)
    const dedupMap = new Map()
    for (const job of allJobs) {
      const key = `${job.company_name.toLowerCase()}|${job.source_url}`
      if (!dedupMap.has(key)) dedupMap.set(key, job)
    }

    const MAX_SIGNALS_PER_RUN = 25
    const uniqueJobs = Array.from(dedupMap.values()).slice(0, MAX_SIGNALS_PER_RUN)

    console.log(
      `Stale Job Tracker: ${allJobs.length} raw → ${uniqueJobs.length} unique (cap ${MAX_SIGNALS_PER_RUN})`
    )

    for (const job of uniqueJobs) {
      const inserted = await persistJobSignal(job)
      if (inserted) {
        signalsFound++
        if (job._source === 'pharmajobs') sourceCounts.pharmajobs++
        else if (job._source === 'medzilla') sourceCounts.medzilla++
        else if (job._source === 'clinicalTrialsArena') sourceCounts.clinicalTrialsArena++
        else sourceCounts.careerSites++
      }
    }

    const jobsFound = allJobs.length

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          jobs_found_total: jobsFound,
          jobs_deduped: uniqueJobs.length,
          source_counts: {
            pharmajobs_raw: allJobs.filter((j) => j._source === 'pharmajobs').length,
            medzilla_raw: allJobs.filter((j) => j._source === 'medzilla').length,
            clinicaltrialsarena_raw: allJobs.filter((j) => j._source === 'clinicalTrialsArena').length,
            career_sites_raw: allJobs.filter((j) => j._source === 'careerSites').length,
          },
          signals_by_source: sourceCounts,
        },
      })
      .eq('id', runId)

    console.log(
      `Stale Job Tracker complete — signals: ${signalsFound}, jobs found: ${jobsFound}`
    )

    return { signalsFound, jobsFound, sourceCounts }
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
