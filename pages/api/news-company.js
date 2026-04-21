import { supabase } from '../../lib/supabase.js'

const ALLOWED_SOURCE_TABLES = ['fiercebio_news', 'biospace_news', 'endpoint_news']

function isValidSourceTable(table) {
  return ALLOWED_SOURCE_TABLES.includes(table)
}

async function applyAssignment(req, res) {
  const { article_url, source_table, company_names, alternate_entries } = req.body || {}

  if (!article_url || !source_table) {
    return res.status(400).json({ error: 'Missing required fields: article_url, source_table' })
  }
  if (!isValidSourceTable(source_table)) {
    return res.status(400).json({ error: `Invalid source_table. Must be one of: ${ALLOWED_SOURCE_TABLES.join(', ')}` })
  }

  const matchedNames = Array.isArray(company_names)
    ? company_names.map((n) => String(n || '').trim()).filter(Boolean)
    : []

  const { error: updateErr } = await supabase
    .from(source_table)
    .update({ matched_names: matchedNames.length > 0 ? matchedNames : null })
    .eq('article_url', article_url)

  if (updateErr) {
    return res.status(500).json({ error: `Update failed: ${updateErr.message}` })
  }

  const altRows = Array.isArray(alternate_entries)
    ? alternate_entries
        .map((e) => ({
          directory_name: e && e.directory_name ? String(e.directory_name).trim() : '',
          alternate_name: e && e.alternate_name ? String(e.alternate_name).trim() : '',
        }))
        .filter((e) => e.directory_name && e.alternate_name)
        .map((e) => ({
          directory_name: e.directory_name,
          alternate_name: e.alternate_name,
          matched_via: 'news_page_entry',
          domain: null,
        }))
    : []

  let upsertedCount = 0
  if (altRows.length > 0) {
    const { data, error: upsertErr } = await supabase
      .from('companies_alternate_names')
      .upsert(altRows, { onConflict: 'alternate_name' })
      .select('alternate_name')

    if (upsertErr) {
      return res.status(500).json({ error: `Alternate name upsert failed: ${upsertErr.message}` })
    }
    upsertedCount = data ? data.length : altRows.length
  }

  return res.status(200).json({
    success: true,
    matched_names: matchedNames,
    alternate_names_upserted: upsertedCount,
  })
}

export default async function handler(req, res) {
  if (req.method === 'POST' || req.method === 'PUT') {
    return applyAssignment(req, res)
  }
  return res.status(405).json({ error: 'Method not allowed' })
}
