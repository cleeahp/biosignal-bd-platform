import { supabase } from '../../lib/supabase.js'

// Mirrors the admin entries in USER_ROLES (pages/index.js) — keep in sync.
const ADMIN_EMAILS = new Set(['clee@argosyhp.com', 'gmayer@argosyhp.com'])

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  const email = userData?.user?.email ? userData.user.email.toLowerCase() : ''
  if (userErr || !email) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!ADMIN_EMAILS.has(email)) {
    return res.status(403).json({ error: 'Forbidden — admin only' })
  }

  const { id, is_target } = req.body || {}
  if (!id) {
    return res.status(400).json({ error: 'id required' })
  }
  if (typeof is_target !== 'boolean') {
    return res.status(400).json({ error: 'is_target must be a boolean' })
  }

  const { data: row, error: fetchErr } = await supabase
    .from('targets_companies')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!row) return res.status(404).json({ error: 'Target company not found' })

  const { error: updateErr } = await supabase
    .from('targets_companies')
    .update({ is_target })
    .eq('id', id)

  if (updateErr) {
    console.error(`[TargetsStar] Update error: ${updateErr.message}`)
    return res.status(500).json({ error: updateErr.message })
  }

  const responseData = { success: true, id, is_target }
  const sizeMB = (Buffer.byteLength(JSON.stringify(responseData), 'utf8') / (1024 * 1024)).toFixed(2)
  console.log(`[API] ${req.url}: ${sizeMB} MB (1 row)`)
  return res.status(200).json(responseData)
}
