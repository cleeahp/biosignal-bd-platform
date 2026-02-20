import { supabase } from '../lib/supabase.js'
import * as cheerio from 'cheerio'

const SEED_COMPETITORS = [
  { name: 'Medpace', careers_url: 'https://www.medpace.com/careers' },
  { name: 'Syneos Health', careers_url: 'https://syneoshealth.com/careers' },
  { name: 'Fortrea', careers_url: 'https://careers.fortrea.com' },
  { name: 'Halloran Consulting', careers_url: 'https://hallorangroup.com/careers' },
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

async function jobPostingExists(jobUrl) {
  const { data } = await supabase
    .from('job_postings')
    .select('id')
    .eq('job_url', jobUrl)
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
    }
  }
}

async function scrapeJobListings(firm) {
  const jobs = []
  try {
    const resp = await fetch(firm.careers_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BioSignalBot/1.0; +https://biosignal.example)',
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

    // Common selectors for job listing pages
    const selectors = [
      'a[href*="job"]',
      'a[href*="career"]',
      'a[href*="position"]',
      'a[href*="opening"]',
      '.job-title a',
      '.position-title a',
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

      if (jobs.length > 0) break // stop at first working selector
    }

    // If structured selectors found nothing, fallback to text scanning for job titles
    if (jobs.length === 0) {
      const bodyText = $('body').text()
      const lines = bodyText.split('\n').map((l) => l.trim()).filter((l) => l.length > 5)
      for (const line of lines) {
        if (isLifeSciencesJob(line) && line.length < 150) {
          jobs.push({ title: line, url: firm.careers_url, description: '' })
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
    // Auto-populate competitor_firms if empty
    const { data: existingFirms } = await supabase
      .from('competitor_firms')
      .select('id')
      .limit(1)

    if (!existingFirms || existingFirms.length === 0) {
      await seedCompetitorFirms()
    }

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

    for (const firm of firms) {
      const jobs = await scrapeJobListings(firm)
      console.log(`${firm.name}: found ${jobs.length} relevant job listings`)

      for (const job of jobs) {
        // Track the job posting itself
        const alreadyTracked = await jobPostingExists(job.url)

        if (!alreadyTracked) {
          await supabase.from('job_postings').insert({
            job_title: job.title,
            job_url: job.url,
            job_board: 'competitor_careers_page',
            source_type: 'competitor',
            competitor_firm: firm.name,
            first_seen_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            days_posted: 0,
            is_active: true,
          })
        } else {
          await supabase
            .from('job_postings')
            .update({ last_seen_at: new Date().toISOString(), is_active: true })
            .eq('job_url', job.url)
        }

        // Try to identify the client company from the job description
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
        const priorityScore = Math.min(18 + 25 + warmthScore, 100) // base 18 + recency 25

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
