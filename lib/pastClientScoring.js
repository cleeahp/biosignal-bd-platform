import { supabase } from './supabase.js'

/**
 * Load all active past clients from Supabase.
 * Returns a Map keyed by lowercase trimmed name → { name, priority_rank, boost_score }
 *
 * Boost formula:
 *   Ranks 1-18 (priority clients): linear +15 to +10
 *     boost_score = Math.round(15 - ((rank - 1) / 17) * 5)
 *   Rank 19+ (historical clients): flat +8
 */
export async function loadPastClients() {
  const { data, error } = await supabase
    .from('past_clients')
    .select('name, priority_rank')
    .eq('is_active', true)
    .order('priority_rank')

  if (error) {
    console.warn('[PastClients] Failed to load:', error.message)
    return new Map()
  }

  const map = new Map()
  for (const row of data || []) {
    const boost_score = row.priority_rank <= 18
      ? Math.round(15 - ((row.priority_rank - 1) / 17) * 5)
      : 8
    const entry = { name: row.name, priority_rank: row.priority_rank, boost_score }
    map.set(row.name.toLowerCase().trim(), entry)
  }
  return map
}

/**
 * Strip common legal suffixes from a company name for fuzzy matching.
 * @param {string} name
 * @returns {string} normalized lowercase name without suffix
 */
function stripSuffixes(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[,.]?\s*(inc\.?|incorporated|corp\.?|corporation|llc\.?|ltd\.?|limited|lp\.?|b\.?v\.?|plc\.?|gmbh|co\.)$/i, '')
    .trim()
}

/**
 * Match a company name against the past clients map using fuzzy suffix-stripped comparison.
 * Also checks if either stripped name starts with the other.
 *
 * @param {string} companyName
 * @param {Map} pastClientsMap
 * @returns {{ name, priority_rank, boost_score }|null}
 */
export function matchPastClient(companyName, pastClientsMap) {
  if (!companyName || !pastClientsMap?.size) return null

  // Exact lowercase match
  const lc = companyName.toLowerCase().trim()
  if (pastClientsMap.has(lc)) return pastClientsMap.get(lc)

  // Suffix-stripped match
  const strippedInput = stripSuffixes(companyName)
  for (const [key, value] of pastClientsMap) {
    const strippedKey = stripSuffixes(key)
    if (strippedInput && strippedKey && strippedInput === strippedKey) return value
    // Prefix match: e.g. "Exelixis" matches "Exelixis, Inc."
    if (strippedInput && strippedKey && (
      strippedInput.startsWith(strippedKey) || strippedKey.startsWith(strippedInput)
    )) return value
  }

  return null
}
