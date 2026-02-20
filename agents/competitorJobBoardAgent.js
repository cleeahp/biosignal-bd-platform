import { supabase } from '../lib/supabase.js'
import * as cheerio from 'cheerio'

// ─── Verified competitor firms (all URLs confirmed HTTP 200) ───────────────────
// URL verification date: 2026-02-20
const SEED_COMPETITORS = [
  // ── Original 6 ──────────────────────────────────────────────────────────────
  { name: 'Medpace',                  careers_url: 'https://www.medpace.com/careers/' },
  { name: 'Syneos Health',            careers_url: 'https://syneoshealth.com/careers' },
  { name: 'Fortrea',                  careers_url: 'https://careers.fortrea.com' },
  { name: 'Halloran Consulting',      careers_url: 'https://www.halloran-consulting.com/careers' },
  { name: 'Premier Research',         careers_url: 'https://premierresearch.com/careers' },
  { name: 'Worldwide Clinical Trials',careers_url: 'https://worldwideclinicaltrials.com/careers' },
  // ── Session-2 verified ───────────────────────────────────────────────────────
  { name: 'ProPharma Group',          careers_url: 'https://propharmagroup.com/careers/' },
  { name: 'Advanced Clinical',        careers_url: 'https://www.advancedclinical.com/careers' },
  { name: 'Synteract',                careers_url: 'https://www.synteract.com/careers' },
  { name: 'Cytel',                    careers_url: 'https://cytel.com/about/careers' },
  { name: 'Veeva Systems',            careers_url: 'https://careers.veeva.com/' },
  { name: 'Labcorp Drug Development', careers_url: 'https://careers.labcorp.com/global/en' },
  { name: 'ICON plc',                 careers_url: 'https://careers.iconplc.com' },
  { name: 'Therapeutics Inc',         careers_url: 'https://www.therapeuticsinc.com/careers' },
  // ── Session-3 verified (all HTTP 200) ────────────────────────────────────────
  { name: 'Black Diamond Networks',   careers_url: 'https://www.blackdiamondnetworks.com/jobs' },
  { name: 'Soliant Health',           careers_url: 'https://www.soliant.com/jobs' },
  { name: 'Medix Staffing',           careers_url: 'https://medixteam.com/find-a-job' },
  { name: 'Solomon Page',             careers_url: 'https://solomonpage.com/our-disciplines/pharmaceutical-biotech' },
  { name: 'Mindlance',                careers_url: 'https://www.mindlance.com/' },
  { name: 'Green Key Resources',      careers_url: 'https://greenkeyresources.com/find-a-job' },
  { name: 'Phaidon International',    careers_url: 'https://www.phaidoninternational.com/jobs' },
  { name: 'ClinLab Staffing',         careers_url: 'https://www.clinlabstaffing.com/job-seekers' },
  { name: 'ALKU',                     careers_url: 'https://www.alku.com/jobs' },
  { name: 'Yoh Services',             careers_url: 'https://yoh.com/' },
  { name: 'Pacer Staffing',           careers_url: 'https://pacerstaffing.com/' },
  { name: 'Oxford Global Resources',  careers_url: 'https://ogcareers.com' },
  { name: 'Catalent',                 careers_url: 'https://careers.catalent.com' },
  { name: 'Spectraforce',             careers_url: 'https://spectraforce.com/' },
  { name: 'Randstad Life Sciences',   careers_url: 'https://www.randstadusa.com/jobs' },
  { name: 'Epic Staffing Group',      careers_url: 'https://epicstaffinggroup.com/' },
  { name: 'Precision Biosciences',    careers_url: 'https://www.precisionbiosciences.com/careers' },
]

const LIFE_SCIENCES_KEYWORDS = [
  'clinical research associate', 'CRA', 'clinical research coordinator', 'CRC',
  'clinical trial manager', 'regulatory affairs', 'quality assurance', 'QA',
  'biostatistician', 'data manager', 'clinical data manager', 'pharmacovigilance',
  'drug safety', 'medical monitor', 'clinical operations', 'site monitor',
  'study coordinator', 'medical affairs', 'validation engineer', 'CMC',
  'regulatory specialist', 'data scientist', 'statistical programmer',
]

// Patterns to infer the client/sponsor company from job description text
const CLIENT_PATTERNS = [
  /(?:client|sponsor|our client|our partner|working with)\s*[:\-–]\s*([A-Z][A-Za-z0-9\s&,\.]+?)(?:\.|,|\n|$)/i,
  /(?:supporting|staffing for|on behalf of|contracted to)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s+to|\s+in|\s+on|\.|,|$)/i,
  /([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,4})\s+(?:is hiring|seeks|is looking for|is seeking)/i,
  /join\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,3})\s+(?:as a|as an|to support)/i,
]

// Known Life Sciences pharma/biotech hubs for geography-based inference
const GEO_BIOTECH_HUBS = {
  'Cambridge, MA': ['Biogen', 'Vertex', 'Moderna', 'Sanofi', 'Novartis', 'AstraZeneca'],
  'San Francisco, CA': ['Genentech', 'BioMarin', '23andMe', 'Rigel Pharmaceuticals'],
  'San Diego, CA': ['Illumina', 'Gilead', 'Dexcom', 'Retinal Gene Therapies'],
  'Research Triangle Park, NC': ['Syneos Health', 'PPD', 'Quintiles'],
  'Philadelphia, PA': ['Johnson & Johnson', 'GSK', 'Incyte'],
  'New Jersey': ['Merck', 'Bristol Myers Squibb', 'Novo Nordisk'],
  'Chicago, IL': ['AbbVie', 'Baxter International', 'Horizon Therapeutics'],
  'Boston, MA': ['Biogen', 'Vertex', 'Ironwood Pharmaceuticals'],
  'Raleigh, NC': ['Bayer', 'Cree Life Sciences', 'RTI Health Solutions'],
}

const WARMTH_SCORES = { active_client: 25, past_client: 18, in_ats: 10, new_prospect: 0 }

function isLifeSciencesJob(title, description = '') {
  const text = `${title} ${description}`.toLowerCase()
  return LIFE_SCIENCES_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))
}

// ─── Client inference: 3-tier approach ────────────────────────────────────────

function inferClientFromText(description) {
  for (const pattern of CLIENT_PATTERNS) {
    const match = description.match(pattern)
    if (match) {
      const name = match[1].trim()
      if (name.length > 3 && name.length < 100) {
        return { name, confidence: 'high' }
      }
    }
  }
  return null
}

function inferClientFromGeography(location, roleType) {
  if (!location) return null
  for (const [region, companies] of Object.entries(GEO_BIOTECH_HUBS)) {
    if (location.toLowerCase().includes(region.toLowerCase().split(',')[0])) {
      // Pick first company as a likely candidate for clinical roles
      if (companies.length > 0 && (roleType === 'clinical_research' || roleType === 'regulatory_affairs')) {
        return { name: companies[0], confidence: 'low' }
      }
    }
  }
  return null
}

function inferLikelyClient(description, title, location) {
  // Tier 1: text scan
  const fromText = inferClientFromText(description || title)
  if (fromText) return fromText

  // Tier 2: geography match (low confidence)
  const roleType = getRoleType(title)
  const fromGeo = inferClientFromGeography(location, roleType)
  if (fromGeo) return fromGeo

  // Tier 3: default — never skip a signal
  return { name: 'Unknown', confidence: 'low' }
}

function getRoleType(title) {
  const t = title.toLowerCase()
  if (t.includes('clinical research') || t.includes('cra') || t.includes('monitor')) return 'clinical_research'
  if (t.includes('regulatory')) return 'regulatory_affairs'
  if (t.includes('quality') || t.includes('qa')) return 'quality_assurance'
  if (t.includes('biostatistic') || t.includes('data manager') || t.includes('statistical')) return 'biostatistics'
  if (t.includes('medical affairs') || t.includes('pharmacovigilance')) return 'medical_affairs'
  return 'other'
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
    .insert({ name: cleanName, industry: 'Life Sciences', relationship_warmth: 'new_prospect' })
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
  console.log(`Seeding ${SEED_COMPETITORS.length} competitor firms...`)
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
      else console.log(`  Seeded: ${firm.name}`)
    } else {
      // Always update URL so stale cached values get corrected
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
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) {
      console.warn(`  Failed to fetch ${firm.careers_url}: HTTP ${resp.status}`)
      return jobs
    }

    const html = await resp.text()
    const $ = cheerio.load(html)

    // ── Structured selectors: accumulate across all; do NOT break early ────────
    const selectors = [
      '.job-title a', '.position-title a',
      '[class*="job-title"] a', '[class*="jobtitle"] a',
      '[class*="position"] a',
      'a[href*="/jobs/"]', 'a[href*="/job/"]',
      'a[href*="job"]', 'a[href*="career"]',
      'a[href*="position"]', 'a[href*="opening"]',
      '[class*="job"] a', '[class*="career"] a',
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

        // Extract location from nearby text
        const $parent = $el.closest('li, article, [class*="job"], [class*="position"]')
        const locationEl = $parent.find('[class*="location"], [class*="city"], [class*="place"]').first()
        const location = locationEl.text().trim() || ''

        seen.add(title.toLowerCase())
        jobs.push({ title, url: href, description: '', location })
      })
    }

    // ── Body-text fallback for JS-rendered or simple static pages ─────────────
    if (jobs.length === 0) {
      const bodyText = $('body').text()
      const lines = bodyText.split('\n').map((l) => l.trim()).filter((l) => l.length > 5)
      for (const line of lines) {
        if (isLifeSciencesJob(line) && line.length < 150) {
          if (!seen.has(line.toLowerCase())) {
            seen.add(line.toLowerCase())
            jobs.push({ title: line, url: firm.careers_url, description: '', location: '' })
          }
          if (jobs.length >= 20) break
        }
      }
    }
  } catch (err) {
    console.warn(`  Scrape failed for ${firm.name}: ${err.message}`)
  }

  return jobs.slice(0, 50)
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
    await seedCompetitorFirms()

    const { data: firms, error: firmsError } = await supabase
      .from('competitor_firms')
      .select('id, name, careers_url')
      .eq('is_active', true)

    if (firmsError) throw new Error(`Failed to fetch competitor firms: ${firmsError.message}`)
    if (!firms || firms.length === 0) throw new Error('No active competitor firms found after seeding')

    console.log(`Competitor Job Board: scanning ${firms.length} firms`)
    const today = new Date().toISOString().split('T')[0]

    for (const firm of firms) {
      const jobs = await scrapeJobListings(firm)
      console.log(`  ${firm.name}: ${jobs.length} Life Sciences roles found`)

      if (jobs.length === 0) {
        await supabase
          .from('competitor_firms')
          .update({ last_scraped_at: new Date().toISOString() })
          .eq('id', firm.id)
        continue
      }

      // ── Primary signal: one aggregated signal per firm per day ────────────────
      const firmCompany = await upsertCompany(firm.name)
      if (firmCompany) {
        const dailyKey = `${firm.careers_url}#${today}`
        const alreadySignaled = await signalExists(firmCompany.id, 'competitor_job_posting', dailyKey)

        if (!alreadySignaled) {
          const sampleJob = jobs[0]
          const likelyClient = inferLikelyClient(sampleJob.description, sampleJob.title, sampleJob.location)
          const sampleTitles = jobs.slice(0, 5).map((j) => j.title)
          const warmthScore = WARMTH_SCORES[firmCompany.relationship_warmth] || 0
          const priorityScore = Math.min(18 + 25 + warmthScore, 100)

          const { error: sigError } = await supabase.from('signals').insert({
            company_id: firmCompany.id,
            signal_type: 'competitor_job_posting',
            signal_summary: `${firm.name} is actively hiring ${jobs.length} Life Sciences role${jobs.length > 1 ? 's' : ''} — e.g. ${sampleTitles.slice(0, 3).join(', ')}`,
            signal_detail: {
              job_title: sampleJob.title,
              job_location: sampleJob.location || 'Multiple Locations',
              posting_date: today,
              competitor_firm: firm.name,
              likely_client: likelyClient.name,
              likely_client_confidence: likelyClient.confidence,
              source_url: firm.careers_url,
              jobs_found: jobs.length,
              sample_titles: sampleTitles,
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
            console.warn(`  Signal insert failed for ${firm.name}: ${sigError.message}`)
          }
        }
      }

      // ── Bonus signals: per-job client signals when client can be inferred ──────
      for (const job of jobs.slice(0, 10)) {
        const likelyClient = inferLikelyClient(job.description, job.title, job.location)
        // Only emit per-job signal if we identified a specific (non-Unknown) client
        if (likelyClient.name === 'Unknown') continue

        const clientCompany = await upsertCompany(likelyClient.name)
        if (!clientCompany) continue

        const jobKey = `${job.url}#client`
        const alreadySignaled = await signalExists(clientCompany.id, 'competitor_job_posting', jobKey)
        if (alreadySignaled) continue

        const warmthScore = WARMTH_SCORES[clientCompany.relationship_warmth] || 0
        const priorityScore = Math.min(22 + 25 + warmthScore, 100) // slightly higher for identified client

        const { error: sigError } = await supabase.from('signals').insert({
          company_id: clientCompany.id,
          signal_type: 'competitor_job_posting',
          signal_summary: `${firm.name} staffing "${job.title}" — likely client: ${likelyClient.name}`,
          signal_detail: {
            job_title: job.title,
            job_location: job.location || 'Unknown',
            posting_date: today,
            competitor_firm: firm.name,
            likely_client: likelyClient.name,
            likely_client_confidence: likelyClient.confidence,
            source_url: job.url,
          },
          source_url: jobKey,
          source_name: `${firm.name} Careers`,
          first_detected_at: new Date().toISOString(),
          status: 'new',
          priority_score: priorityScore,
          score_breakdown: {
            signal_strength: 22,
            recency: 25,
            relationship_warmth: warmthScore,
            actionability: 0,
          },
          days_in_queue: 0,
          is_carried_forward: false,
        })

        if (!sigError) signalsFound++
      }

      await supabase
        .from('competitor_firms')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', firm.id)

      await new Promise((r) => setTimeout(r, 1500))
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: { firms_scanned: firms.length },
      })
      .eq('id', runId)

    console.log(`Competitor Job Board Agent complete. Signals: ${signalsFound}`)
    return { success: true, signalsFound }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Competitor Job Board Agent failed:', error.message)
    return { success: false, error: error.message }
  }
}
