/**
 * Refresh linkedin_current_company for all past_buyers and past_candidates.
 *
 * Strategy per contact:
 *   1. Voyager GraphQL search by full_name + current_company → get publicIdentifier
 *      and primarySubtitle.text (fallback company source)
 *   2. Fetch profile page HTML with linkedinClient.js-style headers → cheerio parse
 *      for <p> elements containing " · " → company = text before first " · "
 *   3. Fallback: split primarySubtitle.text on " at ", take everything after
 *      the last " at " as the company name
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINKEDIN_LI_AT
 */

import { createClient } from '@supabase/supabase-js'
import * as cheerio from 'cheerio'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const TABLES    = ['past_buyers', 'past_candidates']
const TEST_MODE = process.env.TEST_MODE === '1'

// Exact User-Agent from lib/linkedinClient.js
const LINKEDIN_UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GRAPHQL_QUERY_ID = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min)

// ── Session init ───────────────────────────────────────────────────────────────

async function getJsessionId(liAt) {
  try {
    const resp = await fetch('https://www.linkedin.com/', {
      headers: {
        'User-Agent':      LINKEDIN_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie':          `li_at=${liAt}`,
      },
      signal:   AbortSignal.timeout(20_000),
      redirect: 'follow',
    })
    const rawCookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') || '').split(/,(?=[^ ])/)
    for (const c of rawCookies) {
      const m = c.match(/JSESSIONID="?([^";,\s]+)"?/)
      if (m) {
        console.log(`[Companies] JSESSIONID obtained: ${m[1].slice(0, 20)}...`)
        return m[1]
      }
    }
    console.warn('[Companies] JSESSIONID not found — li_at may be expired')
    return null
  } catch (err) {
    console.error('[Companies] Homepage fetch failed:', err.message)
    return null
  }
}

// ── Voyager GraphQL search ─────────────────────────────────────────────────────

/**
 * @returns {{ publicIdentifier: string, subtitleText: string } | { stop: true } | { empty: true } | { malformed: true } | null}
 */
async function searchPerson(liAt, jsessionId, firstName, lastName, company, reqNum) {
  const keywords  = [firstName, lastName, company].filter(Boolean).join(' ')
  const variables = `(start:0,count:3,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`
  const url       = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${GRAPHQL_QUERY_ID}`

  console.log(`[Companies] Search [${reqNum}]: ${firstName} ${lastName}`)

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':                LINKEDIN_UA,
        'Accept':                    'application/vnd.linkedin.normalized+json+2.1',
        'Accept-Language':           'en-US,en;q=0.9',
        'csrf-token':                jsessionId,
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang':                 'en_US',
        'x-li-track':                '{"clientVersion":"1.13.1900"}',
        'Referer':                   'https://www.linkedin.com/search/results/people/',
        'Cookie':                    `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
      },
      signal: AbortSignal.timeout(20_000),
    })

    if (resp.status === 999) { console.log('[Companies] Bot detection (999) — stopping'); return { stop: true } }
    if (resp.status === 429) { console.log('[Companies] Rate limited (429) — stopping');  return { stop: true } }
    if (resp.status === 401 || resp.status === 403) {
      console.log(`[Companies] Auth error (${resp.status}) — li_at may be expired`); return { stop: true }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      console.log(`[Companies] Voyager HTTP ${resp.status}: ${body.slice(0, 120)}`)
      return null
    }

    let data
    try { data = await resp.json() } catch {
      console.log('[Companies] JSON parse failed'); return null
    }

    if (!data || typeof data !== 'object') return { malformed: true }
    const included = data.included
    if (!Array.isArray(included)) return { malformed: true }

    const elements = data?.data?.searchDashClustersByAll?.elements
    if (Array.isArray(elements) && elements.length === 0) return { empty: true }

    const firstLower = (firstName || '').trim().toLowerCase()
    const lastLower  = (lastName  || '').trim().toLowerCase()

    for (const item of included) {
      if (item['$type'] !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue
      const nameText = (item.title?.text || '').toLowerCase()
      if (!nameText.includes(firstLower) || !nameText.includes(lastLower)) continue

      const navUrl = item.navigationUrl || item.navigationContext?.url || ''
      const m      = navUrl.match(/\/in\/([^/?#]+)/)
      const publicIdentifier = m ? m[1] : null

      const subtitleText = (item.primarySubtitle?.text || '').trim()
      return { publicIdentifier, subtitleText }
    }

    return null
  } catch (err) {
    console.log(`[Companies] Voyager request failed: ${err.message}`)
    return null
  }
}

// ── Profile HTML fetch (exact linkedinClient.js headers) ──────────────────────

async function fetchProfileHtml(liAt, publicIdentifier) {
  const url = `https://www.linkedin.com/in/${publicIdentifier}/`
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':                LINKEDIN_UA,
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate, br',
        'Referer':                   'https://www.linkedin.com/',
        'DNT':                       '1',
        'Connection':                'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cookie':                    `li_at=${liAt}`,
      },
      signal:   AbortSignal.timeout(20_000),
      redirect: 'follow',
    })
    if (!resp.ok) return null
    return await resp.text()
  } catch {
    return null
  }
}

// ── Company extraction from HTML ──────────────────────────────────────────────

// Company names: 2–50 chars, not a pure date, not a location pattern
const SKIP_PATTERN = /^\d{4}$|present|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+\s*(yr|mo|year|month)/i

function extractCompanyFromHtml(html) {
  const $ = cheerio.load(html)
  for (const el of $('p').toArray()) {
    const text = $(el).text().trim()
    if (!text.includes(' · ')) continue
    const before = text.split(' · ')[0].trim()
    if (before.length >= 2 && before.length <= 50 && !SKIP_PATTERN.test(before)) {
      return before
    }
  }
  return null
}

// ── Company extraction from subtitle fallback ──────────────────────────────────

function extractCompanyFromSubtitle(subtitleText) {
  if (!subtitleText) return null
  const atIdx = subtitleText.toLowerCase().lastIndexOf(' at ')
  if (atIdx === -1) return null
  const company = subtitleText.slice(atIdx + 4).trim()
  return company.length >= 2 ? company : null
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const liAt = process.env.LINKEDIN_LI_AT
  if (!liAt) { console.error('[Companies] LINKEDIN_LI_AT not set — aborting'); process.exit(1) }

  if (TEST_MODE) console.log('[Companies] TEST_MODE=1 — will process one contact per table')

  // Load all contacts from both tables, then shuffle for varied order each run
  const allContacts = []
  for (const table of TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select('id, first_name, last_name, company')
    if (error) { console.error(`[Companies] Failed to load ${table}: ${error.message}`); continue }
    const batch = TEST_MODE ? data.slice(0, 1) : data
    for (const c of batch) allContacts.push({ ...c, _table: table })
  }
  if (!TEST_MODE) allContacts.sort(() => Math.random() - 0.5)

  const budget = allContacts.length
  console.log(`[Companies] Total contacts: ${budget} — LinkedIn budget: ${budget}`)

  // Bootstrap session
  let jsessionId = await getJsessionId(liAt)
  if (!jsessionId) {
    console.error('[Companies] Cannot proceed without JSESSIONID')
    process.exit(1)
  }

  let totalChecked = 0, foundHtml = 0, foundFallback = 0, notFound = 0
  let companyChanges = 0, reqCount = 0, stopped = false, consecutiveEmpty = 0

  for (const contact of allContacts) {
    if (stopped || reqCount >= budget) {
      console.log('[Companies] Budget exhausted or stopped — halting')
      break
    }

    const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
    totalChecked++
    reqCount++

    // Re-bootstrap JSESSIONID every 100 requests
    if (reqCount > 1 && (reqCount - 1) % 100 === 0) {
      console.log(`[Companies] Re-bootstrapping JSESSIONID at request ${reqCount}...`)
      const refreshed = await getJsessionId(liAt)
      if (refreshed) jsessionId = refreshed
      else console.warn('[Companies] Re-bootstrap failed — continuing with existing token')
    }

    const result = await searchPerson(
      liAt, jsessionId,
      contact.first_name || '',
      contact.last_name  || '',
      contact.company    || '',
      reqCount,
    )

    // Human-like delay; extended break every 50 requests
    if (!TEST_MODE) {
      if (reqCount % 50 === 0) {
        console.log(`[Companies] Taking extended break at request ${reqCount}...`)
        await randomDelay(30_000, 45_000)
      } else {
        await randomDelay(8_000, 15_000)
      }
    }

    if (result?.stop)     { stopped = true; break }
    if (result?.malformed || result?.empty || !result) {
      if (result?.empty || result?.malformed) {
        consecutiveEmpty = (consecutiveEmpty || 0) + 1
        if (consecutiveEmpty >= 5) {
          console.log('[Companies] Rate limited — stopping to avoid detection')
          stopped = true; break
        }
      }
      console.log(`[Companies] NOT FOUND: ${fullName}`)
      notFound++
      await supabase.from(contact._table)
        .update({ linkedin_last_checked: new Date().toISOString() })
        .eq('id', contact.id)
      continue
    }
    consecutiveEmpty = 0

    const { publicIdentifier, subtitleText } = result
    consecutiveEmpty = 0

    // Try HTML parse first
    let linkedinCompany = null
    let source = 'none'

    if (publicIdentifier) {
      const html = await fetchProfileHtml(liAt, publicIdentifier)
      if (html) {
        linkedinCompany = extractCompanyFromHtml(html)
        if (linkedinCompany) source = 'html'
      }
    }

    // Fallback to subtitle
    if (!linkedinCompany) {
      linkedinCompany = extractCompanyFromSubtitle(subtitleText)
      if (linkedinCompany) source = 'subtitle'
    }

    const now = new Date().toISOString()

    if (!linkedinCompany) {
      console.log(`[Companies] NOT FOUND: ${fullName}`)
      notFound++
      await supabase.from(contact._table)
        .update({ linkedin_last_checked: now })
        .eq('id', contact.id)
      continue
    }

    const companyChanged = linkedinCompany.toLowerCase() !== (contact.company || '').toLowerCase()
    if (companyChanged) companyChanges++
    if (source === 'html') foundHtml++
    else foundFallback++

    const { error: updateErr } = await supabase.from(contact._table).update({
      linkedin_current_company: linkedinCompany,
      company_changed:          companyChanged,
      linkedin_last_checked:    now,
    }).eq('id', contact.id)

    if (updateErr) {
      console.error(`[Companies] Update failed for ${fullName}: ${updateErr.message}`)
    } else {
      const changedTag = companyChanged ? ` [CHANGED: "${contact.company}" → "${linkedinCompany}"]` : ''
      console.log(`[Companies] FOUND ${fullName}: ${linkedinCompany} (via ${source})${changedTag}`)
    }
  }

  console.log(`
[Companies] ── Summary ──────────────────────────────
  Total checked:            ${totalChecked}
  Found via HTML:           ${foundHtml}
  Found via subtitle fallback: ${foundFallback}
  Not found:                ${notFound}
  Company changes detected: ${companyChanges}
  LinkedIn requests used:   ${reqCount} / ${budget}
`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
