/**
 * Funding & M&A Agent
 *
 * Monitors four funding sources for INDUSTRY life sciences companies and emits
 * BD signals for grants, M&A, partnerships, IPOs, and venture rounds.
 *
 * Sources:
 *   1. NIH Reporter — SBIR/STTR grants (6-month window)
 *   2. SEC EDGAR 8-K — M&A filings (acquirer + acquired signals)
 *   3. BioSpace /deals/ — Pharma partnerships, licensing, collaborations
 *   4. BioSpace /funding/ — Venture rounds, IPOs, Series A/B/C raises
 *
 * Only INDUSTRY companies are flagged. Universities, academic medical centers,
 * hospitals, government agencies, and foundations are excluded.
 *
 * SEC EDGAR Form D (VC) and S-1 (IPO) were removed — Form D returns VC fund
 * entities (not portfolio companies) and S-1 returns SPAC vehicles, neither
 * of which are useful CRO BD signals.
 * EDGAR 8-K partnership source was replaced by BioSpace /deals/ which returns
 * the actual biotech company (not just the large pharma filer).
 */

import { supabase, normalizeCompanyName, upsertCompany } from '../lib/supabase.js';

// LinkedIn li_at cookie for company posts enrichment (best-effort)
const LINKEDIN_LI_AT = process.env.LINKEDIN_LI_AT;

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
  /university|universite|college|hospital|medical cent(?:er|re)|health system|health cent(?:er|re)|\binstitute\b|school of|\bschool\b|foundation|academy|academie|\bNIH\b|\bNCI\b|\bFDA\b|\bCDC\b|\bNHLBI\b|national institute|national cancer|national heart|department of|children's|childrens|memorial|baptist|methodist|presbyterian|kaiser|mayo clinic|cleveland clinic|johns hopkins|\bmit\b|caltech|stanford|harvard|\byale\b|columbia university|university of pennsylvania|duke university|vanderbilt|emory university|\.edu\b|research cent(?:er|re)|cancer cent(?:er|re)|\bclinic\b|\bconsortium\b|\bsociety\b|\bassociation\b|ministry of|\bgovernment\b|\bfederal\b|national laborator/i;

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

// Non-US country indicators. Used to skip SEC filers and BioSpace articles that
// are clearly non-US entities. We only staff US positions.
// GmbH/AG/NV/BV/SA/KK/AB are European/Asian legal suffixes.
const NON_US_COUNTRY_PATTERNS =
  /\b(Canada|Canadian|UK\b|United Kingdom|Britain|British|Germany|German|GmbH|France|French|Netherlands|Dutch|Switzerland|Swiss|Sweden|Swedish|Australia|Australian|Japan|Japanese|China|Chinese|Korea|Korean|India|Indian|Israel|Israeli|Denmark|Danish|Belgium|Belgian|Finland|Finnish|Italy|Italian|Spain|Spanish|Ireland|Irish|Norway|Norwegian|Singapore|Taiwan|Brazil|Brazilian|Argentina)\b|\bAG\b|\bNV\b|\bBV\b|\bKK\b|\bAB\b/;

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

// upsertCompany is imported from lib/supabase.js (shared ilike check-then-insert pattern)

/**
 * Check whether a signal already exists for the given company, type, and URL.
 *
 * @param {string} companyId
 * @param {string} signalType
 * @param {string} url
 * @returns {Promise<boolean>}
 */
/**
 * Check whether an M&A signal for this exact EDGAR filing already exists,
 * within the last 180 days. Uses signal_detail->>'adsh' for precision —
 * this allows the same company to accumulate multiple M&A signals for
 * different transactions, only deduplicating identical filings.
 *
 * @param {string} adsh - EDGAR accession number (e.g. "0001234567-26-000001")
 * @returns {Promise<boolean>}
 */
async function maSignalExistsByAdsh(adsh) {
  if (!adsh) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);

  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('signal_type', 'ma_transaction')
    .filter('signal_detail->>adsh', 'eq', adsh)
    .gte('created_at', cutoff.toISOString())
    .maybeSingle();

  return !!data;
}

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
    completed_at: new Date().toISOString(),
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

  // Log first 3 org names for verification
  const first3Orgs = projects.slice(0, 3).map((p) => p.organization?.org_name || p.org_name || '?').join(', ');
  console.log(`[fundingMaAgent] NIH: First 3 org names: ${first3Orgs}`);

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
      console.log(`[fundingMaAgent] NIH SKIP: ${orgName} — reason: academic (edu domain)`);
      continue;
    }

    // Post-fetch academic name filter — catches academic orgs that pass the
    // SMALL BUSINESS org_type filter (mis-coded entries in NIH Reporter)
    if (ACADEMIC_PATTERNS.test(orgName)) {
      console.log(`[fundingMaAgent] NIH SKIP: ${orgName} — reason: academic`);
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

    const company = await upsertCompany(supabase, { name: orgName });
    if (!company) continue;

    const alreadyExists = await signalExists(company.id, signalType, sourceUrl);
    if (alreadyExists) {
      console.log(`[fundingMaAgent] NIH SKIP: ${orgName} — reason: dedup`);
      continue;
    }

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
      created_at: new Date().toISOString(),
    });

    if (inserted) {
      signalsInserted++;
    } else {
      console.log(`[fundingMaAgent] NIH SKIP: ${orgName} — reason: insert error`);
    }
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
 * Fetch the primary document text from an EDGAR filing archive.
 * Tries the filing index JSON, finds the 8-K document, returns first 4 KB of plain text.
 * Returns empty string on any error — M&A signal is still created without target details.
 *
 * @param {object} hit - EDGAR search hit object
 * @returns {Promise<string>}
 */
async function fetchMaFilingText(hit) {
  const adsh = hit._source?.adsh || '';
  const ciks = hit._source?.ciks || [];
  const cik = ciks[0] ? parseInt(ciks[0], 10) : null;
  if (!adsh || !cik) return '';

  const adshNoDash = adsh.replace(/-/g, '');
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDash}/${adsh}-index.json`;

  try {
    await sleep(SEC_RATE_LIMIT_MS);
    const indexResp = await fetch(indexUrl, {
      headers: { 'User-Agent': 'BioSignal-BD-Platform contact@biosignal.io', Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!indexResp.ok) return '';

    const index = await indexResp.json();
    // Find the primary 8-K document (not exhibits like 99.1)
    const primaryDoc = (index.documents || []).find((d) => d.type === '8-K') || (index.documents || [])[0];
    if (!primaryDoc?.document) return '';

    await sleep(SEC_RATE_LIMIT_MS);
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDash}/${primaryDoc.document}`;
    const docResp = await fetch(docUrl, {
      headers: { 'User-Agent': 'BioSignal-BD-Platform contact@biosignal.io' },
      signal: AbortSignal.timeout(8000),
    });
    if (!docResp.ok) return '';

    const raw = await docResp.text();
    // Strip HTML tags and return first 4 KB of plain text
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
  } catch {
    return '';
  }
}

/**
 * Extract the name of the acquired company from 8-K filing text.
 * Uses regex patterns that look for "acquire", "merger with", "combination with".
 *
 * @param {string} text  - Plain text excerpt from the filing document
 * @param {string} acquirerName - The filer (acquirer) name, to avoid self-references
 * @returns {string}
 */
function extractMaTarget(text, acquirerName) {
  if (!text) return '';

  const patterns = [
    // "entered into a definitive agreement to acquire XYZ"
    /definitive\s+agreement\s+to\s+acqui(?:re|red)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    // "agreed to acquire XYZ"
    /agreed\s+to\s+acqui(?:re|red)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    // "to acquire XYZ"
    /to\s+acqui(?:re|red|ring)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    // "has acquired / will acquire XYZ"
    /(?:has|will)\s+acqui(?:re|red|ring)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/,
    // "acquisition of XYZ"
    /acquisition\s+of\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    // "merger agreement with XYZ"
    /merger\s+agreement\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    // "merger with XYZ"
    /merger\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    // "combination with XYZ"
    /combination\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
  ];

  const acquirerPrefix = acquirerName.toLowerCase().slice(0, 10);
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ').replace(/\s*(Inc\.|Corp\.|LLC|Ltd\.).*$/, '$1').trim();
      if (name.length >= 3 && name.length <= 80 && !name.toLowerCase().startsWith(acquirerPrefix)) {
        return name;
      }
    }
  }
  return '';
}

/**
 * Classify M&A transaction type from 8-K filing text using keyword scoring.
 * Categories checked in priority order: merger > product_acquisition >
 * acquisition > ipo > partnership. Highest cumulative score wins.
 *
 * @param {string} text
 * @returns {'merger'|'product_acquisition'|'acquisition'|'ipo'|'partnership'}
 */
function classifyTransactionType(text) {
  if (!text) return 'acquisition';
  const lower = text.toLowerCase();

  const scores = { merger: 0, product_acquisition: 0, acquisition: 0, ipo: 0, partnership: 0 };

  // ── MERGER (highest priority — unambiguous Plan of Merger language) ─────────
  if (/agreement and plan of merger/.test(lower)) scores.merger += 6;
  if (/merger of merger sub with and into/.test(lower)) scores.merger += 5;
  if (/\(["']?the\s+["']?parent["']?\)/.test(lower)) scores.merger += 4;   // "(the "Parent")"
  if (/merger agreement/.test(lower)) scores.merger += 3;
  if (/merger consideration/.test(lower)) scores.merger += 3;
  if (/merger of equals/.test(lower)) scores.merger += 4;
  if (/combined company/.test(lower)) scores.merger += 2;
  if (/surviving corporation/.test(lower)) scores.merger += 2;

  // ── PRODUCT ACQUISITION (acquiring specific drug/compound rights, not a whole company) ─
  // hasCompoundName: uppercase letter codes like LYL273, GCC19CART, VLX-1005, MK-8591
  const hasCompoundName = /\b[A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5}\b/.test(text);
  // Core "acquiring rights to" patterns — checked BEFORE partnership to avoid
  // licensing language (e.g. "exclusive license") winning over compound acquisition
  if (/acquir\w*\s+\w*\s*rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 6;
  if (/acquir\w+\s+(?:global|exclusive|worldwide|all)\s+rights?\b/i.test(text)) scores.product_acquisition += 6;
  if (/global\s+rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 5;
  if (/exclusive\s+rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 5;
  if (/acquired?\s+rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 5;
  if (/asset\s+purchase\s+agreement/.test(lower) && hasCompoundName) scores.product_acquisition += 5;
  if (/sold\s+all\s+or\s+substantially\s+all\s+of\s+its\s+right\s+title/.test(lower)) scores.product_acquisition += 5;
  if (/right[,]?\s+title\s+and\s+interest/i.test(text) && hasCompoundName) scores.product_acquisition += 5;
  if (/exclusive.{0,80}rights?.{0,80}from\s+[A-Z]/i.test(text) && hasCompoundName) scores.product_acquisition += 4;
  if (hasCompoundName && /\bacquir\w+\b/i.test(text) && /\bright\b/i.test(text)) scores.product_acquisition += 4;
  if (/\bseller\b/.test(lower) && hasCompoundName) scores.product_acquisition += 3;
  if (hasCompoundName && /\bacquir\w+\b/i.test(text)) scores.product_acquisition += 2;

  // ── COMPANY ACQUISITION ──────────────────────────────────────────────────────
  if (/asset\s+purchase\s+agreement/.test(lower) && !hasCompoundName) scores.acquisition += 4;
  if (/\btender\s+offer\b/.test(lower)) scores.acquisition += 4;
  if (/purchase\s+all\s+outstanding\s+shares/.test(lower)) scores.acquisition += 4;
  if (/stock\s+purchase\s+agreement/.test(lower)) scores.acquisition += 4;
  if (/definitive\s+agreement/.test(lower) && /\bacquire\b/.test(lower)) scores.acquisition += 4;
  if (/purchase\s+agreement/.test(lower) && /\b(company|stock)\b/.test(lower)) scores.acquisition += 3;
  if (/all\s+or\s+substantially\s+all/.test(lower)) scores.acquisition += 2;
  if (/\bacquired\b|\bacquisition\b/.test(lower)) scores.acquisition += 2;

  // ── IPO / PUBLIC OFFERING ───────────────────────────────────────────────────
  if (/initial\s+public\s+offering/.test(lower)) scores.ipo += 5;
  if (/underwriting\s+agreement/.test(lower)) scores.ipo += 4;
  if (/public\s+offering/.test(lower)) scores.ipo += 3;
  if (/shares\s+of\s+common\s+stock/.test(lower) && /offering\s+price/.test(lower)) scores.ipo += 3;
  if (/pre-funded\s+warrants/.test(lower) && /offering/.test(lower)) scores.ipo += 3;
  if (/registered\s+direct\s+offering/.test(lower)) scores.ipo += 3;
  if (/follow-on\s+offering|secondary\s+offering/.test(lower)) scores.ipo += 2;
  if (/\bipo\b/.test(lower)) scores.ipo += 2;

  // ── PARTNERSHIP / LICENSING ─────────────────────────────────────────────────
  if (/collaboration\s+agreement/.test(lower)) scores.partnership += 4;
  if (/license\s+agreement/.test(lower)) scores.partnership += 4;
  if (/exclusive\s+license/.test(lower)) scores.partnership += 4;
  if (/licensing\s+agreement|co-promotion|research\s+collaboration/.test(lower)) scores.partnership += 3;
  if (/\bco-develop/.test(lower)) scores.partnership += 3;
  if (/strategic\s+partnership/.test(lower)) scores.partnership += 2;
  if (/\broyalt/.test(lower)) scores.partnership += 2;

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'acquisition';
  return Object.entries(scores).find(([, s]) => s === maxScore)?.[0] || 'acquisition';
}

/**
 * Extract the acquiring parent company name from a merger 8-K filing.
 * When a company files an 8-K about a merger, the filer is usually the TARGET.
 * The Parent/acquirer is identified by phrases like "(the "Parent")", "by and among
 * the Company, [Parent]", or "[Parent] ... merger of Merger Sub with and into".
 *
 * @param {string} text       - Plain text from 8-K filing
 * @param {string} filerName  - Name of the filing company (the target)
 * @returns {string}  Parent/acquirer name, or '' if not found
 */
function extractMergerParent(text, filerName) {
  if (!text) return '';
  const filerPrefix = filerName.toLowerCase().slice(0, 10);

  const patterns = [
    // "[Company] (the "Parent")" or "[Company] ("Parent")"
    /([A-Z][A-Za-z0-9\s,\.&\-]+?)\s*\(["']?(?:the\s+)?["']?Parent["']?\)/,
    // "by and among the Company, [Parent Name], and Merger Sub"
    /by\s+and\s+among\s+the\s+Company,?\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,\s*and\s+[A-Z][a-z]|\s+and\s+[A-Z][a-z]|\.)/,
    // "[Parent Name], and its wholly-owned subsidiary Merger Sub ... merger of Merger Sub"
    /([A-Z][A-Za-z0-9\s,\.&\-]+?),?\s+(?:and\s+)?[A-Z][a-z]+\s+Sub.{0,50}merger\s+of\s+Merger\s+Sub/i,
    // "Agreement and Plan of Merger ... with [Parent]"
    /Agreement\s+and\s+Plan\s+of\s+Merger.{0,300}(?:\bwith\b|by\s+and\s+among.{0,100}and)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
      if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix)) {
        return name;
      }
    }
  }
  return '';
}

/**
 * Extract the seller/licensor company from a product acquisition 8-K filing.
 * The filer is acquiring drug/compound rights FROM another company.
 *
 * @param {string} text       - Plain text from 8-K filing
 * @param {string} filerName  - Name of the filing company (the acquirer)
 * @returns {string}  Seller name, or '' if not found
 */
function extractProductSeller(text, filerName) {
  if (!text) return '';
  const filerPrefix = filerName.toLowerCase().slice(0, 10);

  const patterns = [
    // "[Company] ("Seller")" or "[Company] (the "Seller")"
    /([A-Z][A-Za-z0-9\s,\.&\-]+?)\s*\(["']?(?:the\s+)?["']?Seller["']?\)/,
    // "acquiring [asset] from [Company] ([abbreviation])" — explicit "from" near "acquiring"
    /acquir\w+\s+(?:global\s+|exclusive\s+|worldwide\s+)?rights?\s+to\s+\S+\s+from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    // "acquiring ... rights to [COMPOUND] ... from [Company]"
    /acquir\w+.{0,300}rights?\s+to.{0,200}from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    // "rights to [COMPOUND] from [Company]"
    /rights?\s+to\s+\S+.{0,150}from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    // "purchased from [Company]" / "acquired from [Company]"
    /(?:purchased?|acquired?)\s+from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    // "licensed from [Company]" / "in-licensed from [Company]"
    /(?:in-?licens\w+|licens\w+)\s+from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
      if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix)) {
        return name;
      }
    }
  }
  return '';
}

/**
 * Extract a drug/compound code name from 8-K filing text.
 * Looks for patterns like LYL273, GCC19CART, VLX-1005, MK-8591 in deal context.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractDrugAsset(text) {
  if (!text) return null;

  const contextPatterns = [
    // "acquiring global rights to LYL273 (formerly GCC19CART)"
    /acquiring.{0,200}rights?\s+to\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    // "rights to LYL273"
    /rights?\s+to\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    // "(formerly GCC19CART)"
    /\(formerly\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\)/,
    // "product candidate LYL273" / "compound VLX-1005" / "the drug MK-8591"
    /(?:product\s+candidate|compound|molecule|drug|asset|program|therapy)\s+(?:known\s+as\s+)?([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    // compound code adjacent to "from [Seller]": "LYL273 from ICT"
    /([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5}).{0,60}from\s+[A-Z][a-z]/,
  ];

  for (const pat of contextPatterns) {
    const m = text.match(pat);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Broad counterparty extractor: last-resort search for a deal partner when
 * type-specific extractors return nothing. Searches the first 2000 chars of
 * the filing for common patterns like:
 *   - '(the "Seller")' / '(the "Purchaser")' near a company name
 *   - 'with [Company Name]' in opening paragraphs
 *   - 'between [Company A] and [Company B]' patterns
 *
 * @param {string} text       - Plain text from 8-K filing
 * @param {string} filerName  - Filing company (exclude from results)
 * @returns {string}  Counterparty name or ''
 */
function extractCounterparty(text, filerName) {
  if (!text) return '';
  const filerPrefix = filerName.toLowerCase().slice(0, 10);
  const snippet = text.slice(0, 2000);

  const patterns = [
    // '(the "Seller")' or '(the "Purchaser")' with preceding company name
    /([A-Z][A-Za-z0-9\s,\.&\-]+?)\s*\(["']?(?:the\s+)?["']?(?:Seller|Purchaser|Buyer|Licensor|Counterparty)["']?\)/,
    // 'entered into ... with [Company]' (partnership/deal announcement)
    /entered\s+into\s+[^.]{0,120}with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/,
    // 'agreement with [Company]' in opening
    /agreement\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/,
    // 'between [Company A] and [Company B]' — take the one that isn't the filer
    /between\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)\s+and\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/,
    // '"Company Name" appearing in quotes after "with"
    /with\s+"([A-Z][A-Za-z0-9\s,\.&\-]+?)"/,
  ];

  for (const pat of patterns) {
    const m = snippet.match(pat);
    if (m) {
      // For "between A and B", pick the one that doesn't start with filerPrefix
      const candidates = m.slice(1).filter(Boolean);
      for (const cand of candidates) {
        const name = cand.trim().replace(/\s+/g, ' ').slice(0, 80);
        if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix)) {
          return name;
        }
      }
    }
  }
  return '';
}

/**
 * Extract structured deal details from 8-K filing plain text.
 *
 * For MERGER: the filer is typically the TARGET. We extract the Parent/acquirer
 * and return acquirer_name=Parent, acquired_name=filerName.
 * For PRODUCT ACQUISITION: acquirer_name=filerName, acquired_name=seller,
 * acquired_asset=compound code.
 * For COMPANY ACQUISITION: acquirer_name=filerName, acquired_name=target.
 * For IPO: only filerName, no counterparty.
 * For PARTNERSHIP: acquirer_name=filerName, acquired_name=partner.
 *
 * @param {string} text       - Plain-text excerpt from an 8-K filing (up to 4 KB)
 * @param {string} filerName  - Name of the company that filed the 8-K
 * @returns {{
 *   transaction_type: string,
 *   acquirer_name: string,
 *   acquired_name: string,
 *   acquired_asset: string|null,
 *   deal_value: string|null,
 *   deal_summary: string,
 *   filing_text_snippet: string|null,
 *   enrichment_source: 'sec_8k_filing'
 * }}
 */
function extractDealDetails(text, filerName) {
  const transaction_type = classifyTransactionType(text);
  const deal_value       = extractAmount(text);

  let acquirer_name;
  let acquired_name;
  let acquired_asset = null;

  if (transaction_type === 'merger') {
    // Filer is the TARGET — extract the Parent (acquirer)
    const parent = extractMergerParent(text, filerName);
    if (parent) {
      acquirer_name = parent;
      acquired_name = filerName;   // filer = the company being acquired
    } else {
      acquirer_name = filerName;
      acquired_name = extractMaTarget(text, filerName);
    }
    acquired_asset = extractDrugAsset(text);  // rare but possible for merger+pipeline

  } else if (transaction_type === 'product_acquisition') {
    // Filer is buying drug rights FROM a seller
    acquirer_name = filerName;
    acquired_name = extractProductSeller(text, filerName);
    acquired_asset = extractDrugAsset(text);

  } else if (transaction_type === 'acquisition') {
    acquirer_name = filerName;
    acquired_name = extractMaTarget(text, filerName);
    acquired_asset = extractDrugAsset(text);

  } else if (transaction_type === 'partnership') {
    acquirer_name = filerName;
    acquired_name = extractMaTarget(text, filerName) || extractProductSeller(text, filerName);
    acquired_asset = extractDrugAsset(text);

  } else {
    // ipo
    acquirer_name = filerName;
    acquired_name = '';
  }

  // FIX 3C: If counterparty is still empty for non-IPO types, try broader search
  if (transaction_type !== 'ipo' && !acquired_name) {
    acquired_name = extractCounterparty(text, filerName);
  }

  // Construct a 1-2 sentence deal summary
  let deal_summary;
  if (transaction_type === 'ipo') {
    deal_summary = `${filerName} announced a public offering${deal_value ? ` valued at ${deal_value}` : ''}.`;
  } else if (transaction_type === 'merger') {
    if (acquirer_name !== filerName && acquired_name === filerName) {
      deal_summary = `${acquirer_name} is acquiring ${filerName}${deal_value ? ` for ${deal_value}` : ''}.`;
    } else {
      deal_summary = `${filerName} announced a merger${acquired_name ? ` with ${acquired_name}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`;
    }
  } else if (transaction_type === 'product_acquisition') {
    deal_summary = `${filerName} is acquiring ${acquired_asset ? `${acquired_asset}` : 'product rights'}${acquired_name ? ` from ${acquired_name}` : ''}${deal_value ? ` for ${deal_value}` : ''}.`;
  } else if (transaction_type === 'partnership') {
    deal_summary = `${filerName} announced a licensing/collaboration agreement${acquired_name ? ` with ${acquired_name}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`;
  } else {
    deal_summary = `${filerName} is acquiring ${acquired_name || 'a company'}${deal_value ? ` for ${deal_value}` : ''}.`;
  }

  // Extract the first 500 chars of the most deal-relevant paragraph
  let filing_text_snippet = null;
  if (text) {
    const DEAL_PARA_RE = /acqui|merger|licen|collaborat|offering|agreement/i;
    const paragraphs = text.split(/\s{2,}/).filter((p) => p.trim().length > 50);
    const relevantPara = paragraphs.find((p) => DEAL_PARA_RE.test(p)) || paragraphs[0] || '';
    filing_text_snippet = relevantPara.trim().slice(0, 500) || null;
  }

  return {
    transaction_type,
    acquirer_name,
    acquired_name,
    acquired_asset,
    deal_value,
    deal_summary,
    filing_text_snippet,
    enrichment_source: 'sec_8k_filing',
  };
}

/**
 * Search BioSpace for deal details about a company.
 * Tries "{companyName} acquisition" and optionally "{companyName} {transactionType}".
 * Best-effort: returns null on any failure.
 *
 * @param {string} companyName
 * @param {string} [transactionType]
 * @returns {Promise<{deal_value: string|null, deal_summary: string, article_url: string}|null>}
 */
async function searchBioSpaceDeal(companyName, transactionType = 'acquisition') {
  const queries = ['acquisition'];
  if (transactionType && transactionType !== 'acquisition') queries.push(transactionType);

  for (const q of queries) {
    const searchUrl = `https://www.biospace.com/search?q=${encodeURIComponent(companyName + ' ' + q)}`;
    try {
      await sleep(SEC_RATE_LIMIT_MS);
      const resp = await fetch(searchUrl, {
        headers: { 'User-Agent': BIOSPACE_BOT_UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const html = await resp.text();

      const articles = parseBioSpaceArticles(html, 'https://www.biospace.com');
      if (articles.length === 0) continue;

      const firstArticle = articles.find((a) =>
        a.title.toLowerCase().includes(companyName.toLowerCase().slice(0, 8))
      ) || articles[0];

      await sleep(SEC_RATE_LIMIT_MS);
      const articleResp = await fetch(firstArticle.url, {
        headers: { 'User-Agent': BIOSPACE_BOT_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!articleResp.ok) return { deal_value: null, deal_summary: firstArticle.title, article_url: firstArticle.url };

      const articleHtml = await articleResp.text();
      const articleText = articleHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
      const dealValue = extractAmount(articleText);
      return { deal_value: dealValue, deal_summary: firstArticle.title, article_url: firstArticle.url };
    } catch (err) {
      console.log(`[fundingMaAgent] BioSpace search failed for "${companyName}" (query: ${q}): ${err.message}`);
    }
  }
  return null;
}

/**
 * Infer a company's web domain from its name for IR page searching.
 * e.g. "Vertex Pharmaceuticals Inc." → "vertexpharmaceuticals.com"
 *
 * @param {string} companyName
 * @returns {string} domain (e.g. "vertexpharmaceuticals.com")
 */
function inferCompanyDomain(companyName) {
  const slug = companyName
    .replace(/,?\s+(inc\.?|incorporated|corp\.?|corporation|llc|ltd\.?|limited|plc|pvt\.?)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `${slug}.com`;
}

/**
 * Search a company's investor relations page for press release content about a deal.
 * Tries common IR URL patterns. Best-effort: returns null on any failure.
 *
 * @param {string} companyName
 * @returns {Promise<{deal_value: string|null, counterparty: string, deal_summary: string, source_url: string}|null>}
 */
async function searchInvestorRelationsPage(companyName) {
  const domain = inferCompanyDomain(companyName);
  const candidates = [
    `https://www.${domain}/investors`,
    `https://www.${domain}/investor-relations`,
    `https://ir.${domain}/`,
    `https://investors.${domain}/`,
  ];
  const DEAL_RE = /acqui|merger|partner|agreement|transaction/i;

  for (const irUrl of candidates) {
    try {
      await sleep(SEC_RATE_LIMIT_MS);
      const resp = await fetch(irUrl, {
        headers: { 'User-Agent': BIOSPACE_BOT_UA },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      if (html.length < 500) continue;

      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      if (!DEAL_RE.test(text)) continue;

      // Look for press release anchor text about deals
      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]{15,200})<\/a>/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const linkText = m[2].replace(/&amp;/g, '&').trim();
        if (!DEAL_RE.test(linkText)) continue;

        const href = m[1];
        const linkUrl = href.startsWith('http')
          ? href
          : `https://www.${domain}${href.startsWith('/') ? '' : '/'}${href}`;

        const dealValue = extractAmount(linkText) || extractAmount(text.slice(0, 2000));
        const cpM = linkText.match(
          /(?:acqui(?:re|red)|merger with|partner(?:ed)? with|agreement with)\s+([A-Z][A-Za-z0-9\s]+?)(?:\s*,|\s+for\s|\.)/i
        );
        return {
          deal_value: dealValue,
          counterparty: cpM?.[1]?.trim() || '',
          deal_summary: linkText.slice(0, 200),
          source_url: linkUrl,
        };
      }

      // Fallback: just grab a deal value from the page
      const dealValue = extractAmount(text.slice(0, 3000));
      if (dealValue) {
        return { deal_value: dealValue, counterparty: '', deal_summary: '', source_url: irUrl };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Search BioPharma Dive for deal coverage of a company.
 * Looks for article cards with deal keywords published in last 180 days.
 * Best-effort: returns null on any failure.
 *
 * @param {string} companyName
 * @returns {Promise<{deal_value: string|null, counterparty: string, deal_summary: string, source_url: string}|null>}
 */
async function searchBioPharmaDiv(companyName) {
  const url = `https://www.biopharmadive.com/search/?q=${encodeURIComponent(companyName)}`;
  const DEAL_RE = /acqui|merger|partner|licens|collaborat/i;
  const cutoff = daysAgo(LOOKBACK_DAYS);

  try {
    await sleep(SEC_RATE_LIMIT_MS);
    const resp = await fetch(url, {
      headers: { 'User-Agent': BIOSPACE_BOT_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Parse article result cards
    const cardRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const card = m[1];
      const titleM = card.match(/<h[23][^>]*>([^<]+)<\/h[23]>/) || card.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</);
      const title = titleM?.[1]?.trim().replace(/&amp;/g, '&') || '';
      if (!title || !DEAL_RE.test(title)) continue;

      const hrefM = card.match(/href="([^"]+)"/);
      const href = hrefM?.[1] || '';
      const articleUrl = href.startsWith('http') ? href : `https://www.biopharmadive.com${href}`;

      // Skip articles outside lookback window
      const dateM = card.match(/(\d{4}-\d{2}-\d{2})|(\w+ \d{1,2}, \d{4})/);
      if (dateM) {
        const articleDate = new Date(dateM[0]);
        if (!isNaN(articleDate.getTime()) && articleDate < cutoff) continue;
      }

      const snippetM = card.match(/class="[^"]*(?:summary|description)[^"]*"[^>]*>([^<]{20,300})/);
      const snippet = snippetM?.[1]?.trim() || title;
      const dealValue = extractAmount(title) || extractAmount(snippet);
      const cpM = title.match(/(?:acquires?|buys?|merges? with|partners? with)\s+([A-Z][A-Za-z0-9\s]+?)(?:\s*,|\s+for\s|\.)/i);

      return {
        deal_value: dealValue,
        counterparty: cpM?.[1]?.trim() || '',
        deal_summary: title,
        source_url: articleUrl,
      };
    }
  } catch (err) {
    console.log(`[fundingMaAgent] BioPharma Dive search failed for "${companyName}": ${err.message}`);
  }
  return null;
}

/**
 * Search FiercePharma for deal coverage of a company.
 * Looks for article results with deal keywords published in last 180 days.
 * Best-effort: returns null on any failure.
 *
 * @param {string} companyName
 * @returns {Promise<{deal_value: string|null, counterparty: string, deal_summary: string, source_url: string}|null>}
 */
async function searchFiercePharma(companyName) {
  const url = `https://www.fiercepharma.com/search?q=${encodeURIComponent(companyName)}`;
  const DEAL_RE = /acqui|merger|partner|licens|collaborat|deal/i;
  const cutoff = daysAgo(LOOKBACK_DAYS);

  try {
    await sleep(SEC_RATE_LIMIT_MS);
    const resp = await fetch(url, {
      headers: { 'User-Agent': BIOSPACE_BOT_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // FiercePharma renders results as node--teaser divs or plain <article> elements
    const cardRe = /<article[^>]*>([\s\S]*?)<\/article>|class="[^"]*node--teaser[^"]*"([\s\S]*?)<\/div>\s*<\/div>/gi;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const card = m[1] || m[2] || '';
      const titleM = card.match(/<h[23][^>]*>([^<]+)<\/h[23]>/) || card.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</);
      const title = titleM?.[1]?.trim().replace(/&amp;/g, '&') || '';
      if (!title || !DEAL_RE.test(title)) continue;

      const hrefM = card.match(/href="([^"]+)"/);
      const href = hrefM?.[1] || '';
      const articleUrl = href.startsWith('http') ? href : `https://www.fiercepharma.com${href}`;

      const dateM = card.match(/(\d{4}-\d{2}-\d{2})|(\w+ \d{1,2}, \d{4})/);
      if (dateM) {
        const articleDate = new Date(dateM[0]);
        if (!isNaN(articleDate.getTime()) && articleDate < cutoff) continue;
      }

      const snippetM = card.match(/class="[^"]*(?:summary|body|description)[^"]*"[^>]*>([^<]{20,300})/);
      const snippet = snippetM?.[1]?.trim() || title;
      const dealValue = extractAmount(title) || extractAmount(snippet);
      const cpM = title.match(/(?:acquires?|buys?|merges? with|partners? with)\s+([A-Z][A-Za-z0-9\s]+?)(?:\s*,|\s+for\s|\.)/i);

      return {
        deal_value: dealValue,
        counterparty: cpM?.[1]?.trim() || '',
        deal_summary: title,
        source_url: articleUrl,
      };
    }
  } catch (err) {
    console.log(`[fundingMaAgent] FiercePharma search failed for "${companyName}": ${err.message}`);
  }
  return null;
}

/**
 * Try to fetch LinkedIn company posts page and extract deal type / counterparty.
 * The company posts page is likely JS-rendered (returns a short HTML shell), so
 * this is best-effort — returns null on any failure or JS-rendered response.
 *
 * Slug: companyName.toLowerCase() → strip non-alphanumeric → join with '-'
 * URL:  https://www.linkedin.com/company/{slug}/posts/
 *
 * @param {string} companyName
 * @returns {Promise<{transaction_type: string|null, enrichment_source: string, source_url: string}|null>}
 */
async function searchLinkedInCompanyPosts(companyName) {
  if (!LINKEDIN_LI_AT) return null;

  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!slug) return null;

  const url = `https://www.linkedin.com/company/${slug}/posts/`;

  const IPO_RE   = /\bipo\b|initial public offering|nasdaq|nyse|public offering/i;
  const ACQ_RE   = /acqui(?:re|red|sition)/i;
  const MERGE_RE = /\bmerge[rd]?\b|merger/i;
  const PART_RE  = /partnership|collaboration|licens/i;
  const DEAL_RE  = /acqui|merger|ipo|initial public offering|nasdaq|nyse|partnership|collaboration|license/i;

  try {
    // 15–30 s human-like delay before each LinkedIn request
    await sleep(15000 + Math.floor(Math.random() * 15000));

    const resp = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie':          `li_at=${LINKEDIN_LI_AT}`,
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!resp.ok) return null;
    const html = await resp.text();

    // Short response = JS-rendered shell — no useful content
    if (html.length < 1000) {
      console.log(`[fundingMaAgent] LinkedIn posts for "${companyName}": ${html.length} chars — JS-rendered, skipping`);
      return null;
    }

    if (!DEAL_RE.test(html)) return null;

    let transaction_type = null;
    if (IPO_RE.test(html))   transaction_type = 'ipo';
    else if (ACQ_RE.test(html))   transaction_type = 'acquisition';
    else if (MERGE_RE.test(html)) transaction_type = 'merger';
    else if (PART_RE.test(html))  transaction_type = 'partnership';

    console.log(`[fundingMaAgent] LinkedIn posts enrichment for "${companyName}": type=${transaction_type}`);
    return { transaction_type, enrichment_source: 'linkedin_company_posts', source_url: url };
  } catch (err) {
    console.log(`[fundingMaAgent] LinkedIn posts failed for "${companyName}": ${err.message}`);
    return null;
  }
}

/**
 * Orchestrate M&A signal enrichment from multiple sources in priority order:
 * 0. LinkedIn company posts (pre-fetched; passed as liResult)
 * 1. Company IR page — highest quality (authoritative source)
 * 2. BioSpace — also tries {transactionType} query
 * 3. BioPharma Dive — trade publication
 * 4. FiercePharma — trade publication
 *
 * Stops once both deal_value and counterparty are found. Logs result.
 *
 * @param {string} entityName
 * @param {string} transactionType
 * @param {string|null} existingDealAmount - from EDGAR filing text (may be null)
 * @param {string} existingAcquiredName - from EDGAR filing text (may be empty)
 * @param {{transaction_type: string|null, enrichment_source: string, source_url: string}|null} liResult - pre-fetched LinkedIn result
 * @returns {Promise<{deal_value: string|null, counterparty: string, deal_summary: string|null, source_url: string|null, source: string|null, transaction_type: string}>}
 */
async function enrichMaSignal(entityName, transactionType, existingDealAmount, existingAcquiredName, liResult = null) {
  const result = {
    deal_value:       existingDealAmount || null,
    counterparty:     existingAcquiredName || '',
    deal_summary:     null,
    source_url:       null,
    source:           existingAcquiredName || existingDealAmount ? 'edgar' : null,
    transaction_type: transactionType,
  };

  const needsEnrichment = () => !result.deal_value || !result.counterparty;

  // Source 0: LinkedIn company posts (pre-fetched, best-effort)
  if (liResult) {
    if (liResult.transaction_type && !result.transaction_type) {
      result.transaction_type = liResult.transaction_type;
    }
    if (liResult.source_url && !result.source_url) result.source_url = liResult.source_url;
    if (!result.source) result.source = liResult.enrichment_source;
  }

  // Source 1: Company IR page
  if (needsEnrichment()) {
    try {
      const irData = await searchInvestorRelationsPage(entityName);
      if (irData) {
        if (irData.deal_value && !result.deal_value) result.deal_value = irData.deal_value;
        if (irData.counterparty && !result.counterparty) result.counterparty = irData.counterparty;
        if (irData.deal_summary && !result.deal_summary) result.deal_summary = irData.deal_summary;
        if (irData.source_url && !result.source_url) result.source_url = irData.source_url;
        if (!result.source || result.source === 'edgar') result.source = 'investor_relations';
      }
    } catch { /* non-fatal */ }
  }

  // Source 2: BioSpace (with transaction type query)
  if (needsEnrichment()) {
    try {
      const bsData = await searchBioSpaceDeal(entityName, transactionType);
      if (bsData) {
        if (bsData.deal_value && !result.deal_value) result.deal_value = bsData.deal_value;
        if (bsData.deal_summary && !result.deal_summary) result.deal_summary = bsData.deal_summary;
        if (bsData.article_url && !result.source_url) result.source_url = bsData.article_url;
        if (!result.source || result.source === 'edgar') result.source = 'biospace';
      }
    } catch { /* non-fatal */ }
  }

  // Source 3: BioPharma Dive
  if (needsEnrichment()) {
    try {
      const bpdData = await searchBioPharmaDiv(entityName);
      if (bpdData) {
        if (bpdData.deal_value && !result.deal_value) result.deal_value = bpdData.deal_value;
        if (bpdData.counterparty && !result.counterparty) result.counterparty = bpdData.counterparty;
        if (bpdData.deal_summary && !result.deal_summary) result.deal_summary = bpdData.deal_summary;
        if (bpdData.source_url && !result.source_url) result.source_url = bpdData.source_url;
        if (!result.source || result.source === 'edgar') result.source = 'biopharmadive';
      }
    } catch { /* non-fatal */ }
  }

  // Source 4: FiercePharma
  if (needsEnrichment()) {
    try {
      const fpData = await searchFiercePharma(entityName);
      if (fpData) {
        if (fpData.deal_value && !result.deal_value) result.deal_value = fpData.deal_value;
        if (fpData.counterparty && !result.counterparty) result.counterparty = fpData.counterparty;
        if (fpData.deal_summary && !result.deal_summary) result.deal_summary = fpData.deal_summary;
        if (fpData.source_url && !result.source_url) result.source_url = fpData.source_url;
        if (!result.source || result.source === 'edgar') result.source = 'fiercepharma';
      }
    } catch { /* non-fatal */ }
  }

  // Log result
  if (result.deal_value || result.counterparty) {
    console.log(
      `[fundingMaAgent] M&A ENRICH [${entityName}]: type=${transactionType}, counterparty=${result.counterparty || 'unknown'}, value=${result.deal_value || 'unknown'}, source=${result.source || 'edgar'}`
    );
  } else {
    console.log(`[fundingMaAgent] M&A ENRICH [${entityName}]: no additional details found`);
  }

  return result;
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
  let liEnrichRequests = 0;
  const MAX_LI_ENRICH = 5;

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
      // US-only: skip entities whose names contain non-US country/legal indicators
      if (NON_US_COUNTRY_PATTERNS.test(entityName)) {
        console.log(`[fundingMaAgent] FILTERED (non-US entity): ${entityName}`);
        continue;
      }

      const adsh = hit._source?.adsh || '';

      // One signal per filing. Dedup by adsh (unique EDGAR accession number)
      // within a 180-day window so the same company can receive signals for
      // different transactions without being blocked by a prior M&A signal.
      const adshAlreadyExists = await maSignalExistsByAdsh(adsh);
      if (adshAlreadyExists) {
        console.log(`[fundingMaAgent] M&A SKIP (dedup by adsh): ${entityName} adsh=${adsh}`);
        continue;
      }

      // Fetch filing document text and extract all deal details
      const filingBodyText     = await fetchMaFilingText(hit);
      const edgarDetails       = extractDealDetails(filingBodyText, entityName);
      const edgarDealAmount    = edgarDetails.deal_value || extractAmount(filingText);
      const edgarAcquirerName  = edgarDetails.acquirer_name;   // parent if merger, filer otherwise
      const edgarAcquiredName  = edgarDetails.acquired_name;
      const edgarAcquiredAsset = edgarDetails.acquired_asset;
      const edgarSnippet       = edgarDetails.filing_text_snippet;
      const transactionType    = edgarDetails.transaction_type;
      if (edgarAcquiredName) {
        console.log(`[fundingMaAgent] M&A deal: ${edgarAcquirerName} → ${edgarAcquiredName} (${transactionType})`);
      }

      // LinkedIn company posts enrichment (max 5 requests per run, best-effort)
      let liResult = null;
      if (liEnrichRequests < MAX_LI_ENRICH) {
        liResult = await searchLinkedInCompanyPosts(entityName);
        liEnrichRequests++;
      }

      // Multi-source enrichment: LinkedIn posts → IR page → BioSpace → BioPharma Dive → FiercePharma
      const enriched = await enrichMaSignal(entityName, transactionType, edgarDealAmount, edgarAcquiredName, liResult);

      const finalDealAmount      = enriched.deal_value || null;
      const finalAcquiredName    = enriched.counterparty || edgarAcquiredName;
      const finalAcquirerName    = edgarAcquirerName;   // always from EDGAR (most authoritative)
      const finalTransactionType = enriched.transaction_type || transactionType;

      const { adjustedScore, preHiringDetail } = await evalPreHiring(entityName, MA_BASE_SCORE);

      const dealSummary = enriched.deal_summary
        || edgarDetails.deal_summary
        || `${finalAcquirerName} announced an M&A transaction${finalAcquiredName ? ` involving ${finalAcquiredName}` : ''}${finalDealAmount ? ` valued at ${finalDealAmount}` : ''}`;

      const detail = {
        company_name:         entityName,
        acquirer_name:        finalAcquirerName,
        acquired_name:        finalAcquiredName,
        acquired_asset:       edgarAcquiredAsset || null,
        transaction_type:     finalTransactionType,
        deal_value:           finalDealAmount,
        adsh,
        funding_type:         'ma',
        funding_amount:       finalDealAmount,
        funding_summary:      dealSummary,
        deal_summary:         dealSummary,
        filing_text_snippet:  edgarSnippet || null,
        enrichment_source:    enriched.source || 'sec_8k_filing',
        enrichment_url:       enriched.source_url,
        date_announced:       fileDate,
        filing_url:           filingUrl,
        source_url:           filingUrl,
        ...preHiringDetail,
      };

      const company = await upsertCompany(supabase, { name: entityName });
      if (company) {
        const inserted = await insertSignal({
          company_id:    company.id,
          signal_type:   'ma_transaction',
          priority_score: adjustedScore,
          signal_summary: `${finalAcquirerName} M&A transaction${finalDealAmount ? ` (${finalDealAmount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
          signal_detail: detail,
          source_url: filingUrl,
          created_at: new Date().toISOString(),
        });

        if (inserted) signalsInserted++;
      }
    }
  }

  return signalsInserted;
}

// ── BioSpace article parsing helpers ─────────────────────────────────────────

const BIOSPACE_BOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse article cards from a BioSpace page.
 * BioSpace uses <a class="Link" aria-label="Title" href="URL"> inside PagePromo
 * divs. Falls back to scanning all <a> tags with substantive text content.
 *
 * @param {string} html
 * @param {string} baseUrl - used to resolve relative hrefs
 * @returns {Array<{title: string, url: string}>}
 */
function parseBioSpaceArticles(html, baseUrl) {
  const cards = [];
  const seen = new Set();

  // Primary: aria-label on Link anchors (PagePromo structure)
  const re = /<a[^>]+aria-label="([^"]{10,})"[^>]+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim();
    const url = m[2].startsWith('http') ? m[2] : `${baseUrl}${m[2]}`;
    if (!seen.has(url)) { seen.add(url); cards.push({ title, url }); }
  }

  // Also try href-first order
  const re2 = /href="([^"]+)"[^>]*aria-label="([^"]{10,})"/g;
  while ((m = re2.exec(html)) !== null) {
    const url = m[1].startsWith('http') ? m[1] : `${baseUrl}${m[1]}`;
    const title = m[2].replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim();
    if (!seen.has(url)) { seen.add(url); cards.push({ title, url }); }
  }

  // Fallback: plain <a> links with substantive text
  if (cards.length === 0) {
    const re3 = /<a[^>]+href="(https?:\/\/www\.biospace\.com\/[^"]+)"[^>]*>([^<]{20,})<\/a>/g;
    while ((m = re3.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].replace(/&amp;/g, '&').trim();
      if (!seen.has(url)) { seen.add(url); cards.push({ title, url }); }
    }
  }

  return cards;
}

/**
 * Infer deal type from article title text.
 * Returns the funding_type string or null if not a funding/deal article.
 *
 * @param {string} text
 * @returns {'venture_capital'|'pharma_partnership'|'ipo'|'ma'|null}
 */
function detectBioSpaceDealType(text) {
  const t = text.toLowerCase();
  if (/\bipo\b|initial public offering|\bs-1\b|nasdaq listing|nyse listing/.test(t)) return 'ipo';
  if (/series\s+[abcde]\d*\b|raises|raised|nabs|secures|closes.*round|venture round|seed round|debut/.test(t)) return 'venture_capital';
  if (/partnership|collaboration|license|pact|co-develop|licensing|teams with|deal with/.test(t)) return 'pharma_partnership';
  if (/acquires|acquisition|merger|buys\b|purchase/.test(t)) return 'ma';
  return null;
}

/**
 * Extract the most relevant company name from a BioSpace article title.
 * BioSpace titles follow patterns like:
 *   "CompanyA Raises $X"  → CompanyA
 *   "BigPharma Fronts $X for SmallBio's drug"  → SmallBio
 *   "X-Partnered CompanyB Raises $X"  → CompanyB
 *   "China's CompanyC Nabs $X"  → CompanyC
 *
 * @param {string} title
 * @returns {string}
 */
function extractCompanyFromBioSpaceTitle(title) {
  // Clean HTML entities
  const clean = title.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');

  // "X-Partnered Y Raises..." → Y is the company raising
  const partneredM = clean.match(/^[A-Za-z\s]+-Partnered\s+(.+?)\s+(?:Raises|Nabs|Secures|Closes|Files|Completes|Nets|Snags|Debuts)\b/i);
  if (partneredM) return partneredM[1].trim();

  // "Country's CompanyName Raises/Nabs..." → CompanyName
  const possessiveM = clean.match(/^(?:China|US|UK|EU|Japan|Korea|Israel|Germany|France)'s\s+(.+?)\s+(?:Raises|Nabs|Secures|Closes|Files|Joins|Signs|Nets)\b/i);
  if (possessiveM) return possessiveM[1].trim();

  // "BigPharma Fronts/Pays/Invests $X for SmallBio's..." → SmallBio
  const dealForM = clean.match(/^[A-Za-z\s]+(?:Fronts|Pays|Invests|Bets)[^f]+\s+for\s+([A-Z][A-Za-z]+(?:\s[A-Z][a-z]+)*)'s/);
  if (dealForM) return dealForM[1].trim();

  // Standard: company name is everything before the first deal/action verb
  const DEAL_VERB = /\b(Raises|Raised|Bets|Fronts|Nabs|Joins|Signs|Teams|Enters|Announces|Files|Completes|Closes|Acquires|Agrees|Inks|Secures|Lands|Wins|Dives|Keeps|Establishes|Pumps|Launches|Nets|Snags|Debuts|Goes|Steps|Forms|Jumps)\b/;
  const verbM = clean.match(new RegExp(`^(.+?)\\s+${DEAL_VERB.source}`, 'i'));
  if (verbM) return verbM[1].trim();

  // Fallback: first 1–3 words
  return clean.split(/\s+/).slice(0, 3).join(' ');
}

// ── Source 3: BioSpace /deals/ — Pharma partnerships & licensing ──────────────

/**
 * Fetch BioSpace /deals/ page and emit pharma partnership signals for
 * smaller biotech companies entering collaboration/licensing deals.
 * Replaces EDGAR 8-K partnership source which was filing large-pharma names.
 *
 * @param {string} today - YYYY-MM-DD
 * @returns {Promise<number>} Signals inserted
 */
async function processBioSpaceDeals(today) {
  let signalsInserted = 0;
  const BASE_SCORE = 28;
  const SOURCE_URL = 'https://www.biospace.com/deals/';

  let html;
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': BIOSPACE_BOT_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`[fundingMaAgent] BioSpace /deals/ HTTP ${resp.status}`);
      return 0;
    }
    html = await resp.text();
  } catch (err) {
    console.error('[fundingMaAgent] BioSpace /deals/ fetch error:', err.message);
    return 0;
  }

  const articles = parseBioSpaceArticles(html, 'https://www.biospace.com');
  console.log(`[fundingMaAgent] BioSpace /deals/: ${articles.length} articles parsed`);

  for (const { title, url } of articles) {
    const dealType = detectBioSpaceDealType(title);
    if (!dealType || dealType === 'ma') continue; // M&A handled by EDGAR source

    // US-only: skip articles about non-US companies (title contains country indicator)
    if (NON_US_COUNTRY_PATTERNS.test(title)) {
      console.log(`[fundingMaAgent] FILTERED BioSpace /deals/ (non-US title): ${title}`);
      continue;
    }

    const rawCompany = extractCompanyFromBioSpaceTitle(title);
    if (!rawCompany || !isIndustryOrg(rawCompany)) continue;

    // Skip if it looks like a large pharma filer (we want the smaller biotech)
    if (LARGE_PHARMA_PATTERNS.test(rawCompany) && dealType === 'pharma_partnership') continue;

    const amount = extractAmount(title);
    const company = await upsertCompany(supabase, { name: rawCompany });
    if (!company) continue;

    const alreadyExists = await signalExists(company.id, 'funding_new_award', url);
    if (alreadyExists) continue;

    const { adjustedScore, preHiringDetail } = await evalPreHiring(rawCompany, BASE_SCORE);

    const fundingType = dealType === 'ipo' ? 'ipo' : dealType === 'venture_capital' ? 'venture_capital' : 'pharma_partnership';
    const summaryVerb = fundingType === 'pharma_partnership' ? 'signed pharma deal' : fundingType === 'ipo' ? 'filed for IPO' : 'raised funding round';

    const detail = {
      company_name: rawCompany,
      funding_type: fundingType,
      funding_amount: amount,
      funding_summary: title,
      date_announced: today,
      source_url: url,
      ...preHiringDetail,
    };

    const inserted = await insertSignal({
      company_id: company.id,
      signal_type: 'funding_new_award',
      priority_score: adjustedScore,
      signal_summary: `${rawCompany} ${summaryVerb}${amount ? ` (${amount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
      signal_detail: detail,
      source_url: url,
      created_at: new Date().toISOString(),
    });

    if (inserted) signalsInserted++;
  }

  return signalsInserted;
}

// ── Source 4: BioSpace /funding/ — Venture rounds & IPOs ─────────────────────

/**
 * Fetch BioSpace /funding/ page and emit VC and IPO signals.
 * Replaces both SEC EDGAR Form D (VC) and S-1 (IPO) sources.
 * Form D returns VC fund names, not portfolio companies.
 * S-1 returns SPAC vehicles and blank-check companies, not true biotech IPOs.
 *
 * @param {string} today - YYYY-MM-DD
 * @returns {Promise<number>} Signals inserted
 */
async function processBioSpaceFunding(today) {
  let signalsInserted = 0;
  const BASE_SCORE = 28;
  const SOURCE_URL = 'https://www.biospace.com/funding/';

  let html;
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': BIOSPACE_BOT_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`[fundingMaAgent] BioSpace /funding/ HTTP ${resp.status}`);
      return 0;
    }
    html = await resp.text();
  } catch (err) {
    console.error('[fundingMaAgent] BioSpace /funding/ fetch error:', err.message);
    return 0;
  }

  const articles = parseBioSpaceArticles(html, 'https://www.biospace.com');
  console.log(`[fundingMaAgent] BioSpace /funding/: ${articles.length} articles parsed`);

  for (const { title, url } of articles) {
    const dealType = detectBioSpaceDealType(title);
    if (!dealType || dealType === 'ma') continue;

    // US-only: skip articles about non-US companies
    if (NON_US_COUNTRY_PATTERNS.test(title)) {
      console.log(`[fundingMaAgent] FILTERED BioSpace /funding/ (non-US title): ${title}`);
      continue;
    }

    const rawCompany = extractCompanyFromBioSpaceTitle(title);
    if (!rawCompany || !isIndustryOrg(rawCompany)) continue;

    // Exclude VC fund entities that appear as company names
    if (VC_FUND_PATTERNS.test(rawCompany)) continue;

    const amount = extractAmount(title);
    const company = await upsertCompany(supabase, { name: rawCompany });
    if (!company) continue;

    const alreadyExists = await signalExists(company.id, 'funding_new_award', url);
    if (alreadyExists) continue;

    const { adjustedScore, preHiringDetail } = await evalPreHiring(rawCompany, BASE_SCORE);

    const fundingType = dealType === 'ipo' ? 'ipo' : dealType === 'pharma_partnership' ? 'pharma_partnership' : 'venture_capital';
    const summaryVerb = fundingType === 'ipo' ? 'filed for IPO' : fundingType === 'pharma_partnership' ? 'signed deal' : 'raised funding';

    const detail = {
      company_name: rawCompany,
      funding_type: fundingType,
      funding_amount: amount,
      funding_summary: title,
      date_announced: today,
      source_url: url,
      ...preHiringDetail,
    };

    const inserted = await insertSignal({
      company_id: company.id,
      signal_type: 'funding_new_award',
      priority_score: adjustedScore,
      signal_summary: `${rawCompany} ${summaryVerb}${amount ? ` (${amount})` : ''}${preHiringDetail.pre_hiring_signal ? ' — Pre-hiring signal' : ''}`,
      signal_detail: detail,
      source_url: url,
      created_at: new Date().toISOString(),
    });

    if (inserted) signalsInserted++;
  }

  return signalsInserted;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Main entry point for the Funding & M&A agent.
 *
 * Orchestrates all four funding source processors. Each source is wrapped in
 * its own try/catch so a failure in one does not prevent the others from running.
 *
 * @returns {Promise<{ signalsFound: number, sourceCounts: { nih: number, ma: number, biospaceDeals: number, biospaceVcIpo: number } }>}
 */
export async function run() {
  const runId = await createAgentRun();
  const now = new Date();
  const sixMonthsAgoDate = daysAgo(LOOKBACK_DAYS);
  const sixMonthsAgo = formatDate(sixMonthsAgoDate);
  const today = formatDate(now);
  const currentYear = now.getFullYear();

  console.log(`[fundingMaAgent] Starting run. Window: ${sixMonthsAgo} → ${today}`);

  const sourceCounts = { nih: 0, ma: 0, biospaceDeals: 0, biospaceVcIpo: 0 };
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

  // Source 3: BioSpace /deals/ — pharma partnerships & licensing
  try {
    sourceCounts.biospaceDeals = await processBioSpaceDeals(today);
    signalsFound += sourceCounts.biospaceDeals;
    console.log(`[fundingMaAgent] BioSpace deals: ${sourceCounts.biospaceDeals} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] BioSpace /deals/ source failed:', err.message);
  }

  // Source 4: BioSpace /funding/ — VC rounds & IPOs
  try {
    sourceCounts.biospaceVcIpo = await processBioSpaceFunding(today);
    signalsFound += sourceCounts.biospaceVcIpo;
    console.log(`[fundingMaAgent] BioSpace funding: ${sourceCounts.biospaceVcIpo} signals`);
  } catch (err) {
    console.error('[fundingMaAgent] BioSpace /funding/ source failed:', err.message);
  }

  await finaliseAgentRun(runId, 'completed', signalsFound);

  console.log(
    `[fundingMaAgent] Completed. Total signals: ${signalsFound}`,
    JSON.stringify(sourceCounts)
  );

  return { signalsFound, sourceCounts };
}
