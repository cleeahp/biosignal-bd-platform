import { supabase } from '../../lib/supabase.js'
import { matchSpecialties, cleanJobTitle } from '../../lib/specialtyMatcher.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'clay_jobs_competitors'

let titleCache = null
const TITLE_CACHE_TTL_MS = 5 * 60 * 1000

async function loadTitleCache() {
  if (titleCache && Date.now() - titleCache.loadedAt < TITLE_CACHE_TTL_MS) return titleCache

  const blocked = new Set()
  const overrides = new Map()
  const PAGE = 1000

  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('blocked_job_titles')
      .select('job_title_lower')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`blocked_job_titles: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.job_title_lower) blocked.add(row.job_title_lower.trim())
    }
    offset += PAGE
  }

  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('job_title_overrides')
      .select('job_title_lower, specialty')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`job_title_overrides: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.job_title_lower) overrides.set(row.job_title_lower.trim(), row.specialty || [])
    }
    offset += PAGE
  }

  titleCache = { blocked, overrides, loadedAt: Date.now() }
  return titleCache
}

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

  let specialty = null
  try {
    const titles = await loadTitleCache()
    const cleanedTitle = cleanJobTitle(job_title).trim()
    if (cleanedTitle && titles.blocked.has(cleanedTitle)) {
      return res.status(200).json({ success: true, skipped: 'blocked_title' })
    }
    specialty = matchSpecialties(job_title, titles.overrides)
  } catch (err) {
    console.error(`[ClayCompetitorWebhook] Title cache load error: ${err.message}`)
    specialty = matchSpecialties(job_title)
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
    specialty,
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
