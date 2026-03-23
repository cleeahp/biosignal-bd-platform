/**
 * Test script for a single contact LinkedIn refresh.
 *
 * Env vars:
 *   TEST_CONTACT_NAME     — full name, e.g. "Jennifer Herring"
 *   TEST_CONTACT_COMPANY  — company name, e.g. "ADC Therapeutics"
 *   LINKEDIN_LI_AT        — LinkedIn session cookie
 *
 * Steps:
 *   1. Bootstrap JSESSIONID from LinkedIn homepage
 *   2. Voyager GraphQL people search
 *   3. Dash profile fetch (q=memberIdentity)
 *   4. Experience card fetch (profileCards)
 *   5. Profile page HTML — extract company name from <p> elements
 */

import { writeFileSync } from 'fs'
import { resolve }       from 'path'
import * as cheerio      from 'cheerio'

const LINKEDIN_UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GRAPHQL_QUERY_ID = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function section(label) {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${label}`)
  console.log('═'.repeat(70))
}

// ── JSESSIONID ────────────────────────────────────────────────────────────────

async function getJsessionId(liAt) {
  let url = 'https://www.linkedin.com/'
  for (let i = 0; i < 10; i++) {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':      LINKEDIN_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie':          `li_at=${liAt}`,
      },
      signal:   AbortSignal.timeout(20_000),
      redirect: 'manual',
    })
    const cookies = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') || '').split(/,(?=[^ ])/)
    for (const c of cookies) {
      const m = c.match(/JSESSIONID="?([^";,\s]+)"?/)
      if (m) return m[1]
    }
    const loc = resp.headers.get('location')
    if (resp.status >= 300 && resp.status < 400 && loc) {
      url = loc.startsWith('http') ? loc : `https://www.linkedin.com${loc}`
      continue
    }
    break
  }
  return null
}

// ── Voyager helpers ───────────────────────────────────────────────────────────

function voyagerHeaders(liAt, jsessionId, referer) {
  return {
    'User-Agent':                LINKEDIN_UA,
    'Accept':                    'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language':           'en-US,en;q=0.9',
    'csrf-token':                jsessionId,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang':                 'en_US',
    'x-li-track':                '{"clientVersion":"1.13.1900"}',
    'Referer':                   referer,
    'Cookie':                    `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
  }
}

async function voyagerGet(liAt, jsessionId, url, referer) {
  const resp = await fetch(url, {
    headers: voyagerHeaders(liAt, jsessionId, referer),
    signal:  AbortSignal.timeout(20_000),
    redirect: 'manual',
  })
  console.log(`HTTP ${resp.status}`)
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location')
    console.log(`  Redirect location: ${loc || '(none)'}`)
    return { status: resp.status, data: null, raw: null, redirectTo: loc }
  }
  const text = await resp.text()
  try {
    return { status: resp.status, data: JSON.parse(text) }
  } catch {
    return { status: resp.status, data: null, raw: text }
  }
}

// ── Step 2: People search ─────────────────────────────────────────────────────

async function searchContact(liAt, jsessionId, name, company) {
  section(`STEP 2 — Voyager GraphQL people search: "${name}" "${company}"`)

  const keywords  = [name, company].filter(Boolean).join(' ')
  const variables = `(start:0,count:5,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`
  const url       = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${GRAPHQL_QUERY_ID}`

  console.log('URL:', url)

  const { status, data, raw } = await voyagerGet(liAt, jsessionId, url, 'https://www.linkedin.com/search/results/people/')

  if (!data) {
    console.log('Non-JSON response:', raw?.slice(0, 500))
    return null
  }

  console.log('\nFull response:')
  console.log(JSON.stringify(data, null, 2))

  // Extract the first EntityResultViewModel that name-matches
  const included   = Array.isArray(data.included) ? data.included : []
  const nameLower  = name.toLowerCase()
  const nameParts  = nameLower.split(/\s+/)

  for (const item of included) {
    if (item['$type'] !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue
    const titleText = (item.title?.text || '').toLowerCase()
    if (!nameParts.every(part => titleText.includes(part))) continue

    const navUrl = item.navigationUrl || item.navigationContext?.url || ''
    const m      = navUrl.match(/\/in\/([^/?#]+)/)
    const publicIdentifier = m ? m[1] : null

    console.log('\n── Matched result ──────────────────────────────────────')
    console.log('  title.text:            ', item.title?.text)
    console.log('  primarySubtitle.text:  ', item.primarySubtitle?.text)
    console.log('  secondarySubtitle.text:', item.secondarySubtitle?.text)
    console.log('  navigationUrl:         ', navUrl)
    console.log('  publicIdentifier:      ', publicIdentifier)
    console.log('  trackingUrn:           ', item.trackingUrn)
    console.log('  entityUrn:             ', item.entityUrn)

    return { publicIdentifier, item }
  }

  console.log('\nNo matching EntityResultViewModel found for name:', name)
  return null
}

// ── Step 3: Dash profile ──────────────────────────────────────────────────────

async function fetchDashProfile(liAt, jsessionId, publicIdentifier) {
  section(`STEP 3 — Dash profile: /dash/profiles?q=memberIdentity&memberIdentity=${publicIdentifier}`)

  const url = `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdentifier}`
  const ref = `https://www.linkedin.com/in/${publicIdentifier}/`

  console.log('URL:', url)

  const { status, data, raw } = await voyagerGet(liAt, jsessionId, url, ref)

  if (!data) {
    console.log('Non-JSON response:', raw?.slice(0, 500))
    return null
  }

  console.log('\nFull response:')
  console.log(JSON.stringify(data, null, 2))

  // Extract profileUrn and experienceCardUrn
  const included = Array.isArray(data.included) ? data.included : []
  const profile  = included.find(i => i['$type'] === 'com.linkedin.voyager.dash.identity.profile.Profile' && i.publicIdentifier)

  if (!profile) {
    console.log('\nNo full Profile object found in included array.')
    return null
  }

  console.log('\n── Extracted fields ────────────────────────────────────')
  console.log('  entityUrn:         ', profile.entityUrn)
  console.log('  publicIdentifier:  ', profile.publicIdentifier)
  console.log('  headline:          ', profile.headline)
  console.log('  locationName:      ', profile.locationName)
  console.log('  geoLocation:       ', JSON.stringify(profile.geoLocation))
  console.log('  experienceCardUrn: ', profile.experienceCardUrn)
  console.log('  educationCardUrn:  ', profile.educationCardUrn)

  return {
    profileUrn:        profile.entityUrn,
    experienceCardUrn: profile.experienceCardUrn,
    publicIdentifier:  profile.publicIdentifier,
  }
}

// ── Step 4: Experience endpoints (try ALL, print each result) ────────────────

function collectTypes(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return seen
  if (obj['$type']) seen.add(obj['$type'])
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) v.forEach(el => collectTypes(el, seen))
    else if (v && typeof v === 'object') collectTypes(v, seen)
  }
  return seen
}

async function fetchExperienceCard(liAt, jsessionId, profileUrn, publicIdentifier) {
  section('STEP 4 — Experience endpoints (ALL attempted, no early exit)')

  const ref  = `https://www.linkedin.com/in/${publicIdentifier}/`
  const enc1 = encodeURIComponent(profileUrn)
  const enc2 = encodeURIComponent(encodeURIComponent(profileUrn))

  const attempts = [
    {
      label: '4a: dash/profiles — ProfilePositionGroup decoration',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdentifier}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfilePositionGroup`,
    },
    {
      label: '4b: identity/profiles/{id}/positions (classic non-dash)',
      url:   `https://www.linkedin.com/voyager/api/identity/profiles/${publicIdentifier}/positions`,
    },
    {
      label: '4c: dash/profiles/{urn}/positions — single-encoded URN path segment',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/profiles/${enc1}/positions`,
    },
    {
      label: '4d: profileCards — sectionType=EXPERIENCE (uppercase)',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/profileCards?q=expandedProfileCard&profileUrn=${enc1}&sectionType=EXPERIENCE`,
    },
    {
      label: '4e: dash/members/{urn}/profileSections?sectionType=experience',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/members/${enc1}/profileSections?sectionType=experience`,
    },
    {
      label: '4f: profileCards — sectionType=experience lowercase (single-encoded, no locale)',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/profileCards?q=expandedProfileCard&profileUrn=${enc1}&sectionType=experience`,
    },
    {
      label: '4g: profileCards — double-encoded URN, sectionType=experience',
      url:   `https://www.linkedin.com/voyager/api/identity/dash/profileCards?q=expandedProfileCard&profileUrn=${enc2}&sectionType=experience`,
    },
  ]

  for (const attempt of attempts) {
    console.log(`\n${'─'.repeat(70)}`)
    console.log(`${attempt.label}`)
    console.log(`URL: ${attempt.url}`)

    let result
    try {
      result = await voyagerGet(liAt, jsessionId, attempt.url, ref)
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      continue
    }

    const { status, data, raw, redirectTo } = result
    console.log(`HTTP status: ${status}`)

    if (status >= 300 && status < 400) {
      console.log(`Redirect → ${redirectTo || '(no Location header)'}`)
      continue
    }

    if (!data) {
      console.log(`Non-JSON body: ${(raw || '').slice(0, 500)}`)
      continue
    }

    console.log('\nFull JSON response:')
    console.log(JSON.stringify(data, null, 2))

    const allTypes = [...collectTypes(data)].sort()
    console.log('\nAll $types in response:', allTypes.length ? allTypes.join('\n  ') : '(none)')
  }
}

// ── Step 5: Profile page HTML — company name extraction ───────────────────────

async function fetchProfileHtml(liAt, jsessionId, publicIdentifier, headline) {
  section(`STEP 5 — Profile page HTML: /in/${publicIdentifier}/`)

  const profileUrl = `https://www.linkedin.com/in/${publicIdentifier}/`
  console.log('URL:', profileUrl)

  const resp = await fetch(profileUrl, {
    headers: {
      'User-Agent':      LINKEDIN_UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'csrf-token':      jsessionId,
      'Cookie':          `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
      'Referer':         'https://www.linkedin.com/feed/',
    },
    signal:   AbortSignal.timeout(30_000),
    redirect: 'follow',
  })
  console.log(`HTTP ${resp.status}`)

  const html = await resp.text()
  const outFile = resolve('scripts/temp_jennifer_profile.html')
  writeFileSync(outFile, html, 'utf8')
  console.log(`\nSaved ${html.length} bytes to ${outFile}`)

  // ── Method 1: cheerio — find all <p> elements, look for " · " ──────────────
  console.log('\n── Method 1: cheerio <p> elements containing " · " ─────────────')
  const $ = cheerio.load(html)
  const dotMatches = []
  $('p').each((_, el) => {
    const text = $(el).text().trim()
    if (text.includes(' · ')) {
      const company = text.split(' · ')[0].trim()
      dotMatches.push({ company, fullText: text })
    }
  })
  if (dotMatches.length) {
    for (const m of dotMatches) {
      console.log(`  Company candidate: "${m.company}"`)
      console.log(`  Full text:         "${m.fullText}"`)
      console.log()
    }
  } else {
    console.log('  No <p> elements with " · " found.')
  }

  // ── Method 2: regex on raw HTML ───────────────────────────────────────────
  console.log('── Method 2: regex >([^<]+) · [^<]+<\\/p> ───────────────────────')
  const re2 = />([^<]+) · [^<]+<\/p>/g
  let m2
  const re2Matches = []
  while ((m2 = re2.exec(html)) !== null) {
    re2Matches.push(m2[1].trim())
  }
  if (re2Matches.length) {
    re2Matches.forEach(c => console.log(`  Company candidate: "${c}"`))
  } else {
    console.log('  No matches.')
  }

  // ── Method 3: headline context → next <p> ─────────────────────────────────
  console.log('\n── Method 3: headline context → next <p> ────────────────────────')
  if (headline) {
    // Escape special regex chars in headline
    const escaped = headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re3 = new RegExp(`${escaped}[\\s\\S]{0,500}?<p[^>]*>([^<]+)<\\/p>`, 'i')
    const m3 = re3.exec(html)
    if (m3) {
      console.log(`  Company candidate (after headline): "${m3[1].trim()}"`)
      console.log(`  Context: ...${html.slice(Math.max(0, m3.index - 50), m3.index + m3[0].length + 50)}...`)
    } else {
      console.log(`  No match for headline "${headline}" → next <p>.`)
    }
  } else {
    console.log('  No headline available — skipping.')
  }

  // ── Method 4: cheerio — all <p> near a heading/section with "Experience" ──
  console.log('\n── Method 4: all <p> in first 3000 chars of <body> ─────────────')
  const bodyStart = html.indexOf('<body')
  const snippet   = bodyStart >= 0 ? html.slice(bodyStart, bodyStart + 3000) : html.slice(0, 3000)
  const re4 = /<p[^>]*>([^<]{3,100})<\/p>/g
  let m4
  const snippet4 = []
  while ((m4 = re4.exec(snippet)) !== null) snippet4.push(m4[1].trim())
  if (snippet4.length) {
    console.log('  <p> texts near body start:')
    snippet4.forEach(t => console.log(`    "${t}"`))
  } else {
    console.log('  No short <p> texts found near body start.')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const liAt   = process.env.LINKEDIN_LI_AT
  const name   = process.env.TEST_CONTACT_NAME
  const company = process.env.TEST_CONTACT_COMPANY

  if (!liAt)    { console.error('LINKEDIN_LI_AT not set');    process.exit(1) }
  if (!name)    { console.error('TEST_CONTACT_NAME not set'); process.exit(1) }

  console.log(`Contact: "${name}" | Company: "${company || '(none)'}"`)

  // Step 1: JSESSIONID
  section('STEP 1 — Bootstrap JSESSIONID from LinkedIn homepage')
  const jsessionId = await getJsessionId(liAt)
  if (!jsessionId) {
    console.error('Could not obtain JSESSIONID — li_at cookie may be expired')
    process.exit(1)
  }
  console.log('JSESSIONID:', jsessionId.slice(0, 20) + '...')

  await sleep(1500)

  // Step 2: Search
  const searchResult = await searchContact(liAt, jsessionId, name, company)
  if (!searchResult?.publicIdentifier) {
    console.error('\nCould not determine publicIdentifier — stopping.')
    process.exit(1)
  }

  await sleep(2000)

  // Step 3: Dash profile
  const profileResult = await fetchDashProfile(liAt, jsessionId, searchResult.publicIdentifier)
  if (!profileResult?.profileUrn) {
    console.error('\nCould not obtain profileUrn — stopping.')
    process.exit(1)
  }

  await sleep(2000)

  // Step 4: Experience card
  await fetchExperienceCard(liAt, jsessionId, profileResult.profileUrn, searchResult.publicIdentifier)

  await sleep(2000)

  // Step 5: Profile page HTML — company name extraction
  const headline = searchResult.item?.primarySubtitle?.text || null
  await fetchProfileHtml(liAt, jsessionId, searchResult.publicIdentifier, headline)

  console.log('\n\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
