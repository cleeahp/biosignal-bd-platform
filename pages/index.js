import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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

// ─── Dismissal reason options per tab ────────────────────────────────────────

const DISMISS_REASONS = {
  clinical:   [{ key: 'company', label: 'Company' }],
  funding:    [{ key: 'company', label: 'Company' }],
  competitor: [{ key: 'role_title', label: 'Role Title' }, { key: 'location', label: 'Location' }],
  stale:      [{ key: 'role_title', label: 'Role Title' }, { key: 'company', label: 'Company' }, { key: 'location', label: 'Location' }],
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

function hasPastClient(signal) {
  const d = parseDetail(signal.signal_detail)
  return !!d.past_client
}

function sortSignals(signals) {
  return [...signals].sort((a, b) => {
    const aPast = hasPastClient(a) ? 1 : 0
    const bPast = hasPastClient(b) ? 1 : 0
    if (bPast !== aPast) return bPast - aPast
    return (b.priority_score || 0) - (a.priority_score || 0)
  })
}

// ─── Column Filter Hook ──────────────────────────────────────────────────────

function useColumnFilters() {
  const [filters, setFilters] = useState({})

  const setFilter = useCallback((colKey, selectedValues) => {
    setFilters(prev => {
      const next = { ...prev }
      if (!selectedValues || selectedValues.length === 0) {
        delete next[colKey]
      } else {
        next[colKey] = selectedValues
      }
      return next
    })
  }, [])

  const clearAll = useCallback(() => setFilters({}), [])

  const hasActiveFilters = Object.keys(filters).length > 0

  const applyFilters = useCallback((rows, extractors) => {
    if (!hasActiveFilters) return rows
    return rows.filter(row => {
      for (const [colKey, allowedValues] of Object.entries(filters)) {
        const extractor = extractors[colKey]
        if (!extractor) continue
        const cellValue = String(extractor(row) || '').toLowerCase()
        const match = allowedValues.some(v => cellValue === v.toLowerCase())
        if (!match) return false
      }
      return true
    })
  }, [filters, hasActiveFilters])

  return { filters, setFilter, clearAll, hasActiveFilters, applyFilters }
}

// ─── Column Filter Dropdown Component ────────────────────────────────────────

function ColumnFilterDropdown({ colKey, label, allValues, activeValues, onApply, className = '' }) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set(activeValues || []))
  const btnRef = useRef(null)
  const dropdownRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const hasFilter = activeValues && activeValues.length > 0

  useEffect(() => {
    setSelected(new Set(activeValues || []))
  }, [activeValues])

  const openDropdown = (e) => {
    e.stopPropagation()
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 4, left: Math.max(4, Math.min(rect.left, window.innerWidth - 240)) })
    }
    setSearch('')
    setIsOpen(true)
  }

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) && !btnRef.current.contains(e.target)) {
        onApply(colKey, [...selected])
        setIsOpen(false)
      }
    }
    const handleKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        onApply(colKey, [...selected])
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isOpen, selected, colKey, onApply])

  const uniqueVals = useMemo(() => {
    const vals = [...new Set(allValues.map(v => String(v || '')))]
      .filter(v => v && v !== '—' && v !== 'undefined')
      .sort((a, b) => a.localeCompare(b))
    if (!search) return vals
    const q = search.toLowerCase()
    return vals.filter(v => v.toLowerCase().includes(q))
  }, [allValues, search])

  const toggle = (val) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(val) ? next.delete(val) : next.add(val)
      return next
    })
  }

  return (
    <>
      <th
        ref={btnRef}
        onClick={openDropdown}
        className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap cursor-pointer hover:text-gray-200 select-none ${className}`}
      >
        <span className="inline-flex items-center gap-1.5">
          {label}
          {hasFilter && <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />}
          <svg className="w-3 h-3 opacity-40" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
        </span>
      </th>
      {isOpen && (
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 50 }}
          className="w-56 bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl"
        >
          <div className="p-2 border-b border-[#374151]">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="w-full bg-[#111827] border border-[#374151] rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1.5">
            {uniqueVals.length === 0 && (
              <p className="text-xs text-gray-500 px-2 py-1">No values</p>
            )}
            {uniqueVals.map(val => (
              <label key={val} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[#374151] cursor-pointer text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={selected.has(val)}
                  onChange={() => toggle(val)}
                  className="rounded border-gray-600 bg-[#111827] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
                <span className="truncate">{val}</span>
              </label>
            ))}
          </div>
          <div className="p-2 border-t border-[#374151] flex justify-between">
            <button
              onClick={() => { setSelected(new Set()); onApply(colKey, []); setIsOpen(false) }}
              className="text-xs text-gray-400 hover:text-white"
            >
              Clear
            </button>
            <button
              onClick={() => { onApply(colKey, [...selected]); setIsOpen(false) }}
              className="text-xs text-blue-400 hover:text-blue-300 font-semibold"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function ClearAllFiltersButton({ hasActiveFilters, onClear }) {
  if (!hasActiveFilters) return null
  return (
    <div className="flex justify-end mb-2">
      <button
        onClick={onClear}
        className="text-xs text-blue-400 hover:text-blue-300 font-medium px-2 py-1 rounded bg-blue-900/30 hover:bg-blue-900/50 transition-colors"
      >
        Clear all filters
      </button>
    </div>
  )
}

// ─── Shared UI components ─────────────────────────────────────────────────────

function PastClientStar() {
  return <span className="text-[#fbbf24] mr-1" title="Past Client">★</span>
}

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

function DismissButton({ signal, onDismiss }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onDismiss(signal) }}
      title="Dismiss signal"
      className="p-1 rounded hover:bg-red-900/40 text-gray-500 hover:text-red-400 transition-colors"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3,6 5,6 21,6" />
        <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
      </svg>
    </button>
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
    <div className="rounded-lg border border-[#374151] overflow-hidden">
      <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>{children}</table>
    </div>
  )
}

function Th({ children, className = '' }) {
  return (
    <th
      className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  )
}

function TdTruncate({ children, className = '', title }) {
  return (
    <td className={`px-3 py-3 ${className}`} title={title}>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {children}
      </div>
    </td>
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

// ─── Dismiss Modal ───────────────────────────────────────────────────────────

function DismissModal({ signal, tabKey, onConfirm, onCancel }) {
  const [selectedReason, setSelectedReason] = useState(null)
  const reasons = DISMISS_REASONS[tabKey] || []
  const d = parseDetail(signal.signal_detail)

  const getValueForReason = (key) => {
    switch (key) {
      case 'company': return signal.companies?.name || d.company_name || d.sponsor || ''
      case 'role_title': return d.job_title || ''
      case 'location': return d.job_location || ''
      default: return ''
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-[#1f2937] border border-[#374151] rounded-xl p-6 max-w-md w-full shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-white font-semibold text-base mb-4">Why are you dismissing this signal?</h3>
        <div className="flex flex-col gap-2 mb-6">
          {reasons.map(r => {
            const val = getValueForReason(r.key)
            return (
              <button
                key={r.key}
                onClick={() => setSelectedReason(r.key)}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border text-sm text-left transition-colors ${
                  selectedReason === r.key
                    ? 'border-blue-500 bg-blue-900/30 text-white'
                    : 'border-[#374151] bg-[#111827] text-gray-300 hover:border-gray-500'
                }`}
              >
                <span>{r.label}</span>
                {val && <span className="text-xs text-gray-400 truncate ml-2 max-w-[180px]">{val}</span>}
              </button>
            )
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded text-sm text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => selectedReason && onConfirm(signal, selectedReason, getValueForReason(selectedReason))}
            disabled={!selectedReason}
            className="px-4 py-2 rounded text-sm font-semibold text-white bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
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

function ClinicalTab({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim, onDismiss }) {
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  const extractors = useMemo(() => ({
    type: s => SIGNAL_TYPE_CONFIG[s.signal_type]?.label || s.signal_type,
    company: s => s.companies?.name || parseDetail(s.signal_detail).sponsor || '',
    source: s => parseDetail(s.signal_detail).nct_id || '',
  }), [])

  const allValues = useMemo(() => ({
    type: signals.map(s => SIGNAL_TYPE_CONFIG[s.signal_type]?.label || s.signal_type),
    company: signals.map(s => s.companies?.name || parseDetail(s.signal_detail).sponsor || ''),
    source: signals.map(s => parseDetail(s.signal_detail).nct_id || ''),
  }), [signals])

  const sorted = useMemo(() => sortSignals(signals), [signals])
  const filtered = applyFilters(sorted, extractors)

  if (signals.length === 0) return <EmptyState message="No active clinical trial signals." />
  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <TableWrapper>
        <thead>
          <tr>
            <ColumnFilterDropdown colKey="type" label="Type" allValues={allValues.type} activeValues={filters.type} onApply={setFilter} className="w-[10%]" />
            <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[18%]" />
            <Th className="w-[16%]">Detail</Th>
            <Th className="w-[22%]">Summary</Th>
            <ColumnFilterDropdown colKey="source" label="Source" allValues={allValues.source} activeValues={filters.source} onApply={setFilter} className="w-[9%]" />
            <Th className="w-[9%]">Date</Th>
            <Th className="w-[6%]">Queue</Th>
            <Th className="w-[7%]">Claim</Th>
            <Th className="w-[3%]"></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#374151]">
          {filtered.map((signal, i) => {
            const isExpanded = expandedRows.has(signal.id)
            const d = parseDetail(signal.signal_detail)
            const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
            const isPast = !!d.past_client
            const companyName = signal.companies?.name || d.sponsor || '—'
            return (
              <>
                <tr
                  key={signal.id}
                  onClick={() => onToggleRow(signal.id)}
                  className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                >
                  <TdTruncate>
                    <SignalTypeBadge signalType={signal.signal_type} />
                  </TdTruncate>
                  <TdTruncate title={companyName}>
                    <div className="text-sm font-semibold text-white">
                      {isPast && <PastClientStar />}
                      {companyName}
                    </div>
                    {signal.companies?.industry && (
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{signal.companies.industry}</div>
                    )}
                  </TdTruncate>
                  <td className="px-3 py-3">
                    <ClinicalDetailCell signal={signal} />
                  </td>
                  <TdTruncate title={d.study_summary || signal.signal_summary || ''}>
                    <span className="text-xs text-gray-400 leading-snug">
                      {d.study_summary || signal.signal_summary || '—'}
                    </span>
                  </TdTruncate>
                  <td className="px-3 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
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
                  <TdTruncate className="text-sm text-gray-400">
                    {formatDate(d.date_updated || signal.updated_at)}
                  </TdTruncate>
                  <td className="px-3 py-3">
                    <DaysInQueueBadge dateStr={signal.first_detected_at} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <DismissButton signal={signal} onDismiss={onDismiss} />
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
    </div>
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

function FundingTab({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim, onDismiss }) {
  const [selectedType, setSelectedType] = useState('all')
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  const typeCounts = { all: signals.length }
  for (const s of signals) {
    const k = getFundingFilterKey(s)
    typeCounts[k] = (typeCounts[k] || 0) + 1
  }

  const visiblePills = FUNDING_FILTER_PILLS.filter(p => p.key === 'all' || (typeCounts[p.key] || 0) > 0)

  const pillFiltered = selectedType === 'all'
    ? signals
    : signals.filter(s => getFundingFilterKey(s) === selectedType)

  const extractors = useMemo(() => ({
    type: s => {
      const d = parseDetail(s.signal_detail)
      if (s.signal_type === 'ma_transaction') return MA_TRANSACTION_TYPE_CONFIG[d.transaction_type]?.label || 'M&A'
      return SIGNAL_TYPE_CONFIG[s.signal_type]?.label || s.signal_type
    },
    company: s => {
      const d = parseDetail(s.signal_detail)
      return s.companies?.name || d.company_name || d.acquirer_name || ''
    },
  }), [])

  const allValues = useMemo(() => ({
    type: pillFiltered.map(s => extractors.type(s)),
    company: pillFiltered.map(s => extractors.company(s)),
  }), [pillFiltered, extractors])

  const sorted = useMemo(() => sortSignals(pillFiltered), [pillFiltered])
  const filtered = applyFilters(sorted, extractors)

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

      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <TableWrapper>
        <thead>
          <tr>
            <ColumnFilterDropdown colKey="type" label="Type" allValues={allValues.type} activeValues={filters.type} onApply={setFilter} className="w-[10%]" />
            <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
            <Th className="w-[10%]">Amount</Th>
            <Th className="w-[28%]">Summary</Th>
            <Th className="w-[10%]">Date</Th>
            <Th className="w-[6%]">Queue</Th>
            <Th className="w-[8%]">Claim</Th>
            <Th className="w-[3%]"></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#374151]">
          {filtered.map((signal, i) => {
            const isExpanded = expandedRows.has(signal.id)
            const d = parseDetail(signal.signal_detail)
            const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
            const isPast = !!d.past_client

            const companyDisplay = signal.signal_type === 'ma_transaction' ? (() => {
              const tt = d.transaction_type
              const acquirer = d.acquirer_name || signal.companies?.name || '—'
              const acquired = d.acquired_name
              const companyName = signal.companies?.name || d.company_name || acquirer
              if (tt === 'ipo') return companyName
              if (tt === 'merger') return acquired ? `${acquirer} → ${acquired}` : acquirer
              if (tt === 'product_acquisition') return acquired ? `${companyName} → ${acquired}` : companyName
              if (tt === 'partnership') return acquired ? `${companyName} ↔ ${acquired}` : companyName
              return acquired ? `${acquirer} → ${acquired}` : acquirer
            })() : signal.companies?.name || d.company_name || '—'

            return (
              <>
                <tr
                  key={signal.id}
                  onClick={() => onToggleRow(signal.id)}
                  className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                >
                  <TdTruncate>
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
                  </TdTruncate>
                  <TdTruncate title={companyDisplay}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-white truncate">
                        {isPast && <PastClientStar />}
                        {companyDisplay}
                      </span>
                    </div>
                    {signal.companies?.industry && (
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{signal.companies.industry}</div>
                    )}
                    {signal.signal_type === 'ma_transaction' && d.acquired_asset && (
                      <div className="text-xs text-gray-400 mt-0.5 truncate">
                        Asset: <span className="font-mono text-blue-300">{d.acquired_asset}</span>
                      </div>
                    )}
                  </TdTruncate>
                  <TdTruncate className="text-sm font-mono text-green-400">
                    {signal.signal_type === 'ma_transaction' ? 'N/A' : (d.funding_amount || 'Undisclosed')}
                  </TdTruncate>
                  <TdTruncate title={d.deal_summary || d.funding_summary || signal.signal_summary || ''}>
                    <span className="text-sm text-gray-200">
                      {truncate(d.deal_summary || d.funding_summary || signal.signal_summary, 100)}
                    </span>
                  </TdTruncate>
                  <TdTruncate className="text-sm text-gray-400">
                    {formatDate(d.date_announced || signal.first_detected_at)}
                  </TdTruncate>
                  <td className="px-3 py-3">
                    <DaysInQueueBadge dateStr={signal.first_detected_at} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <DismissButton signal={signal} onDismiss={onDismiss} />
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
        <div className="overflow-hidden">
          <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <Th className="w-[12%]">Type</Th>
                <Th className="w-[18%]">Company</Th>
                <Th className="w-[28%]">Summary</Th>
                <Th className="w-[12%]">Date Claimed</Th>
                <Th className="w-[10%]">Status</Th>
                <Th className="w-[20%]">Notes</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#374151]">
              {signals.map((signal, i) => {
                const d = parseDetail(signal.signal_detail)
                const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                return (
                  <tr key={signal.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
                    <TdTruncate>
                      <SignalTypeBadge signalType={signal.signal_type} fundingType={d.funding_type} />
                    </TdTruncate>
                    <TdTruncate className="text-sm font-semibold text-white" title={signal.companies?.name || d.company_name || d.sponsor || ''}>
                      {signal.companies?.name || d.company_name || d.sponsor || '—'}
                    </TdTruncate>
                    <TdTruncate title={d.funding_summary || d.study_summary || signal.signal_summary || ''}>
                      <span className="text-sm text-gray-300 leading-snug">
                        {truncate(d.funding_summary || d.study_summary || signal.signal_summary, 90)}
                      </span>
                    </TdTruncate>
                    <TdTruncate className="text-sm text-gray-400">
                      {formatDate(signal.updated_at)}
                    </TdTruncate>
                    <td className="px-3 py-3">
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
                    <td className="px-3 py-3">
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
  { key: 'leads',      label: 'My Leads',          icon: 'clipboard', countKey: 'leads' },
  { key: 'clinical',   label: 'Clinical Trials',   icon: 'beaker',    countKey: 'clinical' },
  { key: 'funding',    label: 'Funding & M&A',     icon: 'trending',  countKey: 'funding' },
  { key: 'competitor', label: 'Competitor Jobs',   icon: 'briefcase', countKey: 'competitor' },
  { key: 'stale',      label: 'Stale Roles',       icon: 'clock',     countKey: 'stale' },
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

function CompetitorJobsPage({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim, onDismiss }) {
  const [copiedId, setCopiedId] = useState(null)
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

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

  const extractors = useMemo(() => ({
    role: s => parseDetail(s.signal_detail).job_title || '',
    competitor: s => parseDetail(s.signal_detail).competitor_firm || s.companies?.name || '',
    location: s => parseDetail(s.signal_detail).job_location || '',
    client: s => parseDetail(s.signal_detail).inferred_client || '',
  }), [])

  const allValues = useMemo(() => ({
    role: signals.map(s => parseDetail(s.signal_detail).job_title || ''),
    competitor: signals.map(s => parseDetail(s.signal_detail).competitor_firm || s.companies?.name || ''),
    location: signals.map(s => parseDetail(s.signal_detail).job_location || ''),
    client: signals.map(s => parseDetail(s.signal_detail).inferred_client || ''),
  }), [signals])

  const filtered = applyFilters(signals, extractors)

  if (signals.length === 0) return <EmptyState message="No competitor job postings found. Run agents to search for open roles." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <TableWrapper>
        <thead>
          <tr>
            <ColumnFilterDropdown colKey="role" label="Role Title" allValues={allValues.role} activeValues={filters.role} onApply={setFilter} className="w-[22%]" />
            <ColumnFilterDropdown colKey="competitor" label="Competitor" allValues={allValues.competitor} activeValues={filters.competitor} onApply={setFilter} className="w-[14%]" />
            <ColumnFilterDropdown colKey="location" label="Location" allValues={allValues.location} activeValues={filters.location} onApply={setFilter} className="w-[14%]" />
            <ColumnFilterDropdown colKey="client" label="Likely Client" allValues={allValues.client} activeValues={filters.client} onApply={setFilter} className="w-[14%]" />
            <Th className="w-[10%]">Date Posted</Th>
            <Th className="w-[6%]">View</Th>
            <Th className="w-[8%]">Prompt</Th>
            <Th className="w-[7%]">Claim</Th>
            <Th className="w-[3%]"></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#374151]">
          {filtered.map((signal, i) => {
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
                  <TdTruncate className="text-sm text-white font-medium" title={d.job_title || ''}>{d.job_title || '—'}</TdTruncate>
                  <TdTruncate className="text-sm font-semibold text-gray-100" title={d.competitor_firm || signal.companies?.name || ''}>
                    {d.competitor_firm || signal.companies?.name || '—'}
                  </TdTruncate>
                  <TdTruncate className="text-sm text-gray-400" title={d.job_location || ''}>{d.job_location || '—'}</TdTruncate>
                  <TdTruncate title={d.inferred_client || ''}>
                    {d.inferred_client
                      ? <span className="text-sm text-gray-200">{d.inferred_client}</span>
                      : <span className="text-xs text-gray-600">—</span>}
                  </TdTruncate>
                  <TdTruncate className="text-sm text-gray-400">
                    {formatDate(d.posting_date || signal.first_detected_at)}
                  </TdTruncate>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
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
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
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
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <DismissButton signal={signal} onDismiss={onDismiss} />
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
    </div>
  )
}

// ─── Stale Roles Page ─────────────────────────────────────────────────────────

function StaleRolesPage({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim, onDismiss }) {
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  const extractors = useMemo(() => ({
    role: s => parseDetail(s.signal_detail).job_title || '',
    company: s => s.companies?.name || parseDetail(s.signal_detail).company_name || '',
    location: s => parseDetail(s.signal_detail).job_location || '',
    manager: s => parseDetail(s.signal_detail).hiring_manager || '',
  }), [])

  const allValues = useMemo(() => ({
    role: signals.map(s => parseDetail(s.signal_detail).job_title || ''),
    company: signals.map(s => s.companies?.name || parseDetail(s.signal_detail).company_name || ''),
    location: signals.map(s => parseDetail(s.signal_detail).job_location || ''),
    manager: signals.map(s => parseDetail(s.signal_detail).hiring_manager || ''),
  }), [signals])

  const sorted = useMemo(() => sortSignals(signals), [signals])
  const filtered = applyFilters(sorted, extractors)

  if (signals.length === 0) return <EmptyState message="No stale roles found yet — run agents to search target company career pages." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <TableWrapper>
        <thead>
          <tr>
            <ColumnFilterDropdown colKey="role" label="Role Title" allValues={allValues.role} activeValues={filters.role} onApply={setFilter} className="w-[22%]" />
            <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[16%]" />
            <ColumnFilterDropdown colKey="manager" label="Hiring Manager" allValues={allValues.manager} activeValues={filters.manager} onApply={setFilter} className="w-[14%]" />
            <ColumnFilterDropdown colKey="location" label="Location" allValues={allValues.location} activeValues={filters.location} onApply={setFilter} className="w-[14%]" />
            <Th className="w-[8%]">Days Open</Th>
            <Th className="w-[6%]">View</Th>
            <Th className="w-[8%]">Claim</Th>
            <Th className="w-[3%]"></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#374151]">
          {filtered.map((signal, i) => {
            const isExpanded = expandedRows.has(signal.id)
            const d = parseDetail(signal.signal_detail)
            const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
            const daysOpen = d.days_posted || signal.days_in_queue || 0
            const dayCls = daysOpen >= 45
              ? 'bg-red-900 text-red-300'
              : daysOpen >= 30
                ? 'bg-orange-900 text-orange-300'
                : 'bg-gray-700 text-gray-300'
            const isPast = !!d.past_client
            const companyName = signal.companies?.name || d.company_name || '—'
            return (
              <>
                <tr
                  key={signal.id}
                  onClick={() => onToggleRow(signal.id)}
                  className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                >
                  <TdTruncate className="text-sm text-white font-medium" title={d.job_title || ''}>
                    {isPast && <PastClientStar />}
                    {d.job_title || '—'}
                  </TdTruncate>
                  <TdTruncate className="text-sm font-semibold text-gray-100" title={companyName}>
                    {companyName}
                  </TdTruncate>
                  <TdTruncate title={d.hiring_manager || ''}>
                    {d.hiring_manager && d.hiring_manager !== 'Unknown'
                      ? <span className="text-sm text-gray-100">{d.hiring_manager}</span>
                      : <span className="text-xs text-gray-600 italic">Unknown</span>
                    }
                  </TdTruncate>
                  <TdTruncate className="text-sm text-gray-400" title={d.job_location || ''}>{d.job_location || '—'}</TdTruncate>
                  <td className="px-3 py-3">
                    {daysOpen > 0 ? (
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${dayCls}`}>
                        {daysOpen}d
                      </span>
                    ) : <span className="text-xs text-gray-600">—</span>}
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
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
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <ClaimCell signal={signal} repName={repName} onClaim={onClaim} onUnclaim={onUnclaim} />
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <DismissButton signal={signal} onDismiss={onDismiss} />
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

// ─── Placeholder Pages ────────────────────────────────────────────────────────

function PlaceholderTable({ columns, emptyMessage }) {
  return (
    <div className="bg-[#1f2937] border border-[#374151] rounded-xl overflow-hidden">
      <div className="overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={columns.length} className="px-3 py-12 text-center">
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
  const [rules, setRules] = useState([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [excludedCompanies, setExcludedCompanies] = useState([])
  const [excludedLoading, setExcludedLoading] = useState(true)
  const [editingThreshold, setEditingThreshold] = useState(null)
  const [thresholdValue, setThresholdValue] = useState('')

  useEffect(() => {
    if (!supabase) return
    const loadRules = async () => {
      const { data } = await supabase
        .from('dismissal_rules')
        .select('*')
        .order('auto_exclude', { ascending: false })
        .order('dismiss_count', { ascending: false })
      setRules(data || [])
      setRulesLoading(false)
    }
    const loadExcluded = async () => {
      const { data } = await supabase
        .from('excluded_companies')
        .select('*')
        .order('name')
      setExcludedCompanies(data || [])
      setExcludedLoading(false)
    }
    loadRules()
    loadExcluded()
  }, [])

  const toggleAutoExclude = async (rule) => {
    if (!supabase) return
    const newValue = !rule.auto_exclude
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, auto_exclude: newValue } : r))
    await supabase.from('dismissal_rules').update({ auto_exclude: newValue }).eq('id', rule.id)
  }

  const deleteRule = async (rule) => {
    if (!supabase) return
    setRules(prev => prev.filter(r => r.id !== rule.id))
    await supabase.from('dismissal_rules').delete().eq('id', rule.id)
  }

  const startEditThreshold = (rule) => {
    setEditingThreshold(rule.id)
    setThresholdValue(String(rule.threshold || 3))
  }

  const saveThreshold = async (rule) => {
    if (!supabase) return
    const val = parseInt(thresholdValue, 10)
    if (isNaN(val) || val < 1) return
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, threshold: val, auto_exclude: r.dismiss_count >= val } : r))
    await supabase.from('dismissal_rules').update({ threshold: val, auto_exclude: rule.dismiss_count >= val }).eq('id', rule.id)
    setEditingThreshold(null)
  }

  const deleteExcludedCompany = async (company) => {
    if (!supabase) return
    setExcludedCompanies(prev => prev.filter(c => c.id !== company.id))
    await supabase.from('excluded_companies').delete().eq('id', company.id)
  }

  const sortedRules = [...rules].sort((a, b) => {
    if (a.auto_exclude !== b.auto_exclude) return a.auto_exclude ? -1 : 1
    return (b.dismiss_count || 0) - (a.dismiss_count || 0)
  })

  const placeholders = [
    { title: 'Agent Configuration', description: 'Configure which agents run, their schedules, and target company lists.' },
    { title: 'Notification Preferences', description: 'Configure Slack or email alerts for new high-priority signals.' },
  ]

  return (
    <div className="flex flex-col gap-8">
      {/* ── Dismissal Rules ──────────────────────────────────────────────── */}
      <div>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-white">
            Dismissal Rules ({rules.length})
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Rules are created automatically when you dismiss a listing. Once a rule reaches its threshold, future search results matching that field/value will be skipped.
          </p>
        </div>
        {rulesLoading ? (
          <div className="text-sm text-gray-500 py-8 text-center">Loading rules...</div>
        ) : rules.length === 0 ? (
          <div className="text-sm text-gray-500 py-8 text-center bg-[#1f2937] border border-[#374151] rounded-xl">
            No dismissal rules yet. Dismiss signals from the tables to create rules.
          </div>
        ) : (
          <div className="rounded-xl border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[14%]">Field</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[28%]">Value</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[20%]">Signal Type</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[8%]">Count</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[10%]">Threshold</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[10%]">Active</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[6%]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {sortedRules.map((rule, i) => {
                  const rowBg = rule.auto_exclude
                    ? (i % 2 === 0 ? 'bg-blue-950/30' : 'bg-blue-950/20')
                    : (i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]')
                  const fieldLabel = (rule.rule_type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  const signalLabel = (rule.signal_type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  return (
                    <tr key={rule.id} className={`${rowBg} transition-colors`}>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-gray-700 text-gray-300">
                          {fieldLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-white truncate" title={rule.rule_value}>
                        {rule.rule_value}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400 truncate" title={signalLabel}>
                        {signalLabel}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-sm font-mono text-white">{rule.dismiss_count || 0}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {editingThreshold === rule.id ? (
                          <input
                            type="number"
                            min="1"
                            value={thresholdValue}
                            onChange={e => setThresholdValue(e.target.value)}
                            onBlur={() => saveThreshold(rule)}
                            onKeyDown={e => { if (e.key === 'Enter') saveThreshold(rule); if (e.key === 'Escape') setEditingThreshold(null) }}
                            autoFocus
                            className="w-12 bg-[#111827] border border-blue-500 rounded px-1.5 py-0.5 text-sm text-white text-center focus:outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => startEditThreshold(rule)}
                            className="text-sm font-mono text-gray-300 hover:text-white cursor-pointer"
                            title="Click to edit threshold"
                          >
                            {rule.threshold || 3}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => toggleAutoExclude(rule)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            rule.auto_exclude ? 'bg-blue-600' : 'bg-gray-600'
                          }`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                            rule.auto_exclude ? 'translate-x-4.5' : 'translate-x-0.5'
                          }`} style={{ transform: rule.auto_exclude ? 'translateX(18px)' : 'translateX(2px)' }} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => deleteRule(rule)}
                          title="Delete rule"
                          className="p-1 rounded hover:bg-red-900/40 text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3,6 5,6 21,6" />
                            <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Excluded Companies ────────────────────────────────────────────── */}
      <div>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-white">
            Excluded Companies — Large Employers ({excludedCompanies.length})
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Companies with 10,001+ LinkedIn members are automatically excluded from signal generation.
          </p>
        </div>
        {excludedLoading ? (
          <div className="text-sm text-gray-500 py-8 text-center">Loading excluded companies...</div>
        ) : excludedCompanies.length === 0 ? (
          <div className="text-sm text-gray-500 py-8 text-center bg-[#1f2937] border border-[#374151] rounded-xl">
            No excluded companies.
          </div>
        ) : (
          <div className="rounded-xl border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[40%]">Company</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[20%]">LinkedIn Members</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[25%]">Last Checked</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] w-[10%]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {excludedCompanies.map((company, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const members = company.linkedin_member_count
                    ? Number(company.linkedin_member_count).toLocaleString()
                    : '—'
                  return (
                    <tr key={company.id} className={`${rowBg} transition-colors`}>
                      <td className="px-4 py-3 text-sm text-white truncate" title={company.name}>{company.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-300 font-mono">{members}</td>
                      <td className="px-4 py-3 text-sm text-gray-400">{formatDate(company.last_checked_at)}</td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => deleteExcludedCompany(company)}
                          title="Remove from excluded list"
                          className="p-1 rounded hover:bg-red-900/40 text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3,6 5,6 21,6" />
                            <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Coming soon placeholders ─────────────────────────────────────── */}
      {placeholders.map(section => (
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
  const [dismissTarget, setDismissTarget]   = useState(null) // { signal, tabKey }
  const repInputRef = useRef(null)

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals', { cache: 'no-store' })
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

  // ─── Dismiss signal flow ──────────────────────────────────────────────────

  const getTabKeyForSignal = (signal) => {
    if (SIGNAL_TYPE_CONFIG[signal.signal_type]?.tab === 'clinical') return 'clinical'
    if (SIGNAL_TYPE_CONFIG[signal.signal_type]?.tab === 'funding') return 'funding'
    if (signal.signal_type === 'competitor_job_posting') return 'competitor'
    if (['stale_job_posting', 'target_company_job'].includes(signal.signal_type)) return 'stale'
    return 'clinical'
  }

  const openDismissModal = (signal) => {
    setDismissTarget({ signal, tabKey: getTabKeyForSignal(signal) })
  }

  const confirmDismiss = async (signal, reasonKey, reasonValue) => {
    setDismissTarget(null)

    // Optimistic removal — remove from React state immediately
    console.log('[Dismiss] Removing signal from state:', signal.id)
    setSignals(prev => {
      const next = prev.filter(s => s.id !== signal.id)
      console.log('[Dismiss] Signals count:', prev.length, '→', next.length)
      return next
    })

    try {
      // 1. Update signal status to dismissed + store reason in signal_detail
      const res = await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: signal.id,
          status: 'dismissed',
          dismissal_reason: reasonKey,
          dismissal_value: reasonValue,
        }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        console.error('[Dismiss] PATCH failed:', res.status, errBody.error || '')
        // Rollback — restore the signal to local state
        setSignals(prev => [...prev, signal])
        return
      }

      console.log('[Dismiss] PATCH succeeded for signal:', signal.id)

      // 2. Upsert dismissal_rules (via Supabase client)
      if (supabase && reasonValue) {
        const signalType = signal.signal_type
        const { data: existing } = await supabase
          .from('dismissal_rules')
          .select('id, dismiss_count')
          .eq('rule_type', reasonKey)
          .eq('rule_value', reasonValue)
          .eq('signal_type', signalType)
          .maybeSingle()

        if (existing) {
          const newCount = (existing.dismiss_count || 0) + 1
          await supabase
            .from('dismissal_rules')
            .update({
              dismiss_count: newCount,
              auto_exclude: newCount >= 3,
            })
            .eq('id', existing.id)
        } else {
          await supabase
            .from('dismissal_rules')
            .insert({
              rule_type: reasonKey,
              rule_value: reasonValue,
              signal_type: signalType,
              dismiss_count: 1,
              auto_exclude: false,
            })
        }
      }
    } catch (err) {
      console.error('[Dismiss] Error:', err)
      // Rollback — restore the signal to local state
      setSignals(prev => [...prev, signal])
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
                  onDismiss={openDismissModal}
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
                  onDismiss={openDismissModal}
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
                  onDismiss={openDismissModal}
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
                  onDismiss={openDismissModal}
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

      {/* Dismiss modal */}
      {dismissTarget && (
        <DismissModal
          signal={dismissTarget.signal}
          tabKey={dismissTarget.tabKey}
          onConfirm={confirmDismiss}
          onCancel={() => setDismissTarget(null)}
        />
      )}

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
