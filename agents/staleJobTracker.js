import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient, shuffleArray } from '../lib/linkedinClient.js'
import * as cheerio from 'cheerio'

const BOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Non-US country names in job location strings. Jobs located outside the US are
// skipped — we only staff US positions. Blank/Remote locations are kept.
const NON_US_LOCATION_PATTERNS =
  /\b(Canada|Ontario|Quebec|British Columbia|Alberta|UK|United Kingdom|England|Scotland|Wales|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan|New Zealand|South Africa|Mexico|Argentina)\b/i

// ─── LinkedIn Source B configuration ──────────────────────────────────────────

// 10 life sciences search queries — shuffled on every run
const LINKEDIN_STALE_QUERIES = [
  'clinical trial coordinator',
  'clinical research associate CRA pharmaceutical',
  'regulatory affairs specialist biotech',
  'medical affairs manager biopharmaceutical',
  'pharmacovigilance drug safety specialist',
  'biostatistician clinical trials',
  'clinical data manager life sciences',
  'quality assurance pharmaceutical GMP',
  'clinical project manager CRO',
  'medical science liaison MSL',
]

// Exclude staffing/CRO competitor firms from stale job signals
// (those belong to competitor_job_posting, not stale_job_posting)
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

// ─── Scoring ───────────────────────────────────────────────────────────────────

function computeScore(daysPosted) {
  let score = 15
  if (daysPosted >= 60) score += 3
  else if (daysPosted >= 30) score += 2
  return Math.min(score, 20)
}

// ─── SOURCE 1: BioSpace.com /jobs/ ────────────────────────────────────────────
// Fetches BioSpace job listings filtered to a given life sciences category.
// Returns jobs matching role keywords with US locations.

async function fetchBioSpaceJobsByCategory(category) {
  const jobs = []
  const url = `https://www.biospace.com/jobs/?category=${encodeURIComponent(category)}&days=30`
  let html

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BOT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(14000),
    })
    if (!resp.ok) {
      console.warn(`BioSpace [${category}]: HTTP ${resp.status}`)
      return jobs
    }
    html = await resp.text()
  } catch (err) {
    console.warn(`BioSpace [${category}] fetch error: ${err.message}`)
    return jobs
  }

  if (html.length < 500) {
    console.warn(`BioSpace [${category}]: response too short (${html.length} chars) — may be JS-rendered`)
    return jobs
  }

  console.log(`BioSpace [${category}]: fetched ${html.length} chars`)
  const $ = cheerio.load(html)
  let parsed = 0

  // BioSpace job cards: try structured containers first
  $('[class*="job"], article, li[class*="result"]').each((_, el) => {
    if (parsed >= 25) return
    const $el = $(el)

    const $titleLink = $el.find('h2 a, h3 a, a[class*="title"], a[class*="job-title"]').first()
    const title = ($titleLink.text() || $el.find('h2, h3').first().text()).trim()
    if (!title || !matchesRoleKeywords(title)) return

    const href = $titleLink.attr('href') || $el.find('a').first().attr('href') || ''
    const sourceUrl = href.startsWith('http') ? href : href ? `https://www.biospace.com${href}` : url

    const companyName = $el.find('[class*="company"], [class*="employer"]').first().text().trim() || 'Unknown'
    const location = $el.find('[class*="location"], [class*="city"]').first().text().trim() || ''
    const dateText = $el.find('[class*="date"], time').first().text().trim() || ''

    // Estimate days_posted from relative date text ("3 days ago", "2 weeks ago")
    let days_posted = 30
    const daysMatch = dateText.match(/(\d+)\s+day/i)
    const weeksMatch = dateText.match(/(\d+)\s+week/i)
    const monthsMatch = dateText.match(/(\d+)\s+month/i)
    if (daysMatch) days_posted = parseInt(daysMatch[1], 10)
    else if (weeksMatch) days_posted = parseInt(weeksMatch[1], 10) * 7
    else if (monthsMatch) days_posted = parseInt(monthsMatch[1], 10) * 30

    jobs.push({
      job_title: title.slice(0, 120),
      company_name: companyName.slice(0, 100),
      job_location: location,
      date_posted: null,
      days_posted,
      source_url: sourceUrl,
      job_board: `biospace_${category.toLowerCase()}`,
    })
    parsed++
  })

  // Fallback: scan all anchors with matching title text
  if (parsed === 0) {
    $('a').each((_, el) => {
      if (parsed >= 20) return
      const $el = $(el)
      const title = $el.text().trim()
      if (!title || title.length < 5 || title.length > 150) return
      if (!matchesRoleKeywords(title)) return
      const href = $el.attr('href') || ''
      if (!href || href === '#') return
      const sourceUrl = href.startsWith('http') ? href : `https://www.biospace.com${href}`
      jobs.push({
        job_title: title.slice(0, 120),
        company_name: 'Unknown',
        job_location: '',
        date_posted: null,
        days_posted: 30,
        source_url: sourceUrl,
        job_board: `biospace_${category.toLowerCase()}`,
      })
      parsed++
    })
  }

  console.log(`BioSpace [${category}]: ${jobs.length} matched jobs`)
  return jobs
}

// ─── SOURCE 2: Career site discovery via company domain inference ──────────────
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
      // Strip city/state/country qualifiers — CT.gov names include these after the first comma
      // e.g. "Merck & Co., Inc., Rahway, NJ, USA" → "merck & co"
      .replace(/,.*$/, '')
      // Remove common legal/entity suffixes
      .replace(
        /\s*\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|plc|gmbh|ag|nv|bv|sa|pty|& co)\b\.?/gi,
        ''
      )
      // Strip everything except letters and numbers
      .replace(/[^a-z0-9]/g, '') + '.com'
  )
}

async function discoverSponsorCareerPages() {
  const jobs = []

  // Step 1: Get company names from our DB — include all relevant industry types
  // plus any company we have a warm relationship with (relationship_warmth IS NOT NULL)
  let companyNames = []
  try {
    const [{ data: byIndustry }, { data: byRelationship }] = await Promise.all([
      supabase
        .from('companies')
        .select('name')
        .in('industry', ['Life Sciences', 'Biotechnology', 'Pharmaceuticals', 'Medical Device'])
        .limit(25),
      supabase
        .from('companies')
        .select('name')
        .not('relationship_warmth', 'is', null)
        .limit(10),
    ])
    const allData = [...(byIndustry || []), ...(byRelationship || [])]
    companyNames = [...new Set(allData.map((c) => c.name).filter(Boolean))]
  } catch (err) {
    console.warn(`companies table fetch error: ${err.message}`)
  }

  // Filter out non-industry names (universities, hospitals, etc.) that ended up in DB
  // before the INDUSTRY-only filter was enforced. Only attempt career lookups for
  // confirmed industry companies.
  const NON_INDUSTRY_PATTERN =
    /university|college|hospital|medical center|health system|health centre|institute|foundation|children's|memorial|research center|research centre|\bschool\b|\bnih\b|\bcdc\b|\bdod\b|\bnasa\b/i
  companyNames = companyNames.filter((name) => !NON_INDUSTRY_PATTERN.test(name))
  console.log(`Career site discovery: ${companyNames.length} industry companies after filtering`)

  // Fall back to CT.gov live query if table is empty after filtering
  if (companyNames.length === 0) {
    try {
      // Use working CT.gov filter.advanced syntax (query.term causes HTTP 400 from Vercel)
      const params = new URLSearchParams({
        'filter.advanced': 'AREA[LeadSponsorClass]INDUSTRY',
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

      const MAX_JOBS_PER_COMPANY = 5
      let foundCount = 0
      $c('a, h1, h2, h3, h4, li').each((_, el) => {
        if (foundCount >= MAX_JOBS_PER_COMPANY) return
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
        foundCount++
      })

      if (foundCount === 0) {
        console.log(`No matching roles on ${careerUrl} for ${companyName}`)
      } else {
        console.log(`Career site: found ${foundCount} role(s) at ${companyName}`)
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
  // US-only: skip jobs where the location is clearly outside the US.
  // Blank or "Remote" locations are kept (may be US-based remote).
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
  const sourceCounts = { biospace_biotech: 0, biospace_pharma: 0, careerSites: 0, linkedin: 0 }

  try {
    const allJobs = []

    // ── Source 1: BioSpace.com Biotechnology jobs ──────────────────────────────
    const biospaceBiotechJobs = await fetchBioSpaceJobsByCategory('Biotechnology')
    for (const job of biospaceBiotechJobs) {
      job._source = 'biospace_biotech'
      allJobs.push(job)
    }

    // ── Source 2: BioSpace.com Pharmaceutical jobs ─────────────────────────────
    const biospacePharmaJobs = await fetchBioSpaceJobsByCategory('Pharmaceutical')
    for (const job of biospacePharmaJobs) {
      job._source = 'biospace_pharma'
      allJobs.push(job)
    }

    // ── Source 3: Company career pages via domain inference ────────────────────
    const careerSiteJobs = await discoverSponsorCareerPages()
    for (const job of careerSiteJobs) {
      job._source = 'careerSites'
      allJobs.push(job)
    }

    // ── Source 4: LinkedIn stale job search (budget: 40 requests) ─────────────
    // Searches 10 life sciences queries shuffled on every run.
    // Filters for days_posted >= 30, excludes competitor firms and academic orgs.
    // Caps at 20 LinkedIn signals per run.
    const linkedin = createLinkedInClient(40)
    let linkedinRequestsUsed = 0

    if (linkedin) {
      const queries = shuffleArray(LINKEDIN_STALE_QUERIES)
      const liDedup = new Set()      // dedup by job_url within this source
      let liSignals = 0
      const MAX_LI_SIGNALS = 20

      for (const query of queries) {
        if (liSignals >= MAX_LI_SIGNALS) break
        if (linkedin.requestsUsed >= 40) {
          console.log(`[StaleJobs] Budget exhausted (${linkedin.requestsUsed} requests used)`)
          break
        }

        // Use 90-day window so we capture genuinely stale postings (30+ days old)
        const results = await linkedin.searchJobs(query, null, 'r7776000')

        if (linkedin.botDetected) {
          console.log('[StaleJobs] Bot detected — stopping for today')
          break
        }

        for (const job of results) {
          if (liSignals >= MAX_LI_SIGNALS) break
          if (!job.jobUrl || liDedup.has(job.jobUrl)) continue
          if (job.daysPosted < 30) continue
          if (!matchesRoleKeywords(job.title)) continue
          if (COMPETITOR_FIRM_NAMES.has(job.company)) continue
          if (ACADEMIC_PATTERNS.test(job.company)) continue
          if (NON_US_LOCATION_PATTERNS.test(job.location)) continue

          liDedup.add(job.jobUrl)
          allJobs.push({
            job_title:    job.title,
            company_name: job.company || 'Unknown',
            job_location: job.location || '',
            date_posted:  null,
            days_posted:  job.daysPosted,
            source_url:   job.jobUrl,
            job_board:    'linkedin',
            _source:      'linkedin',
          })
          liSignals++
        }
      }

      linkedinRequestsUsed = linkedin.requestsUsed
      console.log(
        `[StaleJobs] LinkedIn complete — ${linkedinRequestsUsed} requests used, ` +
        `${liSignals} candidate jobs found`
      )
    }

    // Deduplicate by source_url across all sources
    const dedupMap = new Map()
    for (const job of allJobs) {
      const key = job.source_url
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
        if (job._source === 'biospace_biotech') sourceCounts.biospace_biotech++
        else if (job._source === 'biospace_pharma') sourceCounts.biospace_pharma++
        else if (job._source === 'linkedin') sourceCounts.linkedin++
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
          linkedin_requests_used: linkedinRequestsUsed,
          linkedin_bot_detected: linkedin?.botDetected ?? false,
          source_counts: {
            biospace_biotech_raw: allJobs.filter((j) => j._source === 'biospace_biotech').length,
            biospace_pharma_raw:  allJobs.filter((j) => j._source === 'biospace_pharma').length,
            career_sites_raw:     allJobs.filter((j) => j._source === 'careerSites').length,
            linkedin_raw:         allJobs.filter((j) => j._source === 'linkedin').length,
          },
          signals_by_source: sourceCounts,
        },
      })
      .eq('id', runId)

    console.log(
      `[StaleJobs] Complete — ${linkedinRequestsUsed} requests used, ${signalsFound} signals saved`
    )

    return { signalsFound, requestsUsed: linkedinRequestsUsed, jobsFound, sourceCounts }
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
