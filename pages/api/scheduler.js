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
    Authorization: `Bearer ${process.env.AGENT_SECRET_TOKEN}`,
  }

  // Delegate to the orchestrator, which runs all agents and post-processing
  try {
    const resp = await fetch(`${baseUrl}/api/agents/orchestrator`, { method: 'POST', headers })
    const result = await resp.json()
    return res.status(200).json({
      success: true,
      orchestrator: result,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() })
  }
}
