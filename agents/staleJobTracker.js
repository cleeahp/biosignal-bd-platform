import { supabase } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import * as cheerio from 'cheerio'

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

// ─── SOURCE 1: BioSpace.com ────────────────────────────────────────────────────

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

  if (html.length < 1000) {
    console.warn(`BioSpace: response too short (${html.length} chars) — may be blocked`)
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

// ─── SOURCE 2: MedZilla.com ────────────────────────────────────────────────────

async function fetchMedZillaJobs() {
  const jobs = []

  // MedZilla is an older life sciences job board with server-rendered HTML
  // Try the main search page and a generic jobs listing URL
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

    // Company is often in the 2nd or 3rd td
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

  // Strategy 2: list or div containers with job/listing class names
  if (parsed === 0) {
    $(
      '[class*="job"], [class*="listing"], [class*="result"], [class*="position"]'
    ).each((_, el) => {
      if (parsed >= 30) return
      const $el = $(el)
      const $link = $el.find('a').first()
      const title =
        $link.text().trim() ||
        $el.find('h2, h3, h4').first().text().trim()

      if (!title || !matchesRoleKeywords(title)) return

      const href = $link.attr('href') || ''
      const sourceUrl = href.startsWith('http')
        ? href
        : href
        ? `https://www.medzilla.com${href}`
        : successUrl

      const companyName =
        $el.find('[class*="company"], [class*="employer"]').first().text().trim() ||
        'Unknown Company'

      jobs.push({
        job_title: title.substring(0, 120),
        company_name: companyName.substring(0, 100),
        job_location: '',
        date_posted: null,
        days_posted: 30,
        source_url: sourceUrl,
        job_board: 'medzilla',
      })
      parsed++
    })
  }

  // Strategy 3: scan all anchors for matching job titles
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

// ─── SOURCE 4: Career site discovery via ClinicalTrials.gov sponsors ──────────

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
  const sourceCounts = { biospace: 0, medzilla: 0, clinicalTrialsArena: 0, careerSites: 0 }

  try {
    const allJobs = []

    // ── Source 1: BioSpace.com ─────────────────────────────────────────────────
    const bioSpaceJobs = await fetchBioSpaceJobs()
    for (const job of bioSpaceJobs) {
      job._source = 'biospace'
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

    // ── Source 4: ClinicalTrials.gov sponsor career pages ──────────────────────
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
        if (job._source === 'biospace') sourceCounts.biospace++
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
            biospace_raw: allJobs.filter((j) => j._source === 'biospace').length,
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
