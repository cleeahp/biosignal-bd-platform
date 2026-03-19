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

    let query = supabase.from(table).select('*')

    if (table === 'past_buyers') {
      query = query.order('is_current_buyer', { ascending: false }).order('last_name', { ascending: true })
    } else {
      query = query.order('last_name', { ascending: true })
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
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

    // Fetch the contact from source table
    const { data: contact, error: fetchErr } = await supabase
      .from(from_table)
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !contact) {
      return res.status(404).json({ error: 'Contact not found' })
    }

    // Prepare record for destination table
    const insertData = {
      first_name: contact.first_name,
      last_name: contact.last_name,
      company: contact.company,
      title: contact.title,
      email: contact.email,
      phone: contact.phone,
      source: contact.source,
    }

    // Add is_current_buyer if moving to past_buyers
    if (to_table === 'past_buyers') {
      insertData.is_current_buyer = false
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
