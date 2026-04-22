import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'clay_jobs_competitors'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay competitor jobs webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}

  const job_title = body.job_title || null
  const company_name = body.company_name || null
  const location = body.location || null
  const company_domain = body.company_domain || null
  const job_url = body.job_url ? String(body.job_url).trim() : ''
  const date_posted = body.date_posted || null

  if (!job_url) {
    return res.status(200).json({ success: true, skipped: 'no_url' })
  }

  const { data: existing, error: existingErr } = await supabase
    .from(TABLE)
    .select('id')
    .eq('job_url', job_url)
    .maybeSingle()

  if (existingErr) {
    console.error(`[ClayCompetitorWebhook] Duplicate lookup error: ${existingErr.message}`)
    return res.status(500).json({ error: existingErr.message })
  }

  if (existing) {
    return res.status(200).json({ success: true, skipped: 'duplicate' })
  }

  const row = {
    job_title,
    company_name,
    location,
    company_domain,
    job_url,
    date_posted,
    raw_payload: body,
  }

  const { error: insertErr } = await supabase.from(TABLE).insert(row)
  if (insertErr) {
    console.error(`[ClayCompetitorWebhook] Insert error: ${insertErr.message}`)
    return res.status(500).json({ error: insertErr.message })
  }

  console.log(`[ClayCompetitorWebhook] Inserted: ${company_name} — ${job_title}`)
  return res.status(200).json({ success: true, inserted: true })
}
