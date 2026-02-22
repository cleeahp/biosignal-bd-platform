/**
 * LinkedIn Client — Read-Only Session Manager
 *
 * SECURITY CONTRACT (non-negotiable):
 *   • The li_at session cookie is read from LINKEDIN_LI_AT env var only.
 *     It is NEVER logged, printed, included in responses, or stored anywhere
 *     other than memory for the duration of one agent run.
 *   • Only GET requests to linkedin.com are permitted.
 *     Any attempt to call a mutating method (POST/PUT/DELETE/PATCH) via get()
 *     throws immediately and logs a CRITICAL error.
 *   • Rate limiting: max 10 requests per agent run; 3–8 s randomised delay
 *     between each request; hard 1-req/s cap enforced by the delay floor.
 *   • Stops immediately on HTTP 429 (rate limited) or 999 (bot detected)
 *     without retry.
 *   • The li_at cookie is held in-memory for the lifetime of one
 *     LinkedInClient instance and is NEVER written to disk or database.
 *   • The client is intentionally short-lived — create a new instance per run.
 *
 * Usage:
 *   const client = createLinkedInClient()   // returns null if LINKEDIN_LI_AT not set
 *   if (client) {
 *     const jobs = await client.searchJobs('clinical trial coordinator', 'Actalent')
 *   }
 */

import * as cheerio from 'cheerio';

// ── Constants ──────────────────────────────────────────────────────────────────

const LINKEDIN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_REQUESTS_PER_RUN = 10;
const MIN_DELAY_MS         = 3000;
const MAX_DELAY_MS         = 8000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

/**
 * Parse a relative/fuzzy date string into approximate days-ago count.
 * e.g. "2 weeks ago" → 14, "1 month ago" → 30, "3 days ago" → 3
 *
 * @param {string} text
 * @returns {number}
 */
function parseDaysAgo(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const dM = lower.match(/(\d+)\s+day/);    if (dM)  return parseInt(dM[1]);
  const wM = lower.match(/(\d+)\s+week/);   if (wM)  return parseInt(wM[1]) * 7;
  const mM = lower.match(/(\d+)\s+month/);  if (mM)  return parseInt(mM[1]) * 30;
  if (/just now|just posted|today/.test(lower)) return 0;
  return 0;
}

// ── LinkedInClient class ───────────────────────────────────────────────────────

export class LinkedInClient {
  /**
   * @param {string} liAt  The li_at session cookie value — NEVER logged or exposed
   */
  constructor(liAt) {
    this._liAt         = liAt;  // NEVER logged, printed, or included in any response
    this._requestCount = 0;
    this._stopped      = false;
    this._lastRequest  = 0;     // epoch ms of last request (1 req/s hard cap)
  }

  // ── Read-only interceptor ────────────────────────────────────────────────────

  /**
   * Throw (and log CRITICAL error) if a mutating HTTP method is attempted.
   * This is the request interceptor enforcing the read-only contract.
   *
   * @param {string} method
   */
  _enforceReadOnly(method) {
    const upper = (method || '').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(upper)) {
      const msg = `[LinkedIn] CRITICAL: mutating request intercepted and blocked — ${upper} to linkedin.com is not permitted`;
      console.error(msg);
      throw new Error(msg);
    }
  }

  // ── Rate-limited GET ─────────────────────────────────────────────────────────

  /**
   * Make a rate-limited, read-only GET request to LinkedIn using the li_at cookie.
   * Returns null when the client is stopped (429/999/limit reached).
   *
   * @param {string} url
   * @returns {Promise<Response|null>}
   */
  async get(url) {
    if (this._stopped) {
      console.log('[LinkedIn] Stopped — skipping request');
      return null;
    }
    if (this._requestCount >= MAX_REQUESTS_PER_RUN) {
      console.log('[LinkedIn] Max request limit reached — stopping LinkedIn requests for this run');
      this._stopped = true;
      return null;
    }

    this._enforceReadOnly('GET'); // explicit check even though method is fixed

    // Enforce randomised delay (3–8 s) + hard 1-req/s floor
    const sinceLastMs = Date.now() - this._lastRequest;
    const delay = Math.max(randomDelay(), 1000 - sinceLastMs);
    await new Promise((r) => setTimeout(r, delay));

    this._requestCount++;
    this._lastRequest = Date.now();
    console.log(`[LinkedIn] GET [${this._requestCount}/${MAX_REQUESTS_PER_RUN}]: ${url}`);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':                LINKEDIN_UA,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':           'en-US,en;q=0.5',
          'Accept-Encoding':           'gzip, deflate, br',
          'Referer':                   'https://www.linkedin.com/',
          'DNT':                       '1',
          'Connection':                'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cookie':                    `li_at=${this._liAt}`,
        },
        signal:   AbortSignal.timeout(10000),
        redirect: 'follow',
      });

      // Stop immediately on rate-limit or bot-detection responses
      if (resp.status === 429 || resp.status === 999) {
        console.log(`[LinkedIn] Rate limited (HTTP ${resp.status}) — stopping LinkedIn requests for this run`);
        this._stopped = true;
        return null;
      }

      return resp;
    } catch (err) {
      console.log(`[LinkedIn] GET failed: ${err.message}`);
      return null;
    }
  }

  // ── Job search ───────────────────────────────────────────────────────────────

  /**
   * Search LinkedIn Jobs for life sciences roles.
   * Optionally scoped to a specific company (for competitor sourcing).
   *
   * @param {string} keywords  Role-specific keywords
   * @param {string} [company] Company name filter (Source A only)
   * @returns {Promise<Array<{title:string, company:string, location:string, jobUrl:string, daysPosted:number}>>}
   */
  async searchJobs(keywords, company) {
    if (this._stopped) return [];

    const params = new URLSearchParams({
      keywords: company ? `${company} ${keywords}` : keywords,
      location: 'United States',
      f_TPR:    'r2592000', // last 30 days
      sortBy:   'DD',
    });
    const url = `https://www.linkedin.com/jobs/search/?${params.toString()}`;

    const resp = await this.get(url);
    if (!resp || !resp.ok) return [];

    let html = '';
    try {
      html = await resp.text();
    } catch {
      return [];
    }

    return this._parseJobCards(html, company);
  }

  // ── HTML parsing ─────────────────────────────────────────────────────────────

  /**
   * Parse job cards from a LinkedIn jobs search HTML response.
   * Tries JSON-LD schema first (most reliable), then HTML card patterns.
   *
   * @param {string} html
   * @param {string} [filterCompany] Preferred company name for display
   * @returns {Array<{title, company, location, jobUrl, daysPosted}>}
   */
  _parseJobCards(html, filterCompany) {
    const jobs = [];

    // ── Strategy 1: JSON-LD JobPosting schema ───────────────────────────────
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const schema = JSON.parse(m[1]);
        const items =
          schema['@type'] === 'JobPosting'
            ? [schema]
            : (schema['@graph'] || []).filter((x) => x['@type'] === 'JobPosting');
        for (const item of items) {
          if (jobs.length >= 5) break;
          const title   = item.title || item.name || '';
          if (!title) continue;
          const company  = item.hiringOrganization?.name || filterCompany || '';
          const loc      = item.jobLocation?.address?.addressLocality  || '';
          const region   = item.jobLocation?.address?.addressRegion    || '';
          const location = [loc, region].filter(Boolean).join(', ');
          const datePosted = item.datePosted || '';
          const daysPosted = datePosted
            ? Math.floor((Date.now() - new Date(datePosted).getTime()) / 86400000)
            : 0;
          jobs.push({ title, company, location, jobUrl: item.url || item.sameAs || '', daysPosted });
        }
      } catch { /* invalid JSON-LD */ }
    }
    if (jobs.length > 0) return jobs;

    // ── Strategy 2: Cheerio HTML card parsing ───────────────────────────────
    try {
      const $ = cheerio.load(html);
      $('[class*="job-search-card"], [class*="result-card"], .base-card, li[class*="job"]').each((_, el) => {
        if (jobs.length >= 5) return;
        const $el = $(el);
        const title = $el.find('[class*="job-title"], h3, h2').first().text().trim();
        if (!title) return;
        const company  = $el.find('[class*="company"], [class*="employer"]').first().text().trim() || filterCompany || '';
        const location = $el.find('[class*="location"], [class*="city"]').first().text().trim();
        const dateText = $el.find('[class*="date"], [class*="posted"], time').first().text().trim();
        const href     = $el.find('a').first().attr('href') || '';
        const jobUrl   = href.startsWith('http') ? href : href ? `https://www.linkedin.com${href}` : '';
        jobs.push({ title, company, location, jobUrl, daysPosted: parseDaysAgo(dateText) });
      });
    } catch { /* cheerio parse error */ }

    return jobs;
  }

  // ── Status accessors ─────────────────────────────────────────────────────────

  get isAvailable()  { return !this._stopped; }
  get requestCount() { return this._requestCount; }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a LinkedIn client for one agent run using the LINKEDIN_LI_AT env var.
 * Returns null immediately if LINKEDIN_LI_AT is not configured.
 * Callers must check for null before using.
 *
 * @returns {LinkedInClient|null}
 */
export function createLinkedInClient() {
  const liAt = process.env.LINKEDIN_LI_AT;
  if (!liAt) {
    console.log('[LinkedIn] LINKEDIN_LI_AT not configured — skipping LinkedIn sources');
    return null;
  }
  return new LinkedInClient(liAt);
}
