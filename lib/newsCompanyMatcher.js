/**
 * News article ↔ companies_directory matcher.
 *
 * Given an article title, returns directory_name values for companies whose
 * name (or alternate name) appears in the title under one of three layers:
 *   1. Exact directory name (word-boundary, case-insensitive)
 *   2. Alternate name from companies_alternate_names (word-boundary, case-insensitive)
 *   3. Directory name with corporate suffixes stripped (Inc, LLC, …)
 *
 * Each directory_name appears at most once in the result (deduplicated).
 * Build the matcher once at startup via `buildNewsMatcher(companyNames, alternateNames)`
 * and reuse its returned `match(title)` function per article.
 */

const CORPORATE_SUFFIX_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i

function stripCorporateSuffix(name) {
  let s = name
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(CORPORATE_SUFFIX_RE, '')
    if (s === prev) break
  }
  return s.replace(/[,.\s]+$/, '').trim()
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a regex that matches `needle` in a haystack only when it's not
 * surrounded by alphanumeric characters. Case-insensitive.
 */
function boundaryRegex(needle) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(needle)}(?![A-Za-z0-9])`, 'i')
}

/**
 * Build a reusable matcher.
 *
 * @param {string[]} companyNames  Names from companies_directory
 * @param {Array<{alternate_name: string, directory_name: string}>} alternateNames
 * @returns {{ match: (title: string) => string[], size: number }}
 */
export function buildNewsMatcher(companyNames, alternateNames = []) {
  const entries = []
  const seenNeedles = new Set()

  function addEntry(needle, directoryName) {
    if (!needle || !directoryName) return
    const n = String(needle).trim()
    if (n.length < 3) return
    const key = `${n.toLowerCase()}→${directoryName.toLowerCase()}`
    if (seenNeedles.has(key)) return
    seenNeedles.add(key)
    entries.push({ directoryName, regex: boundaryRegex(n) })
  }

  // Layer 1: exact directory names
  for (const raw of companyNames || []) {
    if (!raw) continue
    const name = String(raw).trim()
    if (!name) continue
    addEntry(name, name)
  }

  // Layer 2: alternate names → directory_name
  for (const row of alternateNames || []) {
    if (!row) continue
    const alt = row.alternate_name ? String(row.alternate_name).trim() : ''
    const dir = row.directory_name ? String(row.directory_name).trim() : ''
    if (!alt || !dir) continue
    addEntry(alt, dir)
  }

  // Layer 3: corporate-suffix-stripped directory names
  for (const raw of companyNames || []) {
    if (!raw) continue
    const original = String(raw).trim()
    if (!original) continue
    const stripped = stripCorporateSuffix(original)
    if (!stripped || stripped.length < 3) continue
    if (stripped.toLowerCase() === original.toLowerCase()) continue
    addEntry(stripped, original)
  }

  function match(title) {
    if (!title) return []
    const matched = []
    const seenDirs = new Set()
    for (const entry of entries) {
      if (seenDirs.has(entry.directoryName.toLowerCase())) continue
      if (entry.regex.test(title)) {
        seenDirs.add(entry.directoryName.toLowerCase())
        matched.push(entry.directoryName)
      }
    }
    return matched
  }

  return { match, size: entries.length }
}
