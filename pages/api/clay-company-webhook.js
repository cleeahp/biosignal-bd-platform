import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'companies_directory'

function normKey(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : ''
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay company enrichment webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const name = body.name ? String(body.name).trim() : ''
  if (!name) {
    return res.status(200).json({ success: true, skipped: 'no_name' })
  }

  const domain = body.domain || null
  const company_size = body.company_size || null
  const primary_industry = body.primary_industry || null
  const company_type = body.company_type || null
  const location = body.location || null
  const linkedin_url = body.linkedin_url ? String(body.linkedin_url).trim() : null

  const nameKey = normKey(name)
  const linkedinKey = normKey(linkedin_url)

  // Find existing row matching (lower(trim(name)), lower(trim(linkedin_url)))
  let existing = null
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, name, linkedin_url')
      .ilike('name', name)
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error(`[ClayCompanyWebhook] Lookup error: ${error.message}`)
      return res.status(500).json({ error: error.message })
    }
    if (!data || data.length === 0) break
    for (const row of data) {
      if (normKey(row.name) === nameKey && normKey(row.linkedin_url) === linkedinKey) {
        existing = row
        break
      }
    }
    if (existing) break
    if (data.length < PAGE) break
    offset += PAGE
  }

  const updateFields = { domain, company_size, primary_industry, company_type, location }

  if (existing) {
    const { error: updateErr } = await supabase
      .from(TABLE)
      .update(updateFields)
      .eq('id', existing.id)
    if (updateErr) {
      console.error(`[ClayCompanyWebhook] Update error: ${updateErr.message}`)
      return res.status(500).json({ error: updateErr.message })
    }
    console.log(`[ClayCompanyWebhook] updated: ${name} (${linkedin_url || 'no linkedin'})`)
    return res.status(200).json({ success: true, action: 'updated' })
  }

  const { error: insertErr } = await supabase
    .from(TABLE)
    .insert({ name, linkedin_url, ...updateFields })
  if (insertErr) {
    console.error(`[ClayCompanyWebhook] Insert error: ${insertErr.message}`)
    return res.status(500).json({ error: insertErr.message })
  }

  console.log(`[ClayCompanyWebhook] inserted: ${name} (${linkedin_url || 'no linkedin'})`)
  return res.status(200).json({ success: true, action: 'inserted' })
}
