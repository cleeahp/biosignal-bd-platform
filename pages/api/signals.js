import { supabase } from '../../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res)
  }
  if (req.method === 'PATCH') {
    return handlePatch(req, res)
  }
  return res.status(405).json({ error: 'Method not allowed' })
}

async function handleGet(req, res) {
  try {
    const { data: signals, error } = await supabase
      .from('signals')
      .select(`
        *,
        companies (id, name, domain, industry, relationship_warmth)
      `)
      .in('status', ['new', 'carried_forward', 'claimed', 'contacted'])
      .neq('status', 'dismissed')
      .order('priority_score', { ascending: false })

    if (error) throw new Error(error.message)

    const totalActive = signals.length

    const newToday = signals.filter(s => {
      if (!s.first_detected_at) return false
      const d = new Date(s.first_detected_at)
      const now = new Date()
      return d.toDateString() === now.toDateString()
    }).length

    const claimed = signals.filter(s => s.claimed_by && s.claimed_by.trim() !== '').length

    return res.status(200).json({
      signals,
      stats: { totalActive, newToday, claimed },
      lastUpdated: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Signals GET error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

async function handlePatch(req, res) {
  const { id, status, claimed_by, notes, dismissal_reason, dismissal_value, inferred_client, claimed_at } = req.body || {}

  if (!id) return res.status(400).json({ error: 'Missing id' })

  const updates = {}
  if (status !== undefined) updates.status = status
  if (claimed_by !== undefined) updates.claimed_by = claimed_by

  // If notes, dismissal info, inferred_client, or claimed_at provided, merge into signal_detail
  if (notes !== undefined || dismissal_reason !== undefined || inferred_client !== undefined || claimed_at !== undefined) {
    const { data: existing, error: fetchError } = await supabase
      .from('signals')
      .select('signal_detail')
      .eq('id', id)
      .single()

    if (fetchError) {
      console.error('Signals PATCH fetch error:', fetchError.message)
      return res.status(500).json({ error: fetchError.message })
    }

    const currentDetail = existing?.signal_detail || {}
    if (notes !== undefined) currentDetail.rep_notes = notes
    if (dismissal_reason !== undefined) {
      currentDetail.dismissal_reason = dismissal_reason
      currentDetail.dismissal_value = dismissal_value
    }
    if (inferred_client !== undefined) {
      currentDetail.inferred_client = inferred_client
    }
    if (claimed_at !== undefined) {
      currentDetail.claimed_at = claimed_at
      currentDetail.claimed_by = claimed_by || ''
    }
    updates.signal_detail = currentDetail
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  const { data, error } = await supabase
    .from('signals')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('Signals PATCH error:', error.message)
    return res.status(500).json({ error: error.message })
  }

  return res.status(200).json({ signal: data })
}
