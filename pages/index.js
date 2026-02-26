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

const MA_TRANSACTION_TYPE_CONFIG = {
  ipo:                 { label: 'IPO',                 color: 'bg-emerald-600' },
  acquisition:         { label: 'Acquisition',         color: 'bg-orange-600' },
  product_acquisition: { label: 'Product Acquisition', color: 'bg-violet-600' },
  merger:              { label: 'Merger',              color: 'bg-amber-600' },
  partnership:         { label: 'Partnership',         color: 'bg-blue-600' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDetail(raw) {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw
}

function formatPhaseLabel(raw) {
  if (!raw) return '?'
  const s = String(raw).trim()
  if (/^PHASE\d+$/i.test(s)) return s.replace(/PHASE(\d+)/i, 'Phase $1')
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
    <div className="overflow-x-auto rounded-lg border border-[#374151]">
      <table className="min-w-full divide-y divide-[#374151]">{children}</table>
    </div>
  )
}

function Th({ children, className = '' }) {
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  )
}

function EmptyState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 rounded-full bg-[#1f2937] flex items-center justify-center mb-3">
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
          <Th>Client Score</Th>
          <Th>Queue</Th>
          <Th>Claim</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {signals.map((signal, i) => {
          const isExpanded = expandedRows.has(signal.id)
          const d = parseDetail(signal.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          return (
            <>
              <tr
                key={signal.id}
                onClick={() => onToggleRow(signal.id)}
                className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
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
                <td className="px-4 py-3 whitespace-nowrap">
                  {d.past_client
                    ? <span className="inline-block px-2 py-0.5 rounded text-xs font-bold bg-[#78350f] text-[#fbbf24]">+{d.past_client.boost_score}</span>
                    : <span className="text-xs text-gray-600">—</span>}
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
                  <td colSpan={9} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
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

function getFundingFilterKey(signal) {
  const d = parseDetail(signal.signal_detail)
  if (signal.signal_type === 'ma_transaction') return d.transaction_type || 'ma'
  if (signal.signal_type === 'funding_renewal')  return 'renewal'
  return 'other'
}

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

  const typeCounts = { all: signals.length }
  for (const s of signals) {
    const k = getFundingFilterKey(s)
    typeCounts[k] = (typeCounts[k] || 0) + 1
  }

  const visiblePills = FUNDING_FILTER_PILLS.filter(p => p.key === 'all' || (typeCounts[p.key] || 0) > 0)

  const filteredSignals = selectedType === 'all'
    ? signals
    : signals.filter(s => getFundingFilterKey(s) === selectedType)

  if (signals.length === 0) return <EmptyState message="No active funding or M&A signals." />
  return (
    <div className="flex flex-col gap-4">
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
            <Th>Client Score</Th>
            <Th>Queue</Th>
            <Th>Claim</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#374151]">
          {filteredSignals.map((signal, i) => {
            const isExpanded = expandedRows.has(signal.id)
            const d = parseDetail(signal.signal_detail)
            const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
            return (
              <>
                <tr
                  key={signal.id}
                  onClick={() => onToggleRow(signal.id)}
                  className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
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
                          if (tt === 'merger') return acquired ? `${acquirer} → ${acquired}` : acquirer
                          if (tt === 'product_acquisition') return acquired ? `${companyName} → ${acquired}` : companyName
                          if (tt === 'partnership') return acquired ? `${companyName} ↔ ${acquired}` : companyName
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
                  <td className="px-4 py-3 whitespace-nowrap">
                    {d.past_client
                      ? <span className="inline-block px-2 py-0.5 rounded text-xs font-bold bg-[#78350f] text-[#fbbf24]">+{d.past_client.boost_score}</span>
                      : <span className="text-xs text-gray-600">—</span>}
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
                    <td colSpan={8} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
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
        className="w-full bg-[#111827] border border-[#374151] rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none min-w-48"
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
    <div className="rounded-lg border border-[#374151] overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-[#1a2234] hover:bg-[#263045] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-300 uppercase tracking-widest">{label}</span>
          <span className="px-2 py-0.5 rounded-full bg-blue-900 text-blue-300 text-xs font-bold">{signals.length}</span>
        </div>
        <span className="text-gray-500 text-xs">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[#374151]">
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
            <tbody className="divide-y divide-[#374151]">
              {signals.map((signal, i) => {
                const d = parseDetail(signal.signal_detail)
                const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                return (
                  <tr key={signal.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
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
                        className="bg-[#111827] border border-[#374151] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer"
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
        <div className="w-14 h-14 rounded-full bg-[#1f2937] flex items-center justify-center mb-4">
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
        <div className="w-14 h-14 rounded-full bg-[#1f2937] flex items-center justify-center mb-4">
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

// ─── Nav Icons ────────────────────────────────────────────────────────────────

function NavIcon({ type, className = 'w-5 h-5' }) {
  const props = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', className }
  switch (type) {
    case 'grid':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
      )
    case 'beaker':
      return (
        <svg {...props}>
          <path d="M9 3h6"/>
          <path d="M8.5 3v6L4 19a1 1 0 0 0 .9 1.45h14.2a1 1 0 0 0 .9-1.45L15.5 9V3"/>
          <line x1="6" y1="14" x2="18" y2="14"/>
        </svg>
      )
    case 'trending':
      return (
        <svg {...props}>
          <polyline points="22,7 13.5,15.5 8.5,10.5 2,17"/>
          <polyline points="16,7 22,7 22,13"/>
        </svg>
      )
    case 'briefcase':
      return (
        <svg {...props}>
          <path d="M20 7H4C2.9 7 2 7.9 2 9v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/>
          <path d="M16 7V5c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2"/>
        </svg>
      )
    case 'clock':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12,6 12,12 16,14"/>
        </svg>
      )
    case 'clipboard':
      return (
        <svg {...props}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      )
    case 'users':
      return (
        <svg {...props}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      )
    case 'user':
      return (
        <svg {...props}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      )
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      )
    default:
      return <svg {...props}><circle cx="12" cy="12" r="4"/></svg>
  }
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const MAIN_NAV = [
  { key: 'dashboard',  label: 'Dashboard',        icon: 'grid' },
  { key: 'clinical',   label: 'Clinical Trials',   icon: 'beaker',    countKey: 'clinical' },
  { key: 'funding',    label: 'Funding & M&A',     icon: 'trending',  countKey: 'funding' },
  { key: 'competitor', label: 'Competitor Jobs',   icon: 'briefcase', countKey: 'competitor' },
  { key: 'stale',      label: 'Stale Roles',       icon: 'clock',     countKey: 'stale' },
  { key: 'leads',      label: 'My Leads',          icon: 'clipboard', countKey: 'leads' },
  { key: 'buyers',     label: 'Past Buyers',       icon: 'users' },
  { key: 'candidates', label: 'Past Candidates',   icon: 'user' },
]

function Sidebar({ activePage, setActivePage, tabCounts }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 w-16 lg:w-[220px] flex flex-col bg-[#0f1729] border-r border-[#1e2d4a]">
      {/* Brand */}
      <div className="flex items-center gap-3 px-3 lg:px-4 h-14 border-b border-[#1e2d4a] shrink-0">
        <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-bold select-none">B</span>
        </div>
        <div className="hidden lg:block min-w-0">
          <div className="text-white font-bold text-sm leading-tight">BioSignal</div>
          <div className="text-blue-400/60 text-[10px] font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 flex flex-col gap-0.5">
        {MAIN_NAV.map(item => {
          const isActive = activePage === item.key
          const count = item.countKey ? (tabCounts[item.countKey] || 0) : 0
          return (
            <button
              key={item.key}
              onClick={() => setActivePage(item.key)}
              className={`relative flex items-center gap-3 px-2.5 py-2.5 rounded-md text-sm font-medium transition-colors w-full justify-center lg:justify-start ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-blue-500 rounded-r-full" />
              )}
              <NavIcon type={item.icon} className="w-5 h-5 shrink-0" />
              <span className="hidden lg:inline truncate">{item.label}</span>
              {count > 0 && (
                <span className={`hidden lg:inline ml-auto text-xs font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                  isActive ? 'bg-blue-600/30 text-blue-300' : 'bg-white/10 text-gray-400'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Settings pinned to bottom */}
      <div className="shrink-0 py-3 px-2 border-t border-[#1e2d4a]">
        <button
          onClick={() => setActivePage('settings')}
          className={`relative flex items-center gap-3 px-2.5 py-2.5 rounded-md text-sm font-medium transition-colors w-full justify-center lg:justify-start ${
            activePage === 'settings'
              ? 'bg-blue-600/20 text-blue-400'
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
        >
          {activePage === 'settings' && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-blue-500 rounded-r-full" />
          )}
          <NavIcon type="settings" className="w-5 h-5 shrink-0" />
          <span className="hidden lg:inline">Settings</span>
        </button>
      </div>
    </aside>
  )
}

// ─── TopBar ───────────────────────────────────────────────────────────────────

const PAGE_TITLES = {
  dashboard:  'Dashboard',
  clinical:   'Clinical Trials',
  funding:    'Funding & M&A',
  competitor: 'Competitor Jobs',
  stale:      'Stale Roles',
  leads:      'My Leads',
  buyers:     'Past Buyers',
  candidates: 'Past Candidates',
  settings:   'Settings',
}

function TopBar({
  activePage, loading, agentRunning,
  repName, showRepInput, repInputValue, repInputRef,
  onRefresh, onRunAgents,
  onEditRep, onStartRep, onRepChange, onSaveRep, onCancelRep,
}) {
  return (
    <div className="bg-[#1f2937] border-b border-[#374151] px-6 py-3 flex items-center justify-between gap-4 sticky top-0 z-30">
      {/* Page title */}
      <h1 className="text-base font-semibold text-white truncate">
        {PAGE_TITLES[activePage] || activePage}
      </h1>

      {/* Right actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Refresh */}
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh signals"
          className="p-1.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
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
          onClick={onRunAgents}
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
            <input
              ref={repInputRef}
              type="text"
              value={repInputValue}
              onChange={onRepChange}
              onKeyDown={e => {
                if (e.key === 'Enter') onSaveRep()
                if (e.key === 'Escape') onCancelRep()
              }}
              className="bg-[#111827] border border-[#374151] rounded px-2.5 py-1 text-sm text-white focus:outline-none focus:border-blue-500 w-32"
              placeholder="First Last"
            />
            <button
              onClick={onSaveRep}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded font-semibold transition-colors"
            >
              Save
            </button>
            <button
              onClick={onCancelRep}
              className="px-2 py-1 bg-white/10 hover:bg-white/20 text-gray-300 text-xs rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : repName ? (
          <button
            onClick={onEditRep}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors group"
          >
            <span className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs font-bold text-white select-none">
              {getRepInitials(repName)}
            </span>
            <span className="text-sm text-gray-300 group-hover:text-white hidden sm:inline">{repName}</span>
          </button>
        ) : (
          <button
            onClick={onStartRep}
            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
          >
            Set name →
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

const AGENT_DISPLAY = {
  clinical_trial_monitor:     'Clinical Trial Monitor',
  funding_ma_agent:           'Funding & M&A Agent',
  competitor_job_board_agent: 'Competitor Job Board',
  stale_job_tracker:          'Stale Job Tracker',
}

function DashboardPage({ signals, agentRuns }) {
  const clinicalNew  = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'clinical' && s.status === 'new').length
  const fundingNew   = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'funding'  && s.status === 'new').length
  const competitorNew = signals.filter(s => s.signal_type === 'competitor_job_posting' && s.status === 'new').length
  const staleNew     = signals.filter(s => ['stale_job_posting', 'target_company_job'].includes(s.signal_type) && s.status === 'new').length

  const summaryCards = [
    { label: 'Clinical Trials',  count: clinicalNew,   icon: 'beaker',    accent: 'text-blue-400',  iconBg: 'bg-blue-600/20' },
    { label: 'Funding & M&A',    count: fundingNew,    icon: 'trending',  accent: 'text-green-400', iconBg: 'bg-green-600/20' },
    { label: 'Competitor Jobs',  count: competitorNew, icon: 'briefcase', accent: 'text-red-400',   iconBg: 'bg-red-600/20' },
    { label: 'Stale Roles',      count: staleNew,      icon: 'clock',     accent: 'text-amber-400', iconBg: 'bg-amber-600/20' },
  ]

  // Group agentRuns by agent_name, take most recent per agent
  const latestRuns = {}
  for (const run of agentRuns) {
    if (!latestRuns[run.agent_name] || new Date(run.started_at) > new Date(latestRuns[run.agent_name].started_at)) {
      latestRuns[run.agent_name] = run
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {summaryCards.map(card => (
          <div key={card.label} className="bg-[#1f2937] border border-[#374151] rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-400">{card.label}</span>
              <div className={`w-9 h-9 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                <NavIcon type={card.icon} className={`w-4 h-4 ${card.accent}`} />
              </div>
            </div>
            <div className="text-4xl font-bold text-white">{card.count}</div>
            <div className="text-xs text-gray-500 mt-1">new signals</div>
          </div>
        ))}
      </div>

      {/* Agent Status */}
      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Agent Status</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Object.entries(AGENT_DISPLAY).map(([key, label]) => {
            const run = latestRuns[key]
            return (
              <div key={key} className="bg-[#1f2937] border border-[#374151] rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    !run ? 'bg-gray-600'
                    : run.status === 'completed' ? 'bg-green-500'
                    : run.status === 'failed' ? 'bg-red-500'
                    : 'bg-yellow-500'
                  }`} />
                  <span className="text-sm font-medium text-white truncate">{label}</span>
                </div>
                {run ? (
                  <>
                    <div className="text-xs text-gray-400 mb-1">Last run: {formatDate(run.started_at)}</div>
                    <div className="text-xs text-gray-500">
                      {run.signals_found != null ? `${run.signals_found} signals found` : '—'}
                    </div>
                    <div className={`text-xs mt-1 font-medium ${
                      run.status === 'completed' ? 'text-green-400'
                      : run.status === 'failed' ? 'text-red-400'
                      : 'text-yellow-400'
                    }`}>
                      {run.status}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-gray-600 italic">No runs recorded</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Competitor Jobs Page ─────────────────────────────────────────────────────

function CompetitorJobsPage({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim }) {
  const [copiedId, setCopiedId] = useState(null)

  function copyMatchPrompt(e, signal) {
    e.stopPropagation()
    const d = parseDetail(signal.signal_detail)
    let desc = d.job_description || ''
    const firmName = d.competitor_firm || ''
    if (firmName) {
      desc = desc.replace(new RegExp(firmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/\s+/g, ' ').trim()
    }
    const prompt = `This is a job description from a staffing firm. Infer who you believe is the specific end-client company hiring for this role. Ignore the staffing firm name. ${desc}`
    navigator.clipboard.writeText(prompt).then(() => {
      setCopiedId(signal.id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }

  if (signals.length === 0) return <EmptyState message="No competitor job postings found. Run agents to search for open roles." />

  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th>Role Title</Th>
          <Th>Competitor</Th>
          <Th>Location</Th>
          <Th>Likely Client</Th>
          <Th>Date Posted</Th>
          <Th>View</Th>
          <Th>Prompt</Th>
          <Th>Claim</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {signals.map((signal, i) => {
          const isExpanded = expandedRows.has(signal.id)
          const d = parseDetail(signal.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          return (
            <>
              <tr
                key={signal.id}
                onClick={() => onToggleRow(signal.id)}
                className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
              >
                <td className="px-4 py-3 text-sm text-white font-medium">{d.job_title || '—'}</td>
                <td className="px-4 py-3 text-sm font-semibold text-gray-100 whitespace-nowrap">
                  {d.competitor_firm || signal.companies?.name || '—'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">{d.job_location || '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {d.inferred_client
                    ? <span className="text-sm text-gray-200">{d.inferred_client}</span>
                    : <span className="text-xs text-gray-600">—</span>}
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
                      View ↗
                    </a>
                  ) : <span className="text-xs text-gray-600">—</span>}
                </td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  {d.job_description ? (
                    <button
                      onClick={e => copyMatchPrompt(e, signal)}
                      className="px-2 py-1 rounded text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-colors whitespace-nowrap"
                    >
                      {copiedId === signal.id ? 'Copied!' : 'Match Prompt'}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                </td>
              </tr>
              {isExpanded && (
                <tr key={`${signal.id}-exp`}>
                  <td colSpan={8} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
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

// ─── Stale Roles Page ─────────────────────────────────────────────────────────

function StaleRolesPage({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim }) {
  if (signals.length === 0) return <EmptyState message="No stale roles found yet — run agents to search target company career pages." />

  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th>Role Title</Th>
          <Th>Company</Th>
          <Th>Hiring Manager</Th>
          <Th>Location</Th>
          <Th>Days Open</Th>
          <Th>Client Score</Th>
          <Th>View</Th>
          <Th>Claim</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {signals.map((signal, i) => {
          const isExpanded = expandedRows.has(signal.id)
          const d = parseDetail(signal.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
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
                className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
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
                <td className="px-4 py-3 whitespace-nowrap">
                  {d.past_client
                    ? <span className="inline-block px-2 py-0.5 rounded text-xs font-bold bg-[#78350f] text-[#fbbf24]">+{d.past_client.boost_score}</span>
                    : <span className="text-xs text-gray-600">—</span>}
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
                  <td colSpan={8} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
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

// ─── Placeholder Pages ────────────────────────────────────────────────────────

function PlaceholderTable({ columns, emptyMessage }) {
  return (
    <div className="bg-[#1f2937] border border-[#374151] rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#374151]">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center">
                <p className="text-gray-500 text-sm italic">{emptyMessage}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PastBuyersPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-gray-400 text-sm">Track contacts at companies that have previously purchased staffing services.</p>
      <PlaceholderTable
        columns={['Full Name', 'Role', 'Company', 'Location', 'LinkedIn Profile']}
        emptyMessage="No past buyers added yet. Data will be populated soon."
      />
    </div>
  )
}

function PastCandidatesPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-gray-400 text-sm">Track candidates you have previously placed or engaged with.</p>
      <PlaceholderTable
        columns={['Full Name', 'Role', 'Company', 'Location', 'LinkedIn Profile']}
        emptyMessage="No past candidates added yet. Data will be populated soon."
      />
    </div>
  )
}

function SettingsPage() {
  const sections = [
    {
      title: 'Agent Configuration',
      description: 'Configure which agents run, their schedules, and target company lists.',
    },
    {
      title: 'Past Client Management',
      description: 'Add, remove, or update past client companies and their boost scores.',
    },
    {
      title: 'Notification Preferences',
      description: 'Configure Slack or email alerts for new high-priority signals.',
    },
  ]
  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      {sections.map(section => (
        <div key={section.title} className="bg-[#1f2937] border border-[#374151] rounded-xl p-6">
          <h3 className="text-base font-semibold text-white mb-1">{section.title}</h3>
          <p className="text-sm text-gray-400 mb-4">{section.description}</p>
          <span className="inline-block px-3 py-1 rounded-full bg-white/5 text-gray-500 text-xs font-medium">
            Coming soon
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [activePage, setActivePage]       = useState('dashboard')
  const [signals, setSignals]             = useState([])
  const [loading, setLoading]             = useState(true)
  const [agentRuns, setAgentRuns]         = useState([])
  const [repName, setRepName]             = useState('')
  const [showRepInput, setShowRepInput]   = useState(false)
  const [repInputValue, setRepInputValue] = useState('')
  const [expandedRows, setExpandedRows]   = useState(new Set())
  const [notes, setNotes]                 = useState({})
  const [savingNotes, setSavingNotes]     = useState(new Set())
  const [leadsGroupOpen, setLeadsGroupOpen] = useState({ clinical: true, funding: true, jobs: true })
  const [agentRunning, setAgentRunning]     = useState(false)
  const [toast, setToast]                   = useState(null)
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

  const fetchAgentRuns = useCallback(async () => {
    if (!supabase) return
    try {
      const { data } = await supabase
        .from('agent_runs')
        .select('agent_name, started_at, completed_at, status, signals_found')
        .order('started_at', { ascending: false })
        .limit(40)
      if (data) setAgentRuns(data)
    } catch (err) {
      console.error('Error fetching agent runs:', err)
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('biosignal_rep_name')
    if (stored) setRepName(stored)
    fetchSignals()
    fetchAgentRuns()
  }, [fetchSignals, fetchAgentRuns])

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

  const clinicalSignals = signals.filter(s => {
    if (SIGNAL_TYPE_CONFIG[s.signal_type]?.tab !== 'clinical') return false
    if (!activeStatuses.includes(s.status)) return false
    const d = parseDetail(s.signal_detail)
    if (d.phase_from === 'Pre-Clinical') return false
    if (d.phase_to && ['?', 'NA', 'N/A'].includes(String(d.phase_to).trim())) return false
    return true
  })
  const fundingSignals    = signals.filter(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.tab === 'funding' && activeStatuses.includes(s.status))
  const competitorSignals = signals.filter(s => s.signal_type === 'competitor_job_posting' && activeStatuses.includes(s.status))
  const staleSignals      = signals.filter(s => ['stale_job_posting', 'target_company_job'].includes(s.signal_type) && activeStatuses.includes(s.status))
  const leadsSignals      = repName ? signals.filter(s => s.claimed_by === repName) : []

  const tabCounts = {
    clinical:   clinicalSignals.length,
    funding:    fundingSignals.length,
    competitor: competitorSignals.length,
    stale:      staleSignals.length,
    leads:      leadsSignals.length,
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
        fetchAgentRuns()
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

  return (
    <div className="flex min-h-screen bg-[#111827]">
      <Sidebar activePage={activePage} setActivePage={setActivePage} tabCounts={tabCounts} />

      <div className="flex-1 lg:ml-[220px] ml-16 min-w-0 flex flex-col">
        <TopBar
          activePage={activePage}
          loading={loading}
          agentRunning={agentRunning}
          repName={repName}
          showRepInput={showRepInput}
          repInputValue={repInputValue}
          repInputRef={repInputRef}
          onRefresh={fetchSignals}
          onRunAgents={runAgents}
          onEditRep={() => { setRepInputValue(repName); setShowRepInput(true) }}
          onStartRep={() => { setRepInputValue(''); setShowRepInput(true) }}
          onRepChange={e => setRepInputValue(e.target.value)}
          onSaveRep={saveRepName}
          onCancelRep={() => setShowRepInput(false)}
        />

        <main className="flex-1 p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-gray-400 text-sm">Loading signals...</span>
            </div>
          ) : (
            <>
              {activePage === 'dashboard'  && (
                <DashboardPage signals={signals} agentRuns={agentRuns} />
              )}
              {activePage === 'clinical'   && (
                <ClinicalTab
                  signals={clinicalSignals}
                  repName={repName}
                  expandedRows={expandedRows}
                  onToggleRow={toggleRow}
                  onClaim={claimSignal}
                  onUnclaim={unclaimSignal}
                />
              )}
              {activePage === 'funding'    && (
                <FundingTab
                  signals={fundingSignals}
                  repName={repName}
                  expandedRows={expandedRows}
                  onToggleRow={toggleRow}
                  onClaim={claimSignal}
                  onUnclaim={unclaimSignal}
                />
              )}
              {activePage === 'competitor' && (
                <CompetitorJobsPage
                  signals={competitorSignals}
                  repName={repName}
                  expandedRows={expandedRows}
                  onToggleRow={toggleRow}
                  onClaim={claimSignal}
                  onUnclaim={unclaimSignal}
                />
              )}
              {activePage === 'stale'      && (
                <StaleRolesPage
                  signals={staleSignals}
                  repName={repName}
                  expandedRows={expandedRows}
                  onToggleRow={toggleRow}
                  onClaim={claimSignal}
                  onUnclaim={unclaimSignal}
                />
              )}
              {activePage === 'leads'      && (
                <LeadsTab
                  signals={leadsSignals}
                  repName={repName}
                  notes={notes}
                  savingNotes={savingNotes}
                  onSaveNotes={saveNotes}
                  onUpdateStatus={updateStatus}
                  groupOpen={leadsGroupOpen}
                  setGroupOpen={setLeadsGroupOpen}
                />
              )}
              {activePage === 'buyers'     && <PastBuyersPage />}
              {activePage === 'candidates' && <PastCandidatesPage />}
              {activePage === 'settings'   && <SettingsPage />}
            </>
          )}
        </main>
      </div>

      {/* Toast notification */}
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
    </div>
  )
}
