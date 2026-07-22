import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

// The four leads tables feeding the CRM, keyed by the person shown in the summary.
const LEADS_TABLES = [
  { table: 'madison_leads', person: 'madison' },
  { table: 'jim_leads',     person: 'jim' },
  { table: 'tim_leads',     person: 'tim' },
  { table: 'scott_leads',   person: 'scott' },
]

const LEADS_TABLE_SET = new Set(LEADS_TABLES.map(t => t.table))

// Fields a PATCH is allowed to write.
const EDITABLE_FIELDS = new Set([
  'momentum', 'development_stage', 'engagement_type', 'key_contact', 'partner', 'notes',
])

// Development-stage buckets counted in the summary table (label → summary key).
const DEV_STAGE_KEYS = {
  'Prospecting': 'prospecting',
  'Engaged':     'engaged',
  'Active':      'active',
  'MSA Sent':    'msa_sent',
  'MSA Signed':  'msa_signed',
}

// Momentum buckets counted in the summary table (label → summary key).
const MOMENTUM_KEYS = {
  'Drive':   'drive',
  'Neutral': 'neutral',
  'Reverse': 'reverse',
  'Park':    'park',
}

// engagement_type is a text[] column and can hold several values at once.
// Accepts an array, tolerates a legacy single string, and clears to NULL when empty.
function normalizeEngagementType(value) {
  const arr = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value])
  const cleaned = arr.map(v => String(v).trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : null
}

async function fetchAll(table, select) {
  const rows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    offset += PAGE
  }
  return rows
}

function emptySummary() {
  return {
    total_targets: 0,
    prospecting: 0, engaged: 0, active: 0, msa_sent: 0, msa_signed: 0,
    drive: 0, neutral: 0, reverse: 0, park: 0,
  }
}

export default async function handler(req, res) {
  // ── POST: manually push one company from a leads page into the CRM ───────────
  if (req.method === 'POST') {
    const { company_name, leads_page, date_added } = req.body || {}
    if (!company_name || !leads_page) {
      return res.status(400).json({ success: false, error: 'company_name and leads_page required' })
    }
    if (!LEADS_TABLE_SET.has(leads_page)) {
      return res.status(400).json({ success: false, error: 'invalid leads_page' })
    }

    const { data: existing, error: findErr } = await supabase
      .from('crm_accounts')
      .select('id')
      .eq('company_name', company_name)
      .eq('leads_page', leads_page)
      .limit(1)
      .maybeSingle()
    if (findErr) return res.status(500).json({ success: false, error: findErr.message })
    if (existing) return res.status(200).json({ success: false, error: 'already_exists' })

    // Prefer the caller-supplied date; otherwise read added_at off the leads row.
    let dateAdded = date_added || null
    if (!dateAdded) {
      const { data: lead } = await supabase
        .from(leads_page)
        .select('added_at')
        .eq('company_name', company_name)
        .limit(1)
        .maybeSingle()
      dateAdded = lead?.added_at || null
    }

    const { error } = await supabase
      .from('crm_accounts')
      .insert({ company_name, leads_page, date_added: dateAdded })
    if (error) return res.status(500).json({ success: false, error: error.message })
    return res.status(200).json({ success: true, inserted: true })
  }

  // ── DELETE: drop one CRM row (leaves the leads-page entry untouched) ─────────
  if (req.method === 'DELETE') {
    const { company_name, leads_page } = req.body || {}
    if (!company_name || !leads_page) {
      return res.status(400).json({ success: false, error: 'company_name and leads_page required' })
    }
    const { error } = await supabase
      .from('crm_accounts')
      .delete()
      .eq('company_name', company_name)
      .eq('leads_page', leads_page)
    if (error) return res.status(500).json({ success: false, error: error.message })
    return res.status(200).json({ success: true, deleted: true })
  }

  // ── PATCH: upsert a single field for a (company_name, leads_page) row ────────
  if (req.method === 'PATCH') {
    const { company_name, leads_page, field, value } = req.body || {}
    if (!company_name || !leads_page) {
      return res.status(400).json({ error: 'company_name and leads_page required' })
    }
    if (!EDITABLE_FIELDS.has(field)) {
      return res.status(400).json({ error: 'invalid field' })
    }

    const writeValue = field === 'engagement_type' ? normalizeEngagementType(value) : value

    const { data: existing, error: findErr } = await supabase
      .from('crm_accounts')
      .select('id')
      .eq('company_name', company_name)
      .eq('leads_page', leads_page)
      .maybeSingle()
    if (findErr) return res.status(500).json({ error: findErr.message })

    if (existing) {
      const { error } = await supabase
        .from('crm_accounts')
        .update({ [field]: writeValue, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) return res.status(500).json({ error: error.message })
    } else {
      const { error } = await supabase
        .from('crm_accounts')
        .insert({ company_name, leads_page, [field]: writeValue })
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  // ── GET: return accounts + summary ───────────────────────────────────────────
  // Companies land in crm_accounts only when pushed explicitly from a leads page
  // (POST above) — nothing is auto-created here.
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Load every leads row per table (used for the total_targets counts).
    const leadsByTable = {}
    for (const { table } of LEADS_TABLES) {
      leadsByTable[table] = await fetchAll(table, 'company_name')
    }

    const accounts = await fetchAll(
      'crm_accounts',
      'company_name, leads_page, momentum, development_stage, engagement_type, key_contact, partner, notes, date_added',
    )

    // Build the summary: total targets from the leads tables, stage/momentum
    // counts from crm_accounts.
    const summary = {}
    for (const { table, person } of LEADS_TABLES) {
      summary[person] = emptySummary()
      summary[person].total_targets = (leadsByTable[table] || []).length
    }
    const tableToPerson = Object.fromEntries(LEADS_TABLES.map(t => [t.table, t.person]))

    for (const acct of accounts) {
      const person = tableToPerson[acct.leads_page]
      if (!person) continue
      const stageKey = DEV_STAGE_KEYS[acct.development_stage]
      if (stageKey) summary[person][stageKey] += 1
      const momKey = MOMENTUM_KEYS[acct.momentum]
      if (momKey) summary[person][momKey] += 1
    }

    const responseData = { accounts, summary }
    const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (${accounts.length} accounts)`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
