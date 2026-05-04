import { supabase } from '../../lib/supabase.js'

const PAGE = 1000
const LARGE_COMPANY_SIZES = new Set(['10,001+', '10,001+ employees'])
const CACHE_TTL_MS = 300_000 // 5 minutes

let cache = { data: null, timestamp: 0 }

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

function bump(map, name, isNew) {
  if (!name) return
  const cur = map.get(name) || { count: 0, new: 0 }
  cur.count += 1
  if (isNew) cur.new += 1
  map.set(name, cur)
}

async function buildDashboard() {
  const now = new Date()
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const startOfYesterdayUtc = startOfTodayUtc - 86_400_000
  const isYesterdayUtc = createdAt => {
    if (!createdAt) return false
    const t = new Date(createdAt).getTime()
    if (Number.isNaN(t)) return false
    return t >= startOfYesterdayUtc && t < startOfTodayUtc
  }

  const [
    trials,
    eightK,
    s1,
    funding,
    fierce,
    biospace,
    endpoints,
    directory,
    clientRows,
  ] = await Promise.all([
    fetchAll('clinical_trials', 'matched_name, created_at', q => q.not('matched_name', 'is', null)),
    fetchAll('eight_k_filings', 'matched_name, items, created_at', q => q.not('matched_name', 'is', null)),
    fetchAll('s1_filings', 'matched_name, created_at', q => q.not('matched_name', 'is', null)),
    fetchAll('funding_projects', 'matched_name, created_at', q => q.not('matched_name', 'is', null)),
    fetchAll('fiercebio_news', 'matched_names, created_at', q => q.not('matched_names', 'is', null)),
    fetchAll('biospace_news', 'matched_names, created_at', q => q.not('matched_names', 'is', null)),
    fetchAll('endpoint_news', 'matched_names, created_at', q => q.not('matched_names', 'is', null)),
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

  const trialCounts = new Map()
  for (const r of trials) bump(trialCounts, r.matched_name, isYesterdayUtc(r.created_at))

  const maCounts = new Map()
  for (const r of eightK) {
    if (!Array.isArray(r.items) || !r.items.includes('1.01')) continue
    bump(maCounts, r.matched_name, isYesterdayUtc(r.created_at))
  }
  for (const r of s1) bump(maCounts, r.matched_name, isYesterdayUtc(r.created_at))

  const fundingCounts = new Map()
  for (const r of funding) bump(fundingCounts, r.matched_name, isYesterdayUtc(r.created_at))

  const newsCounts = new Map()
  for (const list of [fierce, biospace, endpoints]) {
    for (const r of list) {
      if (!Array.isArray(r.matched_names)) continue
      const isNew = isYesterdayUtc(r.created_at)
      for (const name of r.matched_names) bump(newsCounts, name, isNew)
    }
  }

  const allCompanies = new Set([
    ...trialCounts.keys(),
    ...maCounts.keys(),
    ...fundingCounts.keys(),
    ...newsCounts.keys(),
  ])

  const empty = { count: 0, new: 0 }

  const companies = [...allCompanies]
    .filter(name => {
      if (isPastClientName(name)) return true
      const size = directorySize.get(name.toLowerCase())
      return !LARGE_COMPANY_SIZES.has(size)
    })
    .map(name => {
      const clinical = trialCounts.get(name) || empty
      const ma = maCounts.get(name) || empty
      const fundingEntry = fundingCounts.get(name) || empty
      const news = newsCounts.get(name) || empty
      const total = clinical.count + ma.count + fundingEntry.count + news.count
      const totalNew = clinical.new + ma.new + fundingEntry.new + news.new
      return {
        company_name: name,
        clinical_trials_count: clinical.count,
        clinical_trials_new: clinical.new,
        ma_count: ma.count,
        ma_new: ma.new,
        funding_count: fundingEntry.count,
        funding_new: fundingEntry.new,
        news_count: news.count,
        news_new: news.new,
        total_count: total,
        total_new: totalNew,
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

  if (!refresh && cache.data && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return res.status(200).json({ ...cache.data, cached: true, cached_at: cache.timestamp })
  }

  try {
    const result = await buildDashboard()
    cache = { data: result, timestamp: Date.now() }
    return res.status(200).json({ ...result, cached: false, cached_at: cache.timestamp })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
