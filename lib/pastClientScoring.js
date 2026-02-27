import { supabase } from './supabase.js'

const LEGAL_SUFFIXES_RE = /[,.]?\s*(inc\.?|incorporated|corp\.?|corporation|llc\.?|ltd\.?|limited|lp\.?|b\.?v\.?|plc\.?|gmbh|co\.?|s\.?a\.?)$/i

const INDUSTRY_SUFFIXES_RE = /\s+(pharmaceuticals|therapeutics|pharma|biosciences|bio|biopharmaceuticals|clinical\s+research|sciences|medical|health|healthcare|solutions|group|technologies|diagnostics)$/i

/**
 * Strip legal and industry suffixes, returning a clean lowercase name.
 */
function stripAllSuffixes(name) {
  let s = name.toLowerCase().trim()
  // Strip legal suffixes first (may need multiple passes for "Inc." after "Therapeutics, Inc.")
  s = s.replace(LEGAL_SUFFIXES_RE, '').trim()
  // Strip trailing commas/periods left behind
  s = s.replace(/[,.\s]+$/, '').trim()
  // Strip industry suffixes
  s = s.replace(INDUSTRY_SUFFIXES_RE, '').trim()
  s = s.replace(/[,.\s]+$/, '').trim()
  return s
}

/**
 * Extract core keywords from a company name after stripping all suffixes.
 */
function extractCoreKeywords(name) {
  const stripped = stripAllSuffixes(name)
  if (!stripped) return []
  return stripped.split(/\s+/).filter(w => w.length > 0)
}

/**
 * Load all active past clients from Supabase.
 * Returns a Map keyed by lowercase trimmed name → { name, priority_rank, boost_score, coreKeywords }
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
    const coreKeywords = extractCoreKeywords(row.name)
    const entry = { name: row.name, priority_rank: row.priority_rank, boost_score, coreKeywords }
    map.set(row.name.toLowerCase().trim(), entry)
  }
  return map
}

/**
 * Check if all words from `keywords` appear in `targetWords` set or as substrings
 * respecting word-boundary rules for short words.
 */
function keywordsMatch(clientKeywords, signalKeywords, signalStripped) {
  if (!clientKeywords.length || !signalKeywords.length) return false

  for (const kw of clientKeywords) {
    if (kw.length <= 4) {
      // Short words: require word-boundary match to avoid "Rho" matching "Rhonda"
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i')
      if (!re.test(signalStripped)) return false
    } else {
      // Longer words: check if present in signal keywords
      if (!signalKeywords.includes(kw)) return false
    }
  }
  return true
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a company name against the past clients map using keyword-based fuzzy matching.
 *
 * Match priority:
 *   1. Exact match (raw lowercase key in map)
 *   2. Exact stripped match (all suffixes removed, strings equal)
 *   3. Keyword match: all core keywords of client appear in signal name, or vice versa
 *      - Single-word cores: that word appears anywhere in the signal name
 *      - Multi-word cores: all words must appear
 *      - Short words (<=4 chars): word-boundary matching to avoid false positives
 *
 * @param {string} companyName
 * @param {Map} pastClientsMap
 * @returns {{ name, priority_rank, boost_score }|null}
 */
export function matchPastClient(companyName, pastClientsMap) {
  if (!companyName || !pastClientsMap?.size) return null

  // 1. Exact lowercase match
  const lc = companyName.toLowerCase().trim()
  if (pastClientsMap.has(lc)) return pastClientsMap.get(lc)

  const signalStripped = stripAllSuffixes(companyName)
  const signalKeywords = extractCoreKeywords(companyName)

  // 2. Exact stripped match
  for (const [, entry] of pastClientsMap) {
    const clientStripped = stripAllSuffixes(entry.name)
    if (signalStripped && clientStripped && signalStripped === clientStripped) return entry
  }

  // 3. Keyword match
  if (!signalStripped || !signalKeywords.length) return null

  for (const [, entry] of pastClientsMap) {
    const ck = entry.coreKeywords
    if (!ck || !ck.length) continue

    // Check if all client keywords appear in signal name
    if (keywordsMatch(ck, signalKeywords, signalStripped)) return entry
    // Check reverse: all signal keywords appear in client name
    const clientStripped = stripAllSuffixes(entry.name)
    if (keywordsMatch(signalKeywords, ck, clientStripped)) return entry
  }

  return null
}
