/**
 * checkCompanySizes.js
 *
 * Weekly script (also run manually) that checks LinkedIn company pages for
 * employee counts. Companies with 10,001+ employees are inserted into
 * the excluded_companies table and their signals are deleted.
 * Companies that drop below 10,001 are reinstated (removed from the table).
 * Past clients are never excluded regardless of size.
 *
 * Run: node --env-file=.env.local scripts/checkCompanySizes.js
 * GitHub Actions: .github/workflows/company-size-check.yml
 */

import { supabase } from '../lib/supabase.js'
import { shuffleArray } from '../lib/linkedinClient.js'
import { loadPastClients, matchPastClient } from '../lib/pastClientScoring.js'

// ── Config ────────────────────────────────────────────────────────────────────

const LINKEDIN_LI_AT = process.env.LINKEDIN_LI_AT
const MIN_EXCLUDE_COUNT = 10_001   // employeeCountRange.start >= 10001 means 10,001+ employees
const MAX_REQUESTS = 150
const BATCH_SIZE = 100   // Supabase .in() batch size

const SIGNAL_TYPES = [
  'clinical_trial_phase_transition',
  'clinical_trial_new_ind',
  'funding_new_award',
  'funding_renewal',
  'ma_transaction',
  'stale_job_posting',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** Derive a LinkedIn company slug from the company name. */
function toLinkedInSlug(name) {
  return name
    .replace(/,?\s+(Inc\.?|Corp\.?|LLC\.?|LP\.?|L\.P\.?|Ltd\.?|B\.V\.?|GmbH|Co\.|plc)\.?\s*$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

/**
 * Parse employee count from LinkedIn company page HTML.
 *
 * LinkedIn embeds employeeCountRange immediately after jobSearchUrl in the
 * page HTML (either HTML-encoded or plain JSON). The `start` field of that
 * range is the most reliable employee count available without full auth.
 *
 * start values map to LinkedIn ranges:
 *   1 → 1-10,  11 → 11-50,  51 → 51-200,  201 → 201-500,
 *   501 → 501-1000,  1001 → 1001-5000,  5001 → 5001-10000,  10001 → 10001+
 *
 * Returns null if the pattern is not found (do not exclude).
 */
function parseEmployeeCount(html) {
  const m = html.match(
    /jobSearchUrl.{0,200}?employeeCountRange.{0,50}?start(?:&quot;|")\s*(?::|&#58;)\s*(\d+)/s
  )
  if (m) return parseInt(m[1], 10)
  return null
}

/**
 * Extract the company name as shown on the LinkedIn page for slug mismatch detection.
 * Tries page title first (most reliable), then HTML-encoded JSON, then plain JSON.
 */
function extractPageCompanyName(html) {
  // Page title: "CompanyName | LinkedIn" or "CompanyName: Overview | LinkedIn"
  const titleMatch = html.match(/<title>\s*([^|<\n]{2,}?)\s*(?::\s*[^|<\n]+)?\s*\|/)
  if (titleMatch) return titleMatch[1].trim()

  // HTML-encoded JSON: &quot;name&quot;:&quot;CompanyName&quot;
  const htmlEncMatch = html.match(/&quot;name&quot;:&quot;([^&]{2,100})&quot;/)
  if (htmlEncMatch) return htmlEncMatch[1].trim()

  // Plain JSON: "name":"CompanyName"
  const jsonMatch = html.match(/"name"\s*:\s*"([^"]{2,100})"/)
  if (jsonMatch) return jsonMatch[1].trim()

  return null
}

/** Extract first significant word from a name (skip stop words like The, Inc, Corp). */
function firstSignificantWord(name) {
  if (!name) return ''
  const stop = /^(the|a|an|inc|corp|llc|ltd|lp|gmbh|co|plc|and|of|for)$/i
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)
  return words.find(w => w.length > 1 && !stop.test(w)) || words[0] || ''
}

/**
 * Return true if the page company name plausibly matches our DB company name.
 * Compares only the first significant word to catch gross slug collisions.
 */
function isSlugMatch(dbName, pageName) {
  if (!pageName) return true   // Can't determine — assume OK
  const dbFirst = firstSignificantWord(dbName)
  const pageFirst = firstSignificantWord(pageName)
  if (!dbFirst || !pageFirst) return true
  return dbFirst === pageFirst
}

/** Fetch a LinkedIn company page with rate-limit delay. */
async function fetchCompanyPage(slug, liAt, reqNum) {
  const url = `https://www.linkedin.com/company/${slug}/`
  const delay = reqNum > 0 && reqNum % 10 === 0
    ? 60_000 + Math.random() * 30_000   // 60-90s every 10 requests
    : 15_000 + Math.random() * 15_000   // 15-30s standard

  await sleep(delay)

  try {
    const res = await fetch(url, {
      headers: {
        'Cookie': `li_at=${liAt}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    })
    console.log(`[CompanySize] [${reqNum}/${MAX_REQUESTS}] GET ${url} — HTTP ${res.status}`)
    if (!res.ok) return { html: null, url }
    return { html: await res.text(), url }
  } catch (err) {
    console.log(`[CompanySize] [${reqNum}/${MAX_REQUESTS}] GET ${url} — ERROR: ${err.message}`)
    return { html: null, url }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!LINKEDIN_LI_AT) {
  console.error('[CompanySize] LINKEDIN_LI_AT not set — aborting')
  process.exit(1)
}

console.log(`[CompanySize] Starting company size check — budget: ${MAX_REQUESTS} requests`)

// Load past clients — they are never excluded regardless of size
const pastClientsMap = await loadPastClients()
console.log(`[CompanySize] Loaded ${pastClientsMap.size} past clients (protected from exclusion)`)

// Step 1: Get all distinct company IDs from relevant signals
const { data: signalRows, error: signalErr } = await supabase
  .from('signals')
  .select('company_id')
  .in('signal_type', SIGNAL_TYPES)

if (signalErr) {
  console.error('[CompanySize] Failed to query signals:', signalErr.message)
  process.exit(1)
}

const uniqueIds = [...new Set((signalRows || []).map(r => r.company_id).filter(Boolean))]
console.log(`[CompanySize] Found ${uniqueIds.length} distinct companies across signals`)

// Step 2: Get company names for those IDs (in batches)
let allCompanies = []
for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
  const batch = uniqueIds.slice(i, i + BATCH_SIZE)
  const { data } = await supabase.from('companies').select('id, name').in('id', batch)
  allCompanies = allCompanies.concat(data || [])
}

// Step 3: Get already-excluded companies.
// We check them too so we can reinstate any whose count has since dropped below 10,001.
const { data: alreadyExcludedData } = await supabase.from('excluded_companies').select('name')
const alreadyExcludedNames = new Set((alreadyExcludedData || []).map(r => r.name.toLowerCase().trim()))

// Build unified check list: all signal companies + excluded companies no longer in signals
const toCheckMap = new Map()
for (const c of allCompanies) {
  toCheckMap.set(c.name.toLowerCase().trim(), { id: c.id, name: c.name })
}
for (const row of (alreadyExcludedData || [])) {
  const key = row.name.toLowerCase().trim()
  if (!toCheckMap.has(key)) {
    toCheckMap.set(key, { id: null, name: row.name })
  }
}
const toCheck = [...toCheckMap.values()]

console.log(`[CompanySize] ${toCheck.length} companies to check (${alreadyExcludedNames.size} currently excluded)`)

// Step 4: Shuffle and check each company
const shuffled = shuffleArray([...toCheck])
let requestsUsed = 0
let checked = 0
const newlyExcluded = []
const reinstated = []

for (const company of shuffled) {
  if (requestsUsed >= MAX_REQUESTS) {
    console.log(`[CompanySize] Budget exhausted (${MAX_REQUESTS} requests)`)
    break
  }

  const isAlreadyExcluded = alreadyExcludedNames.has(company.name.toLowerCase().trim())

  const slug = toLinkedInSlug(company.name)
  const { html, url } = await fetchCompanyPage(slug, LINKEDIN_LI_AT, requestsUsed)
  requestsUsed++
  checked++

  if (!html) {
    console.log(`[CompanySize] ${company.name}: page not accessible`)
    continue
  }

  // Bot detection
  if (html.includes('authwall') || html.includes('CAPTCHA') || html.length < 500) {
    console.log(`[CompanySize] Bot detection suspected — stopping`)
    break
  }

  // Slug mismatch check — skip if the page belongs to a different company
  const pageName = extractPageCompanyName(html)
  if (!isSlugMatch(company.name, pageName)) {
    console.log(`[CompanySize] ${company.name}: slug mismatch — page shows "${pageName}", skipping`)
    continue
  }

  const count = parseEmployeeCount(html)

  if (count === null) {
    console.log(`[CompanySize] ${company.name}: employee count not found`)
    continue
  }

  if (count >= MIN_EXCLUDE_COUNT) {
    // Past clients are never excluded, even if large
    if (matchPastClient(company.name, pastClientsMap)) {
      console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} employees — SKIPPED (past client)`)
      continue
    }

    if (!isAlreadyExcluded) {
      console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} employees — EXCLUDED`)
      const { error: insertErr } = await supabase.from('excluded_companies').insert({
        name: company.name,
        linkedin_member_count: count,
        linkedin_url: url,
        exclusion_reason: 'employee_count_above_10000',
        last_checked_at: new Date().toISOString(),
      })
      if (insertErr && !insertErr.message.includes('duplicate') && !insertErr.message.includes('unique')) {
        console.warn(`[CompanySize] Insert failed for ${company.name}: ${insertErr.message}`)
      } else {
        newlyExcluded.push({ id: company.id, name: company.name })
      }
    } else {
      // Already excluded — refresh timestamp and member count
      await supabase.from('excluded_companies')
        .update({ linkedin_member_count: count, last_checked_at: new Date().toISOString() })
        .ilike('name', company.name)
      console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} employees — still excluded`)
    }
  } else {
    if (isAlreadyExcluded) {
      // Count has dropped below threshold — reinstate
      const { error: deleteErr } = await supabase
        .from('excluded_companies')
        .delete()
        .ilike('name', company.name)
      if (deleteErr) {
        console.warn(`[CompanySize] Reinstatement failed for ${company.name}: ${deleteErr.message}`)
      } else {
        console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} employees — REINSTATED (below threshold)`)
        reinstated.push(company.name)
      }
    } else {
      console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} employees — OK`)
    }
  }
}

// Step 5: Delete signals from newly excluded companies (only those with a known company ID)
const newlyExcludedWithIds = newlyExcluded.filter(c => c.id !== null)
if (newlyExcludedWithIds.length > 0) {
  const excludedIds = newlyExcludedWithIds.map(c => c.id)
  const { data: deleted, error: deleteErr } = await supabase
    .from('signals')
    .delete()
    .in('company_id', excludedIds)
    .select('id')

  if (deleteErr) {
    console.error('[CompanySize] Signal deletion error:', deleteErr.message)
  } else {
    const deletedCount = deleted?.length ?? 0
    console.log(`\nDeleted ${deletedCount} signals from ${newlyExcluded.length} newly excluded companies:`)
    for (const c of newlyExcluded) console.log(`  - ${c.name}`)
  }
}

// Summary
console.log(`\n${'═'.repeat(50)}`)
console.log(`[CompanySize] Complete`)
console.log(`Companies checked:                 ${checked}`)
console.log(`Newly excluded (≥10,001 employees): ${newlyExcluded.length}`)
console.log(`Reinstated (below threshold):       ${reinstated.length}`)
console.log(`Requests used:                      ${requestsUsed} / ${MAX_REQUESTS}`)
console.log('═'.repeat(50))
