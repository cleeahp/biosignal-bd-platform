import { supabase } from '../lib/supabase.js'
import { runClinicalTrialMonitor } from './clinicalTrialMonitor.js'
import { runFundingMaAgent } from './fundingMaAgent.js'
import { runCompetitorJobBoardAgent } from './competitorJobBoardAgent.js'
import { runStaleJobTracker } from './staleJobTracker.js'

// ─── Priority score recalculation ─────────────────────────────────────────────

function recalculatePriorityScore(signal) {
  const breakdown = signal.score_breakdown || {}
  const daysInQueue = signal.days_in_queue || 0

  // Base signal strength
  const signalStrength = breakdown.signal_strength || 15

  // Relationship warmth (unchanged)
  const warmthScore = breakdown.relationship_warmth || 0

  // Actionability (unchanged)
  const actionability = breakdown.actionability || 0

  // Recency with decay:
  // - Each day old reduces recency by 3, floor of 10
  // - After 7 days unactioned, score increments by 1 every 3 days
  let recency
  if (daysInQueue <= 7) {
    recency = Math.max(25 - daysInQueue * 3, 10)
  } else {
    const baseRecency = 10
    const urgencyBonus = Math.floor((daysInQueue - 7) / 3)
    recency = Math.min(baseRecency + urgencyBonus, 25) // cap back at 25
  }

  return Math.min(signalStrength + recency + warmthScore + actionability, 100)
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runOrchestrator() {
  const startedAt = new Date().toISOString()
  let totalSignalsFound = 0
  let signalsCarriedForward = 0
  const agentResults = {}

  const { data: runLog } = await supabase
    .from('agent_runs')
    .insert({ agent_name: 'orchestrator', status: 'running', started_at: startedAt })
    .select()
    .single()
  const runId = runLog?.id

  try {
    // ── Step 1: Run all four agents in parallel ──────────────────────────────
    console.log('Orchestrator: starting all agents in parallel...')
    const [ctResult, fundingResult, competitorResult, staleResult] = await Promise.all([
      runClinicalTrialMonitor().catch((err) => ({ success: false, error: err.message, signalsFound: 0 })),
      runFundingMaAgent().catch((err) => ({ success: false, error: err.message, signalsFound: 0 })),
      runCompetitorJobBoardAgent().catch((err) => ({ success: false, error: err.message, signalsFound: 0 })),
      runStaleJobTracker().catch((err) => ({ success: false, error: err.message, signalsFound: 0 })),
    ])

    agentResults.clinicalTrialMonitor = ctResult
    agentResults.fundingMaAgent = fundingResult
    agentResults.competitorJobBoard = competitorResult
    agentResults.staleJobTracker = staleResult

    totalSignalsFound =
      (ctResult.signalsFound || 0) +
      (fundingResult.signalsFound || 0) +
      (competitorResult.signalsFound || 0) +
      (staleResult.signalsFound || 0)

    console.log(`Orchestrator: agents complete. Total new signals: ${totalSignalsFound}`)

    // ── Step 2: Mark stale unactioned signals as carried_forward ─────────────
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Signals NOT detected today (i.e., first_detected_at before today) and still 'new'
    const { data: staleSignals } = await supabase
      .from('signals')
      .select('id, days_in_queue')
      .eq('status', 'new')
      .lt('first_detected_at', todayStart.toISOString())

    if (staleSignals && staleSignals.length > 0) {
      const staleIds = staleSignals.map((s) => s.id)
      await supabase
        .from('signals')
        .update({ is_carried_forward: true })
        .in('id', staleIds)
      signalsCarriedForward = staleIds.length
      console.log(`Orchestrator: marked ${signalsCarriedForward} signals as carried_forward`)
    }

    // ── Step 3: Recalculate priority scores for all active signals ────────────
    const { data: activeSignals } = await supabase
      .from('signals')
      .select('id, score_breakdown, days_in_queue, first_detected_at, status')
      .in('status', ['new', 'carried_forward'])

    if (activeSignals && activeSignals.length > 0) {
      const today = new Date()

      for (const signal of activeSignals) {
        // Update days_in_queue
        const firstDetected = new Date(signal.first_detected_at || today)
        const daysInQueue = Math.floor((today - firstDetected) / (1000 * 60 * 60 * 24))
        const newPriorityScore = recalculatePriorityScore({ ...signal, days_in_queue: daysInQueue })

        await supabase
          .from('signals')
          .update({
            days_in_queue: daysInQueue,
            priority_score: newPriorityScore,
          })
          .eq('id', signal.id)
      }

      console.log(`Orchestrator: recalculated scores for ${activeSignals.length} active signals`)
    }

    // ── Step 4: Log final ranked count ───────────────────────────────────────
    const { count: activeCount } = await supabase
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .in('status', ['new', 'carried_forward'])

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        signals_found: totalSignalsFound,
        signals_carried_forward: signalsCarriedForward,
        run_detail: {
          agent_results: agentResults,
          active_signals_after_run: activeCount || 0,
        },
      })
      .eq('id', runId)

    console.log(`Orchestrator complete. Active signals in queue: ${activeCount || 0}`)
    return {
      success: true,
      totalSignalsFound,
      signalsCarriedForward,
      activeSignals: activeCount || 0,
      agentResults,
    }
  } catch (error) {
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message,
        run_detail: { agent_results: agentResults },
      })
      .eq('id', runId)
    console.error('Orchestrator failed:', error.message)
    return { success: false, error: error.message }
  }
}
