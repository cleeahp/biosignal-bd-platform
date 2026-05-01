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

function bumpCount(map, name) {
  if (!name) return
  map.set(name, (map.get(name) || 0) + 1)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
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
      fetchAll('clinical_trials', 'matched_name', q => q.not('matched_name', 'is', null)),
      fetchAll('eight_k_filings', 'matched_name, items', q => q.not('matched_name', 'is', null)),
      fetchAll('s1_filings', 'matched_name', q => q.not('matched_name', 'is', null)),
      fetchAll('funding_projects', 'matched_name', q => q.not('matched_name', 'is', null)),
      fetchAll('fiercebio_news', 'matched_names', q => q.not('matched_names', 'is', null)),
      fetchAll('biospace_news', 'matched_names', q => q.not('matched_names', 'is', null)),
      fetchAll('endpoint_news', 'matched_names', q => q.not('matched_names', 'is', null)),
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
    for (const r of trials) bumpCount(trialCounts, r.matched_name)

    const maCounts = new Map()
    for (const r of eightK) {
      if (!Array.isArray(r.items) || !r.items.includes('1.01')) continue
      bumpCount(maCounts, r.matched_name)
    }
    for (const r of s1) bumpCount(maCounts, r.matched_name)

    const fundingCounts = new Map()
    for (const r of funding) bumpCount(fundingCounts, r.matched_name)

    const newsCounts = new Map()
    for (const list of [fierce, biospace, endpoints]) {
      for (const r of list) {
        if (!Array.isArray(r.matched_names)) continue
        for (const name of r.matched_names) bumpCount(newsCounts, name)
      }
    }

    const allCompanies = new Set([
      ...trialCounts.keys(),
      ...maCounts.keys(),
      ...fundingCounts.keys(),
      ...newsCounts.keys(),
    ])

    const companies = [...allCompanies]
      .filter(name => {
        if (isPastClientName(name)) return true
        const size = directorySize.get(name.toLowerCase())
        return !LARGE_COMPANY_SIZES.has(size)
      })
      .map(name => {
        const clinical = trialCounts.get(name) || 0
        const ma = maCounts.get(name) || 0
        const fundingCount = fundingCounts.get(name) || 0
        const news = newsCounts.get(name) || 0
        return {
          company_name: name,
          clinical_trials_count: clinical,
          ma_count: ma,
          funding_count: fundingCount,
          news_count: news,
          total_count: clinical + ma + fundingCount + news,
        }
      })

    companies.sort((a, b) => b.total_count - a.total_count)

    return res.status(200).json({ companies, pastClients })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
