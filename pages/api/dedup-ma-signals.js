/**
 * Deduplication endpoint: finds and removes duplicate M&A signals that represent
 * the same deal from both sides (acquirer and target both file 8-Ks, or the
 * same signal was inserted multiple times).
 *
 * Two passes:
 *   Pass 1 — "Semantic" duplicates: two signals about the same deal
 *     - Signal A.company_name ≈ Signal B.acquired_name AND
 *       Signal B.company_name ≈ Signal A.acquired_name (symmetric — both sides filed)
 *     - OR Signal A.company_name ≈ Signal B.acquirer_name AND dates within 30 days
 *   Pass 2 — "Exact" duplicates: same company + same signal_type + dates within 7 days
 *     Keep the newer signal (more likely to have enrichment data).
 *
 * In all cases: when a pair is found, keep the signal with MORE non-null fields
 * in signal_detail; delete the other. Returns count of deleted signals.
 *
 * Usage: GET or POST /api/dedup-ma-signals
 */

import { supabase } from '../../lib/supabase.js'

/** Normalise a company name for fuzzy comparison (lowercase, strip legal suffixes). */
function normName(str) {
  if (!str) return ''
  return str
    .toLowerCase()
    .replace(/[,\.]/g, '')
    .replace(/\b(inc|corp|llc|ltd|plc|gmbh|therapeutics|biosciences|pharmaceuticals|pharma)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Return true if the two normalised names are "close enough" to be the same entity.
 * Strategy: one must start with the other's first 6 chars (handles abbreviations
 * and trailing-word differences), or one contains the other (substring).
 */
function namesSimilar(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 6 && b.startsWith(a.slice(0, 6))) return true
  if (b.length >= 6 && a.startsWith(b.slice(0, 6))) return true
  if (a.length >= 8 && b.includes(a.slice(0, 8))) return true
  if (b.length >= 8 && a.includes(b.slice(0, 8))) return true
  return false
}

/** Count non-null, non-empty fields in signal_detail. */
function richness(detail) {
  if (!detail || typeof detail !== 'object') return 0
  return Object.values(detail).filter((v) => v !== null && v !== undefined && v !== '').length
}

/** Days between two ISO date strings. */
function daysBetween(a, b) {
  if (!a || !b) return 999
  return Math.abs(Math.floor((new Date(a) - new Date(b)) / 86400000))
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // ── Fetch all MA transaction signals (up to 500) ─────────────────────────
    const { data: signals, error: fetchErr } = await supabase
      .from('signals')
      .select('id, signal_type, signal_detail, first_detected_at, created_at')
      .eq('signal_type', 'ma_transaction')
      .order('created_at', { ascending: false })
      .limit(500)

    if (fetchErr) throw fetchErr

    const all = (signals || []).map((s) => {
      const d = s.signal_detail || {}
      return {
        id:           s.id,
        signalType:   s.signal_type,
        detectedAt:   s.first_detected_at || s.created_at,
        detail:       d,
        companyName:  normName(d.company_name  || ''),
        acquirerName: normName(d.acquirer_name || ''),
        acquiredName: normName(d.acquired_name || ''),
        richness:     richness(d),
      }
    })

    const toDelete = new Set()

    // ── Pass 1: Semantic duplicates ───────────────────────────────────────────
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (toDelete.has(all[i].id) || toDelete.has(all[j].id)) continue

        const a = all[i]
        const b = all[j]

        // Case 1a: Symmetric match — A filed as target, B filed as acquirer
        // A.company_name ≈ B.acquired_name  AND  B.company_name ≈ A.acquired_name
        const symmetricMatch =
          a.acquiredName && b.acquiredName &&
          namesSimilar(a.companyName, b.acquiredName) &&
          namesSimilar(b.companyName, a.acquiredName)

        // Case 1b: A's company matches B's acquirer AND dates close (within 30 days)
        // (both filed from same side but different companies within the same deal group)
        const acquirerMatch =
          a.acquirerName && b.acquirerName &&
          (namesSimilar(a.companyName, b.acquirerName) || namesSimilar(b.companyName, a.acquirerName)) &&
          daysBetween(a.detectedAt, b.detectedAt) <= 30

        // Case 1c: Same acquired_name AND same acquirer_name
        const sameParties =
          a.acquiredName && b.acquiredName &&
          namesSimilar(a.acquiredName, b.acquiredName) &&
          a.acquirerName && b.acquirerName &&
          namesSimilar(a.acquirerName, b.acquirerName)

        if (symmetricMatch || acquirerMatch || sameParties) {
          // Keep the richer signal; delete the other
          const deleteId = a.richness >= b.richness ? b.id : a.id
          console.log(
            `[dedup-ma] Semantic dup: ${a.id} (${a.detail.company_name}) vs ${b.id} (${b.detail.company_name}) → delete ${deleteId}`
          )
          toDelete.add(deleteId)
        }
      }
    }

    // ── Pass 2: Exact duplicates — same company + signal_type within 7 days ──
    const byCompany = new Map()
    for (const s of all) {
      if (toDelete.has(s.id)) continue
      const key = `${s.companyName}|${s.signalType}`
      if (!byCompany.has(key)) byCompany.set(key, [])
      byCompany.get(key).push(s)
    }
    for (const [, group] of byCompany) {
      if (group.length < 2) continue
      // Sort by richness desc, then by detectedAt desc (newer first)
      group.sort((a, b) => b.richness - a.richness || new Date(b.detectedAt) - new Date(a.detectedAt))
      const keep = group[0]
      for (let k = 1; k < group.length; k++) {
        const candidate = group[k]
        if (daysBetween(keep.detectedAt, candidate.detectedAt) <= 7) {
          console.log(
            `[dedup-ma] Exact dup: ${candidate.id} (${candidate.detail.company_name}) within 7 days of ${keep.id} → delete ${candidate.id}`
          )
          toDelete.add(candidate.id)
        }
      }
    }

    // ── Delete duplicates ─────────────────────────────────────────────────────
    let deleted = 0
    const deleteIds = [...toDelete]
    if (deleteIds.length > 0) {
      const { error: delErr } = await supabase
        .from('signals')
        .delete()
        .in('id', deleteIds)
      if (delErr) throw delErr
      deleted = deleteIds.length
    }

    console.log(`[dedup-ma] Complete — ${all.length} signals checked, ${deleted} deleted`)

    return res.status(200).json({
      checked: all.length,
      deleted,
      message: `Checked ${all.length} MA signals, deleted ${deleted} duplicates`,
    })
  } catch (err) {
    console.error('[dedup-ma] Handler error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
