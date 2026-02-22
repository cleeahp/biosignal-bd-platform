# LinkedIn Integration Setup

The LinkedIn source in this platform is **read-only**. It is used to supplement
competitor job board data and stale job posting signals. No posts, messages,
reactions, or connection requests are ever made.

---

## Adding credentials to Vercel

LinkedIn credentials must be stored as Vercel environment variables. They should
**never** be committed to the repository or added to `.env` files checked into git.

### Step 1 — Open Vercel dashboard

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Select the **biosignal-bd-platform** project
3. Navigate to **Settings → Environment Variables**

### Step 2 — Add variables

Add the following two environment variables. Set them for all environments
(Production, Preview, Development) unless you only want LinkedIn active in
production.

| Variable name        | Description                                      |
|----------------------|--------------------------------------------------|
| `LINKEDIN_EMAIL`     | Email address of the LinkedIn account to use     |
| `LINKEDIN_PASSWORD`  | Password for the LinkedIn account                |

> **Tip:** Use a dedicated service account rather than a personal LinkedIn
> profile. This isolates any rate-limiting or access issues from your personal
> account activity.

### Step 3 — Redeploy

After adding the variables, trigger a new deployment so the agents pick them up.

---

## Verifying the setup

After deploying, trigger the `target-company-jobs-agent` or
`competitor-job-board-agent` from the admin panel and check Vercel function logs.

You should see one of:

```
[LinkedIn] Login successful
[LinkedIn] GET [1/10]: https://www.linkedin.com/jobs/search/?...
```

If credentials are missing:

```
[LinkedIn] Credentials not configured (LINKEDIN_EMAIL / LINKEDIN_PASSWORD) — skipping LinkedIn sources
```

If login fails (wrong password, account locked, etc.):

```
[LinkedIn] Login failed — no li_at session cookie received — skipping LinkedIn sources
```

---

## Security guarantees

The LinkedIn client (`lib/linkedinClient.js`) enforces these constraints at runtime:

- **Read-only**: only GET requests are allowed after login. Any attempt to make a
  POST, PUT, DELETE, or PATCH request throws a CRITICAL error immediately.
- **Credentials never logged**: `LINKEDIN_EMAIL` and `LINKEDIN_PASSWORD` are read
  once during login and never appear in logs, signal details, or API responses.
- **Rate limited**: maximum 10 requests per agent run; 3–8 second randomised
  delay between requests; stops immediately on HTTP 429 or 999.
- **In-memory only**: session cookies are never written to disk or the database.
  They exist only for the duration of one agent run.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Credentials not configured` | Env vars missing or not deployed | Add env vars and redeploy |
| `Login failed — no li_at cookie` | Wrong password or account locked | Verify credentials; check LinkedIn account |
| `Rate limited (HTTP 429)` | Too many requests | Normal — the client stops gracefully; no action needed |
| `Login page fetch failed: HTTP 999` | LinkedIn bot detection | Expected occasionally; retry will succeed in next run |
| No LinkedIn jobs in signals | LinkedIn returned no matching roles | Normal if LinkedIn doesn't have relevant postings |
