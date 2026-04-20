import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fetch past_clients names
  const { data: clientRows, error: clientErr } = await supabase
    .from('past_clients')
    .select('name')
    .eq('is_active', true)

  if (clientErr) return res.status(500).json({ error: clientErr.message })

  const pastClients = (clientRows || []).map(r => r.name)
  const pastClientsLower = new Set(pastClients.map(n => n.toLowerCase()))

  // Fetch funding_projects
  const all = []
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('funding_projects')
      .select('*')
      .range(offset, offset + PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    all.push(...data)
    offset += PAGE
  }

  // Filter: must have matched_name; exclude 10,001+ unless past client
  const projects = all.filter(p => {
    if (!p.matched_name) return false

    if (p.company_size === '10,001+ employees' || p.company_size === '10,001+') {
      const name = p.matched_name.toLowerCase()
      return pastClientsLower.has(name)
    }
    return true
  })

  return res.status(200).json({ projects, pastClients })
}
