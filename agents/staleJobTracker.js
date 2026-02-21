import { supabase } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import * as cheerio from 'cheerio'

// ─── Indeed RSS search keywords ────────────────────────────────────────────────
const INDEED_KEYWORDS = [
  'Clinical Research Associate CRO',
  'SDTM Programmer clinical',
  'Regulatory Affairs Specialist biotech',
  'Biostatistician pharmaceutical',
  'Pharmacovigilance clinical trials',
  'Clinical Data Manager CRO',
  'Quality Assurance pharmaceutical',
  'Clinical Trial Manager CRO',
]

const BOT_UA = 'Mozilla/5.0 (compatible; BioSignalBot/1.0)'

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

// ─── SOURCE 1: Indeed RSS ──────────────────────────────────────────────────────

async function fetchIndeedRss(keyword) {
  const jobs = []
  const q = encodeURIComponent(keyword)
  const url = `https://www.indeed.com/rss?q=${q}&fromage=30&sort=date`

  let xml
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BOT_UA },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) {
      console.warn(`Indeed RSS HTTP ${resp.status} for "${keyword}"`)
      return jobs
    }
    xml = await resp.text()
  } catch (err) {
    console.warn(`Indeed RSS fetch error for "${keyword}": ${err.message}`)
    return jobs
  }

  // Validate that the response is actually RSS/XML, not a CAPTCHA/HTML page
  if (!xml.includes('<rss') && !xml.includes('<item>')) {
    console.warn(`Indeed RSS non-XML response for "${keyword}" — skipping`)
    return jobs
  }

  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
  for (const item of items) {
    const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() || ''
    const link = item.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() || ''
    const pubDateStr = item.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1]?.trim() || ''
    const company =
      item.match(/<source[^>]*>(.*?)<\/source>/s)?.[1]?.trim() ||
      item.match(/<author>(.*?)<\/author>/s)?.[1]?.trim() ||
      ''
    const descRaw =
      item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1] || ''

    if (!title || !link) continue
    if (!matchesRoleKeywords(title)) continue

    const pubDate = pubDateStr ? new Date(pubDateStr) : null
    const daysPosted = pubDate
      ? Math.floor((Date.now() - pubDate.getTime()) / 86400000)
      : 30
    const datePosted = pubDate ? pubDate.toISOString().split('T')[0] : null

    // Extract "City, ST" pattern from stripped description HTML
    const descText = descRaw.replace(/<[^>]+>/g, ' ')
    const locMatch = descText.match(/([A-Z][a-zA-Z\s]{1,25},\s*[A-Z]{2})\b/)
    const jobLocation = locMatch ? locMatch[1].trim() : ''

    jobs.push({
      job_title: title,
      company_name: company || 'Unknown Company',
      job_location: jobLocation,
      date_posted: datePosted,
      days_posted: daysPosted,
      source_url: link,
      job_board: 'indeed',
    })
  }

  console.log(`Indeed RSS "${keyword}": ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 2: BioSpace.com ────────────────────────────────────────────────────

async function fetchBioSpaceJobs() {
  const jobs = []
  let html
  try {
    const resp = await fetch('https://www.biospace.com/jobs/?days=30', {
      headers: {
        'User-Agent': BOT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!resp.ok) {
      console.warn(`BioSpace HTTP ${resp.status}`)
      return jobs
    }
    html = await resp.text()
  } catch (err) {
    console.warn(`BioSpace fetch error: ${err.message}`)
    return jobs
  }

  const $ = cheerio.load(html)

  // Primary parsing strategy: job cards identified by id="item-{n}"
  let parsed = 0
  $('[id^="item-"]').each((_, el) => {
    const $item = $(el)

    const title =
      $item.find('.lister__header span').first().text().trim() ||
      $item.find('h2.lister__header').first().text().trim() ||
      $item.find('h3 span').first().text().trim()

    if (!title || !matchesRoleKeywords(title)) return

    // Company: alt text of logo image, stripping trailing " logo"
    const logoAlt = $item.find('img.lister__logo[alt]').first().attr('alt') || ''
    const orgText = $item.find('.lister__organization').first().text().trim()
    let companyName = logoAlt
      ? logoAlt.replace(/\s+logo\s*$/i, '').trim()
      : orgText
    if (!companyName || companyName.length < 2) return

    // Job URL: first anchor with /job/ in href
    const rawHref = $item.find('a[href*="/job/"]').first().attr('href') || ''
    const cleanHref = rawHref.replace(/\s+/g, '')
    const sourceUrl = cleanHref
      ? cleanHref.startsWith('http')
        ? cleanHref
        : `https://www.biospace.com${cleanHref}`
      : 'https://www.biospace.com/jobs/?days=30'

    // Days posted: badge title "Added in the last N days"
    const badgeTitle = $item.find('.badge[title]').first().attr('title') || ''
    const daysMatch = badgeTitle.match(/Added in the last (\d+) day/i)
    const daysPosted = daysMatch ? parseInt(daysMatch[1], 10) : 30

    // Location
    const jobLocation =
      $item.find('[class*="location"]').first().text().trim() ||
      $item.find('[class*="city"]').first().text().trim() ||
      ''

    jobs.push({
      job_title: title,
      company_name: companyName,
      job_location: jobLocation,
      date_posted: null,
      days_posted: daysPosted,
      source_url: sourceUrl,
      job_board: 'biospace',
    })
    parsed++
  })

  // Fallback: if primary selectors yielded nothing, try article.job containers
  if (parsed === 0) {
    $('article.job').each((_, el) => {
      const $item = $(el)
      const titleEl = $item.find('h2 a').first()
      const title = titleEl.text().trim()
      if (!title || !matchesRoleKeywords(title)) return

      const companyName = $item.find('[class*="company"], [class*="employer"]').first().text().trim()
      if (!companyName || companyName.length < 2) return

      const rawHref = titleEl.attr('href') || ''
      const sourceUrl = rawHref.startsWith('http')
        ? rawHref
        : `https://www.biospace.com${rawHref}`

      jobs.push({
        job_title: title,
        company_name: companyName,
        job_location: '',
        date_posted: null,
        days_posted: 30,
        source_url: sourceUrl,
        job_board: 'biospace',
      })
    })
  }

  console.log(`BioSpace: ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 3: Career site discovery via ClinicalTrials.gov sponsors ──────────

async function discoverSponsorCareerPages() {
  const jobs = []

  // Step 1: Fetch unique INDUSTRY sponsors from active recruiting trials
  let sponsors = []
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
          sponsors.push(name)
        }
      }
    } else {
      console.warn(`ClinicalTrials.gov sponsor query HTTP ${resp.status}`)
    }
  } catch (err) {
    console.warn(`ClinicalTrials.gov sponsor query error: ${err.message}`)
  }

  // Limit sponsor list
  sponsors = sponsors.slice(0, 10)
  if (sponsors.length === 0) return jobs

  // Step 2: For each sponsor, find their career page via DuckDuckGo HTML search
  let careerChecks = 0
  const MAX_CAREER_CHECKS = 5

  for (const companyName of sponsors) {
    if (careerChecks >= MAX_CAREER_CHECKS) break

    // Use DuckDuckGo HTML endpoint — avoids Google bot-blocking
    let careerUrl = null
    try {
      const ddgQuery = encodeURIComponent(`${companyName} careers jobs`)
      const ddgResp = await fetch(`https://html.duckduckgo.com/html/?q=${ddgQuery}`, {
        headers: {
          'User-Agent': BOT_UA,
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(6000),
      })
      if (ddgResp.ok) {
        const ddgHtml = await ddgResp.text()
        const $ = cheerio.load(ddgHtml)
        // DuckDuckGo HTML results: result links are in <a class="result__a"> or similar
        $('a.result__a, a.result__url, .result__extras__url').each((_, el) => {
          if (careerUrl) return
          const href = $(el).attr('href') || ''
          // DDG wraps URLs in redirect links — extract the actual URL from uddg= param
          const uddgMatch = href.match(/uddg=([^&]+)/)
          const actualUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : href
          if (actualUrl && (actualUrl.includes('career') || actualUrl.includes('/jobs'))) {
            careerUrl = actualUrl
          }
        })
      }
    } catch (err) {
      console.warn(`DuckDuckGo search failed for "${companyName}": ${err.message}`)
    }

    if (!careerUrl) {
      console.log(`No career URL found for ${companyName} via DDG`)
      continue
    }

    // Step 3: Fetch the career page and scan for matching roles
    careerChecks++
    let careerPageText = ''
    try {
      const careerResp = await fetch(careerUrl, {
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(5000),
      })
      if (!careerResp.ok) {
        console.warn(`Career page fetch HTTP ${careerResp.status} for ${companyName}`)
        continue
      }
      const careerHtml = await careerResp.text()
      const $c = cheerio.load(careerHtml)
      // Remove nav/footer noise
      $c('nav, footer, script, style').remove()
      careerPageText = $c('body').text()
    } catch (err) {
      console.warn(`Career page fetch failed for ${companyName}: ${err.message}`)
      continue
    }

    // Step 4: Scan text for role keyword matches line by line
    const lines = careerPageText.split(/\n/).map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      if (line.length < 5 || line.length > 200) continue
      if (!matchesRoleKeywords(line)) continue

      // Heuristic location: look for "City, ST" near the line
      const locMatch = line.match(/([A-Z][a-zA-Z\s]{1,25},\s*[A-Z]{2})\b/)
      const jobLocation = locMatch ? locMatch[1].trim() : ''

      // Check dedup before adding (avoid duplicate source URLs)
      jobs.push({
        job_title: line.replace(/\s+/g, ' ').slice(0, 120),
        company_name: companyName,
        job_location: jobLocation,
        date_posted: null,
        days_posted: 30,
        source_url: careerUrl,
        job_board: 'company_career_site',
      })
      break // One signal per company career page per run
    }
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
  const sourceCounts = { indeed: 0, biospace: 0, careerSites: 0 }

  try {
    const allJobs = []

    // ── Source 1: Indeed RSS — all keywords fetched sequentially to avoid
    //   rate-limit hammering; each fetch is independent so errors are isolated
    for (const keyword of INDEED_KEYWORDS) {
      const results = await fetchIndeedRss(keyword)
      for (const job of results) {
        job._source = 'indeed'
        allJobs.push(job)
      }
    }

    // ── Source 2: BioSpace
    const bioSpaceJobs = await fetchBioSpaceJobs()
    for (const job of bioSpaceJobs) {
      job._source = 'biospace'
      allJobs.push(job)
    }

    // ── Source 3: ClinicalTrials.gov sponsor career pages
    const careerSiteJobs = await discoverSponsorCareerPages()
    for (const job of careerSiteJobs) {
      job._source = 'careerSites'
      allJobs.push(job)
    }

    // Deduplicate by (company_name, source_url) — same URL cannot produce two signals
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
        if (job._source === 'indeed') sourceCounts.indeed++
        else if (job._source === 'biospace') sourceCounts.biospace++
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
            indeed_raw: allJobs.filter((j) => j._source === 'indeed').length,
            biospace_raw: allJobs.filter((j) => j._source === 'biospace').length,
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
