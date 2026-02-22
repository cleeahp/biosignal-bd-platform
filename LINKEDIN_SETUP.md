# LinkedIn Integration Setup

The LinkedIn source in this platform is **read-only**. It is used to supplement
competitor job board data and stale job posting signals. No posts, messages,
reactions, or connection requests are ever made.

---

## How it works

Authentication uses your browser's `li_at` session cookie rather than
credentials. You log into LinkedIn normally in Chrome, copy the `li_at` cookie
value, and store it as a Vercel environment variable. The platform injects it
as a `Cookie` header on every request — no login flow, no credentials stored.

---

## Step 1 — Extract your li_at cookie from Chrome

1. Open **Chrome** and log into [linkedin.com](https://www.linkedin.com) normally
2. Open **DevTools** (`F12` or `Cmd+Option+I` on Mac)
3. Go to the **Application** tab
4. In the left sidebar, expand **Cookies** → click `https://www.linkedin.com`
5. Find the cookie named **`li_at`**
6. Click on it and copy the **Value** (it will be a long alphanumeric string)

> **Tip:** Use a dedicated service account rather than your personal LinkedIn
> profile. This isolates any rate-limiting or access issues from your personal
> account activity.

---

## Step 2 — Add the cookie to Vercel

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Select the **biosignal-bd-platform** project
3. Navigate to **Settings → Environment Variables**
4. Add the following variable. Set it for all environments
   (Production, Preview, Development) unless you only want LinkedIn active in
   production.

| Variable name     | Description                                        |
|-------------------|----------------------------------------------------|
| `LINKEDIN_LI_AT`  | The `li_at` session cookie value copied from Chrome |

> **Security:** Treat `LINKEDIN_LI_AT` like a password. Never commit it to the
> repository or add it to `.env` files checked into git. The cookie grants
> full read access to your LinkedIn account.

---

## Step 3 — Redeploy

After adding the variable, trigger a new deployment so the agents pick it up.

---

## Cookie expiry

The `li_at` cookie typically expires after a few weeks of inactivity or when
you log out of LinkedIn on that device. When it expires:

- The test endpoint (`GET /api/test-linkedin`) will return `cookie_valid: false`
- Agent runs will log: `[LinkedIn] Cookie expired or invalid — skipping`

To refresh: repeat Steps 1–3 with a freshly copied `li_at` value.

---

## Verifying the setup

After deploying, call the test endpoint:

```
GET /api/test-linkedin
```

Expected response when working:

```json
{ "success": true, "cookie_present": true, "cookie_valid": true, "error": null }
```

Or trigger the `target-company-jobs-agent` or `competitor-job-board-agent`
from the admin panel and check Vercel function logs.

You should see:

```
[LinkedIn] GET [1/10]: https://www.linkedin.com/jobs/search/?...
```

If the cookie is missing:

```
[LinkedIn] LINKEDIN_LI_AT not configured — skipping LinkedIn sources
```

If the cookie is expired or invalid:

```
[LinkedIn] GET [1/10]: https://www.linkedin.com/feed/
```
followed by the test endpoint returning `cookie_valid: false`.

---

## Security guarantees

The LinkedIn client (`lib/linkedinClient.js`) enforces these constraints at runtime:

- **Read-only**: only GET requests are allowed. Any attempt to make a
  POST, PUT, DELETE, or PATCH request throws a CRITICAL error immediately.
- **Cookie never logged**: `LINKEDIN_LI_AT` is read once and never appears
  in logs, signal details, or API responses.
- **Rate limited**: maximum 10 requests per agent run; 3–8 second randomised
  delay between requests; stops immediately on HTTP 429 or 999.
- **In-memory only**: the cookie value exists only for the duration of one
  agent run and is never written to disk or the database.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `LINKEDIN_LI_AT not configured` | Env var missing or not deployed | Add env var and redeploy |
| `cookie_valid: false` / authwall redirect | Cookie expired or logged out | Extract fresh `li_at` from Chrome and update env var |
| `Rate limited (HTTP 429)` | Too many requests | Normal — the client stops gracefully; no action needed |
| `HTTP 999` | LinkedIn bot detection | Expected occasionally; retry will succeed in next run |
| No LinkedIn jobs in signals | LinkedIn returned no matching roles | Normal if LinkedIn doesn't have relevant postings |
