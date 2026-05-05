import { supabase } from '../../lib/supabase.js'

const PAGE = 1000
const LARGE_COMPANY_SIZES = new Set(['10,001+', '10,001+ employees'])

async function fetchAll(table, select, queryFn) {
  const rows = []
  let offset = 0
  while (true) {
    let q = supabase.from(table).select(select)
    if (queryFn) q = queryFn(q)
    q = q.range(offset, offset + PAGE - 1)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

function bumpScalar(map, name) {
  if (!name) return
  map.set(name, (map.get(name) || 0) + 1)
}

async function fetchSummaryView() {
  const rows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('company_signal_summary')
      .select('*')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`company_signal_summary: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

async function buildDashboard() {
  const startOfTodayUtc = new Date()
  startOfTodayUtc.setUTCHours(0, 0, 0, 0)
  const todayIso = startOfTodayUtc.toISOString()

  const [
    aggRows,
    trialsToday,
    eightKToday,
    s1Today,
    fundingToday,
    fierceToday,
    biospaceToday,
    endpointsToday,
    directory,
    clientRows,
  ] = await Promise.all([
    fetchSummaryView(),
    fetchAll('clinical_trials', 'matched_name', q => q.not('matched_name', 'is', null).gte('created_at', todayIso)),
    fetchAll('eight_k_filings', 'matched_name, items', q => q.not('matched_name', 'is', null).gte('created_at', todayIso)),
    fetchAll('s1_filings', 'matched_name', q => q.not('matched_name', 'is', null).gte('created_at', todayIso)),
    fetchAll('funding_projects', 'matched_name', q => q.not('matched_name', 'is', null).gte('created_at', todayIso)),
    fetchAll('fiercebio_news', 'matched_names', q => q.not('matched_names', 'is', null).gte('created_at', todayIso)),
    fetchAll('biospace_news', 'matched_names', q => q.not('matched_names', 'is', null).gte('created_at', todayIso)),
    fetchAll('endpoint_news', 'matched_names', q => q.not('matched_names', 'is', null).gte('created_at', todayIso)),
    fetchAll('companies_directory', 'name, company_size'),
    (async () => {
      const { data, error } = await supabase
        .from('past_clients')
        .select('name, matched_name')
        .eq('is_active', true)
      if (error) throw new Error(`past_clients: ${error.message}`)
      return data || []
    })(),
  ])

  const pastClients = clientRows
    .filter(r => r.name)
    .map(r => ({ name: r.name, matched_name: r.matched_name }))

  const pastClientLowerSet = new Set()
  for (const c of pastClients) {
    if (c.name) pastClientLowerSet.add(c.name.toLowerCase())
    if (c.matched_name) pastClientLowerSet.add(c.matched_name.toLowerCase())
  }
  const isPastClientName = name => {
    if (!name) return false
    return pastClientLowerSet.has(String(name).toLowerCase())
  }

  const directorySize = new Map()
  for (const row of directory) {
    if (!row.name) continue
    directorySize.set(row.name.toLowerCase(), row.company_size || null)
  }

  const trialNew = new Map()
  for (const r of trialsToday) bumpScalar(trialNew, r.matched_name)

  const maNew = new Map()
  for (const r of eightKToday) {
    if (!Array.isArray(r.items) || !r.items.includes('1.01')) continue
    bumpScalar(maNew, r.matched_name)
  }
  for (const r of s1Today) bumpScalar(maNew, r.matched_name)

  const fundingNew = new Map()
  for (const r of fundingToday) bumpScalar(fundingNew, r.matched_name)

  const newsNew = new Map()
  for (const list of [fierceToday, biospaceToday, endpointsToday]) {
    for (const r of list) {
      if (!Array.isArray(r.matched_names)) continue
      for (const name of r.matched_names) bumpScalar(newsNew, name)
    }
  }

  const companies = aggRows
    .filter(row => {
      const name = row.company_name
      if (!name) return false
      if (isPastClientName(name)) return true
      const size = directorySize.get(name.toLowerCase())
      return !LARGE_COMPANY_SIZES.has(size)
    })
    .map(row => {
      const name = row.company_name
      const clinicalNew = trialNew.get(name) || 0
      const ma_new = maNew.get(name) || 0
      const funding_new = fundingNew.get(name) || 0
      const news_new = newsNew.get(name) || 0
      const total_new = clinicalNew + ma_new + funding_new + news_new
      return {
        company_name: name,
        clinical_trials_count: Number(row.clinical_trials_count) || 0,
        clinical_trials_new: clinicalNew,
        ma_count: Number(row.ma_count) || 0,
        ma_new,
        funding_count: Number(row.funding_count) || 0,
        funding_new,
        news_count: Number(row.news_count) || 0,
        news_new,
        total_count: Number(row.total_count) || 0,
        total_new,
      }
    })

  companies.sort((a, b) => b.total_count - a.total_count)

  const summary = {
    total_companies: companies.length,
    total_signals: companies.reduce((s, c) => s + c.total_count, 0),
    total_new_signals: companies.reduce((s, c) => s + c.total_new, 0),
  }

  return { companies, pastClients, summary }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const refresh = req.query.refresh === 'true' || req.query.refresh === '1'

  try {
    if (refresh) {
      const { error: refreshError } = await supabase.rpc('refresh_company_signal_summary')
      if (refreshError) throw new Error(`refresh_company_signal_summary: ${refreshError.message}`)
    }
    const result = await buildDashboard()
    return res.status(200).json(result)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
