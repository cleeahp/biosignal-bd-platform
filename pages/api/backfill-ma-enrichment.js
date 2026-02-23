/**
 * Backfill endpoint: re-enriches existing ma_transaction signals with
 * 8-K filing text parsed from SEC EDGAR.
 *
 * Processes up to 10 signals per call where enrichment_source != 'sec_8k_filing'.
 * Extracts transaction_type, acquired_name, acquired_asset, deal_value,
 * deal_summary, and filing_text_snippet from the actual 8-K document.
 *
 * Usage: GET or POST /api/backfill-ma-enrichment
 * Returns: { enriched: N, total: N, errors: N, message: "..." }
 */

import { supabase } from '../../lib/supabase.js'

const SEC_UA      = 'BioSignal-BD-Platform contact@biosignal.io'
const DELAY_MS    = 2000
const MAX_PER_RUN = 10

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Utility functions (self-contained copies) ─────────────────────────────────

function extractAmount(text) {
  if (!text) return null
  const patterns = [
    /\$\s*([\d,]+(?:\.\d+)?)\s*billion/i,
    /\$\s*([\d,]+(?:\.\d+)?)\s*million/i,
    /([\d,]+(?:\.\d+)?)\s*billion\s+(?:USD|dollars)/i,
    /([\d,]+(?:\.\d+)?)\s*million\s+(?:USD|dollars)/i,
    /approximately\s+\$\s*([\d,]+(?:\.\d+)?)\s*(billion|million)/i,
    /aggregate\s+(?:consideration|value|purchase price)\s+of\s+\$\s*([\d,]+(?:\.\d+)?)\s*(billion|million)/i,
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      const num  = m[1].replace(/,/g, '')
      const unit = (m[2] || (pat.source.includes('billion') ? 'billion' : 'million')).toLowerCase()
      return `$${num} ${unit}`
    }
  }
  return null
}

function extractMaTarget(text, acquirerName) {
  if (!text) return ''
  const patterns = [
    /definitive\s+agreement\s+to\s+acqui(?:re|red)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    /agreed\s+to\s+acqui(?:re|red)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    /to\s+acqui(?:re|red|ring)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s+in\s+a|\s*\(|\.)/,
    /(?:has|will)\s+acqui(?:re|red|ring)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/,
    /acquisition\s+of\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    /merger\s+agreement\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    /merger\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
    /combination\s+with\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*,|\s+for\s|\s*\(|\.|$)/i,
  ]
  const acquirerPrefix = acquirerName.toLowerCase().slice(0, 10)
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ').replace(/\s*(Inc\.|Corp\.|LLC|Ltd\.).*$/, '$1').trim()
      if (name.length >= 3 && name.length <= 80 && !name.toLowerCase().startsWith(acquirerPrefix)) {
        return name
      }
    }
  }
  return ''
}

function classifyTransactionType(text) {
  if (!text) return 'acquisition'
  const lower = text.toLowerCase()
  const scores = { ipo: 0, acquisition: 0, merger: 0, partnership: 0 }

  if (/public offering/.test(lower)) scores.ipo += 3
  if (/underwriting agreement/.test(lower)) scores.ipo += 3
  if (/initial public offering/.test(lower)) scores.ipo += 4
  if (/\bipo\b/.test(lower)) scores.ipo += 2
  if (/shares of common stock/.test(lower) && /offering price/.test(lower)) scores.ipo += 3
  if (/pre-funded warrants/.test(lower) && /offering/.test(lower)) scores.ipo += 3
  if (/registered direct offering/.test(lower)) scores.ipo += 3
  if (/follow-on offering|secondary offering/.test(lower)) scores.ipo += 2
  if (/priced its.*offering|filed.*s-1/.test(lower)) scores.ipo += 2

  if (/asset purchase agreement/.test(lower)) scores.acquisition += 4
  if (/\bacquired\b|\bacquisition\b/.test(lower)) scores.acquisition += 2
  if (/purchase agreement/.test(lower) && /\b(assets|company|stock)\b/.test(lower)) scores.acquisition += 3
  if (/\btender offer\b/.test(lower)) scores.acquisition += 3
  if (/all or substantially all/.test(lower)) scores.acquisition += 2
  if (/definitive agreement/.test(lower) && /\bacquire\b/.test(lower)) scores.acquisition += 4

  if (/agreement and plan of merger/.test(lower)) scores.merger += 5
  if (/merger agreement/.test(lower) && /\bmerger\b/.test(lower)) scores.merger += 3
  if (/combined company/.test(lower)) scores.merger += 2
  if (/merger consideration/.test(lower)) scores.merger += 3
  if (/merger of equals/.test(lower)) scores.merger += 4
  if (/surviving corporation/.test(lower)) scores.merger += 2

  if (/license agreement/.test(lower)) scores.partnership += 4
  if (/collaboration agreement/.test(lower)) scores.partnership += 4
  if (/exclusive license/.test(lower)) scores.partnership += 4
  if (/\bco-develop/.test(lower)) scores.partnership += 3
  if (/\broyalt/.test(lower)) scores.partnership += 2
  if (/licensing agreement|co-promotion|research collaboration/.test(lower)) scores.partnership += 3
  if (/strategic partnership/.test(lower)) scores.partnership += 2

  const maxScore = Math.max(scores.ipo, scores.acquisition, scores.merger, scores.partnership)
  if (maxScore === 0) return 'acquisition'
  return Object.entries(scores).find(([, s]) => s === maxScore)?.[0] || 'acquisition'
}

function extractDealDetails(text, filerName) {
  const transaction_type = classifyTransactionType(text)
  const acquired_name    = extractMaTarget(text, filerName)
  const deal_value       = extractAmount(text)

  let acquired_asset = null
  const assetPatterns = [
    /(?:compound\s+known\s+as|drug\s+known\s+as|product\s+candidate|lead\s+candidate|molecule|therapy|asset)\s+([A-Z]{2,4}-\d{3,}[A-Z]?)\b/,
    /(?:acqui(?:re|red|sition)|license|collaboration).{0,60}\b([A-Z]{2,4}-\d{3,}[A-Z]?)\b/,
    /(?:compound\s+known\s+as|drug\s+known\s+as|product\s+candidate|asset)\s+([A-Z]{2,4}\d{3,}[A-Z]?)\b/,
  ]
  for (const pat of assetPatterns) {
    const m = text?.match(pat)
    if (m?.[1]) { acquired_asset = m[1]; break }
  }

  const counterparty = acquired_name
  let deal_summary
  if (transaction_type === 'ipo') {
    deal_summary = `${filerName} announced a public offering${deal_value ? ` valued at ${deal_value}` : ''}.`
  } else if (transaction_type === 'merger') {
    deal_summary = `${filerName} announced a merger${counterparty ? ` with ${counterparty}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`
  } else if (transaction_type === 'partnership') {
    deal_summary = `${filerName} announced a licensing/collaboration agreement${counterparty ? ` with ${counterparty}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`
  } else {
    deal_summary = `${filerName} announced an acquisition${counterparty ? ` of ${counterparty}` : ''}${acquired_asset ? ` (${acquired_asset})` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`
  }

  let filing_text_snippet = null
  if (text) {
    const DEAL_PARA_RE = /acqui|merger|licen|collaborat|offering|agreement/i
    const paragraphs = text.split(/\s{2,}/).filter((p) => p.trim().length > 50)
    const relevantPara = paragraphs.find((p) => DEAL_PARA_RE.test(p)) || paragraphs[0] || ''
    filing_text_snippet = relevantPara.trim().slice(0, 500) || null
  }

  return {
    transaction_type,
    acquirer_name:       filerName,
    acquired_name,
    acquired_asset,
    deal_value,
    deal_summary,
    filing_text_snippet,
    enrichment_source:   'sec_8k_filing',
  }
}

// ── SEC EDGAR filing text fetcher ─────────────────────────────────────────────

/**
 * Fetch plain text from an 8-K filing stored in SEC EDGAR.
 * Derives CIK and accession number from the stored filing_url.
 * filing_url format: https://www.sec.gov/Archives/edgar/data/{cik}/{adshNoDash}/
 *
 * @param {string} filingUrl
 * @param {string} adsh - accession number with dashes (from signal_detail.adsh)
 * @returns {Promise<string>} Up to 4 KB of plain text, or '' on failure
 */
async function fetchFilingText(filingUrl, adsh) {
  // Extract CIK from filing URL
  const urlMatch = (filingUrl || '').match(/edgar\/data\/(\d+)\//)
  if (!urlMatch) return ''
  const cik = urlMatch[1]

  const adshForUrl = adsh || ''
  if (!adshForUrl) return ''

  const adshNoDash = adshForUrl.replace(/-/g, '')
  const indexUrl   = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDash}/${adshForUrl}-index.json`

  try {
    await sleep(DELAY_MS)
    const indexResp = await fetch(indexUrl, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!indexResp.ok) return ''

    const index = await indexResp.json()
    const primaryDoc = (index.documents || []).find((d) => d.type === '8-K') || (index.documents || [])[0]
    if (!primaryDoc?.document) return ''

    await sleep(DELAY_MS)
    const docUrl  = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDash}/${primaryDoc.document}`
    const docResp = await fetch(docUrl, {
      headers: { 'User-Agent': SEC_UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!docResp.ok) return ''

    const raw = await docResp.text()
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000)
  } catch {
    return ''
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Fetch up to MAX_PER_RUN signals that lack 8-K enrichment
    const { data: signals, error } = await supabase
      .from('signals')
      .select('id, signal_detail')
      .eq('signal_type', 'ma_transaction')
      .not('signal_detail->>filing_url', 'is', null)  // must have a filing URL
      .neq('signal_detail->>enrichment_source', 'sec_8k_filing')
      .limit(MAX_PER_RUN)

    if (error) throw error

    if (!signals || signals.length === 0) {
      return res.status(200).json({
        enriched: 0,
        total:    0,
        errors:   0,
        message:  'No signals require 8-K enrichment',
      })
    }

    let enriched = 0
    let errors   = 0

    for (const signal of signals) {
      const d          = signal.signal_detail || {}
      const filingUrl  = d.filing_url || d.source_url || ''
      const adsh       = d.adsh || ''
      const filerName  = d.acquirer_name || d.company_name || ''

      if (!filingUrl || !adsh || !filerName) {
        console.log(`[backfill-ma] Skipping signal ${signal.id}: missing filing_url/adsh/filerName`)
        continue
      }

      try {
        const text    = await fetchFilingText(filingUrl, adsh)
        const details = extractDealDetails(text, filerName)

        // Merge enriched fields into existing signal_detail (preserve existing values)
        const updatedDetail = {
          ...d,
          transaction_type:    details.transaction_type    || d.transaction_type,
          acquired_name:       details.acquired_name       || d.acquired_name || '',
          acquired_asset:      details.acquired_asset      || d.acquired_asset || null,
          deal_value:          details.deal_value          || d.deal_value     || null,
          deal_summary:        details.deal_summary        || d.deal_summary   || '',
          filing_text_snippet: details.filing_text_snippet || d.filing_text_snippet || null,
          enrichment_source:   'sec_8k_filing',
        }

        const { error: updateErr } = await supabase
          .from('signals')
          .update({ signal_detail: updatedDetail })
          .eq('id', signal.id)

        if (updateErr) {
          console.error(`[backfill-ma] Update failed for signal ${signal.id}:`, updateErr.message)
          errors++
        } else {
          console.log(`[backfill-ma] Enriched signal ${signal.id} [${filerName}]: type=${details.transaction_type}, asset=${details.acquired_asset || 'none'}`)
          enriched++
        }
      } catch (err) {
        console.error(`[backfill-ma] Error processing signal ${signal.id}:`, err.message)
        errors++
      }
    }

    return res.status(200).json({
      enriched,
      total:   signals.length,
      errors,
      message: `Enriched ${enriched}/${signals.length} signals from SEC 8-K filings (${errors} errors)`,
    })
  } catch (err) {
    console.error('[backfill-ma] Handler error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
