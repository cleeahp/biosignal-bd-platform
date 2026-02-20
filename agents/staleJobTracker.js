import { supabase } from '../lib/supabase.js'

const LIFE_SCIENCES_KEYWORDS = [
  'clinical research associate', 'CRA', 'clinical research coordinator',
  'CRC', 'clinical trial manager', 'CTM', 'regulatory affairs',
  'quality assurance', 'QA specialist', 'medical affairs',
  'biostatistician', 'data manager', 'clinical data manager',
  'manufacturing', 'CMC', 'validation engineer', 'regulatory specialist',
  'pharmacovigilance', 'drug safety', 'medical monitor',
  'clinical operations', 'site monitor', 'study coordinator'
]

async function getTargetCompanies() {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, domain, relationship_warmth')
  if (error) throw new Error(`Failed to fetch companies: ${error.message}`)
  return data || []
}

async function jobExists(jobUrl) {
  const { data } = await supabase
    .from('job_postings')
    .select('id, days_posted, created_at')
    .eq('job_url', jobUrl)
    .single()
  return data
}

async function searchIndeedJobs(companyName) {
  const results = []
  for (const keyword of LIFE_SCIENCES_KEYWORDS.slice(0, 5)) {
    try {
      const query = encodeURIComponent(`${keyword} ${companyName}`)
      const url = `https://indeed.com/jobs?q=${query}&fromage=30`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BioSignalBot/1.0)' }
      })
      if (!response.ok) continue
      const html = await response.text()
      const jobMatches = html.matchAll(
        /data-jk="([^"]+)"[\s\S]*?<span[^>]*class="[^"]*jobTitle[^"]*"[^>]*>([\s\S]*?)<\/span>/g
      )
      for (const match of jobMatches) {
        const jobKey = match[1]
        const titleRaw = match[2].replace(/<[^>]+>/g, '').trim()
        if (!titleRaw || titleRaw.length < 3) continue
        const isRelevant = LIFE_SCIENCES_KEYWORDS.some(kw =>
          titleRaw.toLowerCase().includes(kw.toLowerCase())
        )
        if (isRelevant) {
          results.push({
            job_title: titleRaw,
            job_url: `https://indeed.com/viewjob?jk=${jobKey}`,
            job_board: 'indeed',
            source_type: 'indeed'
          })
        }
      }
      await new Promise(r => setTimeout(r, 1500))
    } catch (err) {
      console.warn(`Indeed search failed for ${companyName}/${keyword}:`, err.message)
    }
  }
  return results
}

function getRoleCategory(title) {
  const t = title.toLowerCase()
  if (t.includes('clinical research') || t.includes('cra') || t.includes('crc') || t.includes('monitor')) return 'clinical_research'
  if (t.includes('regulatory')) return 'regulatory_affairs'
  if (t.includes('quality') || t.includes('qa') || t.includes('qc')) return 'quality_assurance'
  if (t.includes('medical affairs') || t.includes('medical monitor')) return 'medical_affairs'
  if (t.includes('biostatistic') || t.includes('data manager')) return 'biostatistics'
  if (t.includes('manufactur') || t.includes('cmc') || t.includes('validation')) return 'manufacturing_cmc'
  return 'other'
}

function calculatePriorityScore(daysPosted, relationshipWarmth, hasContact) {
  let score = 0
  if (daysPosted >= 90) score += 20
  else if (daysPosted >= 60) score += 17
  else if (daysPosted >= 45) score += 14
  else score += 10
  score += 15
  if (relationshipWarmth === 'active_client') score += 25
  else if (relationshipWarmth === 'past_client') score += 18
  else if (relationshipWarmth === 'in_ats') score += 10
  if (hasContact) score += 15
  return Math.min(score, 100)
}

export async function runStaleJobTracker() {
  let signalsFound = 0
  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'stale_job_tracker', status: 'running' })
    .select()
    .single()
  const runId = runLog?.id

  try {
    const companies = await getTargetCompanies()
    console.log(`Stale Job Tracker: scanning ${companies.length} companies`)

    for (const company of companies) {
      const jobs = await searchIndeedJobs(company.name)

      for (const job of jobs) {
        const existing = await jobExists(job.job_url)

        if (existing) {
          const daysPosted = Math.floor(
            (Date.now() - new Date(existing.created_at)) / (1000 * 60 * 60 * 24)
          )
          await supabase
            .from('job_postings')
            .update({ days_posted: daysPosted, last_seen_at: new Date().toISOString(), is_active: true })
            .eq('job_url', job.job_url)

          if (daysPosted >= 30 && existing.days_posted < 30) {
            const priorityScore = calculatePriorityScore(daysPosted, company.relationship_warmth, false)
            await supabase.from('signals').insert({
              company_id: company.id,
              signal_type: 'stale_job_posting',
              signal_summary: `"${job.job_title}" at ${company.name} has been posted for ${daysPosted} days without being filled`,
              signal_detail: { job_title: job.job_title, job_url: job.job_url, job_board: job.job_board, days_posted: daysPosted },
              source_url: job.job_url,
              source_name: job.job_board,
              signal_date: new Date().toISOString().split('T')[0],
              priority_score: priorityScore,
              score_breakdown: {
                signal_strength: daysPosted >= 60 ? 17 : 10,
                recency: 15,
                relationship_warmth: company.relationship_warmth === 'active_client' ? 25 : 0,
                actionability: 0
              }
            })
            signalsFound++
          }
        } else {
          await supabase.from('job_postings').insert({
            company_id: company.id,
            job_title: job.job_title,
            job_url: job.job_url,
            job_board: job.job_board,
            source_type: job.source_type,
            role_category: getRoleCategory(job.job_title),
            days_posted: 0,
            is_active: true
          })
          console.log(`New job posting tracked: ${job.job_title} at ${company.name}`)
        }
      }
      await new Promise(r => setTimeout(r, 2000))
    }

    await supabase
      .from('agent_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), signals_found: signalsFound })
      .eq('id', runId)

    console.log(`Stale Job Tracker complete. Signals generated: ${signalsFound}`)
    return { success: true, signalsFound }

  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: error.message })
      .eq('id', runId)
    console.error('Stale Job Tracker failed:', error.message)
    return { success: false, error: error.message }
  }
}
