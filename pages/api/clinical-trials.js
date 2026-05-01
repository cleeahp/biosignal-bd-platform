import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fetch all clinical trials
  const trials = []
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('clinical_trials')
      .select('*')
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    trials.push(...data)
    offset += PAGE
  }

  // Fetch past_clients names
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

  // Filter: exclude 10,001+ employees unless matched_name is a past client
  const filtered = trials.filter(t => {
    if (t.company_size === '10,001+ employees') {
      const name = (t.matched_name || '').toLowerCase()
      return name && pastClientsLower.has(name)
    }
    return true
  })

  return res.status(200).json({ trials: filtered, pastClients })
}
