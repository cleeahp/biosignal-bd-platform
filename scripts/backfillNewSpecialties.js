/**
 * Backfill new specialties: Talent Acquisition + AI/ML (one-time)
 *
 * Re-runs the current specialty matcher (lib/specialtyMatcher.js) against every
 * job_title in clay_jobs and clay_jobs_competitors. For rows where the matcher
 * now returns "Talent Acquisition" or "AI/ML" (newly added rules), those
 * specialties are merged into the row's existing specialty array — existing
 * specialties are never removed or overwritten, only added to and deduped.
 *
 * Titles present in job_title_overrides are skipped entirely so manual user
 * edits are preserved.
 *
 * Run directly (do not commit, do not import elsewhere):
 *   node scripts/backfillNewSpecialties.js
 */

import { createClient } from '@supabase/supabase-js'
import { matchSpecialties, cleanJobTitle } from '../lib/specialtyMatcher.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[BackfillNewSpecialties] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const TABLES = ['clay_jobs', 'clay_jobs_competitors']
const NEW_SPECIALTIES = new Set(['Talent Acquisition', 'AI/ML'])

async function loadOverrideTitles() {
  const titles = new Set()
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('job_title_overrides')
      .select('job_title_lower')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`job_title_overrides: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.job_title_lower) titles.add(row.job_title_lower.trim())
    }
    offset += PAGE
  }
  return titles
}

async function loadRows(table) {
  const rows = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, job_title, specialty')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

async function backfillTable(table, overrideTitles) {
  const rows = await loadRows(table)
  let updated = 0
  let skippedOverride = 0
  let failed = 0

  for (const row of rows) {
    const titleKey = cleanJobTitle(row.job_title).trim()
    if (titleKey && overrideTitles.has(titleKey)) {
      skippedOverride++
      continue
    }

    const matched = matchSpecialties(row.job_title)
    const newAdds = matched.filter(s => NEW_SPECIALTIES.has(s))
    if (newAdds.length === 0) continue

    const existing = Array.isArray(row.specialty) ? row.specialty : []
    const merged = [...new Set([...existing, ...newAdds])]
    if (merged.length === existing.length) continue

    const { error } = await supabase.from(table).update({ specialty: merged }).eq('id', row.id)
    if (error) {
      failed++
      console.error(`  [${table}] update failed for id=${row.id}: ${error.message}`)
      continue
    }
    updated++
  }

  console.log(`[${table}] scanned=${rows.length} updated=${updated} skippedOverride=${skippedOverride} failed=${failed}`)
  return updated
}

async function main() {
  console.log('[BackfillNewSpecialties] Loading job_title_overrides…')
  const overrideTitles = await loadOverrideTitles()
  console.log(`[BackfillNewSpecialties] Indexed ${overrideTitles.size} override titles.`)

  for (const table of TABLES) {
    await backfillTable(table, overrideTitles)
  }

  console.log('[BackfillNewSpecialties] Done.')
}

main().catch((e) => {
  console.error('[BackfillNewSpecialties] Fatal:', e.message)
  process.exit(1)
})
