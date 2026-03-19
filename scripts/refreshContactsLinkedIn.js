/**
 * Refresh LinkedIn current title and company for all past buyers and past candidates.
 *
 * Uses LinkedIn's Voyager GraphQL API with proper auth headers.
 * Requires a valid li_at session cookie — JSESSIONID (csrf-token) is obtained
 * automatically by loading the LinkedIn homepage once at startup.
 *
 * Run:
 *   node scripts/refreshContactsLinkedIn.js
 *
 * Test a single contact from each table first:
 *   TEST_MODE=1 node scripts/refreshContactsLinkedIn.js
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINKEDIN_LI_AT
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const TABLES         = ['past_buyers', 'past_candidates']
const REQUEST_BUDGET = 100
const TEST_MODE      = process.env.TEST_MODE === '1'

// ── Delays mirroring LinkedInClient ──────────────────────────────────────────
const SEARCH_DELAY_MIN = 20_000
const SEARCH_DELAY_MAX = 45_000
const BREAK_DELAY_MIN  = 60_000
const BREAK_DELAY_MAX  = 120_000

const LINKEDIN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// GraphQL queryId confirmed working for people search (March 2026)
const GRAPHQL_QUERY_ID = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0'

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Session init ──────────────────────────────────────────────────────────────

/**
 * Load LinkedIn homepage to obtain JSESSIONID.
 * LinkedIn requires JSESSIONID as the `csrf-token` header on all Voyager calls.
 *
 * @param {string} liAt
 * @returns {Promise<string|null>}  e.g. "ajax:8517818438088302593"
 */
async function getJsessionId(liAt) {
  try {
    const resp = await fetch('https://www.linkedin.com/', {
      headers: {
        'User-Agent':    LINKEDIN_UA,
        'Accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie':        `li_at=${liAt}`,
      },
      signal:   AbortSignal.timeout(20_000),
      redirect: 'follow',
    })

    // Node 18.14+ exposes getSetCookie(); fall back to comma-split on older versions
    const rawCookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') || '').split(/,(?=[^ ])/)

    for (const cookie of rawCookies) {
      // JSESSIONID looks like:  JSESSIONID="ajax:8517818438088302593"; Path=/; ...
      const m = cookie.match(/JSESSIONID="?([^";,\s]+)"?/)
      if (m) {
        console.log('[Contacts] JSESSIONID obtained.')
        return m[1]
      }
    }

    console.warn('[Contacts] JSESSIONID not found in homepage Set-Cookie. li_at may be expired.')
    console.warn('[Contacts] Cookie preview:', rawCookies.slice(0, 3).join(' | ').slice(0, 300))
    return null
  } catch (err) {
    console.error('[Contacts] Homepage fetch failed:', err.message)
    return null
  }
}

// ── Voyager GraphQL search ────────────────────────────────────────────────────

/**
 * Search LinkedIn via the Voyager GraphQL API for a person by name + company.
 *
 * Endpoint: GET /voyager/api/graphql?includeWebMetadata=true&variables=...&queryId=...
 * Variables are passed as LinkedIn's custom tuple syntax, NOT URL-encoded.
 *
 * Response: normalized JSON with `included` array of EntityResultViewModel objects.
 * Each has:
 *   title.text            — person's full name
 *   primarySubtitle.text  — LinkedIn headline, typically "Title at Company"
 *   secondarySubtitle.text — location (not used)
 *
 * @returns {Promise<{title:string,company:string}|{stop:true}|null>}
 */
async function searchPersonVoyager(liAt, jsessionId, firstName, lastName, company, reqNum) {
  const keywords = [firstName, lastName, company].filter(Boolean).join(' ')

  // Variables use LinkedIn's custom syntax — NOT standard URL encoding.
  // Spaces in keywords are fine; the outer parens/colons must NOT be encoded.
  const variables = `(start:0,count:3,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`

  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${GRAPHQL_QUERY_ID}`

  console.log(`[Contacts] Voyager search [${reqNum}/${REQUEST_BUDGET}]: ${firstName} ${lastName}`)

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

    if (resp.status === 999) {
      console.log('[Contacts] Bot detection (999) — stopping all requests')
      return { stop: true }
    }
    if (resp.status === 429) {
      console.log('[Contacts] Rate limited (429) — stopping')
      return { stop: true }
    }
    if (resp.status === 401 || resp.status === 403) {
      console.log(`[Contacts] Auth error (${resp.status}) — li_at cookie may be expired`)
      return { stop: true }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      console.log(`[Contacts] Voyager HTTP ${resp.status} for ${firstName} ${lastName}: ${body.slice(0, 120)}`)
      return null
    }

    let data
    try {
      data = await resp.json()
    } catch (e) {
      const preview = await resp.text().catch(() => '')
      console.log(`[Contacts] JSON parse failed. Preview: ${preview.slice(0, 200)}`)
      return null
    }

    return parseGraphQLResult(data, firstName, lastName)
  } catch (err) {
    console.log(`[Contacts] Voyager request failed: ${err.message}`)
    return null
  }
}

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * Parse a Voyager GraphQL normalized response.
 *
 * Looks in `included` for EntityResultViewModel objects where title.text
 * contains both the first and last name. Extracts title/company from
 * primarySubtitle.text (e.g. "Vice President at ADC Therapeutics").
 *
 * @param {object} data
 * @param {string} firstName
 * @param {string} lastName
 * @returns {{title:string, company:string}|null}
 */
function parseGraphQLResult(data, firstName, lastName) {
  const included = data?.included
  if (!Array.isArray(included)) {
    console.log('[Contacts] Voyager response missing "included" array')
    return null
  }

  const firstLower = firstName.trim().toLowerCase()
  const lastLower  = lastName.trim().toLowerCase()

  for (const item of included) {
    if (item['$type'] !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue

    const nameText = (item.title?.text || '').toLowerCase()
    if (!nameText.includes(firstLower) || !nameText.includes(lastLower)) continue

    // primarySubtitle.text is the LinkedIn headline: "Title at Company" or just a headline
    const headline = (item.primarySubtitle?.text || '').trim()
    if (!headline) return { title: '', company: '' }

    // Split "Senior Director at Genentech" → title="Senior Director", company="Genentech"
    const atIdx = headline.toLowerCase().indexOf(' at ')
    if (atIdx !== -1) {
      return {
        title:   headline.slice(0, atIdx).trim(),
        company: headline.slice(atIdx + 4).trim(),
      }
    }

    // Headline has no " at " separator — it's a custom tagline with no company
    return { title: headline, company: '' }
  }

  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const liAt = process.env.LINKEDIN_LI_AT
  if (!liAt) {
    console.error('[Contacts] LINKEDIN_LI_AT not set — aborting')
    process.exit(1)
  }

  if (TEST_MODE) console.log('[Contacts] TEST_MODE=1 — will process one contact per table')

  // Get JSESSIONID (required csrf-token for Voyager API)
  console.log('[Contacts] Obtaining LinkedIn session token...')
  const jsessionId = await getJsessionId(liAt)
  if (!jsessionId) {
    console.error('[Contacts] Cannot proceed without JSESSIONID. Verify LINKEDIN_LI_AT is valid and non-expired.')
    process.exit(1)
  }

  let totalChecked   = 0
  let totalFound     = 0
  let totalNotFound  = 0
  let titleChanges   = 0
  let companyChanges = 0
  let reqCount       = 0
  let stopped        = false

  outer:
  for (const table of TABLES) {
    const { data: contacts, error } = await supabase
      .from(table)
      .select('id, first_name, last_name, title, company')

    if (error) {
      console.error(`[Contacts] Failed to load ${table}: ${error.message}`)
      continue
    }

    const batch = TEST_MODE ? contacts.slice(0, 1) : contacts
    console.log(`\n[Contacts] Processing ${batch.length} contacts from ${table}${TEST_MODE ? ' (TEST_MODE)' : ''}`)

    for (const contact of batch) {
      if (stopped || reqCount >= REQUEST_BUDGET) {
        console.log('[Contacts] Budget exhausted or stopped — halting')
        break outer
      }

      const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
      totalChecked++
      reqCount++

      // Human-like delay (skip before first request; skip in TEST_MODE)
      if (reqCount > 1 && !TEST_MODE) {
        if (reqCount % 10 === 0) {
          const ms = randomBetween(BREAK_DELAY_MIN, BREAK_DELAY_MAX)
          console.log(`[Contacts] Extended break after ${reqCount} requests (${Math.round(ms / 1000)}s)...`)
          await sleep(ms)
        } else {
          await sleep(randomBetween(SEARCH_DELAY_MIN, SEARCH_DELAY_MAX))
        }
      }

      const result = await searchPersonVoyager(
        liAt, jsessionId,
        contact.first_name || '',
        contact.last_name  || '',
        contact.company    || '',
        reqCount,
      )

      if (result?.stop) { stopped = true; break outer }

      const now = new Date().toISOString()

      if (!result || (!result.title && !result.company)) {
        console.log(`[Contacts] NOT FOUND: ${fullName}`)
        totalNotFound++
        await supabase.from(table).update({ linkedin_last_checked: now }).eq('id', contact.id)
        continue
      }

      totalFound++

      const linkedinTitle   = result.title   || null
      const linkedinCompany = result.company || null

      const titleChanged   = linkedinTitle
        ? linkedinTitle.toLowerCase()   !== (contact.title   || '').toLowerCase()
        : false
      const companyChanged = linkedinCompany
        ? linkedinCompany.toLowerCase() !== (contact.company || '').toLowerCase()
        : false

      if (titleChanged)   titleChanges++
      if (companyChanged) companyChanges++

      const { error: updateErr } = await supabase.from(table).update({
        linkedin_current_title:   linkedinTitle,
        linkedin_current_company: linkedinCompany,
        linkedin_last_checked:    now,
        title_changed:            titleChanged,
        company_changed:          companyChanged,
      }).eq('id', contact.id)

      if (updateErr) {
        console.error(`[Contacts] Update failed for ${fullName}: ${updateErr.message}`)
      } else {
        const changes = []
        if (titleChanged)   changes.push(`title: "${contact.title}" → "${linkedinTitle}"`)
        if (companyChanged) changes.push(`company: "${contact.company}" → "${linkedinCompany}"`)
        const suffix = changes.length ? ` [CHANGED: ${changes.join(', ')}]` : ''
        console.log(`[Contacts] Updated: ${fullName}${suffix}`)
      }
    }
  }

  console.log(`
[Contacts] ── Summary ──────────────────────────
  Total checked:          ${totalChecked}
  Found:                  ${totalFound}
  Not found:              ${totalNotFound}
  Title changes:          ${titleChanges}
  Company changes:        ${companyChanges}
  LinkedIn requests used: ${reqCount}
`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
