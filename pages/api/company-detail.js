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
      fetchAll(supabase.from('clinical_trials').select('id, nct_id, brief_title, phase, matched_name, company_size, lead_sponsor_name, is_fda_regulated_drug, is_fda_regulated_device, study_start_date, source_url, central_contacts, created_at').eq('matched_name', company)),
      fetchAll(supabase.from('eight_k_filings').select('id, company_name, matched_name, company_size, filing_date, filing_url, items, accession_number, agreement_type, agreement_summary, created_at').eq('matched_name', company)),
      fetchAll(supabase.from('s1_filings').select('id, company_name, matched_name, company_size, filing_date, filing_url, accession_number, created_at').eq('matched_name', company)),
      fetchAll(supabase.from('funding_projects').select('id, appl_id, org_name, matched_name, company_size, project_title, award_amount, award_notice_date, project_url, public_health_relevance, created_at').eq('matched_name', company)),
      fetchAll(supabase.from('clay_jobs').select('id, job_title, company_name, location, company_domain, job_url, date_posted, matched_name, company_size, specialty, created_at').eq('matched_name', company)),
      fetchAll(supabase.from(NEWS_SOURCES[0].table).select(NEWS_SOURCES[0].select).contains('matched_names', [company])),
      fetchAll(supabase.from(NEWS_SOURCES[1].table).select(NEWS_SOURCES[1].select).contains('matched_names', [company])),
      fetchAll(supabase.from(NEWS_SOURCES[2].table).select(NEWS_SOURCES[2].select).contains('matched_names', [company])),
      fetchAll(supabase.from('past_buyers').select('id, person_name, current_title, current_company, original_title, original_company, current_location, original_email, phone, linkedin_url').ilike('current_company', company)),
      fetchAll(supabase.from('past_candidates').select('id, person_name, current_title, current_company, original_title, original_company, current_location, email, phone, linkedin_url').ilike('current_company', company)),
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

    const responseData = {
      company,
      clinicalTrials: trials,
      filings,
      fundingProjects: funding,
      newsArticles,
      jobs,
      pastBuyers,
      pastCandidates,
      pastClients,
    }
    const totalRows = trials.length + filings.length + funding.length + newsArticles.length + jobs.length + pastBuyers.length + pastCandidates.length
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (${company}, ${totalRows} rows)`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
