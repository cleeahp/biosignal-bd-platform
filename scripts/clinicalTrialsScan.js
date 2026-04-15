/**
 * Clinical Trials Scan
 *
 * Standalone script that fetches Phase 2/3 industry-sponsored US clinical trials
 * from ClinicalTrials.gov v2 API and stores them in the clinical_trials table.
 * After upserting trials, matches sponsor names to the companies_directory via
 * email domain and records results in companies_alternate_names.
 *
 * Usage:
 *   node scripts/clinicalTrialsScan.js --mode daily    # last 3 days
 *   node scripts/clinicalTrialsScan.js --mode manual   # last 90 days
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[ClinicalTrialsScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CT_API_BASE = 'https://clinicaltrials.gov/api/v2/studies'
const PAGE_SIZE = 1000
const RETRY_DELAY_MS = 60_000
const MAX_RETRIES = 3

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/clinicalTrialsScan.js --mode <daily|manual>')
  console.error('  daily  — lookback 3 days')
  console.error('  manual — lookback 90 days')
  process.exit(1)
}

const LOOKBACK_DAYS = mode === 'daily' ? 3 : 90

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── API ───────────────────────────────────────────────────────────────────────

const FIELDS = [
  'NCTId',
  'BriefTitle',
  'LastUpdatePostDate',
  'OverallStatus',
  'LeadSponsorName',
  'Phase',
  'CentralContactName',
  'CentralContactPhone',
  'CentralContactEMail',
  'IsFDARegulatedDrug',
  'IsFDARegulatedDevice',
].join(',')

// Allowed phase values (raw CT.gov API strings). Combined phases are allowed
// when they include Phase 2 or Phase 3.
const ALLOWED_PHASES = new Set(['PHASE2', 'PHASE3'])

function buildQueryUrl(lookbackDate, pageToken = null) {
  const params = new URLSearchParams({
    'filter.advanced': [
      `AREA[LastUpdatePostDate]RANGE[${lookbackDate},MAX]`,
      'AREA[LocationCountry]United States',
      'AREA[LeadSponsorClass]INDUSTRY',
      'AREA[Phase](PHASE2 OR PHASE3)',
    ].join(' AND '),
    pageSize: String(PAGE_SIZE),
    fields: FIELDS,
  })

  if (pageToken) {
    params.set('pageToken', pageToken)
  }

  return `${CT_API_BASE}?${params.toString()}`
}

async function fetchPage(url, attempt = 1) {
  console.log(`[ClinicalTrialsScan] GET ${url.substring(0, 160)}...`)

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })

  if (response.status === 429) {
    if (attempt > MAX_RETRIES) {
      throw new Error('Rate limited after max retries')
    }
    console.warn(`[ClinicalTrialsScan] 429 rate limited — waiting ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`)
    await sleep(RETRY_DELAY_MS)
    return fetchPage(url, attempt + 1)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`API error ${response.status}: ${body.substring(0, 300)}`)
  }

  return response.json()
}

// ── Data extraction ───────────────────────────────────────────────────────────

/**
 * Check whether a study's phase array contains at least one allowed phase.
 * Allowed: PHASE2, PHASE3, or any combined phase that includes one of those
 * (e.g. PHASE1 + PHASE2, PHASE2 + PHASE3).
 * Rejected: pure PHASE1, PHASE4, EARLY_PHASE1, NA, empty/missing.
 *
 * @param {string[]} phases - raw phase array from CT.gov (e.g. ['PHASE2'])
 * @returns {boolean}
 */
function isAllowedPhase(phases) {
  if (!phases || phases.length === 0) return false
  return phases.some((p) => ALLOWED_PHASES.has(p.toUpperCase()))
}

function extractTrial(study) {
  const proto = study.protocolSection || {}
  const id = proto.identificationModule || {}
  const status = proto.statusModule || {}
  const sponsor = proto.sponsorCollaboratorsModule || {}
  const design = proto.designModule || {}
  const oversight = proto.oversightModule || {}
  const contacts = proto.contactsLocationsModule || {}

  const nctId = id.nctId
  if (!nctId) return null

  // Post-fetch phase filter: reject anything that isn't Phase 2/3 or a
  // combined phase containing 2 or 3
  const phases = design.phases || []
  if (!isAllowedPhase(phases)) {
    const phaseLabel = phases.length > 0 ? phases.join(',') : 'NA'
    console.log(`[ClinicalTrialsScan] SKIPPED (phase: ${phaseLabel}): ${nctId}`)
    return null
  }

  const leadSponsor = sponsor.leadSponsor || {}

  // Phase: join array into string like "Phase 2" or "Phase 1/Phase 2"
  const phase = phases
    .map((p) => p.replace(/^PHASE/i, 'Phase '))
    .join('/')
    || null

  // Last update date
  const lastUpdateRaw = status.lastUpdatePostDateStruct?.date || null

  // Central contacts
  const centralContactsList = Array.isArray(contacts.centralContacts) ? contacts.centralContacts : []
  const centralContacts = centralContactsList.map((c) => ({
    name: c.name || null,
    phone: c.phone || null,
    email: c.email || null,
  }))

  return {
    nct_id: nctId,
    brief_title: id.briefTitle || null,
    last_update_post_date: lastUpdateRaw || null,
    overall_status: status.overallStatus || null,
    lead_sponsor_name: leadSponsor.name || null,
    phase,
    central_contacts: centralContacts.length > 0 ? centralContacts : null,
    is_fda_regulated_drug: oversight.isFdaRegulatedDrug ?? null,
    is_fda_regulated_device: oversight.isFdaRegulatedDevice ?? null,
  }
}

// ── Upsert logic ──────────────────────────────────────────────────────────────

async function upsertTrial(trial) {
  // Check if exists
  const { data: existing, error: selectErr } = await supabase
    .from('clinical_trials')
    .select('id, last_update_post_date')
    .eq('nct_id', trial.nct_id)
    .maybeSingle()

  if (selectErr) {
    console.error(`[ClinicalTrialsScan] Select error for ${trial.nct_id}: ${selectErr.message}`)
    return 'error'
  }

  if (!existing) {
    // INSERT
    const { error } = await supabase.from('clinical_trials').insert(trial)
    if (error) {
      console.error(`[ClinicalTrialsScan] Insert error for ${trial.nct_id}: ${error.message}`)
      return 'error'
    }
    return 'inserted'
  }

  // Compare dates — existing.last_update_post_date is a date string from DB
  const existingDate = existing.last_update_post_date
    ? String(existing.last_update_post_date).substring(0, 10)
    : null
  const newDate = trial.last_update_post_date
    ? String(trial.last_update_post_date).substring(0, 10)
    : null

  if (existingDate === newDate) {
    return 'skipped'
  }

  // UPDATE
  const { error } = await supabase
    .from('clinical_trials')
    .update({ ...trial, updated_at: new Date().toISOString() })
    .eq('id', existing.id)

  if (error) {
    console.error(`[ClinicalTrialsScan] Update error for ${trial.nct_id}: ${error.message}`)
    return 'error'
  }
  return 'updated'
}

// ── Company name matching via email domain ───────────────────────────────────

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'mail.com',
])

/**
 * Load all existing (alternate_name, directory_name) pairs from
 * companies_alternate_names into a Set for fast in-memory dedup.
 * Key format: "lowercase_alt_name\0lowercase_dir_name"
 */
async function loadExistingAlternateNames() {
  const pairs = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('alternate_name, directory_name')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[ClinicalTrialsScan] Error loading alternate names: ${error.message}`)
      return pairs
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      pairs.add(`${row.alternate_name.trim().toLowerCase()}\0${row.directory_name.trim().toLowerCase()}`)
    }
    offset += PAGE
  }

  return pairs
}

/**
 * Load all companies_directory rows that have a domain into a Map
 * keyed by lowercase domain → array of company names. Multiple companies
 * can share the same domain (e.g. "Novartis AG" and "Novartis Pharmaceuticals").
 */
async function loadDirectoryDomains() {
  const domainMap = new Map()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name, domain')
      .not('domain', 'is', null)
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[ClinicalTrialsScan] Error loading directory domains: ${error.message}`)
      return domainMap
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      if (row.domain) {
        const key = row.domain.trim().toLowerCase()
        if (!domainMap.has(key)) {
          domainMap.set(key, [])
        }
        domainMap.get(key).push(row.name)
      }
    }
    offset += PAGE
  }

  return domainMap
}

/**
 * Extract the first non-generic email domain from a central_contacts JSONB array.
 * @param {Array|null} centralContacts
 * @returns {string|null}
 */
function extractEmailDomain(centralContacts) {
  if (!Array.isArray(centralContacts)) return null

  for (const contact of centralContacts) {
    const email = contact.email
    if (!email || typeof email !== 'string') continue

    const atIdx = email.indexOf('@')
    if (atIdx === -1) continue

    const domain = email.substring(atIdx + 1).trim().toLowerCase()
    if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
      return domain
    }
  }

  return null
}

/**
 * Process all collected sponsor names against the directory.
 * Queues up rows to batch-insert into companies_alternate_names.
 *
 * @param {Map<string, { sponsor: string, centralContacts: Array|null }>} sponsorsToMatch
 * @param {Set<string>} existingAltPairs - "alt\0dir" pair keys already in DB
 * @param {Map<string, string[]>} directoryDomains - lowercase domain → array of directory company names
 */
async function matchSponsors(sponsorsToMatch, existingAltPairs, directoryDomains) {
  const rowsToInsert = []
  let matched = 0
  let noMatch = 0

  for (const [sponsorKey, { sponsor, centralContacts }] of sponsorsToMatch) {
    const domain = extractEmailDomain(centralContacts)

    if (domain) {
      const directoryNames = directoryDomains.get(domain)
      if (directoryNames && directoryNames.length > 0) {
        // Filter out pairs that already exist in DB
        const newNames = directoryNames.filter(
          (dirName) => !existingAltPairs.has(`${sponsorKey}\0${dirName.trim().toLowerCase()}`)
        )
        if (newNames.length > 0) {
          console.log(`[ClinicalTrialsScan] MATCHED: "${sponsor}" → ${newNames.length} companies via domain ${domain}`)
          for (const dirName of newNames) {
            rowsToInsert.push({
              directory_name: dirName,
              alternate_name: sponsor,
              matched_via: 'email_domain',
              domain,
            })
          }
          matched++
          continue
        }
      }
    }

    // No match — skip, will be re-checked on future runs
    const domainLabel = domain || 'none'
    console.log(`[ClinicalTrialsScan] NO MATCH: "${sponsor}" (domain: ${domainLabel})`)
    noMatch++
  }

  // Batch insert
  if (rowsToInsert.length > 0) {
    const BATCH = 500
    let insertErrors = 0

    for (let i = 0; i < rowsToInsert.length; i += BATCH) {
      const batch = rowsToInsert.slice(i, i + BATCH)
      const { error } = await supabase.from('companies_alternate_names').insert(batch)

      if (error) {
        // Fall back to one-by-one for this batch
        for (const row of batch) {
          const { error: rowErr } = await supabase.from('companies_alternate_names').insert(row)
          if (rowErr) {
            console.error(`[ClinicalTrialsScan] Alt name insert error for "${row.alternate_name}": ${rowErr.message}`)
            insertErrors++
          }
        }
      }
    }

    if (insertErrors > 0) {
      console.log(`[ClinicalTrialsScan] Alt name insert errors: ${insertErrors}`)
    }
  }

  console.log(`[ClinicalTrialsScan] Name matching: ${matched} sponsors matched, ${noMatch} no match, ${rowsToInsert.length} new rows inserted`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const lookbackDate = formatDate(daysAgo(LOOKBACK_DAYS))
  console.log(`[ClinicalTrialsScan] Mode: ${mode}, Lookback: ${LOOKBACK_DAYS} days (since ${lookbackDate})`)

  // Pre-load lookup data for company name matching
  console.log('[ClinicalTrialsScan] Loading company matching data...')
  const [existingAltPairs, directoryDomains] = await Promise.all([
    loadExistingAlternateNames(),
    loadDirectoryDomains(),
  ])
  console.log(`[ClinicalTrialsScan] Loaded ${existingAltPairs.size} existing alternate name pairs, ${directoryDomains.size} unique directory domains`)

  let totalFetched = 0
  let phaseFiltered = 0
  let inserted = 0
  let updated = 0
  let skipped = 0
  let errors = 0
  let pageNum = 0
  let pageToken = null

  // Collect unique sponsors to match after all pages are processed
  // Map key: lowercase sponsor name, value: { sponsor, centralContacts }
  const sponsorsToMatch = new Map()

  while (true) {
    pageNum++
    const url = buildQueryUrl(lookbackDate, pageToken)

    let data
    try {
      data = await fetchPage(url)
    } catch (err) {
      console.error(`[ClinicalTrialsScan] Fatal fetch error on page ${pageNum}: ${err.message}`)
      break
    }

    const studies = data.studies || []
    totalFetched += studies.length

    let pageInserted = 0
    let pageUpdated = 0
    let pageSkipped = 0

    for (const study of studies) {
      const trial = extractTrial(study)
      if (!trial) { phaseFiltered++; continue }

      const result = await upsertTrial(trial)
      switch (result) {
        case 'inserted': inserted++; pageInserted++; break
        case 'updated':  updated++;  pageUpdated++;  break
        case 'skipped':  skipped++;  pageSkipped++;  break
        case 'error':    errors++;   break
      }

      // Collect sponsor for matching (only if insert/update succeeded and sponsor exists)
      if (trial.lead_sponsor_name && (result === 'inserted' || result === 'updated')) {
        const key = trial.lead_sponsor_name.trim().toLowerCase()
        if (!sponsorsToMatch.has(key)) {
          sponsorsToMatch.set(key, {
            sponsor: trial.lead_sponsor_name,
            centralContacts: trial.central_contacts,
          })
        }
      }
    }

    console.log(
      `[ClinicalTrialsScan] Page ${pageNum}: ${studies.length} studies fetched, ` +
      `${pageInserted} inserted, ${pageUpdated} updated, ${pageSkipped} skipped`
    )

    if (data.nextPageToken) {
      pageToken = data.nextPageToken
    } else {
      break
    }
  }

  console.log(`\n[ClinicalTrialsScan] === TRIALS COMPLETE ===`)
  console.log(`[ClinicalTrialsScan] Total fetched:   ${totalFetched}`)
  console.log(`[ClinicalTrialsScan] Phase filtered: ${phaseFiltered}`)
  console.log(`[ClinicalTrialsScan] Inserted:       ${inserted}`)
  console.log(`[ClinicalTrialsScan] Updated:        ${updated}`)
  console.log(`[ClinicalTrialsScan] Skipped:        ${skipped}`)
  console.log(`[ClinicalTrialsScan] Errors:         ${errors}`)

  // ── Company name matching ──────────────────────────────────────────────────
  console.log(`\n[ClinicalTrialsScan] === COMPANY NAME MATCHING ===`)
  console.log(`[ClinicalTrialsScan] ${sponsorsToMatch.size} new sponsors to match`)

  if (sponsorsToMatch.size > 0) {
    await matchSponsors(sponsorsToMatch, existingAltPairs, directoryDomains)
  } else {
    console.log('[ClinicalTrialsScan] No new sponsors to match.')
  }

  console.log(`\n[ClinicalTrialsScan] === ALL DONE ===`)
}

main().catch((err) => {
  console.error('[ClinicalTrialsScan] Unhandled error:', err)
  process.exit(1)
})
