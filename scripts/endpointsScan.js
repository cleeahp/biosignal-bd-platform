/**
 * Endpoints News Scan
 *
 * Scrapes Endpoints News (5 pages) and stores new articles in the
 * endpoint_news Supabase table. Dedups by article_url.
 *
 * Usage:
 *   node scripts/endpointsScan.js --mode daily
 *   node scripts/endpointsScan.js --mode manual
 *
 * Both modes scrape the same pages and insert any articles not already in
 * the database. Relative timestamps from the source are parsed into
 * article_date at insert time and never updated thereafter.
 */

import { createClient } from '@supabase/supabase-js'
import { buildNewsMatcher } from '../lib/newsCompanyMatcher.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[EndpointsScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const URLS = [
  'https://endpoints.news/news/',
  'https://endpoints.news/news/page/2/',
  'https://endpoints.news/news/page/3/',
  'https://endpoints.news/news/page/4/',
  'https://endpoints.news/news/page/5/',
]
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const FETCH_DELAY_MS = 2000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/endpointsScan.js --mode <daily|manual>')
  process.exit(1)
}

// ── HTML helpers ────────────────────────────────────────────────────────────

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&#039;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
  '&hellip;': '…', '&shy;': '', '&#173;': '',
}

function decodeHtmlEntities(text) {
  if (!text) return ''
  let s = text
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    s = s.split(entity).join(char)
  }
  // Drop literal soft-hyphen characters (U+00AD)
  s = s.replace(/\u00AD/g, '')
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10)
    if (code === 173) return ''
    return String.fromCharCode(code)
  })
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
  return s
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]*>/g, '')
}

// ── Relative date parsing ───────────────────────────────────────────────────

function formatDate(date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function daysAgo(n) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return formatDate(d)
}

function parseRelativeDate(text) {
  if (!text) return null
  const t = text.trim().toLowerCase()
  if (!t) return null

  if (/^\d+\s+minutes?\s+ago$/.test(t)) return daysAgo(0)
  if (/^\d+\s+hours?\s+ago$/.test(t)) return daysAgo(0)
  if (t === 'yesterday') return daysAgo(1)

  let m
  m = t.match(/^(\d+)\s+days?\s+ago$/)
  if (m) return daysAgo(parseInt(m[1], 10))

  if (t === 'last week') return daysAgo(7)

  m = t.match(/^(\d+)\s+weeks?\s+ago$/)
  if (m) return daysAgo(parseInt(m[1], 10) * 7)

  if (t === 'last month') return daysAgo(30)

  m = t.match(/^(\d+)\s+months?\s+ago$/)
  if (m) return daysAgo(parseInt(m[1], 10) * 30)

  return null
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
 * Extract articles from an Endpoints News listing page.
 * Each article sits inside <div class="epn_white_box epn_item"> with a
 * <h3><a href="..." title="Clean title">...</a></h3> and a sibling
 * <div class="epn_time">…relative timestamp…</div> inside.
 */
function extractArticles(html) {
  const articles = []

  const itemOpenPattern = /<div\s+class="[^"]*\bepn_item\b[^"]*"[^>]*>/gi
  const starts = []
  let m
  while ((m = itemOpenPattern.exec(html)) !== null) {
    starts.push(m.index)
  }
  starts.push(html.length)

  for (let i = 0; i < starts.length - 1; i++) {
    const block = html.slice(starts[i], starts[i + 1])

    const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    if (!h3Match) continue

    const anchorMatch = h3Match[1].match(/<a\s+([^>]*)>([\s\S]*?)<\/a>/i)
    if (!anchorMatch) continue

    const attrs = anchorMatch[1]
    const hrefMatch = attrs.match(/href="([^"]+)"/i)
    if (!hrefMatch) continue
    const href = hrefMatch[1].trim()
    if (!href) continue

    const titleAttrMatch = attrs.match(/title="([^"]+)"/i)
    let title = titleAttrMatch ? decodeHtmlEntities(titleAttrMatch[1]).trim() : ''
    if (!title) {
      title = decodeHtmlEntities(stripHtmlTags(anchorMatch[2])).replace(/\s+/g, ' ').trim()
    }

    if (!title) continue

    const timeMatch = block.match(/<div\s+class="[^"]*\bepn_time\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const timeText = timeMatch
      ? decodeHtmlEntities(stripHtmlTags(timeMatch[1])).replace(/\s+/g, ' ').trim()
      : ''
    const article_date = parseRelativeDate(timeText)

    articles.push({ title, article_url: href, article_date })
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
    if (error) { console.error(`[EndpointsScan] Error loading companies_directory: ${error.message}`); break }
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
    if (error) { console.error(`[EndpointsScan] Error loading companies_alternate_names: ${error.message}`); break }
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
      .from('endpoint_news')
      .select('article_url')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[EndpointsScan] Error loading existing articles: ${error.message}`); break }
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
    const { error } = await supabase.from('endpoint_news').insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from('endpoint_news').insert(row)
        if (rowErr) {
          console.error(`[EndpointsScan] Insert error for ${row.article_url}: ${rowErr.message}`)
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

async function main() {
  console.log(`[EndpointsScan] Mode: ${mode}, URLs: ${URLS.length}`)

  // Scrape each URL and dedupe by article_url across pages
  const seenUrls = new Set()
  const articles = []

  for (let i = 0; i < URLS.length; i++) {
    const url = URLS[i]
    if (i > 0) await sleep(FETCH_DELAY_MS)

    console.log(`[EndpointsScan] Scraping: ${url}`)
    let html
    try {
      html = await fetchPage(url)
    } catch (err) {
      console.error(`[EndpointsScan] Fetch error for ${url}: ${err.message}`)
      continue
    }

    const pageArticles = extractArticles(html)
    for (const article of pageArticles) {
      if (seenUrls.has(article.article_url)) continue
      seenUrls.add(article.article_url)
      articles.push(article)
    }
  }

  const [existingUrls, companyNames, alternateNames] = await Promise.all([
    loadExistingUrls(),
    loadCompanyNames(),
    loadAlternateNames(),
  ])
  console.log(`[EndpointsScan] ${existingUrls.size} existing articles loaded`)
  const matcher = buildNewsMatcher(companyNames, alternateNames)
  console.log(`[EndpointsScan] ${matcher.size} company name patterns loaded for matching (${companyNames.length} directory names, ${alternateNames.length} alternate names)`)

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
      console.log(`[EndpointsScan] Matched: "${article.title}" → ${matched.join(', ')}`)
    } else {
      article.matched_names = null
    }

    console.log(`[EndpointsScan] Found: ${article.title} — ${article.article_url}`)
    toInsert.push(article)
  }

  const insertResult = await batchInsert(toInsert)

  console.log(`[EndpointsScan] Scan complete: ${articles.length} articles found, ${insertResult.inserted} new, ${skipped} already existed`)
  if (insertResult.errors > 0) {
    console.warn(`[EndpointsScan] ${insertResult.errors} insert errors`)
  }
}

main().catch((err) => {
  console.error('[EndpointsScan] Unhandled error:', err)
  process.exit(1)
})
