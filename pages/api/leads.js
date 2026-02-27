import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method === 'GET')   return handleGet(req, res)
  if (req.method === 'POST')  return handlePost(req, res)
  if (req.method === 'PATCH') return handlePatch(req, res)
  return res.status(405).json({ error: 'Method not allowed' })
}

async function handleGet(req, res) {
  const { claimed_by } = req.query
  try {
    let query = supabase
      .from('leads')
      .select('*')
      .order('claimed_at', { ascending: false })
    if (claimed_by) query = query.eq('claimed_by', claimed_by)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return res.status(200).json({ leads: data || [] })
  } catch (err) {
    console.error('Leads GET error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

async function handlePost(req, res) {
  const { signal_id, signal_type, company_name, signal_summary, claimed_by, claimed_at } = req.body || {}
  if (!signal_id || !claimed_by) {
    return res.status(400).json({ error: 'Missing required fields: signal_id, claimed_by' })
  }
  try {
    const { data, error } = await supabase
      .from('leads')
      .upsert(
        {
          signal_id,
          signal_type: signal_type || '',
          company_name: company_name || '',
          signal_summary: signal_summary || '',
          claimed_by,
          claimed_at: claimed_at || new Date().toISOString(),
          status: 'new',
          notes: '',
        },
        { onConflict: 'signal_id' }
      )
      .select()
      .single()
    if (error) throw new Error(error.message)
    return res.status(201).json({ lead: data })
  } catch (err) {
    console.error('Leads POST error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

async function handlePatch(req, res) {
  const { id, status, notes } = req.body || {}
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const updates = {}
  if (status !== undefined) updates.status = status
  if (notes  !== undefined) updates.notes  = notes

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  try {
    const { data, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return res.status(200).json({ lead: data })
  } catch (err) {
    console.error('Leads PATCH error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
