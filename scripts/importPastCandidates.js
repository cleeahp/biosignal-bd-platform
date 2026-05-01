/**
 * One-time import of past_candidates from supabase/tables/past_candidates.csv.
 *
 * Clears the table and bulk-inserts all rows with the new schema:
 *   person_name, linkedin_url, original_title, original_company,
 *   email, phone, current_title, current_company, current_location
 *
 * The CSV's first_name / last_name / name columns are ignored.
 *
 * Run: node --env-file=.env.local scripts/importPastCandidates.js
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
  console.error('[importPastCandidates] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSV_PATH = resolve(__dirname, '..', 'supabase', 'tables', 'past_candidates.csv')
const BATCH_SIZE = 100

const FIELDS = [
  'person_name',
  'linkedin_url',
  'original_title',
  'original_company',
  'email',
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
  console.log(`[importPastCandidates] Reading ${CSV_PATH}`)
  const raw = readFileSync(CSV_PATH, 'utf8')
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  })
  console.log(`[importPastCandidates] Parsed ${records.length} rows from CSV`)

  const rows = records.map(rec => {
    const out = {}
    for (const field of FIELDS) out[field] = normalize(rec[field])
    return out
  })

  console.log('[importPastCandidates] Clearing existing past_candidates rows...')
  const { error: deleteErr } = await supabase
    .from('past_candidates')
    .delete()
    .not('id', 'is', null)
  if (deleteErr) {
    console.error('[importPastCandidates] Failed to clear table:', deleteErr.message)
    process.exit(1)
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error: insertErr, data } = await supabase
      .from('past_candidates')
      .insert(batch)
      .select('id')
    if (insertErr) {
      console.error(`[importPastCandidates] Batch ${i / BATCH_SIZE + 1} failed:`, insertErr.message)
      process.exit(1)
    }
    inserted += data.length
    console.log(`[importPastCandidates] Batch ${i / BATCH_SIZE + 1}: inserted ${data.length} rows (total ${inserted}/${rows.length})`)
  }

  console.log(`[importPastCandidates] Done. ${inserted} rows inserted.`)
}

main().catch(err => {
  console.error('[importPastCandidates] Fatal error:', err)
  process.exit(1)
})
