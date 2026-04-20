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
    const [fierce, biospace, endpoints] = await Promise.all([
      fetchAll('fiercebio_news', 'title, article_url, article_date, created_at'),
      fetchAll('biospace_news', 'title, article_url, article_date, created_at'),
      fetchAll('endpoint_news', 'title, article_url, created_at'),
    ])

    const articles = [
      ...fierce.map(r => ({
        title: r.title,
        url: r.article_url,
        date: r.article_date || null,
        created_at: r.created_at,
        _source: 'Fierce Bio',
      })),
      ...biospace.map(r => ({
        title: r.title,
        url: r.article_url,
        date: r.article_date || null,
        created_at: r.created_at,
        _source: 'BioSpace',
      })),
      ...endpoints.map(r => ({
        title: r.title,
        url: r.article_url,
        date: null,
        created_at: r.created_at,
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

    return res.status(200).json({ articles })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
