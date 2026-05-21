import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

async function fetchAll(table, select) {
  const rows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

function isBigCo(size) {
  return size === '10,001+ employees' || size === '10,001+'
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Past clients (for override on size filter)
    const { data: clientRows, error: clientErr } = await supabase
      .from('past_clients')
      .select('name, matched_name')
      .eq('is_active', true)
    if (clientErr) throw new Error(`past_clients: ${clientErr.message}`)
    const pastClientMatchedNames = new Set(
      (clientRows || []).map(r => r.matched_name).filter(Boolean).map(n => n.toLowerCase())
    )
    const pastClientNames = new Set(
      (clientRows || []).map(r => r.name).filter(Boolean).map(n => n.toLowerCase())
    )
    const keepBigCo = (matchedName) => {
      const name = (matchedName || '').toLowerCase()
      if (!name) return false
      if (pastClientMatchedNames.has(name)) return true
      return pastClientNames.has(name)
    }

    // Madison Leads: count of tracked companies
    const { count: madisonCount, error: madisonErr } = await supabase
      .from('madison_leads')
      .select('*', { count: 'exact', head: true })
    if (madisonErr) throw new Error(`madison_leads: ${madisonErr.message}`)

    // Jim Leads: count of tracked companies
    const { count: jimCount, error: jimErr } = await supabase
      .from('jim_leads')
      .select('*', { count: 'exact', head: true })
    if (jimErr) throw new Error(`jim_leads: ${jimErr.message}`)

    // Tim Leads: count of tracked companies
    const { count: timCount, error: timErr } = await supabase
      .from('tim_leads')
      .select('*', { count: 'exact', head: true })
    if (timErr) throw new Error(`tim_leads: ${timErr.message}`)

    // Clinical Trials - NEW: size filter only (matches /api/clinical-trials)
    const trials = await fetchAll('clinical_trials', 'matched_name, company_size')
    const clinicalNewCount = trials.filter(t => {
      if (isBigCo(t.company_size)) return keepBigCo(t.matched_name)
      return true
    }).length

    // M&A - NEW: 8-K with Item 1.01 + S-1, size filter (matches /api/ma-funding)
    const eightK = await fetchAll('eight_k_filings', 'matched_name, company_size, items')
    const eightKCount = eightK.filter(f => {
      const hasItem101 = Array.isArray(f.items) && f.items.includes('1.01')
      if (!hasItem101) return false
      if (isBigCo(f.company_size)) return keepBigCo(f.matched_name)
      return true
    }).length

    const s1 = await fetchAll('s1_filings', 'matched_name, company_size')
    const s1Count = s1.filter(f => {
      if (isBigCo(f.company_size)) return keepBigCo(f.matched_name)
      return true
    }).length

    // Funding - NEW: matched_name required, size filter (matches /api/funding-new)
    const funding = await fetchAll('funding_projects', 'matched_name, company_size')
    const fundingNewCount = funding.filter(p => {
      if (!p.matched_name) return false
      if (isBigCo(p.company_size)) return keepBigCo(p.matched_name)
      return true
    }).length

    // Jobs - NEW: size filter only (matches /api/jobs-new)
    const jobs = await fetchAll('clay_jobs', 'matched_name, company_size')
    const jobsNewCount = jobs.filter(j => {
      if (isBigCo(j.company_size)) return keepBigCo(j.matched_name)
      return true
    }).length

    // Competitor Jobs - NEW: total row count (matches /api/competitor-jobs-new)
    const { count: competitorJobsCount, error: competitorJobsErr } = await supabase
      .from('clay_jobs_competitors')
      .select('*', { count: 'exact', head: true })
    if (competitorJobsErr) throw new Error(`clay_jobs_competitors: ${competitorJobsErr.message}`)
    const competitorJobsNewCount = competitorJobsCount || 0

    // News: sum of all three news tables
    const [{ count: fierceCount }, { count: biospaceCount }, { count: endpointsCount }] = await Promise.all([
      supabase.from('fiercebio_news').select('*', { count: 'exact', head: true }),
      supabase.from('biospace_news').select('*', { count: 'exact', head: true }),
      supabase.from('endpoint_news').select('*', { count: 'exact', head: true }),
    ])
    const newsCount = (fierceCount || 0) + (biospaceCount || 0) + (endpointsCount || 0)

    // Past Buyers / Past Candidates: count of contacts with any change (company OR role)
    const normalize = (s) => (s || '').trim().toLowerCase()
    const countChanged = (rows) => {
      let n = 0
      for (const r of rows) {
        const companyChanged = normalize(r.original_company) !== normalize(r.current_company)
        const roleChanged = normalize(r.original_title) !== normalize(r.current_title)
        if (companyChanged || roleChanged) n++
      }
      return n
    }
    const pastBuyersRows = await fetchAll('past_buyers', 'original_company, current_company, original_title, current_title')
    const pastCandidatesRows = await fetchAll('past_candidates', 'original_company, current_company, original_title, current_title')
    const pastBuyersChanges = countChanged(pastBuyersRows)
    const pastCandidatesChanges = countChanged(pastCandidatesRows)

    const responseData = {
      madison_leads: madisonCount || 0,
      jim_leads: jimCount || 0,
      tim_leads: timCount || 0,
      clinical_new: clinicalNewCount,
      ma_funding_new: eightKCount + s1Count,
      funding_new: fundingNewCount,
      jobs_new: jobsNewCount,
      competitor_jobs_new: competitorJobsNewCount,
      news: newsCount,
      past_buyers_changes: pastBuyersChanges,
      past_candidates_changes: pastCandidatesChanges,
    }
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (counts: ${JSON.stringify(responseData)})`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
