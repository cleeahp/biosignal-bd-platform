import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fetch past_clients names
  const { data: clientRows, error: clientErr } = await supabase
    .from('past_clients')
    .select('name, matched_name')
    .eq('is_active', true)

  if (clientErr) return res.status(500).json({ error: clientErr.message })

  const pastClients = (clientRows || []).map(r => ({ name: r.name, matched_name: r.matched_name }))
  const pastClientsLower = new Set(pastClients.map(c => c.name.toLowerCase()))

  // Fetch eight_k_filings
  const eightK = []
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('eight_k_filings')
      .select('*')
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    eightK.push(...data)
    offset += PAGE
  }

  // Filter 8-K: must have item 1.01, exclude 10,001+ unless past client
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

  // Fetch s1_filings
  const s1 = []
  offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('s1_filings')
      .select('*')
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    s1.push(...data)
    offset += PAGE
  }

  // Filter S-1: exclude 10,001+ unless past client
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

  return res.status(200).json({ filings, pastClients })
}
