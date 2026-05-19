const CLAY_WEBHOOK_URL = 'https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-cb7f3cdd-47e8-47a0-9350-82c0868ccfab'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const linkedin_url = body.linkedin_url ? String(body.linkedin_url).trim() : ''

  if (!linkedin_url) {
    return res.status(400).json({ success: false, error: 'linkedin_url required' })
  }
  if (!/linkedin\.com\/company\//i.test(linkedin_url)) {
    return res.status(400).json({ success: false, error: 'Must be a LinkedIn company URL' })
  }

  try {
    const response = await fetch(CLAY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'Company LinkedIn URL': linkedin_url }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[SubmitCompany] Clay error ${response.status}: ${text}`)
      return res.status(502).json({ success: false, error: `Clay returned ${response.status}` })
    }

    console.log(`[SubmitCompany] Sent to Clay: ${linkedin_url}`)
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error(`[SubmitCompany] Fetch error: ${err.message}`)
    return res.status(500).json({ success: false, error: err.message })
  }
}
