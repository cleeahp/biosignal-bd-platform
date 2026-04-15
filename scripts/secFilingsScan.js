/**
 * SEC Filings Scan
 *
 * Standalone script that fetches recent 8-K and S-1 filings from the
 * SEC EDGAR full-text search API and stores them in the eight_k_filings
 * and s1_filings Supabase tables.
 *
 * Filters filings to only pharma/biotech companies by matching against
 * companies_directory, clinical_trials lead sponsors, and past_clients.
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
 * Accession format from EDGAR: "0001234567-24-012345"
 * URL path uses accession without dashes for the directory.
 */
function buildFilingUrl(cik, accession) {
  if (!cik || !accession) return null
  const noDashes = accession.replace(/-/g, '')
  const paddedCik = cik.replace(/^0+/, '')
  return `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${noDashes}/${accession}-index.htm`
}

/**
 * Split a date range into 1-week chunks.
 * Returns array of { startDate, endDate } strings.
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
    current = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000) // next day
  }

  return chunks
}

// ── Company name matching ───────────────────────────────────────────────────

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|AG|NV|SE|Pty)\s*$/i

/**
 * Clean a company name for comparison: strip parentheticals, legal suffixes,
 * trailing punctuation, lowercase.
 */
function cleanName(raw) {
  if (!raw) return ''
  let s = raw
  s = s.replace(/\s*\([^)]*\)/g, '')
  for (let i = 0; i < 3; i++) {
    const prev = s
    s = s.replace(LEGAL_SUFFIXES_RE, '')
    if (s === prev) break
  }
  s = s.replace(/[,.\s]+$/, '').trim()
  return s.toLowerCase()
}

/**
 * Load known company names from companies_directory, clinical_trials
 * lead sponsors, and past_clients. Returns a Set of cleaned lowercase names.
 */
async function loadKnownCompanies() {
  const names = new Set()
  const PAGE = 1000

  // Load companies_directory names
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading companies_directory: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      const cleaned = cleanName(row.name)
      if (cleaned) names.add(cleaned)
    }
    offset += PAGE
  }
  const dirCount = names.size
  console.log(`[SECFilingsScan] Loaded ${dirCount} names from companies_directory`)

  // Load clinical_trials lead sponsor names
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('clinical_trials')
      .select('lead_sponsor_name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading clinical_trials: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      const cleaned = cleanName(row.lead_sponsor_name)
      if (cleaned) names.add(cleaned)
    }
    offset += PAGE
  }
  console.log(`[SECFilingsScan] Loaded ${names.size - dirCount} additional names from clinical_trials`)

  // Load past_clients names
  const { data: clients, error: clientErr } = await supabase
    .from('past_clients')
    .select('name')
    .eq('is_active', true)
  if (clientErr) {
    console.error(`[SECFilingsScan] Error loading past_clients: ${clientErr.message}`)
  } else if (clients) {
    const before = names.size
    for (const row of clients) {
      const cleaned = cleanName(row.name)
      if (cleaned) names.add(cleaned)
    }
    console.log(`[SECFilingsScan] Loaded ${names.size - before} additional names from past_clients`)
  }

  console.log(`[SECFilingsScan] Total known companies: ${names.size}`)
  return names
}

/**
 * Build a prefix index for fast fuzzy matching.
 * Maps first word of each name → Set of full cleaned names.
 */
function buildPrefixIndex(knownNames) {
  const index = new Map()
  for (const name of knownNames) {
    const firstWord = name.split(/\s+/)[0]
    if (firstWord && firstWord.length >= 3) {
      if (!index.has(firstWord)) index.set(firstWord, [])
      index.get(firstWord).push(name)
    }
  }
  return index
}

/**
 * Check if a filing's company name matches any known company.
 * Tries exact cleaned match first, then prefix match using the index.
 */
function matchesKnownCompany(filingCompanyName, knownNames, prefixIndex) {
  const cleaned = cleanName(filingCompanyName)
  if (!cleaned) return false

  // Exact match
  if (knownNames.has(cleaned)) return true

  // Prefix match using index: check if any known name starts with filing name
  // or filing name starts with any known name
  const firstWord = cleaned.split(/\s+/)[0]
  if (!firstWord || firstWord.length < 4) return false

  const candidates = prefixIndex.get(firstWord)
  if (!candidates) return false

  for (const known of candidates) {
    if (known.startsWith(cleaned) || cleaned.startsWith(known)) {
      const overlap = Math.min(known.length, cleaned.length)
      if (overlap >= 4) return true
    }
  }

  return false
}

// ── EDGAR API ───────────────────────────────────────────────────────────────

async function fetchEdgarPage(formType, startDate, endDate, from = 0, attempt = 1) {
  // No q parameter — including q causes literal text search and returns 0 results
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
 * Returns { companyName, ticker }
 */
function parseDisplayName(displayName) {
  if (!displayName) return { companyName: null, ticker: null }

  // Extract ticker: first parenthetical that isn't "(CIK ...)"
  let ticker = null
  const tickerMatch = displayName.match(/\(([A-Z]{1,5})\)/)
  if (tickerMatch) ticker = tickerMatch[1]

  // Extract company name: everything before the first parenthetical
  const nameMatch = displayName.match(/^(.+?)\s*\(/)
  const companyName = nameMatch ? nameMatch[1].trim() : displayName.replace(/\s*\(CIK\s+\d+\)\s*$/, '').trim()

  return { companyName: companyName || null, ticker }
}

/**
 * Extract 8-K filing data from an EDGAR search hit _source.
 */
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

// ── Load existing accession numbers ─────────────────────────────────────────

async function loadExistingAccessions(table) {
  const accessions = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('accession_number')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[SECFilingsScan] Error loading existing ${table}: ${error.message}`)
      return accessions
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      accessions.add(row.accession_number)
    }
    offset += PAGE
  }

  return accessions
}

// ── Scan a single date chunk ────────────────────────────────────────────────

async function scanChunk(formType, extractFn, startDate, endDate, existingAccessions, knownNames, prefixIndex) {
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

      // Filter: only keep filings from known pharma/biotech companies
      if (!matchesKnownCompany(filing.company_name, knownNames, prefixIndex)) {
        filteredOut++
        continue
      }

      console.log(`[SECFilingsScan] Matched: ${filing.company_name} — kept`)
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

async function scanFormType(formType, table, extractFn, startDate, endDate, existingAccessions, knownNames, prefixIndex) {
  console.log(`\n[SECFilingsScan] === Scanning ${formType} filings ===`)
  console.log(`[SECFilingsScan] Date range: ${startDate} to ${endDate}`)
  console.log(`[SECFilingsScan] ${existingAccessions.size} existing ${formType} accession numbers loaded`)

  // Split into weekly chunks for manual mode to avoid 10K cap
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
    const result = await scanChunk(formType, extractFn, chunk.startDate, chunk.endDate, existingAccessions, knownNames, prefixIndex)

    totalFetched += result.totalFetched
    totalMatched += result.matched
    totalFilteredOut += result.filteredOut
    totalSkipped += result.skipped
    allRows.push(...result.rowsToInsert)

    if (chunks.length > 1) {
      console.log(`[SECFilingsScan] Chunk result: ${result.totalFetched} fetched, ${result.matched} matched, ${result.filteredOut} filtered out`)
    }

    // Rate limit between chunks
    if (chunks.length > 1) await sleep(RATE_LIMIT_MS)
  }

  // Batch insert all matched rows
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

  // Load known company names and existing accessions in parallel
  const [knownNames, existing8K, existingS1] = await Promise.all([
    loadKnownCompanies(),
    loadExistingAccessions('eight_k_filings'),
    loadExistingAccessions('s1_filings'),
  ])

  const prefixIndex = buildPrefixIndex(knownNames)

  // Scan 8-K filings
  const results8K = await scanFormType('8-K', 'eight_k_filings', extract8KFiling, startDate, endDate, existing8K, knownNames, prefixIndex)

  await sleep(RATE_LIMIT_MS)

  // Scan S-1 filings
  const resultsS1 = await scanFormType('S-1', 's1_filings', extractS1Filing, startDate, endDate, existingS1, knownNames, prefixIndex)

  console.log(`\n[SECFilingsScan] === ALL DONE ===`)
  console.log(`[SECFilingsScan] 8-K: ${results8K.totalFetched} fetched, ${results8K.matched} matched, ${results8K.filteredOut} filtered, ${results8K.inserted} inserted`)
  console.log(`[SECFilingsScan] S-1: ${resultsS1.totalFetched} fetched, ${resultsS1.matched} matched, ${resultsS1.filteredOut} filtered, ${resultsS1.inserted} inserted`)
}

main().catch((err) => {
  console.error('[SECFilingsScan] Unhandled error:', err)
  process.exit(1)
})
