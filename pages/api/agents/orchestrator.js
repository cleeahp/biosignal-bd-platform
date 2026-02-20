import { runOrchestrator } from '../../../agents/orchestrator.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.AGENT_SECRET_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const result = await runOrchestrator()
    return res.status(200).json(result)
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}
