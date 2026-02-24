import { supabase } from './supabase.js'

/**
 * Fetch all rows from excluded_companies, return a Set of lowercase names.
 * Returns an empty Set on error so agents degrade gracefully.
 */
export async function loadExcludedCompanies() {
  const { data, error } = await supabase
    .from('excluded_companies')
    .select('name')

  if (error) {
    console.warn('[companyExclusion] Failed to load excluded companies:', error.message)
    return new Set()
  }

  return new Set((data || []).map(r => r.name.toLowerCase().trim()))
}

// Strip common legal suffixes to normalize company names before comparison
function stripSuffix(name) {
  return name
    .replace(/,?\s+(Inc\.?|Corp\.?|LLC\.?|LP\.?|L\.P\.?|Ltd\.?|B\.V\.?|GmbH|Co\.|plc)\.?\s*$/i, '')
    .trim()
    .toLowerCase()
}

/**
 * Fuzzy-match companyName against the excluded set.
 * Strips legal suffixes from both sides, then checks if either string
 * starts with the other (handles "AstraZeneca" vs "AstraZeneca PLC" etc.).
 *
 * @param {string} companyName
 * @param {Set<string>} excludedSet  — returned by loadExcludedCompanies()
 * @returns {boolean}
 */
export function isExcludedCompany(companyName, excludedSet) {
  if (!companyName || !excludedSet || excludedSet.size === 0) return false

  const normalized = stripSuffix(companyName)
  if (!normalized) return false

  for (const excluded of excludedSet) {
    const normalizedExcluded = stripSuffix(excluded)
    if (!normalizedExcluded) continue
    if (normalized.startsWith(normalizedExcluded) || normalizedExcluded.startsWith(normalized)) {
      return true
    }
  }

  return false
}
