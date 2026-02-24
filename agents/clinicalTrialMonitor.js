/**
 * Clinical Trial Monitor Agent
 *
 * Polls ClinicalTrials.gov v2 API for INDUSTRY-sponsored studies and generates
 * BD signals for phase transitions, new INDs, site activations, and study completions.
 *
 * Only INDUSTRY sponsors are processed. Universities, NIH, NCI, NHLBI, and all
 * government/academic entities are rejected at both the API query level and locally.
 */

import { supabase, upsertCompany } from '../lib/supabase.js';
import { loadPastClients, matchPastClient } from '../lib/pastClientScoring.js';
import { loadExcludedCompanies, isExcludedCompany } from '../lib/companyExclusion.js';

const CT_API_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const CT_STUDY_BASE = 'https://clinicaltrials.gov/study';
const MAX_PAGES = 2;
const PAGE_SIZE = 100;

// Signal type definitions with base priority scores
const SIGNAL_TYPES = {
  PHASE_TRANSITION: { type: 'clinical_trial_phase_transition', score: 30 },
  NEW_IND:          { type: 'clinical_trial_new_ind',           score: 22 },
};

// Emit phase_transition for Phase 2 and Phase 3 studies (any variant).
// Phase 4, pre-clinical, site activations and completions are excluded.
const PHASE_TRANSITION_NUMS = new Set([2, 3]);

// How many days back to look for recently updated studies
const LOOKBACK_DAYS = 14;

// Academic/government name patterns. Even when leadSponsorClass === 'INDUSTRY',
// some studies list academic medical centres that slip through. Reject any sponsor
// whose name matches these patterns.
const CT_ACADEMIC_PATTERNS =
  /university|universite|college|hospital|medical cent(er|re)|health system|health cent(er|re)|children's|childrens|memorial|baptist|presbyterian|methodist|veterans|institute of|school of|foundation|research cent(er|re)|cancer cent(er|re)|oncology group|cooperative group|intergroupe|francophone|thoracique|sloan kettering|\bmayo\b|cleveland clinic|johns hopkins|\bnih\b|\bnci\b|\bcdc\b|\bva\b(?! pharmaceuticals)/i;

// Module-level counter for debug logging of the first N phase transitions per run
let phaseDebugCount = 0;

/**
 * Format a Date object as YYYY-MM-DD for the ClinicalTrials.gov API.
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
 * Returns a Date object N days after now.
 * @param {number} days
 * @returns {Date}
 */
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Build the ClinicalTrials.gov v2 API query URL for a given page token.
 * Pre-filters to INDUSTRY sponsors at the API level.
 *
 * @param {string} lastUpdateGte - YYYY-MM-DD lower bound on lastUpdatePostDate
 * @param {string|null} pageToken
 * @returns {string}
 */
function buildQueryUrl(lastUpdateGte, pageToken = null) {
  const fields = [
    'NCTId',
    'BriefTitle',
    'OfficialTitle',
    'LeadSponsorName',
    'LeadSponsorClass',
    'Phase',
    'PrimaryCompletionDate',
    // NOTE: StudyFirstPostedDate is NOT a valid CT.gov v2 API field — returns 400.
    // The studyFirstPostedDateStruct is available inside identificationModule
    // which is returned as part of the NCTId/BriefTitle response without needing
    // to be explicitly listed here.
    'LastUpdatePostDate',
    'OverallStatus',
    'EnrollmentCount',
    'ConditionMeshTerm',
    'InterventionType',
    'LocationCountry',
  ].join(',');

  // Note: query.term with AREA[] syntax and filter.lastUpdatePostDate.gte both return
  // HTTP 400 from Vercel IPs. The working approach is a single filter.advanced using
  // RANGE syntax. LocationCount is NOT a valid CT.gov v2 field (returns 400) — use
  // LocationCountry instead and count locations from the response locations array.
  // US-only filter applied at the API level AND post-fetch for defence-in-depth.
  const params = new URLSearchParams({
    'filter.advanced': `AREA[LastUpdatePostDate]RANGE[${lastUpdateGte},MAX] AND AREA[LocationCountry]United States`,
    pageSize: String(PAGE_SIZE),
    fields,
  });

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  return `${CT_API_BASE}?${params.toString()}`;
}

/**
 * Fetch one page of study results from ClinicalTrials.gov v2.
 * Returns the parsed JSON body or throws on non-2xx responses.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchStudiesPage(url) {
  // Log the full URL so it's visible in Vercel logs for debugging 400 errors
  console.log(`[clinicalTrialMonitor] GET ${url}`);

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[clinicalTrialMonitor] API ${response.status}: ${body.substring(0, 300)}`);
    throw new Error(`ClinicalTrials.gov API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch up to MAX_PAGES pages of studies from ClinicalTrials.gov.
 * Aborts pagination on any fetch error.
 *
 * @param {string} lastUpdateGte - YYYY-MM-DD
 * @returns {Promise<object[]>} Flat array of raw study objects
 */
async function fetchAllStudies(lastUpdateGte) {
  const studies = [];
  let pageToken = null;
  let pagesFetched = 0;

  while (pagesFetched < MAX_PAGES) {
    const url = buildQueryUrl(lastUpdateGte, pageToken);
    let data;

    try {
      data = await fetchStudiesPage(url);
    } catch (err) {
      console.error(`[clinicalTrialMonitor] Page fetch failed (page ${pagesFetched + 1}):`, err.message);
      break;
    }

    const studiesInPage = data.studies || [];
    for (const study of studiesInPage) {
      studies.push(study);
    }

    pagesFetched++;

    if (data.nextPageToken && pagesFetched < MAX_PAGES) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }

  return studies;
}

/**
 * Extract a flat protocol data object from the nested ClinicalTrials.gov v2 response.
 *
 * @param {object} study - Raw study object from the API
 * @returns {object} Flattened protocol fields
 */
function extractProtocol(study) {
  const proto = study.protocolSection || {};
  const id = proto.identificationModule || {};
  const sponsor = proto.sponsorCollaboratorsModule || {};
  const status = proto.statusModule || {};
  const design = proto.designModule || {};
  const conditions = proto.conditionsModule || {};
  const interventions = proto.armsInterventionsModule || {};
  const contacts = proto.contactsLocationsModule || {};

  const leadSponsor = sponsor.leadSponsor || {};
  const phases = design.phases || [];
  const meshTerms = conditions.meshes || [];
  const interventionList = interventions.interventions || [];

  const conditionMeshTerm =
    meshTerms.length > 0
      ? meshTerms.map((m) => m.term)
      : conditions.conditions || [];

  const primaryIntervention =
    interventionList.length > 0 ? interventionList[0].name : null;

  // Derive location count and US presence from the locations array.
  // LocationCount is NOT a valid CT.gov v2 API field — removed from fields param.
  const locationsList = Array.isArray(contacts.locations) ? contacts.locations : [];
  const locationCount = locationsList.length;
  const hasUSLocation =
    locationCount === 0 // no location data returned — do not exclude
      ? true
      : locationsList.some((loc) => loc.country === 'United States');

  return {
    nctId: id.nctId || null,
    briefTitle: id.briefTitle || '',
    officialTitle: id.officialTitle || '',
    leadSponsorName: leadSponsor.name || '',
    leadSponsorClass: leadSponsor.class || '',
    phases,
    primaryCompletionDate: status.primaryCompletionDateStruct?.date || null,
    studyFirstPostedDate: id.studyFirstPostedDateStruct?.date || status.studyFirstPostedDateStruct?.date || null,
    lastUpdatePostDate: status.lastUpdatePostDateStruct?.date || null,
    overallStatus: status.overallStatus || '',
    locationCount,
    hasUSLocation,
    enrollmentCount: design.enrollmentInfo?.count || null,
    conditionMeshTerm,
    primaryIntervention,
  };
}

/**
 * Map a CT.gov phase array to a human-readable string and numeric value.
 * For combined phases (e.g. PHASE1/PHASE2), returns the first (lower) phase number
 * so combined phase 1/2 studies are NOT treated as Phase 1-only for IND signals.
 *
 * @param {string[]} phases - e.g. ['PHASE2']
 * @returns {{ phaseStr: string, phaseNum: number | null, isCombined: boolean }}
 */
function parsePhase(phases) {
  if (!phases || phases.length === 0) {
    return { phaseStr: 'N/A', phaseNum: null, isCombined: false };
  }

  const phaseMap = {
    PHASE1: 1,
    PHASE2: 2,
    PHASE3: 3,
    PHASE4: 4,
  };

  const normalised = phases.map((p) => p.toUpperCase().replace(/\s/g, ''));
  const isCombined = normalised.length > 1;

  // Build human-readable phase label: "Phase 2" or "Phase 1/2" for combined
  const phaseStr = normalised.length === 1
    ? (() => {
        const n = phaseMap[normalised[0]];
        return n !== undefined ? `Phase ${n}` : normalised[0].replace(/^PHASE/i, 'Phase ');
      })()
    : 'Phase ' + normalised.map((p) => phaseMap[p] ?? p.replace(/^PHASE/i, '')).join('/');

  // Use highest phase number for transition signals
  let phaseNum = null;
  for (const p of normalised) {
    const n = phaseMap[p];
    if (n !== undefined && (phaseNum === null || n > phaseNum)) {
      phaseNum = n;
    }
  }

  return { phaseStr, phaseNum, isCombined };
}

/**
 * Infer the previous phase label from the current phase number.
 * Returns human-readable labels like "Phase 1", "Phase 2", "Pre-Clinical".
 *
 * @param {number} currentPhaseNum
 * @returns {string}
 */
function inferPreviousPhase(currentPhaseNum) {
  const map = { 2: 'Phase 1', 3: 'Phase 2', 4: 'Phase 3' };
  return map[currentPhaseNum] || 'Pre-Clinical';
}

/**
 * Build a short study summary sentence using condition and intervention.
 *
 * @param {object} proto - Extracted protocol object
 * @returns {string}
 */
function buildStudySummary(proto) {
  const condition =
    proto.conditionMeshTerm.length > 0
      ? proto.conditionMeshTerm[0]
      : proto.officialTitle || proto.briefTitle || 'an undisclosed indication';

  const intervention = proto.primaryIntervention
    ? proto.primaryIntervention
    : 'an investigational agent';

  return `${condition} evaluating ${intervention}`;
}

// upsertCompany imported from lib/supabase.js (shared ilike check-then-insert pattern)

/**
 * Check whether a signal with the given company_id, signal_type, and source_url
 * already exists in the signals table.
 *
 * @param {string} companyId
 * @param {string} signalType
 * @param {string} dedupUrl
 * @returns {Promise<boolean>} true if the signal already exists
 */
async function signalExists(companyId, signalType, dedupUrl) {
  const { data: existing, error } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', signalType)
    .eq('source_url', dedupUrl)
    .maybeSingle();

  if (error) {
    console.error('[clinicalTrialMonitor] signalExists query error:', error.message);
    return false;
  }

  return existing !== null;
}

/**
 * Insert a single signal row into the signals table.
 *
 * @param {object} payload
 * @returns {Promise<boolean>} true on success
 */
async function insertSignal(payload) {
  const { error } = await supabase.from('signals').insert(payload);

  if (error) {
    console.error('[clinicalTrialMonitor] insertSignal error:', error.message);
    return false;
  }

  return true;
}

/**
 * Create an agent_runs entry at the start of a run.
 *
 * @returns {Promise<string|null>} The new run ID or null on error
 */
async function createAgentRun() {
  const { data, error } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'clinicalTrialMonitor',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[clinicalTrialMonitor] createAgentRun error:', error.message);
    return null;
  }

  return data?.id ?? null;
}

/**
 * Update an agent_runs row with final status, signal count, and optional error.
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

  if (errorMessage) {
    update.error_message = errorMessage;
  }

  const { error } = await supabase.from('agent_runs').update(update).eq('id', runId);

  if (error) {
    console.error('[clinicalTrialMonitor] finaliseAgentRun error:', error.message);
  }
}

/**
 * Evaluate a single study and insert applicable signals.
 * Returns the number of new signals inserted.
 *
 * @param {object} study - Raw study object from the API
 * @param {Date} now - Current timestamp
 * @param {Date} completionCutoff - Furthest future date for completion signals
 * @returns {Promise<number>}
 */
async function processStudy(study, now, pastClientsMap = new Map(), excludedCompanies = new Set()) {
  const proto = extractProtocol(study);

  // Guard 1: only INDUSTRY sponsors (API pre-filters, but we confirm)
  if ((proto.leadSponsorClass || '').toUpperCase() !== 'INDUSTRY') {
    return 0;
  }

  if (!proto.nctId || !proto.leadSponsorName) {
    return 0;
  }

  // Guard 2: name-based academic filter — catches misclassified sponsors
  if (CT_ACADEMIC_PATTERNS.test(proto.leadSponsorName)) {
    console.log(`[clinicalTrialMonitor] ${proto.nctId} ACADEMIC NAME REJECTED: ${proto.leadSponsorName}`);
    return 0;
  }

  // Guard 3: US-only (API filters first, post-fetch confirms)
  if (!proto.hasUSLocation) {
    console.log(`[clinicalTrialMonitor] FILTERED (non-US): ${proto.nctId} ${proto.leadSponsorName}`);
    return 0;
  }

  console.log(`[clinicalTrialMonitor] INDUSTRY PASS: ${proto.nctId} — ${proto.leadSponsorName}`);

  if (isExcludedCompany(proto.leadSponsorName, excludedCompanies)) {
    console.log(`[clinicalTrialMonitor] EXCLUDED (large company): ${proto.leadSponsorName}`);
    return 0;
  }

  const { phaseStr, phaseNum, isCombined } = parsePhase(proto.phases);
  const studySummary = buildStudySummary(proto);
  const sourceUrl = `${CT_STUDY_BASE}/${proto.nctId}`;

  const company = await upsertCompany(supabase, { name: proto.leadSponsorName });
  if (!company) return 0;

  let signalsInserted = 0;

  const therapeuticArea =
    proto.conditionMeshTerm.length > 0
      ? proto.conditionMeshTerm[0]
      : (proto.officialTitle || proto.briefTitle || '').substring(0, 120);

  const baseDetail = {
    company_name: proto.leadSponsorName,
    sponsor_class: 'INDUSTRY',
    nct_id: proto.nctId,
    therapeutic_area: therapeuticArea,
    enrollment_count: proto.enrollmentCount,
    num_sites: proto.locationCount,
    date_updated: proto.lastUpdatePostDate,
    study_summary: studySummary,
    source_url: sourceUrl,
  };

  // ── Signal 1: Phase Transition ────────────────────────────────────────────
  // Emit for any INDUSTRY study currently in Phase 2 or Phase 3.
  // Combined phases (Phase 1/2, Phase 2/3) are included via phaseNum.
  // phase_from is inferred from phaseNum; phase_to is the current phase label.
  const phaseFrom = inferPreviousPhase(phaseNum);
  const phaseEmit = PHASE_TRANSITION_NUMS.has(phaseNum);
  console.log(
    `[clinicalTrialMonitor] ${proto.nctId} PHASE CHECK: phase_from=${phaseFrom} phase_to=${phaseStr} phaseNum=${phaseNum} — ${phaseEmit ? 'PASS' : 'REJECT'}`
  );

  if (phaseEmit) {
    const dedupUrl = `${sourceUrl}#PHASE${phaseStr.replace(/\s/g, '')}`;
    const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.PHASE_TRANSITION.type, dedupUrl);
    if (alreadyExists) {
      console.log(`[clinicalTrialMonitor] ${proto.nctId} DEDUP: skipping (${phaseStr} signal already exists)`);
    } else {
      const pastClient = matchPastClient(proto.leadSponsorName, pastClientsMap);
      const baseScore = SIGNAL_TYPES.PHASE_TRANSITION.score;
      const finalScore = pastClient ? baseScore + pastClient.boost_score : baseScore;
      const detail = { ...baseDetail, phase_from: phaseFrom, phase_to: phaseStr };
      if (pastClient) detail.past_client = { name: pastClient.name, priority_rank: pastClient.priority_rank, boost_score: pastClient.boost_score };
      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: SIGNAL_TYPES.PHASE_TRANSITION.type,
        priority_score: finalScore,
        signal_summary: `${proto.leadSponsorName} study in ${phaseStr}: ${proto.briefTitle}`,
        signal_detail: detail,
        source_url: dedupUrl,
        created_at: new Date().toISOString(),
        score_breakdown: { signal_strength: baseScore, past_client_boost: pastClient?.boost_score || 0 },
      });
      if (inserted) signalsInserted++;
    }
  }

  // ── Signal 2: New IND — pure Phase 1 ONLY, first posted within LOOKBACK_DAYS
  const isPhase1Only =
    !isCombined &&
    proto.phases.length === 1 &&
    proto.phases[0].toUpperCase() === 'PHASE1';

  const lookbackThreshold = new Date();
  lookbackThreshold.setDate(lookbackThreshold.getDate() - LOOKBACK_DAYS);
  // Prefer studyFirstPostedDate; fall back to lastUpdatePostDate as a proxy
  // (studyFirstPostedDateStruct may not be present in all API responses).
  const firstPostedRaw = proto.studyFirstPostedDate || proto.lastUpdatePostDate;
  const firstPosted = firstPostedRaw ? new Date(firstPostedRaw) : null;
  const isNewStudy = firstPosted ? firstPosted >= lookbackThreshold : false;

  if (isPhase1Only && isNewStudy) {
    const dedupUrl = `${sourceUrl}#IND`;
    const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.NEW_IND.type, dedupUrl);
    if (alreadyExists) {
      console.log(`[clinicalTrialMonitor] ${proto.nctId} DEDUP: skipping (new_ind already exists)`);
    } else {
      const pastClient = matchPastClient(proto.leadSponsorName, pastClientsMap);
      const baseScore = SIGNAL_TYPES.NEW_IND.score;
      const finalScore = pastClient ? baseScore + pastClient.boost_score : baseScore;
      const detail = { ...baseDetail, phase_from: 'Pre-Clinical', phase_to: 'Phase 1' };
      if (pastClient) detail.past_client = { name: pastClient.name, priority_rank: pastClient.priority_rank, boost_score: pastClient.boost_score };
      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: SIGNAL_TYPES.NEW_IND.type,
        priority_score: finalScore,
        signal_summary: `${proto.leadSponsorName} filed new IND / initiated Phase 1: ${proto.briefTitle}`,
        signal_detail: detail,
        source_url: dedupUrl,
        created_at: new Date().toISOString(),
        score_breakdown: { signal_strength: baseScore, past_client_boost: pastClient?.boost_score || 0 },
      });
      if (inserted) signalsInserted++;
    }
  }

  return signalsInserted;
}

/**
 * Main entry point for the Clinical Trial Monitor agent.
 *
 * Fetches recently updated INDUSTRY-sponsored interventional studies from
 * ClinicalTrials.gov and emits BD signals for phase transitions, new INDs,
 * site activations, and upcoming study completions.
 *
 * @returns {Promise<{ signalsFound: number, studiesProcessed: number, industryFiltered: number }>}
 */
export async function run() {
  phaseDebugCount = 0; // Reset per-run debug counter
  const runId = await createAgentRun();
  const now = new Date();
  const lookbackDate = daysAgo(LOOKBACK_DAYS);
  const lastUpdateGte = formatDate(lookbackDate);

  const pastClientsMap = await loadPastClients();
  console.log(`[clinicalTrialMonitor] Loaded ${pastClientsMap.size} past clients for scoring.`);
  const excludedCompanies = await loadExcludedCompanies();
  console.log(`[clinicalTrialMonitor] Loaded ${excludedCompanies.size} excluded companies.`);

  let signalsFound = 0;
  let studiesProcessed = 0;
  let industryFiltered = 0;

  console.log(`[clinicalTrialMonitor] Starting run. Lookback: ${lastUpdateGte}`);

  try {
    const studies = await fetchAllStudies(lastUpdateGte);

    console.log(`[clinicalTrialMonitor] Fetched ${studies.length} raw studies from API.`);

    for (const study of studies) {
      studiesProcessed++;

      const proto = extractProtocol(study);
      if ((proto.leadSponsorClass || '').toUpperCase() === 'INDUSTRY') {
        industryFiltered++;
      }

      const inserted = await processStudy(study, now, pastClientsMap, excludedCompanies);
      signalsFound += inserted;
    }

    await finaliseAgentRun(runId, 'completed', signalsFound);

    console.log(
      `[clinicalTrialMonitor] Completed. Studies: ${studiesProcessed}, Industry: ${industryFiltered}, Signals: ${signalsFound}`
    );

    return { signalsFound, studiesProcessed, industryFiltered };
  } catch (err) {
    console.error('[clinicalTrialMonitor] Fatal error:', err.message);
    await finaliseAgentRun(runId, 'failed', signalsFound, err.message);

    return { signalsFound, studiesProcessed, industryFiltered };
  }
}
