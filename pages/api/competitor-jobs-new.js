import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const jobs = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('clay_jobs_competitors')
      .select('*')
      .range(offset, offset + PAGE - 1)
    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    jobs.push(...data)
    offset += PAGE
  }

  return res.status(200).json({ jobs })
}
