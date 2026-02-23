# Competitor Job Board Agent — Staffing Firms Fix

## Problem

Agent 3 (Competitor Job Board Agent) was tracking CROs (Contract Research Organizations) and clinical research associations instead of staffing firms only.

**Root cause:**
- `COMPETITOR_FIRMS_SEED` included CROs like "ICON plc" and "Advanced Clinical"
- No validation to ensure LinkedIn job results matched the searched firm
- No CRO filtering patterns in the client inference logic

---

## Changes Made

### 1. Updated Competitor Firms Seed List (`agents/competitorJobBoardAgent.js`)

**Removed (CROs and non-staffing firms):**
- ICON plc (CRO)
- Advanced Clinical (CRO)
- Alku, Black Diamond Networks, Real Life Sciences, The Planet Group
- USTech Solutions, Soliant Health, Epic Staffing Group
- Spectra Force, Mindlance, Pacer Staffing, ZP Group, Meet Staffing, Ampcus
- ClinLab Staffing, Peoplelink Group

**Added (verified staffing firms):**
- Randstad, Adecco, Kelly Services, Manpower, Hays
- Insight Global, Planet Pharma, Proclinical, Real Staffing
- GForce Life Sciences, Medix, EPM Scientific
- ClinLab Solutions Group, Sci.bio, Gemini Staffing Consultants
- Orbis Clinical, Scientific Search, TriNet Pharma
- The Fountain Group, Hueman RPO

**Final count:** 30 staffing firms (same as before)

---

### 2. Added CRO Filtering Pattern

```javascript
const CRO_PATTERNS =
  /\b(ICON|IQVIA|Syneos|PPD|Parexel|Covance|Medpace|PRA Health|Charles River|WuXi|Labcorp Drug Development|Fortrea|ClinChoice|PSI CRO|NAMSA|SGS|Altasciences|Accelerated Enrollment|Alliance for Clinical|ECOG|SWOG|Clinical Research Assoc|Clinical Research Org|Contract Research)\b/i
```

Applied in:
- `inferClientViaLinkedIn()` — filters CROs from client inference results
- Main job processing loop — validates job.company is not a CRO

---

### 3. Added Job Company Name Validation

Before processing each job, the agent now validates:

1. **Company name matches searched firm** — Checks first word overlap to ensure LinkedIn returned jobs from the correct staffing firm
2. **Company is not a CRO** — Filters out any CRO that might slip through
3. **Company is not academic** — Filters out universities, hospitals, etc.

Logs filtered jobs for debugging:
```
[CompetitorJobs] FILTERED (company mismatch): Expected "Actalent", got "ICON plc" for job: Clinical Research Associate
[CompetitorJobs] FILTERED (CRO): "Syneos Health" — Senior CRA
```

---

### 4. Created Database Cleanup Endpoint

**New file:** `pages/api/cleanup-competitor-firms.js`

**Purpose:** One-time cleanup to deactivate old CROs and seed correct staffing firms

**Usage:**
```bash
curl -X POST https://biosignal-sage.vercel.app/api/cleanup-competitor-firms
```

**What it does:**
1. Deactivates (sets `is_active = false`) for all CROs in the removal list
2. Upserts 30 correct staffing firms (activates if already exists)
3. Returns summary of deactivated/seeded firms

**Response:**
```json
{
  "success": true,
  "deactivated": 5,
  "deactivatedFirms": ["ICON plc", "Advanced Clinical", ...],
  "seeded": 30,
  "skipped": 0,
  "message": "Competitor firms cleaned up and re-seeded"
}
```

---

### 5. Updated Documentation

**AGENTS.md** changes:
- Agent 3 description now states "STAFFING FIRMS ONLY"
- Added "Staffing Firms vs CROs" section with clear definitions
- Added CRO exclusion examples (ICON, IQVIA, Syneos, PPD, etc.)
- Listed all 30 current competitor firms
- Added validation logic to Key Behaviors

---

## Deployment Steps

### 1. Deploy Code Changes

Push changes to GitHub:
```bash
cd C:\Users\Guest1\Downloads\biosignal-cc
git add .
git commit -m "Fix Agent 3: Track staffing firms only, exclude CROs"
git push origin main
```

Vercel will auto-deploy.

---

### 2. Clean Up Competitor Firms Table

**Option A: Via API endpoint (recommended)**

```bash
curl -X POST https://biosignal-sage.vercel.app/api/cleanup-competitor-firms
```

**Option B: Manual SQL (Supabase SQL Editor)**

```sql
-- Deactivate CROs
UPDATE competitor_firms 
SET is_active = false 
WHERE name ILIKE ANY (ARRAY[
  'ICON plc', 'ICON', 'Advanced Clinical', 'Alku', 
  'Black Diamond Networks', 'Real Life Sciences', 
  'The Planet Group', 'USTech Solutions', 'Soliant Health',
  'Epic Staffing Group', 'Spectra Force', 'Mindlance',
  'Pacer Staffing', 'ZP Group', 'Meet Staffing', 'Ampcus',
  'ClinLab Staffing', 'Peoplelink Group'
]);

-- Verify only staffing firms are active
SELECT name, is_active FROM competitor_firms ORDER BY name;
```

---

### 3. Verify Next Agent Run

After deployment, check the next nightly Agent 3 run (2 AM UTC / 9 PM ET):

1. **GitHub Actions** — Check workflow log at:
   https://github.com/cleeahp/biosignal-bd-platform/actions

2. **Look for:**
   - `[CompetitorJobs] Processing 30 active firms (shuffled) — LinkedIn only`
   - NO `[CompetitorJobs] FILTERED (CRO):` warnings
   - NO `[CompetitorJobs] FILTERED (company mismatch):` warnings with CRO names

3. **Check Supabase agent_runs table:**
   ```sql
   SELECT * FROM agent_runs 
   WHERE agent_name = 'competitor-job-board-agent' 
   ORDER BY started_at DESC 
   LIMIT 1;
   ```

   Verify `run_detail.firms_checked = 30` and `run_detail.seed_result.seeded = 30`

---

### 4. Archive Old CRO Signals (Optional)

Old signals from CROs can be archived:

```sql
-- Find signals from deactivated CRO firms
SELECT s.id, s.signal_summary, s.signal_detail->>'competitor_firm' as firm
FROM signals s
WHERE s.signal_type = 'competitor_job_posting'
  AND s.signal_detail->>'competitor_firm' ILIKE ANY (ARRAY[
    'ICON plc', 'ICON', 'Advanced Clinical'
  ]);

-- Archive them
UPDATE signals 
SET status = 'archived' 
WHERE signal_type = 'competitor_job_posting'
  AND signal_detail->>'competitor_firm' ILIKE ANY (ARRAY[
    'ICON plc', 'ICON', 'Advanced Clinical', 
    -- add other CRO names here
  ]);
```

---

## Testing Locally

To test the changes before deployment:

```bash
cd C:\Users\Guest1\Downloads\biosignal-cc

# Set env vars in .env.local (copy from .env.local.example)
# Add: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINKEDIN_LI_AT

# Run the job agents script
npm run run-job-agents
```

Expected output:
- `Competitor seed: 30 upserted, 0 skipped`
- `[CompetitorJobs] Processing 30 active firms (shuffled) — LinkedIn only`
- NO CRO-related filter warnings
- Signals saved only from staffing firms

---

## Rollback Plan

If issues arise:

1. **Revert code changes:**
   ```bash
   git revert HEAD
   git push origin main
   ```

2. **Reactivate old firms:**
   ```sql
   UPDATE competitor_firms SET is_active = true;
   ```

3. **Check logs** — The agent will continue to function with the old seed list until manually cleaned up.

---

## Summary

✅ **Fixed:** Agent 3 now tracks only staffing firms (Randstad, Actalent, Kelly Services, etc.)  
✅ **Excluded:** CROs (ICON, IQVIA, Syneos, PPD, Parexel, etc.)  
✅ **Validation:** Job company names checked against searched firm + CRO patterns  
✅ **Cleanup:** API endpoint created to reset competitor_firms table  
✅ **Docs:** AGENTS.md updated with clear staffing vs CRO definitions  

**Next agent run:** Tonight at 2 AM UTC (9 PM ET)
