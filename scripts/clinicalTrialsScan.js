/**
 * Clinical Trials Scan
 *
 * Standalone script that fetches Phase 2/3 industry-sponsored US clinical trials
 * from ClinicalTrials.gov v2 API and stores them in the clinical_trials table.
 * Query window: studies with StartDate between 1 month ago and 1 year ahead.
 * After upserting trials, matches sponsor names to the companies_directory via
 * email domain and records results in companies_alternate_names.
 *
 * Usage:
 *   node scripts/clinicalTrialsScan.js --mode daily    # StartDate window upsert
 *   node scripts/clinicalTrialsScan.js --mode manual   # StartDate window upsert
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
  console.error('  daily  — StartDate window upsert')
  console.error('  manual — StartDate window upsert')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateSlash(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const y = date.getFullYear()
  return `${m}/${d}/${y}`
}

function monthsAgo(n) {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d
}

function yearsAhead(n) {
  const d = new Date()
  d.setFullYear(d.getFullYear() + n)
  return d
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── API ───────────────────────────────────────────────────────────────────────

const FIELDS = [
  'NCTId',
  'BriefTitle',
  'OverallStatus',
  'LeadSponsorName',
  'Phase',
  'StartDate',
  'CentralContactName',
  'CentralContactPhone',
  'CentralContactEMail',
  'IsFDARegulatedDrug',
  'IsFDARegulatedDevice',
].join(',')

// Allowed phase values (raw CT.gov API strings). Combined phases are allowed
// when they include Phase 2 or Phase 3.
const ALLOWED_PHASES = new Set(['PHASE2', 'PHASE3'])

function buildQueryUrl(startDateRange, pageToken = null) {
  const params = new URLSearchParams({
    'filter.advanced': [
      `AREA[StartDate]RANGE[${startDateRange.from}, ${startDateRange.to}]`,
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

  // Study start date (can be "2025-03-15" or "March 2025")
  const studyStartDate = status.startDateStruct?.date || null

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
    overall_status: status.overallStatus || null,
    lead_sponsor_name: leadSponsor.name || null,
    phase,
    study_start_date: studyStartDate,
    source_url: `https://clinicaltrials.gov/study/${nctId}`,
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
    .select('id')
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

// ── Company name matching (multi-layer) ──────────────────────────────────────

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'mail.com',
])

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|AG|NV|SE|Pty)\s*$/i

const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'in', 'by', 'at', 'to'])

/**
 * Parse company_size strings like "10,001+ employees" → 10001 (lower bound).
 * Returns 0 for null/empty/unparseable.
 */
function parseSize(sizeStr) {
  if (!sizeStr) return 0
  // Extract the first number (which is the lower bound)
  const match = sizeStr.replace(/,/g, '').match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Given an array of { name, size } entries, return the one with the largest
 * parsed company_size. Ties broken by first occurrence.
 */
function pickLargest(entries) {
  if (!entries || entries.length === 0) return null
  if (entries.length === 1) return entries[0]
  let best = entries[0]
  let bestSize = parseSize(best.size)
  for (let i = 1; i < entries.length; i++) {
    const s = parseSize(entries[i].size)
    if (s > bestSize) {
      best = entries[i]
      bestSize = s
    }
  }
  return best
}

/**
 * Pick the best candidate from a list of entries that share a domain.
 * Primary sort: largest company_size. Tiebreaker when multiple entries are
 * tied at the top size: prefer an entry whose cleaned-name word appears
 * within the domain string.
 */
function pickBestForDomain(entries, domain) {
  if (!entries || entries.length === 0) return null
  if (entries.length === 1) return entries[0]

  let maxSize = parseSize(entries[0].size)
  for (let i = 1; i < entries.length; i++) {
    const s = parseSize(entries[i].size)
    if (s > maxSize) maxSize = s
  }

  const topTier = entries.filter((e) => parseSize(e.size) === maxSize)
  if (topTier.length === 1) return topTier[0]

  const domainLower = String(domain || '').toLowerCase()
  for (const entry of topTier) {
    const cleaned = cleanName(entry.name)
    const words = cleaned.split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    for (const w of words) {
      if (domainLower.includes(w)) return entry
    }
  }

  return topTier[0]
}

/**
 * Clean a company name for comparison:
 *   - Strip parenthetical content (parens AND everything inside them)
 *   - Strip legal suffixes
 *   - Trim trailing commas/whitespace
 *   - Lowercase
 */
function cleanName(raw) {
  if (!raw) return ''
  let s = raw
  // Remove parenthetical content (parens and everything inside)
  s = s.replace(/\s*\([^)]*\)/g, '')
  // Strip legal suffixes (may need multiple passes)
  for (let i = 0; i < 3; i++) {
    const prev = s
    s = s.replace(LEGAL_SUFFIXES_RE, '')
    if (s === prev) break
  }
  // Trim trailing commas, periods, whitespace
  s = s.replace(/[,.\s]+$/, '').trim()
  return s.toLowerCase()
}

/**
 * Extract the first 1-2 significant words from a cleaned name for prefix matching.
 */
function extractCoreWords(cleaned) {
  if (!cleaned) return []
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w))
  return words.slice(0, 2)
}

// ── Data loading ─────────────────────────────────────────────────────────────

/**
 * Load all existing alternate_name values from companies_alternate_names
 * into a Set (lowercased) for skip-check. If a sponsor already exists
 * (regardless of matched_via), skip all matching layers.
 */
async function loadExistingAlternateNames() {
  const names = new Map()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('alternate_name, directory_name, matched_via')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[ClinicalTrialsScan] Error loading alternate names: ${error.message}`)
      return names
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      names.set(row.alternate_name.trim().toLowerCase(), {
        directory_name: row.directory_name,
        matched_via: row.matched_via,
      })
    }
    offset += PAGE
  }

  return names
}

/**
 * Load ALL companies_directory rows into memory. Builds three indexes:
 *   - domainMap:   lowercase domain → [{ name, size }]
 *   - nameMap:     cleaned lowercase name → [{ name, size }]
 *   - prefixIndex: first significant word → [{ name, cleanedName, size }]
 */
async function loadDirectory() {
  const domainMap = new Map()
  const nameMap = new Map()
  const prefixIndex = new Map()
  const PAGE = 1000
  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name, domain, company_size')
      .range(offset, offset + PAGE - 1)

    if (error) {
      console.error(`[ClinicalTrialsScan] Error loading directory: ${error.message}`)
      break
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      total++
      const entry = { name: row.name, size: row.company_size || null }

      // Domain index
      if (row.domain) {
        const domKey = row.domain.trim().toLowerCase()
        if (!domainMap.has(domKey)) domainMap.set(domKey, [])
        domainMap.get(domKey).push(entry)
      }

      // Cleaned name index
      const cleaned = cleanName(row.name)
      if (cleaned) {
        if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
        nameMap.get(cleaned).push(entry)

        // Prefix index (first significant word)
        const coreWords = extractCoreWords(cleaned)
        if (coreWords.length > 0) {
          const firstWord = coreWords[0]
          if (!prefixIndex.has(firstWord)) prefixIndex.set(firstWord, [])
          prefixIndex.get(firstWord).push({ ...entry, cleanedName: cleaned })
        }
      }
    }
    offset += PAGE
  }

  // Exact name → company_size map for enrichment lookups
  const sizeMap = new Map()
  for (const [, entries] of nameMap) {
    for (const entry of entries) {
      if (!sizeMap.has(entry.name)) {
        sizeMap.set(entry.name, entry.size)
      }
    }
  }

  console.log(`[ClinicalTrialsScan] Loaded ${total} directory companies → ${domainMap.size} domains, ${nameMap.size} cleaned names, ${prefixIndex.size} prefix words`)
  return { domainMap, nameMap, prefixIndex, sizeMap }
}

// ── Matching layers ──────────────────────────────────────────────────────────

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
 * Layer 1: Email domain match.
 * Returns { dirName, domain } or null.
 */
function matchByDomain(centralContacts, domainMap) {
  const domain = extractEmailDomain(centralContacts)
  if (!domain) return null

  const entries = domainMap.get(domain)
  if (!entries || entries.length === 0) return null

  const best = pickBestForDomain(entries, domain)
  return { dirName: best.name, domain, layer: 'email_domain' }
}

/**
 * Layer 2: Exact cleaned name match.
 * Returns { dirName } or null.
 */
function matchByExactName(sponsorName, nameMap) {
  const cleaned = cleanName(sponsorName)
  if (!cleaned) return null

  const entries = nameMap.get(cleaned)
  if (!entries || entries.length === 0) return null

  const best = pickLargest(entries)
  return { dirName: best.name, domain: null, layer: 'exact_name' }
}

/**
 * Layer 3: Core keyword prefix match.
 * Returns { dirName } or null.
 */
function matchByKeyword(sponsorName, prefixIndex) {
  const cleaned = cleanName(sponsorName)
  if (!cleaned) return null

  const coreWords = extractCoreWords(cleaned)
  if (coreWords.length === 0) return null

  const firstWord = coreWords[0]

  // For short single-word names (<=4 chars), require exact word-boundary match
  if (coreWords.length === 1 && firstWord.length <= 4) {
    const candidates = prefixIndex.get(firstWord)
    if (!candidates) return null
    // Only match if the directory cleaned name is exactly this word
    const exact = candidates.filter((c) => c.cleanedName === firstWord)
    if (exact.length === 0) return null
    const best = pickLargest(exact)
    return { dirName: best.name, domain: null, layer: 'keyword' }
  }

  // Check if any directory company's cleaned name starts with the core words
  const candidates = prefixIndex.get(firstWord)
  if (!candidates || candidates.length === 0) return null

  // If we have 2 core words, filter to entries whose cleaned name starts with both
  const prefix = coreWords.join(' ')
  const matches = candidates.filter((c) => c.cleanedName.startsWith(prefix))

  if (matches.length > 0) {
    const best = pickLargest(matches)
    return { dirName: best.name, domain: null, layer: 'keyword' }
  }

  // Fall back to single first-word prefix if 2-word prefix had no matches
  if (coreWords.length > 1) {
    const singleMatches = candidates.filter((c) => c.cleanedName.startsWith(firstWord))
    if (singleMatches.length > 0) {
      const best = pickLargest(singleMatches)
      return { dirName: best.name, domain: null, layer: 'keyword' }
    }
  }

  return null
}

/**
 * Run all matching layers in priority order. Returns a match result or null.
 */
function matchSponsor(sponsor, centralContacts, directory) {
  // Layer 1: Email domain
  const domainMatch = matchByDomain(centralContacts, directory.domainMap)
  if (domainMatch) return domainMatch

  // Layer 2: Exact cleaned name
  const exactMatch = matchByExactName(sponsor, directory.nameMap)
  if (exactMatch) return exactMatch

  // Layer 3: Core keyword prefix
  const keywordMatch = matchByKeyword(sponsor, directory.prefixIndex)
  if (keywordMatch) return keywordMatch

  // Layer 4: No match
  return null
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function matchSponsors(sponsorsToMatch, existingAltNames, directory) {
  const rowsToInsert = []
  let matchedByLayer = { email_domain: 0, exact_name: 0, keyword: 0 }
  let noMatch = 0

  for (const [sponsorKey, { sponsor, centralContacts }] of sponsorsToMatch) {
    // Skip if this alternate_name already exists in DB (any matched_via)
    if (existingAltNames.has(sponsorKey)) continue

    const result = matchSponsor(sponsor, centralContacts, directory)

    if (result) {
      console.log(`[ClinicalTrialsScan] MATCHED (${result.layer}): "${sponsor}" → "${result.dirName}"${result.domain ? ` via domain ${result.domain}` : ''}`)
      rowsToInsert.push({
        directory_name: result.dirName,
        alternate_name: sponsor,
        matched_via: result.layer,
        domain: result.domain || null,
      })
      // Update in-memory map
      existingAltNames.set(sponsorKey, { directory_name: result.dirName, matched_via: result.layer })

      matchedByLayer[result.layer]++
    } else {
      // Layer 4: No match — insert self-referencing row to prevent reprocessing
      console.log(`[ClinicalTrialsScan] NO MATCH: "${sponsor}"`)
      rowsToInsert.push({
        directory_name: sponsor,
        alternate_name: sponsor,
        matched_via: 'no_match',
        domain: null,
      })
      // Update in-memory map
      existingAltNames.set(sponsorKey, { directory_name: sponsor, matched_via: 'no_match' })
      noMatch++
    }
  }

  // Batch insert
  if (rowsToInsert.length > 0) {
    const BATCH = 500
    let insertErrors = 0

    for (let i = 0; i < rowsToInsert.length; i += BATCH) {
      const batch = rowsToInsert.slice(i, i + BATCH)
      const { error } = await supabase.from('companies_alternate_names').insert(batch)

      if (error) {
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

  const totalMatched = matchedByLayer.email_domain + matchedByLayer.exact_name + matchedByLayer.keyword
  console.log(`[ClinicalTrialsScan] Name matching: ${totalMatched} matched (domain: ${matchedByLayer.email_domain}, exact: ${matchedByLayer.exact_name}, keyword: ${matchedByLayer.keyword}), ${noMatch} no match, ${rowsToInsert.length} rows inserted`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startDateRange = {
    from: formatDateSlash(monthsAgo(1)),
    to: formatDateSlash(yearsAhead(1)),
  }
  console.log(`[ClinicalTrialsScan] Mode: ${mode}, StartDate window: ${startDateRange.from} → ${startDateRange.to}`)

  // Pre-load lookup data for company name matching
  console.log('[ClinicalTrialsScan] Loading company matching data...')
  const [existingAltNames, directory] = await Promise.all([
    loadExistingAlternateNames(),
    loadDirectory(),
  ])
  console.log(`[ClinicalTrialsScan] Loaded ${existingAltNames.size} existing alternate names`)

  // ── Phase 1: Fetch all trials from API ────────────────────────────────────
  let totalFetched = 0
  let phaseFiltered = 0
  let pageNum = 0
  let pageToken = null
  const allTrials = []

  // Collect unique sponsors to match after all pages are processed
  // Map key: lowercase sponsor name, value: { sponsor, centralContacts }
  const sponsorsToMatch = new Map()

  while (true) {
    pageNum++
    const url = buildQueryUrl(startDateRange, pageToken)

    let data
    try {
      data = await fetchPage(url)
    } catch (err) {
      console.error(`[ClinicalTrialsScan] Fatal fetch error on page ${pageNum}: ${err.message}`)
      break
    }

    const studies = data.studies || []
    totalFetched += studies.length

    for (const study of studies) {
      const trial = extractTrial(study)
      if (!trial) { phaseFiltered++; continue }

      allTrials.push(trial)

      // Collect sponsor for matching
      if (trial.lead_sponsor_name) {
        const key = trial.lead_sponsor_name.trim().toLowerCase()
        if (!existingAltNames.has(key)) {
          if (!sponsorsToMatch.has(key)) {
            sponsorsToMatch.set(key, {
              sponsor: trial.lead_sponsor_name,
              centralContacts: trial.central_contacts,
            })
          } else if (trial.central_contacts && extractEmailDomain(trial.central_contacts)) {
            // Upgrade contacts if existing entry has no usable email
            const existing = sponsorsToMatch.get(key)
            if (!extractEmailDomain(existing.centralContacts)) {
              existing.centralContacts = trial.central_contacts
            }
          }
        }
      }
    }

    console.log(`[ClinicalTrialsScan] Page ${pageNum}: ${studies.length} studies fetched, ${allTrials.length} trials collected`)

    if (data.nextPageToken) {
      pageToken = data.nextPageToken
    } else {
      break
    }
  }

  console.log(`\n[ClinicalTrialsScan] === FETCH COMPLETE ===`)
  console.log(`[ClinicalTrialsScan] Total fetched:   ${totalFetched}`)
  console.log(`[ClinicalTrialsScan] Phase filtered: ${phaseFiltered}`)
  console.log(`[ClinicalTrialsScan] Trials to upsert: ${allTrials.length}`)

  // ── Phase 2: Company name matching ────────────────────────────────────────
  console.log(`\n[ClinicalTrialsScan] === COMPANY NAME MATCHING ===`)
  console.log(`[ClinicalTrialsScan] ${sponsorsToMatch.size} new sponsors to match`)

  if (sponsorsToMatch.size > 0) {
    await matchSponsors(sponsorsToMatch, existingAltNames, directory)
  } else {
    console.log('[ClinicalTrialsScan] No new sponsors to match.')
  }

  // ── Phase 3: Build enrichment maps and upsert trials ──────────────────────
  // altNameToDir: lowercase sponsor name → directory_name (excluding no_match)
  const altNameToDir = new Map()
  for (const [altName, info] of existingAltNames) {
    if (info.matched_via !== 'no_match') {
      altNameToDir.set(altName, info.directory_name)
    }
  }

  // dirToSize: exact directory name → company_size
  const dirToSize = directory.sizeMap

  console.log(`\n[ClinicalTrialsScan] === UPSERT WITH ENRICHMENT ===`)
  console.log(`[ClinicalTrialsScan] ${altNameToDir.size} sponsor→company mappings, ${dirToSize.size} company→size mappings`)

  let inserted = 0
  let updated = 0
  let errors = 0

  for (const trial of allTrials) {
    // Enrich with matched_name and company_size
    const sponsorKey = trial.lead_sponsor_name?.trim().toLowerCase()
    const matchedName = sponsorKey ? (altNameToDir.get(sponsorKey) || null) : null
    trial.matched_name = matchedName
    trial.company_size = matchedName ? (dirToSize.get(matchedName) || null) : null

    const result = await upsertTrial(trial)
    switch (result) {
      case 'inserted': inserted++; break
      case 'updated':  updated++;  break
      case 'error':    errors++;   break
    }
  }

  console.log(`\n[ClinicalTrialsScan] === UPSERT COMPLETE ===`)
  console.log(`[ClinicalTrialsScan] Inserted:       ${inserted}`)
  console.log(`[ClinicalTrialsScan] Updated:        ${updated}`)
  console.log(`[ClinicalTrialsScan] Errors:         ${errors}`)

  console.log(`\n[ClinicalTrialsScan] Refreshing company signal summary...`)
  const { error: refreshError } = await supabase.rpc('refresh_company_signal_summary')
  if (refreshError) {
    console.error(`[ClinicalTrialsScan] Failed to refresh company signal summary: ${refreshError.message}`)
  } else {
    console.log(`[ClinicalTrialsScan] Company signal summary refreshed.`)
  }

  console.log(`\n[ClinicalTrialsScan] === ALL DONE ===`)
}

main().catch((err) => {
  console.error('[ClinicalTrialsScan] Unhandled error:', err)
  process.exit(1)
})
