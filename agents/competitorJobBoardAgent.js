import { supabase, upsertCompany } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'
import { createLinkedInClient, shuffleArray } from '../lib/linkedinClient.js'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// 45 life sciences staffing firms. Upserted into competitor_firms when the
// table has fewer than 30 rows. LinkedIn is the sole job source — no career
// pages are scraped.

const COMPETITOR_FIRMS_SEED = [
  { name: 'Actalent' },
  { name: 'Kelly' },
  { name: 'Alku' },
  { name: 'Black Diamond Networks' },
  { name: 'Real Life Sciences' },
  { name: 'Oxford Global Resources' },
  { name: 'The Planet Group' },
  { name: 'Advanced Clinical' },
  { name: 'Randstad' },
  { name: 'Joule Staffing' },
  { name: 'Beacon Hill Staffing Group' },
  { name: 'Net2Source' },
  { name: 'USTech Solutions' },
  { name: 'Yoh Services' },
  { name: 'Soliant Health' },
  { name: 'Medix' },
  { name: 'Epic Staffing Group' },
  { name: 'Solomon Page' },
  { name: 'Spectra Force' },
  { name: 'Mindlance' },
  { name: 'Green Key Resources' },
  { name: 'Phaidon International' },
  { name: 'Peoplelink Group' },
  { name: 'Pacer Staffing' },
  { name: 'ZP Group' },
  { name: 'Meet Staffing' },
  { name: 'Ampcus' },
  { name: 'ClinLab Staffing' },
  { name: 'Adecco' },
  { name: 'Manpower' },
  { name: 'Hays' },
  { name: 'Insight Global' },
  { name: 'Planet Pharma' },
  { name: 'Proclinical' },
  { name: 'Real Staffing' },
  { name: 'GForce Life Sciences' },
  { name: 'EPM Scientific' },
  { name: 'ClinLab Solutions Group' },
  { name: 'Sci.bio' },
  { name: 'Gemini Staffing Consultants' },
  { name: 'Orbis Clinical' },
  { name: 'Scientific Search' },
  { name: 'TriNet Pharma' },
  { name: 'The Fountain Group' },
  { name: 'Hueman RPO' },
]

// CRO / non-staffing firms — jobs posted BY these companies must be skipped even
// if LinkedIn surfaces them in a staffing-firm search.
const CRO_PATTERNS =
  /\b(syneos|fortrea|labcorp|iqvia|propharma|premier\s+research|worldwide\s+clinical|halloran|medpace|ppd\b|parexel|covance|charles\s+river|wuxi|pra\s+health|pharmaceutical\s+product\s+development|icon\s+plc|icon\s+strategic|asgn)\b/i

// Non-US job location filter — skip non-US postings
const NON_US_JOB_LOC =
  /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan)\b/i

// ─── Client-inference helpers ──────────────────────────────────────────────────

// Staffing/recruiting firm patterns — these must be filtered OUT of inference results
const STAFFING_PATTERNS =
  /\b(staffing|recruiting|recruitment|search|talent|workforce|placement|resourcing|executive search|professional services)\b/i

// Academic / non-industry orgs
const ACADEMIC_PATTERNS =
  /university|college|hospital|medical cent(?:er|re)|health system|institute|foundation|children's|memorial|research cent(?:er|re)|\bnih\b|\bcdc\b/i

// Life sciences company indicator (used to score candidates)
const LIFE_SCIENCES_CO =
  /pharma|biotech|therapeutics|biosciences|biologics|genomics|oncology|biopharma|biopharmaceutical|medtech|diagnostics/i

// Regexp that matches title segments (dash-separated) that contain location / phase / modifier noise
const TITLE_NOISE_RE =
  /\b(?:remote|us.based|home.based|telecommute|nationwide|multiple locations|phase\s+[IVX]+|fsp|full.service|hybrid|onsite|on.site|contract|travel|global|americas)\b|\b[A-Z][a-z]{3,},\s*[A-Z]{2}\b/i

/**
 * Strip location, phase, and modifier noise from a staffing job title so it can
 * be used as a LinkedIn cross-reference search query.
 *
 * Removes: dash-separated location/phase segments, parenthetical text, trailing
 * roman numerals, and the competitor firm name. Appends "pharmaceutical" for context.
 *
 * @param {string} title
 * @param {string} competitorName
 * @returns {string}
 */
function cleanJobTitle(title, competitorName) {
  if (!title) return 'clinical research pharmaceutical'

  // Split on em-dash / en-dash / hyphen separators, keep substantive segments
  const segments = title.split(/\s*[-–—]\s*/).filter(seg => {
    const s = seg.trim()
    if (!s) return false
    if (TITLE_NOISE_RE.test(s)) return false           // location, phase, FSP, etc.
    if (/^[IVX]{1,4}$/.test(s)) return false           // pure roman numeral segment
    return true
  })

  let cleaned = segments.join(' ')

  // Remove parenthetical text: (Remote), (Contract), (FSP), etc.
  cleaned = cleaned.replace(/\([^)]+\)/g, '')

  // Remove trailing roman numerals: "CRA II" → "CRA"
  cleaned = cleaned.replace(/\s+(?:I{1,3}|IV|VI{0,3})\s*$/, '')

  // Remove the competitor firm's first significant word (prevents it showing up in results)
  if (competitorName) {
    const firstSigWord = competitorName.split(/\s+/).find(w => w.length > 4)
    if (firstSigWord) {
      cleaned = cleaned.replace(
        new RegExp(`\\b${firstSigWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '',
      )
    }
  }

  // Normalize
  cleaned = cleaned.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim()

  // Append pharma context for LinkedIn's relevance ranking
  if (!/pharma|biotech|therapeutics|clinical/i.test(cleaned)) cleaned += ' pharmaceutical'

  return cleaned.trim() || 'clinical research pharmaceutical'
}

/**
 * Score a LinkedIn search result as a candidate end client for our competitor signal.
 *
 * @param {object} p
 * @param {string} p.candidateCompany   - Company name from LinkedIn result
 * @param {string} p.candidateTitle     - Job title from LinkedIn result
 * @param {string} p.candidateLocation  - Location from LinkedIn result
 * @param {string} p.originalTitle      - The staffing job title
 * @param {string} p.originalLocation   - The staffing job location
 * @param {Set<string>} p.knownCompanyNames - Lowercased company names from BioSignal DB
 * @returns {number}
 */
function scoreCandidate({ candidateCompany, candidateTitle, candidateLocation, originalTitle, originalLocation, knownCompanyNames }) {
  let score = 0

  // +1 for life-sciences company name
  if (LIFE_SCIENCES_CO.test(candidateCompany)) score += 1

  // +3 for job-title keyword overlap (at least 2 shared tokens ≥ 5 chars)
  const origTokens = new Set(
    originalTitle.toLowerCase().split(/\W+/).filter(t => t.length >= 5),
  )
  const overlap = (candidateTitle || '').toLowerCase().split(/\W+/)
    .filter(t => t.length >= 5 && origTokens.has(t)).length
  if (overlap >= 2) score += 3
  else if (overlap >= 1) score += 1

  // +3 for location overlap (any token ≥ 4 chars in common)
  if (originalLocation && candidateLocation) {
    const origTokens2 = originalLocation.toLowerCase().split(/\W+/).filter(t => t.length >= 4)
    const candLoc = candidateLocation.toLowerCase()
    if (origTokens2.some(t => candLoc.includes(t))) score += 3
  }

  // +2 for known company already in BioSignal DB
  const normCand = candidateCompany.toLowerCase().replace(/[,.]/g, '').replace(/\s+/g, ' ').trim()
  const isKnown = knownCompanyNames.has(normCand) ||
    [...knownCompanyNames].some(n => n.length >= 8 && normCand.startsWith(n.slice(0, 8)))
  if (isKnown) score += 2

  return score
}

/**
 * Try to infer the end client from the job description text alone (no extra requests).
 * Looks for phrases like "on behalf of [Company]", "our client", "end client:".
 * Falls back to checking if any known BioSignal company appears in the description.
 *
 * @param {string}       description
 * @param {string}       competitorName
 * @param {Set<string>}  knownCompanyNames  Lowercased names from companies table
 * @returns {{ inferred_client, client_confidence, client_inference_method }|null}
 */
function inferClientFromDescription(description, competitorName, knownCompanyNames) {
  if (!description) return null
  const filerPrefix = (competitorName || '').toLowerCase().slice(0, 8)

  const highConfidencePatterns = [
    /\bon\s+behalf\s+of\s+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[.,\(]|$)/,
    /end\s+client\s*:?\s+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[.,\(]|$)/i,
    /client\s*:\s+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[.,\(]|$)/i,
    /our\s+client[,\s]+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[,.\(]|is\b|has\b)/,
    /placing\s+a\s+\w+\s+with\s+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[.,\(]|$)/i,
    /opportunity\s+with\s+([A-Z][A-Za-z0-9\s&,.\-]+?)(?:\s*[.,\(]|$)/i,
  ]
  for (const pat of highConfidencePatterns) {
    const m = description.match(pat)
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 80)
      if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix) && LIFE_SCIENCES_CO.test(name)) {
        return { inferred_client: name, client_confidence: 'High', client_inference_method: 'description_explicit' }
      }
    }
  }

  // Fallback: known company name anywhere in description
  const descLower = description.toLowerCase()
  for (const compName of knownCompanyNames) {
    if (compName.length >= 6 && descLower.includes(compName)) {
      const idx = descLower.indexOf(compName)
      const rawName = description.slice(idx, idx + compName.length)
      return { inferred_client: rawName, client_confidence: 'Low', client_inference_method: 'description_company_match' }
    }
  }

  return null
}

/**
 * Infer the end client via a LinkedIn cross-reference search.
 * Searches for similar open roles at NON-staffing companies; the company posting
 * the most-matching role is likely the end client.
 *
 * @param {object}       linkedin          LinkedInClient instance
 * @param {string}       jobTitle          Original job title
 * @param {string}       location          Job location
 * @param {string}       competitorName    Staffing firm name
 * @param {Set<string>}  knownCompanyNames Lowercased names from BioSignal DB
 * @param {Set<string>}  staffingNames     Lowercased staffing firm names to exclude
 * @returns {Promise<{ inferred_client, client_confidence, client_inference_method }|null>}
 */
async function inferClientViaLinkedIn(linkedin, jobTitle, location, competitorName, knownCompanyNames, staffingNames) {
  if (!linkedin?.isAvailable) return null

  const searchQuery = cleanJobTitle(jobTitle, competitorName)
  console.log(`[ClientInference] LinkedIn query: "${searchQuery}"`)

  let results
  try {
    // No time-range filter and sort by Relevance to get best title matches
    results = await linkedin.searchJobs(searchQuery, null, '')
  } catch (err) {
    console.log(`[ClientInference] Search threw: ${err.message}`)
    return null
  }
  if (linkedin.botDetected || !results?.length) return null

  const competitorPrefix = (competitorName || '').toLowerCase().slice(0, 8)
  const scored = []

  for (const r of results) {
    const company = (r.company || '').trim()
    if (!company) continue
    const compLower = company.toLowerCase()

    // Must not be a staffing firm
    if ([...staffingNames].some(n => n.length >= 6 && (compLower.includes(n.slice(0, 8)) || n.startsWith(compLower.slice(0, 8))))) continue
    if (STAFFING_PATTERNS.test(company)) continue
    // Must not be academic
    if (ACADEMIC_PATTERNS.test(company)) continue
    // Must not be the competitor itself
    if (compLower.startsWith(competitorPrefix)) continue

    const score = scoreCandidate({
      candidateCompany:  company,
      candidateTitle:    r.title || '',
      candidateLocation: r.location || '',
      originalTitle:     jobTitle,
      originalLocation:  location,
      knownCompanyNames,
    })
    if (score > 0) scored.push({ company, score })
  }

  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const confidence = best.score >= 6 ? 'High' : best.score >= 3 ? 'Medium' : 'Low'
  console.log(`[ClientInference] Best match: "${best.company}" score=${best.score} confidence=${confidence}`)
  return { inferred_client: best.company, client_confidence: confidence, client_inference_method: 'linkedin_cross_reference' }
}

// ─── Shared signal helpers ─────────────────────────────────────────────────────

async function signalExists(companyId, signalType, sourceUrl) {
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', signalType)
    .eq('source_url', sourceUrl)
    .maybeSingle()
  return !!data
}

// ─── Competitor firm seeding ───────────────────────────────────────────────────
// Ensures competitor_firms table is populated. Runs only when row count < 30.

async function seedCompetitorFirms() {
  const { count } = await supabase
    .from('competitor_firms')
    .select('*', { count: 'exact', head: true })

  if (count >= 30) return { seeded: 0, skipped: 0, skippedFirms: [] }

  let seeded = 0
  let skipped = 0
  const skippedFirms = []

  for (const firm of COMPETITOR_FIRMS_SEED) {
    const { data: existing } = await supabase
      .from('competitor_firms')
      .select('id')
      .ilike('name', firm.name)
      .maybeSingle()

    if (existing) {
      await supabase.from('competitor_firms').update({ is_active: true }).eq('id', existing.id)
      seeded++
    } else {
      const { error } = await supabase
        .from('competitor_firms')
        .insert({ name: firm.name, is_active: true })
      if (error) {
        skippedFirms.push({ name: firm.name, reason: error.message })
        skipped++
      } else {
        seeded++
      }
    }
  }

  return { seeded, skipped, skippedFirms }
}

// Description fetching is handled by client.fetchJobDescription() which uses
// the /jobs-guest/jobs/api/jobPosting/{jobId} guest API endpoint.

// ─── Persist a single competitor activity signal ───────────────────────────────

async function persistCompetitorSignal(firmName, jobUrl, jobTitle, jobLocation, jobDescription = '', clientData = {}) {
  if (jobLocation && NON_US_JOB_LOC.test(jobLocation)) {
    console.log(`[competitorJobBoard] FILTERED (non-US): "${jobLocation}" — ${jobTitle}`)
    return false
  }

  const firmCompany = await upsertCompany(supabase, { name: firmName })
  if (!firmCompany) return false

  // Dedup key: job URL + title slug per ISO week
  const titleSlug = jobTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
  const weekNum   = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${jobUrl || 'https://biosignal.app'}#${titleSlug}-week-${weekNum}`
  const exists    = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id:      firmCompany.id,
    signal_type:     'competitor_job_posting',
    signal_summary:  `${firmName}: "${jobTitle}"`,
    signal_detail: {
      job_title:               jobTitle,
      job_location:            jobLocation,
      posting_date:            today,
      competitor_firm:         firmName,
      job_url:                 jobUrl || '',
      job_description:         jobDescription,
      ats_source:              'linkedin',
      inferred_client:         clientData.inferred_client         || null,
      client_confidence:       clientData.client_confidence       || null,
      client_inference_method: clientData.client_inference_method || null,
    },
    source_url:         sourceUrl,
    source_name:        'LinkedIn',
    first_detected_at:  new Date().toISOString(),
    status:             'new',
    priority_score:     15,
    score_breakdown:    { signal_strength: 15 },
    days_in_queue:      0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`Signal insert failed for ${firmName}: ${error.message}`)
    return false
  }
  return true
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function run() {
  const { data: runEntry } = await supabase
    .from('agent_runs')
    .insert({
      agent_name:  'competitor-job-board-agent',
      status:      'running',
      started_at:  new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0

  try {
    // ── Step 1: Seed competitor firms table if needed ────────────────────────
    const seedResult = await seedCompetitorFirms()
    console.log(`Competitor seed: ${seedResult.seeded} upserted, ${seedResult.skipped} skipped`)

    // ── Step 2: Load active firms from DB and shuffle order ─────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = shuffleArray(allFirms || [])
    console.log(`[CompetitorJobs] Processing ${firmsToCheck.length} active firms (shuffled) — LinkedIn only`)

    // Build a Set of staffing firm names for client-inference filtering
    const staffingNames = new Set(COMPETITOR_FIRMS_SEED.map(f => f.name.toLowerCase()))
    if (allFirms) allFirms.forEach(f => staffingNames.add(f.name.toLowerCase()))

    // Load known company names from BioSignal DB for scoring/description matching
    // (best-effort — if it fails, inference continues without known-company bonus)
    const knownCompanyNames = new Set()
    try {
      const { data: companies } = await supabase.from('companies').select('name').limit(2000)
      for (const c of companies || []) {
        if (c.name) knownCompanyNames.add(c.name.toLowerCase().replace(/[,.]/g, '').replace(/\s+/g, ' ').trim())
      }
      console.log(`[CompetitorJobs] Loaded ${knownCompanyNames.size} known companies for client inference`)
    } catch (err) {
      console.log(`[CompetitorJobs] Could not load known companies: ${err.message}`)
    }

    // ── Step 3: Initialise LinkedIn client — budget: 100 requests ───────────
    // Budget breakdown (approx per run):
    //   ~30 searchJobs calls (one per firm)
    //   ~30 fetchJobDescription calls (1 per qualifying job)
    //   ~20 inferClientViaLinkedIn cross-reference searches
    //   Total: ~80 — fits in budget of 100
    const linkedin = createLinkedInClient(100)
    if (!linkedin) {
      console.log('[CompetitorJobs] LinkedIn unavailable — nothing to do')
      await supabase.from('agent_runs').update({
        status: 'completed', completed_at: new Date().toISOString(), signals_found: 0,
        run_detail: { firms_checked: 0, linkedin_available: false },
      }).eq('id', runId)
      return { signalsFound: 0, requestsUsed: 0, firmsChecked: 0, seedResult }
    }

    // Rotate through 8 short role keywords — one per firm, cycling by index.
    // Short single-keyword queries avoid LinkedIn's multi-keyword matching failures
    // that produce empty pages. Over 8 daily runs, every firm gets every keyword.
    const ROLE_KEYWORD_ROTATION = [
      'CRA',
      'clinical research',
      'regulatory affairs',
      'biostatistician',
      'clinical trial',
      'medical affairs',
      'quality assurance',
      'data management',
    ]
    let firmsChecked = 0
    let firmIndex = 0
    let totalClientInferences = 0  // cap LinkedIn client-inference at 20 per run

    // ── Step 4: LinkedIn search for each firm — no career page fetching ──────
    for (const firm of firmsToCheck) {
      if (!linkedin.isAvailable) break
      if (linkedin.requestsUsed >= 100) {
        console.log(`[CompetitorJobs] Budget exhausted (${linkedin.requestsUsed} requests used)`)
        break
      }

      firmsChecked++
      const singleKeyword = ROLE_KEYWORD_ROTATION[firmIndex % ROLE_KEYWORD_ROTATION.length]
      firmIndex++
      console.log(`[CompetitorJobs] Querying "${firm.name} ${singleKeyword}"`)
      const liJobs = await linkedin.searchJobs(singleKeyword, firm.name)

      if (linkedin.botDetected) {
        console.log('[CompetitorJobs] Bot detected — stopping for today')
        break
      }

      let liInserted = 0
      for (const job of liJobs.slice(0, 3)) {
        if (!matchesRoleKeywords(job.title)) continue
        if (NON_US_JOB_LOC.test(job.location)) continue

        // Skip jobs posted BY a CRO/non-staffing company (LinkedIn sometimes
        // surfaces CRO postings when searching for a staffing firm's keyword)
        if (job.company && CRO_PATTERNS.test(job.company)) {
          console.log(`[CompetitorJobs] FILTERED (CRO): "${job.company}" — ${job.title}`)
          continue
        }

        // Fetch description via guest API (/jobs-guest/jobs/api/jobPosting/{id})
        let description = ''
        if (job.jobUrl && linkedin.isAvailable) {
          description = await linkedin.fetchJobDescription(job.jobUrl)
          if (linkedin.botDetected) {
            console.log('[CompetitorJobs] Bot detected during description fetch — stopping for today')
            break
          }
        }

        // ── Client inference ──────────────────────────────────────────────────
        // Step 1: Try LinkedIn cross-reference (only for first 20 signals, budget permitting)
        let clientData = null
        if (totalClientInferences < 20 && linkedin.isAvailable && linkedin.requestsUsed < 85) {
          clientData = await inferClientViaLinkedIn(
            linkedin, job.title, job.location || '', firm.name, knownCompanyNames, staffingNames,
          )
          if (clientData) totalClientInferences++
          if (linkedin.botDetected) break
        }
        // Step 2: Fallback — parse description text (no extra request)
        if (!clientData) {
          clientData = inferClientFromDescription(description, firm.name, knownCompanyNames)
        }
        if (clientData) {
          console.log(`[CompetitorJobs] Client inferred: "${clientData.inferred_client}" (${clientData.client_confidence}, ${clientData.client_inference_method})`)
        }

        const inserted = await persistCompetitorSignal(
          firm.name, job.jobUrl || '', job.title, job.location || '', description, clientData || {},
        )
        if (inserted) { signalsFound++; liInserted++ }
      }

      console.log(`${firm.name}: ${liInserted} LinkedIn signals saved`)
      if (linkedin.botDetected) break
    }

    const requestsUsed = linkedin.requestsUsed

    await supabase.from('agent_runs').update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      signals_found: signalsFound,
      run_detail: {
        firms_checked:          firmsChecked,
        total_active_firms:     allFirms?.length ?? 0,
        linkedin_requests_used: requestsUsed,
        linkedin_bot_detected:  linkedin.botDetected,
        seed_result: {
          seeded:        seedResult.seeded,
          skipped:       seedResult.skipped,
          skipped_firms: seedResult.skippedFirms,
        },
      },
    }).eq('id', runId)

    console.log(
      `[CompetitorJobs] Complete — ${requestsUsed} requests used, ${signalsFound} signals saved`
    )

    return { signalsFound, requestsUsed, firmsChecked, seedResult }
  } catch (err) {
    await supabase.from('agent_runs').update({
      status:        'failed',
      completed_at:  new Date().toISOString(),
      error_message: err.message,
    }).eq('id', runId)
    throw err
  }
}
