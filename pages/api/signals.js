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
    // Fetch signals joined with company name
    const { data: signals, error } = await supabase
      .from('signals')
      .select(`
        id,
        signal_type,
        signal_summary,
        signal_detail,
        source_url,
        source_name,
        first_detected_at,
        status,
        claimed_by,
        priority_score,
        score_breakdown,
        days_in_queue,
        is_carried_forward,
        company_id,
        companies (
          id,
          name,
          domain,
          relationship_warmth,
          size_range
        )
      `)
      .in('status', ['new', 'carried_forward', 'claimed', 'contacted'])
      .order('priority_score', { ascending: false })

    if (error) throw new Error(error.message)

    // For each signal, check if any contacts exist
    const signalIds = signals.map((s) => s.id)
    const companyIds = [...new Set(signals.map((s) => s.company_id).filter(Boolean))]

    // Fetch contact existence by company
    let contactsByCompany = {}
    if (companyIds.length > 0) {
      const { data: contactData } = await supabase
        .from('contacts')
        .select('company_id')
        .in('company_id', companyIds)

      if (contactData) {
        for (const c of contactData) {
          contactsByCompany[c.company_id] = true
        }
      }
    }

    // Fetch signal_contacts for primary contact info
    let contactsBySignal = {}
    if (signalIds.length > 0) {
      const { data: scData } = await supabase
        .from('signal_contacts')
        .select('signal_id, contact_id, is_primary')
        .in('signal_id', signalIds)

      if (scData) {
        for (const sc of scData) {
          if (!contactsBySignal[sc.signal_id]) {
            contactsBySignal[sc.signal_id] = []
          }
          contactsBySignal[sc.signal_id].push(sc)
        }
      }
    }

    // Compute summary stats
    const totalActive = signals.length
    const newToday = signals.filter((s) => {
      if (!s.first_detected_at) return false
      const detected = new Date(s.first_detected_at)
      const today = new Date()
      return (
        detected.getFullYear() === today.getFullYear() &&
        detected.getMonth() === today.getMonth() &&
        detected.getDate() === today.getDate()
      )
    }).length
    const claimed = signals.filter((s) => s.claimed_by && s.claimed_by.trim() !== '').length

    const enrichedSignals = signals.map((s, idx) => ({
      ...s,
      rank: idx + 1,
      company_name: s.companies?.name || 'Unknown Company',
      relationship_warmth: s.companies?.relationship_warmth || 'new_prospect',
      has_contacts:
        !!(contactsBySignal[s.id]?.length > 0) ||
        !!(s.company_id && contactsByCompany[s.company_id]),
    }))

    return res.status(200).json({
      signals: enrichedSignals,
      stats: { totalActive, newToday, claimed },
      lastUpdated: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Signals API GET error:', error.message)
    return res.status(500).json({ error: error.message })
  }
}

async function handlePatch(req, res) {
  const { id, status, claimed_by } = req.body || {}

  if (!id) {
    return res.status(400).json({ error: 'Signal id is required' })
  }

  const updates = {}
  if (status !== undefined) updates.status = status
  if (claimed_by !== undefined) updates.claimed_by = claimed_by

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
    return res.status(500).json({ error: error.message })
  }

  return res.status(200).json({ signal: data })
}
