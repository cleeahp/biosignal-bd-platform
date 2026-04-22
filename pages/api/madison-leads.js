import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  // ── POST: add a tracked company ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { company_name } = req.body
    if (!company_name) return res.status(400).json({ error: 'company_name required' })

    const { error } = await supabase.from('madison_leads').insert({ company_name })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── DELETE: remove a tracked company ──────────────────────────────────────
  if (req.method === 'DELETE') {
    const { company_name } = req.body
    if (!company_name) return res.status(400).json({ error: 'company_name required' })

    const { error } = await supabase.from('madison_leads').delete().eq('company_name', company_name)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  // ── GET: fetch all data for tracked companies ─────────────────────────────
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fetch tracked companies
  const { data: tracked, error: trackedErr } = await supabase
    .from('madison_leads')
    .select('company_name')
    .order('added_at', { ascending: false })

  if (trackedErr) return res.status(500).json({ error: trackedErr.message })

  const trackedCompanies = (tracked || []).map(r => r.company_name)

  if (trackedCompanies.length === 0) {
    // Fetch past_clients even with no tracked companies (for star display)
    const { data: clientRows } = await supabase.from('past_clients').select('name').eq('is_active', true)
    return res.status(200).json({
      trackedCompanies: [],
      clinicalTrials: [],
      filings: [],
      fundingProjects: [],
      newsArticles: [],
      clayJobs: [],
      pastClients: (clientRows || []).map(r => r.name),
    })
  }

  // Fetch past_clients
  const { data: clientRows, error: clientErr } = await supabase
    .from('past_clients')
    .select('name')
    .eq('is_active', true)

  if (clientErr) return res.status(500).json({ error: clientErr.message })

  const pastClients = (clientRows || []).map(r => r.name)
  const pastClientsLower = new Set(pastClients.map(n => n.toLowerCase()))

  const PAGE = 1000

  // ── Clinical trials for tracked companies ─────────────────────────────────
  const trials = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('clinical_trials')
      .select('*')
      .in('matched_name', trackedCompanies)
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
      .select('*')
      .in('matched_name', trackedCompanies)
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
      .select('*')
      .in('matched_name', trackedCompanies)
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
      .select('*')
      .in('matched_name', trackedCompanies)
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
        .overlaps('matched_names', trackedCompanies)
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
      .select('*')
      .in('matched_name', trackedCompanies)
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

  return res.status(200).json({
    trackedCompanies,
    clinicalTrials: filteredTrials,
    filings,
    fundingProjects: filteredFunding,
    newsArticles,
    clayJobs,
    pastClients,
  })
}
