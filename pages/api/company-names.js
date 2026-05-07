import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const names = []
    let offset = 0
    while (true) {
      const { data, error } = await supabase
        .from('companies_directory')
        .select('name')
        .order('name')
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(`companies_directory: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        if (row.name) names.push(row.name)
      }
      if (data.length < PAGE) break
      offset += PAGE
    }

    const responseData = { names }
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (${names.length} names)`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
