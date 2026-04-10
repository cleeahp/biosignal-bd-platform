import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse'
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CSV_PATH = path.resolve(__dirname, '../supabase/tables/companies_table.csv')
const TABLE = 'companies_directory'

// Fetch all existing company names from the table
async function fetchExistingNames() {
  const names = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('name')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`Error fetching existing names: ${error.message}`)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      names.add(row.name.trim().toLowerCase())
    }
    offset += PAGE
  }

  return names
}

// Parse CSV, deduplicate by lowercase trimmed name
function parseCSV() {
  return new Promise((resolve, reject) => {
    const seen = new Map()
    let dupes = 0

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

      const key = name.toLowerCase()
      if (seen.has(key)) {
        dupes++
        return
      }

      seen.set(key, {
        name,
        primary_industry: row['Primary Industry']?.trim() || null,
        company_size: row['Size']?.trim() || null,
        company_type: row['Type']?.trim() || null,
        location: row['Location']?.trim() || null,
        domain: row['Domain']?.trim() || null,
        linkedin_url: row['LinkedIn URL']?.trim() || null,
      })
    })

    parser.on('end', () => {
      const records = [...seen.values()]
      console.log(`Parsed ${records.length} unique companies from CSV (${dupes} CSV duplicates skipped)`)
      resolve(records)
    })
    parser.on('error', reject)
  })
}

// Insert only new records in batches
async function importNewRecords(records) {
  const BATCH = 500
  let inserted = 0
  let errors = 0

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)

    const { error } = await supabase.from(TABLE).insert(batch)

    if (error) {
      // Batch failed — try one by one
      for (const record of batch) {
        const { error: rowErr } = await supabase.from(TABLE).insert(record)
        if (rowErr) {
          console.error(`Error inserting "${record.name}": ${rowErr.message}`)
          errors++
        } else {
          inserted++
        }
      }
    } else {
      inserted += batch.length
    }

    const processed = Math.min(i + BATCH, records.length)
    if (processed % 2000 === 0 || processed === records.length) {
      console.log(`Progress: ${processed}/${records.length} new companies (inserted: ${inserted}, errors: ${errors})`)
    }
  }

  return { inserted, errors }
}

async function main() {
  console.log('=== Companies Directory Import ===\n')

  // Verify table exists
  const { error: checkErr } = await supabase.from(TABLE).select('id').limit(1)
  if (checkErr) {
    console.error(`Table "${TABLE}" not accessible: ${checkErr.message}`)
    process.exit(1)
  }

  // Fetch existing names
  console.log('Fetching existing companies from database...')
  const existingNames = await fetchExistingNames()
  console.log(`Found ${existingNames.size} existing companies in database.\n`)

  // Parse CSV
  const allRecords = await parseCSV()

  // Filter to only new companies
  const newRecords = allRecords.filter(r => !existingNames.has(r.name.trim().toLowerCase()))
  const skipped = allRecords.length - newRecords.length

  console.log(`\nSkipped: ${skipped} (already exist in database)`)
  console.log(`New:     ${newRecords.length}\n`)

  if (newRecords.length === 0) {
    console.log('Nothing to import — all companies already exist.')
    return
  }

  // Insert new records
  console.log(`Inserting ${newRecords.length} new companies...\n`)
  const { inserted, errors } = await importNewRecords(newRecords)

  console.log('\n=== Import Complete ===')
  console.log(`New companies added: ${inserted}`)
  console.log(`Already existed:     ${skipped}`)
  console.log(`Errors:              ${errors}`)
  console.log(`Total in CSV:        ${allRecords.length}`)
}

main().catch(console.error)
