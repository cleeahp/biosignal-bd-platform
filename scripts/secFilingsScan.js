/**
 * SEC Filings Scan
 *
 * Standalone script that fetches recent 8-K and S-1 filings from the
 * SEC EDGAR full-text search API and stores them in the eight_k_filings
 * and s1_filings Supabase tables.
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
const EDGAR_SEARCH_FALLBACK = 'https://efts.sec.gov/LATEST/search-index'
const PAGE_SIZE = 100
const RATE_LIMIT_MS = 120 // slightly above 100ms for safety
const RETRY_DELAY_MS = 10_000
const MAX_RETRIES = 3
const USER_AGENT = 'BioSignal-BD-Platform/1.0 (cleeahp@gmail.com)'

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
  // CIK in URL is zero-padded to 10 digits
  const paddedCik = cik.replace(/^0+/, '')
  return `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${noDashes}/${accession}-index.htm`
}

// ── EDGAR API ───────────────────────────────────────────────────────────────

async function fetchEdgarPage(formType, startDate, endDate, from = 0, attempt = 1) {
  const params = new URLSearchParams({
    q: '*',
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
    // Try fallback URL pattern without q=* on first failure
    if (attempt === 1) {
      console.warn(`[SECFilingsScan] Primary endpoint returned ${response.status}, trying fallback...`)
      const fallbackParams = new URLSearchParams({
        forms: formType,
        startdt: startDate,
        enddt: endDate,
        from: String(from),
        size: String(PAGE_SIZE),
      })
      const fallbackUrl = `${EDGAR_SEARCH_FALLBACK}?${fallbackParams.toString()}`
      const fallbackResp = await fetch(fallbackUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (fallbackResp.ok) return fallbackResp.json()
    }

    const body = await response.text().catch(() => '')
    throw new Error(`EDGAR API error ${response.status}: ${body.substring(0, 300)}`)
  }

  return response.json()
}

// ── Data extraction ─────────────────────────────────────────────────────────

/**
 * Extract 8-K filing data from an EDGAR search hit.
 * The EDGAR full-text search returns hits with fields like:
 *   - entity_name, file_num, period_of_report, file_date, entity_id (CIK)
 *   - accession_no, display_names, display_date_filed, items (for 8-Ks)
 *   - tickers (if available)
 */
function extract8KFiling(hit) {
  const cik = hit.entity_id || hit.ciks?.[0] || ''
  const accession = hit.accession_no || hit.adsh || ''
  if (!accession) return null

  const companyName = hit.entity_name || hit.display_names?.[0] || null
  const ticker = hit.tickers?.[0] || hit.ticker || null
  const filingDate = hit.file_date || hit.period_of_report || hit.display_date_filed || null

  // 8-K items (e.g., ["1.01", "9.01"])
  let items = null
  if (hit.items && Array.isArray(hit.items) && hit.items.length > 0) {
    items = hit.items
  } else if (hit.items && typeof hit.items === 'string') {
    items = hit.items.split(',').map(s => s.trim()).filter(Boolean)
  }

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
  const cik = hit.entity_id || hit.ciks?.[0] || ''
  const accession = hit.accession_no || hit.adsh || ''
  if (!accession) return null

  const companyName = hit.entity_name || hit.display_names?.[0] || null
  const filingDate = hit.file_date || hit.period_of_report || hit.display_date_filed || null

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

// ── Scan a form type ────────────────────────────────────────────────────────

async function scanFormType(formType, table, extractFn, startDate, endDate, existingAccessions) {
  console.log(`\n[SECFilingsScan] === Scanning ${formType} filings ===`)
  console.log(`[SECFilingsScan] Date range: ${startDate} to ${endDate}`)
  console.log(`[SECFilingsScan] ${existingAccessions.size} existing ${formType} accession numbers loaded`)

  let totalFetched = 0
  let inserted = 0
  let skipped = 0
  let errors = 0
  let from = 0

  while (true) {
    let data
    try {
      data = await fetchEdgarPage(formType, startDate, endDate, from)
    } catch (err) {
      console.error(`[SECFilingsScan] Fatal fetch error for ${formType} at offset ${from}: ${err.message}`)
      break
    }

    // EDGAR search returns { hits: { hits: [...], total: { value: N } } }
    const hits = data.hits?.hits || data.filings || data.results || []
    const totalAvailable = data.hits?.total?.value || data.total || 0

    if (hits.length === 0) {
      if (from === 0) {
        console.log(`[SECFilingsScan] No ${formType} filings found in date range`)
      }
      break
    }

    totalFetched += hits.length

    const rowsToInsert = []

    for (const hit of hits) {
      // The hit may be wrapped in _source
      const source = hit._source || hit

      const filing = extractFn(source)
      if (!filing) continue

      if (existingAccessions.has(filing.accession_number)) {
        skipped++
        continue
      }

      existingAccessions.add(filing.accession_number)
      rowsToInsert.push(filing)
    }

    // Batch insert
    if (rowsToInsert.length > 0) {
      const { error } = await supabase.from(table).insert(rowsToInsert)

      if (error) {
        // Fall back to individual inserts
        for (const row of rowsToInsert) {
          const { error: rowErr } = await supabase.from(table).insert(row)
          if (rowErr) {
            console.error(`[SECFilingsScan] Insert error for ${row.accession_number}: ${rowErr.message}`)
            errors++
          } else {
            inserted++
          }
        }
      } else {
        inserted += rowsToInsert.length
      }
    }

    console.log(`[SECFilingsScan] ${formType} page: ${hits.length} hits fetched, ${rowsToInsert.length} new, ${totalFetched}/${totalAvailable} total`)

    from += hits.length

    if (from >= totalAvailable || hits.length < PAGE_SIZE) {
      break
    }

    // Rate limit
    await sleep(RATE_LIMIT_MS)
  }

  console.log(`[SECFilingsScan] ${formType} complete: ${totalFetched} fetched, ${inserted} inserted, ${skipped} skipped, ${errors} errors`)
  return { totalFetched, inserted, skipped, errors }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const endDate = formatDate(new Date())
  const startDate = formatDate(daysAgo(LOOKBACK_DAYS))
  console.log(`[SECFilingsScan] Mode: ${mode}, Lookback: ${LOOKBACK_DAYS} days (${startDate} to ${endDate})`)

  // Load existing accession numbers in parallel
  const [existing8K, existingS1] = await Promise.all([
    loadExistingAccessions('eight_k_filings'),
    loadExistingAccessions('s1_filings'),
  ])

  // Scan 8-K filings
  const results8K = await scanFormType('8-K', 'eight_k_filings', extract8KFiling, startDate, endDate, existing8K)

  // Rate limit between form types
  await sleep(RATE_LIMIT_MS)

  // Scan S-1 filings
  const resultsS1 = await scanFormType('S-1', 's1_filings', extractS1Filing, startDate, endDate, existingS1)

  console.log(`\n[SECFilingsScan] === ALL DONE ===`)
  console.log(`[SECFilingsScan] 8-K: ${results8K.inserted} inserted, ${results8K.skipped} skipped`)
  console.log(`[SECFilingsScan] S-1: ${resultsS1.inserted} inserted, ${resultsS1.skipped} skipped`)
}

main().catch((err) => {
  console.error('[SECFilingsScan] Unhandled error:', err)
  process.exit(1)
})
