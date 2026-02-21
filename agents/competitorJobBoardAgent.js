import { supabase } from '../lib/supabase.js'
import { matchesRoleKeywords } from '../lib/roleKeywords.js'

// ─── Competitor firms seed data ────────────────────────────────────────────────
// This list is upserted into the competitor_firms table when fewer than 30
// records exist. Career URLs are verified reachable before insertion.

const COMPETITOR_FIRMS_SEED = [
  // URLs verified via HEAD request 2026-02-21
  { name: 'Actalent', careers_url: 'https://www.actalentservices.com/careers' },
  { name: 'Kelly Life Sciences', careers_url: 'https://kellyservices.com/us/jobs/life-sciences/' },
  { name: 'Alku', careers_url: 'https://www.alku.com/jobs/' },
  { name: 'Black Diamond Networks', careers_url: 'https://blackdiamondnetworks.com/jobs/' },
  { name: 'Real Life Sciences', careers_url: 'https://reallifesciences.com/careers/' },
  { name: 'Oxford Global Resources', careers_url: 'https://www.ogr.com/careers' },
  { name: 'The Planet Group', careers_url: 'https://www.theplanetgroup.com/jobs' },
  { name: 'ICON plc', careers_url: 'https://jobs.iconplc.com/jobs' },
  { name: 'Advanced Clinical', careers_url: 'https://www.advancedclinical.com/careers/' },
  { name: 'Randstad Life Sciences', careers_url: 'https://www.randstadusa.com/jobs/life-sciences' },
  { name: 'Joule Staffing', careers_url: 'https://www.joulesolutions.com/find-a-job' },
  { name: 'Beacon Hill Staffing Group', careers_url: 'https://www.beaconhillstaffing.com/jobs' },
  { name: 'ASGN Incorporated', careers_url: 'https://www.asgn.com' },
  { name: 'Net2Source', careers_url: 'https://www.net2source.com/jobs/' },
  { name: 'USTech Solutions', careers_url: 'https://ustechsolutions.com/jobs/' },
  { name: 'Yoh Services', careers_url: 'https://www.yoh.com' },
  { name: 'Soliant Health', careers_url: 'https://www.soliant.com/jobs/' },
  { name: 'Medix Staffing', careers_url: 'https://www.medixteam.com/job-search/' },
  { name: 'Epic Staffing Group', careers_url: 'https://www.epicstaffinggroup.com' },
  { name: 'Solomon Page', careers_url: 'https://www.solomonpage.com/find-a-job/' },
  { name: 'Spectra Force', careers_url: 'https://www.spectraforce.com/careers' },
  { name: 'Mindlance', careers_url: 'https://www.mindlance.com/careers/' },
  { name: 'Green Key Resources', careers_url: 'https://www.greenkeyresources.com/find-a-job' },
  { name: 'Phaidon International', careers_url: 'https://phaidoninternational.com/jobs' },
  { name: 'Peoplelink Group', careers_url: 'https://peoplelinkgroup.com/job-seekers/' },
  { name: 'Pacer Staffing', careers_url: 'https://www.pacerstaffing.com/job-seekers/' },
  { name: 'ZP Group', careers_url: 'https://zp.group/job-seekers/' },
  { name: 'Meet Staffing', careers_url: 'https://meetstaffing.com/jobs/' },
  { name: 'Ampcus', careers_url: 'https://ampcus.com/jobs/' },
  { name: 'ClinLab Staffing', careers_url: 'https://clinlabstaffing.com/job-seekers/' },
  { name: 'Medpace', careers_url: 'https://medpace.com/careers/open-positions/' },
  { name: 'Syneos Health', careers_url: 'https://jobs.syneoshealth.com' },
  { name: 'Fortrea', careers_url: 'https://careers.fortrea.com/jobs' },
  { name: 'Halloran Consulting', careers_url: 'https://www.halloran-consulting.com/careers' },
  { name: 'Premier Research', careers_url: 'https://premierresearch.com/careers/' },
  { name: 'Worldwide Clinical Trials', careers_url: 'https://worldwideclinicaltrials.com/careers/' },
  { name: 'IQVIA', careers_url: 'https://jobs.iqvia.com' },
  { name: 'Parexel', careers_url: 'https://parexel.com/careers' },
  { name: 'Labcorp Drug Development', careers_url: 'https://jobs.labcorp.com' },
  { name: 'ProPharma Group', careers_url: 'https://propharmagroup.com/careers/' },
  { name: 'TalentBurst', careers_url: 'https://talentburst.com/jobs/' },
  { name: 'KForce', careers_url: 'https://kforce.com/job-seekers/' },
  { name: 'WuXi AppTec Clinical', careers_url: 'https://wuxiclinical.com/careers' },
  { name: 'Charles River Laboratories', careers_url: 'https://careers.crl.com' },
  { name: 'Integrated Project Management', careers_url: 'https://ipmglobal.com/careers' },
]

const BOT_UA = 'Mozilla/5.0 (compatible; BioSignalBot/1.0)'
const CLINICALTRIALS_API = 'https://clinicaltrials.gov/api/v2/studies'

// ─── Shared signal helpers ─────────────────────────────────────────────────────

async function upsertCompany(name) {
  const { data } = await supabase
    .from('companies')
    .upsert({ name, industry: 'Life Sciences' }, { onConflict: 'name' })
    .select()
    .single()
  return data
}

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
// Only runs when the table has fewer than 30 rows. Each firm's career URL is
// verified with a HEAD request before being written to the database. HTTP 405
// (Method Not Allowed) is treated as success — the site is reachable.

async function seedCompetitorFirms() {
  const { count } = await supabase
    .from('competitor_firms')
    .select('*', { count: 'exact', head: true })

  if (count >= 30) return { seeded: 0, skipped: 0, skippedFirms: [] }

  let seeded = 0
  let skipped = 0
  const skippedFirms = []

  for (const firm of COMPETITOR_FIRMS_SEED) {
    try {
      const resp = await fetch(firm.careers_url, {
        method: 'HEAD',
        headers: { 'User-Agent': BOT_UA },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      })
      const ok = resp.status < 400 || resp.status === 405
      if (ok) {
        await supabase
          .from('competitor_firms')
          .upsert(
            { name: firm.name, careers_url: firm.careers_url, is_active: true },
            { onConflict: 'name' }
          )
        seeded++
      } else {
        skippedFirms.push({ name: firm.name, reason: `HTTP ${resp.status}` })
        skipped++
      }
    } catch (err) {
      skippedFirms.push({ name: firm.name, reason: err.message })
      skipped++
    }
    // Avoid hammering servers during bulk seed
    await new Promise((r) => setTimeout(r, 100))
  }

  return { seeded, skipped, skippedFirms }
}

// ─── Client inference from trial metadata ─────────────────────────────────────
// Determines which pharma/biotech company is the CRO's likely client.
// "High confidence" = lead sponsor is INDUSTRY and is not the CRO itself.
// "Medium confidence" = an industry collaborator that is not the CRO.
// "Low confidence" = no industry party distinguishable from the CRO.

function inferLikelyClient(trial, firmName) {
  const sponsor = trial.protocolSection?.sponsorsModule?.leadSponsor
  const collaborators = trial.protocolSection?.sponsorsModule?.collaborators || []
  const firmLower = firmName.toLowerCase()

  if (
    sponsor?.class === 'INDUSTRY' &&
    sponsor.name &&
    !sponsor.name.toLowerCase().includes(firmLower)
  ) {
    return { likely_client: sponsor.name, confidence: 'high' }
  }

  const industryCollab = collaborators.find(
    (c) =>
      c.class === 'INDUSTRY' &&
      c.name &&
      !c.name.toLowerCase().includes(firmLower)
  )
  if (industryCollab) {
    return { likely_client: industryCollab.name, confidence: 'medium' }
  }

  return { likely_client: 'Unknown', confidence: 'low' }
}

// ─── ClinicalTrials.gov query for a single firm ────────────────────────────────
// Searches for active RECRUITING or ACTIVE_NOT_RECRUITING interventional trials
// where the firm appears as sponsor or collaborator. Returns raw study objects.

async function fetchTrialsForFirm(firmName) {
  const params = new URLSearchParams({
    'query.term': firmName,
    'filter.advanced':
      'AREA[CollaboratorClass]INDUSTRY OR AREA[LeadSponsorClass]INDUSTRY',
    'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING',
    pageSize: '5',
    fields:
      'NCTId,BriefTitle,LeadSponsorName,LeadSponsorClass,CollaboratorsModule,Phase,OverallStatus,LocationCountry',
  })

  let json
  try {
    const resp = await fetch(`${CLINICALTRIALS_API}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) {
      console.warn(`CT.gov query for "${firmName}" returned HTTP ${resp.status}`)
      return []
    }
    json = await resp.json()
  } catch (err) {
    console.warn(`CT.gov fetch error for "${firmName}": ${err.message}`)
    return []
  }

  const studies = json.studies || []
  console.log(`CT.gov "${firmName}": ${studies.length} active trials`)
  return studies
}

// ─── Derive a firm slug for use in compound source URLs ───────────────────────

function toFirmSlug(firmName) {
  return firmName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ─── Derive a readable phase label from the CT.gov phases array ───────────────

function phaseLabel(phases) {
  if (!phases || phases.length === 0) return 'Unknown Phase'
  if (phases.includes('PHASE4')) return 'Phase 4'
  if (phases.includes('PHASE3')) return 'Phase 3'
  if (phases.includes('PHASE2')) return 'Phase 2'
  if (phases.includes('PHASE1')) return 'Phase 1'
  return phases[0].replace('_', ' ')
}

// ─── Persist a single competitor trial signal ──────────────────────────────────

async function persistCompetitorSignal(firmName, trial, nctId) {
  const firmCompany = await upsertCompany(firmName)
  if (!firmCompany) return false

  const { likely_client, confidence } = inferLikelyClient(trial, firmName)
  const firmSlug = toFirmSlug(firmName)

  // Compound source URL makes the dedup key unique per (firm × trial)
  const sourceUrl = `https://clinicaltrials.gov/study/${nctId}#competitor-${firmSlug}`
  const exists = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const ps = trial.protocolSection || {}
  const phases = ps.designModule?.phases || ps.Phase || []
  const status = ps.statusModule?.overallStatus || ps.OverallStatus || 'Unknown'
  const briefTitle = ps.identificationModule?.briefTitle || ps.BriefTitle || 'Unknown Trial'
  const countries = ps.contactsLocationsModule?.locations
    ? [...new Set(ps.contactsLocationsModule.locations.map((l) => l.country).filter(Boolean))]
    : ps.LocationCountry || []
  const locationStr =
    countries.length > 0 ? countries.slice(0, 3).join(', ') : 'Multiple Sites'

  const label = phaseLabel(Array.isArray(phases) ? phases : [phases])
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('signals').insert({
    company_id: firmCompany.id,
    signal_type: 'competitor_job_posting',
    signal_summary: `${firmName} active on ${label} trial for ${likely_client} (${status}) — competitor CRO intelligence`,
    signal_detail: {
      job_title: `Clinical Research Staff - ${label} (${status})`,
      job_location: locationStr,
      posting_date: today,
      competitor_firm: firmName,
      likely_client,
      likely_client_confidence: confidence,
      source_url: `https://clinicaltrials.gov/study/${nctId}`,
      nct_id: nctId,
      trial_phase: label,
      trial_status: status,
      trial_title:
        briefTitle.length > 120 ? briefTitle.slice(0, 117) + '...' : briefTitle,
    },
    source_url: sourceUrl,
    source_name: 'ClinicalTrials.gov',
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: 18,
    score_breakdown: { signal_strength: 18 },
    days_in_queue: 0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`Signal insert failed for ${firmName}/${nctId}: ${error.message}`)
    return false
  }
  return true
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function run() {
  const { data: runEntry } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'competitor-job-board-agent',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  const runId = runEntry?.id

  let signalsFound = 0

  try {
    // ── Step 1: Seed competitor firms table if needed ────────────────────────
    const seedResult = await seedCompetitorFirms()
    console.log(
      `Competitor seed: ${seedResult.seeded} inserted, ${seedResult.skipped} skipped`
    )

    // ── Step 2: Load active firms from DB ───────────────────────────────────
    const { data: allFirms, error: firmsErr } = await supabase
      .from('competitor_firms')
      .select('name, careers_url')
      .eq('is_active', true)
      .order('name')

    if (firmsErr) throw new Error(`Failed to load competitor firms: ${firmsErr.message}`)

    const firmsToCheck = allFirms || []
    console.log(
      `Competitor Job Board: processing ALL ${firmsToCheck.length} active firms this run`
    )

    let firmsChecked = 0

    // ── Step 3: For each firm, query ClinicalTrials.gov (400ms delay between firms)
    for (const firm of firmsToCheck) {
      const studies = await fetchTrialsForFirm(firm.name)
      firmsChecked++

      for (const study of studies) {
        const ps = study.protocolSection || {}
        const nctId = ps.identificationModule?.nctId || study.NCTId
        if (!nctId) continue

        const inserted = await persistCompetitorSignal(firm.name, study, nctId)
        if (inserted) signalsFound++
      }

      // 400ms delay between firms — balanced against Vercel 300s timeout
      if (firmsChecked < firmsToCheck.length) {
        await new Promise((r) => setTimeout(r, 400))
      }
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          firms_checked: firmsChecked,
          total_active_firms: allFirms?.length ?? 0,
          seed_result: {
            seeded: seedResult.seeded,
            skipped: seedResult.skipped,
            skipped_firms: seedResult.skippedFirms,
          },
        },
      })
      .eq('id', runId)

    console.log(
      `Competitor Job Board Agent complete — signals: ${signalsFound}, firms checked: ${firmsChecked}`
    )

    return {
      signalsFound,
      firmsChecked,
      seedResult: {
        seeded: seedResult.seeded,
        skipped: seedResult.skipped,
        skippedFirms: seedResult.skippedFirms,
      },
    }
  } catch (err) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err.message,
      })
      .eq('id', runId)
    throw err
  }
}
