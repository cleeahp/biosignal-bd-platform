import { supabase } from '../../lib/supabase.js'

// Returns ISO timestamp for midnight EST seven days ago — matches the dashboard.
function sevenDaysAgoMidnightEstIso() {
  const now = new Date()
  const cutoff = new Date(now)
  cutoff.setUTCHours(5, 0, 0, 0)
  if (now.getUTCHours() < 5) {
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
  }
  cutoff.setUTCDate(cutoff.getUTCDate() - 7)
  return cutoff.toISOString()
}

export default async function handler(req, res) {
  // ── POST: add a tracked company (defaults to not a key account) ───────────
  if (req.method === 'POST') {
    const { company_name } = req.body
    if (!company_name) return res.status(400).json({ error: 'company_name required' })

    const { error } = await supabase
      .from('jim_leads')
      .insert({ company_name, is_key_account: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── PATCH: toggle is_key_account ──────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { company_name, is_key_account } = req.body
    if (!company_name) return res.status(400).json({ error: 'company_name required' })
    if (typeof is_key_account !== 'boolean') {
      return res.status(400).json({ error: 'is_key_account boolean required' })
    }

    const { error } = await supabase
      .from('jim_leads')
      .update({ is_key_account })
      .eq('company_name', company_name)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── DELETE: remove a tracked company ──────────────────────────────────────
  if (req.method === 'DELETE') {
    const { company_name } = req.body
    if (!company_name) return res.status(400).json({ error: 'company_name required' })

    const { error } = await supabase.from('jim_leads').delete().eq('company_name', company_name)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── GET: fetch all data for tracked companies ─────────────────────────────
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const cutoffIso = sevenDaysAgoMidnightEstIso()

  // Fetch tracked companies with is_key_account flag
  const { data: tracked, error: trackedErr } = await supabase
    .from('jim_leads')
    .select('company_name, is_key_account')
    .order('added_at', { ascending: false })

  if (trackedErr) return res.status(500).json({ error: trackedErr.message })

  const trackedCompanies = (tracked || []).map(r => ({
    name: r.company_name,
    is_key_account: !!r.is_key_account,
  }))
  const trackedNames = trackedCompanies.map(c => c.name)

  const emptyNewCounts = { clinicalTrials: 0, filings: 0, fundingProjects: 0, jobs: 0, news: 0 }

  if (trackedNames.length === 0) {
    // Fetch past_clients even with no tracked companies (for star display)
    const { data: clientRows } = await supabase.from('past_clients').select('name, matched_name').eq('is_active', true)
    const responseData = {
      trackedCompanies: [],
      clinicalTrials: [],
      filings: [],
      fundingProjects: [],
      newsArticles: [],
      clayJobs: [],
      pastClients: (clientRows || []).map(r => ({ name: r.name, matched_name: r.matched_name })),
      newCounts: emptyNewCounts,
      cutoffIso,
    }
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (0 rows)`)
    return res.status(200).json(responseData)
  }

  // Fetch past_clients
  const { data: clientRows, error: clientErr } = await supabase
    .from('past_clients')
    .select('name, matched_name')
    .eq('is_active', true)

  if (clientErr) return res.status(500).json({ error: clientErr.message })

  const pastClients = (clientRows || []).map(r => ({ name: r.name, matched_name: r.matched_name }))
  const pastClientsLower = new Set([
    ...pastClients.map(c => c.name.toLowerCase()),
    ...pastClients.filter(c => c.matched_name).map(c => c.matched_name.toLowerCase()),
  ])

  const PAGE = 1000
  const cutoffMs = new Date(cutoffIso).getTime()
  const isNew = row => {
    const t = new Date(row.created_at || 0).getTime()
    return !!t && t >= cutoffMs
  }

  // ── Clinical trials for tracked companies ─────────────────────────────────
  const trials = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('clinical_trials')
      .select('id, nct_id, brief_title, phase, matched_name, company_size, lead_sponsor_name, is_fda_regulated_drug, is_fda_regulated_device, study_start_date, source_url, central_contacts, created_at')
      .in('matched_name', trackedNames)
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    trials.push(...data)
    offset += PAGE
  }

  // Filter trials: exclude 10,001+ unless past client
  const filteredTrials = trials.filter(t => {
    if (t.company_size === '10,001+ employees') {
      const name = (t.matched_name || '').toLowerCase()
      return name && pastClientsLower.has(name)
    }
    return true
  })

  // ── 8-K filings for tracked companies ─────────────────────────────────────
  const eightK = []
  offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('eight_k_filings')
      .select('id, company_name, matched_name, company_size, filing_date, filing_url, items, accession_number, agreement_type, agreement_summary, created_at')
      .in('matched_name', trackedNames)
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    eightK.push(...data)
    offset += PAGE
  }

  const filtered8K = eightK.filter(f => {
    const hasItem101 = Array.isArray(f.items) && f.items.includes('1.01')
    if (!hasItem101) return false

    if (f.company_size === '10,001+ employees') {
      const name = (f.matched_name || '').toLowerCase()
      return name && pastClientsLower.has(name)
    }
    return true
  }).map(f => ({
    ...f,
    _source: '8-K',
    _transaction: f.agreement_type || 'Other',
  }))

  // ── S-1 filings for tracked companies ─────────────────────────────────────
  const s1 = []
  offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('s1_filings')
      .select('id, company_name, matched_name, company_size, filing_date, filing_url, accession_number, created_at')
      .in('matched_name', trackedNames)
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    s1.push(...data)
    offset += PAGE
  }

  const filteredS1 = s1.filter(f => {
    if (f.company_size === '10,001+ employees') {
      const name = (f.matched_name || '').toLowerCase()
      return name && pastClientsLower.has(name)
    }
    return true
  }).map(f => ({
    ...f,
    _source: 'S-1',
    _transaction: 'IPO',
  }))

  const filings = [...filtered8K, ...filteredS1]

  // ── Funding projects for tracked companies ────────────────────────────────
  const funding = []
  offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('funding_projects')
      .select('id, appl_id, org_name, matched_name, company_size, project_title, award_amount, award_notice_date, project_url, public_health_relevance, created_at')
      .in('matched_name', trackedNames)
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    funding.push(...data)
    offset += PAGE
  }

  const filteredFunding = funding.filter(p => {
    if (!p.matched_name) return false
    if (p.company_size === '10,001+ employees' || p.company_size === '10,001+') {
      const name = p.matched_name.toLowerCase()
      return pastClientsLower.has(name)
    }
    return true
  })

  // ── News articles for tracked companies ───────────────────────────────────
  const NEWS_SOURCES = [
    { table: 'fiercebio_news', source: 'Fierce Bio',    select: 'title, article_url, article_date, matched_names, created_at', hasDate: true },
    { table: 'biospace_news',  source: 'BioSpace',      select: 'title, article_url, article_date, matched_names, created_at', hasDate: true },
    { table: 'endpoint_news',  source: 'Endpoints News', select: 'title, article_url, matched_names, created_at',              hasDate: false },
  ]

  const newsArticles = []
  for (const cfg of NEWS_SOURCES) {
    offset = 0
    while (true) {
      const { data, error } = await supabase
        .from(cfg.table)
        .select(cfg.select)
        .overlaps('matched_names', trackedNames)
        .range(offset, offset + PAGE - 1)
      if (error) return res.status(500).json({ error: error.message })
      if (!data || data.length === 0) break
      for (const r of data) {
        newsArticles.push({
          title: r.title,
          url: r.article_url,
          date: cfg.hasDate ? (r.article_date || null) : null,
          created_at: r.created_at,
          matched_names: r.matched_names || null,
          source_table: cfg.table,
          _source: cfg.source,
        })
      }
      offset += PAGE
    }
  }

  // ── Clay jobs for tracked companies ───────────────────────────────────────
  const clayJobsRaw = []
  offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('clay_jobs')
      .select('id, job_title, company_name, location, company_domain, job_url, date_posted, matched_name, company_size, created_at')
      .in('matched_name', trackedNames)
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    clayJobsRaw.push(...data)
    offset += PAGE
  }

  const clayJobs = clayJobsRaw.filter(j => {
    if (j.company_size === '10,001+ employees' || j.company_size === '10,001+') {
      const name = (j.matched_name || '').toLowerCase()
      return !!name && pastClientsLower.has(name)
    }
    return true
  })

  const newCounts = {
    clinicalTrials: filteredTrials.filter(isNew).length,
    filings: filings.filter(isNew).length,
    fundingProjects: filteredFunding.filter(isNew).length,
    jobs: clayJobs.filter(isNew).length,
    news: newsArticles.filter(isNew).length,
  }

  const responseData = {
    trackedCompanies,
    clinicalTrials: filteredTrials,
    filings,
    fundingProjects: filteredFunding,
    newsArticles,
    clayJobs,
    pastClients,
    newCounts,
    cutoffIso,
  }
  const totalRows = filteredTrials.length + filings.length + filteredFunding.length + newsArticles.length + clayJobs.length
  const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
  console.log(`[API] ${req.url}: ${sizeMB} MB (${totalRows} rows)`)
  return res.status(200).json(responseData)
}
