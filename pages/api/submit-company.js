import { supabase } from '../../lib/supabase.js'

const CLAY_WEBHOOK_URL = 'https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-cb7f3cdd-47e8-47a0-9350-82c0868ccfab'

// Accept https://www.linkedin.com/company/{slug} (optional trailing slash) and
// reject deeper paths like /jobs, /about, etc.
const LINKEDIN_COMPANY_URL_RE = /^https:\/\/www\.linkedin\.com\/company\/[^/?#]+\/?$/i

function normalizeLinkedinUrl(s) {
  return String(s || '').trim().toLowerCase().replace(/\/+$/, '')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const rawInput = body.linkedin_url ? String(body.linkedin_url).trim() : ''

  if (!LINKEDIN_COMPANY_URL_RE.test(rawInput)) {
    return res.status(400).json({
      success: false,
      error: 'invalid_url',
      message: 'Please enter a valid LinkedIn company URL (e.g. https://www.linkedin.com/company/elutia)',
    })
  }

  const normalized = normalizeLinkedinUrl(rawInput)

  // Duplicate check — case-insensitive, ignoring trailing slashes on both sides.
  // Pre-filter with ilike using the normalized prefix, then compare exactly
  // after normalizing each candidate so e.g. ".../elut" doesn't match ".../elutia".
  const { data: candidates, error: lookupErr } = await supabase
    .from('companies_directory')
    .select('name, linkedin_url')
    .ilike('linkedin_url', `${normalized}%`)
  if (lookupErr) {
    console.error(`[SubmitCompany] Directory lookup error: ${lookupErr.message}`)
    return res.status(500).json({ success: false, error: lookupErr.message })
  }
  const dupe = (candidates || []).find(r => normalizeLinkedinUrl(r.linkedin_url) === normalized)
  if (dupe) {
    return res.status(200).json({
      success: false,
      error: 'already_exists',
      company_name: dupe.name,
    })
  }

  try {
    const response = await fetch(CLAY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'Company LinkedIn URL': rawInput }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[SubmitCompany] Clay error ${response.status}: ${text}`)
      return res.status(502).json({ success: false, error: `Clay returned ${response.status}` })
    }

    console.log(`[SubmitCompany] Sent to Clay: ${rawInput}`)
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error(`[SubmitCompany] Fetch error: ${err.message}`)
    return res.status(500).json({ success: false, error: err.message })
  }
}
