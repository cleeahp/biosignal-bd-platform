import { supabase } from '../../lib/supabase.js'
import { matchSpecialties } from '../../lib/specialtyMatcher.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'

function isBlank(s) {
  return s == null || String(s).trim() === ''
}

// ── job_title_overrides cache (5 minutes, mirrors clay-jobs-webhook.js) ────────
let titleCache = null
const TITLE_CACHE_TTL_MS = 5 * 60 * 1000

async function loadOverrides() {
  if (titleCache && Date.now() - titleCache.loadedAt < TITLE_CACHE_TTL_MS) return titleCache.overrides

  const overrides = new Map()
  const PAGE = 1000
  let offset = 0
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

  titleCache = { overrides, loadedAt: Date.now() }
  return overrides
}

// Rank a companies_directory company_size bucket so we can pick the "largest"
// when a domain maps to multiple directory entries. Uses the lower bound of the
// employee range; unknown/blank buckets rank below any real bucket.
function companySizeRank(size) {
  if (isBlank(size)) return -1
  const s = String(size).toLowerCase()
  if (s.includes('self-employed')) return 1
  const digits = s.replace(/,/g, '').match(/\d+/)
  return digits ? parseInt(digits[0], 10) : -1
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay leads contacts webhook is active' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = req.headers.authorization || req.headers.Authorization
  if (auth !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const full_name = body.full_name != null ? String(body.full_name).trim() : null
  const first_name = body.first_name != null ? String(body.first_name).trim() : null
  const last_name = body.last_name != null ? String(body.last_name).trim() : null
  const job_title = body.job_title != null ? String(body.job_title).trim() : null
  const location = body.location != null ? String(body.location).trim() : null
  const company_domain = body.company_domain != null ? String(body.company_domain).trim() : null
  const linkedin_url = body.linkedin_url ? String(body.linkedin_url).trim() : ''

  // Skip records with no LinkedIn URL — it's our dedup key.
  if (!linkedin_url) {
    return res.status(200).json({ success: true, skipped: 'no_linkedin_url' })
  }

  // Dedup by linkedin_url.
  const { data: existing, error: dupErr } = await supabase
    .from('leads_contacts')
    .select('id')
    .ilike('linkedin_url', linkedin_url)
    .maybeSingle()

  if (dupErr) {
    console.error(`[ClayLeadsContacts] Dedup lookup error: ${dupErr.message}`)
    return res.status(500).json({ error: dupErr.message })
  }

  if (existing) {
    return res.status(200).json({ success: true, skipped: 'duplicate' })
  }

  // Resolve company name from domain via companies_directory (case-insensitive).
  // If a domain maps to multiple companies, pick the one with the largest size.
  let company_name = null
  if (!isBlank(company_domain)) {
    const { data: dirMatches, error: dirErr } = await supabase
      .from('companies_directory')
      .select('name, company_size')
      .ilike('domain', company_domain)

    if (dirErr) {
      console.error(`[ClayLeadsContacts] Directory lookup error: ${dirErr.message}`)
      return res.status(500).json({ error: dirErr.message })
    }

    if (dirMatches && dirMatches.length > 0) {
      const best = dirMatches.reduce((a, b) =>
        companySizeRank(b.company_size) > companySizeRank(a.company_size) ? b : a
      )
      company_name = best.name ?? null
    }
  }

  // Categorize by specialty using the same override-aware matcher as jobs.
  let specialty
  try {
    const overrides = await loadOverrides()
    specialty = matchSpecialties(job_title, overrides)
  } catch (err) {
    console.error(`[ClayLeadsContacts] Override cache load error: ${err.message}`)
    specialty = matchSpecialties(job_title)
  }

  const { error: insertErr } = await supabase
    .from('leads_contacts')
    .insert({
      full_name,
      first_name,
      last_name,
      job_title,
      location,
      company_domain,
      company_name,
      linkedin_url,
      specialty,
    })

  if (insertErr) {
    console.error(`[ClayLeadsContacts] Insert error: ${insertErr.message}`)
    return res.status(500).json({ error: insertErr.message })
  }

  console.log(`[ClayLeadsContacts] Inserted: ${full_name} — ${job_title} at ${company_domain} (company: ${company_name || 'no match'})`)

  return res.status(200).json({ success: true, inserted: true })
}
