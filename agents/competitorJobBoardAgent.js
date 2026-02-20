import { supabase } from '../lib/supabase.js'
import * as cheerio from 'cheerio'

// ─── Competitor firms to track ─────────────────────────────────────────────────
// careers_url stored for context / competitor_firms table; actual job detection
// uses BioSpace (server-side rendered), which lists CROs and staffing firms directly.
const SEED_COMPETITORS = [
  { name: 'Medpace',                  careers_url: 'https://www.medpace.com/careers/' },
  { name: 'Syneos Health',            careers_url: 'https://syneoshealth.com/careers' },
  { name: 'Fortrea',                  careers_url: 'https://careers.fortrea.com' },
  { name: 'Premier Research',         careers_url: 'https://premierresearch.com/careers' },
  { name: 'Worldwide Clinical Trials',careers_url: 'https://worldwideclinicaltrials.com/careers' },
  { name: 'ProPharma Group',          careers_url: 'https://propharmagroup.com/careers/' },
  { name: 'Advanced Clinical',        careers_url: 'https://www.advancedclinical.com/careers' },
  { name: 'Synteract',                careers_url: 'https://www.synteract.com/careers' },
  { name: 'Cytel',                    careers_url: 'https://cytel.com/about/careers' },
  { name: 'Veeva Systems',            careers_url: 'https://careers.veeva.com/' },
  { name: 'Labcorp Drug Development', careers_url: 'https://careers.labcorp.com/global/en' },
  { name: 'ICON plc',                 careers_url: 'https://careers.iconplc.com' },
  { name: 'Therapeutics Inc',         careers_url: 'https://www.therapeuticsinc.com/careers' },
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

// ─── Name matching map: lowercase key → canonical firm name ───────────────────
// Used to detect competitor firm names appearing in BioSpace job listings.
// Keys are unambiguous substrings; word-boundary regex prevents false positives.
const COMPETITOR_NAME_KEYS = {
  'syneos': 'Syneos Health',
  'fortrea': 'Fortrea',
  'labcorp': 'Labcorp Drug Development',
  'medpace': 'Medpace',
  'propharma': 'ProPharma Group',
  'advanced clinical': 'Advanced Clinical',
  'synteract': 'Synteract',
  'cytel': 'Cytel',
  'veeva': 'Veeva Systems',
  'catalent': 'Catalent',
  'precision biosciences': 'Precision Biosciences',
  'worldwide clinical': 'Worldwide Clinical Trials',
  'premier research': 'Premier Research',
  'alku': 'ALKU',
  'soliant': 'Soliant Health',
  'solomon page': 'Solomon Page',
  'green key': 'Green Key Resources',
  'phaidon': 'Phaidon International',
  'clinlab': 'ClinLab Staffing',
  'oxford global': 'Oxford Global Resources',
  'icon plc': 'ICON plc',
  'spectraforce': 'Spectraforce',
  'mindlance': 'Mindlance',
  'black diamond': 'Black Diamond Networks',
  'pacer staffing': 'Pacer Staffing',
  'yoh services': 'Yoh Services',
  'epic staffing': 'Epic Staffing Group',
  'medix': 'Medix Staffing',
  'randstad': 'Randstad Life Sciences',
  'therapeutics inc': 'Therapeutics Inc',
}

const LIFE_SCIENCES_KEYWORDS = [
  'clinical research associate', 'cra', 'clinical research coordinator', 'crc',
  'clinical trial manager', 'regulatory affairs', 'quality assurance', 'qa specialist',
  'biostatistician', 'data manager', 'clinical data manager', 'pharmacovigilance',
  'drug safety', 'medical monitor', 'clinical operations', 'site monitor',
  'study coordinator', 'medical affairs', 'validation engineer', 'statistical programmer',
]

const WARMTH_SCORES = { active_client: 25, past_client: 18, in_ats: 10, new_prospect: 0 }

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function isLifeSciencesJob(title) {
  const t = title.toLowerCase()
  return LIFE_SCIENCES_KEYWORDS.some((kw) => t.includes(kw))
}

// Match a BioSpace company name against our competitor firm list.
// Uses word-boundary regex to avoid partial false matches (e.g. "icon" inside "iconic").
function findMatchingCompetitor(companyName) {
  if (!companyName || companyName.length < 3) return null
  const normalized = companyName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  for (const [key, firmName] of Object.entries(COMPETITOR_NAME_KEYS)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`)
    if (regex.test(normalized)) return firmName
  }
  return null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
    } else {
      await supabase
        .from('competitor_firms')
        .update({ careers_url: firm.careers_url })
        .eq('id', existing.id)
    }
  }
}

// ─── SOURCE: BioSpace Clinical Research jobs ───────────────────────────────────
// BioSpace is server-side rendered. CROs (Syneos, ICON, Fortrea, Labcorp, etc.)
// and Life Sciences staffing firms post directly on BioSpace.
// We scrape the listing and match company names against our competitor list.

async function fetchBioSpaceJobsForCompetitors() {
  const matches = [] // Array of { firmName, job }
  try {
    const resp = await fetch('https://www.biospace.com/jobs/?discipline=Clinical-Research', {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(18000),
    })

    if (!resp.ok) {
      console.warn(`  BioSpace returned HTTP ${resp.status}`)
      return matches
    }

    const html = await resp.text()
    const $ = cheerio.load(html)

    $('[id^="item-"]').each((_, el) => {
      const $item = $(el)

      const title = $item.find('.lister__header span').first().text().trim()
        || $item.find('h3 span').first().text().trim()
      if (!title || !isLifeSciencesJob(title)) return

      // Company from logo alt text
      let company = ''
      const logoAlt = $item.find('img.lister__logo, img[class*="logo"]').first().attr('alt') || ''
      if (logoAlt) company = logoAlt.replace(/\s+logo\s*$/i, '').trim()
      if (!company || company.length < 2) return

      // Check if company matches a competitor firm
      const matchedFirm = findMatchingCompetitor(company)
      if (!matchedFirm) return

      // Job URL
      let jobUrl = ''
      const linkHref = $item.find('a[href*="/job/"]').first().attr('href') || ''
      if (linkHref) {
        const cleanHref = linkHref.replace(/[\s\n\t]/g, '')
        jobUrl = cleanHref.startsWith('http') ? cleanHref : `https://jobs.biospace.com${cleanHref}`
      }
      if (!jobUrl) jobUrl = 'https://www.biospace.com/jobs/?discipline=Clinical-Research'

      const location = $item.find('[class*="location"], [class*="city"]').first().text().trim() || ''

      let daysPosted = 30
      const badgeTitle = $item.find('.badge[title], [class*="badge"][title]').first().attr('title') || ''
      const daysMatch = badgeTitle.match(/Added in the last (\d+) day/i)
      if (daysMatch) daysPosted = parseInt(daysMatch[1], 10)

      matches.push({ firmName: matchedFirm, job: { title, company, location, link: jobUrl, daysPosted } })
    })

    console.log(`  BioSpace scan: ${matches.length} competitor job matches found`)
  } catch (err) {
    console.warn(`  BioSpace fetch failed: ${err.message}`)
  }
  return matches
}

// ─── SOURCE 2: Indeed RSS with competitor firm names ──────────────────────────
// Searches Indeed for jobs recently posted by specific CRO/staffing firms.
// Gracefully fails with 403 from some IP ranges (Cloudflare); Vercel IPs typically work.

async function fetchIndeedRssForFirm(firmName) {
  const matches = []
  try {
    const q = encodeURIComponent(`"${firmName}" clinical research`)
    const url = `https://www.indeed.com/rss?q=${q}&l=&fromage=7&sort=date`
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!resp.ok) return matches
    const xml = await resp.text()
    if (!xml.includes('<rss') && !xml.includes('<item>')) return matches

    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
    for (const item of items) {
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim()
      const link  = item.match(/<link>(.*?)<\/link>/s)?.[1]?.trim()
      const company = item.match(/<source[^>]*>(.*?)<\/source>/s)?.[1]?.trim() || firmName

      if (!title || !link || !isLifeSciencesJob(title)) continue
      const matchedFirm = findMatchingCompetitor(company) || firmName
      matches.push({ firmName: matchedFirm, job: { title, company, location: '', link, daysPosted: 7 } })
    }
  } catch (_) { /* silently skip */ }
  return matches
}

// ─── Main export ───────────────────────────────────────────────────────────────

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

    const today = new Date().toISOString().split('T')[0]

    // ── Fetch BioSpace + a few Indeed RSS queries in parallel ─────────────────
    // High-value CRO/staffing firms most likely to appear on BioSpace:
    const indeedFirms = ['Syneos Health', 'ICON plc', 'Fortrea', 'Labcorp']
    const [bioSpaceMatches, ...indeedMatchSets] = await Promise.all([
      fetchBioSpaceJobsForCompetitors(),
      ...indeedFirms.map((f) => fetchIndeedRssForFirm(f)),
    ])

    // Combine all matches
    const allMatches = [...bioSpaceMatches]
    for (const set of indeedMatchSets) allMatches.push(...set)

    // Group matches by firm name
    const byFirm = new Map()
    for (const match of allMatches) {
      if (!byFirm.has(match.firmName)) byFirm.set(match.firmName, [])
      byFirm.get(match.firmName).push(match.job)
    }

    console.log(`Competitor Job Board: ${byFirm.size} competitor firms detected with Life Sciences openings`)

    for (const [firmName, jobs] of byFirm) {
      // Find canonical careers URL from SEED_COMPETITORS
      const seedEntry = SEED_COMPETITORS.find((s) => s.name === firmName)
      const careersUrl = seedEntry?.careers_url || 'https://www.biospace.com/jobs/?discipline=Clinical-Research'

      const firmCompany = await upsertCompany(firmName)
      if (!firmCompany) continue

      // One aggregated signal per firm per day
      const dailyKey = `${careersUrl}#${today}`
      const alreadySignaled = await signalExists(firmCompany.id, 'competitor_job_posting', dailyKey)
      if (alreadySignaled) {
        console.log(`  ${firmName}: signal already exists for today, skipping`)
        continue
      }

      const sampleJob = jobs[0]
      const sampleTitles = [...new Set(jobs.map((j) => j.title))].slice(0, 5)
      const warmthScore = WARMTH_SCORES[firmCompany.relationship_warmth] || 0
      const priorityScore = Math.min(18 + 25 + warmthScore, 100)

      const { error: sigError } = await supabase.from('signals').insert({
        company_id: firmCompany.id,
        signal_type: 'competitor_job_posting',
        signal_summary: `${firmName} is actively hiring ${jobs.length} Life Sciences role${jobs.length > 1 ? 's' : ''} — e.g. ${sampleTitles.slice(0, 3).join(', ')}`,
        signal_detail: {
          job_title: sampleJob.title,
          job_location: sampleJob.location || 'Multiple Locations',
          posting_date: today,
          competitor_firm: firmName,
          likely_client: 'Unknown', // CRO client not inferred from BioSpace listings
          likely_client_confidence: 'low',
          source_url: careersUrl,
          jobs_found: jobs.length,
          sample_titles: sampleTitles,
        },
        source_url: dailyKey,
        source_name: `${firmName} Careers`,
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
        console.log(`  ${firmName}: signal inserted (${jobs.length} roles)`)
      } else {
        console.warn(`  Signal insert failed for ${firmName}: ${sigError.message}`)
      }
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: signalsFound,
        run_detail: {
          firms_detected: byFirm.size,
          biospace_matches: bioSpaceMatches.length,
        },
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
