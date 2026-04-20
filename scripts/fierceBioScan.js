/**
 * FierceBiotech Scan
 *
 * Scrapes the FierceBiotech "cell-gene-therapy" keyword feed and stores new
 * articles in the fiercebio_news Supabase table. Dedups by article_url.
 *
 * Usage:
 *   node scripts/fierceBioScan.js --mode daily
 *   node scripts/fierceBioScan.js --mode manual
 *
 * Both modes scrape the same page and insert any articles not already in
 * the database. The distinction exists for consistency with other scripts.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FierceBioScan] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const SOURCE_URL = 'https://www.fiercebiotech.com/keyword/cell-gene-therapy'
const BASE_URL = 'https://www.fiercebiotech.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const modeIdx = args.indexOf('--mode')
const mode = modeIdx !== -1 ? args[modeIdx + 1] : null

if (!mode || !['daily', 'manual'].includes(mode)) {
  console.error('Usage: node scripts/fierceBioScan.js --mode <daily|manual>')
  process.exit(1)
}

// ── HTML helpers ────────────────────────────────────────────────────────────

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
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
 * Parse a date string like "Apr 20, 2026 10:15am" or "Apr 20, 2026"
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
 * Extract articles from the FierceBiotech keyword page HTML.
 * Each article is rooted at an <h3 class="element-title ..."><a href="...">TITLE</a></h3>
 * and the publication date follows somewhere after in the same card block as
 * <span class="date d-inline-block">Apr 20, 2026 10:15am</span>.
 */
function extractArticles(html) {
  const articles = []

  const h3Pattern = /<h3\s+class="element-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi
  const titleMatches = []
  let match
  while ((match = h3Pattern.exec(html)) !== null) {
    titleMatches.push({ index: match.index, endIndex: h3Pattern.lastIndex, inner: match[1] })
  }

  for (let i = 0; i < titleMatches.length; i++) {
    const { endIndex, inner } = titleMatches[i]

    const anchorMatch = inner.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!anchorMatch) continue

    let href = anchorMatch[1].trim()
    if (href.startsWith('/')) href = BASE_URL + href

    const title = decodeHtmlEntities(stripHtmlTags(anchorMatch[2])).replace(/\s+/g, ' ').trim()
    if (!title || !href) continue

    // Search for the nearest date span between this title and the next title
    const nextStart = i + 1 < titleMatches.length ? titleMatches[i + 1].index : html.length
    const windowHtml = html.substring(endIndex, nextStart)

    let articleDate = null
    const dateMatch = windowHtml.match(/<span\s+class="date\s+d-inline-block"[^>]*>([\s\S]*?)<\/span>/i)
    if (dateMatch) {
      const rawDate = decodeHtmlEntities(stripHtmlTags(dateMatch[1]))
      articleDate = parseArticleDate(rawDate)
    }

    articles.push({ title, article_url: href, article_date: articleDate })
  }

  return articles
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadExistingUrls() {
  const urls = new Set()
  const PAGE = 1000
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('fiercebio_news')
      .select('article_url')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error(`[FierceBioScan] Error loading existing articles: ${error.message}`); break }
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
    const { error } = await supabase.from('fiercebio_news').insert(batch)

    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await supabase.from('fiercebio_news').insert(row)
        if (rowErr) {
          console.error(`[FierceBioScan] Insert error for ${row.article_url}: ${rowErr.message}`)
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
  console.log(`[FierceBioScan] Mode: ${mode}, URL: ${SOURCE_URL}`)

  const html = await fetchPage(SOURCE_URL)
  const articles = extractArticles(html)

  const existingUrls = await loadExistingUrls()
  console.log(`[FierceBioScan] ${existingUrls.size} existing articles loaded`)

  const toInsert = []
  let skipped = 0

  for (const article of articles) {
    if (existingUrls.has(article.article_url)) {
      skipped++
      continue
    }
    existingUrls.add(article.article_url)
    console.log(`[FierceBioScan] Found: ${article.title} (${article.article_date || 'unknown date'}) — ${article.article_url}`)
    toInsert.push(article)
  }

  const insertResult = await batchInsert(toInsert)

  console.log(`[FierceBioScan] Scan complete: ${articles.length} articles found, ${insertResult.inserted} new, ${skipped} already existed`)
  if (insertResult.errors > 0) {
    console.warn(`[FierceBioScan] ${insertResult.errors} insert errors`)
  }
}

main().catch((err) => {
  console.error('[FierceBioScan] Unhandled error:', err)
  process.exit(1)
})
