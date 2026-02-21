/**
 * One-time cleanup endpoint: deletes clinical trial and funding signals
 * where the company/sponsor name matches known academic/government patterns.
 *
 * Usage: GET /api/cleanup-academic-signals
 * Returns: { deleted: N, message: "..." }
 */

import { supabase } from '../../lib/supabase.js'

// Combined academic patterns covering both CT and funding sources.
// Mirrors CT_ACADEMIC_PATTERNS (clinicalTrialMonitor.js) and ACADEMIC_PATTERNS (fundingMaAgent.js).
const ACADEMIC_CLEANUP_PATTERNS =
  /university|universite|college|hospital|medical cent(?:er|re)|health system|health cent(?:er|re)|\binstitute\b|school of|\bschool\b|foundation|academy|academie|\bNIH\b|\bNCI\b|\bFDA\b|\bCDC\b|\bNHLBI\b|national institute|national cancer|national heart|department of|children's|childrens|memorial|baptist|methodist|presbyterian|kaiser|mayo clinic|cleveland clinic|johns hopkins|\bmit\b|caltech|stanford|harvard|\byale\b|columbia university|university of pennsylvania|duke university|vanderbilt|emory university|\.edu\b|research cent(?:er|re)|cancer cent(?:er|re)|\bclinic\b|\bconsortium\b|\bsociety\b|\bassociation\b|ministry of|\bgovernment\b|\bfederal\b|national laborator|oncology group|cooperative group|intergroupe|francophone|thoracique|sloan kettering|anderson cancer/i

const SIGNAL_TYPES_TO_CLEAN = [
  'clinical_trial_phase_transition',
  'clinical_trial_new_ind',
  'funding_new_award',
  'ma_transaction',
]

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Fetch signals of relevant types along with their company name join
    const { data: signals, error } = await supabase
      .from('signals')
      .select('id, signal_type, signal_detail, companies(name)')
      .in('signal_type', SIGNAL_TYPES_TO_CLEAN)

    if (error) throw error

    const toDelete = []
    for (const signal of signals || []) {
      const d = signal.signal_detail || {}
      // Check company name from join, then from signal_detail fields
      const companyName =
        signal.companies?.name ||
        d.company_name ||
        d.sponsor ||
        d.lead_sponsor ||
        d.acquirer_name ||
        ''
      if (companyName && ACADEMIC_CLEANUP_PATTERNS.test(companyName)) {
        toDelete.push(signal.id)
        console.log(`[cleanup] Marking for deletion: "${companyName}" (${signal.signal_type})`)
      }
    }

    // Also flag clinical trial signals with bad phase data for deletion
    const { data: phaseSignals, error: phaseErr } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .in('signal_type', ['clinical_trial_phase_transition', 'clinical_trial_new_ind'])

    if (!phaseErr) {
      for (const signal of phaseSignals || []) {
        const d = signal.signal_detail || {}
        const phaseFrom = String(d.phase_from || '')
        const phaseTo = String(d.phase_to || '')
        if (
          phaseFrom === 'Pre-Clinical' ||
          ['?', 'NA', 'N/A'].includes(phaseTo.trim())
        ) {
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            console.log(`[cleanup] Pre-Clinical signal: phase_from=${phaseFrom} phase_to=${phaseTo}`)
          }
        }
      }
    }

    if (toDelete.length === 0) {
      return res.status(200).json({ deleted: 0, message: 'No academic or bad-phase signals found to clean up' })
    }

    // Delete in batches of 100 to avoid query size limits
    let totalDeleted = 0
    for (let i = 0; i < toDelete.length; i += 100) {
      const batch = toDelete.slice(i, i + 100)
      const { error: delError } = await supabase.from('signals').delete().in('id', batch)
      if (!delError) totalDeleted += batch.length
      else console.error('[cleanup] Batch delete error:', delError.message)
    }

    return res.status(200).json({
      deleted: totalDeleted,
      total_matched: toDelete.length,
      message: `Deleted ${totalDeleted} academic/government/bad-phase signals`,
    })
  } catch (err) {
    console.error('[cleanup] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
