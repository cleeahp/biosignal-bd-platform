import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

/**
 * Normalize a company name for consistent storage and deduplication.
 *
 * - Trims whitespace
 * - Strips geographic qualifiers after a legal suffix + comma
 *   e.g. "Merck & Co., Inc., Rahway, NJ, USA" → "Merck & Co., Inc."
 * - Converts to title case, preserving short ALL-CAPS abbreviations (AG, NV, etc.)
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompanyName(name) {
  if (!name || typeof name !== 'string') return ''
  let n = name.trim()

  // Strip geographic qualifiers that follow a legal-entity suffix + comma
  // e.g. "Merck & Co., Inc., Rahway, NJ, USA" → "Merck & Co., Inc."
  n = n.replace(
    /\b(Inc\.?|Corp\.?|LLC|Ltd\.?|L\.L\.C\.?|PLC|GmbH|AG|NV|BV|SA|Pty),\s+.+$/i,
    (_, suffix) => suffix
  )
  n = n.trim().replace(/,\s*$/, '')

  // Title-case each word; preserve short ALL-CAPS abbreviations (≤3 chars like AG, NV, BV)
  // but title-case common legal suffixes (Inc, LLC, Ltd, etc.) for consistency
  const LEGAL_SUFFIXES = /^(Inc|Corp|Ltd|Llc|Llp|Lp|Plc)$/i
  n = n.replace(/\b[A-Za-z]+\b/g, (word) => {
    // Preserve short all-caps that are NOT legal suffixes (e.g. AG, NV, MD, CRO)
    if (word.length <= 3 && word === word.toUpperCase() && !LEGAL_SUFFIXES.test(word)) {
      return word
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  })

  return n
}

/**
 * Shared upsert for the companies table.
 *
 * Uses a manual check-then-insert pattern with no onConflict clause,
 * because the unique index is a functional expression index on lower(trim(name))
 * which Postgres ON CONFLICT (name) cannot match.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {{ name: string, [key: string]: any }} companyData
 * @returns {Promise<{id: string, name: string, relationship_warmth: string}|null>}
 */
export async function upsertCompany(supabaseClient, companyData) {
  try {
    const name = companyData.name?.trim()
    if (!name) return null

    const { data: existing } = await supabaseClient
      .from('companies')
      .select('id, name, relationship_warmth')
      .ilike('name', name)
      .maybeSingle()

    if (existing) return existing

    const { data: inserted, error } = await supabaseClient
      .from('companies')
      .insert({ ...companyData, name })
      .select('id, name, relationship_warmth')
      .maybeSingle()

    if (error) {
      const { data: retry } = await supabaseClient
        .from('companies')
        .select('id, name, relationship_warmth')
        .ilike('name', name)
        .maybeSingle()
      return retry
    }

    return inserted
  } catch (e) {
    return null
  }
}
