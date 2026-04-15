/**
 * SEC Filings Scan
 *
 * Standalone script that fetches recent 8-K and S-1 filings from the
 * SEC EDGAR full-text search API and stores them in the eight_k_filings
 * and s1_filings Supabase tables.
 *
 * Filters filings to companies in companies_directory using strict name
 * matching (exact cleaned name or bidirectional keyword match — no fuzzy
 * or prefix matching). Splits the date range into 1-week chunks for the
 * 90-day manual mode to stay under EDGAR's 10,000-result cap.
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
const RATE_LIMIT_MS = 120
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

function buildFilingUrl(cik, accession) {
  if (!cik || !accession) return null
  const noDashes = accession.replace(/-/g, '')
  const paddedCik = cik.replace(/^0+/, '')
  return `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${noDashes}/${accession}-index.htm`
}

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

// ── Company name cleaning & matching ────────────────────────────────────────

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i

const COUNTRY_SUFFIX_RE = /\s*[/\\]\s*(?:DE|NEW|FI|UK|CAN|NV|MD|NY|CA|TX|WA|IL|MA|PA|NJ|CT|OH|MN|CO|AZ|GA|NC|VA|FL|OR|WI|IN|MO|KS|UT|SC|TN|LA|AL|MI|IA|NE|AR|MS|OK|WV|NH|ME|HI|ID|MT|NM|ND|RI|SD|VT|WY|AK|DC|PR|GU|VI)\s*$/

const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'a', 'an', 'in', 'by', 'at', 'to'])

/**
 * Clean a company name for comparison: strip parentheticals, country/state
 * suffixes, legal suffixes, trailing punctuation, lowercase.
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
 * Extract significant words from a cleaned name (skip stop words).
 */
function significantWords(cleaned) {
  if (!cleaned) return []
  return cleaned.split(/\s+/).filter(w => w.length > 0 && !STOP_WORDS.has(w))
}

/**
 * Parse company_size strings like "10,001+ employees" → 10001 (lower bound).
 */
function parseSize(sizeStr) {
  if (!sizeStr) return 0
  const match = sizeStr.replace(/,/g, '').match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

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
 *   - nameMap: cleaned name → [{name, size}] (for Layer 1 exact matching)
 *   - wordIndex: sorted-word-key → [{name, size, words}] (for Layer 2 strict keyword matching)
 *   - sizeMap: exact directory name → company_size
 */
async function loadDirectory() {
  const nameMap = new Map()
  const wordIndex = new Map()
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
      const cleaned = cleanName(row.name)
      if (!cleaned) continue

      // Layer 1: exact name map
      if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
      nameMap.get(cleaned).push(entry)

      // Layer 2: word index — key is sorted significant words joined
      const words = significantWords(cleaned)
      if (words.length >= 2) {
        const key = [...words].sort().join('|')
        if (!wordIndex.has(key)) wordIndex.set(key, [])
        wordIndex.get(key).push({ ...entry, words })
      }

      // Size map
      if (!sizeMap.has(row.name)) {
        sizeMap.set(row.name, row.company_size || null)
      }
    }
    offset += PAGE
  }

  console.log(`[SECFilingsScan] Loaded ${total} directory companies → ${nameMap.size} cleaned names, ${wordIndex.size} word keys`)
  return { nameMap, wordIndex, sizeMap }
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

// ── Strict matching ─────────────────────────────────────────────────────────

/**
 * Layer 1: Exact cleaned name match.
 */
function matchExact(companyName, nameMap) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const entries = nameMap.get(cleaned)
  if (!entries || entries.length === 0) return null

  const best = pickLargest(entries)
  return { dirName: best.name, size: best.size, layer: 'exact_name' }
}

/**
 * Layer 2: Strict bidirectional keyword match.
 * Only for multi-word names. ALL significant words from the filing name
 * must appear in the directory name AND vice versa.
 */
function matchKeywordStrict(companyName, wordIndex) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const filingWords = significantWords(cleaned)
  // Single-word names must match via Layer 1 only
  if (filingWords.length < 2) return null

  const filingKey = [...filingWords].sort().join('|')

  // Direct lookup: exact same set of significant words
  const entries = wordIndex.get(filingKey)
  if (entries && entries.length > 0) {
    const best = pickLargest(entries)
    return { dirName: best.name, size: best.size, layer: 'keyword' }
  }

  return null
}

/**
 * Match a filing company name against companies_directory.
 * Returns { dirName, size, layer } or null.
 */
function matchCompany(companyName, nameMap, wordIndex) {
  const exact = matchExact(companyName, nameMap)
  if (exact) return exact

  const keyword = matchKeywordStrict(companyName, wordIndex)
  if (keyword) return keyword

  return null
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

async function scanChunk(formType, extractFn, startDate, endDate, existingAccessions, nameMap, wordIndex, sizeMap, existingAltNames, altNameRows) {
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

      // Strict name match against companies_directory
      const dirMatch = matchCompany(filing.company_name, nameMap, wordIndex)
      if (!dirMatch) {
        filteredOut++
        continue
      }

      // Enrich with matched_name and company_size
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

      console.log(`[SECFilingsScan] Matched: ${filing.company_name} → ${dirMatch.dirName} (${dirMatch.layer}) — kept`)
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

async function scanFormType(formType, table, extractFn, startDate, endDate, existingAccessions, nameMap, wordIndex, sizeMap, existingAltNames, altNameRows) {
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
    const result = await scanChunk(formType, extractFn, chunk.startDate, chunk.endDate, existingAccessions, nameMap, wordIndex, sizeMap, existingAltNames, altNameRows)

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

  // Load data in parallel
  console.log('[SECFilingsScan] Loading company data and existing accessions...')
  const [directory, existing8K, existingS1, existingAltNames] = await Promise.all([
    loadDirectory(),
    loadExistingAccessions('eight_k_filings'),
    loadExistingAccessions('s1_filings'),
    loadExistingAlternateNames(),
  ])

  const { nameMap, wordIndex, sizeMap } = directory
  console.log(`[SECFilingsScan] ${existingAltNames.size} existing alternate names loaded`)

  const altNameRows = []

  // Scan 8-K filings
  const results8K = await scanFormType('8-K', 'eight_k_filings', extract8KFiling, startDate, endDate, existing8K, nameMap, wordIndex, sizeMap, existingAltNames, altNameRows)

  await sleep(RATE_LIMIT_MS)

  // Scan S-1 filings
  const resultsS1 = await scanFormType('S-1', 's1_filings', extractS1Filing, startDate, endDate, existingS1, nameMap, wordIndex, sizeMap, existingAltNames, altNameRows)

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
