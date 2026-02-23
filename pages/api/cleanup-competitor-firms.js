/**
 * API endpoint to clean up competitor_firms table and re-seed with correct staffing firms only.
 * 
 * Removes CROs and clinical research associations that were mistakenly added.
 * Re-seeds with the corrected list of staffing firms.
 * 
 * POST /api/cleanup-competitor-firms
 * 
 * Response:
 * {
 *   success: true,
 *   deactivated: 5,
 *   deactivatedFirms: ['ICON plc', 'Advanced Clinical', ...],
 *   seeded: 30,
 *   message: 'Competitor firms cleaned up and re-seeded'
 * }
 */

import { supabase } from '../../lib/supabase.js'

// CROs and associations to remove (these are NOT staffing firms)
const CRO_AND_ASSOCIATIONS_TO_REMOVE = [
  'ICON plc',
  'ICON',
  'Advanced Clinical',
  'Alku',
  'Black Diamond Networks',
  'Real Life Sciences',
  'The Planet Group',
  'USTech Solutions',
  'Soliant Health',
  'Epic Staffing Group',
  'Spectra Force',
  'Mindlance',
  'Pacer Staffing',
  'ZP Group',
  'Meet Staffing',
  'Ampcus',
  'ClinLab Staffing',
  'Peoplelink Group',
]

// Correct list of staffing firms
const STAFFING_FIRMS = [
  'Randstad',
  'Adecco',
  'Kelly Services',
  'Manpower',
  'Hays',
  'Actalent',
  'Insight Global',
  'Planet Pharma',
  'Proclinical',
  'Real Staffing',
  'GForce Life Sciences',
  'Medix',
  'EPM Scientific',
  'ClinLab Solutions Group',
  'Sci.bio',
  'Gemini Staffing Consultants',
  'Orbis Clinical',
  'Scientific Search',
  'TriNet Pharma',
  'The Fountain Group',
  'Hueman RPO',
  'Net2Source',
  'Oxford Global Resources',
  'Beacon Hill Staffing Group',
  'ASGN Incorporated',
  'Yoh Services',
  'Joule Staffing',
  'Solomon Page',
  'Green Key Resources',
  'Phaidon International',
]

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    console.log('[CleanupCompetitorFirms] Starting cleanup...')

    // Step 1: Deactivate CROs and incorrectly classified firms
    const deactivatedFirms = []
    for (const firmName of CRO_AND_ASSOCIATIONS_TO_REMOVE) {
      const { data: existing } = await supabase
        .from('competitor_firms')
        .select('id, name')
        .ilike('name', firmName)
        .maybeSingle()

      if (existing) {
        const { error } = await supabase
          .from('competitor_firms')
          .update({ is_active: false })
          .eq('id', existing.id)

        if (!error) {
          deactivatedFirms.push(existing.name)
          console.log(`[CleanupCompetitorFirms] Deactivated: ${existing.name}`)
        }
      }
    }

    // Step 2: Upsert correct staffing firms
    let seeded = 0
    let skipped = 0
    const skippedFirms = []

    for (const firmName of STAFFING_FIRMS) {
      const { data: existing } = await supabase
        .from('competitor_firms')
        .select('id')
        .ilike('name', firmName)
        .maybeSingle()

      if (existing) {
        // Reactivate if it was deactivated
        await supabase
          .from('competitor_firms')
          .update({ is_active: true })
          .eq('id', existing.id)
        seeded++
        console.log(`[CleanupCompetitorFirms] Reactivated: ${firmName}`)
      } else {
        const { error } = await supabase
          .from('competitor_firms')
          .insert({ name: firmName, is_active: true })

        if (error) {
          skippedFirms.push({ name: firmName, reason: error.message })
          skipped++
          console.warn(`[CleanupCompetitorFirms] Failed to insert ${firmName}: ${error.message}`)
        } else {
          seeded++
          console.log(`[CleanupCompetitorFirms] Seeded: ${firmName}`)
        }
      }
    }

    console.log(`[CleanupCompetitorFirms] Complete — ${deactivatedFirms.length} deactivated, ${seeded} seeded, ${skipped} skipped`)

    return res.status(200).json({
      success: true,
      deactivated: deactivatedFirms.length,
      deactivatedFirms,
      seeded,
      skipped,
      skippedFirms,
      message: 'Competitor firms cleaned up and re-seeded'
    })
  } catch (err) {
    console.error('[CleanupCompetitorFirms] Error:', err)
    return res.status(500).json({
      success: false,
      error: err.message
    })
  }
}
