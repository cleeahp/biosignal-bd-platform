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

function extractMaTarget(text, filerName) {
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
  const filerPrefix = filerName.toLowerCase().slice(0, 10)
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ').replace(/\s*(Inc\.|Corp\.|LLC|Ltd\.).*$/, '$1').trim()
      if (name.length >= 3 && name.length <= 80 && !name.toLowerCase().startsWith(filerPrefix)) {
        return name
      }
    }
  }
  return ''
}

function extractMergerParent(text, filerName) {
  if (!text) return ''
  const filerPrefix = filerName.toLowerCase().slice(0, 10)
  const patterns = [
    /([A-Z][A-Za-z0-9\s,\.&\-]+?)\s*\(["']?(?:the\s+)?["']?Parent["']?\)/,
    /by\s+and\s+among\s+the\s+Company,?\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,\s*and\s+[A-Z][a-z]|\s+and\s+[A-Z][a-z]|\.)/,
    /([A-Z][A-Za-z0-9\s,\.&\-]+?),?\s+(?:and\s+)?[A-Z][a-z]+\s+Sub.{0,50}merger\s+of\s+Merger\s+Sub/i,
    /Agreement\s+and\s+Plan\s+of\s+Merger.{0,300}(?:\bwith\b|by\s+and\s+among.{0,100}and)\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/,
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 80)
      if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix)) return name
    }
  }
  return ''
}

function extractProductSeller(text, filerName) {
  if (!text) return ''
  const filerPrefix = filerName.toLowerCase().slice(0, 10)
  const patterns = [
    /([A-Z][A-Za-z0-9\s,\.&\-]+?)\s*\(["']?(?:the\s+)?["']?Seller["']?\)/,
    /acquiring.{0,300}rights?\s+to.{0,200}from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    /rights?\s+to\s+\S+.{0,150}from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
    /(?:purchased?|acquired?)\s+from\s+([A-Z][A-Za-z0-9\s,\.&\-]+?)(?:\s*\(|\s*,|\.)/i,
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 80)
      if (name.length >= 3 && !name.toLowerCase().startsWith(filerPrefix)) return name
    }
  }
  return ''
}

function extractDrugAsset(text) {
  if (!text) return null
  const contextPatterns = [
    /acquiring.{0,200}rights?\s+to\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    /rights?\s+to\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    /\(formerly\s+([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\)/,
    /(?:product\s+candidate|compound|molecule|drug|asset|program|therapy)\s+(?:known\s+as\s+)?([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5})\b/,
    /([A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5}).{0,60}from\s+[A-Z][a-z]/,
  ]
  for (const pat of contextPatterns) {
    const m = text.match(pat)
    if (m?.[1]) return m[1]
  }
  return null
}

function classifyTransactionType(text) {
  if (!text) return 'acquisition'
  const lower = text.toLowerCase()
  const scores = { merger: 0, product_acquisition: 0, acquisition: 0, ipo: 0, partnership: 0 }

  if (/agreement and plan of merger/.test(lower)) scores.merger += 6
  if (/merger of merger sub with and into/.test(lower)) scores.merger += 5
  if (/\(["']?(?:the\s+)?["']?parent["']?\)/.test(lower)) scores.merger += 4
  if (/merger agreement/.test(lower)) scores.merger += 3
  if (/merger consideration/.test(lower)) scores.merger += 3
  if (/merger of equals/.test(lower)) scores.merger += 4
  if (/combined company/.test(lower)) scores.merger += 2
  if (/surviving corporation/.test(lower)) scores.merger += 2

  const hasCompoundName = /\b[A-Z]{2,6}[-]?\d{2,}[A-Z]{0,5}\b/.test(text)
  if (/acquir\w*\s+\w*\s*rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 6
  if (/global\s+rights?\s+to\b/i.test(text) && hasCompoundName) scores.product_acquisition += 5
  if (/asset\s+purchase\s+agreement/.test(lower) && hasCompoundName) scores.product_acquisition += 5
  if (/sold\s+all\s+or\s+substantially\s+all\s+of\s+its\s+right\s+title/.test(lower)) scores.product_acquisition += 5
  if (/exclusive.{0,80}rights?.{0,80}from\s+[A-Z]/i.test(text) && hasCompoundName) scores.product_acquisition += 4
  if (/\bseller\b/.test(lower) && hasCompoundName) scores.product_acquisition += 3

  if (/asset\s+purchase\s+agreement/.test(lower) && !hasCompoundName) scores.acquisition += 4
  if (/\btender\s+offer\b/.test(lower)) scores.acquisition += 4
  if (/purchase\s+all\s+outstanding\s+shares/.test(lower)) scores.acquisition += 4
  if (/stock\s+purchase\s+agreement/.test(lower)) scores.acquisition += 4
  if (/definitive\s+agreement/.test(lower) && /\bacquire\b/.test(lower)) scores.acquisition += 4
  if (/purchase\s+agreement/.test(lower) && /\b(company|stock)\b/.test(lower)) scores.acquisition += 3
  if (/all\s+or\s+substantially\s+all/.test(lower)) scores.acquisition += 2
  if (/\bacquired\b|\bacquisition\b/.test(lower)) scores.acquisition += 2

  if (/initial\s+public\s+offering/.test(lower)) scores.ipo += 5
  if (/underwriting\s+agreement/.test(lower)) scores.ipo += 4
  if (/public\s+offering/.test(lower)) scores.ipo += 3
  if (/shares\s+of\s+common\s+stock/.test(lower) && /offering\s+price/.test(lower)) scores.ipo += 3
  if (/pre-funded\s+warrants/.test(lower) && /offering/.test(lower)) scores.ipo += 3
  if (/registered\s+direct\s+offering/.test(lower)) scores.ipo += 3
  if (/follow-on\s+offering|secondary\s+offering/.test(lower)) scores.ipo += 2
  if (/\bipo\b/.test(lower)) scores.ipo += 2

  if (/collaboration\s+agreement/.test(lower)) scores.partnership += 4
  if (/license\s+agreement/.test(lower)) scores.partnership += 4
  if (/exclusive\s+license/.test(lower)) scores.partnership += 4
  if (/licensing\s+agreement|co-promotion|research\s+collaboration/.test(lower)) scores.partnership += 3
  if (/\bco-develop/.test(lower)) scores.partnership += 3
  if (/strategic\s+partnership/.test(lower)) scores.partnership += 2
  if (/\broyalt/.test(lower)) scores.partnership += 2

  const maxScore = Math.max(...Object.values(scores))
  if (maxScore === 0) return 'acquisition'
  return Object.entries(scores).find(([, s]) => s === maxScore)?.[0] || 'acquisition'
}

function extractDealDetails(text, filerName) {
  const transaction_type = classifyTransactionType(text)
  const deal_value       = extractAmount(text)

  let acquirer_name, acquired_name, acquired_asset = null

  if (transaction_type === 'merger') {
    const parent = extractMergerParent(text, filerName)
    if (parent) {
      acquirer_name = parent
      acquired_name = filerName
    } else {
      acquirer_name = filerName
      acquired_name = extractMaTarget(text, filerName)
    }
    acquired_asset = extractDrugAsset(text)
  } else if (transaction_type === 'product_acquisition') {
    acquirer_name = filerName
    acquired_name = extractProductSeller(text, filerName)
    acquired_asset = extractDrugAsset(text)
  } else if (transaction_type === 'acquisition') {
    acquirer_name = filerName
    acquired_name = extractMaTarget(text, filerName)
    acquired_asset = extractDrugAsset(text)
  } else if (transaction_type === 'partnership') {
    acquirer_name = filerName
    acquired_name = extractMaTarget(text, filerName) || extractProductSeller(text, filerName)
    acquired_asset = extractDrugAsset(text)
  } else {
    acquirer_name = filerName
    acquired_name = ''
  }

  let deal_summary
  if (transaction_type === 'ipo') {
    deal_summary = `${filerName} announced a public offering${deal_value ? ` valued at ${deal_value}` : ''}.`
  } else if (transaction_type === 'merger') {
    if (acquirer_name !== filerName && acquired_name === filerName) {
      deal_summary = `${acquirer_name} is acquiring ${filerName}${deal_value ? ` for ${deal_value}` : ''}.`
    } else {
      deal_summary = `${filerName} announced a merger${acquired_name ? ` with ${acquired_name}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`
    }
  } else if (transaction_type === 'product_acquisition') {
    deal_summary = `${filerName} is acquiring ${acquired_asset || 'product rights'}${acquired_name ? ` from ${acquired_name}` : ''}${deal_value ? ` for ${deal_value}` : ''}.`
  } else if (transaction_type === 'partnership') {
    deal_summary = `${filerName} announced a licensing/collaboration agreement${acquired_name ? ` with ${acquired_name}` : ''}${deal_value ? ` valued at ${deal_value}` : ''}.`
  } else {
    deal_summary = `${filerName} is acquiring ${acquired_name || 'a company'}${deal_value ? ` for ${deal_value}` : ''}.`
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
    acquirer_name,
    acquired_name,
    acquired_asset,
    deal_value,
    deal_summary,
    filing_text_snippet,
    enrichment_source: 'sec_8k_filing',
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

        // Merge enriched fields; always overwrite classification fields from 8-K parse
        const updatedDetail = {
          ...d,
          transaction_type:    details.transaction_type,
          acquirer_name:       details.acquirer_name       || d.acquirer_name || filerName,
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
