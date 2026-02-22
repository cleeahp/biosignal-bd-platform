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
 *   • Rate limiting: configurable request budget (default 60); randomised
 *     delays of 15–45 s between requests; extended 60–90 s break every
 *     10 requests.
 *   • Stops immediately on HTTP 429 (rate limited) or 999 (bot detected)
 *     without retry.
 *   • The li_at cookie is held in-memory for the lifetime of one
 *     LinkedInClient instance and is NEVER written to disk or database.
 *   • The client is intentionally short-lived — create a new instance per run.
 *
 * Usage:
 *   const client = createLinkedInClient(60)   // returns null if LINKEDIN_LI_AT not set
 *   if (client) {
 *     const jobs = await client.searchJobs('clinical trial coordinator', 'Actalent')
 *   }
 */

import * as cheerio from 'cheerio';

// ── Constants ──────────────────────────────────────────────────────────────────

const LINKEDIN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Standard delay between search requests: 20–45 s
const SEARCH_DELAY_MIN = 20_000;
const SEARCH_DELAY_MAX = 45_000;

// Fetch delay for individual job description pages: 8–20 s
const FETCH_DELAY_MIN = 8_000;
const FETCH_DELAY_MAX = 20_000;

// Extended break every 10 requests: 60–120 s
const BREAK_DELAY_MIN = 60_000;
const BREAK_DELAY_MAX = 120_000;

// Randomised Accept-Language variants to avoid fingerprinting
const ACCEPT_LANGUAGE_VARIANTS = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8,es;q=0.5',
  'en-US,en;q=0.9,en-GB;q=0.8',
];

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Fisher-Yates shuffle — returns a new array with elements in random order.
 * Exported so agents can shuffle their own lists.
 *
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Return a random integer in [min, max].
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
   * @param {string} liAt          The li_at session cookie value — NEVER logged
   * @param {number} requestLimit  Maximum GET requests for this session
   */
  constructor(liAt, requestLimit = 60) {
    this._liAt          = liAt;           // NEVER logged, printed, or returned
    this._requestLimit  = requestLimit;
    this._requestCount  = 0;
    this._stopped       = false;
    this._botDetected   = false;
  }

  // ── Read-only interceptor ────────────────────────────────────────────────────

  /**
   * Throw (and log CRITICAL error) if a mutating HTTP method is attempted.
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

  // ── Delay helpers ────────────────────────────────────────────────────────────

  /**
   * Wait for a human-like delay appropriate to the request type.
   *
   * @param {'search'|'fetch'|'break'} type
   */
  async _delayBetweenRequests(type) {
    let ms;
    if (type === 'break') {
      ms = randomBetween(BREAK_DELAY_MIN, BREAK_DELAY_MAX);
    } else if (type === 'fetch') {
      ms = randomBetween(FETCH_DELAY_MIN, FETCH_DELAY_MAX);
    } else {
      ms = randomBetween(SEARCH_DELAY_MIN, SEARCH_DELAY_MAX);
    }
    await new Promise((r) => setTimeout(r, ms));
  }

  // ── Rate-limited GET ─────────────────────────────────────────────────────────

  /**
   * Make a rate-limited, read-only GET request to LinkedIn using the li_at cookie.
   * Applies human-like delays and fires an extended break every 10 requests.
   * Returns null when the client is stopped (429/999/budget exhausted).
   *
   * @param {string}               url
   * @param {'search'|'fetch'}     type  Controls which delay is applied
   * @returns {Promise<Response|null>}
   */
  async get(url, type = 'search') {
    if (this._stopped) {
      console.log('[LinkedIn] Stopped — skipping request');
      return null;
    }
    if (this._requestCount >= this._requestLimit) {
      console.log(`[LinkedIn] Budget exhausted (${this._requestLimit} requests used) — stopping`);
      this._stopped = true;
      return null;
    }

    this._enforceReadOnly('GET');

    // Fire an extended break after every 10 completed requests
    if (this._requestCount > 0 && this._requestCount % 10 === 0) {
      console.log(`[LinkedIn] Taking a break after ${this._requestCount} requests...`);
      await this._delayBetweenRequests('break');
    } else {
      await this._delayBetweenRequests(type);
    }

    this._requestCount++;
    const acceptLanguage = ACCEPT_LANGUAGE_VARIANTS[
      Math.floor(Math.random() * ACCEPT_LANGUAGE_VARIANTS.length)
    ];

    console.log(`[LinkedIn] GET [${this._requestCount}/${this._requestLimit}]: ${url}`);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':                LINKEDIN_UA,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':           acceptLanguage,
          'Accept-Encoding':           'gzip, deflate, br',
          'Referer':                   'https://www.linkedin.com/',
          'DNT':                       '1',
          'Connection':                'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cookie':                    `li_at=${this._liAt}`,
        },
        signal:   AbortSignal.timeout(15000),
        redirect: 'follow',
      });

      if (resp.status === 999) {
        console.log('[LinkedIn] Bot detection triggered (999) — stopping all LinkedIn requests for today');
        this._botDetected = true;
        this._stopped     = true;
        return null;
      }

      if (resp.status === 429) {
        console.log('[LinkedIn] Rate limited (429) — stopping');
        this._stopped = true;
        return null;
      }

      return resp;
    } catch (err) {
      console.log(`[LinkedIn] GET failed: ${err.message}`);
      return null;
    }
  }

  // ── Job search (guest API) ────────────────────────────────────────────────────

  /**
   * Search LinkedIn Jobs via the public guest API.
   *
   * Uses the server-rendered endpoint:
   *   /jobs-guest/jobs/api/seeMoreJobPostings/search
   * This endpoint returns static HTML (not JS-rendered) so job cards are
   * parseable immediately with cheerio. It works without authentication but
   * we still send the li_at cookie and browser headers for consistency.
   *
   * @param {string}      keywords   Role-specific keywords
   * @param {string|null} [company]  Company name filter (Source A only)
   * @param {string}      [timeRange] LinkedIn f_TPR value; pass '' for no filter
   * @returns {Promise<Array<{title:string, company:string, location:string, jobUrl:string, daysPosted:number}>>}
   */
  async searchJobs(keywords, company = null, timeRange = 'r2592000') {
    if (this._stopped) return [];

    const queryKeywords = company ? `${company} ${keywords}` : keywords;
    const params = new URLSearchParams({
      keywords: queryKeywords,
      location: 'United States',
      start:    '0',
      sortBy:   'DD',
    });
    if (timeRange) params.set('f_TPR', timeRange);

    const url =
      `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;

    const resp = await this.get(url, 'search');
    if (!resp) return [];

    console.log(`[LinkedIn] Guest API HTTP ${resp.status} — query: '${queryKeywords}'`);
    if (!resp.ok) {
      console.log(`[LinkedIn] Guest API non-OK (${resp.status}) — skipping parse`);
      return [];
    }

    let html = '';
    try {
      html = await resp.text();
    } catch (err) {
      console.log(`[LinkedIn] Guest API: failed to read response body: ${err.message}`);
      return [];
    }

    console.log(`[LinkedIn] Guest API response: ${html.length} chars`);

    const jobs = this._parseGuestApiCards(html, company, queryKeywords);

    console.log(`[LinkedIn] Guest API: ${jobs.length} job cards found for query '${queryKeywords}'`);
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      console.log(
        `[LinkedIn] Guest API: job #${i + 1}: title='${j.title}', company='${j.company}', ` +
        `location='${j.location}', days=${j.daysPosted}, url='${j.jobUrl}'`
      );
    }

    if (jobs.length === 0) {
      console.warn(
        `[LinkedIn] Guest API: 0 cards found — response preview:\n${html.slice(0, 2000)}`
      );
    }

    return jobs;
  }

  // ── Guest API HTML parser ─────────────────────────────────────────────────────

  /**
   * Parse job cards from LinkedIn's guest API response HTML.
   *
   * The guest API returns a list of <li> elements each wrapping a
   * <div class="base-card"> (or similar). Selectors tried:
   *   Primary:  li > div.base-card  |  div.base-card (direct)
   *   Fallback: li elements with a .base-search-card__title descendant
   *
   * Field selectors:
   *   title:    .base-search-card__title  (also h3 variant)
   *   company:  .base-search-card__subtitle  (also h4 variant)
   *   location: .job-search-card__location
   *   date:     time[datetime]  → datetime attr → exact day count
   *   url:      a[href*="/jobs/view/"]  or  a.base-card__full-link
   *
   * @param {string}      html
   * @param {string|null} filterCompany
   * @param {string}      queryKeywords  For logging only
   * @returns {Array<{title, company, location, jobUrl, daysPosted}>}
   */
  _parseGuestApiCards(html, filterCompany, queryKeywords) {
    const jobs  = [];
    const today = Date.now();

    /** Days since a date string (YYYY-MM-DD); falls back to text parsing. */
    function daysFromTimeEl($el) {
      const dt = $el.attr('datetime') || $el.attr('data-datetime') || '';
      if (dt) {
        const ms = new Date(dt).getTime();
        if (!isNaN(ms)) return Math.max(0, Math.floor((today - ms) / 86400000));
      }
      return parseDaysAgo($el.text().trim());
    }

    /** Resolve href to absolute LinkedIn URL. */
    function toAbsolute(href) {
      if (!href) return '';
      return href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    }

    let $;
    try {
      $ = cheerio.load(html);
    } catch (err) {
      console.log(`[LinkedIn] Guest API: Cheerio parse failed: ${err.message}`);
      return [];
    }

    // The guest API returns one <li> per job; each contains a .base-card div.
    // Try the specific li selector first, then fall back to any .base-card.
    const liCount = $('li').length;
    const bcCount = $('.base-card').length;
    console.log(`[LinkedIn] Guest API: ${liCount} <li> elements, ${bcCount} .base-card elements`);

    // Build candidate set: prefer li wrappers, fall back to bare .base-card
    const candidates = liCount > 0 ? $('li') : $('.base-card');

    candidates.each((_, el) => {
      if (jobs.length >= 25) return;
      const $el = $(el);

      // Title — try specific selector first, then generic h3
      const title =
        $el.find('.base-search-card__title').first().text().trim() ||
        $el.find('h3.base-search-card__title').first().text().trim() ||
        $el.find('h3').first().text().trim();
      if (!title) return;

      // Company
      const company =
        $el.find('.base-search-card__subtitle').first().text().trim() ||
        $el.find('h4.base-search-card__subtitle').first().text().trim() ||
        $el.find('h4').first().text().trim() ||
        filterCompany || '';

      // Location
      const location =
        $el.find('.job-search-card__location').first().text().trim() ||
        $el.find('[class*="location"]').first().text().trim();

      // Job URL — prefer /jobs/view/ links, then .base-card__full-link, then first anchor
      const jobUrl = toAbsolute(
        $el.find('a[href*="/jobs/view/"]').first().attr('href') ||
        $el.find('a.base-card__full-link').first().attr('href') ||
        $el.find('a').first().attr('href') || ''
      );

      // Date posted
      const daysPosted = daysFromTimeEl($el.find('time').first());

      jobs.push({ title, company, location, jobUrl, daysPosted });
    });

    return jobs;
  }

  // ── Job description fetch (guest API) ─────────────────────────────────────────

  /**
   * Fetch a full job posting description via LinkedIn's guest API.
   * Uses the server-rendered endpoint which doesn't require authentication:
   *   /jobs-guest/jobs/api/jobPosting/{jobId}
   *
   * jobId is extracted from the job URL:
   *   https://www.linkedin.com/jobs/view/12345678 → 12345678
   *
   * @param {string} jobUrl  Full LinkedIn job URL
   * @returns {Promise<string>}  First 500 chars of visible text, or ''
   */
  async fetchJobDescription(jobUrl) {
    if (!jobUrl || this._stopped) return '';

    // Guest API URLs are slug-style: /jobs/view/title-slug-4371801116?position=1
    // The jobId is the last number in the path segment, before any query string.
    // Pattern 1: last dash-separated number before '?' or end of path
    // Pattern 2: numeric-only path segment (legacy /jobs/view/12345678 format)
    // Pattern 3: query param fallback
    const idMatch =
      jobUrl.match(/\/jobs\/view\/[^?]*-(\d+)(?:\?|$)/) ||
      jobUrl.match(/\/jobs\/view\/(\d+)(?:\?|$)/) ||
      jobUrl.match(/currentJobId=(\d+)/);
    if (!idMatch) {
      console.log(`[LinkedIn] fetchJobDescription: no jobId in URL: ${jobUrl}`);
      return '';
    }

    const jobId  = idMatch[1];
    const apiUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;

    try {
      const resp = await this.get(apiUrl, 'fetch');
      if (!resp?.ok) return '';
      const html = await resp.text();
      const $ = cheerio.load(html);
      $('script, style, nav, footer, header').remove();
      return $.text().replace(/\s+/g, ' ').trim().slice(0, 500);
    } catch (err) {
      console.log(`[LinkedIn] fetchJobDescription failed: ${err.message}`);
      return '';
    }
  }

  // ── Status accessors ─────────────────────────────────────────────────────────

  get isAvailable()   { return !this._stopped; }
  get botDetected()   { return this._botDetected; }
  get requestCount()  { return this._requestCount; }
  get requestsUsed()  { return this._requestCount; }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a LinkedIn client for one agent run using the LINKEDIN_LI_AT env var.
 * Returns null immediately if LINKEDIN_LI_AT is not configured.
 * Callers must check for null before using.
 *
 * @param {number} [requestLimit=60]  Max GET requests allowed for this session
 * @returns {LinkedInClient|null}
 */
export function createLinkedInClient(requestLimit = 60) {
  const liAt = process.env.LINKEDIN_LI_AT;
  if (!liAt) {
    console.log('[LinkedIn] LINKEDIN_LI_AT not configured — skipping LinkedIn sources');
    return null;
  }
  console.log(
    `[LinkedIn] Session ready — budget: ${requestLimit} requests, ` +
    `delays: 15-45s standard, 60-90s every 10 requests`
  );
  return new LinkedInClient(liAt, requestLimit);
}
