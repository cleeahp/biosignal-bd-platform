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
 */

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
  })
  console.log(`HTTP ${resp.status}`)
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

// ── Step 4: Experience card ───────────────────────────────────────────────────

async function fetchExperienceCard(liAt, jsessionId, profileUrn, publicIdentifier) {
  section('STEP 4 — Experience card: /dash/profileCards?q=expandedProfileCard&sectionType=experience')

  // profileUrn needs to be URI-encoded when used as a query param
  const encodedUrn = encodeURIComponent(profileUrn)
  const url = `https://www.linkedin.com/voyager/api/identity/dash/profileCards?q=expandedProfileCard&profileUrn=${encodedUrn}&sectionType=experience&locale=en_US`
  const ref = `https://www.linkedin.com/in/${publicIdentifier}/`

  console.log('URL:', url)

  const { status, data, raw } = await voyagerGet(liAt, jsessionId, url, ref)

  if (!data) {
    console.log('Non-JSON response:', raw?.slice(0, 500))
    return
  }

  console.log('\nFull response:')
  console.log(JSON.stringify(data, null, 2))

  // Summarise any position objects found
  const included = Array.isArray(data.included) ? data.included : []
  const positions = included.filter(i =>
    i['$type'] && i['$type'].toLowerCase().includes('position')
  )
  if (positions.length) {
    console.log(`\n── ${positions.length} position object(s) found ───────────────────`)
    positions.forEach((p, i) => {
      console.log(`  [${i}] title=${p.title || p.localizedTitle} | company=${p.companyName || p.localizedCompanyName} | $type=${p['$type']}`)
    })
  } else {
    console.log('\nNo position objects found in included array (check $types above).')
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

  console.log('\n\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
