/**
 * NIH RePORTER Funding Scan
 *
 * Standalone script that fetches recently-added NIH-funded projects from the
 * NIH RePORTER API and stores them in the funding_projects Supabase table.
 *
 * Filters projects to organizations in companies_directory using strict name
 * matching (exact cleaned name or bidirectional keyword match — no fuzzy
 * or prefix matching). Unmatched projects are still inserted with null
 * matched_name/company_size so they remain searchable.
 *
 * Usage:
 *   node scripts/nihFundingScan.js --mode daily    # last 3 days
 *   node scripts/nihFundingScan.js --mode manual   # last 90 days
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[NIHFundingScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const REPORTER_ENDPOINT = 'https://api.reporter.nih.gov/v2/projects/search'
const PAGE_SIZE = 500
const MAX_OFFSET = 14_999
const RATE_LIMIT_MS = 1000
const RETRY_DELAY_MS = 10_000
const MAX_RETRIES = 3

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/nihFundingScan.js --mode <daily|manual>')
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
    if (error) { console.error(`[NIHFundingScan] Error loading companies_directory: ${error.message}`); break }
    if (!data || data.length === 0) break

    for (const row of data) {
      total++
      const entry = { name: row.name, size: row.company_size || null }
      const cleaned = cleanName(row.name)
      if (!cleaned) continue

      if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
      nameMap.get(cleaned).push(entry)

      const words = significantWords(cleaned)
      if (words.length >= 2) {
        const key = [...words].sort().join('|')
        if (!wordIndex.has(key)) wordIndex.set(key, [])
        wordIndex.get(key).push({ ...entry, words })
      }

      if (!sizeMap.has(row.name)) {
        sizeMap.set(row.name, row.company_size || null)
      }
    }
    offset += PAGE
  }

  console.log(`[NIHFundingScan] Loaded ${total} directory companies → ${nameMap.size} cleaned names, ${wordIndex.size} word keys`)
  return { nameMap, wordIndex, sizeMap }
}

async function loadExistingAlternateNames() {
  const names = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('alternate_name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[NIHFundingScan] Error loading alternate names: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      names.add(row.alternate_name.trim().toLowerCase())
    }
    offset += PAGE
  }

  return names
}

async function loadExistingApplIds() {
  const ids = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('funding_projects')
      .select('appl_id')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[NIHFundingScan] Error loading existing funding_projects: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      ids.add(row.appl_id)
    }
    offset += PAGE
  }

  return ids
}

// ── Strict matching ─────────────────────────────────────────────────────────

function matchExact(companyName, nameMap) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const entries = nameMap.get(cleaned)
  if (!entries || entries.length === 0) return null

  const best = pickLargest(entries)
  return { dirName: best.name, size: best.size, layer: 'exact_name' }
}

function matchKeywordStrict(companyName, wordIndex) {
  const cleaned = cleanName(companyName)
  if (!cleaned) return null

  const filingWords = significantWords(cleaned)
  if (filingWords.length < 2) return null

  const filingKey = [...filingWords].sort().join('|')

  const entries = wordIndex.get(filingKey)
  if (entries && entries.length > 0) {
    const best = pickLargest(entries)
    return { dirName: best.name, size: best.size, layer: 'keyword' }
  }

  return null
}

function matchCompany(companyName, nameMap, wordIndex) {
  const exact = matchExact(companyName, nameMap)
  if (exact) return exact

  const keyword = matchKeywordStrict(companyName, wordIndex)
  if (keyword) return keyword

  return null
}

// ── NIH RePORTER API ────────────────────────────────────────────────────────

async function fetchReporterPage(fromDate, toDate, offset, attempt = 1) {
  const payload = {
    criteria: {
      award_notice_date: {
        from_date: fromDate,
        to_date: toDate,
      },
      organization_type: ['Domestic For-Profits'],
    },
    offset,
    limit: PAGE_SIZE,
    sort_field: 'DateAdded',
    sort_order: 'desc',
  }

  const response = await fetch(REPORTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })

  if (response.status === 429) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`Rate limited after ${MAX_RETRIES} retries`)
    }
    console.warn(`[NIHFundingScan] 429 rate limited — waiting ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`)
    await sleep(RETRY_DELAY_MS)
    return fetchReporterPage(fromDate, toDate, offset, attempt + 1)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`RePORTER API error ${response.status}: ${body.substring(0, 300)}`)
  }

  return response.json()
}

// ── Data extraction ─────────────────────────────────────────────────────────

function normalizeDate(value) {
  if (!value) return null
  const str = String(value)
  const match = str.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

function extractProject(record) {
  const applId = record.appl_id != null ? String(record.appl_id) : null
  if (!applId) return null

  const org = record.organization || {}

  return {
    appl_id: applId,
    project_num: record.project_num || null,
    project_title: record.project_title || null,
    org_name: org.org_name || null,
    org_city: org.org_city || null,
    org_state: org.org_state || null,
    award_amount: typeof record.award_amount === 'number' ? record.award_amount : (record.award_amount ? Number(record.award_amount) : null),
    public_health_relevance: record.phr_text || null,
    fiscal_year: typeof record.fiscal_year === 'number' ? record.fiscal_year : (record.fiscal_year ? parseInt(record.fiscal_year, 10) : null),
    award_notice_date: normalizeDate(record.award_notice_date),
    date_added: normalizeDate(record.date_added),
    project_url: `https://reporter.nih.gov/project-details/${applId}`,
  }
}

// ── Batch insert helper ─────────────────────────────────────────────────────

async function batchInsert(table, rows) {
  if (rows.length === 0) return { inserted: 0, errors: 0 }

  let inserted = 0
  let errors = 0
  const BATCH = 100

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await supabase.from(table).insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from(table).insert(row)
        if (rowErr) {
          const label = row.appl_id || row.alternate_name || 'unknown'
          console.error(`[NIHFundingScan] Insert error for ${label}: ${rowErr.message}`)
          errors++
        } else {
          inserted++
        }
      }
    } else {
      inserted += batch.length
    }
  }

  return { inserted, errors }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const toDate = formatDate(new Date())
  const fromDate = formatDate(daysAgo(LOOKBACK_DAYS))
  console.log(`[NIHFundingScan] Mode: ${mode}, Award notice date range: ${fromDate} to ${toDate}`)

  console.log('[NIHFundingScan] Loading company data and existing appl_ids...')
  const [directory, existingApplIds, existingAltNames] = await Promise.all([
    loadDirectory(),
    loadExistingApplIds(),
    loadExistingAlternateNames(),
  ])

  const { nameMap, wordIndex, sizeMap } = directory
  console.log(`[NIHFundingScan] ${existingApplIds.size} existing appl_ids loaded`)
  console.log(`[NIHFundingScan] ${existingAltNames.size} existing alternate names loaded`)

  const altNameRows = []
  const rowsToInsert = []
  let totalFetched = 0
  let totalMatched = 0
  let totalUnmatched = 0
  let totalSkipped = 0
  let offset = 0

  while (offset <= MAX_OFFSET) {
    let data
    try {
      data = await fetchReporterPage(fromDate, toDate, offset)
    } catch (err) {
      console.error(`[NIHFundingScan] Fetch error at offset ${offset}: ${err.message}`)
      break
    }

    const results = data.results || []
    const meta = data.meta || {}
    const totalAvailable = meta.total || 0

    if (offset === 0 && totalAvailable > 15_000) {
      console.warn(`[NIHFundingScan] WARNING: total results (${totalAvailable}) exceed max offset 15,000 — some projects will be missed`)
    }

    if (results.length === 0) break

    totalFetched += results.length
    console.log(`[NIHFundingScan] Page ${Math.floor(offset / PAGE_SIZE) + 1}: fetched ${results.length} projects (total so far: ${totalFetched})`)

    for (const record of results) {
      const project = extractProject(record)
      if (!project) continue

      if (existingApplIds.has(project.appl_id)) {
        totalSkipped++
        continue
      }
      existingApplIds.add(project.appl_id)

      const dirMatch = matchCompany(project.org_name, nameMap, wordIndex)
      if (dirMatch) {
        project.matched_name = dirMatch.dirName
        project.company_size = dirMatch.size || (sizeMap.get(dirMatch.dirName) || null)
        project.matched_via = dirMatch.layer

        const altKey = project.org_name ? project.org_name.trim().toLowerCase() : ''
        if (altKey && !existingAltNames.has(altKey)) {
          existingAltNames.add(altKey)
          altNameRows.push({
            directory_name: dirMatch.dirName,
            alternate_name: project.org_name,
            matched_via: dirMatch.layer,
            domain: null,
          })
        }

        console.log(`[NIHFundingScan] Matched: ${project.org_name} → ${dirMatch.dirName} (${dirMatch.layer}) — kept`)
        totalMatched++
      } else {
        project.matched_name = null
        project.company_size = null
        project.matched_via = null
        totalUnmatched++
      }

      rowsToInsert.push(project)
    }

    if (results.length < PAGE_SIZE) break
    if (totalAvailable && offset + PAGE_SIZE >= totalAvailable) break

    offset += PAGE_SIZE
    if (offset > MAX_OFFSET) {
      console.warn(`[NIHFundingScan] Reached max offset ${MAX_OFFSET} — stopping pagination`)
      break
    }

    await sleep(RATE_LIMIT_MS)
  }

  console.log(`\n[NIHFundingScan] Inserting ${rowsToInsert.length} funding projects...`)
  const insertResult = await batchInsert('funding_projects', rowsToInsert)
  console.log(`[NIHFundingScan] funding_projects: ${insertResult.inserted} inserted, ${insertResult.errors} errors`)

  if (altNameRows.length > 0) {
    console.log(`[NIHFundingScan] Inserting ${altNameRows.length} new alternate name rows...`)
    const altResult = await batchInsert('companies_alternate_names', altNameRows)
    console.log(`[NIHFundingScan] Alternate names: ${altResult.inserted} inserted, ${altResult.errors} errors`)
  }

  console.log(`\n[NIHFundingScan] Scan complete: ${totalFetched} fetched, ${totalMatched} matched, ${totalUnmatched} unmatched, ${insertResult.inserted} inserted, ${totalSkipped} already existed`)
}

main().catch((err) => {
  console.error('[NIHFundingScan] Unhandled error:', err)
  process.exit(1)
})
