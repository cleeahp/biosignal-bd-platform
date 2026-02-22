/**
 * LinkedIn Client — Read-Only Session Manager
 *
 * SECURITY CONTRACT (non-negotiable):
 *   • Credentials are read from LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars only.
 *     They are NEVER logged, printed, included in responses, or stored.
 *   • Only GET requests to linkedin.com are permitted after login.
 *     Any attempt to call a mutating method (POST/PUT/DELETE/PATCH) via get()
 *     throws immediately and logs a CRITICAL error.
 *   • Rate limiting: max 10 requests per agent run; 3–8 s randomised delay
 *     between each request; hard 1-req/s cap enforced by the delay floor.
 *   • Stops immediately on HTTP 429 (rate limited) or 999 (bot detected)
 *     without retry.
 *   • Cookies are held in-memory for the lifetime of one LinkedInClient
 *     instance and are NEVER written to disk or database.
 *   • The session is intentionally short-lived — create a new client per run.
 *
 * Usage:
 *   const client = await createLinkedInClient()   // returns null if no creds
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
 * Update a cookie jar (Map<name, value>) from Set-Cookie response headers.
 * Only stores name=value — attributes (Domain, Path, HttpOnly, etc.) are ignored.
 *
 * @param {string[]} setCookieHeaders
 * @param {Map<string, string>} jar
 */
function applySetCookies(setCookieHeaders, jar) {
  for (const header of setCookieHeaders) {
    const [nameValue] = header.split(';');
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx < 0) continue;
    const name  = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    if (name) jar.set(name, value);
  }
}

/**
 * Serialise a cookie jar into a Cookie header string.
 *
 * @param {Map<string, string>} jar
 * @returns {string}
 */
function jarToCookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Extract Set-Cookie values from a Fetch Response, compatible with Node 18+
 * (which exposes getSetCookie()) and older runtimes that only expose a single
 * 'set-cookie' string.
 *
 * @param {Response} resp
 * @returns {string[]}
 */
function getSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  const raw = resp.headers.get('set-cookie');
  return raw ? [raw] : [];
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
  constructor() {
    /** @type {Map<string, string>} In-memory cookie jar — never persisted */
    this._jar            = new Map();
    this._requestCount   = 0;
    this._stopped        = false;
    this._loggedIn       = false;
    this._lastLoginMethod = null;   // set on successful login
    this._lastRequest    = 0;   // epoch ms of last request (1 req/s hard cap)
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
   * Make a rate-limited, read-only GET request to LinkedIn.
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
      const cookieHeader = jarToCookieHeader(this._jar);
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':      LINKEDIN_UA,
          Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer:           'https://www.linkedin.com/',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
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

      applySetCookies(getSetCookies(resp), this._jar);
      return resp;
    } catch (err) {
      console.log(`[LinkedIn] GET failed: ${err.message}`);
      return null;
    }
  }

  // ── Login ────────────────────────────────────────────────────────────────────

  /**
   * Shared helper: fetch the LinkedIn login page, populate the cookie jar,
   * and return { html, loginCsrfParam }.
   *
   * @returns {Promise<{html: string, loginCsrfParam: string}>}
   */
  async _fetchLoginPage() {
    const resp = await fetch('https://www.linkedin.com/login', {
      headers: {
        'User-Agent':      LINKEDIN_UA,
        Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal:   AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!resp.ok) {
      throw new Error(`login page returned HTTP ${resp.status}`);
    }

    applySetCookies(getSetCookies(resp), this._jar);
    const html = await resp.text();

    // Extract loginCsrfParam from hidden form input
    const m = html.match(/name="loginCsrfParam"\s+value="([^"]+)"/)
           || html.match(/"loginCsrfParam"\s*:\s*"([^"]+)"/);
    return { html, loginCsrfParam: m?.[1] || '' };
  }

  /**
   * Method 1 (current LinkedIn flow):
   * POST to /checkpoint/lg/login-submit with loginCsrfParam.
   * This is the endpoint LinkedIn's login form targets as of 2024-2026.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async _loginViaCheckpoint(email, password) {
    const { loginCsrfParam } = await this._fetchLoginPage();

    const body = new URLSearchParams({
      session_key:                  email,
      session_password:             password,
      loginCsrfParam,
      ac:                           '2',
      sIdString:                    '',
      parentPageKey:                'd_flagship3_login',
      pageInstance:                 'urn:li:page:d_flagship3_login',
      trk:                          'guest_homepage-basic_sign-in-submit-btn',
      authUUID:                     '',
      session_redirect:             '',
      tryRandomRememberedAccount:   'false',
      login_submit:                 '',
    });

    const cookieHeader = jarToCookieHeader(this._jar);
    console.log('[LinkedIn] Method 1: POST /checkpoint/lg/login-submit');

    const loginResp = await fetch('https://www.linkedin.com/checkpoint/lg/login-submit', {
      method: 'POST',
      headers: {
        'User-Agent':     LINKEDIN_UA,
        'Content-Type':   'application/x-www-form-urlencoded',
        Accept:           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'en-US,en;q=0.9',
        Referer:          'https://www.linkedin.com/login',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body:     body.toString(),
      signal:   AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    applySetCookies(getSetCookies(loginResp), this._jar);

    if (this._jar.has('li_at')) {
      console.log('[LinkedIn] Method 1 succeeded');
      this._lastLoginMethod = 'checkpoint';
      return true;
    }

    // Detect verification/challenge redirect — account needs manual action
    const finalUrl = loginResp.url || '';
    if (/checkpoint|challenge|verify|authwall/i.test(finalUrl)) {
      console.log(`[LinkedIn] Method 1: redirected to verification page (${finalUrl}) — account may need manual verification`);
    } else {
      console.log(`[LinkedIn] Method 1: li_at not in response (HTTP ${loginResp.status}, url=${finalUrl})`);
    }
    return false;
  }

  /**
   * Method 2 (legacy fallback):
   * POST to /uas/login — the older endpoint that was replaced by /checkpoint/lg/login-submit.
   * Some accounts or LinkedIn environments still respond to this endpoint.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async _loginViaUas(email, password) {
    // Fresh login-page fetch for this attempt (gets a new JSESSIONID)
    const { loginCsrfParam } = await this._fetchLoginPage();

    const body = new URLSearchParams({
      session_key:      email,
      session_password: password,
      loginCsrfParam,
      csrfToken:        loginCsrfParam,
      ac:               '2',
      sIdString:        '',
      parentPageKey:    'd_flagship3_login',
      pageInstance:     'urn:li:page:d_flagship3_login',
      trk:              'guest_homepage-basic_sign-in-submit-btn',
    });

    const cookieHeader = jarToCookieHeader(this._jar);
    console.log('[LinkedIn] Method 2: POST /uas/login');

    const loginResp = await fetch('https://www.linkedin.com/uas/login', {
      method: 'POST',
      headers: {
        'User-Agent':   LINKEDIN_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:         'text/html,application/xhtml+xml',
        Referer:        'https://www.linkedin.com/login',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body:     body.toString(),
      signal:   AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    applySetCookies(getSetCookies(loginResp), this._jar);

    if (this._jar.has('li_at')) {
      console.log('[LinkedIn] Method 2 succeeded');
      this._lastLoginMethod = 'uas/login';
      return true;
    }

    console.log(`[LinkedIn] Method 2: li_at not in response (HTTP ${loginResp.status})`);
    return false;
  }

  /**
   * Log into LinkedIn using credentials from environment variables.
   * Tries two login endpoints in order; if both fail logs a clear diagnostic.
   * Credentials are read exactly once and NEVER stored, logged, or included
   * in any response body.
   *
   * Both login POSTs are intentional exceptions to the read-only rule —
   * required for authentication only; no content interactions are made.
   *
   * @returns {Promise<boolean>} true if login succeeded
   */
  async login() {
    const email    = process.env.LINKEDIN_EMAIL;
    const password = process.env.LINKEDIN_PASSWORD;

    if (!email || !password) {
      console.log('[LinkedIn] Credentials not configured (LINKEDIN_EMAIL / LINKEDIN_PASSWORD) — skipping LinkedIn sources');
      this._stopped = true;
      return false;
    }

    // Method 1: /checkpoint/lg/login-submit (current LinkedIn flow, 2024-2026)
    try {
      const ok = await this._loginViaCheckpoint(email, password);
      if (ok) { this._loggedIn = true; return true; }
    } catch (err) {
      console.log(`[LinkedIn] Method 1 error: ${err.message}`);
    }

    // Method 2: /uas/login (legacy endpoint, still works for some accounts)
    try {
      const ok = await this._loginViaUas(email, password);
      if (ok) { this._loggedIn = true; return true; }
    } catch (err) {
      console.log(`[LinkedIn] Method 2 error: ${err.message}`);
    }

    // All methods exhausted
    console.log(
      '[LinkedIn] All login methods failed — li_at not received. ' +
      'Check credentials in Vercel env vars or LinkedIn may require ' +
      'manual verification. Skipping LinkedIn sources this run.'
    );
    this._stopped = true;
    return false;
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
    if (this._stopped || !this._loggedIn) return [];

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

  get isAvailable()     { return this._loggedIn && !this._stopped; }
  get requestCount()    { return this._requestCount; }
  get lastLoginMethod() { return this._lastLoginMethod; }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create and log into a LinkedIn client for one agent run.
 * Returns null immediately if LINKEDIN_EMAIL or LINKEDIN_PASSWORD are not set,
 * or if login fails. Callers must check for null before using.
 *
 * @returns {Promise<LinkedInClient|null>}
 */
export async function createLinkedInClient() {
  if (!process.env.LINKEDIN_EMAIL || !process.env.LINKEDIN_PASSWORD) {
    console.log('[LinkedIn] Credentials not configured (LINKEDIN_EMAIL / LINKEDIN_PASSWORD) — skipping LinkedIn sources');
    return null;
  }

  try {
    const client = new LinkedInClient();
    const ok = await client.login();
    return ok ? client : null;
  } catch (err) {
    console.log(`[LinkedIn] Client initialisation failed: ${err.message} — skipping LinkedIn sources`);
    return null;
  }
}
