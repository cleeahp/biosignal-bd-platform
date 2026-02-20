import { supabase } from '../lib/supabase.js'

const NIH_REPORTER_API = 'https://api.reporter.nih.gov/v2/projects/search'
const SEC_EDGAR_API = 'https://efts.sec.gov/LATEST/search-index'

const SIGNAL_SCORES = {
  funding_new_award: 28,
  funding_renewal: 18,
  ma_acquirer: 27,
  ma_acquired: 27,
}

const WARMTH_SCORES = {
  active_client: 25,
  past_client: 18,
  in_ats: 10,
  new_prospect: 0,
}

const LIFE_SCIENCES_TERMS = [
  'pharmaceutical', 'biotech', 'biotechnology', 'clinical', 'therapeutics',
  'biosciences', 'life sciences', 'genomics', 'oncology', 'immunology',
  'medical', 'drug', 'vaccine', 'diagnostics', 'biopharmaceutical',
  'CRO', 'contract research', 'regulatory', 'biologics',
]

function calculatePriorityScore(signalType, warmth) {
  const signalStrength = SIGNAL_SCORES[signalType] || 20
  const recency = 25 // detected today
  const warmthScore = WARMTH_SCORES[warmth] || 0
  const actionability = 0
  return Math.min(signalStrength + recency + warmthScore + actionability, 100)
}

async function upsertCompany(name) {
  if (!name || name.trim().length < 2) return null
  const cleanName = name.trim()

  const { data: existing } = await supabase
    .from('companies')
    .select('id, relationship_warmth')
    .ilike('name', cleanName)
    .maybeSingle()

  if (existing) return existing

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({
      name: cleanName,
      industry: 'Life Sciences',
      relationship_warmth: 'new_prospect',
    })
    .select('id, relationship_warmth')
    .single()

  if (error) {
    console.warn(`Failed to insert company "${cleanName}": ${error.message}`)
    return null
  }

  return newCompany
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

async function insertSignal(company, signalType, summary, detail, sourceUrl, sourceName) {
  const alreadyExists = await signalExists(company.id, signalType, sourceUrl)
  if (alreadyExists) return false

  const priorityScore = calculatePriorityScore(signalType, company.relationship_warmth)
  const { error } = await supabase.from('signals').insert({
    company_id: company.id,
    signal_type: signalType,
    signal_summary: summary,
    signal_detail: detail,
    source_url: sourceUrl,
    source_name: sourceName,
    first_detected_at: new Date().toISOString(),
    status: 'new',
    priority_score: priorityScore,
    score_breakdown: {
      signal_strength: SIGNAL_SCORES[signalType] || 20,
      recency: 25,
      relationship_warmth: WARMTH_SCORES[company.relationship_warmth] || 0,
      actionability: 0,
    },
    days_in_queue: 0,
    is_carried_forward: false,
  })

  if (error) {
    console.warn(`Signal insert failed for ${company.id}/${signalType}: ${error.message}`)
    return false
  }
  return true
}

// ─── NIH Reporter ─────────────────────────────────────────────────────────────

function isLifeSciencesOrg(orgName, projectTitle) {
  const text = `${orgName} ${projectTitle}`.toLowerCase()
  return LIFE_SCIENCES_TERMS.some((t) => text.includes(t.toLowerCase()))
}

async function fetchNihGrants() {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fromDate = sevenDaysAgo.toISOString().split('T')[0]

  const body = {
    criteria: {
      award_notice_date: { from_date: fromDate },
    },
    offset: 0,
    limit: 100,
    sort_field: 'award_notice_date',
    sort_order: 'desc',
  }

  const resp = await fetch(NIH_REPORTER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    throw new Error(`NIH Reporter API error ${resp.status}: ${await resp.text()}`)
  }

  const json = await resp.json()
  return json.results || []
}

async function processNihGrants() {
  let count = 0
  const grants = await fetchNihGrants()
  console.log(`NIH: fetched ${grants.length} grants`)

  for (const grant of grants) {
    const orgName = grant.organization?.org_name || ''
    const projectTitle = grant.project_title || ''
    const awardAmount = grant.award_amount || 0
    const activityCode = grant.activity_code || ''
    const projectNum = grant.project_num || ''

    if (!orgName) continue
    // Filter to Life Sciences context
    if (!isLifeSciencesOrg(orgName, projectTitle)) continue

    // Determine if renewal or new award (renewal codes often start with R01, R21 etc. with suffix >1)
    // Simple heuristic: activity codes beginning with R are grants; suffix number > 1 suggests renewal
    const isRenewal = /R\d\d.*\d{2,}/.test(activityCode) && grant.opportunity_number?.includes('PA-')
    const signalType = isRenewal ? 'funding_renewal' : 'funding_new_award'
    const sourceUrl = projectNum
      ? `https://reporter.nih.gov/project-details/${projectNum}`
      : NIH_REPORTER_API

    const company = await upsertCompany(orgName)
    if (!company) continue

    const summary = isRenewal
      ? `NIH grant renewal: ${projectTitle} ($${(awardAmount / 1000).toFixed(0)}K) awarded to ${orgName}`
      : `New NIH award: ${projectTitle} ($${(awardAmount / 1000).toFixed(0)}K) to ${orgName}`

    const inserted = await insertSignal(
      company,
      signalType,
      summary,
      { project_title: projectTitle, award_amount: awardAmount, activity_code: activityCode, project_num: projectNum, org_name: orgName },
      sourceUrl,
      'NIH Reporter'
    )
    if (inserted) count++
  }

  return count
}

// ─── SEC EDGAR ────────────────────────────────────────────────────────────────

// Keywords that suggest M&A in 8-K filings
const MA_KEYWORDS = [
  'acquisition', 'merger', 'acquires', 'acquired', 'definitive agreement',
  'business combination', 'tender offer', 'takeover', 'consolidation',
]

function isLifeSciencesText(text) {
  return LIFE_SCIENCES_TERMS.some((t) => text.toLowerCase().includes(t.toLowerCase()))
}

function isMaRelated(text) {
  return MA_KEYWORDS.some((kw) => text.toLowerCase().includes(kw.toLowerCase()))
}

// Extract company names from 8-K entity name — crude but functional
function parseCompaniesFromFiling(entityName, description) {
  const companies = []
  if (entityName) companies.push(entityName.trim())

  // Try to extract "acquires XYZ" or "XYZ acquired by ABC" patterns
  const acquiresMatch = description.match(/(?:acquires?|acquired?)\s+([A-Z][A-Za-z\s,\.]+?)(?:\s+for|\s+in|\.|,|$)/i)
  if (acquiresMatch) {
    const target = acquiresMatch[1].trim()
    if (target.length > 2 && target.length < 80) companies.push(target)
  }

  return [...new Set(companies)]
}

async function fetchSecFilings() {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const today = new Date()
  const startdt = sevenDaysAgo.toISOString().split('T')[0]
  const enddt = today.toISOString().split('T')[0]

  const params = new URLSearchParams({
    q: MA_KEYWORDS.slice(0, 3).join(' '),
    dateRange: 'custom',
    startdt,
    enddt,
    forms: '8-K',
    hits: '100',
  })

  const url = `${SEC_EDGAR_API}?${params.toString()}`
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BioSignalBot contact@biosignal.example' },
  })

  if (!resp.ok) {
    throw new Error(`SEC EDGAR API error ${resp.status}: ${await resp.text()}`)
  }

  const json = await resp.json()
  return json.hits?.hits || []
}

async function processSecFilings() {
  let count = 0
  let filings = []

  try {
    filings = await fetchSecFilings()
  } catch (err) {
    console.warn(`SEC EDGAR fetch failed: ${err.message}`)
    return 0
  }

  console.log(`SEC EDGAR: fetched ${filings.length} 8-K filings`)

  for (const hit of filings) {
    const source = hit._source || {}
    const entityName = source.entity_name || source.display_names?.[0] || ''
    const description = source.description || source.file_date || ''
    const filingUrl = source.file_url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${source.entity_id}&type=8-K`

    const fullText = `${entityName} ${description}`

    if (!isLifeSciencesText(fullText)) continue
    if (!isMaRelated(fullText)) continue

    const companies = parseCompaniesFromFiling(entityName, description)

    if (companies.length === 0) continue

    // Create a signal for the acquirer (first company)
    const acquirerCompany = await upsertCompany(companies[0])
    if (acquirerCompany) {
      const inserted = await insertSignal(
        acquirerCompany,
        'ma_acquirer',
        `M&A activity (acquirer): ${companies[0]} involved in Life Sciences deal`,
        { entity_name: entityName, description, filing_url: filingUrl, related_companies: companies },
        filingUrl,
        'SEC EDGAR 8-K'
      )
      if (inserted) count++
    }

    // If a second company was identified, create an ma_acquired signal
    if (companies.length > 1) {
      const acquiredCompany = await upsertCompany(companies[1])
      if (acquiredCompany) {
        const inserted = await insertSignal(
          acquiredCompany,
          'ma_acquired',
          `M&A activity (acquired): ${companies[1]} being acquired in Life Sciences deal`,
          { entity_name: entityName, description, filing_url: filingUrl, related_companies: companies },
          filingUrl,
          'SEC EDGAR 8-K'
        )
        if (inserted) count++
      }
    }
  }

  return count
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runFundingMaAgent() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'funding_ma_agent', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    const [nihCount, secCount] = await Promise.all([
      processNihGrants().catch((err) => {
        console.error('NIH processing error:', err.message)
        return 0
      }),
      processSecFilings().catch((err) => {
        console.error('SEC processing error:', err.message)
        return 0
      }),
    ])

    signalsFound = nihCount + secCount

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: { nih_signals: nihCount, sec_signals: secCount },
      })
      .eq('id', runId)

    console.log(`Funding/MA Agent complete. Signals: NIH=${nihCount}, SEC=${secCount}`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message,
      })
      .eq('id', runId)
    console.error('Funding/MA Agent failed:', error.message)
    return { success: false, error: error.message }
  }
}
