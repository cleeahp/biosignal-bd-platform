/**
 * Import New Companies (one-time)
 *
 * Imports rows from supabase/tables/companies_table.csv into the
 * companies_directory table. Deduplicates by the (name, linkedin_url) pair:
 * a CSV row is considered a duplicate only when both name AND normalized
 * LinkedIn URL already exist as a pair in the directory. Same name with a
 * different URL (or vice versa) is treated as a new entry.
 *
 * Usage:
 *   node scripts/importNewCompanies.js
 */

import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse'
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[ImportCompanies] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CSV_PATH = path.resolve(__dirname, '../supabase/tables/companies_table.csv')
const TABLE = 'companies_directory'

// Normalize a LinkedIn URL for dedup comparison
function normalizeLinkedInUrl(url) {
  if (!url) return ''
  return url.trim().toLowerCase().replace(/\/$/, '')
}

function makeKey(name, linkedinUrl) {
  return `${(name || '').trim().toLowerCase()}|${normalizeLinkedInUrl(linkedinUrl)}`
}

// Probe a single column by attempting select('<col>').limit(1)
async function columnExists(col) {
  const { error } = await supabase.from(TABLE).select(col).limit(1)
  return !error
}

async function detectOptionalColumns() {
  const [hasLocation, hasCountry, hasCompanyType] = await Promise.all([
    columnExists('location'),
    columnExists('country'),
    columnExists('company_type'),
  ])
  return { hasLocation, hasCountry, hasCompanyType }
}

// Load ALL (name_lower, linkedin_url_normalized) pairs from the directory
async function loadExistingKeys() {
  const keys = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('name, linkedin_url')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[ImportCompanies] Error loading directory: ${error.message}`)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      keys.add(makeKey(row.name, row.linkedin_url))
    }
    offset += PAGE
  }

  return keys
}

// Parse CSV and produce records. Dedup within CSV by (name, linkedin_url) key.
function parseCSV(optionalCols) {
  return new Promise((resolve, reject) => {
    const records = []
    const seenInCsv = new Set()
    let csvDupes = 0

    const parser = createReadStream(CSV_PATH).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      })
    )

    parser.on('data', (row) => {
      const name = row['Name']?.trim()
      if (!name) return

      const linkedinUrl = row['LinkedIn URL']?.trim() || null
      const key = makeKey(name, linkedinUrl)

      if (seenInCsv.has(key)) {
        csvDupes++
        return
      }
      seenInCsv.add(key)

      const record = {
        name,
        primary_industry: row['Primary Industry']?.trim() || null,
        company_size: row['Size']?.trim() || null,
        domain: row['Domain']?.trim() || null,
        linkedin_url: linkedinUrl,
      }
      if (optionalCols.hasLocation) record.location = row['Location']?.trim() || null
      if (optionalCols.hasCountry) record.country = row['Country']?.trim() || null
      if (optionalCols.hasCompanyType) record.company_type = row['Type']?.trim() || null

      records.push({ key, record })
    })

    parser.on('end', () => resolve({ records, csvDupes }))
    parser.on('error', reject)
  })
}

async function insertBatch(records) {
  const BATCH = 500
  let inserted = 0
  let errors = 0

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)
    const { error } = await supabase.from(TABLE).insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from(TABLE).insert(row)
        if (rowErr) {
          console.error(`[ImportCompanies] Insert error for "${row.name}": ${rowErr.message}`)
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

async function main() {
  // Verify required column linkedin_url exists
  if (!(await columnExists('linkedin_url'))) {
    console.error('[ImportCompanies] Missing linkedin_url column. Run:')
    console.error('  ALTER TABLE companies_directory ADD COLUMN linkedin_url text;')
    process.exit(1)
  }

  const optionalCols = await detectOptionalColumns()

  const existingKeys = await loadExistingKeys()
  console.log(`[ImportCompanies] Loaded ${existingKeys.size} existing companies from directory`)

  const { records, csvDupes } = await parseCSV(optionalCols)
  console.log(`[ImportCompanies] Parsed ${records.length + csvDupes} companies from CSV`)

  const toInsert = []
  let alreadyExists = 0
  for (const { key, record } of records) {
    if (existingKeys.has(key)) {
      alreadyExists++
      continue
    }
    existingKeys.add(key)
    toInsert.push(record)
  }

  console.log(`[ImportCompanies] ${toInsert.length} new companies to insert, ${alreadyExists} already exist, ${csvDupes} CSV duplicates skipped`)

  if (toInsert.length === 0) {
    console.log('[ImportCompanies] Inserted: 0, Errors: 0')
    return
  }

  const { inserted, errors } = await insertBatch(toInsert)
  console.log(`[ImportCompanies] Inserted: ${inserted}, Errors: ${errors}`)
}

main().catch((err) => {
  console.error('[ImportCompanies] Unhandled error:', err)
  process.exit(1)
})
