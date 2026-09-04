import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'targets_companies'

function cleanString(value) {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay targets webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}

  const name = cleanString(body.name)
  if (!name) {
    return res.status(400).json({ error: 'name is required' })
  }

  const record = {
    name,
    domain: cleanString(body.domain),
    description: cleanString(body.description),
    industry: cleanString(body.industry),
    company_size: cleanString(body.company_size),
    company_type: cleanString(body.company_type),
    city: cleanString(body.city),
    state_province: cleanString(body.state_province),
    country: cleanString(body.country),
    linkedin_url: cleanString(body.linkedin_url),
  }

  let deletedQuery = supabase
    .from('targets_companies_deleted')
    .select('id')
    .eq('name', name)
  deletedQuery = record.linkedin_url
    ? deletedQuery.eq('linkedin_url', record.linkedin_url)
    : deletedQuery.is('linkedin_url', null)

  const { data: deletedMatch, error: deletedErr } = await deletedQuery.maybeSingle()
  if (deletedErr) {
    console.error(`[ClayTargetsWebhook] Deleted-check error: ${deletedErr.message}`)
    return res.status(500).json({ error: deletedErr.message })
  }
  if (deletedMatch) {
    console.log(`[ClayTargetsWebhook] skipped (previously deleted): ${name} (${record.linkedin_url || 'no linkedin'})`)
    return res.status(200).json({ skipped: true, reason: 'deleted' })
  }

  const { error: upsertErr } = await supabase
    .from(TABLE)
    .upsert(record, { onConflict: 'name,linkedin_url' })

  if (upsertErr) {
    console.error(`[ClayTargetsWebhook] Upsert error: ${upsertErr.message}`)
    return res.status(500).json({ error: upsertErr.message })
  }

  console.log(`[ClayTargetsWebhook] upserted: ${name} (${record.linkedin_url || 'no linkedin'})`)

  return res.status(200).json({ success: true, action: 'upserted' })
}
