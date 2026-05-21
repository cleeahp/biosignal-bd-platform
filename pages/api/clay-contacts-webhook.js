import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const ALLOWED_TABLES = ['past_buyers', 'past_candidates']

const normalize = (s) => (s || '').trim().toLowerCase()

function isBlank(s) {
  return s == null || String(s).trim() === ''
}

function today() {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay contacts webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const table = body.table
  const linkedin_url = body.linkedin_url ? String(body.linkedin_url).trim() : ''
  const incoming_title = body.current_title != null ? String(body.current_title).trim() : ''
  const incoming_company = body.current_company != null ? String(body.current_company).trim() : ''
  const incoming_location = body.current_location != null ? String(body.current_location).trim() : ''

  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Invalid table. Must be past_buyers or past_candidates' })
  }

  if (!linkedin_url) {
    return res.status(200).json({ success: true, skipped: 'no_linkedin_url' })
  }

  const { data: existing, error: lookupErr } = await supabase
    .from(table)
    .select('id, current_title, current_company, current_location, original_title, original_company, job_history')
    .ilike('linkedin_url', linkedin_url)
    .maybeSingle()

  if (lookupErr) {
    console.error(`[ClayContactsWebhook] Lookup error: ${lookupErr.message}`)
    return res.status(500).json({ error: lookupErr.message })
  }

  if (!existing) {
    return res.status(200).json({ success: true, skipped: 'not_found' })
  }

  const existing_title = existing.current_title || ''
  const existing_company = existing.current_company || ''
  const existing_location = existing.current_location || ''

  const role_changed = normalize(incoming_title) !== normalize(existing_title)
  const company_changed = normalize(incoming_company) !== normalize(existing_company)
  const location_changed = normalize(incoming_location) !== normalize(existing_location)

  const update = { last_enrichment_date: today() }

  if (role_changed || company_changed) {
    let job_history = Array.isArray(existing.job_history) ? [...existing.job_history] : []
    const origTitle = existing.original_title
    const origCompany = existing.original_company
    if (!isBlank(origTitle) && !isBlank(origCompany)) {
      const exists = job_history.some(e =>
        normalize(e && e.role) === normalize(origTitle) &&
        normalize(e && e.company) === normalize(origCompany)
      )
      if (!exists) {
        job_history.push({ role: origTitle, company: origCompany })
      }
    }
    update.job_history = job_history
    update.original_title = existing.current_title
    update.original_company = existing.current_company
    update.current_title = incoming_title
    update.current_company = incoming_company

    if (role_changed && company_changed) update.last_change_type = 'both_changed'
    else if (role_changed) update.last_change_type = 'role_changed'
    else update.last_change_type = 'company_changed'
  } else {
    const origTitle = existing.original_title
    const origCompany = existing.original_company
    const originalsDiffer =
      normalize(origTitle) !== normalize(existing_title) ||
      normalize(origCompany) !== normalize(existing_company)
    if (originalsDiffer) {
      if (!isBlank(origTitle) && !isBlank(origCompany)) {
        const job_history = Array.isArray(existing.job_history) ? [...existing.job_history] : []
        const exists = job_history.some(e =>
          normalize(e && e.role) === normalize(origTitle) &&
          normalize(e && e.company) === normalize(origCompany)
        )
        if (!exists) {
          job_history.push({ role: origTitle, company: origCompany })
          update.job_history = job_history
        }
      }
      update.original_title = existing.current_title
      update.original_company = existing.current_company
    }
    update.last_change_type = null
  }

  if (location_changed) {
    update.current_location = incoming_location
  }

  const { error: updateErr } = await supabase
    .from(table)
    .update(update)
    .eq('id', existing.id)

  if (updateErr) {
    console.error(`[ClayContactsWebhook] Update error: ${updateErr.message}`)
    return res.status(500).json({ error: updateErr.message })
  }

  console.log(`[ClayContactsWebhook] ${table}: ${linkedin_url} — role: ${role_changed ? 'CHANGED' : 'same'}, company: ${company_changed ? 'CHANGED' : 'same'}, location: ${location_changed ? 'CHANGED' : 'same'}`)

  return res.status(200).json({
    success: true,
    action: 'updated',
    changes: { role_changed, company_changed, location_changed },
  })
}
