/**
 * Funding & M&A Agent
 *
 * Monitors five funding sources for INDUSTRY life sciences companies and emits
 * BD signals for grants, M&A, partnerships, IPOs, and venture rounds.
 *
 * Sources:
 *   1. NIH Reporter — SBIR/STTR grants (6-month window)
 *   2. SEC EDGAR 8-K — M&A filings
 *   3. SEC EDGAR 8-K — Pharma partnership / licensing filings
 *   4. SEC EDGAR S-1 — IPO filings
 *   5. SEC EDGAR Form D — Venture capital rounds
 *
 * Only INDUSTRY companies are flagged. Universities, academic medical centers,
 * hospitals, government agencies, and foundations are excluded.
 */

import { supabase } from '../lib/supabase.js';

// ── External API base URLs ────────────────────────────────────────────────────

const NIH_REPORTER_API = 'https://api.reporter.nih.gov/v2/projects/search';
const SEC_EDGAR_SEARCH  = 'https://efts.sec.gov/LATEST/search-index';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 180;           // 6-month window for all sources
const FETCH_TIMEOUT_MS = 10000;      // AbortSignal timeout for all fetches
const SEC_RATE_LIMIT_MS = 200;       // Delay between SEC EDGAR requests

// Patterns that identify non-industry (academic/government) organisations.
// Applied to ALL five funding sources. When matched, the organisation is
// logged and excluded — we only staff into industry.
const ACADEMIC_PATTERNS =
  /university|universite|college|hospital|medical center|health system|health centre|institute of|school of|foundation|academy|academie|NIH\b|NCI\b|FDA\b|NHLBI\b|national institute|national cancer|national heart|department of|children's|childrens|memorial|baptist|methodist|presbyterian|kaiser|mayo clinic|cleveland clinic|johns hopkins|\bmit\b|caltech|stanford|harvard|yale\b|columbia university|university of pennsylvania|duke university|vanderbilt|emory university|\.edu\b/i;

// Industry entity indicators — at least one must be present for SEC-sourced
// companies that would otherwise match no academic keyword (belt-and-suspenders).
const INDUSTRY_INDICATORS =
  /\b(inc\.|inc\b|corp\.|corp\b|llc\b|ltd\.|ltd\b|co\.\b|gmbh\b|\bag\b|\bnv\b|\bplc\b|therapeutics|biosciences|bioscience|pharmaceuticals|pharmaceutical|pharma\b|biotech\b|biopharma|biopharmaceutical|genomics|biologics|medical devices?|diagnostics|oncology|clinical|lifesciences|life sciences)\b/i;

// Life sciences keyword filter for SEC filings (company names and filing text)
const LIFE_SCIENCES_PATTERNS =
  /pharma|biotech|therapeutics|biosciences|biologics|genomics|oncology|clinical|CRO|medtech|medical device|diagnostics|biopharma|biopharmaceutical|life sciences/i;

// Patterns to detect VC fund entities that should not be signal targets
const VC_FUND_PATTERNS =
  /\bfund\b|\bcapital\b|\bventures\b|\bpartners\b|\bmanagement\b|\binvestments\b/i;

// Large pharma indicators used when finding the smaller biotech in partnerships
const LARGE_PHARMA_PATTERNS =
  /\bpharma\b.*\bplc\b|\binc\b.*\bpharm|\bsanofi\b|\bpfizer\b|\broche\b|\bnovartis\b|\bmerck\b|\babbvie\b|\bastrazene\b|\beli lilly\b|\bbristol.myers\b/i;

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Format a Date as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns a Date object N days before now.
 * @param {number} days
 * @returns {Date}
 */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Pause execution for a given number of milliseconds.
 * Used for SEC EDGAR rate-limiting.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Industry / life sciences filters ─────────────────────────────────────────

/**
 * Returns true if the organisation name is an industry entity
 * (biotech, pharma, CRO, etc.) rather than academic or government.
 * Logs every exclusion so the filter can be verified in Vercel logs.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isIndustryOrg(name) {
  if (ACADEMIC_PATTERNS.test(name)) {
    console.log(`[fundingMaAgent] FILTERED (academic): ${name}`);
    return false;
  }
  return true;
}

/**
 * Stricter industry check used for SEC EDGAR sources.
 * Requires at least one explicit industry-entity indicator in the name,
 * unless the name is short and clearly a company (e.g. "Moderna").
 * All academic-pattern matches are always rejected.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isIndustryOrgSec(name) {
  if (!name) return false;
  if (ACADEMIC_PATTERNS.test(name)) {
    console.log(`[fundingMaAgent] FILTERED (academic/SEC): ${name}`);
    return false;
  }
  // Accept names that have an explicit industry indicator
  if (INDUSTRY_INDICATORS.test(name)) return true;
  // Accept short names (≤3 words) that don't match any academic keyword —
  // these are typically company brand names (e.g. "Gilead", "Moderna")
  const wordCount = name.trim().split(/\s+/).length;
  if (wordCount <= 3) return true;
  // Longer names with no industry indicator and no academic keyword — reject
  console.log(`[fundingMaAgent] FILTERED (no industry indicator, long name): ${name}`);
  return false;
}

/**
 * Returns true if the text suggests a life sciences context.
 * Used as a secondary filter on SEC filing text and entity names.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isLifeSciences(text) {
  return LIFE_SCIENCES_PATTERNS.test(text);
}

// ── Amount extraction ─────────────────────────────────────────────────────────

/**
 * Extract the first dollar-amount mention from a block of text.
 * Returns a formatted string like "$45M", "$1.2B", or null.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractAmount(text) {
  if (!text) return null;

  const match = text.match(/\$\s*(\d[\d.,]*)\s*(million|billion|M|B)\b/i);
  if (!match) return null;

  const raw = match[1].replace(/,/g, '');
  const unit = match[2].toLowerCase();
  const suffix = unit === 'billion' || unit === 'b' ? 'B' : 'M';

  return `$${raw}${suffix}`;
}

// ── Database helpers ──────────────────────────────────────────────────────────

/**
 * Upsert a company into the companies table.
 * On conflict on 'name', returns the existing row.
 *
 * @param {string} name
 * @returns {Promise<object|null>} Row with id and name, or null on error
 */
async function upsertCompany(name) {
  const { data, error } = await supabase
    .from('companies')
    .upsert({ name, industry: 'Life Sciences' }, { onConflict: 'name' })
    .select('id, name')
    .maybeSingle();

  if (error) {
    console.error(`[fundingMaAgent] upsertCompany failed for "${name}":`, error.message);
    return null;
  }

  return data;
}

/**
 * Check whether a signal already exists for the given company, type, and URL.
 *
 * @param {string} companyId
 * @param {string} signalType
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function signalExists(companyId, signalType, url) {
  const { data: existing, error } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', signalType)
    .eq('source_url', url)
    .maybeSingle();

  if (error) {
    console.error('[fundingMaAgent] signalExists query error:', error.message);
    return false;
  }

  return existing !== null;
}

/**
 * Query the job_postings table for active postings matching a company name.
 * Returns false (no active jobs) if the table doesn't exist or the query fails.
 *
 * @param {string} companyName
 * @returns {Promise<boolean>}
 */
async function checkHasActiveJobs(companyName) {
  try {
    const { data, error } = await supabase
      .from('job_postings')
      .select('id')
      .ilike('company_name', `%${companyName}%`)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (error) {
      // Table might not exist — treat as no active jobs
      return false;
    }

    return data !== null;
  } catch {
    return false;
  }
}

/**
 * Adjust a base priority score based on whether active job postings exist.
 *
 * Pre-hiring (no active jobs):  +15 points
 * Active jobs present:          -15 points (floor of 5)
 *
 * @param {number} baseScore
 * @param {boolean} preHiring - true means NO active jobs (pre-hiring signal)
 * @returns {number}
 */
function calcPriorityScore(baseScore, preHiring) {
  if (preHiring) {
    return baseScore + 15;
  }
  return Math.max(5, baseScore - 15);
}

/**
 * Insert a signal row into the signals table.
 *
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
async function insertSignal(payload) {
  const { error } = await supabase.from('signals').insert(payload);

  if (error) {
    console.error('[fundingMaAgent] insertSignal error:', error.message);
    return false;
  }

  return true;
}

/**
 * Create an agent_runs row and return its ID.
 *
 * @returns {Promise<string|null>}
 */
async function createAgentRun() {
  const { data, error } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'fundingMaAgent',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[fundingMaAgent] createAgentRun error:', error.message);
    return null;
  }

  return data?.id ?? null;
}

/**
 * Finalise an agent_runs row with status, signal count, and optional error.
 *
 * @param {string|null} runId
 * @param {'completed'|'failed'} status
 * @param {number} signalsFound
 * @param {string|null} errorMessage
 */
async function finaliseAgentRun(runId, status, signalsFound, errorMessage = null) {
  if (!runId) return;

  const update = {
    status,
    signals_found: signalsFound,
    finished_at: new Date().toISOString(),
  };

  if (errorMessage) update.error_message = errorMessage;

  const { error } = await supabase.from('agent_runs').update(update).eq('id', runId);

  if (error) {
    console.error('[fundingMaAgent] finaliseAgentRun error:', error.message);
  }
}

// ── Pre-hiring signal helper ──────────────────────────────────────────────────

/**
 * Evaluate the pre-hiring status for a company and build the signal detail
 * additions and score adjustment.
 *
 * @param {string} companyName
 * @param {number} baseScore
 * @returns {Promise<{ adjustedScore: number, preHiringDetail: object }>}
 */
async function evalPreHiring(companyName, baseScore) {
  const hasActiveJobs = await checkHasActiveJobs(companyName);
  const preHiring = !hasActiveJobs;
  const adjustedScore = calcPriorityScore(baseScore, preHiring);

  return {
    adjustedScore,
    preHiringDetail: {
      has_active_jobs: hasActiveJobs,
      pre_hiring_signal: preHiring,
    },
  };
}

// ── Source 1: NIH SBIR/STTR grants ───────────────────────────────────────────

/**
 * Fetch NIH SBIR/STTR grant awards from the NIH Reporter API.
 * Restricted to small-business org types to ensure industry-only results.
 *
 * @param {string} sixMonthsAgo - YYYY-MM-DD
 * @param {string} today - YYYY-MM-DD
 * @param {number} currentYear
 * @returns {Promise<object[]>} Array of project objects
 */
async function fetchNihGrants(sixMonthsAgo, today, currentYear) {
  const body = {
    criteria: {
      fiscal_years: [currentYear, currentYear - 1],
      activity_codes: ['R43', 'R44', 'R41', 'R42', 'U43', 'U44'],
      award_notice_date: { from_date: sixMonthsAgo, to_date: today },
      org_types: ['SMALL BUSINESS'],
    },
    limit: 50,
    offset: 0,
    sort_field: 'award_notice_date',
    sort_order: 'desc',
  };

  const response = await fetch(NIH_REPORTER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`NIH Reporter API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.results || [];
}

/**
 * Process NIH SBIR/STTR grants and emit funding signals.
 *
 * @param {string} sixMonthsAgo
 * @param {string} today
 * @param {number} currentYear
 * @returns {Promise<number>} Signals inserted
 */
async function processNihGrants(sixMonthsAgo, today, currentYear) {
  let signalsInserted = 0;
  let projects;

  try {
    projects = await fetchNihGrants(sixMonthsAgo, today, currentYear);
  } catch (err) {
    console.error('[fundingMaAgent] NIH grant fetch failed:', err.message);
    return 0;
  }

  console.log(`[fundingMaAgent] NIH: Fetched ${projects.length} grant projects.`);

  for (const project of projects) {
    const orgName = project.organization?.org_name || project.org_name || '';
    const activityCode = project.activity_code || '';
    const totalCost = project.award_amount || project.total_cost || null;
    const projectTitle = project.project_title || '';
    const awardDate = project.award_notice_date || project.project_start_date || today;
    const nctId = project.project_num || '';

    // Check .edu domain from organization website field
    const orgWebsite = project.organization?.org_url || project.org_url || '';
    if (orgWebsite && orgWebsite.includes('.edu')) {
      console.log(`[fundingMaAgent] FILTERED (edu domain): ${orgName} [${orgWebsite}]`);
      continue;
    }

    if (!orgName || !isIndustryOrg(orgName)) continue;

    // R43, R41, U43 are new (Phase I) awards; R44, R42, U44 are renewals
    const NEW_CODES = ['R43', 'R41', 'U43'];
    const signalType = NEW_CODES.includes(activityCode) ? 'funding_new_award' : 'funding_renewal';
    const baseScore = 20;

    const fundingAmount = totalCost ? `$${Math.round(totalCost / 1000)}K` : null;
    const fundingSummary = `${orgName} received NIH ${activityCode} grant${fundingAmount ? ` of ${fundingAmount}` : ''} for: ${projectTitle}`;
    const sourceUrl = `https://reporter.nih.gov/project-details/${encodeURIComponent(nctId)}`;

    const company = await upsertCompany(orgName);
    if (!company) continue;

    const alreadyExists = await signalExists(company.id, signalType, sourceUrl);
    if (alreadyExists) continue;

    const { adjustedScore, preHiringDetail } = await evalPreHiring(orgName, baseScore);

    const signalSummaryLabel = preHiringDetail.pre_hiring_signal
      ? ' — Pre-hiring signal'
      : '';

    const detail = {
      company_name: orgName,
      funding_type: 'government_grant',
      funding_amount: fundingAmount,
      funding_summary: fundingSummary,
      date_announced: awardDate,
      source_url: sourceUrl,
      activity_code: activityCode,
      project_title: projectTitle,
      ...preHiringDetail,
    };

    const inserted = await insertSignal({
      company_id: company.id,
      signal_type: signalType,
      priority_score: adjustedScore,
      signal_summary: `${fundingSummary}${signalSummaryLabel}`,
      signal_detail: detail,
      source_url: sourceUrl,
      detected_at: new Date().toISOString(),
    });

    if (inserted) signalsInserted++;
  }

  return signalsInserted;
}

// ── Source 2: SEC EDGAR 8-K M&A filings ──────────────────────────────────────

/**
 * Fetch 8-K filings matching M&A keywords from SEC EDGAR full-text search.
 *
 * @param {string} query - URL-encoded search query string
 * @param {string} startdt - YYYY-MM-DD
 * @param {string} enddt - YYYY-MM-DD
 * @returns {Promise<object[]>} Array of EDGAR filing hits
 */
async function fetchEdgarFilings(query, startdt, enddt, forms = '8-K') {
  const params = new URLSearchParams({
    q: query,
    dateRange: 'custom',
    startdt,
    enddt,
    forms,
  });

  const url = `${SEC_EDGAR_SEARCH}?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BioSignal-BD-Platform contact@biosignal.io' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`SEC EDGAR API error: ${response.status} ${response.statusText} for ${url}`);
  }

  const data = await response.json();
  return data.hits?.hits || [];
}

/**
 * Extract the entity name from a SEC EDGAR filing hit.
 *
 * The EDGAR search-index API returns display_names as an array of strings:
 * "COMPANY NAME  (TICKER)  (CIK 0001234567)"
 * The entity_name field is null in the search-index endpoint.
 *
 * @param {object} hit - EDGAR search hit object
 * @returns {string}
 */
function extractEntityName(hit) {
  const displayNames = hit._source?.display_names || [];
  const raw = hit._source?.entity_name ||
    (typeof displayNames[0] === 'string' ? displayNames[0] :
     displayNames[0]?.name || '');
  // Strip ticker symbols and CIK parentheticals:
  // "BIOMARIN PHARMACEUTICAL INC  (BMRN)  (CIK 0001477720)" → "BIOMARIN PHARMACEUTICAL INC"
  return raw.replace(/\s*\([^)]*\)\s*/g, '').trim();
}

/**
 * Construct a EDGAR filing URL from accession number and CIK.
 * Falls back to a company search URL if fields are missing.
 *
 * @param {object} hit - EDGAR search hit object
 * @param {string} entityName - Cleaned entity name for fallback URL
 * @param {string} formType - Form type for fallback URL (e.g. '8-K', 'S-1', 'D')
 * @returns {string}
 */
function buildFilingUrl(hit, entityName, formType) {
  const adsh = hit._source?.adsh || '';
  const ciks = hit._source?.ciks || [];
  const cik = ciks[0] ? parseInt(ciks[0], 10) : null;

  if (adsh && cik) {
    const adshNoDash = adsh.replace(/-/g, '');
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDash}/`;
  }

  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(entityName)}&type=${encodeURIComponent(formType)}&dateb=&owner=include&count=40`;
}

/**
 * Process SEC EDGAR 8-K M&A filings and emit acquirer + acquired signals.
 *
 * @param {string} sixMonthsAgo
 * @param {string} today
 * @returns {Promise<number>} Signals inserted
 */
async function processMaFilings(sixMonthsAgo, today) {
  let signalsInserted = 0;
  const MA_BASE_SCORE = 27;

  const queries = [
    '"acquisition" "merger"',
    '"acquires" "definitive agreement"',
  ];

  for (const query of queries) {
    await sleep(SEC_RATE_LIMIT_MS);

    let hits;
    try {
      hits = await fetchEdgarFilings(query, sixMonthsAgo, today, '8-K');
    } catch (err) {
      console.error('[fundingMaAgent] M&A EDGAR fetch failed:', err.message);
      continue;
    }

    console.log(`[fundingMaAgent] M&A: "${query}" → ${hits.length} hits`);

    for (const hit of hits) {
      const entityName = extractEntityName(hit);
      const fileDate = hit._source?.file_date || today;
      const filingText = hit._source?.period_of_report || '';
      const filingUrl = buildFilingUrl(hit, entityName, '8-K');

      if (!entityName || !isIndustryOrgSec(entityName)) continue;
      if (!isLifeSciences(entityName) && !isLifeSciences(filingText)) continue;

      const dealAmount = extractAmount(filingText);

      // Emit acquirer signal
      const acquirerCompany = await upsertCompany(entityName);
      if (acquirerCompany) {
        const acquirerAlreadyExists = await signalExists(acquirerCompany.id, 'ma_acquirer', filingUrl);
        if (!acquirerAlreadyExists) {
          const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, MA_BASE_SCORE);

          const detail = {
            company_name: entityName,
            funding_type: 'ma',
            funding_amount: dealAmount,
            funding_summary: `${entityName} announced an acquisition or merger${dealAmount ? ` valued at ${dealAmount}` : ''}.`,
            date_announced: fileDate,
            source_url: filingUrl,
            ...preHiringDetail,
          };

          const inserted = await insertSignal({
            company_id: acquirerCompany.id,
            signal_type: 'ma_acquirer',
            priority_score: adjustedScore,
            signal_summary: `${entityName} is acquiring in life sciences M&A${dealAmount ? ` (${dealAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
            signal_detail: detail,
            source_url: filingUrl,
            detected_at: new Date().toISOString(),
          });

          if (inserted) signalsInserted++;
        }
      }

      // Emit acquired signal (same company, different signal type)
      if (acquirerCompany) {
        const acquiredAlreadyExists = await signalExists(acquirerCompany.id, 'ma_acquired', filingUrl);
        if (!acquiredAlreadyExists) {
          const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, MA_BASE_SCORE);

          const detail = {
            company_name: entityName,
            funding_type: 'ma',
            funding_amount: dealAmount,
            funding_summary: `${entityName} is a party in an M&A transaction${dealAmount ? ` valued at ${dealAmount}` : ''}.`,
            date_announced: fileDate,
            source_url: filingUrl,
            ...preHiringDetail,
          };

          const inserted = await insertSignal({
            company_id: acquirerCompany.id,
            signal_type: 'ma_acquired',
            priority_score: adjustedScore,
            signal_summary: `${entityName} involved in acquisition/merger filing${dealAmount ? ` (${dealAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
            signal_detail: detail,
            source_url: filingUrl,
            detected_at: new Date().toISOString(),
          });

          if (inserted) signalsInserted++;
        }
      }
    }
  }

  return signalsInserted;
}

// ── Source 3: SEC EDGAR 8-K Pharma Partnership filings ───────────────────────

/**
 * Process SEC EDGAR 8-K filings for pharma partnerships and licensing deals.
 * Targets the smaller biotech company as the signal entity.
 *
 * @param {string} sixMonthsAgo
 * @param {string} today
 * @returns {Promise<number>} Signals inserted
 */
async function processPartnershipFilings(sixMonthsAgo, today) {
  let signalsInserted = 0;
  const PARTNERSHIP_BASE_SCORE = 28;

  const queries = [
    '"collaboration agreement" "license agreement"',
    '"co-development" "licensing"',
  ];

  for (const query of queries) {
    await sleep(SEC_RATE_LIMIT_MS);

    let hits;
    try {
      hits = await fetchEdgarFilings(query, sixMonthsAgo, today, '8-K');
    } catch (err) {
      console.error('[fundingMaAgent] Partnership EDGAR fetch failed:', err.message);
      continue;
    }

    console.log(`[fundingMaAgent] Partnerships: "${query}" → ${hits.length} hits`);

    for (const hit of hits) {
      const entityName = extractEntityName(hit);
      const fileDate = hit._source?.file_date || today;
      const filingUrl = buildFilingUrl(hit, entityName, '8-K');

      if (!entityName || !isIndustryOrgSec(entityName)) continue;
      if (!isLifeSciences(entityName)) continue;

      // Skip large pharma entities — we target the smaller biotech
      if (LARGE_PHARMA_PATTERNS.test(entityName)) continue;

      const dealAmount = extractAmount(hit._source?.period_of_report || '');

      const company = await upsertCompany(entityName);
      if (!company) continue;

      const alreadyExists = await signalExists(company.id, 'funding_new_award', filingUrl);
      if (alreadyExists) continue;

      const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, PARTNERSHIP_BASE_SCORE);

      const detail = {
        company_name: entityName,
        funding_type: 'pharma_partnership',
        funding_amount: dealAmount,
        funding_summary: `${entityName} entered into a pharma collaboration or licensing agreement${dealAmount ? ` valued at ${dealAmount}` : ''}.`,
        date_announced: fileDate,
        source_url: filingUrl,
        ...preHiringDetail,
      };

      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: 'funding_new_award',
        priority_score: adjustedScore,
        signal_summary: `${entityName} signed pharma partnership/licensing deal${dealAmount ? ` (${dealAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
        signal_detail: detail,
        source_url: filingUrl,
        detected_at: new Date().toISOString(),
      });

      if (inserted) signalsInserted++;
    }
  }

  return signalsInserted;
}

// ── Source 4: SEC EDGAR S-1 IPO Filings ──────────────────────────────────────

/**
 * Process SEC EDGAR S-1 filings for life sciences IPOs.
 *
 * @param {string} sixMonthsAgo
 * @param {string} today
 * @returns {Promise<number>} Signals inserted
 */
async function processIpoFilings(sixMonthsAgo, today) {
  let signalsInserted = 0;
  const IPO_BASE_SCORE = 28;

  await sleep(SEC_RATE_LIMIT_MS);

  let hits;
  try {
    hits = await fetchEdgarFilings('"initial public offering"', sixMonthsAgo, today, 'S-1');
  } catch (err) {
    console.error('[fundingMaAgent] IPO EDGAR fetch failed:', err.message);
    return 0;
  }

  console.log(`[fundingMaAgent] IPO: Fetched ${hits.length} S-1 hits.`);

  for (const hit of hits) {
    const entityName = extractEntityName(hit);
    const fileDate = hit._source?.file_date || today;
    const filingUrl = buildFilingUrl(hit, entityName, 'S-1');

    if (!entityName || !isIndustryOrgSec(entityName)) continue;
    if (!isLifeSciences(entityName)) continue;

    const ipoAmount = extractAmount(hit._source?.period_of_report || '');

    const company = await upsertCompany(entityName);
    if (!company) continue;

    const alreadyExists = await signalExists(company.id, 'funding_new_award', filingUrl);
    if (alreadyExists) continue;

    const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, IPO_BASE_SCORE);

    const detail = {
      company_name: entityName,
      funding_type: 'ipo',
      funding_amount: ipoAmount,
      funding_summary: `${entityName} filed an S-1 for an initial public offering${ipoAmount ? ` raising ${ipoAmount}` : ''}.`,
      date_announced: fileDate,
      source_url: filingUrl,
      ...preHiringDetail,
    };

    const inserted = await insertSignal({
      company_id: company.id,
      signal_type: 'funding_new_award',
      priority_score: adjustedScore,
      signal_summary: `${entityName} filed IPO S-1${ipoAmount ? ` (${ipoAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
      signal_detail: detail,
      source_url: filingUrl,
      detected_at: new Date().toISOString(),
    });

    if (inserted) signalsInserted++;
  }

  return signalsInserted;
}

// ── Source 5: SEC EDGAR Form D Venture Capital Rounds ────────────────────────

/**
 * Process SEC EDGAR Form D filings for life sciences venture capital rounds.
 * Excludes VC fund entities that are the investors, not the portfolio companies.
 *
 * @param {string} sixMonthsAgo
 * @param {string} today
 * @returns {Promise<number>} Signals inserted
 */
async function processVcFilings(sixMonthsAgo, today) {
  let signalsInserted = 0;
  const VC_BASE_SCORE = 28;

  const queries = [
    '"Series A" OR "Series B" OR "Series C"',
    '"venture capital"',
  ];

  for (const query of queries) {
    await sleep(SEC_RATE_LIMIT_MS);

    let hits;
    try {
      hits = await fetchEdgarFilings(query, sixMonthsAgo, today, 'D');
    } catch (err) {
      console.error('[fundingMaAgent] VC EDGAR fetch failed:', err.message);
      continue;
    }

    console.log(`[fundingMaAgent] VC: "${query}" → ${hits.length} hits`);

    for (const hit of hits) {
      const entityName = extractEntityName(hit);
      const fileDate = hit._source?.file_date || today;
      const filingUrl = buildFilingUrl(hit, entityName, 'D');

      if (!entityName || !isIndustryOrgSec(entityName)) continue;

      // Exclude entities that are VC funds themselves (not portfolio companies)
      if (VC_FUND_PATTERNS.test(entityName)) continue;

      if (!isLifeSciences(entityName)) continue;

      // Detect the series from the filing text or query context
      let seriesLabel = 'Venture Round';
      if (/series\s+a/i.test(query)) seriesLabel = 'Series A';
      else if (/series\s+b/i.test(query)) seriesLabel = 'Series B';
      else if (/series\s+c/i.test(query)) seriesLabel = 'Series C';

      const roundAmount = extractAmount(hit._source?.period_of_report || '');

      const company = await upsertCompany(entityName);
      if (!company) continue;

      const alreadyExists = await signalExists(company.id, 'funding_new_award', filingUrl);
      if (alreadyExists) continue;

      const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, VC_BASE_SCORE);

      const detail = {
        company_name: entityName,
        funding_type: 'venture_capital',
        funding_amount: roundAmount,
        funding_summary: `${entityName} raised a ${seriesLabel} venture round${roundAmount ? ` of ${roundAmount}` : ''}.`,
        date_announced: fileDate,
        source_url: filingUrl,
        series_label: seriesLabel,
        ...preHiringDetail,
      };

      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: 'funding_new_award',
        priority_score: adjustedScore,
        signal_summary: `${entityName} raised ${seriesLabel}${roundAmount ? ` (${roundAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
        signal_detail: detail,
        source_url: filingUrl,
        detected_at: new Date().toISOString(),
      });

      if (inserted) signalsInserted++;
    }
  }

  return signalsInserted;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Main entry point for the Funding & M&A agent.
 *
 * Orchestrates all five funding source processors. Each source is wrapped in
 * its own try/catch so a failure in one does not prevent the others from running.
 *
 * @returns {Promise<{ signalsFound: number, sourceCounts: { nih: number, ma: number, partnerships: number, ipo: number, vc: number } }>}
 */
export async function run() {
  const runId = await createAgentRun();
  const now = new Date();
  const sixMonthsAgoDate = daysAgo(LOOKBACK_DAYS);
  const sixMonthsAgo = formatDate(sixMonthsAgoDate);
  const today = formatDate(now);
  const currentYear = now.getFullYear();

  console.log(`[fundingMaAgent] Starting run. Window: ${sixMonthsAgo} → ${today}`);

  const sourceCounts = { nih: 0, ma: 0, partnerships: 0, ipo: 0, vc: 0 };
  let signalsFound = 0;

  // Source 1: NIH SBIR/STTR grants
  try {
    sourceCounts.nih = await processNihGrants(sixMonthsAgo, today, currentYear);
    signalsFound += sourceCounts.nih;
    console.log(`[fundingMaAgent] NIH grants: ${sourceCounts.nih} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] NIH source failed:', err.message);
  }

  // Source 2: SEC EDGAR M&A 8-K filings
  try {
    sourceCounts.ma = await processMaFilings(sixMonthsAgo, today);
    signalsFound += sourceCounts.ma;
    console.log(`[fundingMaAgent] M&A filings: ${sourceCounts.ma} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] M&A source failed:', err.message);
  }

  // Source 3: SEC EDGAR Pharma Partnership 8-K filings
  try {
    sourceCounts.partnerships = await processPartnershipFilings(sixMonthsAgo, today);
    signalsFound += sourceCounts.partnerships;
    console.log(`[fundingMaAgent] Partnerships: ${sourceCounts.partnerships} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] Partnerships source failed:', err.message);
  }

  // Source 4: SEC EDGAR S-1 IPO filings
  try {
    sourceCounts.ipo = await processIpoFilings(sixMonthsAgo, today);
    signalsFound += sourceCounts.ipo;
    console.log(`[fundingMaAgent] IPOs: ${sourceCounts.ipo} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] IPO source failed:', err.message);
  }

  // Source 5: SEC EDGAR Form D venture capital
  try {
    sourceCounts.vc = await processVcFilings(sixMonthsAgo, today);
    signalsFound += sourceCounts.vc;
    console.log(`[fundingMaAgent] VC rounds: ${sourceCounts.vc} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] VC source failed:', err.message);
  }

  await finaliseAgentRun(runId, 'completed', signalsFound);

  console.log(
    `[fundingMaAgent] Completed. Total signals: ${signalsFound}`,
    JSON.stringify(sourceCounts)
  );

  return { signalsFound, sourceCounts };
}
