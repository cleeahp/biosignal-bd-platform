import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'targets_jobs'

function cleanString(value) {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

function parsePostedOn(value) {
  const cleaned = cleanString(value)
  if (!cleaned) return null
  const normalized = cleaned.replace(' at ', ' ')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay targets jobs webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}

  const company_name = cleanString(body.company_name)
  const job_title = cleanString(body.job_title)
  if (!company_name || !job_title) {
    return res.status(400).json({ error: 'company_name and job_title are required' })
  }

  const record = {
    company_name,
    job_title,
    location: cleanString(body.location),
    company_domain: cleanString(body.company_domain),
    job_linkedin_url: cleanString(body.job_linkedin_url),
    posted_on: parsePostedOn(body.posted_on),
  }

  const { error: writeErr } = record.job_linkedin_url
    ? await supabase.from(TABLE).upsert(record, { onConflict: 'job_linkedin_url' })
    : await supabase.from(TABLE).insert(record)

  if (writeErr) {
    console.error(`[ClayTargetsJobsWebhook] Write error: ${writeErr.message}`)
    return res.status(500).json({ error: writeErr.message })
  }

  console.log(`[ClayTargetsJobsWebhook] upserted: ${job_title} @ ${company_name} (${record.job_linkedin_url || 'no linkedin'})`)

  return res.status(200).json({ success: true, action: 'upserted' })
}
