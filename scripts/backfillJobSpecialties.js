/**
 * One-time backfill of `specialty` for clay_jobs and clay_jobs_competitors.
 *
 * Loads job_title_overrides and applies matchSpecialties() to each row missing
 * a specialty, updating in batches.
 *
 * Run: node scripts/backfillJobSpecialties.js
 *      (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be in environment)
 */

import { createClient } from '@supabase/supabase-js'
import { matchSpecialties } from '../lib/specialtyMatcher.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[BackfillSpecialties] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const PAGE = 1000

async function loadOverrides() {
  const overrides = new Map()
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('job_title_overrides')
      .select('job_title_lower, specialty')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`job_title_overrides: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.job_title_lower) overrides.set(row.job_title_lower.trim(), row.specialty || [])
    }
    offset += PAGE
  }
  return overrides
}

async function backfillTable(table, overrides) {
  let total = 0
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, job_title')
      .is('specialty', null)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table} select: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data) {
      const specialty = matchSpecialties(row.job_title, overrides)
      const { error: upErr } = await supabase
        .from(table)
        .update({ specialty })
        .eq('id', row.id)
      if (upErr) {
        console.error(`[BackfillSpecialties] ${table} update ${row.id}: ${upErr.message}`)
        continue
      }
      total += 1
    }

    if (data.length < PAGE) break
  }
  return total
}

async function main() {
  const overrides = await loadOverrides()
  const jobsCount = await backfillTable('clay_jobs', overrides)
  const competitorCount = await backfillTable('clay_jobs_competitors', overrides)
  console.log(`[BackfillSpecialties] clay_jobs: ${jobsCount} updated, clay_jobs_competitors: ${competitorCount} updated`)
}

main().catch(err => {
  console.error(`[BackfillSpecialties] Fatal: ${err.message}`)
  process.exit(1)
})
