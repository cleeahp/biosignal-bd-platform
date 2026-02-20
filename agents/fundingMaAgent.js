import { supabase } from '../lib/supabase.js'

const NIH_REPORTER_API = 'https://api.reporter.nih.gov/v2/projects/search'
const SEC_EDGAR_SEARCH  = 'https://efts.sec.gov/LATEST/search-index'

const SIGNAL_SCORES = {
  funding_new_award: 28,
  funding_renewal:   18,
  ma_acquirer:       27,
  ma_acquired:       27,
}

const WARMTH_SCORES = {
  active_client: 25,
  past_client:   18,
  in_ats:        10,
  new_prospect:   0,
}

const LIFE_SCIENCES_TERMS = [
  'pharmaceutical', 'biotech', 'biotechnology', 'clinical', 'therapeutics',
  'biosciences', 'life sciences', 'genomics', 'oncology', 'immunology',
  'medical', 'drug', 'vaccine', 'diagnostics', 'biopharmaceutical',
  'CRO', 'contract research', 'regulatory', 'biologics', 'biopharma',
  'gene therapy', 'cell therapy', 'antibody', 'oncology', 'neurology',
]

function isLifeSciencesText(text) {
  const t = text.toLowerCase()
  return LIFE_SCIENCES_TERMS.some((term) => t.includes(term.toLowerCase()))
}

function calculatePriorityScore(signalType, warmth) {
  const signalStrength = SIGNAL_SCORES[signalType] || 20
  const recency = 25
  const warmthScore = WARMTH_SCORES[warmth] || 0
  return Math.min(signalStrength + recency + warmthScore, 100)
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
    .insert({ name: cleanName, industry: 'Life Sciences', relationship_warmth: 'new_prospect' })
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

function formatAmount(amount) {
  if (!amount || amount === 0) return null
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`
  return `$${amount}`
}

// ─── NIH Reporter: SBIR / STTR (government grants to private industry) ─────────
// Activity codes: SBIR=SB*, STTR=ST* — these are grants specifically for small
// businesses (biotech/pharma companies), not universities or hospitals.

async function processNihIndustryGrants() {
  let count = 0
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fromDate = sevenDaysAgo.toISOString().split('T')[0]

  const body = {
    criteria: {
      award_notice_date: { from_date: fromDate },
      // SBIR/STTR activity codes target private companies
      activity_codes: ['R44', 'R43', 'R41', 'R42', 'U44', 'SB1', 'SB2'],
    },
    offset: 0,
    limit: 100,
    sort_field: 'award_notice_date',
    sort_order: 'desc',
  }

  let grants = []
  try {
    const resp = await fetch(NIH_REPORTER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.warn(`NIH Reporter returned HTTP ${resp.status}`)
      return 0
    }
    const json = await resp.json()
    grants = json.results || []
  } catch (err) {
    console.warn(`NIH Reporter fetch failed: ${err.message}`)
    return 0
  }

  console.log(`NIH SBIR/STTR: fetched ${grants.length} grants`)

  for (const grant of grants) {
    const orgName = grant.organization?.org_name || ''
    const projectTitle = grant.project_title || ''
    const awardAmount = grant.award_amount || 0
    const activityCode = grant.activity_code || ''
    const projectNum = grant.project_num || ''
    const awardDate = grant.award_notice_date || null

    if (!orgName) continue
    if (!isLifeSciencesText(`${orgName} ${projectTitle}`)) continue

    // Distinguish new award vs renewal: R44/R42/SB2 = Phase II (renewal), R43/R41/SB1 = Phase I (new)
    const isRenewal = ['R44', 'R42', 'SB2', 'U44'].includes(activityCode.toUpperCase())
    const signalType = isRenewal ? 'funding_renewal' : 'funding_new_award'
    const sourceUrl = projectNum
      ? `https://reporter.nih.gov/project-details/${projectNum}`
      : NIH_REPORTER_API

    const company = await upsertCompany(orgName)
    if (!company) continue

    const amtStr = formatAmount(awardAmount)
    const summary = isRenewal
      ? `NIH SBIR Phase II renewal${amtStr ? ` (${amtStr})` : ''}: ${projectTitle} — ${orgName}`
      : `NIH SBIR/STTR award${amtStr ? ` (${amtStr})` : ''}: ${projectTitle} — ${orgName}`

    const inserted = await insertSignal(
      company,
      signalType,
      summary,
      {
        company_name: orgName,
        funding_type: 'government_grant',
        funding_amount: amtStr,
        funding_summary: `${activityCode} grant for: ${projectTitle}`,
        date_announced: awardDate,
        source_url: sourceUrl,
        project_num: projectNum,
        activity_code: activityCode,
      },
      sourceUrl,
      'NIH Reporter'
    )
    if (inserted) count++
  }

  return count
}

// ─── SEC EDGAR: M&A signals (8-K filings with acquisition keywords) ─────────────

const MA_KEYWORDS = [
  'acquisition', 'merger', 'acquires', 'acquired', 'definitive agreement',
  'business combination', 'tender offer', 'takeover',
]

function isMaRelated(text) {
  return MA_KEYWORDS.some((kw) => text.toLowerCase().includes(kw))
}

function parseCompaniesFromFiling(entityName, description) {
  const companies = []
  if (entityName) companies.push(entityName.trim())
  const acquiresMatch = description.match(/(?:acquires?|acquired?)\s+([A-Z][A-Za-z\s,\.]+?)(?:\s+for|\s+in|\.|,|$)/i)
  if (acquiresMatch) {
    const target = acquiresMatch[1].trim()
    if (target.length > 2 && target.length < 80) companies.push(target)
  }
  return [...new Set(companies)]
}

async function processSecMaFilings() {
  let count = 0
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const startdt = sevenDaysAgo.toISOString().split('T')[0]
  const enddt = new Date().toISOString().split('T')[0]

  const params = new URLSearchParams({
    q: MA_KEYWORDS.slice(0, 3).join(' '),
    dateRange: 'custom',
    startdt,
    enddt,
    forms: '8-K',
    hits: '100',
  })

  let filings = []
  try {
    const resp = await fetch(`${SEC_EDGAR_SEARCH}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'BioSignalBot contact@biosignal.example' },
    })
    if (!resp.ok) {
      console.warn(`SEC EDGAR 8-K returned HTTP ${resp.status}`)
      return 0
    }
    const json = await resp.json()
    filings = json.hits?.hits || []
  } catch (err) {
    console.warn(`SEC EDGAR 8-K fetch failed: ${err.message}`)
    return 0
  }

  console.log(`SEC EDGAR 8-K: fetched ${filings.length} M&A filings`)

  for (const hit of filings) {
    const source = hit._source || {}
    const entityName = source.entity_name || source.display_names?.[0] || ''
    const description = source.description || ''
    const filingUrl = source.file_url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${source.entity_id}&type=8-K`
    const filedDate = source.file_date || null

    const fullText = `${entityName} ${description}`
    if (!isLifeSciencesText(fullText)) continue
    if (!isMaRelated(fullText)) continue

    const companies = parseCompaniesFromFiling(entityName, description)
    if (companies.length === 0) continue

    const acquirerCompany = await upsertCompany(companies[0])
    if (acquirerCompany) {
      const inserted = await insertSignal(
        acquirerCompany,
        'ma_acquirer',
        `M&A (acquirer): ${companies[0]} in Life Sciences deal`,
        {
          company_name: companies[0],
          funding_type: 'acquisition',
          funding_amount: null,
          funding_summary: description.slice(0, 200),
          date_announced: filedDate,
          source_url: filingUrl,
          related_companies: companies,
        },
        filingUrl,
        'SEC EDGAR 8-K'
      )
      if (inserted) count++
    }

    if (companies.length > 1) {
      const acquiredCompany = await upsertCompany(companies[1])
      if (acquiredCompany) {
        const inserted = await insertSignal(
          acquiredCompany,
          'ma_acquired',
          `M&A (acquired): ${companies[1]} being acquired in Life Sciences deal`,
          {
            company_name: companies[1],
            funding_type: 'acquisition',
            funding_amount: null,
            funding_summary: description.slice(0, 200),
            date_announced: filedDate,
            source_url: filingUrl,
            related_companies: companies,
          },
          filingUrl,
          'SEC EDGAR 8-K'
        )
        if (inserted) count++
      }
    }
  }

  return count
}

// ─── SEC EDGAR: Pharma partnerships (8-K filings with licensing/collaboration) ──

const PARTNERSHIP_KEYWORDS = [
  'collaboration agreement', 'license agreement', 'licensing agreement',
  'co-development', 'partnership agreement', 'strategic alliance',
  'exclusive license', 'royalty agreement', 'co-promotion',
]

function isPartnershipRelated(text) {
  return PARTNERSHIP_KEYWORDS.some((kw) => text.toLowerCase().includes(kw))
}

// Rough dollar amount extraction for partnership deals
function extractDealAmount(text) {
  const m = text.match(/\$[\d,.]+\s*(?:million|billion|M|B)\b/i)
    || text.match(/(?:USD|US\$)\s*[\d,.]+\s*(?:million|billion)/i)
  if (!m) return null
  const raw = m[0].replace(/[^0-9.MBmillion billion]/gi, '')
  if (/billion/i.test(m[0]) || /B\b/.test(m[0])) {
    const n = parseFloat(raw)
    return isNaN(n) ? m[0] : `$${n}B`
  }
  const n = parseFloat(raw)
  return isNaN(n) ? m[0] : `$${n}M`
}

async function processSecPartnershipFilings() {
  let count = 0
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const startdt = sevenDaysAgo.toISOString().split('T')[0]
  const enddt = new Date().toISOString().split('T')[0]

  const params = new URLSearchParams({
    q: '"collaboration agreement" OR "license agreement" OR "licensing agreement"',
    dateRange: 'custom',
    startdt,
    enddt,
    forms: '8-K',
    hits: '50',
  })

  let filings = []
  try {
    const resp = await fetch(`${SEC_EDGAR_SEARCH}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'BioSignalBot contact@biosignal.example' },
    })
    if (!resp.ok) {
      console.warn(`SEC EDGAR partnerships returned HTTP ${resp.status}`)
      return 0
    }
    const json = await resp.json()
    filings = json.hits?.hits || []
  } catch (err) {
    console.warn(`SEC EDGAR partnership fetch failed: ${err.message}`)
    return 0
  }

  console.log(`SEC EDGAR partnership 8-K: fetched ${filings.length} filings`)

  for (const hit of filings) {
    const source = hit._source || {}
    const entityName = source.entity_name || source.display_names?.[0] || ''
    const description = source.description || ''
    const filingUrl = source.file_url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${source.entity_id}&type=8-K`
    const filedDate = source.file_date || null

    const fullText = `${entityName} ${description}`
    if (!isLifeSciencesText(fullText)) continue
    if (!isPartnershipRelated(fullText)) continue

    const company = await upsertCompany(entityName)
    if (!company) continue

    const dealAmount = extractDealAmount(description)

    const inserted = await insertSignal(
      company,
      'funding_new_award',
      `Pharma partnership deal${dealAmount ? ` (${dealAmount})` : ''}: ${entityName} — ${description.slice(0, 100)}`,
      {
        company_name: entityName,
        funding_type: 'pharma_partnership',
        funding_amount: dealAmount,
        funding_summary: description.slice(0, 300),
        date_announced: filedDate,
        source_url: filingUrl,
      },
      filingUrl,
      'SEC EDGAR 8-K'
    )
    if (inserted) count++
  }

  return count
}

// ─── SEC EDGAR: IPO signals (S-1 / S-11 registration statements) ───────────────

async function processSecIpoFilings() {
  let count = 0
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const startdt = thirtyDaysAgo.toISOString().split('T')[0]
  const enddt = new Date().toISOString().split('T')[0]

  const params = new URLSearchParams({
    q: 'life sciences OR biotech OR pharmaceutical OR therapeutics OR biopharmaceutical',
    dateRange: 'custom',
    startdt,
    enddt,
    forms: 'S-1',
    hits: '50',
  })

  let filings = []
  try {
    const resp = await fetch(`${SEC_EDGAR_SEARCH}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'BioSignalBot contact@biosignal.example' },
    })
    if (!resp.ok) {
      console.warn(`SEC EDGAR S-1 returned HTTP ${resp.status}`)
      return 0
    }
    const json = await resp.json()
    filings = json.hits?.hits || []
  } catch (err) {
    console.warn(`SEC EDGAR S-1 fetch failed: ${err.message}`)
    return 0
  }

  console.log(`SEC EDGAR S-1 (IPO): fetched ${filings.length} filings`)

  for (const hit of filings) {
    const source = hit._source || {}
    const entityName = source.entity_name || source.display_names?.[0] || ''
    const description = source.description || ''
    const filingUrl = source.file_url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${source.entity_id}&type=S-1`
    const filedDate = source.file_date || null

    const fullText = `${entityName} ${description}`
    if (!isLifeSciencesText(fullText)) continue

    const company = await upsertCompany(entityName)
    if (!company) continue

    const inserted = await insertSignal(
      company,
      'funding_new_award',
      `IPO filing: ${entityName} filed S-1 registration statement`,
      {
        company_name: entityName,
        funding_type: 'ipo',
        funding_amount: null,
        funding_summary: `${entityName} filed S-1 registration with SEC — potential IPO`,
        date_announced: filedDate,
        source_url: filingUrl,
      },
      filingUrl,
      'SEC EDGAR S-1'
    )
    if (inserted) count++
  }

  return count
}

// ─── SEC EDGAR: VC rounds (Form D — private placement / exempt offerings) ───────
// Form D is filed when private companies raise capital in exempt offerings (VC rounds).
// Life Sciences companies use this to report Series A/B/C/D rounds.

async function processSecFormDFilings() {
  let count = 0
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const startdt = thirtyDaysAgo.toISOString().split('T')[0]
  const enddt = new Date().toISOString().split('T')[0]

  const params = new URLSearchParams({
    q: 'pharmaceutical OR biotech OR therapeutics OR biosciences OR biopharmaceutical',
    dateRange: 'custom',
    startdt,
    enddt,
    forms: 'D',
    hits: '100',
  })

  let filings = []
  try {
    const resp = await fetch(`${SEC_EDGAR_SEARCH}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'BioSignalBot contact@biosignal.example' },
    })
    if (!resp.ok) {
      console.warn(`SEC EDGAR Form D returned HTTP ${resp.status}`)
      return 0
    }
    const json = await resp.json()
    filings = json.hits?.hits || []
  } catch (err) {
    console.warn(`SEC EDGAR Form D fetch failed: ${err.message}`)
    return 0
  }

  console.log(`SEC EDGAR Form D (VC): fetched ${filings.length} filings`)

  for (const hit of filings) {
    const source = hit._source || {}
    const entityName = source.entity_name || source.display_names?.[0] || ''
    const description = source.description || ''
    const filingUrl = source.file_url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${source.entity_id}&type=D`
    const filedDate = source.file_date || null

    const fullText = `${entityName} ${description}`
    if (!isLifeSciencesText(fullText)) continue
    if (!entityName || entityName.length < 3) continue

    // Skip obvious non-company entities (funds, LLCs that are investment vehicles)
    if (/fund|capital|ventures?\b|partners?\b|holdings?/i.test(entityName)) continue

    const company = await upsertCompany(entityName)
    if (!company) continue

    const inserted = await insertSignal(
      company,
      'funding_new_award',
      `VC/private raise: ${entityName} filed Form D exempt offering`,
      {
        company_name: entityName,
        funding_type: 'venture_capital',
        funding_amount: null, // Form D XML has amount but EDGAR search doesn't return it directly
        funding_summary: `${entityName} filed SEC Form D for exempt private offering (potential VC/Series round)`,
        date_announced: filedDate,
        source_url: filingUrl,
      },
      filingUrl,
      'SEC EDGAR Form D'
    )
    if (inserted) count++
  }

  return count
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function runFundingMaAgent() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'funding_ma_agent', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    const [nihCount, maCount, partnershipCount, ipoCount, vcCount] = await Promise.all([
      processNihIndustryGrants().catch((err) => { console.error('NIH error:', err.message); return 0 }),
      processSecMaFilings().catch((err)       => { console.error('SEC M&A error:', err.message); return 0 }),
      processSecPartnershipFilings().catch((err) => { console.error('SEC partnership error:', err.message); return 0 }),
      processSecIpoFilings().catch((err)      => { console.error('SEC IPO error:', err.message); return 0 }),
      processSecFormDFilings().catch((err)    => { console.error('SEC Form D error:', err.message); return 0 }),
    ])

    signalsFound = nihCount + maCount + partnershipCount + ipoCount + vcCount

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          nih_sbir_signals: nihCount,
          ma_signals: maCount,
          partnership_signals: partnershipCount,
          ipo_signals: ipoCount,
          vc_signals: vcCount,
        },
      })
      .eq('id', runId)

    console.log(`Funding/MA Agent complete. Signals: NIH=${nihCount} M&A=${maCount} Partnership=${partnershipCount} IPO=${ipoCount} VC=${vcCount}`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Funding/MA Agent failed:', error.message)
    return { success: false, error: error.message }
  }
}
