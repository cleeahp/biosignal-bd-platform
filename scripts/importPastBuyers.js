/**
 * One-time import of past_buyers from supabase/tables/past_buyers.csv.
 *
 * Clears the table and bulk-inserts all rows with the new schema:
 *   person_name, linkedin_url, original_title, original_company,
 *   original_email, phone, current_title, current_company, current_location
 *
 * Run: node --env-file=.env.local scripts/importPastBuyers.js
 *      (or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment)
 */

import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[importPastBuyers] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSV_PATH = resolve(__dirname, '..', 'supabase', 'tables', 'past_buyers.csv')
const BATCH_SIZE = 100

const FIELDS = [
  'person_name',
  'linkedin_url',
  'original_title',
  'original_company',
  'original_email',
  'phone',
  'current_title',
  'current_company',
  'current_location',
]

function normalize(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

async function main() {
  console.log(`[importPastBuyers] Reading ${CSV_PATH}`)
  const raw = readFileSync(CSV_PATH, 'utf8')
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  })
  console.log(`[importPastBuyers] Parsed ${records.length} rows from CSV`)

  const rows = records.map(rec => {
    const out = {}
    for (const field of FIELDS) out[field] = normalize(rec[field])
    return out
  })

  console.log('[importPastBuyers] Clearing existing past_buyers rows...')
  const { error: deleteErr } = await supabase
    .from('past_buyers')
    .delete()
    .not('id', 'is', null)
  if (deleteErr) {
    console.error('[importPastBuyers] Failed to clear table:', deleteErr.message)
    process.exit(1)
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error: insertErr, data } = await supabase
      .from('past_buyers')
      .insert(batch)
      .select('id')
    if (insertErr) {
      console.error(`[importPastBuyers] Batch ${i / BATCH_SIZE + 1} failed:`, insertErr.message)
      process.exit(1)
    }
    inserted += data.length
    console.log(`[importPastBuyers] Batch ${i / BATCH_SIZE + 1}: inserted ${data.length} rows (total ${inserted}/${rows.length})`)
  }

  console.log(`[importPastBuyers] Done. ${inserted} rows inserted.`)
}

main().catch(err => {
  console.error('[importPastBuyers] Fatal error:', err)
  process.exit(1)
})
