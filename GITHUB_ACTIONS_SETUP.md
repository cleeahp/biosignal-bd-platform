# GitHub Actions Setup — Nightly Job Agents

The two LinkedIn job agents (`competitorJobBoardAgent` and `staleJobTracker`) run
as a nightly GitHub Actions workflow instead of via Vercel. This removes the
Vercel 300-second function timeout constraint — the agents can safely run for
45–90 minutes.

---

## Required GitHub Secrets

Add these three secrets to your GitHub repo:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret name                | Value                                                     |
|---------------------------|-----------------------------------------------------------|
| `SUPABASE_URL`            | Your Supabase project URL (e.g. `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service-role key (bypasses RLS — keep private) |
| `LINKEDIN_LI_AT`          | Your LinkedIn `li_at` session cookie (see `LINKEDIN_SETUP.md`) |

These are the same values already in your Vercel environment variables.
Copy them from Vercel dashboard → Settings → Environment Variables.

> **Security:** `SUPABASE_SERVICE_ROLE_KEY` bypasses Row-Level Security.
> Never commit it to the repository. GitHub secrets are encrypted at rest
> and only exposed to workflow runs.

---

## Manual trigger (test immediately)

After adding the secrets:

1. Go to your GitHub repo
2. Click the **Actions** tab
3. Select **"Nightly Job Agents"** in the left sidebar
4. Click **"Run workflow"** → **"Run workflow"** (green button)

The run will take 45–90 minutes depending on how many LinkedIn requests
complete before the budget is exhausted. You can watch progress in real time
by clicking into the running workflow.

---

## Schedule

The workflow runs automatically at **2:00 AM UTC** every night, which is:
- 9:00 PM EST (Eastern Standard Time)
- 10:00 PM EDT (Eastern Daylight Time)

To change the schedule, edit `cron: '0 2 * * *'` in
`.github/workflows/job-agents.yml`. Use [crontab.guru](https://crontab.guru)
to preview cron expressions.

---

## Monitoring

**Check run history:**
GitHub repo → Actions → Nightly Job Agents

**Read logs:**
Click any run → click the `run-job-agents` step → expand the
"Run job agents" section to see all console output including:
- `[LinkedIn] GET [N/60]: ...` — each LinkedIn request
- `[LinkedIn] Taking a break after 10 requests...` — break delays
- `[CompetitorJobs] Complete — N requests used, M signals saved`
- `[StaleJobs] Complete — N requests used, M signals saved`

**Download logs on failure:**
If the run fails, log files from `logs/job-agents-{date}.log` are uploaded
as a workflow artifact and retained for 7 days. Click the failed run →
scroll to "Artifacts" at the bottom → download `job-agent-logs`.

---

## LinkedIn cookie expiry

The `LINKEDIN_LI_AT` cookie expires periodically (typically every few weeks).
When it expires, the workflow will still succeed but LinkedIn requests will
be skipped with:

```
[LinkedIn] LINKEDIN_LI_AT not configured — skipping LinkedIn sources
```

Or if the cookie is invalid:
```
[LinkedIn] Bot detection triggered (999) — stopping all LinkedIn requests for today
```

To refresh: extract a new `li_at` cookie from Chrome DevTools (see
`LINKEDIN_SETUP.md`) and update the GitHub secret.

---

## Local testing

To run the job agents locally:

1. Copy the example env file:
   ```
   cp .env.local.example .env.local
   ```

2. Fill in `.env.local` with your real values.

3. Run the agents:
   ```
   npm run run-job-agents
   ```

Logs are written to `logs/job-agents-{date}.log` in addition to stdout.
