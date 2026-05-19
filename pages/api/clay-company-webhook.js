import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'
const TABLE = 'companies_directory'
const PAGE = 1000

// ── Cleaning (mirrors scripts/secFilingsScan.js cleanName) ────────────────────

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i
const COUNTRY_SUFFIX_RE = /\s*[/\\]\s*(?:DE|NEW|FI|UK|CAN|NV|MD|NY|CA|TX|WA|IL|MA|PA|NJ|CT|OH|MN|CO|AZ|GA|NC|VA|FL|OR|WI|IN|MO|KS|UT|SC|TN|LA|AL|MI|IA|NE|AR|MS|OK|WV|NH|ME|HI|ID|MT|NM|ND|RI|SD|VT|WY|AK|DC|PR|GU|VI)\s*$/

function cleanName(raw) {
  if (!raw) return ''
  let s = String(raw)
  s = s.replace(/\s*\([^)]*\)/g, '')
  s = s.replace(COUNTRY_SUFFIX_RE, '')
  for (let i = 0; i < 3; i++) {
    const prev = s
    s = s.replace(LEGAL_SUFFIXES_RE, '')
    if (s === prev) break
  }
  s = s.replace(/[,.\s]+$/, '').trim()
  return s.toLowerCase()
}

// ── News matcher: Layer 1 only (start-of-title + word boundary) ───────────────

const LIFE_SCIENCE_TERMS = new Set([
  'pharmaceutical', 'pharmaceuticals', 'biotech', 'biotechnology', 'bio',
  'biopharma', 'biopharmaceutical', 'biopharmaceuticals', 'bioscience',
  'biosciences', 'therapeutics', 'therapeutic', 'pharma', 'genomics',
  'diagnostics', 'medical', 'health', 'healthcare', 'scientific',
  'sciences', 'science', 'laboratories', 'laboratory', 'biologic',
  'biologics', 'solutions', 'technologies', 'technology', 'life sciences',
  'lifesciences', 'group', 'product', 'products',
])

function isAlnum(c) {
  if (!c) return false
  const code = c.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function titleStartsWithCompany(title, cleanedCompanyLower) {
  if (!title || !cleanedCompanyLower) return false
  const lower = String(title).toLowerCase()
  if (cleanedCompanyLower.length > lower.length) return false
  if (!lower.startsWith(cleanedCompanyLower)) return false
  const endIdx = cleanedCompanyLower.length
  if (endIdx < lower.length && isAlnum(lower[endIdx])) return false
  return true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normKey(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : ''
}

async function matchSignalTable({ table, sourceField, cleanedTarget, companyName, companySize }) {
  let matched = 0
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(`id, ${sourceField}`)
      .is('matched_name', null)
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error(`[ClayCompanyWebhook] ${table} fetch error: ${error.message}`)
      break
    }
    if (!data || data.length === 0) break

    const toUpdate = []
    for (const row of data) {
      if (cleanName(row[sourceField]) === cleanedTarget) toUpdate.push(row.id)
    }
    if (toUpdate.length > 0) {
      const { error: updErr } = await supabase
        .from(table)
        .update({ matched_name: companyName, company_size: companySize })
        .in('id', toUpdate)
      if (updErr) console.error(`[ClayCompanyWebhook] ${table} update error: ${updErr.message}`)
      else matched += toUpdate.length
    }

    if (data.length < PAGE) break
    offset += PAGE
  }
  return matched
}

async function matchNewsTable({ table, cleanedTargetLower, companyName }) {
  let matched = 0
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, title, matched_names')
      .or('matched_names.is.null,matched_names.eq.{}')
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error(`[ClayCompanyWebhook] ${table} fetch error: ${error.message}`)
      break
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      if (!titleStartsWithCompany(row.title, cleanedTargetLower)) continue
      const current = Array.isArray(row.matched_names) ? row.matched_names : []
      if (current.includes(companyName)) continue
      const next = [...current, companyName]
      const { error: updErr } = await supabase
        .from(table)
        .update({ matched_names: next })
        .eq('id', row.id)
      if (updErr) console.error(`[ClayCompanyWebhook] ${table} update error: ${updErr.message}`)
      else matched += 1
    }

    if (data.length < PAGE) break
    offset += PAGE
  }
  return matched
}

async function ensureAlternateName(name) {
  const { data, error } = await supabase
    .from('companies_alternate_names')
    .select('id')
    .ilike('alternate_name', name)
    .maybeSingle()
  if (error) {
    console.error(`[ClayCompanyWebhook] alternate name lookup error: ${error.message}`)
    return
  }
  if (data) return
  const { error: insErr } = await supabase
    .from('companies_alternate_names')
    .insert({ directory_name: name, alternate_name: name, matched_via: 'directory' })
  if (insErr) console.error(`[ClayCompanyWebhook] alternate name insert error: ${insErr.message}`)
}

async function runMatchingPass(name, companySize) {
  const cleaned = cleanName(name)
  if (!cleaned) {
    console.log(`[ClayCompanyWebhook] Skipping matching — name cleans to empty: "${name}"`)
    return
  }
  if (LIFE_SCIENCE_TERMS.has(cleaned)) {
    console.log(`[ClayCompanyWebhook] Skipping news matching — name "${name}" is a generic industry term`)
  }

  console.log(`[ClayCompanyWebhook] Matching "${name}" against unmatched signals...`)

  const counts = { clinical_trials: 0, eight_k: 0, s1: 0, funding: 0, news: 0 }

  counts.clinical_trials = await matchSignalTable({
    table: 'clinical_trials', sourceField: 'lead_sponsor_name',
    cleanedTarget: cleaned, companyName: name, companySize,
  })
  counts.eight_k = await matchSignalTable({
    table: 'eight_k_filings', sourceField: 'company_name',
    cleanedTarget: cleaned, companyName: name, companySize,
  })
  counts.s1 = await matchSignalTable({
    table: 's1_filings', sourceField: 'company_name',
    cleanedTarget: cleaned, companyName: name, companySize,
  })
  counts.funding = await matchSignalTable({
    table: 'funding_projects', sourceField: 'org_name',
    cleanedTarget: cleaned, companyName: name, companySize,
  })

  if (!LIFE_SCIENCE_TERMS.has(cleaned) && cleaned.length >= 3) {
    for (const table of ['fiercebio_news', 'biospace_news', 'endpoint_news']) {
      counts.news += await matchNewsTable({ table, cleanedTargetLower: cleaned, companyName: name })
    }
  }

  await ensureAlternateName(name)

  console.log(`[ClayCompanyWebhook] Matched: clinical_trials: ${counts.clinical_trials}, eight_k: ${counts.eight_k}, s1: ${counts.s1}, funding: ${counts.funding}, news: ${counts.news}`)

  const { error: refreshErr } = await supabase.rpc('refresh_company_signal_summary')
  if (refreshErr) console.error(`[ClayCompanyWebhook] Materialized view refresh error: ${refreshErr.message}`)
  else console.log(`[ClayCompanyWebhook] Materialized view refreshed`)
}

// ── Handler ───────────────────────────────────────────────────────────────────

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
  let action

  if (existing) {
    const { error: updateErr } = await supabase
      .from(TABLE)
      .update(updateFields)
      .eq('id', existing.id)
    if (updateErr) {
      console.error(`[ClayCompanyWebhook] Update error: ${updateErr.message}`)
      return res.status(500).json({ error: updateErr.message })
    }
    action = 'updated'
    console.log(`[ClayCompanyWebhook] updated: ${name} (${linkedin_url || 'no linkedin'})`)
  } else {
    const { error: insertErr } = await supabase
      .from(TABLE)
      .insert({ name, linkedin_url, ...updateFields })
    if (insertErr) {
      console.error(`[ClayCompanyWebhook] Insert error: ${insertErr.message}`)
      return res.status(500).json({ error: insertErr.message })
    }
    action = 'inserted'
    console.log(`[ClayCompanyWebhook] inserted: ${name} (${linkedin_url || 'no linkedin'})`)
  }

  res.status(200).json({ success: true, action })

  // Fire-and-forget matching pass
  setImmediate(() => {
    runMatchingPass(name, company_size).catch(err => {
      console.error(`[ClayCompanyWebhook] Matching pass error: ${err.message}`)
    })
  })
}
