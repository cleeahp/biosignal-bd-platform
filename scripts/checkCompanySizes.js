/**
 * checkCompanySizes.js
 *
 * Weekly script (also run manually) that checks LinkedIn company pages for
 * employee/member counts. Companies with > 5,000 members are inserted into
 * the excluded_companies table and their signals are deleted.
 *
 * Run: node --env-file=.env.local scripts/checkCompanySizes.js
 * GitHub Actions: .github/workflows/company-size-check.yml
 */

import * as cheerio from 'cheerio'
import { supabase } from '../lib/supabase.js'
import { shuffleArray } from '../lib/linkedinClient.js'

// ── Config ────────────────────────────────────────────────────────────────────

const LINKEDIN_LI_AT = process.env.LINKEDIN_LI_AT
const MAX_EMPLOYEE_COUNT = 5_000
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

/** Parse employee/member count from LinkedIn company page HTML. */
function parseEmployeeCount(html) {
  // JSON embedded in page — most reliable
  const staffMatch = html.match(/"staffCount"\s*:\s*(\d+)/)
  if (staffMatch) return parseInt(staffMatch[1])

  const empCountMatch = html.match(/"employeeCount"\s*:\s*(\d+)/)
  if (empCountMatch) return parseInt(empCountMatch[1])

  // Visible text: "X,XXX employees" or "X,XXX+ employees"
  const empTextMatch = html.match(/([\d,]+)\+?\s+(?:employees|associated\s+members)/i)
  if (empTextMatch) return parseInt(empTextMatch[1].replace(/,/g, ''))

  // Range indicator: "10,001+" in aria-label or text nodes
  const rangeMatch = html.match(/([\d,]+)\+\s*(?:<|employees|members)/i)
  if (rangeMatch) {
    const num = parseInt(rangeMatch[1].replace(/,/g, ''))
    if (num > 100) return num
  }

  return null
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

// Step 3: Filter out companies already in excluded_companies
const { data: alreadyExcluded } = await supabase.from('excluded_companies').select('name')
const excludedNames = new Set((alreadyExcluded || []).map(r => r.name.toLowerCase().trim()))

const toCheck = allCompanies.filter(c => !excludedNames.has(c.name.toLowerCase().trim()))
console.log(`[CompanySize] ${toCheck.length} companies to check (${excludedNames.size} already excluded)`)

// Step 4: Shuffle and check each company
const shuffled = shuffleArray([...toCheck])
let requestsUsed = 0
let checked = 0
const newlyExcluded = []

for (const company of shuffled) {
  if (requestsUsed >= MAX_REQUESTS) {
    console.log(`[CompanySize] Budget exhausted (${MAX_REQUESTS} requests)`)
    break
  }

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

  const count = parseEmployeeCount(html)

  if (count === null) {
    console.log(`[CompanySize] ${company.name}: employee count not found`)
    continue
  }

  if (count > MAX_EMPLOYEE_COUNT) {
    console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} members — EXCLUDED`)
    const { error: insertErr } = await supabase.from('excluded_companies').insert({
      name: company.name,
      linkedin_member_count: count,
      linkedin_url: url,
      exclusion_reason: 'employee_count_above_5000',
      last_checked_at: new Date().toISOString(),
    })
    if (insertErr && !insertErr.message.includes('duplicate') && !insertErr.message.includes('unique')) {
      console.warn(`[CompanySize] Insert failed for ${company.name}: ${insertErr.message}`)
    } else {
      newlyExcluded.push({ id: company.id, name: company.name })
    }
  } else {
    console.log(`[CompanySize] ${company.name}: ${count.toLocaleString()} members — OK`)
  }
}

// Step 5: Delete signals from newly excluded companies
if (newlyExcluded.length > 0) {
  const excludedIds = newlyExcluded.map(c => c.id)
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
console.log(`Companies checked:              ${checked}`)
console.log(`Newly excluded (>5,000 members): ${newlyExcluded.length}`)
console.log(`Requests used:                  ${requestsUsed} / ${MAX_REQUESTS}`)
console.log('═'.repeat(50))
