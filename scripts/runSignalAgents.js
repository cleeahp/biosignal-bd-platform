/**
 * scripts/runSignalAgents.js
 *
 * Standalone runner for the Clinical Trials and Funding & M&A signal agents.
 * Designed to be invoked by GitHub Actions on a nightly cron schedule
 * where there are no Vercel timeout constraints.
 *
 * Agents run sequentially: clinical trials first, then funding & M&A.
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service-role key (bypasses RLS)
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
const logPath = path.join(logsDir, `signal-agents-${today}.log`)
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

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const missing = REQUIRED_ENV.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`[SignalAgents] Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

// ── Agent imports ──────────────────────────────────────────────────────────────
// Imported after env vars are loaded so the supabase client initialises correctly.

import { run as runClinicalTrialMonitor } from '../agents/clinicalTrialMonitor.js'
import { run as runFundingMaAgent }       from '../agents/fundingMaAgent.js'

// ── Main ───────────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
console.log(`[SignalAgents] Starting at ${startedAt}`)
console.log(`[SignalAgents] Log file: ${logPath}`)

let clinicalResult = { signalsFound: 0, studiesProcessed: 0 }
let fundingResult  = { signalsFound: 0 }

try {
  // Run clinical trials first
  console.log('\n[SignalAgents] ── Running Clinical Trial Monitor ──────────────')
  clinicalResult = await runClinicalTrialMonitor().catch((err) => {
    console.error(`[ClinicalTrials] Agent failed: ${err.message}`)
    return { signalsFound: 0, studiesProcessed: 0, error: err.message }
  })

  // Then funding & M&A
  console.log('\n[SignalAgents] ── Running Funding & M&A Agent ─────────────────')
  fundingResult = await runFundingMaAgent().catch((err) => {
    console.error(`[FundingMA] Agent failed: ${err.message}`)
    return { signalsFound: 0, error: err.message }
  })

  const finishedAt     = new Date().toISOString()
  const elapsedMinutes = ((new Date(finishedAt) - new Date(startedAt)) / 60_000).toFixed(1)
  const totalSignals   = (clinicalResult.signalsFound ?? 0) + (fundingResult.signalsFound ?? 0)

  console.log('')
  console.log('═══════════════════════════════════════════════')
  console.log('[SignalAgents] Run complete')
  console.log(`[SignalAgents] Elapsed: ${elapsedMinutes} minutes`)
  console.log(`[ClinicalTrials] ${clinicalResult.signalsFound ?? 0} signals — ${clinicalResult.studiesProcessed ?? 0} studies processed`)
  console.log(`[FundingMA]      ${fundingResult.signalsFound ?? 0} signals — source counts: ${JSON.stringify(fundingResult.sourceCounts ?? {})}`)
  console.log(`[SignalAgents] Total new signals: ${totalSignals}`)
  console.log('═══════════════════════════════════════════════')

  const bothFailed = clinicalResult.error && fundingResult.error
  process.exit(bothFailed ? 1 : 0)
} catch (err) {
  console.error(`[SignalAgents] Unhandled error: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
}
