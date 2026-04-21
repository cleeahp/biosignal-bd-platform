/**
 * News article ↔ companies_directory matcher.
 *
 * Given an article title, returns all directory companies whose name
 * appears in the title under one of three matching layers:
 *   1. Exact directory name (word-boundary, case-insensitive)
 *   2. Directory name with corporate suffixes stripped (Inc, LLC, …)
 *   3. Layer-2 form with common life-science suffixes also stripped
 *      (Pharmaceuticals, Therapeutics, Biotech, …)
 *
 * Each directory company contributes at most one entry to the result.
 * Build the matcher once at startup via `buildNewsMatcher(companyNames)`
 * and reuse its returned `match(title)` function per article.
 */

const CORPORATE_SUFFIX_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i

// Ordered longer-first so e.g. "Biosciences" matches before "Bio".
const LIFESCI_SUFFIX_RE = /[,.]?\s*\b(Biopharmaceuticals?|Biopharmaceutical|Biopharma|Biosciences?|Bioscience|Biotech|Biologics?|Biologic|Pharmaceuticals?|Pharmaceutical|Pharma|Genomics|Analytical\s+Laboratories|Laboratories|Laboratory|Healthcare|Diagnostics|Scientific|Technologies|Technology|Therapeutics?|Therapeutic|Sciences?|Solutions|Products?|Medical|Science|Health|Group|Bio)\s*$/i

function stripSuffix(name, re) {
  let s = name
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(re, '')
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
 * Build a regex that matches `needle` only at the start of the haystack,
 * with a trailing non-alphanumeric boundary. Case-insensitive.
 * Used by Layer 3 to avoid false positives from short life-sci-stripped names.
 */
function startAnchoredRegex(needle) {
  return new RegExp(`^${escapeRegex(needle)}(?![A-Za-z0-9])`, 'i')
}

/**
 * Build a reusable matcher from a list of directory company names.
 *
 * @param {string[]} companyNames
 * @returns {{ match: (title: string) => string[], size: number }}
 */
export function buildNewsMatcher(companyNames) {
  const entries = []
  const seen = new Set()

  for (const raw of companyNames) {
    if (!raw) continue
    const original = String(raw).trim()
    if (!original) continue

    // Dedup by lowercased original to avoid double-matching the same name
    const key = original.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const level2 = stripSuffix(original, CORPORATE_SUFFIX_RE)
    const level3 = stripSuffix(level2, LIFESCI_SUFFIX_RE)

    const layers = []
    if (original.length >= 3) layers.push(boundaryRegex(original))
    if (
      level2 &&
      level2.length >= 3 &&
      level2.toLowerCase() !== original.toLowerCase()
    ) {
      layers.push(boundaryRegex(level2))
    }
    if (
      level3 &&
      level3.length >= 4 &&
      level3.toLowerCase() !== level2.toLowerCase() &&
      level3.toLowerCase() !== original.toLowerCase()
    ) {
      layers.push(startAnchoredRegex(level3))
    }

    if (layers.length === 0) continue
    entries.push({ original, layers })
  }

  function match(title) {
    if (!title) return []
    const matched = []
    for (const entry of entries) {
      for (const re of entry.layers) {
        if (re.test(title)) {
          matched.push(entry.original)
          break
        }
      }
    }
    return matched
  }

  return { match, size: entries.length }
}
