import { supabase } from '../lib/supabase.js'
import * as cheerio from 'cheerio'

const SEED_COMPETITORS = [
  { name: 'Medpace', careers_url: 'https://www.medpace.com/careers/' },
  { name: 'Syneos Health', careers_url: 'https://syneoshealth.com/careers' },
  { name: 'Fortrea', careers_url: 'https://careers.fortrea.com' },
  // Correct domain — hallorangroup.com is an unrelated real-estate company
  { name: 'Halloran Consulting', careers_url: 'https://www.halloran-consulting.com/careers' },
  { name: 'Premier Research', careers_url: 'https://premierresearch.com/careers' },
  { name: 'Worldwide Clinical Trials', careers_url: 'https://worldwideclinicaltrials.com/careers' },
]

const LIFE_SCIENCES_KEYWORDS = [
  'clinical research associate', 'CRA', 'clinical research coordinator', 'CRC',
  'clinical trial manager', 'regulatory affairs', 'quality assurance', 'QA',
  'biostatistician', 'data manager', 'clinical data manager', 'pharmacovigilance',
  'drug safety', 'medical monitor', 'clinical operations', 'site monitor',
  'study coordinator', 'medical affairs', 'validation engineer', 'CMC',
]

const CLIENT_EXTRACTION_PATTERNS = [
  /(?:client|sponsor|company|our partner|client company)[:\s]+([A-Z][A-Za-z\s&,\.]+?)(?:\.|,|\n|$)/i,
  /(?:supporting|working with|partnering with)\s+([A-Z][A-Za-z\s&]+?)(?:\s+to|\s+in|\.|,|$)/i,
  /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,4})\s+(?:is hiring|seeks|is looking)/i,
]

const WARMTH_SCORES = { active_client: 25, past_client: 18, in_ats: 10, new_prospect: 0 }

function isLifeSciencesJob(title, description = '') {
  const text = `${title} ${description}`.toLowerCase()
  return LIFE_SCIENCES_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))
}

function extractClientCompany(description) {
  for (const pattern of CLIENT_EXTRACTION_PATTERNS) {
    const match = description.match(pattern)
    if (match) {
      const name = match[1].trim()
      if (name.length > 3 && name.length < 100) return name
    }
  }
  return null
}

async function upsertCompany(name) {
  if (!name || name.trim().length < 2) return null
  const cleanName = name.trim()

  const { data: existing } = await supabase
    .from('companies')
    .select('id, relationship_warmth')
    .ilike('name', cleanName)
    .maybeSingle()

  if (existing) return existing

  const { data: newCompany, error } = await supabase
    .from('companies')
    .insert({
      name: cleanName,
      industry: 'Life Sciences',
      relationship_warmth: 'new_prospect',
    })
    .select('id, relationship_warmth')
    .single()

  if (error) {
    console.warn(`Failed to insert company "${cleanName}": ${error.message}`)
    return null
  }

  return newCompany
}

async function signalExists(companyId, signalType, sourceUrl) {
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('signal_type', signalType)
    .eq('source_url', sourceUrl)
    .maybeSingle()
  return !!data
}

async function seedCompetitorFirms() {
  console.log('Seeding competitor firms table...')
  for (const firm of SEED_COMPETITORS) {
    const { data: existing } = await supabase
      .from('competitor_firms')
      .select('id')
      .ilike('name', firm.name)
      .maybeSingle()

    if (!existing) {
      const { error } = await supabase.from('competitor_firms').insert({
        name: firm.name,
        careers_url: firm.careers_url,
        is_active: true,
      })
      if (error) console.warn(`Failed to seed ${firm.name}: ${error.message}`)
      else console.log(`Seeded competitor: ${firm.name}`)
    } else {
      // Update URL in case the stored URL is stale (e.g. old Halloran domain)
      await supabase
        .from('competitor_firms')
        .update({ careers_url: firm.careers_url })
        .eq('id', existing.id)
    }
  }
}

async function scrapeJobListings(firm) {
  const jobs = []
  try {
    const resp = await fetch(firm.careers_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) {
      console.warn(`Failed to fetch ${firm.careers_url}: HTTP ${resp.status}`)
      return jobs
    }

    const html = await resp.text()
    const $ = cheerio.load(html)

    // Try structured selectors — do NOT break early; accumulate from all selectors
    // so that more specific selectors can add to results from broader ones.
    const selectors = [
      '.job-title a',
      '.position-title a',
      '[class*="job-title"] a',
      '[class*="jobtitle"] a',
      '[class*="position"] a',
      'a[href*="/jobs/"]',
      'a[href*="job"]',
      'a[href*="career"]',
      'a[href*="position"]',
      'a[href*="opening"]',
      '[class*="job"] a',
      '[class*="career"] a',
      'li a',
    ]

    const seen = new Set()

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const $el = $(el)
        const title = $el.text().trim()
        let href = $el.attr('href') || ''

        if (!title || title.length < 5 || title.length > 200) return
        if (!isLifeSciencesJob(title)) return
        if (seen.has(title.toLowerCase())) return

        // Resolve relative URLs
        if (href.startsWith('/')) {
          const base = new URL(firm.careers_url)
          href = `${base.protocol}//${base.host}${href}`
        } else if (!href.startsWith('http')) {
          href = firm.careers_url
        }

        seen.add(title.toLowerCase())
        jobs.push({ title, url: href, description: '' })
      })
    }

    // If structured selectors found nothing, fall back to body-text line scanning.
    // This handles WordPress/static pages that embed job category text in marketing copy.
    if (jobs.length === 0) {
      const bodyText = $('body').text()
      const lines = bodyText.split('\n').map((l) => l.trim()).filter((l) => l.length > 5)
      for (const line of lines) {
        if (isLifeSciencesJob(line) && line.length < 150) {
          if (!seen.has(line.toLowerCase())) {
            seen.add(line.toLowerCase())
            jobs.push({ title: line, url: firm.careers_url, description: '' })
          }
          if (jobs.length >= 20) break
        }
      }
    }
  } catch (err) {
    console.warn(`Scrape failed for ${firm.name}: ${err.message}`)
  }

  return jobs.slice(0, 50) // cap per firm
}

export async function runCompetitorJobBoardAgent() {
  let signalsFound = 0

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'competitor_job_board_agent', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    // Always re-seed so corrected URLs propagate to the DB
    await seedCompetitorFirms()

    // Fetch all active competitor firms
    const { data: firms, error: firmsError } = await supabase
      .from('competitor_firms')
      .select('id, name, careers_url')
      .eq('is_active', true)

    if (firmsError) throw new Error(`Failed to fetch competitor firms: ${firmsError.message}`)
    if (!firms || firms.length === 0) {
      throw new Error('No active competitor firms found after seeding')
    }

    console.log(`Competitor Job Board: scanning ${firms.length} firms`)
    const today = new Date().toISOString().split('T')[0]

    for (const firm of firms) {
      const jobs = await scrapeJobListings(firm)
      console.log(`${firm.name}: found ${jobs.length} Life Sciences job references`)

      // ─── Primary signal: competitor firm hiring activity ───────────────────
      // Emit one aggregated signal per firm per day whenever Life Sciences jobs
      // are found.  Using the competitor firm itself as the tracked company means
      // we always surface competitor-activity signals without needing to identify
      // an end-client from the job description (which is rarely present).
      if (jobs.length > 0) {
        const firmCompany = await upsertCompany(firm.name)
        if (firmCompany) {
          // Deduplicate by firm + date so we emit at most one signal per firm/day
          const dailyKey = `${firm.careers_url}#${today}`
          const alreadySignaled = await signalExists(
            firmCompany.id,
            'competitor_job_posting',
            dailyKey
          )

          if (!alreadySignaled) {
            const sampleTitles = jobs
              .slice(0, 3)
              .map((j) => j.title)
              .join(', ')
            const warmthScore = WARMTH_SCORES[firmCompany.relationship_warmth] || 0
            const priorityScore = Math.min(18 + 25 + warmthScore, 100)

            const { error: sigError } = await supabase.from('signals').insert({
              company_id: firmCompany.id,
              signal_type: 'competitor_job_posting',
              signal_summary: `${firm.name} is actively hiring ${jobs.length} Life Sciences role${jobs.length > 1 ? 's' : ''} — e.g. ${sampleTitles}`,
              signal_detail: {
                competitor_firm: firm.name,
                jobs_found: jobs.length,
                sample_titles: jobs.slice(0, 10).map((j) => j.title),
                careers_url: firm.careers_url,
              },
              source_url: dailyKey,
              source_name: `${firm.name} Careers`,
              first_detected_at: new Date().toISOString(),
              status: 'new',
              priority_score: priorityScore,
              score_breakdown: {
                signal_strength: 18,
                recency: 25,
                relationship_warmth: warmthScore,
                actionability: 0,
              },
              days_in_queue: 0,
              is_carried_forward: false,
            })

            if (!sigError) {
              signalsFound++
            } else {
              console.warn(`Signal insert failed for ${firm.name}: ${sigError.message}`)
            }
          }
        }
      }

      // ─── Bonus signal: identified client company ───────────────────────────
      // If a job description mentions a specific client company, emit an
      // additional signal attributed to that client.
      for (const job of jobs) {
        const clientName = extractClientCompany(job.description || job.title)
        if (!clientName) continue

        const clientCompany = await upsertCompany(clientName)
        if (!clientCompany) continue

        const alreadySignaled = await signalExists(
          clientCompany.id,
          'competitor_job_posting',
          job.url
        )
        if (alreadySignaled) continue

        const warmthScore = WARMTH_SCORES[clientCompany.relationship_warmth] || 0
        const priorityScore = Math.min(18 + 25 + warmthScore, 100)

        const { error: sigError } = await supabase.from('signals').insert({
          company_id: clientCompany.id,
          signal_type: 'competitor_job_posting',
          signal_summary: `Competitor ${firm.name} is staffing "${job.title}" — possible client: ${clientName}`,
          signal_detail: {
            competitor_firm: firm.name,
            job_title: job.title,
            job_url: job.url,
            client_company: clientName,
          },
          source_url: job.url,
          source_name: `${firm.name} Careers`,
          first_detected_at: new Date().toISOString(),
          status: 'new',
          priority_score: priorityScore,
          score_breakdown: {
            signal_strength: 18,
            recency: 25,
            relationship_warmth: warmthScore,
            actionability: 0,
          },
          days_in_queue: 0,
          is_carried_forward: false,
        })

        if (!sigError) signalsFound++
      }

      // Update last_scraped_at for the competitor firm
      await supabase
        .from('competitor_firms')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', firm.id)

      // Rate-limit between firms
      await new Promise((r) => setTimeout(r, 2000))
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: { firms_scraped: firms.length },
      })
      .eq('id', runId)

    console.log(`Competitor Job Board Agent complete. Signals: ${signalsFound}`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message,
      })
      .eq('id', runId)
    console.error('Competitor Job Board Agent failed:', error.message)
    return { success: false, error: error.message }
  }
}
