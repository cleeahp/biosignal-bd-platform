/**
 * SEC Filings Scan
 *
 * Standalone script that fetches recent 8-K and S-1 filings from the
 * SEC EDGAR full-text search API and stores them in the eight_k_filings
 * and s1_filings Supabase tables.
 *
 * Filters filings to only companies in the sec_companies table (matched
 * against companies_directory by the matchSecCompanies.js script).
 * Uses CIK-based filtering for precise matching.
 * Splits the date range into 1-week chunks for the 90-day manual mode
 * to stay under EDGAR's 10,000-result cap.
 *
 * Usage:
 *   node scripts/secFilingsScan.js --mode daily    # last 3 days
 *   node scripts/secFilingsScan.js --mode manual   # last 90 days
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[SECFilingsScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const EDGAR_SEARCH_BASE = 'https://efts.sec.gov/LATEST/search-index'
const PAGE_SIZE = 100
const RATE_LIMIT_MS = 120 // slightly above 100ms for safety
const RETRY_DELAY_MS = 10_000
const MAX_RETRIES = 3
const USER_AGENT = 'BioSignal-BD-Platform/1.0 (cleeahp@gmail.com)'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/secFilingsScan.js --mode <daily|manual>')
  console.error('  daily  — lookback 3 days')
  console.error('  manual — lookback 90 days')
  process.exit(1)
}

const LOOKBACK_DAYS = mode === 'daily' ? 3 : 90

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the filing URL from CIK and accession number.
 */
function buildFilingUrl(cik, accession) {
  if (!cik || !accession) return null
  const noDashes = accession.replace(/-/g, '')
  const paddedCik = cik.replace(/^0+/, '')
  return `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${noDashes}/${accession}-index.htm`
}

/**
 * Split a date range into 1-week chunks.
 */
function splitDateRange(startDate, endDate) {
  const chunks = []
  let current = new Date(startDate)
  const end = new Date(endDate)

  while (current < end) {
    const chunkEnd = new Date(Math.min(current.getTime() + WEEK_MS - 1, end.getTime()))
    chunks.push({
      startDate: formatDate(current),
      endDate: formatDate(chunkEnd),
    })
    current = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000)
  }

  return chunks
}

// ── Data loading ────────────────────────────────────────────────────────────

/**
 * Load sec_companies into a Map: CIK → { directory_name, company_size }.
 * CIKs are stored without leading zeros.
 */
async function loadSecCompanies() {
  const cikMap = new Map()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('sec_companies')
      .select('cik, directory_name, company_size')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading sec_companies: ${error.message}`); break }
    if (!data || data.length === 0) break

    for (const row of data) {
      cikMap.set(row.cik, {
        directory_name: row.directory_name,
        company_size: row.company_size,
      })
    }
    offset += PAGE
  }

  console.log(`[SECFilingsScan] Loaded ${cikMap.size} CIKs from sec_companies`)
  return cikMap
}

/**
 * Load existing accession numbers from a filings table into a Set.
 */
async function loadExistingAccessions(table) {
  const accessions = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('accession_number')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading existing ${table}: ${error.message}`); break }
    if (!data || data.length === 0) break

    for (const row of data) {
      accessions.add(row.accession_number)
    }
    offset += PAGE
  }

  return accessions
}

// ── EDGAR API ───────────────────────────────────────────────────────────────

async function fetchEdgarPage(formType, startDate, endDate, from = 0, attempt = 1) {
  const params = new URLSearchParams({
    forms: formType,
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: String(from),
    size: String(PAGE_SIZE),
  })

  const url = `${EDGAR_SEARCH_BASE}?${params.toString()}`
  console.log(`[SECFilingsScan] GET ${url.substring(0, 180)}...`)

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (response.status === 429) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`Rate limited after ${MAX_RETRIES} retries`)
    }
    console.warn(`[SECFilingsScan] 429 rate limited — waiting ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`)
    await sleep(RETRY_DELAY_MS)
    return fetchEdgarPage(formType, startDate, endDate, from, attempt + 1)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`EDGAR API error ${response.status}: ${body.substring(0, 300)}`)
  }

  return response.json()
}

// ── Data extraction ─────────────────────────────────────────────────────────

/**
 * Parse company name and ticker from EDGAR display_names format.
 * Example: "Tilray Brands, Inc.  (TLRY)  (CIK 0001731348)"
 */
function parseDisplayName(displayName) {
  if (!displayName) return { companyName: null, ticker: null }

  let ticker = null
  const tickerMatch = displayName.match(/\(([A-Z]{1,5})\)/)
  if (tickerMatch) ticker = tickerMatch[1]

  const nameMatch = displayName.match(/^(.+?)\s*\(/)
  const companyName = nameMatch ? nameMatch[1].trim() : displayName.replace(/\s*\(CIK\s+\d+\)\s*$/, '').trim()

  return { companyName: companyName || null, ticker }
}

function extract8KFiling(hit) {
  const cik = hit.ciks?.[0] || ''
  const accession = hit.adsh || ''
  if (!accession) return null

  const { companyName, ticker } = parseDisplayName(hit.display_names?.[0])
  const filingDate = hit.file_date || null
  const items = Array.isArray(hit.items) && hit.items.length > 0 ? hit.items : null

  return {
    company_cik: String(cik).replace(/^0+/, '') || null,
    company_name: companyName,
    ticker,
    filing_date: filingDate,
    accession_number: accession,
    filing_url: buildFilingUrl(cik, accession),
    items,
  }
}

function extractS1Filing(hit) {
  const cik = hit.ciks?.[0] || ''
  const accession = hit.adsh || ''
  if (!accession) return null

  const { companyName } = parseDisplayName(hit.display_names?.[0])
  const filingDate = hit.file_date || null

  return {
    company_cik: String(cik).replace(/^0+/, '') || null,
    company_name: companyName,
    filing_date: filingDate,
    accession_number: accession,
    filing_url: buildFilingUrl(cik, accession),
  }
}

// ── Scan a single date chunk ────────────────────────────────────────────────

async function scanChunk(formType, extractFn, startDate, endDate, existingAccessions, secCompanies) {
  let totalFetched = 0
  let matched = 0
  let filteredOut = 0
  let skipped = 0
  let from = 0
  const rowsToInsert = []

  while (true) {
    let data
    try {
      data = await fetchEdgarPage(formType, startDate, endDate, from)
    } catch (err) {
      console.error(`[SECFilingsScan] Fatal fetch error for ${formType} (${startDate}–${endDate}) at offset ${from}: ${err.message}`)
      break
    }

    const hits = data.hits?.hits || []
    const totalAvailable = data.hits?.total?.value || 0

    if (hits.length === 0) break

    totalFetched += hits.length

    for (const hit of hits) {
      const source = hit._source || hit
      const filing = extractFn(source)
      if (!filing) continue

      if (existingAccessions.has(filing.accession_number)) {
        skipped++
        continue
      }

      // Filter by CIK: only keep filings from companies in sec_companies
      const secEntry = secCompanies.get(filing.company_cik)
      if (!secEntry) {
        filteredOut++
        continue
      }

      // Enrich with matched_name and company_size from sec_companies
      filing.matched_name = secEntry.directory_name
      filing.company_size = secEntry.company_size

      console.log(`[SECFilingsScan] Matched: ${filing.company_name} (CIK ${filing.company_cik}) → ${secEntry.directory_name} — kept`)
      existingAccessions.add(filing.accession_number)
      rowsToInsert.push(filing)
      matched++
    }

    from += hits.length
    if (from >= totalAvailable || hits.length < PAGE_SIZE) break

    await sleep(RATE_LIMIT_MS)
  }

  return { totalFetched, matched, filteredOut, skipped, rowsToInsert }
}

// ── Scan a form type across all date chunks ─────────────────────────────────

async function scanFormType(formType, table, extractFn, startDate, endDate, existingAccessions, secCompanies) {
  console.log(`\n[SECFilingsScan] === Scanning ${formType} filings ===`)
  console.log(`[SECFilingsScan] Date range: ${startDate} to ${endDate}`)
  console.log(`[SECFilingsScan] ${existingAccessions.size} existing ${formType} accession numbers loaded`)

  const chunks = LOOKBACK_DAYS > 7
    ? splitDateRange(startDate, endDate)
    : [{ startDate, endDate }]

  console.log(`[SECFilingsScan] Scanning in ${chunks.length} date chunk(s)`)

  let totalFetched = 0
  let totalMatched = 0
  let totalFilteredOut = 0
  let totalSkipped = 0
  let totalInserted = 0
  let totalErrors = 0
  const allRows = []

  for (const chunk of chunks) {
    console.log(`\n[SECFilingsScan] Chunk: ${chunk.startDate} to ${chunk.endDate}`)
    const result = await scanChunk(formType, extractFn, chunk.startDate, chunk.endDate, existingAccessions, secCompanies)

    totalFetched += result.totalFetched
    totalMatched += result.matched
    totalFilteredOut += result.filteredOut
    totalSkipped += result.skipped
    allRows.push(...result.rowsToInsert)

    if (chunks.length > 1) {
      console.log(`[SECFilingsScan] Chunk result: ${result.totalFetched} fetched, ${result.matched} matched, ${result.filteredOut} filtered out`)
    }

    if (chunks.length > 1) await sleep(RATE_LIMIT_MS)
  }

  // Batch insert
  if (allRows.length > 0) {
    const BATCH = 500
    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH)
      const { error } = await supabase.from(table).insert(batch)

      if (error) {
        for (const row of batch) {
          const { error: rowErr } = await supabase.from(table).insert(row)
          if (rowErr) {
            console.error(`[SECFilingsScan] Insert error for ${row.accession_number}: ${rowErr.message}`)
            totalErrors++
          } else {
            totalInserted++
          }
        }
      } else {
        totalInserted += batch.length
      }
    }
  }

  console.log(`\n[SECFilingsScan] ${formType} complete:`)
  console.log(`[SECFilingsScan]   Total fetched:    ${totalFetched}`)
  console.log(`[SECFilingsScan]   Matched (kept):   ${totalMatched}`)
  console.log(`[SECFilingsScan]   Filtered out:     ${totalFilteredOut}`)
  console.log(`[SECFilingsScan]   Already existed:  ${totalSkipped}`)
  console.log(`[SECFilingsScan]   Inserted:         ${totalInserted}`)
  console.log(`[SECFilingsScan]   Errors:           ${totalErrors}`)

  return { totalFetched, inserted: totalInserted, skipped: totalSkipped, matched: totalMatched, filteredOut: totalFilteredOut, errors: totalErrors }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const endDate = formatDate(new Date())
  const startDate = formatDate(daysAgo(LOOKBACK_DAYS))
  console.log(`[SECFilingsScan] Mode: ${mode}, Lookback: ${LOOKBACK_DAYS} days (${startDate} to ${endDate})`)

  // Load sec_companies CIK map and existing accessions in parallel
  console.log('[SECFilingsScan] Loading sec_companies and existing accessions...')
  const [secCompanies, existing8K, existingS1] = await Promise.all([
    loadSecCompanies(),
    loadExistingAccessions('eight_k_filings'),
    loadExistingAccessions('s1_filings'),
  ])

  if (secCompanies.size === 0) {
    console.error('[SECFilingsScan] No companies in sec_companies table. Run matchSecCompanies.js first.')
    process.exit(1)
  }

  // Scan 8-K filings
  const results8K = await scanFormType('8-K', 'eight_k_filings', extract8KFiling, startDate, endDate, existing8K, secCompanies)

  await sleep(RATE_LIMIT_MS)

  // Scan S-1 filings
  const resultsS1 = await scanFormType('S-1', 's1_filings', extractS1Filing, startDate, endDate, existingS1, secCompanies)

  console.log(`\n[SECFilingsScan] === ALL DONE ===`)
  console.log(`[SECFilingsScan] 8-K: ${results8K.totalFetched} fetched, ${results8K.matched} matched, ${results8K.filteredOut} filtered, ${results8K.inserted} inserted`)
  console.log(`[SECFilingsScan] S-1: ${resultsS1.totalFetched} fetched, ${resultsS1.matched} matched, ${resultsS1.filteredOut} filtered, ${resultsS1.inserted} inserted`)
}

main().catch((err) => {
  console.error('[SECFilingsScan] Unhandled error:', err)
  process.exit(1)
})
