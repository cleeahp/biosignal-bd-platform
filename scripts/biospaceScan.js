/**
 * BioSpace Scan
 *
 * Paginates through https://www.biospace.com/search-press-releases and stores
 * new articles in the biospace_news Supabase table. Dedups by article_url.
 *
 * Usage:
 *   node scripts/biospaceScan.js --mode daily   # stops once an article is older than 3 days
 *   node scripts/biospaceScan.js --mode manual  # stops once an article is older than 30 days
 */

import { createClient } from '@supabase/supabase-js'
import { buildNewsMatcher } from '../lib/newsCompanyMatcher.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[BioSpaceScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PRESS_RELEASES_BASE = 'https://www.biospace.com/search-press-releases'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const FETCH_DELAY_MS = 2000
const MAX_PAGES = 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/biospaceScan.js --mode <daily|manual>')
  process.exit(1)
}

// ── HTML helpers ────────────────────────────────────────────────────────────

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&#039;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
  '&hellip;': '…',
}

function decodeHtmlEntities(text) {
  if (!text) return ''
  let s = text
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    s = s.split(entity).join(char)
  }
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
  return s
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]*>/g, '')
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Parse a date string like "April 20, 2026" or "Apr 20, 2026"
 * into YYYY-MM-DD, or null if unparseable.
 */
function parseArticleDate(raw) {
  if (!raw) return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  const m = cleaned.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const monthKey = m[1].substring(0, 3).toLowerCase()
  const month = MONTHS[monthKey]
  if (!month) return null
  const day = parseInt(m[2], 10)
  const year = parseInt(m[3], 10)
  if (!day || !year) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ── Scraping ────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`)
  }
  return response.text()
}

/**
 * Extract articles from the BioSpace drug-development page HTML.
 * Each article is rooted at a <div class="PagePromo-title"><a class="Link" href="...">TITLE</a></div>
 * with a following <div class="PagePromo-date">April 20, 2026</div> in the same card block.
 */
function extractArticles(html) {
  const articles = []

  const titleDivPattern = /<div\s+class="PagePromo-title"[^>]*>([\s\S]*?)<\/div>/gi
  const titleMatches = []
  let match
  while ((match = titleDivPattern.exec(html)) !== null) {
    titleMatches.push({ index: match.index, endIndex: titleDivPattern.lastIndex, inner: match[1] })
  }

  for (let i = 0; i < titleMatches.length; i++) {
    const { endIndex, inner } = titleMatches[i]

    const anchorMatch = inner.match(/<a\s+[^>]*class="[^"]*\bLink\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || inner.match(/<a\s+[^>]*href="([^"]+)"[^>]*class="[^"]*\bLink\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    if (!anchorMatch) continue

    const href = anchorMatch[1].trim()
    const title = decodeHtmlEntities(stripHtmlTags(anchorMatch[2])).replace(/\s+/g, ' ').trim()
    if (!title || !href) continue

    // Search for the nearest date div between this title and the next title
    const nextStart = i + 1 < titleMatches.length ? titleMatches[i + 1].index : html.length
    const windowHtml = html.substring(endIndex, nextStart)

    let articleDate = null
    const dateMatch = windowHtml.match(/<div\s+class="PagePromo-date"[^>]*>([\s\S]*?)<\/div>/i)
    if (dateMatch) {
      const rawDate = decodeHtmlEntities(stripHtmlTags(dateMatch[1]))
      articleDate = parseArticleDate(rawDate)
    }

    articles.push({ title, article_url: href, article_date: articleDate })
  }

  return articles
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadCompanyNames() {
  const names = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('companies_directory')
      .select('name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[BioSpaceScan] Error loading companies_directory: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) if (row.name) names.push(row.name)
    offset += PAGE
  }
  return names
}

async function loadAlternateNames() {
  const rows = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('companies_alternate_names')
      .select('alternate_name, directory_name')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[BioSpaceScan] Error loading companies_alternate_names: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.alternate_name && row.directory_name) rows.push(row)
    }
    offset += PAGE
  }
  return rows
}

async function loadExistingUrls() {
  const urls = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('biospace_news')
      .select('article_url')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[BioSpaceScan] Error loading existing articles: ${error.message}`); break }
    if (!data || data.length === 0) break
    for (const row of data) urls.add(row.article_url)
    offset += PAGE
  }

  return urls
}

// ── Batch insert helper ─────────────────────────────────────────────────────

async function batchInsert(rows) {
  if (rows.length === 0) return { inserted: 0, errors: 0 }

  let inserted = 0
  let errors = 0
  const BATCH = 100

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await supabase.from('biospace_news').insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from('biospace_news').insert(row)
        if (rowErr) {
          console.error(`[BioSpaceScan] Insert error for ${row.article_url}: ${rowErr.message}`)
          errors++
        } else {
          inserted++
        }
      }
    } else {
      inserted += batch.length
    }
  }

  return { inserted, errors }
}

// ── Main ────────────────────────────────────────────────────────────────────

function formatYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main() {
  const daysBack = mode === 'daily' ? 3 : 30
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - daysBack)
  const cutoffStr = formatYMD(cutoff)
  console.log(`[BioSpaceScan] Mode: ${mode}, Date cutoff: ${cutoffStr}`)

  const seenUrls = new Set()
  const articles = []

  let page = 1
  let keepGoing = true

  while (keepGoing && page <= MAX_PAGES) {
    if (page > 1) await sleep(FETCH_DELAY_MS)

    const url = page === 1 ? PRESS_RELEASES_BASE : `${PRESS_RELEASES_BASE}?p=${page}`
    console.log(`[BioSpaceScan] Scraping page ${page}: ${url}`)

    let html
    try {
      html = await fetchPage(url)
    } catch (err) {
      console.error(`[BioSpaceScan] Fetch error for ${url}: ${err.message}`)
      break
    }

    const pageArticles = extractArticles(html)
    if (pageArticles.length === 0) {
      console.log(`[BioSpaceScan] Page ${page}: 0 articles found, stopping`)
      break
    }

    const datedSorted = pageArticles
      .map(a => a.article_date)
      .filter(Boolean)
      .sort()
    const oldestDate = datedSorted.length > 0 ? datedSorted[0] : 'unknown'
    console.log(`[BioSpaceScan] Page ${page}: ${pageArticles.length} articles found, oldest date: ${oldestDate}`)

    for (const article of pageArticles) {
      if (seenUrls.has(article.article_url)) continue
      seenUrls.add(article.article_url)
      articles.push(article)
    }

    const triggerArticle = pageArticles.find(a => a.article_date && a.article_date < cutoffStr)
    if (triggerArticle) {
      console.log(`[BioSpaceScan] Stopping: found article older than cutoff (${triggerArticle.article_date})`)
      keepGoing = false
    }

    page++
  }

  if (keepGoing && page > MAX_PAGES) {
    console.warn(`[BioSpaceScan] Reached safety cap of ${MAX_PAGES} pages, stopping`)
  }

  const [existingUrls, companyNames, alternateNames] = await Promise.all([
    loadExistingUrls(),
    loadCompanyNames(),
    loadAlternateNames(),
  ])
  console.log(`[BioSpaceScan] ${existingUrls.size} existing articles loaded`)
  const matcher = buildNewsMatcher(companyNames, alternateNames)
  console.log(`[BioSpaceScan] ${matcher.size} company name patterns loaded for matching (${companyNames.length} directory names, ${alternateNames.length} alternate names)`)

  const toInsert = []
  let skipped = 0

  for (const article of articles) {
    if (existingUrls.has(article.article_url)) {
      skipped++
      continue
    }
    existingUrls.add(article.article_url)

    const matched = matcher.match(article.title)
    if (matched.length > 0) {
      article.matched_names = matched
      console.log(`[BioSpaceScan] Matched: "${article.title}" → ${matched.join(', ')}`)
    } else {
      article.matched_names = null
    }

    console.log(`[BioSpaceScan] Found: ${article.title} (${article.article_date || 'unknown date'}) — ${article.article_url}`)
    toInsert.push(article)
  }

  const insertResult = await batchInsert(toInsert)

  console.log(`[BioSpaceScan] Scan complete: ${articles.length} articles found, ${insertResult.inserted} new, ${skipped} already existed`)
  if (insertResult.errors > 0) {
    console.warn(`[BioSpaceScan] ${insertResult.errors} insert errors`)
  }

  console.log(`[BioSpaceScan] Refreshing company signal summary...`)
  const { error: refreshError } = await supabase.rpc('refresh_company_signal_summary')
  if (refreshError) {
    console.error(`[BioSpaceScan] Failed to refresh company signal summary: ${refreshError.message}`)
  } else {
    console.log(`[BioSpaceScan] Company signal summary refreshed.`)
  }
}

main().catch((err) => {
  console.error('[BioSpaceScan] Unhandled error:', err)
  process.exit(1)
})
