/**
 * lib/llmClientInference.js
 *
 * Batched LLM-based end-client inference for competitor job signals.
 * Uses Claude Haiku for cost efficiency. Best-effort — never blocks signal creation.
 *
 * Usage:
 *   const map = await batchInferClients(signals)
 *   // map: signal ID → predictions array
 */

import Anthropic from '@anthropic-ai/sdk'

const BATCH_SIZE = 10
const MODEL = 'claude-haiku-4-5-20251001'

/**
 * Infer end-client companies for a batch of competitor job signals via LLM.
 *
 * @param {Array<{ id: string, job_title: string, job_description: string, competitor_firm: string, job_location: string }>} signals
 * @returns {Promise<Map<string, Array<{ company: string, confidence: 'High'|'Medium'|'Low', reasoning: string }>>>}
 *   Map of signal ID → top-3 predictions. Returns empty map if API key not set or on error.
 */
export async function batchInferClients(signals) {
  if (!signals?.length) return new Map()

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[LLMInference] ANTHROPIC_API_KEY not set — skipping LLM client inference')
    return new Map()
  }

  const client = new Anthropic({ apiKey })
  const results = new Map()

  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    try {
      const jobsText = batch.map((sig, idx) => {
        // Strip competitor firm name from description before sending to LLM
        let desc = sig.job_description || ''
        if (sig.competitor_firm) {
          const escaped = sig.competitor_firm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          desc = desc.replace(new RegExp(escaped, 'gi'), '').replace(/\s+/g, ' ').trim()
        }
        return `${idx + 1}. ID: ${sig.id}
Title: ${sig.job_title}
Location: ${sig.job_location}
Description: ${desc}`
      }).join('\n\n---\n\n')

      const prompt = `You are an expert at identifying which pharmaceutical, biotech, or life sciences company is the actual end-client hiring through a staffing firm. For each job description below, predict the top 3 most likely end-client companies. Return ONLY valid JSON array with objects: {id, predictions: [{company, confidence: 'High'|'Medium'|'Low', reasoning: string}]}. Do not include the staffing firm as a prediction.

${jobsText}`

      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      })

      const responseText = message.content[0]?.text || ''

      // Extract JSON array — strip markdown code fences if present
      const jsonMatch = responseText.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.warn(`[LLMInference] Batch ${batchNum}: could not extract JSON from response`)
        continue
      }

      const parsed = JSON.parse(jsonMatch[0])
      let batchHits = 0
      for (const item of parsed) {
        if (item.id && Array.isArray(item.predictions) && item.predictions.length > 0) {
          results.set(item.id, item.predictions)
          batchHits++
        }
      }
      console.log(`[LLMInference] Batch ${batchNum}: ${batchHits}/${batch.length} signals inferred`)
    } catch (err) {
      console.warn(`[LLMInference] Batch ${batchNum} failed: ${err.message}`)
      // Continue with next batch — best-effort, never fatal
    }
  }

  return results
}
