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

const COUNTRY_SUFFIX_RE = /\s*[/\\]\s*[A-Z]{2,3}\s*$/

const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'in', 'by', 'at', 'to'])

/**
 * Clean a company name for comparison: strip parentheticals, country suffixes,
 * legal suffixes, trailing punctuation, lowercase.
 */
function cleanName(raw) {
  if (!raw) return ''
  let s = raw
  s = s.replace(/\s*\([^)]*\)/g, '')
  s = s.replace(COUNTRY_SUFFIX_RE, '')
  for (let i = 0; i < 3; i++) {
    const prev = s
    s = s.replace(LEGAL_SUFFIXES_RE, '')
    if (s === prev) break
  }
  s = s.replace(/[,.\s]+$/, '').trim()
  return s.toLowerCase()
}

/**
 * Extract the first 1-2 significant words from a cleaned name for prefix matching.
 */
function extractCoreWords(cleaned) {
  if (!cleaned) return []
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w))
  return words.slice(0, 2)
}

/**
 * Parse company_size strings like "10,001+ employees" → 10001 (lower bound).
 * Returns 0 for null/empty/unparseable.
 */
function parseSize(sizeStr) {
  if (!sizeStr) return 0
  const match = sizeStr.replace(/,/g, '').match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Given an array of { name, size } entries, return the one with the largest
 * parsed company_size. Ties broken by first occurrence.
 */
function pickLargest(entries) {
  if (!entries || entries.length === 0) return null
  if (entries.length === 1) return entries[0]
  let best = entries[0]
  let bestSize = parseSize(best.size)
  for (let i = 1; i < entries.length; i++) {
    const s = parseSize(entries[i].size)
    if (s > bestSize) {
      best = entries[i]
      bestSize = s
    }
  }
  return best
}

// ── Data loading ────────────────────────────────────────────────────────────

/**
 * Load companies_directory into memory. Builds:
 *   - knownNames: Set of cleaned names (for filtering)
 *   - nameMap: cleaned name → [{name, size}] (for exact matching)
 *   - dirPrefixIndex: first significant word → [{name, cleanedName, size}] (for keyword matching)
 *   - sizeMap: exact directory name → company_size (for enrichment)
 */
async function loadDirectory() {
  const knownNames = new Set()
  const nameMap = new Map()
  const dirPrefixIndex = new Map()
  const sizeMap = new Map()
  const PAGE = 1000
  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name, company_size')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading companies_directory: ${error.message}`); break }
    if (!data || data.length === 0) break

    for (const row of data) {
      total++
      const entry = { name: row.name, size: row.company_size || null }

      // Known names set (for filtering)
      const cleaned = cleanName(row.name)
      if (cleaned) {
        knownNames.add(cleaned)

        // Name map (for exact matching)
        if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
        nameMap.get(cleaned).push(entry)

        // Prefix index (for keyword matching)
        const coreWords = extractCoreWords(cleaned)
        if (coreWords.length > 0) {
          const firstWord = coreWords[0]
          if (!dirPrefixIndex.has(firstWord)) dirPrefixIndex.set(firstWord, [])
          dirPrefixIndex.get(firstWord).push({ ...entry, cleanedName: cleaned })
        }
      }

      // Size map (exact name → company_size)
      if (!sizeMap.has(row.name)) {
        sizeMap.set(row.name, row.company_size || null)
      }
    }
    offset += PAGE
  }

  console.log(`[SECFilingsScan] Loaded ${total} directory companies → ${nameMap.size} cleaned names, ${dirPrefixIndex.size} prefix words`)
  return { knownNames, nameMap, dirPrefixIndex, sizeMap }
}

/**
 * Load additional known company names from clinical_trials and past_clients.
 * Adds to the existing knownNames Set for filtering.
 */
async function loadAdditionalKnownNames(knownNames) {
  const PAGE = 1000
  const before = knownNames.size

  // Load clinical_trials lead sponsor names
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('clinical_trials')
      .select('lead_sponsor_name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading clinical_trials: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      const cleaned = cleanName(row.lead_sponsor_name)
      if (cleaned) knownNames.add(cleaned)
    }
    offset += PAGE
  }
  console.log(`[SECFilingsScan] Loaded ${knownNames.size - before} additional names from clinical_trials`)

  // Load past_clients names
  const { data: clients, error: clientErr } = await supabase
    .from('past_clients')
    .select('name')
    .eq('is_active', true)
  if (clientErr) {
    console.error(`[SECFilingsScan] Error loading past_clients: ${clientErr.message}`)
  } else if (clients) {
    const beforeClients = knownNames.size
    for (const row of clients) {
      const cleaned = cleanName(row.name)
      if (cleaned) knownNames.add(cleaned)
    }
    console.log(`[SECFilingsScan] Loaded ${knownNames.size - beforeClients} additional names from past_clients`)
  }

  console.log(`[SECFilingsScan] Total known companies: ${knownNames.size}`)
}

/**
 * Load existing alternate names from companies_alternate_names into a Set
 * (lowercased) for dedup when recording new matches.
 */
async function loadExistingAlternateNames() {
  const names = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('alternate_name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[SECFilingsScan] Error loading alternate names: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      names.add(row.alternate_name.trim().toLowerCase())
    }
    offset += PAGE
  }

  return names
}

/**
 * Build a prefix index for fast fuzzy matching against the known names Set.
 * Used for the keep/discard filtering step (not the directory matching step).
 */
function buildFilterPrefixIndex(knownNames) {
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
 * Check if a filing's company name matches any known company (for filtering).
 * Tries exact cleaned match first, then prefix match using the index.
 */
function matchesKnownCompany(filingCompanyName, knownNames, filterPrefixIndex) {
  const cleaned = cleanName(filingCompanyName)
  if (!cleaned) return false

  if (knownNames.has(cleaned)) return true

  const firstWord = cleaned.split(/\s+/)[0]
  if (!firstWord || firstWord.length < 4) return false

  const candidates = filterPrefixIndex.get(firstWord)
  if (!candidates) return false

  for (const known of candidates) {
    if (known.startsWith(cleaned) || cleaned.startsWith(known)) {
      const overlap = Math.min(known.length, cleaned.length)
      if (overlap >= 4) return true
    }
  }

  return false
}

// ── Directory matching (for enrichment) ─────────────────────────────────────

/**
 * Layer 1: Exact cleaned name match against companies_directory.
 * Returns { dirName, size, layer } or null.
 */
function matchByExactName(companyName, nameMap) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const entries = nameMap.get(cleaned)
  if (!entries || entries.length === 0) return null

  const best = pickLargest(entries)
  return { dirName: best.name, size: best.size, layer: 'exact_name' }
}

/**
 * Layer 2: Core keyword prefix match against companies_directory.
 * Returns { dirName, size, layer } or null.
 */
function matchByKeyword(companyName, dirPrefixIndex) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const coreWords = extractCoreWords(cleaned)
  if (coreWords.length === 0) return null

  const firstWord = coreWords[0]

  // For short single-word names (<=4 chars), require exact word-boundary match
  if (coreWords.length === 1 && firstWord.length <= 4) {
    const candidates = dirPrefixIndex.get(firstWord)
    if (!candidates) return null
    const exact = candidates.filter((c) => c.cleanedName === firstWord)
    if (exact.length === 0) return null
    const best = pickLargest(exact)
    return { dirName: best.name, size: best.size, layer: 'keyword' }
  }

  const candidates = dirPrefixIndex.get(firstWord)
  if (!candidates || candidates.length === 0) return null

  // Try 2-word prefix match first
  const prefix = coreWords.join(' ')
  const matches = candidates.filter((c) => c.cleanedName.startsWith(prefix))

  if (matches.length > 0) {
    const best = pickLargest(matches)
    return { dirName: best.name, size: best.size, layer: 'keyword' }
  }

  // Fall back to single first-word prefix
  if (coreWords.length > 1) {
    const singleMatches = candidates.filter((c) => c.cleanedName.startsWith(firstWord))
    if (singleMatches.length > 0) {
      const best = pickLargest(singleMatches)
      return { dirName: best.name, size: best.size, layer: 'keyword' }
    }
  }

  return null
}

/**
 * Match a filing's company_name against companies_directory.
 * Returns { dirName, size, layer } or null.
 */
function matchFilingCompany(companyName, nameMap, dirPrefixIndex) {
  // Layer 1: Exact name
  const exact = matchByExactName(companyName, nameMap)
  if (exact) return exact

  // Layer 2: Keyword
  const keyword = matchByKeyword(companyName, dirPrefixIndex)
  if (keyword) return keyword

  return null
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

async function scanChunk(formType, extractFn, startDate, endDate, existingAccessions, knownNames, filterPrefixIndex, nameMap, dirPrefixIndex, sizeMap, existingAltNames, altNameRows) {
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
      if (!matchesKnownCompany(filing.company_name, knownNames, filterPrefixIndex)) {
        filteredOut++
        continue
      }

      // Enrich: match against companies_directory for matched_name and company_size
      const dirMatch = matchFilingCompany(filing.company_name, nameMap, dirPrefixIndex)
      if (dirMatch) {
        filing.matched_name = dirMatch.dirName
        filing.company_size = dirMatch.size || (sizeMap.get(dirMatch.dirName) || null)

        // Record in companies_alternate_names if new
        const altKey = filing.company_name.trim().toLowerCase()
        if (!existingAltNames.has(altKey)) {
          existingAltNames.add(altKey)
          altNameRows.push({
            directory_name: dirMatch.dirName,
            alternate_name: filing.company_name,
            matched_via: dirMatch.layer,
            domain: null,
          })
        }
      } else {
        filing.matched_name = null
        filing.company_size = null
      }

      console.log(`[SECFilingsScan] Matched: ${filing.company_name}${dirMatch ? ` → ${dirMatch.dirName} (${dirMatch.layer})` : ''} — kept`)
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

async function scanFormType(formType, table, extractFn, startDate, endDate, existingAccessions, knownNames, filterPrefixIndex, nameMap, dirPrefixIndex, sizeMap, existingAltNames, altNameRows) {
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
    const result = await scanChunk(formType, extractFn, chunk.startDate, chunk.endDate, existingAccessions, knownNames, filterPrefixIndex, nameMap, dirPrefixIndex, sizeMap, existingAltNames, altNameRows)

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

  // Load all data in parallel
  console.log('[SECFilingsScan] Loading company data and existing accessions...')
  const [directory, existing8K, existingS1, existingAltNames] = await Promise.all([
    loadDirectory(),
    loadExistingAccessions('eight_k_filings'),
    loadExistingAccessions('s1_filings'),
    loadExistingAlternateNames(),
  ])

  const { knownNames, nameMap, dirPrefixIndex, sizeMap } = directory

  // Load additional known names from clinical_trials and past_clients
  await loadAdditionalKnownNames(knownNames)

  // Build filter prefix index (for keep/discard decision)
  const filterPrefixIndex = buildFilterPrefixIndex(knownNames)
  console.log(`[SECFilingsScan] ${existingAltNames.size} existing alternate names loaded`)

  // Shared list of new alternate name rows to insert at the end
  const altNameRows = []

  // Scan 8-K filings
  const results8K = await scanFormType('8-K', 'eight_k_filings', extract8KFiling, startDate, endDate, existing8K, knownNames, filterPrefixIndex, nameMap, dirPrefixIndex, sizeMap, existingAltNames, altNameRows)

  await sleep(RATE_LIMIT_MS)

  // Scan S-1 filings
  const resultsS1 = await scanFormType('S-1', 's1_filings', extractS1Filing, startDate, endDate, existingS1, knownNames, filterPrefixIndex, nameMap, dirPrefixIndex, sizeMap, existingAltNames, altNameRows)

  // Insert new alternate name rows
  if (altNameRows.length > 0) {
    console.log(`\n[SECFilingsScan] Inserting ${altNameRows.length} new alternate name rows...`)
    const BATCH = 500
    let altInserted = 0
    let altErrors = 0

    for (let i = 0; i < altNameRows.length; i += BATCH) {
      const batch = altNameRows.slice(i, i + BATCH)
      const { error } = await supabase.from('companies_alternate_names').insert(batch)

      if (error) {
        for (const row of batch) {
          const { error: rowErr } = await supabase.from('companies_alternate_names').insert(row)
          if (rowErr) {
            console.error(`[SECFilingsScan] Alt name insert error for "${row.alternate_name}": ${rowErr.message}`)
            altErrors++
          } else {
            altInserted++
          }
        }
      } else {
        altInserted += batch.length
      }
    }
    console.log(`[SECFilingsScan] Alternate names: ${altInserted} inserted, ${altErrors} errors`)
  }

  console.log(`\n[SECFilingsScan] === ALL DONE ===`)
  console.log(`[SECFilingsScan] 8-K: ${results8K.totalFetched} fetched, ${results8K.matched} matched, ${results8K.filteredOut} filtered, ${results8K.inserted} inserted`)
  console.log(`[SECFilingsScan] S-1: ${resultsS1.totalFetched} fetched, ${resultsS1.matched} matched, ${resultsS1.filteredOut} filtered, ${resultsS1.inserted} inserted`)
  console.log(`[SECFilingsScan] Alternate names: ${altNameRows.length} new`)
}

main().catch((err) => {
  console.error('[SECFilingsScan] Unhandled error:', err)
  process.exit(1)
})
