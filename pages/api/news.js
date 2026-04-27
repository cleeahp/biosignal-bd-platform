import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

async function fetchAll(table, select) {
  const rows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
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

  try {
    const [fierce, biospace, endpoints, clientRows] = await Promise.all([
      fetchAll('fiercebio_news', 'title, article_url, article_date, matched_names, created_at'),
      fetchAll('biospace_news', 'title, article_url, article_date, matched_names, created_at'),
      fetchAll('endpoint_news', 'title, article_url, matched_names, created_at'),
      (async () => {
        const { data, error } = await supabase.from('past_clients').select('name, matched_name').eq('is_active', true)
        if (error) throw new Error(`past_clients: ${error.message}`)
        return data || []
      })(),
    ])
    const pastClients = clientRows
      .filter(r => r.name)
      .map(r => ({ name: r.name, matched_name: r.matched_name }))

    const articles = [
      ...fierce.map(r => ({
        title: r.title,
        url: r.article_url,
        date: r.article_date || null,
        created_at: r.created_at,
        matched_names: r.matched_names || null,
        source_table: 'fiercebio_news',
        _source: 'Fierce Bio',
      })),
      ...biospace.map(r => ({
        title: r.title,
        url: r.article_url,
        date: r.article_date || null,
        created_at: r.created_at,
        matched_names: r.matched_names || null,
        source_table: 'biospace_news',
        _source: 'BioSpace',
      })),
      ...endpoints.map(r => ({
        title: r.title,
        url: r.article_url,
        date: null,
        created_at: r.created_at,
        matched_names: r.matched_names || null,
        source_table: 'endpoint_news',
        _source: 'Endpoints News',
      })),
    ]

    articles.sort((a, b) => {
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        return new Date(b.date) - new Date(a.date)
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })

    return res.status(200).json({ articles, pastClients })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
