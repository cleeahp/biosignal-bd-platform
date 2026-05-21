import { supabase } from '../../lib/supabase.js'

const ALLOWED_TABLES = ['past_buyers', 'past_candidates']

function isValidTable(table) {
  return ALLOWED_TABLES.includes(table)
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { table } = req.query
    if (!table || !isValidTable(table)) {
      return res.status(400).json({ error: 'Invalid or missing table parameter. Must be one of: past_buyers, past_candidates' })
    }

    const query = supabase.from(table).select('*').order('person_name', { ascending: true })

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    const rows = data || []

    let maxDate = null
    for (const r of rows) {
      const d = r.last_enrichment_date
      if (d && (!maxDate || d > maxDate)) maxDate = d
    }
    const normalize = (s) => (s || '').trim().toLowerCase()
    let companyChanges = 0
    let roleChanges = 0
    let bothChanges = 0
    for (const row of rows) {
      const cc = normalize(row.original_company) !== normalize(row.current_company)
        && normalize(row.original_company) !== '' && normalize(row.current_company) !== ''
      const rc = normalize(row.original_title) !== normalize(row.current_title)
        && normalize(row.original_title) !== '' && normalize(row.current_title) !== ''
      if (cc && rc) bothChanges++
      else if (cc) companyChanges++
      else if (rc) roleChanges++
    }
    const summary = {
      total: rows.length,
      last_enrichment_date: maxDate,
      company_changes: companyChanges + bothChanges,
      role_changes: roleChanges + bothChanges,
    }

    const response = { rows, summary }
    const sizeMB = (Buffer.byteLength(JSON.stringify(response), 'utf8') / (1024 * 1024)).toFixed(2)
    console.log(`[API] ${req.url}: ${sizeMB} MB (${rows.length} rows)`)
    return res.status(200).json(response)
  }

  if (req.method === 'POST') {
    // Move a contact between tables
    const { id, from_table, to_table } = req.body

    if (!id || !from_table || !to_table) {
      return res.status(400).json({ error: 'Missing required fields: id, from_table, to_table' })
    }
    if (!isValidTable(from_table) || !isValidTable(to_table)) {
      return res.status(400).json({ error: 'Invalid table name' })
    }
    if (from_table === to_table) {
      return res.status(400).json({ error: 'from_table and to_table must be different' })
    }

    // Fetch the contact from source table.
    // past_buyers stores email as `original_email`; past_candidates stores it as `email`.
    const sourceEmailCol = from_table === 'past_buyers' ? 'original_email' : 'email'
    const targetEmailCol = to_table === 'past_buyers' ? 'original_email' : 'email'

    const { data: contact, error: fetchErr } = await supabase
      .from(from_table)
      .select(`person_name, linkedin_url, original_title, original_company, phone, current_title, current_company, current_location, ${sourceEmailCol}`)
      .eq('id', id)
      .single()

    if (fetchErr || !contact) {
      return res.status(404).json({ error: 'Contact not found' })
    }

    const insertData = {
      person_name: contact.person_name,
      linkedin_url: contact.linkedin_url,
      original_title: contact.original_title,
      original_company: contact.original_company,
      phone: contact.phone,
      current_title: contact.current_title,
      current_company: contact.current_company,
      current_location: contact.current_location,
      [targetEmailCol]: contact[sourceEmailCol],
    }

    // Insert into destination table
    const { error: insertErr } = await supabase
      .from(to_table)
      .insert(insertData)

    if (insertErr) {
      // If duplicate key, just delete from source
      if (insertErr.code === '23505') {
        // Duplicate — already exists in destination, just remove from source
      } else {
        return res.status(500).json({ error: `Insert failed: ${insertErr.message}` })
      }
    }

    // Delete from source table
    const { error: deleteErr } = await supabase
      .from(from_table)
      .delete()
      .eq('id', id)

    if (deleteErr) {
      return res.status(500).json({ error: `Delete failed: ${deleteErr.message}` })
    }

    return res.status(200).json({ success: true, moved: { from: from_table, to: to_table } })
  }

  if (req.method === 'DELETE') {
    const { id, table } = req.body

    if (!id || !table) {
      return res.status(400).json({ error: 'Missing required fields: id, table' })
    }
    if (!isValidTable(table)) {
      return res.status(400).json({ error: 'Invalid table name' })
    }

    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', id)

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
