/**
 * scripts/runJobAgents.js
 *
 * Standalone runner for the two LinkedIn-backed job signal agents.
 * Designed to be invoked by GitHub Actions on a nightly cron schedule
 * with no timeout constraints.
 *
 * In production (GitHub Actions): env vars are injected via workflow secrets.
 * For local testing:              copy .env.local.example → .env.local and fill in values,
 *                                 then run: npm run run-job-agents
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service-role key (bypasses RLS)
 *   LINKEDIN_LI_AT            — LinkedIn li_at session cookie
 */

import dotenv from 'dotenv'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.join(__dirname, '..')

// ── Environment loading ────────────────────────────────────────────────────────
// GitHub Actions injects env vars as secrets; dotenv is only used locally.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.join(ROOT, '.env.local') })  // no-ops if file absent
}

// ── File logging ───────────────────────────────────────────────────────────────
// All console.log / .warn / .error output is tee'd to both stdout and a dated
// log file so GitHub Actions can upload the file as an artifact on failure.

const logsDir = path.join(ROOT, 'logs')
await mkdir(logsDir, { recursive: true })

const today   = new Date().toISOString().split('T')[0]
const logPath = path.join(logsDir, `job-agents-${today}.log`)
const logFile = createWriteStream(logPath, { flags: 'a' })

function formatArgs(args) {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

const _log   = console.log.bind(console)
const _warn  = console.warn.bind(console)
const _error = console.error.bind(console)

console.log = (...args) => {
  _log(...args)
  logFile.write(`[LOG]   ${formatArgs(args)}\n`)
}
console.warn = (...args) => {
  _warn(...args)
  logFile.write(`[WARN]  ${formatArgs(args)}\n`)
}
console.error = (...args) => {
  _error(...args)
  logFile.write(`[ERROR] ${formatArgs(args)}\n`)
}

// ── Env-var validation ─────────────────────────────────────────────────────────

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LINKEDIN_LI_AT']
const missing = REQUIRED_ENV.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`[JobAgents] Missing required environment variables: ${missing.join(', ')}`)
  console.error('[JobAgents] See GITHUB_ACTIONS_SETUP.md for setup instructions.')
  process.exit(1)
}

// ── Agent imports ──────────────────────────────────────────────────────────────
// Imported after env vars are loaded so the supabase client initialises correctly.

import { run as runCompetitorJobBoardAgent } from '../agents/competitorJobBoardAgent.js'
import { run as runStaleJobTracker }         from '../agents/staleJobTracker.js'

// ── Main ───────────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
console.log(`[JobAgents] Starting at ${startedAt}`)
console.log(`[JobAgents] Log file: ${logPath}`)

try {
  const [competitorResult, staleResult] = await Promise.all([
    runCompetitorJobBoardAgent().catch((err) => {
      console.error(`[CompetitorJobs] Agent failed: ${err.message}`)
      return { signalsFound: 0, requestsUsed: 0, error: err.message }
    }),
    runStaleJobTracker().catch((err) => {
      console.error(`[StaleJobs] Agent failed: ${err.message}`)
      return { signalsFound: 0, requestsUsed: 0, error: err.message }
    }),
  ])

  const finishedAt      = new Date().toISOString()
  const elapsedMinutes  = ((new Date(finishedAt) - new Date(startedAt)) / 60_000).toFixed(1)

  console.log('')
  console.log('═══════════════════════════════════════════════')
  console.log('[JobAgents] Run complete')
  console.log(`[JobAgents] Elapsed: ${elapsedMinutes} minutes`)
  console.log(
    `[CompetitorJobs] Complete — ${competitorResult.requestsUsed ?? 0} requests used, ` +
    `${competitorResult.signalsFound ?? 0} signals saved`
  )
  console.log(
    `[StaleJobs] Complete — ${staleResult.requestsUsed ?? 0} requests used, ` +
    `${staleResult.signalsFound ?? 0} signals saved`
  )
  console.log('═══════════════════════════════════════════════')

  // Exit non-zero if either agent hard-failed (but not just low signal count)
  const bothFailed = competitorResult.error && staleResult.error
  process.exit(bothFailed ? 1 : 0)
} catch (err) {
  console.error(`[JobAgents] Unhandled error: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
}
