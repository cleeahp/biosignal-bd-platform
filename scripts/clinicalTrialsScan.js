/**
 * Clinical Trials Scan
 *
 * Standalone script that fetches Phase 2/3 industry-sponsored US clinical trials
 * from ClinicalTrials.gov v2 API and stores them in the clinical_trials table.
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
  'LocationFacility',
  'LocationCity',
  'LocationState',
  'LocationZip',
  'LocationCountry',
  'LocationContactName',
  'LocationContactPhone',
  'LocationContactEMail',
  'CentralContactName',
  'CentralContactPhone',
  'CentralContactEMail',
  'IsFDARegulatedDrug',
  'IsFDARegulatedDevice',
].join(',')

function buildQueryUrl(lookbackDate, pageToken = null) {
  const params = new URLSearchParams({
    'filter.advanced': [
      `AREA[LastUpdatePostDate]RANGE[${lookbackDate},MAX]`,
      'AREA[LocationCountry]United States',
      'AREA[LeadSponsorClass]INDUSTRY',
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

  const leadSponsor = sponsor.leadSponsor || {}

  // Phase: join array into string like "Phase 2" or "Phase 1/Phase 2"
  const phases = design.phases || []
  const phase = phases
    .map((p) => p.replace(/^PHASE/i, 'Phase '))
    .join('/')
    || null

  // Last update date
  const lastUpdateRaw = status.lastUpdatePostDateStruct?.date || null

  // Locations: extract all US locations into JSONB array
  // CT.gov v2 nests contacts inside each location as a contacts[] array
  const locationsList = Array.isArray(contacts.locations) ? contacts.locations : []
  const usLocations = locationsList
    .filter((loc) => loc.country === 'United States' || !loc.country)
    .map((loc) => {
      const locContacts = Array.isArray(loc.contacts) ? loc.contacts : []
      const contact = locContacts[0] || {}
      return {
        facility: loc.facility || null,
        city: loc.city || null,
        state: loc.state || null,
        zip: loc.zip || null,
        contact_name: contact.name || null,
        contact_phone: contact.phone || null,
        contact_email: contact.email || null,
      }
    })

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
    locations: usLocations.length > 0 ? usLocations : null,
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const lookbackDate = formatDate(daysAgo(LOOKBACK_DAYS))
  console.log(`[ClinicalTrialsScan] Mode: ${mode}, Lookback: ${LOOKBACK_DAYS} days (since ${lookbackDate})`)

  let totalFetched = 0
  let inserted = 0
  let updated = 0
  let skipped = 0
  let errors = 0
  let pageNum = 0
  let pageToken = null

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
      if (!trial) continue

      const result = await upsertTrial(trial)
      switch (result) {
        case 'inserted': inserted++; pageInserted++; break
        case 'updated':  updated++;  pageUpdated++;  break
        case 'skipped':  skipped++;  pageSkipped++;  break
        case 'error':    errors++;   break
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

  console.log(`\n[ClinicalTrialsScan] === COMPLETE ===`)
  console.log(`[ClinicalTrialsScan] Total fetched: ${totalFetched}`)
  console.log(`[ClinicalTrialsScan] Inserted:      ${inserted}`)
  console.log(`[ClinicalTrialsScan] Updated:       ${updated}`)
  console.log(`[ClinicalTrialsScan] Skipped:       ${skipped}`)
  console.log(`[ClinicalTrialsScan] Errors:        ${errors}`)
}

main().catch((err) => {
  console.error('[ClinicalTrialsScan] Unhandled error:', err)
  process.exit(1)
})
