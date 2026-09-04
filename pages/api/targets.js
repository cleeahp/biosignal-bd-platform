import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const rows = []
    let offset = 0
    while (true) {
      const { data, error } = await supabase
        .from('targets_companies')
        .select('id, name, city, state_province, company_size, domain, linkedin_url, description')
        .order('name', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(`targets_companies: ${error.message}`)
      if (!data || data.length === 0) break
      rows.push(...data)
      if (data.length < PAGE) break
      offset += PAGE
    }

    const responseData = { rows }
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (${rows.length} rows)`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
