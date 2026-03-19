# BioSignal BD Platform — Architecture Reference

This document is the authoritative reference for every agent, library, API route, database table,
dashboard page, and automation in the BioSignal BD Platform. Keep it updated whenever any of
these components change.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Agents](#agents)
4. [Library Modules](#library-modules)
5. [API Routes](#api-routes)
6. [Database Tables](#database-tables)
7. [Dashboard Pages](#dashboard-pages)
8. [GitHub Actions Workflows](#github-actions-workflows)
9. [Environment Variables](#environment-variables)

---

## Project Overview

BioSignal is a BD intelligence platform for a life sciences staffing firm. It automatically
monitors clinical trial activity, funding events, M&A filings, and LinkedIn job postings to
surface high-probability sales signals — companies that are likely to need clinical research,
regulatory, biostatistics, or pharmacovigilance staffing in the near term.

Reps log in, review signals across four categories, claim the ones they want to pursue, and
track outreach progress through a My Leads pipeline. The platform also stores a contacts CRM
(past buyers, past candidates, other contacts) and a settings panel for dismissal rule management.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Next.js 14 (Pages Router), Tailwind CSS |
| Backend | Next.js API routes (serverless, deployed on Vercel) |
| Database | Supabase (Postgres) |
| Hosting | Vercel (web app + short-running API agents, max 300 s) |
| Scheduled jobs | GitHub Actions (long-running LinkedIn agents, max 120 min) |
| LinkedIn scraping | `LinkedInClient` class using the guest jobs API + cheerio HTML parsing |
| LLM inference | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) via `@anthropic-ai/sdk` |
| Module system | ESM (`"type": "module"`) throughout — no CommonJS |
| Runtime | Node.js 20 |

---

## Agents

There are five agents. Four do real work; one is a retired stub.

### How agents run

| Agent | Trigger | Runtime |
|---|---|---|
| Clinical Trial Monitor | Vercel (via orchestrator) | ≤300 s |
| Funding & M&A Agent | Vercel (via orchestrator) | ≤300 s |
| Target Company Jobs | Vercel (stub, no-op) | instant |
| Competitor Job Board | GitHub Actions nightly | up to 90 min |
| Stale Job Tracker | GitHub Actions nightly | up to 90 min |

The **orchestrator** (`agents/orchestrator.js`, called by `POST /api/agents/orchestrator`) runs
the Vercel agents in sequence and recalculates priority scores for all carried-forward signals.
The two LinkedIn agents run separately via `scripts/runJobAgents.js` on GitHub Actions because
their human-paced delays (15–45 s between requests) would exceed Vercel's 300-second function limit.

---

### Agent 1 — Clinical Trial Monitor

**File:** `agents/clinicalTrialMonitor.js`
**API route:** `POST /api/agents/clinical-trial-monitor`
**Trigger:** Vercel orchestrator (button or scheduled)

#### What it does

Polls the ClinicalTrials.gov v2 REST API for INDUSTRY-sponsored studies updated in the last
14 days. Generates BD signals when a study reaches Phase 2 or Phase 3, or when a new Phase 1
study was first posted within the last 14 days.

#### Data source

- **ClinicalTrials.gov v2 API** — `https://clinicaltrials.gov/api/v2/studies`
- Pre-filters to `aggFilters=studyType:int,sponsorClass:INDUSTRY` at the API query level
- Fetches up to 2 pages × 100 studies per run (200 studies max)

#### Signal types created

| Signal type | Base score | Condition |
|---|---|---|
| `clinical_trial_phase_transition` | 30 | Study is Phase 2 or Phase 3, INDUSTRY sponsor |
| `clinical_trial_new_ind` | 22 | Pure Phase 1, first posted ≤14 days ago, INDUSTRY sponsor |

#### Key filtering logic

- **Academic/government filter:** Sponsor names matching a regex of 40+ university, hospital,
  government, and academic patterns are rejected even if `LeadSponsorClass === 'INDUSTRY'`.
  Pattern: universities, colleges, hospitals, NIH, NCI, CDC, VA, Mayo Clinic, Sloan Kettering, etc.
- **Phase filter:** Only Phase 2 and Phase 3 are eligible for `phase_transition`. Phase 1 is
  only eligible for `new_ind` if first posted within 14 days. Phase 4 and pre-clinical are skipped.
- **Phase-to filter:** Signals where `phase_to` is `?`, `NA`, or `N/A` are filtered out in the UI.
- **Company exclusion:** `isExcludedCompany()` skips companies in `excluded_companies`
  (large employers with 10,001+ LinkedIn members), unless they are past clients.
- **Past client boost:** `matchPastClient()` adds +8 to +15 to the priority score.
- **Dismissal rules:** `checkDismissalExclusion()` skips signals matching auto-exclude rules.
- **Deduplication:** Signals are keyed on `(company_id, signal_type, nct_id)`. Existing active
  signals are updated (score recalculated) rather than duplicated.

---

### Agent 2 — Funding & M&A Agent

**File:** `agents/fundingMaAgent.js`
**API route:** `POST /api/agents/funding-ma`
**Trigger:** Vercel orchestrator

#### What it does

Monitors four funding sources for INDUSTRY life sciences companies. Emits BD signals for
NIH grants, SEC-reported M&A filings, BioSpace pharma deals, and BioSpace venture rounds.

#### Data sources

| Source | What it tracks | Lookback |
|---|---|---|
| NIH Reporter API | SBIR/STTR grants to small businesses | 180 days |
| SEC EDGAR 8-K search | M&A filings — acquirer + acquired | 180 days |
| BioSpace /deals/ | Pharma partnerships, licensing, collaborations | scrapes recent articles |
| BioSpace /funding/ | Venture capital, IPOs, Series A/B/C raises | scrapes recent articles |

#### Signal types created

| Signal type | Source | Condition |
|---|---|---|
| `funding_new_award` (government_grant) | NIH Reporter | SBIR/STTR award, INDUSTRY company |
| `ma_transaction` | SEC EDGAR 8-K | Acquisition, merger, partnership, product acquisition, or IPO |
| `funding_new_award` (pharma_partnership) | BioSpace /deals/ | Licensing or collaboration deal |
| `funding_new_award` (venture_capital) | BioSpace /funding/ | Series round or venture raise |
| `funding_new_award` (ipo) | BioSpace /funding/ | IPO filing |
| `funding_renewal` | NIH Reporter | Renewal award to past-client company |

#### Key filtering logic

- **Academic/government filter:** Regex of 50+ academic and government patterns rejects
  universities, hospitals, NIH institutes, government agencies, and foundations.
- **Industry indicators:** SEC-sourced companies must contain at least one industry marker
  (Inc., Corp., LLC, Ltd., therapeutics, pharmaceuticals, biotech, etc.) as a second check.
- **Life sciences keyword filter:** SEC filings must mention pharma, biotech, therapeutics,
  CRO, or related terms in the company name or filing text.
- **Non-US filter:** Companies with country names, European legal suffixes (GmbH, AG, NV, BV),
  or non-US geographic signals are skipped — only US staffing opportunities are pursued.
- **VC fund filter:** Entity names containing "fund", "capital", "ventures", "partners",
  "management", or "investments" are rejected (they are the VC fund, not a portfolio company).
- **Company exclusion + past client boost:** Same logic as Clinical Trial Monitor.
- **Deduplication:** Keyed on `(company_id, signal_type, source_url)` for BioSpace/NIH;
  keyed on `(company_id, signal_type, filing_date + acquirer)` for EDGAR.

---

### Agent 3 — Competitor Job Board Agent

**File:** `agents/competitorJobBoardAgent.js`
**Script:** `scripts/runJobAgents.js` → `npm run run-job-agents`
**Trigger:** GitHub Actions nightly at 2:00 AM UTC (9 PM EST / 10 PM EDT)

#### What it does

Searches LinkedIn for jobs posted by 53 competitor life sciences staffing firms. Each job
represents a competitor placing a candidate — meaning a pharma/biotech end-client is actively
hiring. After collecting signals, uses Claude Haiku (via `llmClientInference.js`) to infer the
likely end-client company from the job description.

#### Data source

- **LinkedIn guest jobs API** — `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`
- Searches by competitor firm name + role keyword query
- **Request budget:** 60 requests per run
- **Rate limiting:** 20–45 s between searches; 60–120 s break every 10 requests; stops on HTTP 429 or 999

#### Competitor firms tracked (53 firms)

Actalent, Kelly, Alku, Black Diamond Networks, Real Life Sciences, Oxford Global Resources,
The Planet Group, Advanced Clinical, Randstad, Joule Staffing, Beacon Hill, Net2Source,
USTech Solutions, Yoh Services, Soliant Health, Medix, Epic Staffing Group, Solomon Page,
SpectraForce, Mindlance, Green Key Resources, Phaidon International, Peoplelink Group,
Pacer Staffing, ZP Group, Meet Staffing, Ampcus, ClinLab Staffing, Adecco, Manpower,
Hays, Insight Global, Planet Pharma, Proclinical, Real Staffing, GForce Life Sciences,
EPM Scientific, ClinLab Solutions Group, Sci.bio, Gemini Staffing Consultants, Orbis Clinical,
Scientific Search, TriNet Pharma, The Fountain Group, Hueman RPO, Surf Search,
Cornerstone Search Group, Smith Hanley Associates, Global Edge Recruiting, Clinnect,
BioPhase Solutions, Cowen Partners, Barrington James.

#### Signal type created

| Signal type | Base score |
|---|---|
| `competitor_job_posting` | 15 |

#### Key filtering logic

- **Role keyword filter:** `matchesRoleKeywords()` — job titles must match clinical research,
  regulatory, biostatistics, pharmacovigilance, or data management keywords. Internship and
  sales roles are excluded via `EXCLUDED_ROLE_PATTERNS`.
- **CRO filter:** Jobs posted by CRO companies (Syneos, IQVIA, ICON, Parexel, PPD, Labcorp,
  Fortrea, etc.) are skipped even if LinkedIn surfaces them — CROs are not staffing clients.
- **Non-US filter:** Jobs with non-US location strings (Canada, UK, Germany, etc.) are skipped.
- **Dismissal rules:** `checkDismissalExclusion()` skips signals matching auto-exclude rules
  for role_title and location.
- **URL deduplication:** Job URLs are normalised (query params stripped) and keyed on
  `(company_id, signal_type, source_url)` to avoid re-ingesting the same posting.
- **LLM inference:** After upsert, `batchInferClients()` uses Claude Haiku to predict the
  likely pharma/biotech end-client. Top prediction stored as `signal_detail.inferred_client`.

---

### Agent 4 — Stale Job Tracker

**File:** `agents/staleJobTracker.js`
**Script:** `scripts/runJobAgents.js`
**Trigger:** GitHub Actions nightly (same job as Competitor Job Board)

#### What it does

Searches LinkedIn for clinical research, regulatory, and related roles posted by actual
pharma/biotech companies (not staffing firms) that have been open for 30+ days. A stale
role signals that the company is struggling to fill the position — a direct sales opportunity.

#### Data source

- **LinkedIn guest jobs API** (same as Competitor Job Board)
- 60 pre-defined role+industry search queries, shuffled on every run
- Filters for postings ≥30 days old using LinkedIn's time-range filter
- **Request budget:** 80 requests per run

#### Signal type created

| Signal type | Base score | Condition |
|---|---|---|
| `stale_job_posting` | 15+ | Pharma/biotech role open 30+ days, non-US excluded |

#### Key filtering logic

- **Role keyword filter:** Same `matchesRoleKeywords()` + `EXCLUDED_ROLE_PATTERNS` as above.
- **CRO filter:** A much larger CRO list (50+ companies including Syneos, Fortrea, IQVIA,
  Parexel, PPD, Icon, Covance, Charles River, WuXi, Medpace, Halloran, Premier Research,
  Worldwide Clinical, Katalyst, Evolution Research, Seran Bioscience, etc.) are excluded.
  CRO jobs belong in `competitor_job_posting`, not `stale_job_posting`.
- **Staffing firm filter:** Jobs posted by any competitor firm (from the 53-firm list) are skipped.
- **Non-US filter:** Same `NON_US_LOCATION_PATTERNS` regex as Competitor Job Board.
- **Company exclusion + past client boost:** Same as Clinical Trial Monitor.
- **Dismissal rules:** Same as above.
- **URL deduplication + days threshold:** Only jobs with `daysPosted >= 30` are kept.
  URL normalisation prevents duplicates from tracking params.

---

### Agent 5 — Target Company Jobs (Retired Stub)

**File:** `agents/targetCompanyJobsAgent.js`
**Status:** No-op stub — previously scraped career pages (Greenhouse, Lever, BioSpace).
All non-LinkedIn signal paths were removed. The stub logs an `agent_runs` entry for
observability and returns `{ signalsFound: 0 }` immediately.

---

### Orchestrator

**File:** `agents/orchestrator.js`
**API route:** `POST /api/agents/orchestrator` (requires `Authorization: Bearer <AGENT_SECRET_TOKEN>`)

Runs the three active Vercel agents in sequence (Clinical → Funding → TargetCompanyJobs stub),
then recalculates priority scores for all carried-forward signals.

**Priority score formula:**

```
priority_score = min(signalStrength + recency + warmthScore + actionability + pastClientBoost, 100)
```

- `signalStrength`: from `score_breakdown.signal_strength` (base signal score, e.g. 30 for phase transition)
- `recency`: days-in-queue decay — starts at 25, drops 3/day for 7 days (floor 10), then gains 1 every 3 days (urgency bonus, cap 25)
- `warmthScore`: from `score_breakdown.relationship_warmth`
- `actionability`: from `score_breakdown.actionability`
- `pastClientBoost`: +8 to +15 based on past client priority rank (rank 1 = +15, rank 18 = +10, rank 19+ = +8 flat)

---

## Library Modules

### `lib/supabase.js`

Exports the shared Supabase service-role client (server-side) plus two shared utilities:

- **`supabase`** — `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — used by all agents and API routes
- **`normalizeCompanyName(name)`** — strips geographic qualifiers after a legal suffix
  (`"Merck & Co., Inc., Rahway, NJ, USA"` → `"Merck & Co., Inc."`), then title-cases each word
  while preserving short ALL-CAPS abbreviations (AG, NV, MD) and legal suffixes.
- **`upsertCompany(client, companyData)`** — check-then-insert pattern (no `ON CONFLICT`)
  because the unique index is a functional expression index on `lower(trim(name))` which
  Postgres `ON CONFLICT (name)` cannot match. On race-condition insert failure, retries the lookup.

---

### `lib/pastClientScoring.js`

- **`loadPastClients()`** — loads all `is_active = true` rows from `past_clients`, returns
  a `Map<lowercase_name, { name, priority_rank, boost_score, coreKeywords }>`.
  Boost formula: rank 1–18 → `Math.round(15 - ((rank-1)/17) * 5)` (+15 to +10); rank 19+ → +8 flat.
- **`matchPastClient(companyName, pastClientsMap)`** — three-tier fuzzy match:
  1. Exact lowercase key match
  2. Exact stripped match (legal + industry suffixes removed)
  3. Keyword match — all core keywords of the client appear in the signal name, or vice versa.
     Short words (≤4 chars) require word-boundary matching to avoid false positives.

---

### `lib/companyExclusion.js`

- **`loadExcludedCompanies()`** — loads all rows from `excluded_companies`, returns a `Set<lowercase_name>`.
- **`isExcludedCompany(name, excludedSet, pastClientsMap?)`** — checks prefix/suffix substring
  match after stripping legal suffixes. Past clients are **never** excluded, even if they appear
  in `excluded_companies`.

---

### `lib/dismissalRules.js`

- **`loadDismissalRules()`** — loads `auto_exclude = true` rows from `dismissal_rules`,
  returns a `Map<signal_type, [{ rule_type, rule_value }]>`.
- **`checkDismissalExclusion(rules, signalType, { company, role_title, location })`** — returns
  `{ excluded: true, rule_type, rule_value }` if any rule matches, otherwise `{ excluded: false }`.
  Matching is exact, case-insensitive.

---

### `lib/roleKeywords.js`

Shared role matching logic used by both LinkedIn agents.

- **`ROLE_KEYWORDS`** — 100+ exact role title strings across biostatistics, data management,
  CRA/CTM/CRC, quality/validation, statistical programming, SDTM/CDISC, EDC, drug safety/PV,
  regulatory affairs, medical writing, and HEOR.
- **`PARTIAL_ROLE_KEYWORDS`** — 15 partial-match strings (e.g. "Clinical Research", "Regulatory",
  "Biostat") that match any job title containing the substring.
- **`ROLE_KEYWORDS_REGEX`** — pre-compiled `RegExp` combining all of the above plus standalone
  abbreviation patterns (`\bCRA\b`, `\bCTM\b`, `\bSAS\b`, etc.).
- **`matchesRoleKeywords(text)`** — returns `true` if text matches any keyword.
- **`EXCLUDED_ROLE_PATTERNS`** — regex that matches intern, internship, co-op, student worker,
  sales rep, account executive, BDR, SDR, territory manager, and related sales/intern roles.
  Signals matching this pattern are always skipped.

---

### `lib/linkedinClient.js`

Read-only LinkedIn scraping client. **Security contract:** the `li_at` cookie is never logged,
stored to disk, or returned in any response. Only GET requests are allowed — mutating methods
throw immediately.

- **`createLinkedInClient(requestLimit?)`** — factory function; returns `null` if `LINKEDIN_LI_AT`
  is not set. Default budget: 60 requests.
- **`LinkedInClient`** class:
  - `get(url, type)` — rate-limited GET with human-like delays (20–45 s between searches,
    8–20 s between description fetches, 60–120 s break every 10 requests). Stops on HTTP 429 or 999.
  - `searchJobs(keywords, company?, timeRange?)` — searches the guest jobs API and parses
    job cards (title, company, location, jobUrl, daysPosted) using cheerio. Returns up to 25 results.
  - `fetchJobDescription(jobUrl)` — fetches the full job posting description (up to 2000 chars)
    from the guest API for competitor job signal descriptions.
  - `fetchHiringManager(jobUrl)` — attempts to extract the hiring manager name from the
    LinkedIn hiring team section of the job posting page.
- **`shuffleArray(arr)`** — Fisher-Yates shuffle; exported for agents to randomize query order.

---

### `lib/llmClientInference.js`

LLM-based end-client inference for competitor job signals. Best-effort — never blocks signal
creation if the API is unavailable or the response cannot be parsed.

- **`batchInferClients(signals)`** — takes an array of `{ id, job_title, job_description, competitor_firm, job_location }` objects, strips the competitor firm name from each description, sends batches of 10 to Claude Haiku, and returns a `Map<signal_id, [{ company, confidence, reasoning }]>`.
  The competitor firm name is never included as a prediction.
- **Model:** `claude-haiku-4-5-20251001`
- **Batch size:** 10 signals per API call
- Returns empty Map if `ANTHROPIC_API_KEY` is not set.

---

## API Routes

All routes are in `pages/api/` and use the Supabase **service-role key** (never the anon key).

### `GET /api/signals`

Returns all active signals (status in `new`, `carried_forward`, `claimed`, `contacted`),
joined with company data, ordered by `priority_score DESC`.

Response: `{ signals: [...], stats: { totalActive, newToday, claimed }, lastUpdated }`

Each signal includes: `companies.{ id, name, domain, industry, relationship_warmth }`.

---

### `PATCH /api/signals`

Updates a signal's status, claim, dismissal, notes, or inferred client.

Accepted fields: `id` (required), `status`, `claimed_by`, `claimed_at`, `notes`, `dismissal_reason`, `dismissal_value`, `inferred_client`.

Notes, dismissal info, inferred_client, and claimed_at are merged into `signal_detail` (JSONB)
rather than top-level columns. Status and `claimed_by` are top-level updates.

---

### `GET /api/leads`

Returns all rows from the `leads` table, enriched with `signal_detail` fetched in a
single batch query (not N+1). Optionally filtered by `?claimed_by=<name>`.

Response: `{ leads: [...] }` — each lead has all `leads` columns plus `signal_detail`.

---

### `POST /api/leads`

Creates a lead record when a rep claims a signal. Upserts on `signal_id` (no duplicates
if the same signal is claimed twice).

Required body: `{ signal_id, claimed_by }`.
Optional: `signal_type`, `company_name`, `signal_summary`, `claimed_at`.

---

### `PATCH /api/leads`

Updates a lead's `status` or `notes`.

Required body: `{ id }`. Optional: `status`, `notes`.

---

### `GET /api/contacts?table=<name>`

Returns all rows from one of three contact tables: `past_buyers`, `past_candidates`, `other_contacts`.

- `past_buyers` is sorted by `is_current_buyer DESC, last_name ASC`
- Others are sorted by `last_name ASC`

---

### `POST /api/contacts`

Moves a contact from one table to another (fetch → insert → delete). Handles duplicate-key
errors gracefully (already in destination → just delete from source).

Required body: `{ id, from_table, to_table }`.

---

### `DELETE /api/contacts`

Deletes a contact by id from the specified table.

Required body: `{ id, table }`.

---

### `POST /api/agents/orchestrator`

Triggers the Vercel orchestrator (Clinical + Funding + stub agents + priority recalculation).

- Requires `Authorization: Bearer <AGENT_SECRET_TOKEN>`
- Max duration: 300 s (Vercel limit)
- Returns `{ totalSignals, results: { agentName: { signalsFound } } }`

Individual agent API routes (`/api/agents/clinical-trial-monitor`, `/api/agents/funding-ma`,
`/api/agents/stale-job-tracker`, `/api/agents/competitor-job-board`) also exist for
running single agents in isolation. All require the same bearer token.

---

## Database Tables

### `signals`

Core output table. One row per unique BD signal.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `company_id` | uuid | FK → companies |
| `signal_type` | text | See signal types above |
| `priority_score` | int | 0–100, recalculated nightly |
| `signal_detail` | jsonb | All signal-specific fields (job_title, nct_id, funding_amount, etc.) |
| `signal_summary` | text | One-line human-readable summary |
| `source_url` | text | Used for deduplication |
| `status` | text | new, carried_forward, claimed, contacted, dismissed |
| `claimed_by` | text | Rep name |
| `first_detected_at` | timestamptz | When first inserted |
| `updated_at` | timestamptz | Last update |
| `score_breakdown` | jsonb | Component scores for recalculation |
| `days_in_queue` | int | Updated by orchestrator |

Unique index: `(company_id, signal_type, source_url)` for deduplication.

---

### `companies`

Normalised company records. Each agent upserts here before inserting a signal.

| Column | Notes |
|---|---|
| `id` | PK |
| `name` | Normalised via `normalizeCompanyName()` |
| `domain` | Company website domain |
| `industry` | e.g. "Biotechnology", "Pharmaceuticals" |
| `relationship_warmth` | cold / warm / hot (used in scoring) |

**Unique index:** functional expression index on `lower(trim(name))`. This is why `upsertCompany`
uses a manual check-then-insert pattern rather than `ON CONFLICT`.

---

### `past_clients`

Companies that have previously engaged the firm as a staffing client.

| Column | Notes |
|---|---|
| `name` | Company name |
| `priority_rank` | 1 = highest priority; ranks 1–18 get a graduated boost |
| `is_active` | Only active rows are loaded |

Boost formula: rank 1–18 → +15 to +10 (linear); rank 19+ → +8 flat.

---

### `excluded_companies`

Large employers (10,001+ LinkedIn members) that are excluded from signal generation.
Past clients are exempt from this exclusion.

| Column | Notes |
|---|---|
| `name` | Company name |
| `linkedin_member_count` | Used to decide threshold |
| `last_checked_at` | Updated by `scripts/checkCompanySizes.js` (weekly) |

---

### `competitor_firms`

The 53 life sciences staffing firms tracked by the Competitor Job Board agent.
Auto-seeded by the agent if the table has fewer than 30 rows.

| Column | Notes |
|---|---|
| `name` | Firm name |
| `is_active` | Whether to include in searches |

---

### `dismissal_rules`

Auto-generated when a rep dismisses a signal. Once `dismiss_count >= threshold`, the rule
becomes active (`auto_exclude = true`) and future signals matching that field/value are skipped.

| Column | Notes |
|---|---|
| `rule_type` | company, role_title, or location |
| `rule_value` | The matched value (case-insensitive) |
| `signal_type` | Which signal type the rule applies to |
| `dismiss_count` | How many times this value has been dismissed |
| `threshold` | Count required to activate auto-exclude (default 3, editable in Settings) |
| `auto_exclude` | Boolean; checked by agents at run time |

---

### `agent_runs`

Audit log for every agent run.

| Column | Notes |
|---|---|
| `agent_name` | e.g. `clinical_trial_monitor`, `orchestrator` |
| `status` | running, completed, failed |
| `started_at` | Timestamp |
| `completed_at` | Timestamp |
| `signals_found` | Count of new signals upserted |
| `run_detail` | jsonb — agent-specific run metadata |

---

### `leads`

Created when a rep claims a signal. Tracks outreach pipeline status and notes independently
from the signal record (signals can be unclaimed; leads persist for history).

| Column | Notes |
|---|---|
| `signal_id` | FK → signals (unique — one lead per signal) |
| `signal_type` | Denormalized for display |
| `company_name` | Denormalized for display |
| `signal_summary` | Denormalized for display |
| `claimed_by` | Rep name |
| `claimed_at` | Timestamp |
| `status` | new, contacted, in_progress, won, lost |
| `notes` | Rep's free-text outreach notes |

---

### `past_buyers`

Contacts at companies that have purchased staffing services.

| Column | Notes |
|---|---|
| `first_name`, `last_name` | Contact name |
| `company` | Company name |
| `title` | Job title |
| `email` | Email address |
| `phone` | Phone number |
| `source` | Where the contact came from |
| `is_current_buyer` | `true` if currently an active timesheet approver |

---

### `past_candidates`

Candidates previously placed or engaged through the firm.

Same schema as `past_buyers` minus `is_current_buyer`.

---

### `other_contacts`

Staging area for contacts not yet classified as buyers or candidates. Reps can move contacts
to `past_buyers` or `past_candidates` via the Other Contacts page.

Same schema as `past_buyers` minus `is_current_buyer`.

---

## Dashboard Pages

The dashboard is a single-page React app in `pages/index.js` (3,094 lines) with a fixed
left sidebar. Each sidebar item renders a different page component.

| Sidebar item | Key | What it shows |
|---|---|---|
| Dashboard | `dashboard` | 4 summary cards (new signal counts), 4 agent status cards |
| My Leads | `leads` | Claimed signals grouped by type (Clinical / Funding / Competitor / Stale); status + notes editing; "show all leads" toggle |
| Clinical Trials | `clinical` | `clinical_trial_phase_transition` and `clinical_trial_new_ind` signals; column filters on Type, Company, Source; expandable detail rows |
| Funding & M&A | `funding` | `ma_transaction` and `funding_*` signals; pill filters (Merger, Acquisition, IPO, etc.); column filters on Type, Company |
| Competitor Jobs | `competitor` | `competitor_job_posting` signals; column filters on Role, Competitor, Location, Likely Client; Match Prompt button copies LLM inference prompt |
| Stale Roles | `stale` | `stale_job_posting` and `target_company_job` signals; column filters on Role, Company, Hiring Manager, Location; Days Open badge |
| Past Buyers | `buyers` | Contacts from `past_buyers` table; search by name/company/title/email; green dot = current buyer |
| Past Candidates | `candidates` | Contacts from `past_candidates` table; search by name/company/title/email |
| Other Contacts | `contacts` | Contacts from `other_contacts` table; action buttons to move contact to Buyers or Candidates via `POST /api/contacts` |
| Settings | `settings` | Dismissal rules table (threshold editable inline, auto-exclude toggle, delete); Excluded Companies list |

All signal pages support:
- **Column filter dropdowns** — multi-select checkboxes, searchable, applied client-side
- **Row expand** — click any row to show full `signal_detail` as a key-value card
- **Claim / Unclaim** — creates or removes a `leads` row; claim is rep-specific
- **Dismiss** — modal asking for dismiss reason (company / role_title / location); updates
  `dismissal_rules` dismiss_count, activates auto-exclude at threshold

---

## GitHub Actions Workflows

### `job-agents.yml` — Nightly Job Agents

**Schedule:** `0 2 * * *` → 2:00 AM UTC = 9:00 PM EST / 10:00 PM EDT
**Manual trigger:** `workflow_dispatch` (GitHub Actions tab)
**Timeout:** 120 minutes

Runs `node scripts/runJobAgents.js` which executes:
1. `competitorJobBoardAgent.run()` — up to 60 LinkedIn requests (45–90 min with delays)
2. `staleJobTracker.run()` — up to 80 LinkedIn requests (45–90 min with delays)

On failure, uploads any files in `logs/` as artifacts (7-day retention).

Secrets used: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LINKEDIN_LI_AT`, `ANTHROPIC_API_KEY`.

---

### `company-size-check.yml` — Weekly Company Size Check

**Schedule:** `0 3 * * 0` → Every Sunday at 3:00 AM UTC
**Manual trigger:** `workflow_dispatch`

Runs `node scripts/checkCompanySizes.js` which checks LinkedIn company pages to get
member counts and updates `excluded_companies` for companies that have grown to 10,001+.

Secrets used: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LINKEDIN_LI_AT`.

---

## Environment Variables

### Server-side (agents + API routes)

| Variable | Where used | Purpose |
|---|---|---|
| `SUPABASE_URL` | All agents, all API routes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | All agents, all API routes | Supabase service role (bypasses RLS) |
| `LINKEDIN_LI_AT` | `linkedinClient.js`, `fundingMaAgent.js` | LinkedIn `li_at` session cookie for scraping |
| `ANTHROPIC_API_KEY` | `llmClientInference.js` | Claude Haiku API key for end-client inference |
| `AGENT_SECRET_TOKEN` | `pages/api/agents/orchestrator.js` and all individual agent API routes | Bearer token required to trigger agents via HTTP |

### Client-side (browser / Next.js frontend)

| Variable | Where used | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `pages/index.js` | Supabase URL for real-time subscriptions and direct Supabase queries from the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `pages/index.js` | Supabase anon key (respects RLS) for client-side subscriptions, dismissal rule upserts, and settings page reads |
| `NEXT_PUBLIC_AGENT_SECRET_TOKEN` | `pages/index.js` (Run Agents button) | Passed as Bearer token when the dashboard triggers `POST /api/agents/orchestrator` |

> **Note:** `NEXT_PUBLIC_*` variables are exposed to the browser. Never set `SUPABASE_SERVICE_ROLE_KEY`
> or `ANTHROPIC_API_KEY` as `NEXT_PUBLIC_*` variables.
