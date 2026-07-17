import { supabase } from '../../lib/supabase.js'

const PAGE = 1000

// The four leads tables feeding the CRM, keyed by the person shown in the summary.
const LEADS_TABLES = [
  { table: 'madison_leads', person: 'madison' },
  { table: 'jim_leads',     person: 'jim' },
  { table: 'tim_leads',     person: 'tim' },
  { table: 'scott_leads',   person: 'scott' },
]

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
  'Closed':      'closed',
}

// Momentum buckets counted in the summary table (label → summary key).
const MOMENTUM_KEYS = {
  'Drive':   'drive',
  'Neutral': 'neutral',
  'Reverse': 'reverse',
  'Park':    'park',
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
    prospecting: 0, engaged: 0, active: 0, msa_sent: 0, closed: 0,
    drive: 0, neutral: 0, reverse: 0, park: 0,
  }
}

export default async function handler(req, res) {
  // ── PATCH: upsert a single field for a (company_name, leads_page) row ────────
  if (req.method === 'PATCH') {
    const { company_name, leads_page, field, value } = req.body || {}
    if (!company_name || !leads_page) {
      return res.status(400).json({ error: 'company_name and leads_page required' })
    }
    if (!EDITABLE_FIELDS.has(field)) {
      return res.status(400).json({ error: 'invalid field' })
    }

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
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) return res.status(500).json({ error: error.message })
    } else {
      const { error } = await supabase
        .from('crm_accounts')
        .insert({ company_name, leads_page, [field]: value })
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  // ── GET: sync missing leads → crm_accounts, then return accounts + summary ───
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Load every leads row (company_name + added_at) per table.
    const leadsByTable = {}
    for (const { table } of LEADS_TABLES) {
      leadsByTable[table] = await fetchAll(table, 'company_name, added_at')
    }

    // Load existing crm_accounts rows so we can detect which leads are missing.
    const existingRows = await fetchAll(
      'crm_accounts',
      'company_name, leads_page, momentum, development_stage, engagement_type, key_contact, partner, notes, date_added',
    )
    const existingKeys = new Set(
      existingRows.map(r => `${r.leads_page}||${String(r.company_name).toLowerCase()}`),
    )

    // Auto-create crm_accounts entries for leads that don't have one yet.
    const toInsert = []
    for (const { table } of LEADS_TABLES) {
      for (const lead of leadsByTable[table]) {
        const key = `${table}||${String(lead.company_name).toLowerCase()}`
        if (existingKeys.has(key)) continue
        existingKeys.add(key)
        toInsert.push({
          company_name: lead.company_name,
          leads_page: table,
          date_added: lead.added_at || null,
        })
      }
    }

    if (toInsert.length > 0) {
      // Insert in chunks to stay well under any payload limits.
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500)
        const { error } = await supabase.from('crm_accounts').insert(chunk)
        if (error) throw new Error(`crm_accounts insert: ${error.message}`)
      }
    }

    // Re-fetch the full account set (now including any freshly-synced rows).
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
    console.log(`[API] ${req.url}: ${sizeMB} MB (${accounts.length} accounts, ${toInsert.length} synced)`)
    return res.status(200).json(responseData)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
