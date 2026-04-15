/**
 * Match SEC Companies to Directory
 *
 * Downloads SEC's company_tickers.json and matches each company against
 * the companies_directory Supabase table using multi-layer name matching.
 * Stores matched results in the sec_companies table.
 *
 * Usage:
 *   node scripts/matchSecCompanies.js
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[MatchSEC] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
const USER_AGENT = 'BioSignal-BD-Platform/1.0 (cleeahp@gmail.com)'

// ── Name cleaning ───────────────────────────────────────────────────────────

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|AG|NV|SE|Pty)\s*$/i

const COUNTRY_SUFFIX_RE = /\s*[/\\]\s*(?:DE|NEW|FI|UK|CAN|NV|MD|NY|CA|TX|WA|IL|MA|PA|NJ|CT|OH|MN|CO|AZ|GA|NC|VA|FL|OR|WI|IN|MO|KS|UT|SC|TN|LA|AL|MI|IA|NE|AR|MS|OK|WV|NH|ME|HI|ID|MT|NM|ND|RI|SD|VT|WY|AK|DC|PR|GU|VI)\s*$/

const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'in', 'by', 'at', 'to'])

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

function extractCoreWords(cleaned) {
  if (!cleaned) return []
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w))
  return words.slice(0, 2)
}

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

// ── Download SEC tickers ────────────────────────────────────────────────────

async function downloadSecTickers() {
  console.log(`[MatchSEC] Downloading ${SEC_TICKERS_URL}...`)
  const response = await fetch(SEC_TICKERS_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  })

  if (!response.ok) {
    throw new Error(`Failed to download company_tickers.json: ${response.status}`)
  }

  const data = await response.json()

  // Format: { "0": { cik_str: "320193", ticker: "AAPL", title: "Apple Inc" }, ... }
  const companies = Object.values(data)
  console.log(`[MatchSEC] Downloaded ${companies.length} SEC companies`)
  return companies
}

// ── Load companies_directory ────────────────────────────────────────────────

async function loadDirectory() {
  const nameMap = new Map()
  const prefixIndex = new Map()
  const PAGE = 1000
  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name, company_size, primary_industry')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[MatchSEC] Error loading companies_directory: ${error.message}`); break }
    if (!data || data.length === 0) break

    for (const row of data) {
      total++
      const entry = { name: row.name, size: row.company_size || null, industry: row.primary_industry || null }
      const cleaned = cleanName(row.name)
      if (!cleaned) continue

      // Name map (for exact matching)
      if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
      nameMap.get(cleaned).push(entry)

      // Prefix index (for keyword matching)
      const coreWords = extractCoreWords(cleaned)
      if (coreWords.length > 0) {
        const firstWord = coreWords[0]
        if (!prefixIndex.has(firstWord)) prefixIndex.set(firstWord, [])
        prefixIndex.get(firstWord).push({ ...entry, cleanedName: cleaned })
      }
    }
    offset += PAGE
  }

  console.log(`[MatchSEC] Loaded ${total} directory companies → ${nameMap.size} cleaned names, ${prefixIndex.size} prefix words`)
  return { nameMap, prefixIndex }
}

// ── Matching layers ─────────────────────────────────────────────────────────

function matchByExactName(secName, nameMap) {
  const cleaned = cleanName(secName)
  if (!cleaned) return null

  const entries = nameMap.get(cleaned)
  if (!entries || entries.length === 0) return null

  const best = pickLargest(entries)
  return { dirName: best.name, size: best.size, industry: best.industry, layer: 'exact_name' }
}

function matchByKeyword(secName, prefixIndex) {
  const cleaned = cleanName(secName)
  if (!cleaned) return null

  const coreWords = extractCoreWords(cleaned)
  if (coreWords.length === 0) return null

  const firstWord = coreWords[0]

  // For short single-word names (<=4 chars), require exact word-boundary match
  if (coreWords.length === 1 && firstWord.length <= 4) {
    const candidates = prefixIndex.get(firstWord)
    if (!candidates) return null
    const exact = candidates.filter((c) => c.cleanedName === firstWord)
    if (exact.length === 0) return null
    const best = pickLargest(exact)
    return { dirName: best.name, size: best.size, industry: best.industry, layer: 'keyword' }
  }

  const candidates = prefixIndex.get(firstWord)
  if (!candidates || candidates.length === 0) return null

  // Try 2-word prefix match first
  const prefix = coreWords.join(' ')
  const matches = candidates.filter((c) => c.cleanedName.startsWith(prefix))

  if (matches.length > 0) {
    const best = pickLargest(matches)
    return { dirName: best.name, size: best.size, industry: best.industry, layer: 'keyword' }
  }

  // Fall back to single first-word prefix
  if (coreWords.length > 1) {
    const singleMatches = candidates.filter((c) => c.cleanedName.startsWith(firstWord))
    if (singleMatches.length > 0) {
      const best = pickLargest(singleMatches)
      return { dirName: best.name, size: best.size, industry: best.industry, layer: 'keyword' }
    }
  }

  return null
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load data in parallel
  const [secCompanies, directory] = await Promise.all([
    downloadSecTickers(),
    loadDirectory(),
  ])

  const { nameMap, prefixIndex } = directory

  let exactMatches = 0
  let keywordMatches = 0
  let noMatch = 0
  const rowsToInsert = []
  const seenCIKs = new Set()

  for (const sec of secCompanies) {
    const cik = String(sec.cik_str || sec.cik || '')
    const ticker = sec.ticker || ''
    const secName = sec.title || ''

    if (!cik || !secName) continue
    // Deduplicate by CIK (some companies appear multiple times with different tickers)
    if (seenCIKs.has(cik)) continue

    // Layer 1: Exact name
    let result = matchByExactName(secName, nameMap)

    // Layer 2: Keyword
    if (!result) {
      result = matchByKeyword(secName, prefixIndex)
    }

    if (result) {
      seenCIKs.add(cik)
      rowsToInsert.push({
        cik,
        ticker,
        sec_name: secName,
        directory_name: result.dirName,
        company_size: result.size,
        primary_industry: result.industry,
        matched_via: result.layer,
      })

      if (result.layer === 'exact_name') exactMatches++
      else keywordMatches++
    } else {
      noMatch++
    }
  }

  console.log(`\n[MatchSEC] === MATCHING COMPLETE ===`)
  console.log(`[MatchSEC] SEC companies processed: ${secCompanies.length}`)
  console.log(`[MatchSEC] Exact name matches: ${exactMatches}`)
  console.log(`[MatchSEC] Keyword matches:     ${keywordMatches}`)
  console.log(`[MatchSEC] Total matched:        ${rowsToInsert.length}`)
  console.log(`[MatchSEC] No match:             ${noMatch}`)

  // Clear existing sec_companies and insert fresh data
  console.log(`\n[MatchSEC] Clearing existing sec_companies table...`)
  // Delete in batches to avoid timeouts
  while (true) {
    const { data, error } = await supabase
      .from('sec_companies')
      .select('id')
      .limit(1000)
    if (error) { console.error(`[MatchSEC] Error checking sec_companies: ${error.message}`); break }
    if (!data || data.length === 0) break
    const ids = data.map(r => r.id)
    const { error: delErr } = await supabase
      .from('sec_companies')
      .delete()
      .in('id', ids)
    if (delErr) { console.error(`[MatchSEC] Error deleting: ${delErr.message}`); break }
  }

  // Insert new matches
  console.log(`[MatchSEC] Inserting ${rowsToInsert.length} matched companies...`)
  const BATCH = 500
  let inserted = 0
  let errors = 0

  for (let i = 0; i < rowsToInsert.length; i += BATCH) {
    const batch = rowsToInsert.slice(i, i + BATCH)
    const { error } = await supabase.from('sec_companies').insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from('sec_companies').insert(row)
        if (rowErr) {
          console.error(`[MatchSEC] Insert error for CIK ${row.cik} (${row.sec_name}): ${rowErr.message}`)
          errors++
        } else {
          inserted++
        }
      }
    } else {
      inserted += batch.length
    }
  }

  console.log(`\n[MatchSEC] === ALL DONE ===`)
  console.log(`[MatchSEC] Inserted: ${inserted}`)
  console.log(`[MatchSEC] Errors:   ${errors}`)
}

main().catch((err) => {
  console.error('[MatchSEC] Unhandled error:', err)
  process.exit(1)
})
