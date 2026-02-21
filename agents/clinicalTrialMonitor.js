/**
 * Clinical Trial Monitor Agent
 *
 * Polls ClinicalTrials.gov v2 API for INDUSTRY-sponsored studies and generates
 * BD signals for phase transitions, new INDs, site activations, and study completions.
 *
 * Only INDUSTRY sponsors are processed. Universities, NIH, NCI, NHLBI, and all
 * government/academic entities are rejected at both the API query level and locally.
 */

import { supabase } from '../lib/supabase.js';

const CT_API_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const CT_STUDY_BASE = 'https://clinicaltrials.gov/study';
const MAX_PAGES = 2;
const PAGE_SIZE = 100;

// Signal type definitions with base priority scores
const SIGNAL_TYPES = {
  PHASE_TRANSITION: { type: 'clinical_trial_phase_transition', score: 30 },
  NEW_IND:          { type: 'clinical_trial_new_ind',           score: 22 },
  SITE_ACTIVATION:  { type: 'clinical_trial_site_activation',   score: 25 },
  COMPLETION:       { type: 'clinical_trial_completion',         score: 20 },
};

// Minimum number of locations to trigger a site_activation signal
const MIN_SITES_FOR_ACTIVATION = 10;

// Days ahead to look for upcoming primary completions
const COMPLETION_WINDOW_DAYS = 90;

// How many days back to look for recently updated studies
const LOOKBACK_DAYS = 14;

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
    'LastUpdatePostDate',
    'OverallStatus',
    'LocationCount',
    'EnrollmentCount',
    'ConditionMeshTerm',
    'InterventionType',
  ].join(',');

  const params = new URLSearchParams({
    'query.term': 'AREA[InterventionType]interventional',
    'filter.advanced': 'AREA[LeadSponsorClass]INDUSTRY',
    'filter.lastUpdatePostDate.gte': lastUpdateGte,
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
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
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

  // LocationCount may be returned as a top-level scalar on the study object
  // when requested via the fields param, or counted from the locations array.
  let locationCount = 0;
  if (typeof study.locationCount === 'number') {
    locationCount = study.locationCount;
  } else if (Array.isArray(contacts.locations)) {
    locationCount = contacts.locations.length;
  }

  return {
    nctId: id.nctId || null,
    briefTitle: id.briefTitle || '',
    officialTitle: id.officialTitle || '',
    leadSponsorName: leadSponsor.name || '',
    leadSponsorClass: leadSponsor.class || '',
    phases,
    primaryCompletionDate: status.primaryCompletionDateStruct?.date || null,
    lastUpdatePostDate: status.lastUpdatePostDateStruct?.date || null,
    overallStatus: status.overallStatus || '',
    locationCount,
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
  const phaseStr = phases.join('/');

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
 *
 * @param {number} currentPhaseNum
 * @returns {string}
 */
function inferPreviousPhase(currentPhaseNum) {
  const map = { 2: 'PHASE1', 3: 'PHASE2', 4: 'PHASE3' };
  return map[currentPhaseNum] || 'PRE-CLINICAL';
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

/**
 * Upsert a company record into the companies table.
 * On conflict on the 'name' column, returns the existing row.
 *
 * @param {string} name - Company name
 * @returns {Promise<object|null>} The row with id and name, or null on error
 */
async function upsertCompany(name) {
  const { data, error } = await supabase
    .from('companies')
    .upsert({ name, industry: 'Life Sciences' }, { onConflict: 'name' })
    .select('id, name')
    .maybeSingle();

  if (error) {
    console.error(`[clinicalTrialMonitor] upsertCompany failed for "${name}":`, error.message);
    return null;
  }

  return data;
}

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
    finished_at: new Date().toISOString(),
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
async function processStudy(study, now, completionCutoff) {
  const proto = extractProtocol(study);

  // Hard local guard: only INDUSTRY sponsors (API pre-filters, but we confirm)
  if ((proto.leadSponsorClass || '').toUpperCase() !== 'INDUSTRY') {
    return 0;
  }

  if (!proto.nctId || !proto.leadSponsorName) {
    return 0;
  }

  const { phaseStr, phaseNum, isCombined } = parsePhase(proto.phases);
  const studySummary = buildStudySummary(proto);
  const sourceUrl = `${CT_STUDY_BASE}/${proto.nctId}`;

  const company = await upsertCompany(proto.leadSponsorName);
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

  // ── Signal 1: Phase Transition (Phase 2, 3, or 4 studies) ─────────────────
  // The dedup URL includes the current phase number so that when the study
  // advances again to the next phase, a new signal is re-emitted.
  if (phaseNum !== null && phaseNum >= 2) {
    const phaseFrom = inferPreviousPhase(phaseNum);
    const dedupUrl = `${sourceUrl}#PHASE${phaseNum}`;

    const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.PHASE_TRANSITION.type, dedupUrl);

    if (!alreadyExists) {
      const detail = {
        ...baseDetail,
        phase_from: phaseFrom,
        phase_to: phaseStr,
      };

      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: SIGNAL_TYPES.PHASE_TRANSITION.type,
        priority_score: SIGNAL_TYPES.PHASE_TRANSITION.score,
        signal_summary: `${proto.leadSponsorName} study advanced from ${phaseFrom} to ${phaseStr}: ${proto.briefTitle}`,
        signal_detail: detail,
        source_url: dedupUrl,
        detected_at: new Date().toISOString(),
      });

      if (inserted) signalsInserted++;
    }
  }

  // ── Signal 2: New IND — Phase 1 ONLY, no combined 1/2 ────────────────────
  const isPhase1Only =
    !isCombined &&
    proto.phases.length === 1 &&
    proto.phases[0].toUpperCase() === 'PHASE1';

  if (isPhase1Only) {
    const dedupUrl = `${sourceUrl}#IND`;

    const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.NEW_IND.type, dedupUrl);

    if (!alreadyExists) {
      const detail = {
        ...baseDetail,
        phase_from: 'PRE-CLINICAL',
        phase_to: 'PHASE1',
      };

      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: SIGNAL_TYPES.NEW_IND.type,
        priority_score: SIGNAL_TYPES.NEW_IND.score,
        signal_summary: `${proto.leadSponsorName} filed new IND / initiated Phase 1: ${proto.briefTitle}`,
        signal_detail: detail,
        source_url: dedupUrl,
        detected_at: new Date().toISOString(),
      });

      if (inserted) signalsInserted++;
    }
  }

  // ── Signal 3: Site Activation (more than MIN_SITES_FOR_ACTIVATION sites) ──
  if (proto.locationCount > MIN_SITES_FOR_ACTIVATION) {
    // Include the location count in the dedup URL so that a re-expansion to
    // even more sites is treated as a distinct event.
    const dedupUrl = `${sourceUrl}#SITES${proto.locationCount}`;

    const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.SITE_ACTIVATION.type, dedupUrl);

    if (!alreadyExists) {
      const detail = {
        ...baseDetail,
        phase_from: phaseNum ? inferPreviousPhase(phaseNum) : 'N/A',
        phase_to: phaseStr,
      };

      const inserted = await insertSignal({
        company_id: company.id,
        signal_type: SIGNAL_TYPES.SITE_ACTIVATION.type,
        priority_score: SIGNAL_TYPES.SITE_ACTIVATION.score,
        signal_summary: `${proto.leadSponsorName} has activated ${proto.locationCount} sites: ${proto.briefTitle}`,
        signal_detail: detail,
        source_url: dedupUrl,
        detected_at: new Date().toISOString(),
      });

      if (inserted) signalsInserted++;
    }
  }

  // ── Signal 4: Upcoming Primary Completion (within next 90 days) ───────────
  if (proto.primaryCompletionDate) {
    const completionDate = new Date(proto.primaryCompletionDate);

    if (!isNaN(completionDate.getTime()) && completionDate >= now && completionDate <= completionCutoff) {
      const dedupUrl = `${sourceUrl}#COMPLETION${proto.primaryCompletionDate}`;

      const alreadyExists = await signalExists(company.id, SIGNAL_TYPES.COMPLETION.type, dedupUrl);

      if (!alreadyExists) {
        const daysUntilCompletion = Math.ceil(
          (completionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );

        const detail = {
          ...baseDetail,
          phase_from: phaseNum ? inferPreviousPhase(phaseNum) : 'N/A',
          phase_to: phaseStr,
          primary_completion_date: proto.primaryCompletionDate,
          days_until_completion: daysUntilCompletion,
        };

        const inserted = await insertSignal({
          company_id: company.id,
          signal_type: SIGNAL_TYPES.COMPLETION.type,
          priority_score: SIGNAL_TYPES.COMPLETION.score,
          signal_summary: `${proto.leadSponsorName} study completes in ${daysUntilCompletion} days (${proto.primaryCompletionDate}): ${proto.briefTitle}`,
          signal_detail: detail,
          source_url: dedupUrl,
          detected_at: new Date().toISOString(),
        });

        if (inserted) signalsInserted++;
      }
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
  const runId = await createAgentRun();
  const now = new Date();
  const lookbackDate = daysAgo(LOOKBACK_DAYS);
  const completionCutoff = daysFromNow(COMPLETION_WINDOW_DAYS);
  const lastUpdateGte = formatDate(lookbackDate);

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

      const inserted = await processStudy(study, now, completionCutoff);
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
