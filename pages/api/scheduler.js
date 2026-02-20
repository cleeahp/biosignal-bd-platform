export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.AGENT_SECRET_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.AGENT_SECRET_TOKEN}`
  }

  const results = {}

  // Run Stale Job Tracker
  try {
    const res1 = await fetch(`${baseUrl}/api/agents/stale-job-tracker`, { method: 'POST', headers })
    results.staleJobTracker = await res1.json()
  } catch (err) {
    results.staleJobTracker = { error: err.message }
  }

  return res.status(200).json({ success: true, results, timestamp: new Date().toISOString() })
}
