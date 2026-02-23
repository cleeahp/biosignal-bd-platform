import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

const SIGNAL_TYPE_CONFIG = {
  clinical_trial_phase_transition: { label: 'Phase Transition', color: 'bg-blue-500', tab: 'clinical' },
  clinical_trial_new_ind:          { label: 'New IND',          color: 'bg-cyan-500',  tab: 'clinical' },
  clinical_trial_site_activation:  { label: 'Site Activation',  color: 'bg-teal-500',  tab: null },
  clinical_trial_completion:       { label: 'Trial Completion',  color: 'bg-purple-500', tab: null },
  funding_new_award:               { label: null,                color: null,            tab: null },
  funding_renewal:                 { label: 'Renewal',           color: 'bg-lime-600',   tab: 'funding' },
  ma_transaction:                  { label: 'M&A',               color: 'bg-orange-500', tab: 'funding' },
  ma_acquirer:                     { label: 'M&A — Acquirer',    color: 'bg-orange-500', tab: null },
  ma_acquired:                     { label: 'M&A — Acquired',    color: 'bg-amber-500',  tab: null },
  competitor_job_posting:          { label: 'Competitor Job',    color: 'bg-red-500',    tab: 'jobs' },
  target_company_job:              { label: 'Target Co. Job',    color: 'bg-violet-500', tab: 'jobs' },
  stale_job_posting:               { label: 'Stale Job',         color: 'bg-gray-500',   tab: 'jobs' },
}

const FUNDING_TYPE_CONFIG = {
  venture_capital:    { label: 'Venture Capital',    color: 'bg-green-600' },
  ipo:                { label: 'IPO',                color: 'bg-emerald-600' },
  pharma_partnership: { label: 'Pharma Partnership', color: 'bg-blue-600' },
  government_grant:   { label: 'Government Grant',   color: 'bg-orange-600' },
  ma:                 { label: 'M&A',                color: 'bg-amber-600' },
}

// Badge config for ma_transaction signals keyed by transaction_type
const MA_TRANSACTION_TYPE_CONFIG = {
  ipo:                 { label: 'IPO',                 color: 'bg-emerald-600' },
  acquisition:         { label: 'Acquisition',         color: 'bg-orange-600' },
  product_acquisition: { label: 'Product Acquisition', color: 'bg-violet-600' },
  merger:              { label: 'Merger',              color: 'bg-amber-600' },
  partnership:         { label: 'Partnership',         color: 'bg-blue-600' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely parse signal_detail — Supabase returns it as a JSONB object,
 * but older data or edge cases may arrive as a JSON string.
 */
function parseDetail(raw) {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw
}

/**
 * Normalize a stored phase label to a readable format.
 * Handles both old storage format ("PHASE1", "PRE-CLINICAL") and
 * new format ("Phase 1", "Pre-Clinical", "Phase 1/2").
 */
function formatPhaseLabel(raw) {
  if (!raw) return '?'
  const s = String(raw).trim()
  // Old format: "PHASE1" → "Phase 1"
  if (/^PHASE\d+$/i.test(s)) return s.replace(/PHASE(\d+)/i, 'Phase $1')
  // Old format: "PRE-CLINICAL" or "PRE_CLINICAL" → "Pre-Clinical"
  if (/^PRE[-_]CLINICAL$/i.test(s)) return 'Pre-Clinical'
  return s
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d)) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysAgo(dateStr) {
  if (!dateStr) return 0
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000)
}

function getRepInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.substring(0, 2).toUpperCase()
}

function truncate(str, n) {
  if (!str) return ''
  return str.length > n ? str.substring(0, n) + '...' : str
}

// ─── Shared UI components ─────────────────────────────────────────────────────

function SignalTypeBadge({ signalType, fundingType }) {
  let label, color
  const config = SIGNAL_TYPE_CONFIG[signalType]
  if (signalType === 'funding_new_award' && fundingType) {
    const ftConfig = FUNDING_TYPE_CONFIG[fundingType]
    label = ftConfig?.label || 'New Award'
    color = ftConfig?.color || 'bg-green-600'
  } else {
    label = config?.label || signalType
    color = config?.color || 'bg-gray-600'
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold text-white whitespace-nowrap ${color}`}>
      {label}
    </span>
  )
}

function DaysInQueueBadge({ dateStr }) {
  const days = daysAgo(dateStr)
  let cls = 'bg-gray-700 text-gray-300'
  if (days > 14) cls = 'bg-red-900 text-red-300'
  else if (days > 7) cls = 'bg-orange-900 text-orange-300'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${cls}`}>
      {days}d
    </span>
  )
}

function ConfidenceBadge({ confidence }) {
  if (!confidence) return null
  const map = {
    high:   'bg-green-900 text-green-300',
    medium: 'bg-yellow-900 text-yellow-300',
    low:    'bg-gray-700 text-gray-400',
  }
  const cls = map[confidence] || map.low
  return (
    <span className={`inline-block ml-1 px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {confidence}
    </span>
  )
}

function ClaimCell({ signal, repName, onClaim, onUnclaim }) {
  if (!repName) {
    return <span className="text-xs text-gray-600 italic">Set name</span>
  }
  if (!signal.claimed_by) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClaim(signal) }}
        className="px-3 py-1 rounded text-xs font-semibold bg-green-700 hover:bg-green-600 text-white transition-colors"
      >
        Claim
      </button>
    )
  }
  if (signal.claimed_by === repName) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="px-2 py-1 rounded text-xs font-semibold bg-blue-700 text-blue-100">Claimed</span>
        <button
          onClick={(e) => { e.stopPropagation(); onUnclaim(signal) }}
          className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white text-xs transition-colors"
          title="Unclaim"
        >
          ×
        </button>
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-gray-700 text-gray-300 text-xs font-bold"
      title={signal.claimed_by}
    >
      {getRepInitials(signal.claimed_by)}
    </span>
  )
}

function ExpandedDetailCard({ signal }) {
  const d = parseDetail(signal.signal_detail)
  const fields = Object.entries(d).filter(([k, v]) => k !== 'rep_notes' && v !== null && v !== undefined && v !== '')
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3 text-sm">
      {signal.companies?.name && (
        <div className="sm:col-span-2">
          <span className="block text-gray-500 text-xs uppercase tracking-wide mb-0.5">Company</span>
          <p className="text-white font-semibold">{signal.companies.name}</p>
        </div>
      )}
      {fields.map(([key, value]) => {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        const isUrl = typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))
        return (
          <div key={key}>
            <span className="block text-gray-500 text-xs uppercase tracking-wide mb-0.5">{label}</span>
            {isUrl ? (
              <a
                href={value}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-blue-400 hover:text-blue-300 underline break-all text-sm"
              >
                {value}
              </a>
            ) : (
              <p className="text-gray-200 text-sm">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</p>
            )}
          </div>
        )
      })}
      {signal.signal_summary && (
        <div className="sm:col-span-2 mt-1">
          <span className="block text-gray-500 text-xs uppercase tracking-wide mb-0.5">Signal Summary</span>
          <p className="text-gray-200 text-sm leading-relaxed">{signal.signal_summary}</p>
        </div>
      )}
    </div>
  )
}

function TableWrapper({ children }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="min-w-full divide-y divide-gray-800">{children}</table>
    </div>
  )
}

function Th({ children, className = '' }) {
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-gray-900 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  )
}

function EmptyState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3">
        <span className="text-gray-600 text-xl font-mono">—</span>
      </div>
      <p className="text-gray-400 text-sm">{message}</p>
    </div>
  )
}

// ─── Tab: Clinical Trials ─────────────────────────────────────────────────────

function ClinicalDetailCell({ signal }) {
  const d = parseDetail(signal.signal_detail)
  switch (signal.signal_type) {
    case 'clinical_trial_phase_transition':
      return (
        <span className="text-sm text-white font-medium">
          {formatPhaseLabel(d.phase_from)} → {formatPhaseLabel(d.phase_to)}
        </span>
      )
    case 'clinical_trial_new_ind':
      return <span className="text-sm text-gray-500">N/A</span>
    case 'clinical_trial_site_activation':
      return (
        <span className="text-sm text-gray-200">
          {d.num_sites ? `${d.num_sites} sites activated` : '—'}
          {d.enrollment_count ? ` — ${d.enrollment_count} enrolled` : ''}
        </span>
      )
    case 'clinical_trial_completion':
      return (
        <div>
          <span className="text-sm text-gray-200">{truncate(d.study_summary, 80)}</span>
          {d.primary_completion_date && (
            <p className="text-xs text-gray-400 mt-0.5">
              completion {formatDate(d.primary_completion_date)}
            </p>
          )}
        </div>
      )
    default:
      return <span className="text-sm text-gray-400">{truncate(signal.signal_summary, 90) || '—'}</span>
  }
}

function ClinicalTab({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim }) {
  if (signals.length === 0) return <EmptyState message="No active clinical trial signals." />
  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th>Type</Th>
          <Th>Company</Th>
          <Th className="min-w-72">Detail</Th>
          <Th className="min-w-48">Summary</Th>
          <Th>Source</Th>
          <Th>Date Updated</Th>
          <Th>Queue</Th>
          <Th>Claim</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800">
        {signals.map((signal, i) => {
          const isExpanded = expandedRows.has(signal.id)
          const d = parseDetail(signal.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'
          return (
            <>
              <tr
                key={signal.id}
                onClick={() => onToggleRow(signal.id)}
                className={`${rowBg} hover:bg-gray-800 cursor-pointer transition-colors`}
              >
                <td className="px-4 py-3 whitespace-nowrap">
                  <SignalTypeBadge signalType={signal.signal_type} />
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm font-semibold text-white whitespace-nowrap">
                    {signal.companies?.name || d.sponsor || '—'}
                  </div>
                  {signal.companies?.industry && (
                    <div className="text-xs text-gray-500 mt-0.5">{signal.companies.industry}</div>
                  )}
                </td>
                <td className="px-4 py-3 min-w-72">
                  <ClinicalDetailCell signal={signal} />
                </td>
                <td className="px-4 py-3" style={{ maxWidth: '400px' }}>
                  <span className="text-xs text-gray-400 leading-snug" style={{ wordBreak: 'break-word', overflowWrap: 'break-word', whiteSpace: 'normal', display: 'block' }}>
                    {d.study_summary || signal.signal_summary || '—'}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                  {d.nct_id ? (
                    <a
                      href={`https://clinicaltrials.gov/study/${d.nct_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 font-mono"
                    >
                      {d.nct_id}
                    </a>
                  ) : '—'}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-400">
                  {formatDate(d.date_updated || signal.updated_at)}
                </td>
                <td className="px-4 py-3">
                  <DaysInQueueBadge dateStr={signal.first_detected_at} />
                </td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                </td>
              </tr>
              {isExpanded && (
                <tr key={`${signal.id}-exp`}>
                  <td colSpan={8} className="bg-gray-800 px-8 py-5 border-b border-gray-700">
                    <ExpandedDetailCard signal={signal} />
                  </td>
                </tr>
              )}
            </>
          )
        })}
      </tbody>
    </TableWrapper>
  )
}

// ─── Tab: Funding & M&A ───────────────────────────────────────────────────────

// Map (signal_type, signal_detail) → a filter key string
function getFundingFilterKey(signal) {
  const d = parseDetail(signal.signal_detail)
  if (signal.signal_type === 'ma_transaction') return d.transaction_type || 'ma'
  if (signal.signal_type === 'funding_renewal')  return 'renewal'
  return 'other'
}

// Filter pill definitions. Only pills with count > 0 are shown.
const FUNDING_FILTER_PILLS = [
  { key: 'all',                label: 'All',             activeClass: 'bg-gray-200 text-gray-900',   inactiveClass: 'bg-gray-800 text-gray-300 hover:bg-gray-700' },
  { key: 'merger',             label: 'Merger',          activeClass: 'bg-amber-600 text-white',      inactiveClass: 'bg-amber-900/40 text-amber-300 hover:bg-amber-900/70' },
  { key: 'acquisition',        label: 'Acquisition',     activeClass: 'bg-orange-600 text-white',     inactiveClass: 'bg-orange-900/40 text-orange-300 hover:bg-orange-900/70' },
  { key: 'ipo',                label: 'IPO',             activeClass: 'bg-emerald-600 text-white',    inactiveClass: 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/70' },
  { key: 'product_acquisition',label: 'Product Acq',    activeClass: 'bg-violet-600 text-white',     inactiveClass: 'bg-violet-900/40 text-violet-300 hover:bg-violet-900/70' },
  { key: 'partnership',        label: 'Partnership',     activeClass: 'bg-blue-600 text-white',       inactiveClass: 'bg-blue-900/40 text-blue-300 hover:bg-blue-900/70' },
  { key: 'renewal',            label: 'Renewal',         activeClass: 'bg-lime-600 text-white',       inactiveClass: 'bg-lime-900/40 text-lime-300 hover:bg-lime-900/70' },
  { key: 'ma',                 label: 'M&A',             activeClass: 'bg-gray-500 text-white',       inactiveClass: 'bg-gray-800 text-gray-400 hover:bg-gray-700' },
]

function FundingTab({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim }) {
  const [selectedType, setSelectedType] = useState('all')

  // Count signals per filter key
  const typeCounts = { all: signals.length }
  for (const s of signals) {
    const k = getFundingFilterKey(s)
    typeCounts[k] = (typeCounts[k] || 0) + 1
  }

  // Only show pills that have at least 1 signal (or the "All" pill)
  const visiblePills = FUNDING_FILTER_PILLS.filter(p => p.key === 'all' || (typeCounts[p.key] || 0) > 0)

  // Filter the signal list based on selected type
  const filteredSignals = selectedType === 'all'
    ? signals
    : signals.filter(s => getFundingFilterKey(s) === selectedType)

  if (signals.length === 0) return <EmptyState message="No active funding or M&A signals." />
  return (
    <div className="flex flex-col gap-4">
      {/* ── Type filter pills ── */}
      <div className="flex flex-wrap gap-1.5">
        {visiblePills.map(pill => {
          const isActive = selectedType === pill.key
          const count = pill.key === 'all' ? signals.length : (typeCounts[pill.key] || 0)
          return (
            <button
              key={pill.key}
              onClick={() => setSelectedType(pill.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${isActive ? pill.activeClass : pill.inactiveClass}`}
            >
              {pill.label}
              <span className={`inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full text-xs font-bold ${isActive ? 'bg-black/20' : 'bg-black/30'}`}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

    <TableWrapper>
      <thead>
        <tr>
          <Th>Type</Th>
          <Th>Company</Th>
          <Th>Amount</Th>
          <Th className="min-w-64">Summary</Th>
          <Th>Date</Th>
          <Th>Queue</Th>
          <Th>Claim</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800">
        {filteredSignals.map((signal, i) => {
          const isExpanded = expandedRows.has(signal.id)
          const d = parseDetail(signal.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'
          return (
            <>
              <tr
                key={signal.id}
                onClick={() => onToggleRow(signal.id)}
                className={`${rowBg} hover:bg-gray-800 cursor-pointer transition-colors`}
              >
                <td className="px-4 py-3 whitespace-nowrap">
                  {signal.signal_type === 'ma_transaction' ? (() => {
                    const ttCfg = MA_TRANSACTION_TYPE_CONFIG[d.transaction_type] || { label: 'M&A', color: 'bg-orange-600' }
                    return (
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold text-white whitespace-nowrap ${ttCfg.color}`}>
                        {ttCfg.label}
                      </span>
                    )
                  })() : (
                    <SignalTypeBadge signalType={signal.signal_type} fundingType={d.funding_type} />
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-white whitespace-nowrap">
                      {signal.signal_type === 'ma_transaction' ? (() => {
                        const tt = d.transaction_type
                        const acquirer = d.acquirer_name || signal.companies?.name || '—'
                        const acquired = d.acquired_name
                        const companyName = signal.companies?.name || d.company_name || acquirer
                        if (tt === 'ipo') return companyName
                        // merger: acquirer_name=Parent, acquired_name=target (filer)
                        if (tt === 'merger') return acquired ? `${acquirer} → ${acquired}` : acquirer
                        // product_acquisition: filer → seller (use company_name as the acquirer)
                        if (tt === 'product_acquisition') return acquired ? `${companyName} → ${acquired}` : companyName
                        if (tt === 'partnership') return acquired ? `${companyName} ↔ ${acquired}` : companyName
                        // acquisition: acquirer → acquired target (no fallback text)
                        return acquired ? `${acquirer} → ${acquired}` : acquirer
                      })() : signal.companies?.name || d.company_name || '—'}
                    </span>
                    {d.pre_hiring_signal && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-900 text-yellow-300">
                        ★ Pre-hiring
                      </span>
                    )}
                  </div>
                  {signal.companies?.industry && (
                    <div className="text-xs text-gray-500 mt-0.5">{signal.companies.industry}</div>
                  )}
                  {signal.signal_type === 'ma_transaction' && d.acquired_asset && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      Asset: <span className="font-mono text-blue-300">{d.acquired_asset}</span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-green-400">
                  {signal.signal_type === 'ma_transaction' ? 'N/A' : (d.funding_amount || 'Undisclosed')}
                </td>
                <td className="px-4 py-3 min-w-64">
                  <span className="text-sm text-gray-200">
                    {truncate(d.deal_summary || d.funding_summary || signal.signal_summary, 100)}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-400">
                  {formatDate(d.date_announced || signal.first_detected_at)}
                </td>
                <td className="px-4 py-3">
                  <DaysInQueueBadge dateStr={signal.first_detected_at} />
                </td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                </td>
              </tr>
              {isExpanded && (
                <tr key={`${signal.id}-exp`}>
                  <td colSpan={7} className="bg-gray-800 px-8 py-5 border-b border-gray-700">
                    <ExpandedDetailCard signal={signal} />
                  </td>
                </tr>
              )}
            </>
          )
        })}
      </tbody>
    </TableWrapper>
    </div>
  )
}

// ─── Tab: Jobs ────────────────────────────────────────────────────────────────

function JobsTab({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim }) {
  const competitorSignals = signals.filter(s => s.signal_type === 'competitor_job_posting')
  const staleSignals = signals.filter(s =>
    s.signal_type === 'stale_job_posting' || s.signal_type === 'target_company_job'
  )

  if (signals.length === 0) return <EmptyState message="No active job signals. Run agents to search for open roles." />

  return (
    <div className="flex flex-col gap-10">

      {/* ── Section Navigation ── */}
      <div className="flex gap-1 border-b border-gray-800 pb-0 -mb-6">
        <button
          onClick={() => document.getElementById('competitor-postings')?.scrollIntoView({ behavior: 'smooth' })}
          className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-t transition-colors"
        >
          Competitor Postings
          <span className="px-1.5 py-0.5 rounded-full bg-red-900 text-red-300 text-xs font-bold">
            {competitorSignals.length}
          </span>
        </button>
        <button
          onClick={() => document.getElementById('stale-roles')?.scrollIntoView({ behavior: 'smooth' })}
          className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-t transition-colors"
        >
          Stale Roles
          <span className="px-1.5 py-0.5 rounded-full bg-amber-900 text-amber-300 text-xs font-bold">
            {staleSignals.length}
          </span>
        </button>
      </div>

      {/* ── Section 1: Competitor Postings ── */}
      <div>
        <div className="flex items-center gap-2 mb-3" id="competitor-postings">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Competitor Postings</h2>
          <span className="px-2 py-0.5 rounded-full bg-red-900 text-red-300 text-xs font-bold">
            {competitorSignals.length}
          </span>
        </div>
        {competitorSignals.length === 0 ? (
          <p className="text-xs text-gray-600 italic px-1">No competitor postings found yet.</p>
        ) : (
          <TableWrapper>
            <thead>
              <tr>
                <Th>Role Title</Th>
                <Th>Location</Th>
                <Th>Competitor</Th>
                <Th>Date Posted</Th>
                <Th>View</Th>
                <Th>Claim</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {competitorSignals.map((signal, i) => {
                const isExpanded = expandedRows.has(signal.id)
                const d = parseDetail(signal.signal_detail)
                const rowBg = i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'
                return (
                  <>
                    <tr
                      key={signal.id}
                      onClick={() => onToggleRow(signal.id)}
                      className={`${rowBg} hover:bg-gray-800 cursor-pointer transition-colors`}
                    >
                      <td className="px-4 py-3 text-sm text-white font-medium">{d.job_title || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">{d.job_location || '—'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-100 whitespace-nowrap">
                        {d.competitor_firm || signal.companies?.name || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-400">
                        {formatDate(d.posting_date || signal.first_detected_at)}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        {(d.job_url || d.source_url) ? (
                          <a
                            href={d.job_url || d.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 font-medium whitespace-nowrap"
                          >
                            View Posting ↗
                          </a>
                        ) : <span className="text-xs text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${signal.id}-exp`}>
                        <td colSpan={6} className="bg-gray-800 px-8 py-5 border-b border-gray-700">
                          <ExpandedDetailCard signal={signal} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </TableWrapper>
        )}
      </div>

      {/* ── Section 2: Stale Roles at Target Companies ── */}
      <div>
        <div className="flex items-center gap-2 mb-3" id="stale-roles">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Stale Roles at Target Companies</h2>
          <span className="px-2 py-0.5 rounded-full bg-amber-900 text-amber-300 text-xs font-bold">
            {staleSignals.length}
          </span>
          <span className="text-xs text-gray-600 italic">Long-open roles at companies in your BD pipeline</span>
        </div>
        {staleSignals.length === 0 ? (
          <p className="text-xs text-gray-600 italic px-1">No stale roles found yet — run agents to search target company career pages and BioSpace.</p>
        ) : (
          <TableWrapper>
            <thead>
              <tr>
                <Th>Role Title</Th>
                <Th>Company</Th>
                <Th>Hiring Manager</Th>
                <Th>Location</Th>
                <Th>Days Open</Th>
                <Th>View</Th>
                <Th>Claim</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {staleSignals.map((signal, i) => {
                const isExpanded = expandedRows.has(signal.id)
                const d = parseDetail(signal.signal_detail)
                const rowBg = i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'
                const daysOpen = d.days_posted || signal.days_in_queue || 0
                const dayCls = daysOpen >= 45
                  ? 'bg-red-900 text-red-300'
                  : daysOpen >= 30
                    ? 'bg-orange-900 text-orange-300'
                    : 'bg-gray-700 text-gray-300'
                return (
                  <>
                    <tr
                      key={signal.id}
                      onClick={() => onToggleRow(signal.id)}
                      className={`${rowBg} hover:bg-gray-800 cursor-pointer transition-colors`}
                    >
                      <td className="px-4 py-3 text-sm text-white font-medium">{d.job_title || '—'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-100 whitespace-nowrap">
                        {signal.companies?.name || d.company_name || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {d.hiring_manager && d.hiring_manager !== 'Unknown'
                          ? <span className="text-sm text-gray-100">{d.hiring_manager}</span>
                          : <span className="text-xs text-gray-600 italic">Unknown</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">{d.job_location || '—'}</td>
                      <td className="px-4 py-3">
                        {daysOpen > 0 ? (
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${dayCls}`}>
                            {daysOpen}d
                          </span>
                        ) : <span className="text-xs text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        {(d.job_url || d.careers_url) ? (
                          <a
                            href={d.job_url || d.careers_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 font-medium whitespace-nowrap"
                          >
                            View ↗
                          </a>
                        ) : <span className="text-xs text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${signal.id}-exp`}>
                        <td colSpan={7} className="bg-gray-800 px-8 py-5 border-b border-gray-700">
                          <ExpandedDetailCard signal={signal} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </TableWrapper>
        )}
      </div>
    </div>
  )
}

// ─── Tab: My Leads ────────────────────────────────────────────────────────────

function LeadsNoteCell({ signal, notes, onSaveNotes, savingNotes }) {
  const d = parseDetail(signal.signal_detail)
  const serverNote = d.rep_notes || notes[signal.id] || ''
  const [localNote, setLocalNote] = useState(serverNote)
  const isSaving = savingNotes.has(signal.id)
  const isDirty = localNote !== serverNote

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        rows={2}
        value={localNote}
        onChange={e => setLocalNote(e.target.value)}
        onBlur={() => { if (isDirty) onSaveNotes(signal.id, localNote) }}
        placeholder="Add outreach notes..."
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none min-w-48"
      />
      {isDirty && (
        <button
          onClick={() => onSaveNotes(signal.id, localNote)}
          disabled={isSaving}
          className="self-end px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-xs text-white font-medium transition-colors"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      )}
    </div>
  )
}

function LeadsGroup({ groupKey, label, signals, notes, savingNotes, onSaveNotes, onUpdateStatus, groupOpen, setGroupOpen }) {
  const isOpen = groupOpen[groupKey] !== false
  const toggle = () => setGroupOpen(prev => ({ ...prev, [groupKey]: !isOpen }))

  return (
    <div className="rounded-lg border border-gray-800 overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-gray-900 hover:bg-gray-850 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-300 uppercase tracking-widest">{label}</span>
          <span className="px-2 py-0.5 rounded-full bg-blue-900 text-blue-300 text-xs font-bold">{signals.length}</span>
        </div>
        <span className="text-gray-500 text-xs">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-800">
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Company</Th>
                <Th className="min-w-64">Summary</Th>
                <Th>Date Claimed</Th>
                <Th>Status</Th>
                <Th className="min-w-52">Notes</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {signals.map((signal, i) => {
                const d = parseDetail(signal.signal_detail)
                const rowBg = i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'
                return (
                  <tr key={signal.id} className={`${rowBg} hover:bg-gray-800 transition-colors`}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <SignalTypeBadge signalType={signal.signal_type} fundingType={d.funding_type} />
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-white whitespace-nowrap">
                      {signal.companies?.name || d.company_name || d.sponsor || '—'}
                    </td>
                    <td className="px-4 py-3 min-w-64">
                      <span className="text-sm text-gray-300 leading-snug">
                        {truncate(d.funding_summary || d.study_summary || signal.signal_summary, 90)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-400">
                      {formatDate(signal.updated_at)}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={signal.status}
                        onChange={e => onUpdateStatus(signal, e.target.value)}
                        onClick={e => e.stopPropagation()}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="claimed">Claimed</option>
                        <option value="contacted">Contacted</option>
                        <option value="closed">Closed</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <LeadsNoteCell
                        signal={signal}
                        notes={notes}
                        onSaveNotes={onSaveNotes}
                        savingNotes={savingNotes}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function LeadsTab({ signals, repName, notes, savingNotes, onSaveNotes, onUpdateStatus, groupOpen, setGroupOpen }) {
  if (!repName) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center mb-4">
          <span className="text-gray-500 text-2xl font-bold">?</span>
        </div>
        <p className="text-gray-300 text-base font-semibold mb-1">Set your name above to see your leads.</p>
        <p className="text-gray-500 text-sm">Your claimed signals will appear here for tracking and outreach notes.</p>
      </div>
    )
  }

  if (signals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center mb-4">
          <span className="text-gray-500 text-2xl font-mono">—</span>
        </div>
        <p className="text-gray-300 text-base font-semibold mb-1">No leads claimed yet.</p>
        <p className="text-gray-500 text-sm">Claim signals from the other tabs to track them here.</p>
      </div>
    )
  }

  const clinicalSignals = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'clinical')
  const fundingSignals  = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'funding')
  const jobsSignals     = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'jobs')

  const groups = [
    { key: 'clinical', label: 'Clinical Trials',  items: clinicalSignals },
    { key: 'funding',  label: 'Funding & M&A',    items: fundingSignals },
    { key: 'jobs',     label: 'Jobs',              items: jobsSignals },
  ].filter(g => g.items.length > 0)

  return (
    <div className="flex flex-col gap-5">
      {groups.map(group => (
        <LeadsGroup
          key={group.key}
          groupKey={group.key}
          label={group.label}
          signals={group.items}
          notes={notes}
          savingNotes={savingNotes}
          onSaveNotes={onSaveNotes}
          onUpdateStatus={onUpdateStatus}
          groupOpen={groupOpen}
          setGroupOpen={setGroupOpen}
        />
      ))}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [activeTab, setActiveTab]         = useState('clinical')
  const [signals, setSignals]             = useState([])
  const [loading, setLoading]             = useState(true)
  const [repName, setRepName]             = useState('')
  const [showRepInput, setShowRepInput]   = useState(false)
  const [repInputValue, setRepInputValue] = useState('')
  const [expandedRows, setExpandedRows]   = useState(new Set())
  const [notes, setNotes]                 = useState({})
  const [savingNotes, setSavingNotes]     = useState(new Set())
  const [leadsGroupOpen, setLeadsGroupOpen] = useState({ clinical: true, funding: true, jobs: true })
  const [agentRunning, setAgentRunning]     = useState(false)
  const [toast, setToast]                   = useState(null) // { type: 'success'|'error', message }
  const repInputRef = useRef(null)

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSignals(data.signals || [])
    } catch (err) {
      console.error('Error fetching signals:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('biosignal_rep_name')
    if (stored) setRepName(stored)
    fetchSignals()
  }, [fetchSignals])

  useEffect(() => {
    if (!supabase) return
    const channel = supabase
      .channel('signals-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals' }, () => fetchSignals())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals' }, () => fetchSignals())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'signals' }, () => fetchSignals())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchSignals])

  useEffect(() => {
    if (showRepInput && repInputRef.current) repInputRef.current.focus()
  }, [showRepInput])

  const activeStatuses = ['new', 'carried_forward', 'claimed', 'contacted']

  const tabSignals = {
    clinical: signals.filter(s => {
      if (SIGNAL_TYPE_CONFIG[s.signal_type]?.tab !== 'clinical') return false
      if (!activeStatuses.includes(s.status)) return false
      const d = parseDetail(s.signal_detail)
      // Hide Pre-Clinical → anything (too noisy) and anything → ?, NA, N/A (bad data)
      if (d.phase_from === 'Pre-Clinical') return false
      if (d.phase_to && ['?', 'NA', 'N/A'].includes(String(d.phase_to).trim())) return false
      return true
    }),
    funding:  signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'funding'  && activeStatuses.includes(s.status)),
    jobs:     signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'jobs'      && activeStatuses.includes(s.status)),
    leads:    repName ? signals.filter(s => s.claimed_by === repName) : [],
  }

  const tabCounts = {
    clinical: tabSignals.clinical.length,
    funding:  tabSignals.funding.length,
    jobs:     tabSignals.jobs.length,
    leads:    tabSignals.leads.length,
  }

  const toggleRow = (id) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const claimSignal = async (signal) => {
    if (!repName) return
    setSignals(prev => prev.map(s => s.id === signal.id ? { ...s, claimed_by: repName, status: 'claimed' } : s))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signal.id, claimed_by: repName, status: 'claimed' }),
      })
      fetchSignals()
    } catch (err) {
      console.error('Error claiming signal:', err)
      fetchSignals()
    }
  }

  const unclaimSignal = async (signal) => {
    setSignals(prev => prev.map(s => s.id === signal.id ? { ...s, claimed_by: null, status: 'new' } : s))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signal.id, claimed_by: null, status: 'new' }),
      })
      fetchSignals()
    } catch (err) {
      console.error('Error unclaiming signal:', err)
      fetchSignals()
    }
  }

  const updateStatus = async (signal, newStatus) => {
    setSignals(prev => prev.map(s => s.id === signal.id ? { ...s, status: newStatus } : s))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signal.id, status: newStatus }),
      })
      fetchSignals()
    } catch (err) {
      console.error('Error updating status:', err)
      fetchSignals()
    }
  }

  const saveNotes = async (signalId, text) => {
    setSavingNotes(prev => new Set(prev).add(signalId))
    setNotes(prev => ({ ...prev, [signalId]: text }))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signalId, notes: text }),
      })
      fetchSignals()
    } catch (err) {
      console.error('Error saving notes:', err)
    } finally {
      setSavingNotes(prev => {
        const next = new Set(prev)
        next.delete(signalId)
        return next
      })
    }
  }

  const runAgents = async () => {
    setAgentRunning(true)
    setToast(null)
    try {
      const token = process.env.NEXT_PUBLIC_AGENT_SECRET_TOKEN
      const res = await fetch('/api/agents/orchestrator', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!res.ok) {
        setToast({ type: 'error', message: data.error || `HTTP ${res.status}` })
      } else {
        const total =
          data.totalSignals ??
          data.signalsFound ??
          Object.values(data.results || {}).reduce((sum, r) => sum + (r.signalsFound || 0), 0)
        setToast({ type: 'success', message: `Agents complete — ${total} new signals found` })
        fetchSignals()
      }
    } catch (err) {
      setToast({ type: 'error', message: err.message })
    } finally {
      setAgentRunning(false)
      setTimeout(() => setToast(null), 6000)
    }
  }

  const saveRepName = () => {
    const trimmed = repInputValue.trim()
    if (trimmed) {
      setRepName(trimmed)
      localStorage.setItem('biosignal_rep_name', trimmed)
    }
    setShowRepInput(false)
  }

  const tabs = [
    { key: 'clinical', label: 'Clinical Trials' },
    { key: 'funding',  label: 'Funding & M&A' },
    { key: 'jobs',     label: 'Jobs' },
    { key: 'leads',    label: 'My Leads' },
  ]

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* ── Header ── */}
      <header className="bg-gray-900 border-b border-gray-800 sticky top-0 z-50">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6">
          {/* Top row */}
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <span className="text-white font-extrabold text-xl tracking-tight">BioSignal BD</span>
              <span className="hidden sm:inline text-gray-500 text-xs font-medium uppercase tracking-widest">
                Life Sciences Intelligence
              </span>
            </div>

            {/* Right-side actions */}
            <div className="flex items-center gap-2">
              {/* Refresh */}
              <button
                onClick={fetchSignals}
                disabled={loading}
                title="Refresh signals"
                className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
              >
                <svg
                  className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>

              {/* Run Agents */}
              <button
                onClick={runAgents}
                disabled={agentRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                {agentRunning ? (
                  <>
                    <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                    Running…
                  </>
                ) : 'Run Agents'}
              </button>

              {/* Rep identity */}
              {showRepInput ? (
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-xs hidden sm:inline">Your name:</span>
                  <input
                    ref={repInputRef}
                    type="text"
                    value={repInputValue}
                    onChange={e => setRepInputValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveRepName()
                      if (e.key === 'Escape') setShowRepInput(false)
                    }}
                    className="bg-gray-800 border border-gray-700 rounded px-2.5 py-1 text-sm text-white focus:outline-none focus:border-blue-500 w-36"
                    placeholder="First Last"
                  />
                  <button
                    onClick={saveRepName}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded font-semibold transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setShowRepInput(false)}
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : repName ? (
                <button
                  onClick={() => { setRepInputValue(repName); setShowRepInput(true) }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-800 hover:bg-gray-700 transition-colors group"
                >
                  <span className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs font-bold text-white select-none">
                    {getRepInitials(repName)}
                  </span>
                  <span className="text-sm text-gray-300 group-hover:text-white">{repName}</span>
                </button>
              ) : (
                <button
                  onClick={() => { setRepInputValue(''); setShowRepInput(true) }}
                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
                >
                  Set name →
                </button>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex items-end">
            {tabs.map(tab => {
              const isActive = activeTab === tab.key
              const count = tabCounts[tab.key]
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`
                    flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors
                    ${isActive
                      ? 'text-white border-white'
                      : 'text-gray-400 border-transparent hover:text-gray-200'
                    }
                  `}
                >
                  {tab.label}
                  {count > 0 && (
                    <span
                      className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-bold ${
                        isActive ? 'bg-white text-gray-900' : 'bg-gray-700 text-gray-300'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      {/* ── Toast notification ── */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3.5 rounded-lg shadow-2xl text-sm font-medium max-w-sm ${
            toast.type === 'success'
              ? 'bg-green-800 text-green-100 border border-green-700'
              : 'bg-red-900 text-red-100 border border-red-700'
          }`}
        >
          <span className="shrink-0 text-base">{toast.type === 'success' ? '✓' : '✕'}</span>
          <span className="flex-1 leading-snug">{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            className="shrink-0 ml-1 opacity-60 hover:opacity-100 transition-opacity text-xs leading-none"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Main Content ── */}
      <main className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-gray-400 text-sm">Loading signals...</span>
          </div>
        ) : (
          <>
            {activeTab === 'clinical' && (
              <ClinicalTab
                signals={tabSignals.clinical}
                repName={repName}
                expandedRows={expandedRows}
                onToggleRow={toggleRow}
                onClaim={claimSignal}
                onUnclaim={unclaimSignal}
              />
            )}
            {activeTab === 'funding' && (
              <FundingTab
                signals={tabSignals.funding}
                repName={repName}
                expandedRows={expandedRows}
                onToggleRow={toggleRow}
                onClaim={claimSignal}
                onUnclaim={unclaimSignal}
              />
            )}
            {activeTab === 'jobs' && (
              <JobsTab
                signals={tabSignals.jobs}
                repName={repName}
                expandedRows={expandedRows}
                onToggleRow={toggleRow}
                onClaim={claimSignal}
                onUnclaim={unclaimSignal}
              />
            )}
            {activeTab === 'leads' && (
              <LeadsTab
                signals={tabSignals.leads}
                repName={repName}
                notes={notes}
                savingNotes={savingNotes}
                onSaveNotes={saveNotes}
                onUpdateStatus={updateStatus}
                groupOpen={leadsGroupOpen}
                setGroupOpen={setLeadsGroupOpen}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}
