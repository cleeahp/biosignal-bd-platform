import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

async function fetchAll(query) {
  const rows = []
  let offset = 0
  while (true) {
    const { data, error } = await query.range(offset, offset + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const company = (req.query.company || '').trim()
  if (!company) {
    return res.status(400).json({ error: 'company query parameter required' })
  }

  try {
    const NEWS_SOURCES = [
      { table: 'fiercebio_news', source: 'Fierce Bio', select: 'title, article_url, article_date, matched_names, created_at' },
      { table: 'biospace_news', source: 'BioSpace', select: 'title, article_url, article_date, matched_names, created_at' },
      { table: 'endpoint_news', source: 'Endpoints News', select: 'title, article_url, article_date, matched_names, created_at' },
    ]

    const [trials, eightKRaw, s1Raw, funding, jobs, fierce, biospace, endpoints, pastBuyers, pastCandidates, clientRows] = await Promise.all([
      fetchAll(supabase.from('clinical_trials').select('*').eq('matched_name', company)),
      fetchAll(supabase.from('eight_k_filings').select('*').eq('matched_name', company)),
      fetchAll(supabase.from('s1_filings').select('*').eq('matched_name', company)),
      fetchAll(supabase.from('funding_projects').select('*').eq('matched_name', company)),
      fetchAll(supabase.from('clay_jobs').select('*').eq('matched_name', company)),
      fetchAll(supabase.from(NEWS_SOURCES[0].table).select(NEWS_SOURCES[0].select).contains('matched_names', [company])),
      fetchAll(supabase.from(NEWS_SOURCES[1].table).select(NEWS_SOURCES[1].select).contains('matched_names', [company])),
      fetchAll(supabase.from(NEWS_SOURCES[2].table).select(NEWS_SOURCES[2].select).contains('matched_names', [company])),
      fetchAll(supabase.from('past_buyers').select('*').ilike('original_company', company)),
      fetchAll(supabase.from('past_candidates').select('*').ilike('original_company', company)),
      (async () => {
        const { data, error } = await supabase
          .from('past_clients')
          .select('name, matched_name')
          .eq('is_active', true)
        if (error) throw new Error(`past_clients: ${error.message}`)
        return data || []
      })(),
    ])

    const eightKFiltered = eightKRaw
      .filter(f => Array.isArray(f.items) && f.items.includes('1.01'))
      .map(f => ({ ...f, _source: '8-K', _transaction: f.agreement_type || 'Other' }))

    const s1Mapped = s1Raw.map(f => ({ ...f, _source: 'S-1', _transaction: 'IPO' }))

    const filings = [...eightKFiltered, ...s1Mapped]

    const newsArticles = []
    const newsBuckets = [
      { rows: fierce, cfg: NEWS_SOURCES[0] },
      { rows: biospace, cfg: NEWS_SOURCES[1] },
      { rows: endpoints, cfg: NEWS_SOURCES[2] },
    ]
    for (const { rows, cfg } of newsBuckets) {
      for (const r of rows) {
        newsArticles.push({
          title: r.title,
          url: r.article_url,
          date: r.article_date || null,
          created_at: r.created_at,
          matched_names: r.matched_names || null,
          source_table: cfg.table,
          _source: cfg.source,
        })
      }
    }

    const pastClients = clientRows
      .filter(r => r.name)
      .map(r => ({ name: r.name, matched_name: r.matched_name }))

    return res.status(200).json({
      company,
      clinicalTrials: trials,
      filings,
      fundingProjects: funding,
      newsArticles,
      jobs,
      pastBuyers,
      pastCandidates,
      pastClients,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
