/**
 * Cleanup endpoint: removes academic/government signals, non-LinkedIn job signals,
 * garbage-title stale jobs, target_company_job signals, and job URL duplicates.
 *
 * Usage: GET or POST /api/cleanup-academic-signals
 * Returns: { deleted: N, total_matched: N, breakdown: {...}, message: "..." }
 */

import { supabase } from '../../lib/supabase.js'

// Combined academic patterns covering both CT and funding sources.
const ACADEMIC_CLEANUP_PATTERNS =
  /university|universite|college|hospital|medical cent(?:er|re)|health system|health cent(?:er|re)|\binstitute\b|school of|\bschool\b|foundation|academy|academie|\bNIH\b|\bNCI\b|\bFDA\b|\bCDC\b|\bNHLBI\b|national institute|national cancer|national heart|department of|children's|childrens|memorial|baptist|methodist|presbyterian|kaiser|mayo clinic|cleveland clinic|johns hopkins|\bmit\b|caltech|stanford|harvard|\byale\b|columbia university|university of pennsylvania|duke university|vanderbilt|emory university|\.edu\b|research cent(?:er|re)|cancer cent(?:er|re)|\bclinic\b|\bconsortium\b|\bsociety\b|\bassociation\b|ministry of|\bgovernment\b|\bfederal\b|national laborator|oncology group|cooperative group|intergroupe|francophone|thoracique|sloan kettering|anderson cancer/i

// Garbage job title patterns — scraped page text accidentally stored as job titles
const GARBAGE_TITLE_PATTERNS =
  /From Protocol to|Revealing the human|RWD and RWE are rewriting|ScienceAreas of Focus|Research and DevelopmentPipeline/i

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
    const toDelete = []
    const breakdown = {
      academic_government:       0,
      bad_phase_data:            0,
      non_linkedin_stale_jobs:   0,
      target_company_jobs:       0,
      non_linkedin_competitor:   0,
      garbage_job_titles:        0,
      duplicate_job_urls:        0,
    }

    // ── A: Academic / government signals (existing logic) ─────────────────────
    const { data: signals, error } = await supabase
      .from('signals')
      .select('id, signal_type, signal_detail, companies(name)')
      .in('signal_type', SIGNAL_TYPES_TO_CLEAN)

    if (error) throw error

    for (const signal of signals || []) {
      const d = signal.signal_detail || {}
      const companyName =
        signal.companies?.name ||
        d.company_name || d.sponsor || d.lead_sponsor || d.acquirer_name || ''
      if (companyName && ACADEMIC_CLEANUP_PATTERNS.test(companyName)) {
        toDelete.push(signal.id)
        breakdown.academic_government++
        console.log(`[cleanup] Academic signal: "${companyName}" (${signal.signal_type})`)
      }
    }

    // ── B: Clinical trial signals with bad phase data ─────────────────────────
    const { data: phaseSignals, error: phaseErr } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .in('signal_type', ['clinical_trial_phase_transition', 'clinical_trial_new_ind'])

    if (!phaseErr) {
      for (const signal of phaseSignals || []) {
        const d = signal.signal_detail || {}
        const phaseFrom = String(d.phase_from || '')
        const phaseTo   = String(d.phase_to   || '')
        if (
          phaseFrom === 'Pre-Clinical' ||
          ['?', 'NA', 'N/A'].includes(phaseTo.trim())
        ) {
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            breakdown.bad_phase_data++
            console.log(`[cleanup] Bad-phase signal: phase_from=${phaseFrom} phase_to=${phaseTo}`)
          }
        }
      }
    }

    // ── C: stale_job_posting signals NOT from LinkedIn ────────────────────────
    // staleJobTracker stores source='LinkedIn' (or job_board='linkedin').
    // targetCompanyJobsAgent stored source='BioSpace' | 'LinkedIn'.
    // Any record where neither field indicates LinkedIn is garbage.
    const { data: staleSignals, error: staleErr } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .eq('signal_type', 'stale_job_posting')

    if (!staleErr) {
      for (const signal of staleSignals || []) {
        const d = signal.signal_detail || {}
        const source   = (d.source   || '').toLowerCase()
        const jobBoard = (d.job_board || '').toLowerCase()
        const isLinkedIn = source === 'linkedin' || jobBoard === 'linkedin'
        if (!isLinkedIn) {
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            breakdown.non_linkedin_stale_jobs++
            console.log(`[cleanup] Non-LinkedIn stale job: source="${d.source}" job_board="${d.job_board}"`)
          }
        }
      }
    }

    // ── D: All target_company_job signals (came from career page scraping) ────
    const { data: targetSignals, error: targetErr } = await supabase
      .from('signals')
      .select('id')
      .eq('signal_type', 'target_company_job')

    if (!targetErr) {
      for (const signal of targetSignals || []) {
        if (!toDelete.includes(signal.id)) {
          toDelete.push(signal.id)
          breakdown.target_company_jobs++
        }
      }
      if ((targetSignals || []).length > 0) {
        console.log(`[cleanup] Removing ${targetSignals.length} target_company_job signals (career page sourced)`)
      }
    }

    // ── E: competitor_job_posting signals NOT from LinkedIn ───────────────────
    const { data: competitorSignals, error: compErr } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .eq('signal_type', 'competitor_job_posting')

    if (!compErr) {
      for (const signal of competitorSignals || []) {
        const d = signal.signal_detail || {}
        const atsSource = (d.ats_source || '').toLowerCase()
        if (atsSource && atsSource !== 'linkedin') {
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            breakdown.non_linkedin_competitor++
            console.log(`[cleanup] Non-LinkedIn competitor job: ats_source="${d.ats_source}"`)
          }
        }
      }
    }

    // ── F: stale_job_posting with garbage job titles ──────────────────────────
    const { data: staleForGarbage, error: garbageErr } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .eq('signal_type', 'stale_job_posting')

    if (!garbageErr) {
      for (const signal of staleForGarbage || []) {
        const d = signal.signal_detail || {}
        const title = d.job_title || ''
        if (title && GARBAGE_TITLE_PATTERNS.test(title)) {
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            breakdown.garbage_job_titles++
            console.log(`[cleanup] Garbage job title: "${title.slice(0, 60)}"`)
          }
        }
      }
    }

    // ── G: Duplicate signals by job_url (keep newest, delete older) ──────────
    // Fetch all job signals that have a job_url in signal_detail
    const { data: jobSignals, error: dupErr } = await supabase
      .from('signals')
      .select('id, signal_detail, created_at')
      .in('signal_type', ['stale_job_posting', 'competitor_job_posting', 'target_company_job'])
      .order('created_at', { ascending: false })

    if (!dupErr) {
      const seenJobUrls = new Map() // job_url → newest id already kept
      for (const signal of jobSignals || []) {
        const d = signal.signal_detail || {}
        const jobUrl = d.job_url || d.source_url || ''
        if (!jobUrl) continue
        if (seenJobUrls.has(jobUrl)) {
          // This signal is older — mark for deletion unless already marked
          if (!toDelete.includes(signal.id)) {
            toDelete.push(signal.id)
            breakdown.duplicate_job_urls++
          }
        } else {
          seenJobUrls.set(jobUrl, signal.id)
        }
      }
      if (breakdown.duplicate_job_urls > 0) {
        console.log(`[cleanup] Removing ${breakdown.duplicate_job_urls} duplicate-URL job signals`)
      }
    }

    if (toDelete.length === 0) {
      return res.status(200).json({
        deleted: 0,
        total_matched: 0,
        breakdown,
        message: 'No signals matched cleanup criteria',
      })
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
      deleted:       totalDeleted,
      total_matched: toDelete.length,
      breakdown,
      message:       `Deleted ${totalDeleted} signals (${JSON.stringify(breakdown)})`,
    })
  } catch (err) {
    console.error('[cleanup] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
