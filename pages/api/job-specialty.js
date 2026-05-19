import { supabase } from '../../lib/supabase.js'
import { cleanJobTitle } from '../../lib/specialtyMatcher.js'

const ALLOWED_TABLES = new Set(['clay_jobs', 'clay_jobs_competitors'])

export default async function handler(req, res) {
  if (req.method === 'PATCH') {
    const { job_id, table, specialty } = req.body || {}
    if (!job_id) return res.status(400).json({ error: 'job_id required' })
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'invalid table' })
    if (!Array.isArray(specialty)) return res.status(400).json({ error: 'specialty array required' })

    const { data: jobRow, error: lookupErr } = await supabase
      .from(table)
      .select('id, job_title')
      .eq('id', job_id)
      .maybeSingle()
    if (lookupErr) return res.status(500).json({ error: lookupErr.message })
    if (!jobRow) return res.status(404).json({ error: 'job not found' })

    const { error: updateErr } = await supabase
      .from(table)
      .update({ specialty })
      .eq('id', job_id)
    if (updateErr) return res.status(500).json({ error: updateErr.message })

    const titleKey = cleanJobTitle(jobRow.job_title).trim()
    if (titleKey) {
      const { error: upsertErr } = await supabase
        .from('job_title_overrides')
        .upsert(
          { job_title_lower: titleKey, specialty, updated_at: new Date().toISOString() },
          { onConflict: 'job_title_lower' }
        )
      if (upsertErr) {
        console.error(`[JobSpecialty] Override upsert error: ${upsertErr.message}`)
      }
    }

    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { job_id, table } = req.body || {}
    if (!job_id) return res.status(400).json({ error: 'job_id required' })
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'invalid table' })

    const { data: jobRow, error: lookupErr } = await supabase
      .from(table)
      .select('id, job_title')
      .eq('id', job_id)
      .maybeSingle()
    if (lookupErr) return res.status(500).json({ error: lookupErr.message })
    if (!jobRow) return res.status(404).json({ error: 'job not found' })

    const titleKey = cleanJobTitle(jobRow.job_title).trim()

    const { error: deleteErr } = await supabase
      .from(table)
      .delete()
      .eq('id', job_id)
    if (deleteErr) return res.status(500).json({ error: deleteErr.message })

    if (titleKey) {
      const { error: blockErr } = await supabase
        .from('blocked_job_titles')
        .upsert({ job_title_lower: titleKey }, { onConflict: 'job_title_lower', ignoreDuplicates: true })
      if (blockErr) {
        console.error(`[JobSpecialty] Block insert error: ${blockErr.message}`)
      }
    }

    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
