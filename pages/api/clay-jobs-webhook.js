import { supabase } from '../../lib/supabase.js'

const AUTH_TOKEN = 'Bearer biosignal-clay-2026'

// ── Company name cleaning & matching (mirrors scripts/secFilingsScan.js) ───────

const LEGAL_SUFFIXES_RE = /[,.]?\s*\b(Inc\.?|Corp\.?|Corporation|LLC\.?|Ltd\.?|Limited|L\.?P\.?|LP|Co\.?|GmbH|B\.?V\.?|S\.?A\.?|S\.?L\.?|KGaA|ApS|Srl|A\/S|PLC|plc|AG|NV|SE|Pty)\s*$/i
const COUNTRY_SUFFIX_RE = /\s*[/\\]\s*(?:DE|NEW|FI|UK|CAN|NV|MD|NY|CA|TX|WA|IL|MA|PA|NJ|CT|OH|MN|CO|AZ|GA|NC|VA|FL|OR|WI|IN|MO|KS|UT|SC|TN|LA|AL|MI|IA|NE|AR|MS|OK|WV|NH|ME|HI|ID|MT|NM|ND|RI|SD|VT|WY|AK|DC|PR|GU|VI)\s*$/
const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'a', 'an', 'in', 'by', 'at', 'to'])

function cleanName(raw) {
  if (!raw) return ''
  let s = raw
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

function significantWords(cleaned) {
  if (!cleaned) return []
  return cleaned.split(/\s+/).filter(w => w.length > 0 && !STOP_WORDS.has(w))
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0
  const match = sizeStr.replace(/,/g, '').match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

function pickLargest(entries) {
  if (!entries || entries.length === 0) return null
  if (entries.length === 1) return entries[0]
  let best = entries[0]
  let bestSize = parseSize(best.size)
  for (let i = 1; i < entries.length; i++) {
    const s = parseSize(entries[i].size)
    if (s > bestSize) {
      best = entries[i]
      bestSize = s
    }
  }
  return best
}

// ── Directory cache (5 minutes) ───────────────────────────────────────────────

let cache = null
const CACHE_TTL_MS = 5 * 60 * 1000

async function loadDirectory() {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache

  const nameMap = new Map()     // cleaned name → [{name, size}]
  const wordIndex = new Map()   // sorted-word-key → [{name, size}]
  const sizeMap = new Map()     // directory name → company_size
  const altNameMap = new Map()  // lowercase alternate_name → directory_name
  const PAGE = 1000

  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name, company_size')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`companies_directory: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data) {
      const entry = { name: row.name, size: row.company_size || null }
      const cleaned = cleanName(row.name)
      if (!cleaned) continue

      if (!nameMap.has(cleaned)) nameMap.set(cleaned, [])
      nameMap.get(cleaned).push(entry)

      const words = significantWords(cleaned)
      if (words.length >= 2) {
        const key = [...words].sort().join('|')
        if (!wordIndex.has(key)) wordIndex.set(key, [])
        wordIndex.get(key).push(entry)
      }

      if (!sizeMap.has(row.name)) sizeMap.set(row.name, row.company_size || null)
    }
    offset += PAGE
  }

  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('directory_name, alternate_name')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`companies_alternate_names: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data) {
      if (!row.alternate_name || !row.directory_name) continue
      altNameMap.set(row.alternate_name.trim().toLowerCase(), row.directory_name)
    }
    offset += PAGE
  }

  cache = { nameMap, wordIndex, sizeMap, altNameMap, loadedAt: Date.now() }
  return cache
}

function matchCompany(companyName, { nameMap, wordIndex, sizeMap, altNameMap }) {
  if (!companyName) return null

  // Alternate-names table lookup
  const altKey = companyName.trim().toLowerCase()
  const altHit = altNameMap.get(altKey)
  if (altHit) {
    return { dirName: altHit, size: sizeMap.get(altHit) || null, layer: 'alternate_name' }
  }

  // Layer 1: exact cleaned match
  const cleaned = cleanName(companyName)
  if (cleaned) {
    const entries = nameMap.get(cleaned)
    if (entries && entries.length > 0) {
      const best = pickLargest(entries)
      return { dirName: best.name, size: best.size || sizeMap.get(best.name) || null, layer: 'exact_name' }
    }
  }

  // Layer 2: strict bidirectional keyword match (multi-word only)
  const words = significantWords(cleaned)
  if (words.length >= 2) {
    const key = [...words].sort().join('|')
    const entries = wordIndex.get(key)
    if (entries && entries.length > 0) {
      const best = pickLargest(entries)
      return { dirName: best.name, size: best.size || sizeMap.get(best.name) || null, layer: 'keyword' }
    }
  }

  return null
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Clay jobs webhook is active' })
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

  // Duplicate check
  const { data: existing, error: existingErr } = await supabase
    .from('clay_jobs')
    .select('id')
    .eq('job_url', job_url)
    .maybeSingle()

  if (existingErr) {
    console.error(`[ClayWebhook] Duplicate lookup error: ${existingErr.message}`)
    return res.status(500).json({ error: existingErr.message })
  }

  if (existing) {
    return res.status(200).json({ success: true, skipped: 'duplicate' })
  }

  // Company match
  let matched_name = null
  let company_size = null
  let matched_via = null

  try {
    const dir = await loadDirectory()
    const match = matchCompany(company_name, dir)
    if (match) {
      matched_name = match.dirName
      company_size = match.size
      matched_via = match.layer
    }
  } catch (err) {
    console.error(`[ClayWebhook] Directory load error: ${err.message}`)
  }

  const row = {
    job_title,
    company_name,
    location,
    company_domain,
    job_url,
    date_posted,
    matched_name,
    company_size,
    matched_via,
    raw_payload: body,
  }

  const { error: insertErr } = await supabase.from('clay_jobs').insert(row)
  if (insertErr) {
    console.error(`[ClayWebhook] Insert error: ${insertErr.message}`)
    return res.status(500).json({ error: insertErr.message })
  }

  console.log(`[ClayWebhook] Inserted: ${company_name} — ${job_title} (matched: ${matched_name || 'none'})`)
  return res.status(200).json({ success: true, inserted: true })
}
