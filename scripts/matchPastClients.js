/**
 * Match Past Clients (one-time)
 *
 * Fills the past_clients.matched_name column by matching each past_clients.name
 * against companies_directory.name and companies_alternate_names.alternate_name
 * under four layers (first match wins):
 *   1. Exact match to companies_directory.name
 *   2. Exact match to companies_alternate_names.alternate_name
 *   3. Corporate-suffix-stripped match to companies_directory.name
 *   4. Corporate-suffix-stripped match to companies_alternate_names.alternate_name
 *
 * Usage:
 *   node scripts/matchPastClients.js
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[MatchPastClients] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Suffix stripping ────────────────────────────────────────────────────────

const CORPORATE_SUFFIX_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i

function stripCorporateSuffix(name) {
  let s = String(name || '')
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(CORPORATE_SUFFIX_RE, '')
    if (s === prev) break
  }
  return s.replace(/[,.\s]+$/, '').trim()
}

function normalizeKey(name) {
  return String(name || '').trim().toLowerCase()
}

function strippedKey(name) {
  return stripCorporateSuffix(name).toLowerCase()
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadAll(table, columns) {
  const rows = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[MatchPastClients] Loading past_clients, companies_directory, companies_alternate_names...')

  const [pastClients, directory, alternateNames] = await Promise.all([
    loadAll('past_clients', 'id, name'),
    loadAll('companies_directory', 'name'),
    loadAll('companies_alternate_names', 'alternate_name, directory_name'),
  ])

  console.log(`[MatchPastClients] Loaded ${pastClients.length} past clients, ${directory.length} directory companies, ${alternateNames.length} alternate names`)

  // Build lookup maps. Later entries will overwrite earlier ones on collision;
  // that's fine — all collisions point to the same canonical directory name.
  const dirExactByKey = new Map()      // lowercased trimmed name → original name
  const dirStrippedByKey = new Map()   // lowercased stripped name → original name
  for (const row of directory) {
    if (!row.name) continue
    dirExactByKey.set(normalizeKey(row.name), row.name)
    const s = strippedKey(row.name)
    if (s) dirStrippedByKey.set(s, row.name)
  }

  const altExactByKey = new Map()      // lowercased trimmed alt name → directory name
  const altStrippedByKey = new Map()   // lowercased stripped alt name → directory name
  for (const row of alternateNames) {
    if (!row.alternate_name || !row.directory_name) continue
    altExactByKey.set(normalizeKey(row.alternate_name), row.directory_name)
    const s = strippedKey(row.alternate_name)
    if (s) altStrippedByKey.set(s, row.directory_name)
  }

  let matched = 0
  let unmatched = 0

  for (const client of pastClients) {
    if (!client.name) {
      unmatched++
      continue
    }

    const key = normalizeKey(client.name)
    const stripped = strippedKey(client.name)

    let matchedName = null
    let layer = 0

    if (dirExactByKey.has(key)) {
      matchedName = dirExactByKey.get(key)
      layer = 1
    } else if (altExactByKey.has(key)) {
      matchedName = altExactByKey.get(key)
      layer = 2
    } else if (stripped && dirStrippedByKey.has(stripped)) {
      matchedName = dirStrippedByKey.get(stripped)
      layer = 3
    } else if (stripped && altStrippedByKey.has(stripped)) {
      matchedName = altStrippedByKey.get(stripped)
      layer = 4
    }

    if (matchedName) {
      const { error } = await supabase
        .from('past_clients')
        .update({ matched_name: matchedName })
        .eq('id', client.id)
      if (error) {
        console.error(`[MatchPastClients] Update error for "${client.name}": ${error.message}`)
        unmatched++
        continue
      }
      console.log(`[MatchPastClients] ${client.name} → ${matchedName} (layer ${layer})`)
      matched++
    } else {
      console.log(`[MatchPastClients] ${client.name} → NO MATCH`)
      unmatched++
    }
  }

  console.log(`[MatchPastClients] Complete: ${matched} matched, ${unmatched} unmatched out of ${pastClients.length}`)
}

main().catch((err) => {
  console.error('[MatchPastClients] Unhandled error:', err)
  process.exit(1)
})
