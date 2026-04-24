/**
 * News article ↔ companies_directory matcher.
 *
 * Given an article title, returns directory_name values for companies whose
 * name (or alternate name) appears in the title under one of three layers:
 *   1. Exact directory name
 *   2. Alternate name from companies_alternate_names
 *   3. Directory name with corporate + life-science suffixes stripped
 *
 * Each directory_name appears at most once in the result (deduplicated).
 * Build the matcher once at startup via `buildNewsMatcher(companyNames, alternateNames)`
 * and reuse its returned `match(title)` function per article.
 *
 * Implementation note: the directory is huge (~200k rows). Pre-compiling a
 * regex per company OOMs the heap, so this matcher uses plain string
 * `indexOf` plus a manual word-boundary check, with a first-word inverted
 * index that reduces per-title work from O(N companies) to O(title words ×
 * companies-with-matching-first-word).
 */

const CORPORATE_SUFFIX_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i

// Common life-science terms that are too generic to stand alone as matchable
// needles once corporate suffixes are stripped. If a company name reduces to
// one of these (e.g. "Biosciences LLC" → "Biosciences"), skip Layer 3.
const LIFE_SCIENCE_TERMS = new Set([
  'life sciences', 'lifesciences', 'biosciences', 'therapeutics',
  'pharmaceuticals', 'biopharmaceuticals', 'biotech', 'biotechnology',
  'bio', 'pharma', 'pharmaceutical', 'genomics', 'diagnostics',
  'medical', 'health', 'healthcare', 'scientific', 'biopharma',
  'biologic', 'biologics', 'solutions', 'technologies', 'technology',
  'sciences', 'laboratories',
])

// Strip a trailing life-science suffix (longest-first alternation) so names
// like "Acme Therapeutics" or "Vertex Pharmaceuticals" also match as "Acme"
// or "Vertex" in Layer 3.
const LIFE_SCIENCE_SUFFIX_RE = /[,.]?\s*\b(life\s+sciences|biopharmaceuticals|pharmaceuticals|biotechnology|laboratories|therapeutics|technologies|diagnostics|biosciences|lifesciences|pharmaceutical|healthcare|scientific|technology|biopharma|solutions|biologics|genomics|sciences|biologic|medical|biotech|pharma|health|bio)\s*$/i

function stripCorporateSuffix(name) {
  let s = name
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(CORPORATE_SUFFIX_RE, '')
    if (s === prev) break
  }
  return s.replace(/[,.\s]+$/, '').trim()
}

function stripLifeScienceSuffix(name) {
  let s = name
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(LIFE_SCIENCE_SUFFIX_RE, '')
    if (s === prev) break
  }
  return s.replace(/[,.\s]+$/, '').trim()
}

/**
 * Is character `c` alphanumeric (ASCII)? Cheap lookup for word-boundary check.
 */
function isAlnum(c) {
  if (!c) return false
  const code = c.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||   // 0-9
    (code >= 65 && code <= 90) ||   // A-Z
    (code >= 97 && code <= 122)     // a-z
  )
}

/**
 * True if the substring at text[matchIndex..matchIndex+matchLength] is
 * flanked by non-alphanumeric characters (or string boundaries).
 */
function hasWordBoundary(text, matchIndex, matchLength) {
  const before = matchIndex === 0 ? true : !isAlnum(text[matchIndex - 1])
  const endIdx = matchIndex + matchLength
  const after = endIdx >= text.length ? true : !isAlnum(text[endIdx])
  return before && after
}

/**
 * Extract the first alphanumeric word from `s` (lowercased).
 * Returns null if no alphanumeric run exists.
 */
function firstWordOf(s) {
  const m = s.match(/[a-z0-9]+/i)
  return m ? m[0].toLowerCase() : null
}

/**
 * Extract all distinct alphanumeric words (lowercased) from `s` as a Set.
 */
function wordSet(s) {
  const out = new Set()
  const re = /[a-z0-9]+/gi
  let m
  while ((m = re.exec(s)) !== null) {
    out.add(m[0].toLowerCase())
  }
  return out
}

/**
 * Build a reusable matcher.
 *
 * @param {string[]} companyNames  Names from companies_directory
 * @param {Array<{alternate_name: string, directory_name: string}>} alternateNames
 * @returns {{ match: (title: string) => string[], size: number }}
 */
export function buildNewsMatcher(companyNames, alternateNames = []) {
  // entries: { needleLower, directoryName, firstWord }
  const entries = []
  const seen = new Set()

  function addEntry(needle, directoryName) {
    if (!needle || !directoryName) return
    const n = String(needle).trim()
    if (n.length < 3) return
    const lower = n.toLowerCase()
    const dedupKey = `${lower}${directoryName.toLowerCase()}`
    if (seen.has(dedupKey)) return
    seen.add(dedupKey)
    const firstWord = firstWordOf(lower)
    if (!firstWord) return
    entries.push({ needleLower: lower, directoryName, firstWord })
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

  // Layer 3: suffix-stripped directory names (corporate + life-science)
  // Skip when the remaining name is itself a generic life-science term
  // (e.g. "Biosciences LLC" → "Biosciences" → skipped).
  for (const raw of companyNames || []) {
    if (!raw) continue
    const original = String(raw).trim()
    if (!original) continue

    const corpStripped = stripCorporateSuffix(original)
    if (!corpStripped) continue
    if (LIFE_SCIENCE_TERMS.has(corpStripped.toLowerCase())) continue

    const fullStripped = stripLifeScienceSuffix(corpStripped)
    if (!fullStripped || fullStripped.length < 3) continue
    if (LIFE_SCIENCE_TERMS.has(fullStripped.toLowerCase())) continue
    if (fullStripped.toLowerCase() === original.toLowerCase()) continue

    addEntry(fullStripped, original)
  }

  // Sort longest-first so more specific needles win when a shorter needle is
  // a prefix of a longer one. Stable sort preserves Layer 1 → 2 → 3 precedence
  // at equal lengths.
  entries.sort((a, b) => b.needleLower.length - a.needleLower.length)

  // First-word inverted index: firstWord → entries with that first word.
  // Ordering inside each bucket follows the sorted `entries` array.
  const firstWordIndex = new Map()
  for (const entry of entries) {
    let bucket = firstWordIndex.get(entry.firstWord)
    if (!bucket) {
      bucket = []
      firstWordIndex.set(entry.firstWord, bucket)
    }
    bucket.push(entry)
  }

  function match(title) {
    if (!title) return []
    const lower = title.toLowerCase()
    const titleLen = lower.length
    const titleWords = wordSet(lower)
    if (titleWords.size === 0) return []

    const seenDirs = new Set()
    const matched = []

    for (const word of titleWords) {
      const bucket = firstWordIndex.get(word)
      if (!bucket) continue
      for (const entry of bucket) {
        if (entry.needleLower.length > titleLen) continue
        const dirKey = entry.directoryName.toLowerCase()
        if (seenDirs.has(dirKey)) continue
        const idx = lower.indexOf(entry.needleLower)
        if (idx === -1) continue
        if (!hasWordBoundary(lower, idx, entry.needleLower.length)) continue
        seenDirs.add(dirKey)
        matched.push(entry.directoryName)
      }
    }
    return matched
  }

  return { match, size: entries.length }
}
