import { supabase, upsertCompany } from '../lib/supabase.js'
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

// Non-US country names. If the inferred client company name contains one of these
// it is likely a non-US entity — we only generate signals for US-based clients.
const NON_US_CLIENT_PATTERNS =
  /\b(Canada|UK|United Kingdom|Germany|France|Netherlands|Switzerland|Sweden|Australia|Japan|China|India|Korea|Singapore|Ireland|Denmark|Belgium|Italy|Spain|Brazil|Israel|Norway|Finland|Taiwan|GmbH|AG\b|NV\b|BV\b)\b/i

// ─── Shared signal helpers ─────────────────────────────────────────────────────

// upsertCompany imported from lib/supabase.js (shared ilike check-then-insert pattern)

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
        const { data: existingFirm } = await supabase
          .from('competitor_firms')
          .select('id')
          .ilike('name', firm.name)
          .maybeSingle()
        if (existingFirm) {
          await supabase
            .from('competitor_firms')
            .update({ is_active: true })
            .eq('id', existingFirm.id)
        } else {
          await supabase
            .from('competitor_firms')
            .insert({ name: firm.name, careers_url: firm.careers_url, is_active: true })
        }
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

// ─── Client inference from career page HTML + companies table ─────────────────
// Previously this used ClinicalTrials.gov per-firm queries (query.term=firmName),
// which return HTTP 400 because competitor firm names are not valid CT.gov sponsor
// search terms. Replaced with: fetch the firm's own career page, then scan for any
// known Life Sciences company name from our companies table.

async function inferClientFromCareerPage(careersUrl, firmName, knownCompanyNames) {
  if (!careersUrl) return { likely_client: 'Unknown', confidence: 'low' }

  let html = ''
  try {
    const resp = await fetch(careersUrl, {
      headers: { 'User-Agent': BOT_UA },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })
    if (!resp.ok) return { likely_client: 'Unknown', confidence: 'low' }
    html = await resp.text()
  } catch {
    return { likely_client: 'Unknown', confidence: 'low' }
  }

  if (html.length < 500) return { likely_client: 'Unknown', confidence: 'low' }

  const htmlLower = html.toLowerCase()
  const firmLower = firmName.toLowerCase()

  for (const companyName of knownCompanyNames) {
    if (!companyName || companyName.length < 5) continue
    // Skip if the company name is the firm itself
    if (companyName.toLowerCase().includes(firmLower) || firmLower.includes(companyName.toLowerCase())) continue
    if (htmlLower.includes(companyName.toLowerCase())) {
      return { likely_client: companyName, confidence: 'medium' }
    }
  }

  return { likely_client: 'Unknown', confidence: 'low' }
}

// ─── Persist a single competitor activity signal ───────────────────────────────
// Dedup key is firm + ISO week so one signal per firm per week at most.

async function persistCompetitorSignal(firmName, careersUrl, likelyClient, confidence) {
  // US-only: skip signals where the inferred client is clearly a non-US entity
  if (likelyClient && likelyClient !== 'Unknown' && NON_US_CLIENT_PATTERNS.test(likelyClient)) {
    console.log(`[competitorJobBoard] FILTERED (non-US client): ${likelyClient} via ${firmName}`)
    return false
  }

  const firmCompany = await upsertCompany(supabase, { name: firmName })
  if (!firmCompany) return false

  // One signal per firm per calendar week
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
  const sourceUrl = `${careersUrl || 'https://biosignal.app'}#competitor-week-${weekNum}`
  const exists = await signalExists(firmCompany.id, 'competitor_job_posting', sourceUrl)
  if (exists) return false

  const today = new Date().toISOString().split('T')[0]
  const clientNote = likelyClient !== 'Unknown' ? ` — likely client: ${likelyClient}` : ''

  const { error } = await supabase.from('signals').insert({
    company_id: firmCompany.id,
    signal_type: 'competitor_job_posting',
    signal_summary: `${firmName} actively hiring in life sciences${clientNote}`,
    signal_detail: {
      job_title: 'Active life sciences hiring',
      job_location: '',
      posting_date: today,
      competitor_firm: firmName,
      likely_client: likelyClient,
      likely_client_confidence: confidence,
      source_url: careersUrl || '',
    },
    source_url: sourceUrl,
    source_name: 'CareersPage',
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: 15,
    score_breakdown: { signal_strength: 15 },
    days_in_queue: 0,
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

    // ── Step 3: Load known Life Sciences companies for client inference ──────
    const { data: knownCompanies } = await supabase
      .from('companies')
      .select('name')
      .eq('industry', 'Life Sciences')
      .limit(200)
    const knownCompanyNames = (knownCompanies || []).map((c) => c.name)
    console.log(`Loaded ${knownCompanyNames.length} known companies for client inference`)

    // ── Step 4: For each firm, fetch career page and infer likely client ─────
    // CT.gov per-firm queries are REMOVED — query.term=firmName returns HTTP 400.
    // Instead: fetch career page HTML, scan for known company names from DB.
    for (const firm of firmsToCheck) {
      firmsChecked++

      const { likely_client, confidence } = await inferClientFromCareerPage(
        firm.careers_url,
        firm.name,
        knownCompanyNames
      )
      console.log(`${firm.name}: likely_client="${likely_client}" (${confidence})`)

      const inserted = await persistCompetitorSignal(
        firm.name,
        firm.careers_url,
        likely_client,
        confidence
      )
      if (inserted) signalsFound++

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
