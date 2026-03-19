/**
 * Refresh LinkedIn current title and company for all past buyers and past candidates.
 *
 * For each contact, searches LinkedIn people search by name + current company,
 * parses the first matching result, and updates the five LinkedIn columns.
 *
 * Run:
 *   node scripts/refreshContactsLinkedIn.js
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINKEDIN_LI_AT
 */

import { createClient } from '@supabase/supabase-js'
import * as cheerio from 'cheerio'
import { createLinkedInClient } from '../lib/linkedinClient.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const TABLES = ['past_buyers', 'past_candidates']
const REQUEST_BUDGET = 100

/**
 * Search LinkedIn people search and return {title, company} for the first
 * result that matches the contact's first and last name.
 * Returns null if not found or client is stopped.
 *
 * @param {import('../lib/linkedinClient.js').LinkedInClient} client
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} company
 * @returns {Promise<{title:string, company:string}|null>}
 */
async function searchPerson(client, firstName, lastName, company) {
  if (!client.isAvailable) return null

  const keywords = `${firstName} ${lastName} ${company || ''}`.trim()
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`

  const resp = await client.get(url, 'search')
  if (!resp?.ok) return null

  let html = ''
  try {
    html = await resp.text()
  } catch (err) {
    console.log(`[Contacts] Failed to read response for ${firstName} ${lastName}: ${err.message}`)
    return null
  }

  let $
  try {
    $ = cheerio.load(html)
  } catch (err) {
    return null
  }

  const firstLower = firstName.toLowerCase()
  const lastLower  = lastName.toLowerCase()

  let match = null
  $('.entity-result__content').each((_, el) => {
    if (match) return
    const $el      = $(el)
    const nameText = $el.find('.entity-result__title-text').text().trim().toLowerCase()
    if (nameText.includes(firstLower) && nameText.includes(lastLower)) {
      const title   = $el.find('.entity-result__primary-subtitle').text().trim()
      const company = $el.find('.entity-result__secondary-subtitle').text().trim()
      match = { title, company }
    }
  })

  return match
}

async function main() {
  const client = createLinkedInClient(REQUEST_BUDGET)
  if (!client) {
    console.error('[Contacts] LINKEDIN_LI_AT not set — aborting')
    process.exit(1)
  }

  let totalChecked    = 0
  let totalFound      = 0
  let totalNotFound   = 0
  let titleChanges    = 0
  let companyChanges  = 0

  for (const table of TABLES) {
    const { data: contacts, error } = await supabase
      .from(table)
      .select('id, first_name, last_name, title, company')

    if (error) {
      console.error(`[Contacts] Failed to load ${table}: ${error.message}`)
      continue
    }

    console.log(`\n[Contacts] Processing ${contacts.length} contacts from ${table}`)

    for (const contact of contacts) {
      if (!client.isAvailable) {
        console.log('[Contacts] LinkedIn client stopped — halting early')
        break
      }

      const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
      totalChecked++

      const result = await searchPerson(
        client,
        contact.first_name || '',
        contact.last_name  || '',
        contact.company    || '',
      )

      const now = new Date().toISOString()

      if (!result || (!result.title && !result.company)) {
        console.log(`[Contacts] NOT FOUND: ${fullName}`)
        totalNotFound++
        await supabase.from(table).update({ linkedin_last_checked: now }).eq('id', contact.id)
        continue
      }

      totalFound++

      const linkedinTitle   = result.title   || null
      const linkedinCompany = result.company || null

      const titleChanged   = linkedinTitle   ? linkedinTitle.toLowerCase()   !== (contact.title   || '').toLowerCase() : false
      const companyChanged = linkedinCompany ? linkedinCompany.toLowerCase() !== (contact.company || '').toLowerCase() : false

      if (titleChanged)   titleChanges++
      if (companyChanged) companyChanges++

      const { error: updateErr } = await supabase.from(table).update({
        linkedin_current_title:   linkedinTitle,
        linkedin_current_company: linkedinCompany,
        linkedin_last_checked:    now,
        title_changed:            titleChanged,
        company_changed:          companyChanged,
      }).eq('id', contact.id)

      if (updateErr) {
        console.error(`[Contacts] Update failed for ${fullName}: ${updateErr.message}`)
      } else {
        const changes = []
        if (titleChanged)   changes.push(`title: "${contact.title}" → "${linkedinTitle}"`)
        if (companyChanged) changes.push(`company: "${contact.company}" → "${linkedinCompany}"`)
        const suffix = changes.length ? ` [CHANGED: ${changes.join(', ')}]` : ''
        console.log(`[Contacts] Updated: ${fullName}${suffix}`)
      }
    }

    if (!client.isAvailable) break
  }

  console.log(`
[Contacts] ── Summary ──────────────────────────
  Total checked:          ${totalChecked}
  Found:                  ${totalFound}
  Not found:              ${totalNotFound}
  Title changes:          ${titleChanges}
  Company changes:        ${companyChanges}
  LinkedIn requests used: ${client.requestsUsed}
`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
