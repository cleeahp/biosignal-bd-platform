import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react'
import { createPortal } from 'react-dom'
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

function formatClaimerName(name) {
  if (!name) return ''
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0]}.`
  return parts[0]
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
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000 }}
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
        </div>,
        document.body,
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
  const [hovered, setHovered] = useState(false)

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
      <span
        className="inline-flex items-center"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {hovered ? (
          <button
            onClick={(e) => { e.stopPropagation(); onUnclaim(signal) }}
            className="px-2 py-1 rounded text-xs font-semibold bg-gray-600 hover:bg-red-700 text-gray-200 hover:text-white transition-colors whitespace-nowrap"
          >
            Unclaim
          </button>
        ) : (
          <span className="px-2 py-1 rounded text-xs font-semibold bg-blue-700 text-blue-100 whitespace-nowrap">
            {formatClaimerName(repName)}
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="text-xs text-gray-400 font-medium whitespace-nowrap" title={signal.claimed_by}>
      {formatClaimerName(signal.claimed_by)}
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

// ─── Name Modal ───────────────────────────────────────────────────────────────

function NameModal({ onSave }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { if (inputRef.current) inputRef.current.focus() }, [])

  const handleSave = () => {
    const trimmed = value.trim()
    if (!trimmed) { setError(true); return }
    onSave(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75">
      <div className="bg-[#1f2937] border border-[#374151] rounded-xl p-8 max-w-sm w-full mx-4 shadow-2xl">
        <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center mb-4">
          <NavIcon type="user" className="w-5 h-5 text-blue-400" />
        </div>
        <h2 className="text-white text-lg font-bold mb-1">Enter your name</h2>
        <p className="text-gray-400 text-sm mb-5">This identifies you when claiming leads.</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => { setValue(e.target.value); setError(false) }}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          placeholder="First Last"
          className={`w-full bg-[#111827] border rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none mb-1 ${
            error ? 'border-red-500 focus:border-red-400' : 'border-[#374151] focus:border-blue-500'
          }`}
        />
        {error
          ? <p className="text-red-400 text-xs mb-4">Please enter your name to continue.</p>
          : <div className="mb-4" />
        }
        <button
          onClick={handleSave}
          className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors text-sm"
        >
          Continue
        </button>
      </div>
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

  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => {
    const arr = [...signals]
    arr.sort((a, b) => {
      const da = new Date(parseDetail(a.signal_detail).date_updated || a.updated_at || 0).getTime()
      const db = new Date(parseDetail(b.signal_detail).date_updated || b.updated_at || 0).getTime()
      return sortDir === 'desc' ? db - da : da - db
    })
    return arr
  }, [signals, sortDir])
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
            <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[9%] cursor-pointer select-none hover:text-gray-200" onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>Date {sortDir === 'desc' ? '↓' : '↑'}</th>
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

  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => {
    const arr = [...pillFiltered]
    arr.sort((a, b) => {
      const da = new Date(parseDetail(a.signal_detail).date_announced || a.first_detected_at || 0).getTime()
      const db = new Date(parseDetail(b.signal_detail).date_announced || b.first_detected_at || 0).getTime()
      return sortDir === 'desc' ? db - da : da - db
    })
    return arr
  }, [pillFiltered, sortDir])
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
            <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[10%] cursor-pointer select-none hover:text-gray-200" onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>Date {sortDir === 'desc' ? '↓' : '↑'}</th>
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

// ─── Tab: My Leads (rebuilt) ─────────────────────────────────────────────────

function LeadNoteCell({ lead, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(lead.notes || '')
  const inputRef = useRef(null)

  useEffect(() => { setValue(lead.notes || '') }, [lead.notes])
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus() }, [editing])

  const save = () => {
    setEditing(false)
    if (value !== (lead.notes || '')) onSave(lead.id, value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') { setValue(lead.notes || ''); setEditing(false) }
        }}
        onBlur={save}
        className="w-full bg-[#111827] border border-blue-500/50 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-400 min-w-32"
      />
    )
  }
  return (
    <div
      onClick={() => setEditing(true)}
      className="cursor-text min-h-[24px] truncate"
      title={value || 'Click to add notes'}
    >
      {value
        ? <span className="text-xs text-gray-300">{value}</span>
        : <span className="text-xs text-gray-600 italic">Add notes...</span>
      }
    </div>
  )
}

const LEAD_STATUS_OPTIONS = [
  { value: 'new',         label: 'New' },
  { value: 'contacted',   label: 'Contacted' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'won',         label: 'Won' },
  { value: 'lost',        label: 'Lost' },
]

// ── Leads page helpers ────────────────────────────────────────────────────────

const LEAD_TYPE_OPTIONS = [
  { key: 'all',        label: 'All Leads' },
  { key: 'clinical',   label: 'Clinical Trials' },
  { key: 'funding',    label: 'Funding & M&A' },
  { key: 'competitor', label: 'Competitor Jobs' },
  { key: 'stale',      label: 'Stale Roles' },
]

const LEAD_SIGNAL_TYPES = {
  clinical:   ['clinical_trial_phase_transition', 'clinical_trial_new_ind', 'clinical_trial_site_activation', 'clinical_trial_completion'],
  funding:    ['ma_transaction', 'ma_acquirer', 'ma_acquired', 'funding_new_award', 'funding_renewal'],
  competitor: ['competitor_job_posting'],
  stale:      ['stale_job_posting', 'target_company_job'],
}

const LEADS_SECTION_META = {
  clinical:   'Clinical Trials',
  funding:    'Funding & M&A',
  competitor: 'Competitor Jobs',
  stale:      'Stale Roles',
}

function formatAmount(val) {
  if (!val) return '—'
  const num = parseFloat(String(val).replace(/[$,]/g, ''))
  if (!isNaN(num) && num > 0) {
    if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`
    return `$${num.toLocaleString()}`
  }
  return String(val)
}

function ExternalLinkIcon({ href }) {
  if (!href) return <span className="text-xs text-gray-600">—</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      title="Open in new tab"
      className="text-blue-400 hover:text-blue-300 transition-colors inline-flex"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </a>
  )
}

function LeadStatusSelect({ lead, onUpdate }) {
  return (
    <select
      value={lead.status || 'new'}
      onChange={e => onUpdate(lead.id, e.target.value)}
      className="bg-[#111827] border border-[#374151] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer"
    >
      {LEAD_STATUS_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

function LeadClientCell({ lead, onSave }) {
  const getClient = () => parseDetail(lead.signal_detail).inferred_client || ''
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(getClient)
  const inputRef = useRef(null)

  useEffect(() => { setValue(getClient()) }, [lead.signal_detail])
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus() }, [editing])

  const save = () => {
    setEditing(false)
    if (value !== getClient()) onSave(lead.signal_id, value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') { setValue(getClient()); setEditing(false) }
        }}
        onBlur={save}
        className="w-full bg-[#111827] border border-blue-500/50 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-400"
        placeholder="Enter client..."
      />
    )
  }
  return (
    <div onClick={() => setEditing(true)} className="cursor-text min-h-[24px] truncate" title={value || 'Click to enter client'}>
      {value
        ? <span className="text-sm text-gray-200">{value}</span>
        : <span className="text-xs text-gray-500 italic">Enter client...</span>
      }
    </div>
  )
}

function LeadTypeFilterDropdown({ selectedTypes, onToggle }) {
  const [open, setOpen] = useState(false)
  const dropRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const isAll = selectedTypes.has('all')
  const activeLabels = LEAD_TYPE_OPTIONS.filter(o => o.key !== 'all' && selectedTypes.has(o.key)).map(o => o.label)
  const buttonLabel = isAll || activeLabels.length === 0 ? 'Filter by type' : activeLabels.join(', ')

  return (
    <div ref={dropRef} className="relative">
      <button
        onClick={() => setOpen(p => !p)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1f2937] border border-[#374151] text-sm text-gray-300 hover:text-white hover:border-[#4b5563] transition-colors"
      >
        <span className="max-w-[260px] truncate">{buttonLabel}</span>
        <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-52 bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl z-50 py-1">
          {LEAD_TYPE_OPTIONS.map(opt => (
            <label
              key={opt.key}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#374151] cursor-pointer"
              onClick={e => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={opt.key === 'all' ? isAll : selectedTypes.has(opt.key)}
                onChange={() => onToggle(opt.key)}
                className="rounded border-gray-600 bg-[#111827] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-sm text-gray-300">{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Per-type lead tables ───────────────────────────────────────────────────────

function CompetitorJobsLeadTable({ leads, onUpdateStatus, onUpdateNotes, onUpdateClient }) {
  const [sortDir, setSortDir] = useState('desc')
  if (leads.length === 0) return <p className="text-sm text-gray-500 italic py-4 px-1">No leads yet.</p>
  const sorted = [...leads].sort((a, b) => {
    const da = parseDetail(a.signal_detail), db = parseDetail(b.signal_detail)
    const ta = new Date(da.posting_date || a.first_detected_at || 0).getTime()
    const tb = new Date(db.posting_date || b.first_detected_at || 0).getTime()
    return sortDir === 'desc' ? tb - ta : ta - tb
  })
  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th className="w-[20%]">Role Title</Th>
          <Th className="w-[13%]">Competitor</Th>
          <Th className="w-[11%]">Location</Th>
          <Th className="w-[14%]">Likely Client</Th>
          <th
            className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[9%] cursor-pointer select-none hover:text-gray-200"
            onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
          >Date Posted {sortDir === 'desc' ? '↓' : '↑'}</th>
          <Th className="w-[4%]">Link</Th>
          <Th className="w-[10%]">Claim Date</Th>
          <Th className="w-[10%]">Status</Th>
          <Th className="w-[9%]">Notes</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {sorted.map((lead, i) => {
          const d = parseDetail(lead.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          return (
            <tr key={lead.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
              <TdTruncate className="text-sm text-white font-medium" title={d.job_title || ''}>
                {!!d.past_client && <PastClientStar />}
                {d.job_title || '—'}
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-200" title={d.competitor_firm || ''}>
                {d.competitor_firm || lead.company_name || '—'}
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-400" title={d.job_location || ''}>
                {d.job_location || '—'}
              </TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <LeadClientCell lead={lead} onSave={onUpdateClient} />
              </td>
              <TdTruncate className="text-sm text-gray-400">
                {formatDate(d.posting_date)}
              </TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <ExternalLinkIcon href={d.job_url} />
              </td>
              <TdTruncate className="text-sm text-gray-400">{formatDate(lead.claimed_at)}</TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <LeadStatusSelect lead={lead} onUpdate={onUpdateStatus} />
              </td>
              <td className="px-3 py-3">
                <LeadNoteCell lead={lead} onSave={onUpdateNotes} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableWrapper>
  )
}

function StaleRolesLeadTable({ leads, onUpdateStatus, onUpdateNotes }) {
  if (leads.length === 0) return <p className="text-sm text-gray-500 italic py-4 px-1">No leads yet.</p>
  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th className="w-[22%]">Role Title</Th>
          <Th className="w-[18%]">Company</Th>
          <Th className="w-[13%]">Location</Th>
          <Th className="w-[7%]">Days Open</Th>
          <Th className="w-[4%]">Link</Th>
          <Th className="w-[10%]">Claim Date</Th>
          <Th className="w-[12%]">Status</Th>
          <Th className="w-[14%]">Notes</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {leads.map((lead, i) => {
          const d = parseDetail(lead.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          const daysOpen = d.days_posted || 0
          const dayCls = daysOpen >= 45 ? 'bg-red-900 text-red-300' : daysOpen >= 30 ? 'bg-orange-900 text-orange-300' : 'bg-gray-700 text-gray-300'
          return (
            <tr key={lead.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
              <TdTruncate className="text-sm text-white font-medium" title={d.job_title || ''}>
                {!!d.past_client && <PastClientStar />}
                {d.job_title || '—'}
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-200 font-semibold" title={d.company_name || lead.company_name || ''}>
                {d.company_name || lead.company_name || '—'}
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-400" title={d.job_location || ''}>
                {d.job_location || '—'}
              </TdTruncate>
              <td className="px-3 py-3">
                {daysOpen > 0
                  ? <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${dayCls}`}>{daysOpen}d</span>
                  : <span className="text-xs text-gray-600">—</span>
                }
              </td>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <ExternalLinkIcon href={d.job_url || d.source_url} />
              </td>
              <TdTruncate className="text-sm text-gray-400">{formatDate(lead.claimed_at)}</TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <LeadStatusSelect lead={lead} onUpdate={onUpdateStatus} />
              </td>
              <td className="px-3 py-3">
                <LeadNoteCell lead={lead} onSave={onUpdateNotes} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableWrapper>
  )
}

function FundingLeadTable({ leads, onUpdateStatus, onUpdateNotes }) {
  const [sortDir, setSortDir] = useState('desc')
  if (leads.length === 0) return <p className="text-sm text-gray-500 italic py-4 px-1">No leads yet.</p>
  const sorted = [...leads].sort((a, b) => {
    const da = parseDetail(a.signal_detail), db = parseDetail(b.signal_detail)
    const ta = new Date(da.date || da.filing_date || da.date_announced || a.first_detected_at || 0).getTime()
    const tb = new Date(db.date || db.filing_date || db.date_announced || b.first_detected_at || 0).getTime()
    return sortDir === 'desc' ? tb - ta : ta - tb
  })
  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th className="w-[10%]">Type</Th>
          <Th className="w-[18%]">Company</Th>
          <Th className="w-[9%]">Amount</Th>
          <Th className="w-[17%]">Summary</Th>
          <th
            className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[8%] cursor-pointer select-none hover:text-gray-200"
            onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
          >Date {sortDir === 'desc' ? '↓' : '↑'}</th>
          <Th className="w-[5%]">Queue</Th>
          <Th className="w-[10%]">Claim Date</Th>
          <Th className="w-[11%]">Status</Th>
          <Th className="w-[12%]">Notes</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {sorted.map((lead, i) => {
          const d = parseDetail(lead.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          const typeLabel = lead.signal_type === 'ma_transaction'
            ? (MA_TRANSACTION_TYPE_CONFIG[d.transaction_type]?.label || 'M&A')
            : lead.signal_type === 'funding_new_award'
              ? (FUNDING_TYPE_CONFIG[d.funding_type]?.label || 'Funding')
              : lead.signal_type === 'funding_renewal' ? 'Renewal'
              : (SIGNAL_TYPE_CONFIG[lead.signal_type]?.label || lead.signal_type)
          const typeColor = lead.signal_type === 'ma_transaction'
            ? (MA_TRANSACTION_TYPE_CONFIG[d.transaction_type]?.color || 'bg-orange-600')
            : 'bg-green-700'
          const summary = d.summary || d.deal_summary || d.funding_summary || lead.signal_summary || ''
          const dateVal = d.date || d.filing_date || d.date_announced || null
          const amountRaw = d.amount || d.deal_value || d.funding_amount || null
          return (
            <tr key={lead.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
              <TdTruncate>
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold text-white whitespace-nowrap ${typeColor}`}>
                  {typeLabel}
                </span>
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-100 font-semibold" title={d.company_name || lead.company_name || ''}>
                {!!d.past_client && <PastClientStar />}
                {d.company_name || lead.company_name || '—'}
              </TdTruncate>
              <TdTruncate className="text-sm font-mono text-green-400">
                {formatAmount(amountRaw)}
              </TdTruncate>
              <TdTruncate title={summary}>
                <span className="text-xs text-gray-300">{truncate(summary, 80)}</span>
              </TdTruncate>
              <TdTruncate className="text-sm text-gray-400">{formatDate(dateVal)}</TdTruncate>
              <td className="px-3 py-3 text-center">
                {d.priority_score
                  ? <span className="text-xs font-mono text-gray-300">{d.priority_score}</span>
                  : <span className="text-xs text-gray-600">—</span>
                }
              </td>
              <TdTruncate className="text-sm text-gray-400">{formatDate(lead.claimed_at)}</TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <LeadStatusSelect lead={lead} onUpdate={onUpdateStatus} />
              </td>
              <td className="px-3 py-3">
                <LeadNoteCell lead={lead} onSave={onUpdateNotes} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableWrapper>
  )
}

function ClinicalLeadDetailCell({ lead }) {
  const d = parseDetail(lead.signal_detail)
  if (lead.signal_type === 'clinical_trial_phase_transition') {
    return (
      <span className="text-sm text-white font-medium">
        {formatPhaseLabel(d.phase_from)} → {formatPhaseLabel(d.phase_to)}
      </span>
    )
  }
  if (lead.signal_type === 'clinical_trial_new_ind') {
    return <span className="text-sm text-gray-400">{d.ind_number || 'N/A'}</span>
  }
  return <span className="text-sm text-gray-400">{truncate(d.summary || '', 40) || '—'}</span>
}

function ClinicalLeadTable({ leads, onUpdateStatus, onUpdateNotes }) {
  const [sortDir, setSortDir] = useState('desc')
  if (leads.length === 0) return <p className="text-sm text-gray-500 italic py-4 px-1">No leads yet.</p>
  const sorted = [...leads].sort((a, b) => {
    const da = parseDetail(a.signal_detail), db = parseDetail(b.signal_detail)
    const ta = new Date(da.transition_date || da.date || a.first_detected_at || 0).getTime()
    const tb = new Date(db.transition_date || db.date || b.first_detected_at || 0).getTime()
    return sortDir === 'desc' ? tb - ta : ta - tb
  })
  return (
    <TableWrapper>
      <thead>
        <tr>
          <Th className="w-[8%]">Type</Th>
          <Th className="w-[15%]">Company</Th>
          <Th className="w-[12%]">Detail</Th>
          <Th className="w-[15%]">Summary</Th>
          <Th className="w-[7%]">Source</Th>
          <th
            className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[8%] cursor-pointer select-none hover:text-gray-200"
            onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
          >Date {sortDir === 'desc' ? '↓' : '↑'}</th>
          <Th className="w-[4%]">Link</Th>
          <Th className="w-[5%]">Queue</Th>
          <Th className="w-[9%]">Claim Date</Th>
          <Th className="w-[9%]">Status</Th>
          <Th className="w-[8%]">Notes</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#374151]">
        {sorted.map((lead, i) => {
          const d = parseDetail(lead.signal_detail)
          const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
          const companyName = d.company_name || d.sponsor || lead.company_name || '—'
          const dateVal = d.transition_date || d.date || null
          const summary = d.study_title || d.summary || lead.signal_summary || ''
          return (
            <tr key={lead.id} className={`${rowBg} hover:bg-[#263045] transition-colors`}>
              <TdTruncate>
                <SignalTypeBadge signalType={lead.signal_type} />
              </TdTruncate>
              <TdTruncate className="text-sm font-semibold text-white" title={companyName}>
                {!!d.past_client && <PastClientStar />}
                {companyName}
              </TdTruncate>
              <td className="px-3 py-3">
                <ClinicalLeadDetailCell lead={lead} />
              </td>
              <TdTruncate title={summary}>
                <span className="text-xs text-gray-400 leading-snug">{truncate(summary, 60)}</span>
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
                ) : <span className="text-xs text-gray-600">—</span>}
              </td>
              <TdTruncate className="text-sm text-gray-400">{formatDate(dateVal)}</TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <ExternalLinkIcon href={d.source_url} />
              </td>
              <td className="px-3 py-3 text-center">
                {d.priority_score
                  ? <span className="text-xs font-mono text-gray-300">{d.priority_score}</span>
                  : <span className="text-xs text-gray-600">—</span>
                }
              </td>
              <TdTruncate className="text-sm text-gray-400">{formatDate(lead.claimed_at)}</TdTruncate>
              <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                <LeadStatusSelect lead={lead} onUpdate={onUpdateStatus} />
              </td>
              <td className="px-3 py-3">
                <LeadNoteCell lead={lead} onSave={onUpdateNotes} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableWrapper>
  )
}

// ── Main LeadsTab ─────────────────────────────────────────────────────────────

function LeadsTab({ leads, repName, showAllLeads, onToggleShowAll, onUpdateStatus, onUpdateNotes, onUpdateClient }) {
  const [selectedTypes, setSelectedTypes] = useState(new Set(['all']))

  if (!repName) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-14 h-14 rounded-full bg-[#1f2937] flex items-center justify-center mb-4">
          <span className="text-gray-500 text-2xl font-bold">?</span>
        </div>
        <p className="text-gray-300 text-base font-semibold mb-1">Set your name to see your leads.</p>
        <p className="text-gray-500 text-sm">Your claimed signals will appear here for tracking and outreach.</p>
      </div>
    )
  }

  const myCount = leads.filter(l => l.claimed_by === repName).length
  const displayLeads = showAllLeads ? leads : leads.filter(l => l.claimed_by === repName)
  const toggleLabel = showAllLeads ? `Show my leads (${myCount})` : `Show all leads (${leads.length})`

  const toggleType = (key) => {
    setSelectedTypes(prev => {
      if (key === 'all') return new Set(['all'])
      const next = new Set(prev)
      next.delete('all')
      if (next.has(key)) {
        next.delete(key)
        if (next.size === 0) return new Set(['all'])
      } else {
        next.add(key)
      }
      return next
    })
  }

  const isAll = selectedTypes.has('all')

  const categorized = {
    clinical:   displayLeads.filter(l => LEAD_SIGNAL_TYPES.clinical.includes(l.signal_type)),
    funding:    displayLeads.filter(l => LEAD_SIGNAL_TYPES.funding.includes(l.signal_type)),
    competitor: displayLeads.filter(l => LEAD_SIGNAL_TYPES.competitor.includes(l.signal_type)),
    stale:      displayLeads.filter(l => LEAD_SIGNAL_TYPES.stale.includes(l.signal_type)),
  }

  const visibleTypes = isAll
    ? ['clinical', 'funding', 'competitor', 'stale']
    : [...selectedTypes].filter(k => k !== 'all')

  return (
    <div className="flex flex-col gap-6">
      {/* Controls row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <LeadTypeFilterDropdown selectedTypes={selectedTypes} onToggle={toggleType} />
        <button
          onClick={onToggleShowAll}
          className="text-xs text-blue-400 hover:text-blue-300 font-medium px-2 py-1 rounded bg-blue-900/30 hover:bg-blue-900/50 transition-colors"
        >
          {toggleLabel}
        </button>
      </div>

      {/* Anchor buttons — only in All Leads view */}
      {isAll && (
        <div className="flex gap-2 flex-wrap">
          {(['clinical', 'funding', 'competitor', 'stale']).map(key => (
            <button
              key={key}
              onClick={() => document.getElementById(`leads-section-${key}`)?.scrollIntoView({ behavior: 'smooth' })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1f2937] border border-[#374151] text-xs font-medium text-gray-300 hover:text-white hover:border-[#4b5563] transition-colors"
            >
              {LEADS_SECTION_META[key]}
              <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-xs font-bold bg-white/10 text-gray-400">
                {categorized[key].length}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {displayLeads.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-[#1f2937] flex items-center justify-center mb-4">
            <span className="text-gray-500 text-2xl font-mono">—</span>
          </div>
          <p className="text-gray-300 text-base font-semibold mb-1">
            {showAllLeads ? 'No leads found.' : 'No leads claimed yet.'}
          </p>
          <p className="text-gray-500 text-sm">Claim signals from the other tabs to track them here.</p>
        </div>
      )}

      {/* Per-type sections */}
      {displayLeads.length > 0 && visibleTypes.map(typeKey => {
        const sectionLeads = categorized[typeKey]
        return (
          <div key={typeKey} id={`leads-section-${typeKey}`} className="flex flex-col gap-3">
            {isAll && (
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-[#374151] pb-2">
                {LEADS_SECTION_META[typeKey]}
                <span className="ml-2 text-gray-600 font-normal normal-case">({sectionLeads.length})</span>
              </h3>
            )}
            {typeKey === 'competitor' && <CompetitorJobsLeadTable leads={sectionLeads} onUpdateStatus={onUpdateStatus} onUpdateNotes={onUpdateNotes} onUpdateClient={onUpdateClient} />}
            {typeKey === 'stale'      && <StaleRolesLeadTable     leads={sectionLeads} onUpdateStatus={onUpdateStatus} onUpdateNotes={onUpdateNotes} />}
            {typeKey === 'funding'    && <FundingLeadTable         leads={sectionLeads} onUpdateStatus={onUpdateStatus} onUpdateNotes={onUpdateNotes} />}
            {typeKey === 'clinical'   && <ClinicalLeadTable        leads={sectionLeads} onUpdateStatus={onUpdateStatus} onUpdateNotes={onUpdateNotes} />}
          </div>
        )
      })}
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
    case 'flask':
      return (
        <svg {...props}>
          <path d="M9 3h6"/>
          <path d="M8.5 3v6L4 19a1 1 0 0 0 .9 1.45h14.2a1 1 0 0 0 .9-1.45L15.5 9V3"/>
          <path d="M19 2l2 2M21 2l-2 2" strokeWidth="2.5"/>
        </svg>
      )
    case 'trending':
      return (
        <svg {...props}>
          <polyline points="22,7 13.5,15.5 8.5,10.5 2,17"/>
          <polyline points="16,7 22,7 22,13"/>
        </svg>
      )
    case 'dollar':
      return (
        <svg {...props}>
          <line x1="12" y1="2" x2="12" y2="22"/>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
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
    case 'book':
      return (
        <svg {...props}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
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
  { key: 'dashboard',      label: 'Dashboard',              icon: 'grid' },
  { key: 'madison_leads',  label: 'Madison Leads',          icon: 'clipboard', countKey: 'madison_leads' },
  { key: 'clinical_new',   label: 'Clinical Trials - NEW',  icon: 'flask',     countKey: 'clinical_new' },
  { key: 'ma_funding_new', label: 'M&A - NEW',              icon: 'trending',  countKey: 'ma_funding_new' },
  { key: 'funding_new',    label: 'Funding - NEW',          icon: 'dollar',    countKey: 'funding_new' },
  { key: 'competitor',     label: 'Competitor Jobs',        icon: 'briefcase', countKey: 'competitor' },
  { key: 'stale',          label: 'Stale Roles',            icon: 'clock',     countKey: 'stale' },
  { key: 'buyers',         label: 'Past Buyers',            icon: 'users' },
  { key: 'candidates',     label: 'Past Candidates',        icon: 'user' },
  { key: 'contacts',       label: 'Other Contacts',         icon: 'user' },
  { key: 'clinical',       label: 'Clinical Trials',        icon: 'beaker',    countKey: 'clinical' },
  { key: 'funding',        label: 'Funding & M&A',          icon: 'trending',  countKey: 'funding' },
  { key: 'leads',          label: 'My Leads',               icon: 'clipboard', countKey: 'leads' },
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

function TopBar({ activePage, loading, agentRunning, repName, onRefresh, onRunAgents, onShowNameModal }) {
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

        {/* Rep identity — opens name modal */}
        {repName ? (
          <button
            onClick={onShowNameModal}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors group"
          >
            <span className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs font-bold text-white select-none">
              {getRepInitials(repName)}
            </span>
            <span className="text-sm text-gray-300 group-hover:text-white hidden sm:inline">{repName}</span>
          </button>
        ) : (
          <button
            onClick={onShowNameModal}
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

function CompetitorJobsPage({ signals, repName, expandedRows, onToggleRow, onClaim, onUnclaim, onDismiss, onUpdateClient }) {
  const [copiedId, setCopiedId] = useState(null)
  const [editingClientId, setEditingClientId] = useState(null)
  const [editingClientValue, setEditingClientValue] = useState('')
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  function copyMatchPrompt(e, signal) {
    e.stopPropagation()
    const d = parseDetail(signal.signal_detail)
    let desc = d.job_description || ''
    const firmName = d.competitor_firm || ''
    if (firmName) {
      desc = desc.replace(new RegExp(firmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/\s+/g, ' ').trim()
    }
    const prompt = `Using the language in this job description, try to identify the end-client, excluding staffing firms. Compare it to language of other job descriptions associated with that employer to determine whether it is a match. If it is not a strong match, do not guess. ${desc}`
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

  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => {
    const arr = [...signals]
    arr.sort((a, b) => {
      const da = new Date(parseDetail(a.signal_detail).posting_date || a.first_detected_at || 0).getTime()
      const db = new Date(parseDetail(b.signal_detail).posting_date || b.first_detected_at || 0).getTime()
      return sortDir === 'desc' ? db - da : da - db
    })
    return arr
  }, [signals, sortDir])
  const filtered = applyFilters(sorted, extractors)

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
            <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap w-[10%] cursor-pointer select-none hover:text-gray-200" onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>Date Posted {sortDir === 'desc' ? '↓' : '↑'}</th>
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
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    {editingClientId === signal.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={editingClientValue}
                        onChange={e => setEditingClientValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            onUpdateClient(signal.id, editingClientValue.trim())
                            setEditingClientId(null)
                          } else if (e.key === 'Escape') {
                            setEditingClientId(null)
                          }
                        }}
                        onBlur={() => setEditingClientId(null)}
                        className="w-full bg-[#111827] text-sm text-white px-2 py-1 rounded border border-blue-500/50 outline-none focus:border-blue-400"
                        placeholder="Enter client..."
                      />
                    ) : (
                      <div
                        onClick={() => {
                          setEditingClientId(signal.id)
                          setEditingClientValue(d.inferred_client || '')
                        }}
                        className="cursor-text truncate"
                        title={d.inferred_client || 'Click to enter client'}
                      >
                        {d.inferred_client
                          ? <span className="text-sm text-gray-200">{d.inferred_client}</span>
                          : <span className="text-xs text-gray-500 italic">Enter client...</span>}
                      </div>
                    )}
                  </td>
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
                    {(d.source_url || d.job_url || d.careers_url) ? (
                      <a
                        href={d.source_url || d.job_url || d.careers_url}
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

function ContactsTable({ rows, columns, emptyMessage, showActions, onAction, loading, showLinkedIn }) {
  const [search, setSearch] = useState('')
  const filtered = rows.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return (`${r.first_name || ''} ${r.last_name || ''}`).toLowerCase().includes(s)
      || (r.company || '').toLowerCase().includes(s)
      || (r.title || '').toLowerCase().includes(s)
      || (r.email || '').toLowerCase().includes(s)
  })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          type="text" placeholder="Search by name, company, title, or email…"
          value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-[#111827] border border-[#374151] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-xs text-gray-500 shrink-0">{filtered.length} of {rows.length}</span>
      </div>
      <div className="bg-[#1f2937] border border-[#374151] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full divide-y divide-[#374151]">
            <thead>
              <tr>
                {columns.map(col => (
                  <th key={col} className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">{col}</th>
                ))}
                {showLinkedIn && (
                  <>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">LinkedIn Title</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">LinkedIn Company</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">Last Checked</th>
                  </>
                )}
                {showActions && (
                  <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#374151]">
              {loading ? (
                <tr><td colSpan={columns.length + (showActions ? 1 : 0) + (showLinkedIn ? 3 : 0)} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm">Loading…</p></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={columns.length + (showActions ? 1 : 0) + (showLinkedIn ? 3 : 0)} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">{search ? 'No matches found.' : emptyMessage}</p></td></tr>
              ) : filtered.map(row => (
                <tr key={row.id} className="hover:bg-[#111827]/50 transition-colors">
                  <td className="px-3 py-2.5 text-sm text-white whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {row.is_current_buyer && <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" title="Current buyer" />}
                      {row.first_name} {row.last_name}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-sm text-gray-300 whitespace-nowrap">{row.company || '—'}</td>
                  <td className="px-3 py-2.5 text-sm text-gray-300">{row.title || '—'}</td>
                  <td className="px-3 py-2.5 text-sm">
                    {row.email ? <a href={`mailto:${row.email}`} className="text-blue-400 hover:text-blue-300 hover:underline">{row.email}</a> : <span className="text-gray-500">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-sm">
                    {row.phone ? <a href={`tel:${row.phone}`} className="text-blue-400 hover:text-blue-300 hover:underline">{row.phone}</a> : <span className="text-gray-500">—</span>}
                  </td>
                  {showLinkedIn && (
                    <>
                      <td className="px-3 py-2.5 text-sm whitespace-nowrap">
                        {row.linkedin_current_title
                          ? <span className="flex items-center gap-1.5">
                              <span className="text-gray-300">{row.linkedin_current_title}</span>
                              {row.title_changed && <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-500/20 text-amber-400">changed</span>}
                            </span>
                          : <span className="text-gray-500">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-sm whitespace-nowrap">
                        {row.linkedin_current_company
                          ? <span className="flex items-center gap-1.5">
                              <span className="text-gray-300">{row.linkedin_current_company}</span>
                              {row.company_changed && <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-500/20 text-amber-400">changed</span>}
                            </span>
                          : <span className="text-gray-500">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-sm text-gray-500 whitespace-nowrap">
                        {row.linkedin_last_checked
                          ? new Date(row.linkedin_last_checked).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                          : 'Never'}
                      </td>
                    </>
                  )}
                  {showActions && (
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => onAction(row.id, 'past_buyers')} className="px-2 py-1 text-xs font-medium rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors">Buyer</button>
                        <button onClick={() => onAction(row.id, 'past_candidates')} className="px-2 py-1 text-xs font-medium rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 transition-colors">Candidate</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function BuyerCandidateTable({ rows, emptyMessage, loading, showBuyerDot, table, onDeleteRow }) {
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  const toggleRow = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDelete = async (row) => {
    const res = await fetch('/api/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, table }),
    })
    if (res.ok) {
      setConfirmDeleteId(null)
      if (onDeleteRow) onDeleteRow(row.id)
    } else {
      const err = await res.json().catch(() => ({}))
      setDeleteError(err.error || 'Delete failed')
    }
  }

  const filtered = rows.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return (`${r.first_name || ''} ${r.last_name || ''}`).toLowerCase().includes(s)
      || (r.company || '').toLowerCase().includes(s)
      || (r.title || '').toLowerCase().includes(s)
      || (r.email || '').toLowerCase().includes(s)
  })

  const COL_SPAN = 8

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          type="text" placeholder="Search by name, company, title, or email…"
          value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-[#111827] border border-[#374151] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-xs text-gray-500 shrink-0">{filtered.length} of {rows.length}</span>
      </div>
      <div className="bg-[#1f2937] border border-[#374151] rounded-xl overflow-hidden" style={{ width: '100%', overflowX: 'hidden' }}>
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '28px' }} />
            <col style={{ width: '32px' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">Full Name</th>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">Current Role</th>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">Current Company</th>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">Location</th>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">LinkedIn Company</th>
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234]">Last Checked</th>
              <th className="py-3 bg-[#1a2234]"></th>
              <th className="py-3 bg-[#1a2234] text-xs font-semibold uppercase tracking-wider text-gray-600 text-center">Del</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {loading ? (
              <tr><td colSpan={COL_SPAN} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm">Loading…</p></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={COL_SPAN} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">{search ? 'No matches found.' : emptyMessage}</p></td></tr>
            ) : filtered.map(row => {
              const fullName = `${row.first_name || ''} ${row.last_name || ''}`.trim()
              const isExpanded = expandedIds.has(row.id)
              return (
                <Fragment key={row.id}>
                  <tr onClick={() => toggleRow(row.id)} className="cursor-pointer hover:bg-[#111827]/50 transition-colors">
                    <td className="px-3 py-2.5" title={fullName} style={{ overflow: 'hidden' }}>
                      <div className="flex items-center gap-2" style={{ overflow: 'hidden' }}>
                        {showBuyerDot && row.is_current_buyer && <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" title="Current buyer" />}
                        <span className="text-xs text-white" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{fullName || '—'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-300" title={row.title || ''} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.title || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-300" title={row.company || ''} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.company || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-300" title={row.location || ''} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.location || '—'}</td>
                    <td className="px-3 py-2.5" title={row.linkedin_current_company || ''} style={{ overflow: 'hidden' }}>
                      {row.linkedin_current_company
                        ? <span className="flex items-center gap-1" style={{ overflow: 'hidden' }}>
                            <span className="text-xs text-gray-300" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.linkedin_current_company}</span>
                            {row.company_changed && <span className="px-1 py-0.5 text-xs font-medium rounded bg-amber-500/20 text-amber-400 shrink-0">↑</span>}
                          </span>
                        : <span className="text-xs text-gray-500">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500" style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {row.linkedin_last_checked
                        ? new Date(row.linkedin_last_checked).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : 'Never'}
                    </td>
                    <td className="pr-3 py-2.5 text-right" style={{ color: '#6b7280' }}>
                      <svg style={{ width: 12, height: 12, display: 'inline', transition: 'transform 0.15s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                      </svg>
                    </td>
                    <td className="py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => { setConfirmDeleteId(row.id); setDeleteError(null) }}
                        title="Delete contact"
                        style={{ color: '#7f1d1d', lineHeight: 1 }}
                        onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                        onMouseLeave={e => e.currentTarget.style.color = '#7f1d1d'}
                      >
                        <svg style={{ width: 13, height: 13, display: 'inline' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                  {confirmDeleteId === row.id && (
                    <tr key={`${row.id}-del`}>
                      <td colSpan={COL_SPAN} className="px-6 py-3 border-b border-red-900/40" style={{ background: 'rgba(127,29,29,0.18)' }}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm text-red-300">Delete <strong className="text-red-200">{fullName}</strong>? This cannot be undone.</span>
                          <button
                            onClick={() => handleDelete(row)}
                            className="px-3 py-1 text-xs font-semibold bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
                          >Confirm</button>
                          <button
                            onClick={() => { setConfirmDeleteId(null); setDeleteError(null) }}
                            className="px-3 py-1 text-xs bg-[#374151] hover:bg-[#4b5563] text-gray-300 rounded transition-colors"
                          >Cancel</button>
                          {deleteError && <span className="text-xs text-red-400">{deleteError}</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                  {isExpanded && (
                    <tr key={`${row.id}-exp`}>
                      <td colSpan={COL_SPAN} className="bg-[#263045] px-6 py-4 border-b border-[#374151]">
                        <div className="flex flex-wrap gap-x-8 gap-y-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Email</span>
                            {row.email
                              ? <a href={`mailto:${row.email}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.email}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">LinkedIn</span>
                            {row.linkedin_url
                              ? <a href={row.linkedin_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.linkedin_url.replace(/[?#].*/, '')}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          {row.phone && (
                            <div className="flex flex-col gap-1">
                              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Phone</span>
                              <a href={`tel:${row.phone}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.phone}</a>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Clinical Trials NEW Page ────────────────────────────────────────────────

function ClinicalTrialsNewPage() {
  const [trials, setTrials] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  useEffect(() => {
    fetch('/api/clinical-trials')
      .then(r => r.json())
      .then(data => {
        setTrials(data.trials || [])
        setPastClients(data.pastClients || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const pastClientsLower = useMemo(() => new Set(pastClients.map(n => n.toLowerCase())), [pastClients])

  const toggleRow = useCallback((id) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const getDisplayName = useCallback((t) => t.matched_name || t.lead_sponsor_name || '', [])

  const getCategory = useCallback((t) => {
    const drug = t.is_fda_regulated_drug
    const device = t.is_fda_regulated_device
    if (drug && device) return 'Drug / Device'
    if (drug) return 'Drug'
    if (device) return 'Device'
    return ''
  }, [])

  const isPastClient = useCallback((t) => {
    const name = getDisplayName(t).toLowerCase()
    return name && pastClientsLower.has(name)
  }, [pastClientsLower, getDisplayName])

  const extractors = useMemo(() => ({
    nct_id: t => t.nct_id || '',
    company: t => getDisplayName(t),
    title: t => t.brief_title || '',
    phase: t => t.phase || '',
    category: t => getCategory(t),
    last_update: t => formatDate(t.last_update_post_date),
  }), [getDisplayName, getCategory])

  const allValues = useMemo(() => ({
    nct_id: trials.map(t => t.nct_id || ''),
    company: trials.map(t => getDisplayName(t)),
    title: trials.map(t => t.brief_title || ''),
    phase: trials.map(t => t.phase || ''),
    category: trials.map(t => getCategory(t)),
    last_update: trials.map(t => formatDate(t.last_update_post_date)),
  }), [trials, getDisplayName, getCategory])

  const sorted = useMemo(() => {
    const arr = [...trials]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = new Date(a.last_update_post_date || 0).getTime()
      const db = new Date(b.last_update_post_date || 0).getTime()
      return db - da
    })
    return arr
  }, [trials, isPastClient])

  const filtered = applyFilters(sorted, extractors)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (trials.length === 0) return <EmptyState message="No clinical trials found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={allValues.nct_id} activeValues={filters.nct_id} onApply={setFilter} className="w-[12%]" />
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[22%]" />
              <ColumnFilterDropdown colKey="title" label="Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="phase" label="Phase" allValues={allValues.phase} activeValues={filters.phase} onApply={setFilter} className="w-[10%]" />
              <ColumnFilterDropdown colKey="category" label="Category" allValues={allValues.category} activeValues={filters.category} onApply={setFilter} className="w-[12%]" />
              <ColumnFilterDropdown colKey="last_update" label="Last Update" allValues={allValues.last_update} activeValues={filters.last_update} onApply={setFilter} className="w-[14%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((trial, i) => {
              const isExpanded = expandedRows.has(trial.id || trial.nct_id)
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(trial)
              const isClient = isPastClient(trial)
              const category = getCategory(trial)
              const contacts = Array.isArray(trial.central_contacts) ? trial.central_contacts : []

              return (
                <Fragment key={trial.id || trial.nct_id}>
                  <tr
                    onClick={() => toggleRow(trial.id || trial.nct_id)}
                    className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {trial.nct_id || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                      {displayName || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-white" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {trial.brief_title || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {trial.phase || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {category || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {formatDate(trial.last_update_post_date)}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div className="flex flex-col gap-4">
                          <div>
                            <a
                              href={trial.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-blue-400 hover:text-blue-300 font-medium"
                            >
                              View on ClinicalTrials.gov &#8599;
                            </a>
                          </div>
                          <div>
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Contact Information</h4>
                            {contacts.length > 0 ? (
                              <div className="flex flex-col gap-2">
                                {contacts.map((c, ci) => (
                                  <div key={ci} className="text-sm text-gray-300 flex flex-wrap gap-x-4 gap-y-1">
                                    {c.name && <span>{c.name}</span>}
                                    {c.email && (
                                      <a href={`mailto:${c.email}`} className="text-blue-400 hover:text-blue-300" onClick={e => e.stopPropagation()}>
                                        {c.email}
                                      </a>
                                    )}
                                    {c.phone && (
                                      <a href={`tel:${c.phone}`} className="text-blue-400 hover:text-blue-300" onClick={e => e.stopPropagation()}>
                                        {c.phone}
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-gray-500 italic">No contact information available</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── M&A and Funding NEW Page ────────────────────────────────────────────────

function MAFundingNewPage() {
  const [filings, setFilings] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  useEffect(() => {
    fetch('/api/ma-funding')
      .then(r => r.json())
      .then(data => {
        setFilings(data.filings || [])
        setPastClients(data.pastClients || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const pastClientsLower = useMemo(() => new Set(pastClients.map(n => n.toLowerCase())), [pastClients])

  const toggleRow = useCallback((id) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const getDisplayName = useCallback((f) => f.matched_name || f.company_name || '', [])

  const isPastClient = useCallback((f) => {
    const name = getDisplayName(f).toLowerCase()
    return name && pastClientsLower.has(name)
  }, [pastClientsLower, getDisplayName])

  const extractors = useMemo(() => ({
    company: f => getDisplayName(f),
    transaction: f => f._transaction || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: filings.map(f => getDisplayName(f)),
    transaction: filings.map(f => f._transaction || ''),
  }), [filings, getDisplayName])

  const sorted = useMemo(() => {
    const arr = [...filings]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = new Date(a.filing_date || 0).getTime()
      const db = new Date(b.filing_date || 0).getTime()
      return db - da
    })
    return arr
  }, [filings, isPastClient])

  const filtered = applyFilters(sorted, extractors)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (filings.length === 0) return <EmptyState message="No M&A or funding filings found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={allValues.transaction} activeValues={filters.transaction} onApply={setFilter} className="w-[20%]" />
              <Th className="w-[20%]">Filing Date</Th>
              <Th className="w-[30%]">Filing Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((filing, i) => {
              const rowKey = filing.id || filing.accession_number
              const isExpanded = expandedRows.has(rowKey)
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(filing)
              const isClient = isPastClient(filing)
              const hasExpandContent = filing._source === '8-K' && filing.agreement_summary

              return (
                <Fragment key={rowKey}>
                  <tr
                    onClick={() => hasExpandContent && toggleRow(rowKey)}
                    className={`${rowBg} hover:bg-[#263045] ${hasExpandContent ? 'cursor-pointer' : ''} transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                      {displayName || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {filing._transaction || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {formatDate(filing.filing_date)}
                    </td>
                    <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                      {filing.filing_url ? (
                        <a
                          href={filing.filing_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 font-medium"
                        >
                          View Filing &#8599;
                        </a>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={4} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Agreement Summary</h4>
                          <p className="text-sm text-gray-300 leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
                            {filing.agreement_summary}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Funding NEW Page ────────────────────────────────────────────────────────

function formatAward(amount) {
  if (amount == null || amount === 0) return '—'
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n) || n === 0) return '—'
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function FundingNewPage() {
  const [projects, setProjects] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  useEffect(() => {
    fetch('/api/funding-new')
      .then(r => r.json())
      .then(data => {
        setProjects(data.projects || [])
        setPastClients(data.pastClients || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const pastClientsLower = useMemo(() => new Set(pastClients.map(n => n.toLowerCase())), [pastClients])

  const toggleRow = useCallback((id) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const getDisplayName = useCallback((p) => p.matched_name || '', [])

  const isPastClient = useCallback((p) => {
    const name = getDisplayName(p).toLowerCase()
    return name && pastClientsLower.has(name)
  }, [pastClientsLower, getDisplayName])

  const extractors = useMemo(() => ({
    company: p => getDisplayName(p),
    title: p => p.project_title || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: projects.map(p => getDisplayName(p)),
    title: projects.map(p => p.project_title || ''),
  }), [projects, getDisplayName])

  const sorted = useMemo(() => {
    const arr = [...projects]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = new Date(a.award_notice_date || 0).getTime()
      const db = new Date(b.award_notice_date || 0).getTime()
      return db - da
    })
    return arr
  }, [projects, isPastClient])

  const filtered = applyFilters(sorted, extractors)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (projects.length === 0) return <EmptyState message="No funding projects found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="title" label="Project Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <Th className="w-[15%]">Award</Th>
              <Th className="w-[10%]">Award Date</Th>
              <Th className="w-[15%]">Project Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((project, i) => {
              const rowKey = project.id || project.appl_id
              const hasExpandContent = !!(project.public_health_relevance && project.public_health_relevance.trim())
              const isExpanded = expandedRows.has(rowKey)
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(project)
              const isClient = isPastClient(project)

              return (
                <Fragment key={rowKey}>
                  <tr
                    onClick={() => hasExpandContent && toggleRow(rowKey)}
                    className={`${rowBg} hover:bg-[#263045] ${hasExpandContent ? 'cursor-pointer' : ''} transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                      {displayName || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-white" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {project.project_title || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {formatAward(project.award_amount)}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                      {formatDate(project.award_notice_date)}
                    </td>
                    <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                      {project.project_url ? (
                        <a
                          href={project.project_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 font-medium"
                        >
                          View Project &#8599;
                        </a>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                  {isExpanded && hasExpandContent && (
                    <tr>
                      <td colSpan={5} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Summary:</h4>
                          <p className="text-sm text-gray-300 leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
                            {project.public_health_relevance}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Madison Leads Page ──────────────────────────────────────────────────────

function MadisonLeadsPage() {
  const [data, setData] = useState({ trackedCompanies: [], clinicalTrials: [], filings: [], fundingProjects: [], pastClients: [] })
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedTrialRows, setExpandedTrialRows] = useState(new Set())
  const [expandedFilingRows, setExpandedFilingRows] = useState(new Set())
  const [expandedFundingRows, setExpandedFundingRows] = useState(new Set())
  const searchRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceRef = useRef(null)

  const trialsFilter = useColumnFilters()
  const filingsFilter = useColumnFilters()
  const fundingFilter = useColumnFilters()

  const loadData = useCallback(() => {
    setLoading(true)
    fetch('/api/madison-leads')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Search debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([])
      setSearchOpen(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      fetch(`/api/company-search?q=${encodeURIComponent(searchQuery.trim())}`)
        .then(r => r.json())
        .then(results => {
          setSearchResults(Array.isArray(results) ? results : [])
          setSearchOpen(true)
        })
        .catch(() => {})
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [searchQuery])

  // Close dropdown on outside click
  useEffect(() => {
    if (!searchOpen) return
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) && !searchRef.current.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [searchOpen])

  const addCompany = async (name) => {
    if (data.trackedCompanies.includes(name)) return
    await fetch('/api/madison-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    setSearchQuery('')
    setSearchOpen(false)
    loadData()
  }

  const removeCompany = async (name) => {
    await fetch('/api/madison-leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    loadData()
  }

  const pastClientsLower = useMemo(() => new Set(data.pastClients.map(n => n.toLowerCase())), [data.pastClients])

  const toggleTrialRow = useCallback((id) => {
    setExpandedTrialRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const toggleFilingRow = useCallback((id) => {
    setExpandedFilingRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const toggleFundingRow = useCallback((id) => {
    setExpandedFundingRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const isPastClient = useCallback((name) => {
    const lower = (name || '').toLowerCase()
    return lower && pastClientsLower.has(lower)
  }, [pastClientsLower])

  // ── Clinical Trials table logic ───────────────────────────────────────────

  const getTrialDisplayName = useCallback((t) => t.matched_name || t.lead_sponsor_name || '', [])
  const getCategory = useCallback((t) => {
    const drug = t.is_fda_regulated_drug
    const device = t.is_fda_regulated_device
    if (drug && device) return 'Drug / Device'
    if (drug) return 'Drug'
    if (device) return 'Device'
    return ''
  }, [])

  const trialExtractors = useMemo(() => ({
    nct_id: t => t.nct_id || '',
    company: t => getTrialDisplayName(t),
    title: t => t.brief_title || '',
    phase: t => t.phase || '',
    category: t => getCategory(t),
    last_update: t => formatDate(t.last_update_post_date),
  }), [getTrialDisplayName, getCategory])

  const trialAllValues = useMemo(() => ({
    nct_id: data.clinicalTrials.map(t => t.nct_id || ''),
    company: data.clinicalTrials.map(t => getTrialDisplayName(t)),
    title: data.clinicalTrials.map(t => t.brief_title || ''),
    phase: data.clinicalTrials.map(t => t.phase || ''),
    category: data.clinicalTrials.map(t => getCategory(t)),
    last_update: data.clinicalTrials.map(t => formatDate(t.last_update_post_date)),
  }), [data.clinicalTrials, getTrialDisplayName, getCategory])

  const sortedTrials = useMemo(() => {
    const arr = [...data.clinicalTrials]
    arr.sort((a, b) => {
      const ap = isPastClient(getTrialDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getTrialDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.last_update_post_date || 0) - new Date(a.last_update_post_date || 0)
    })
    return arr
  }, [data.clinicalTrials, isPastClient, getTrialDisplayName])

  const filteredTrials = trialsFilter.applyFilters(sortedTrials, trialExtractors)

  // ── Filings table logic ───────────────────────────────────────────────────

  const getFilingDisplayName = useCallback((f) => f.matched_name || f.company_name || '', [])

  const filingExtractors = useMemo(() => ({
    company: f => getFilingDisplayName(f),
    transaction: f => f._transaction || '',
  }), [getFilingDisplayName])

  const filingAllValues = useMemo(() => ({
    company: data.filings.map(f => getFilingDisplayName(f)),
    transaction: data.filings.map(f => f._transaction || ''),
  }), [data.filings, getFilingDisplayName])

  const sortedFilings = useMemo(() => {
    const arr = [...data.filings]
    arr.sort((a, b) => {
      const ap = isPastClient(getFilingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFilingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.filing_date || 0) - new Date(a.filing_date || 0)
    })
    return arr
  }, [data.filings, isPastClient, getFilingDisplayName])

  const filteredFilings = filingsFilter.applyFilters(sortedFilings, filingExtractors)

  // ── Funding table logic ───────────────────────────────────────────────────

  const getFundingDisplayName = useCallback((p) => p.matched_name || '', [])

  const fundingExtractors = useMemo(() => ({
    company: p => getFundingDisplayName(p),
    title: p => p.project_title || '',
  }), [getFundingDisplayName])

  const fundingAllValues = useMemo(() => ({
    company: data.fundingProjects.map(p => getFundingDisplayName(p)),
    title: data.fundingProjects.map(p => p.project_title || ''),
  }), [data.fundingProjects, getFundingDisplayName])

  const sortedFunding = useMemo(() => {
    const arr = [...data.fundingProjects]
    arr.sort((a, b) => {
      const ap = isPastClient(getFundingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFundingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.award_notice_date || 0) - new Date(a.award_notice_date || 0)
    })
    return arr
  }, [data.fundingProjects, isPastClient, getFundingDisplayName])

  const filteredFunding = fundingFilter.applyFilters(sortedFunding, fundingExtractors)

  // Filter search results to exclude already-tracked companies
  const availableResults = searchResults.filter(r => !data.trackedCompanies.includes(r.name))

  return (
    <div className="flex flex-col gap-6">
      {/* ── Company Selector ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="relative" ref={searchRef}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search companies to track..."
            className="w-full bg-[#111827] text-sm text-white px-4 py-2.5 rounded-lg border border-[#374151] outline-none focus:border-blue-500 placeholder-gray-500"
          />
          {searchOpen && availableResults.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl"
            >
              {availableResults.slice(0, 50).map(r => (
                <button
                  key={r.name}
                  onClick={() => addCompany(r.name)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {data.trackedCompanies.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {data.trackedCompanies.map(name => (
              <span key={name} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600/20 text-blue-300 text-xs font-medium border border-blue-500/30">
                {name}
                <button
                  onClick={() => removeCompany(name)}
                  className="ml-0.5 text-blue-400 hover:text-white transition-colors text-base leading-none"
                  aria-label={`Remove ${name}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && data.trackedCompanies.length === 0 && (
        <EmptyState message="Search and add companies above to see their clinical trials and SEC filings." />
      )}

      {/* ── Clinical Trials Section ──────────────────────────────────────── */}
      {!loading && data.clinicalTrials.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">Clinical Trials</h2>
          <ClearAllFiltersButton hasActiveFilters={trialsFilter.hasActiveFilters} onClear={trialsFilter.clearAll} />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={trialAllValues.nct_id} activeValues={trialsFilter.filters.nct_id} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={trialAllValues.company} activeValues={trialsFilter.filters.company} onApply={trialsFilter.setFilter} className="w-[22%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={trialAllValues.title} activeValues={trialsFilter.filters.title} onApply={trialsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="phase" label="Phase" allValues={trialAllValues.phase} activeValues={trialsFilter.filters.phase} onApply={trialsFilter.setFilter} className="w-[10%]" />
                  <ColumnFilterDropdown colKey="category" label="Category" allValues={trialAllValues.category} activeValues={trialsFilter.filters.category} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <ColumnFilterDropdown colKey="last_update" label="Last Update" allValues={trialAllValues.last_update} activeValues={trialsFilter.filters.last_update} onApply={trialsFilter.setFilter} className="w-[14%]" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredTrials.map((trial, i) => {
                  const isExpanded = expandedTrialRows.has(trial.id || trial.nct_id)
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getTrialDisplayName(trial)
                  const isClient = isPastClient(displayName)
                  const category = getCategory(trial)
                  const contacts = Array.isArray(trial.central_contacts) ? trial.central_contacts : []

                  return (
                    <Fragment key={trial.id || trial.nct_id}>
                      <tr
                        onClick={() => toggleTrialRow(trial.id || trial.nct_id)}
                        className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                      >
                        <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{trial.nct_id || '—'}</td>
                        <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                          {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                          {displayName || '—'}
                        </td>
                        <td className="px-3 py-3 text-sm text-white" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{trial.brief_title || '—'}</td>
                        <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{trial.phase || '—'}</td>
                        <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{category || '—'}</td>
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(trial.last_update_post_date)}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                            <div className="flex flex-col gap-4">
                              <div>
                                <a href={trial.source_url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-400 hover:text-blue-300 font-medium">
                                  View on ClinicalTrials.gov &#8599;
                                </a>
                              </div>
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Contact Information</h4>
                                {contacts.length > 0 ? (
                                  <div className="flex flex-col gap-2">
                                    {contacts.map((c, ci) => (
                                      <div key={ci} className="text-sm text-gray-300 flex flex-wrap gap-x-4 gap-y-1">
                                        {c.name && <span>{c.name}</span>}
                                        {c.email && <a href={`mailto:${c.email}`} className="text-blue-400 hover:text-blue-300" onClick={e => e.stopPropagation()}>{c.email}</a>}
                                        {c.phone && <a href={`tel:${c.phone}`} className="text-blue-400 hover:text-blue-300" onClick={e => e.stopPropagation()}>{c.phone}</a>}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-sm text-gray-500 italic">No contact information available</p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── M&A and Filings Section ──────────────────────────────────────── */}
      {!loading && data.filings.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">M&A and Filings</h2>
          <ClearAllFiltersButton hasActiveFilters={filingsFilter.hasActiveFilters} onClear={filingsFilter.clearAll} />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={filingAllValues.company} activeValues={filingsFilter.filters.company} onApply={filingsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={filingAllValues.transaction} activeValues={filingsFilter.filters.transaction} onApply={filingsFilter.setFilter} className="w-[20%]" />
                  <Th className="w-[20%]">Filing Date</Th>
                  <Th className="w-[30%]">Filing Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredFilings.map((filing, i) => {
                  const rowKey = filing.id || filing.accession_number
                  const isExpanded = expandedFilingRows.has(rowKey)
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getFilingDisplayName(filing)
                  const isClient = isPastClient(displayName)
                  const hasExpandContent = filing._source === '8-K' && filing.agreement_summary

                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() => hasExpandContent && toggleFilingRow(rowKey)}
                        className={`${rowBg} hover:bg-[#263045] ${hasExpandContent ? 'cursor-pointer' : ''} transition-colors`}
                      >
                        <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                          {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                          {displayName || '—'}
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{filing._transaction || '—'}</td>
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(filing.filing_date)}</td>
                        <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                          {filing.filing_url ? (
                            <a href={filing.filing_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Filing &#8599;</a>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={4} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Agreement Summary</h4>
                              <p className="text-sm text-gray-300 leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>{filing.agreement_summary}</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Funding Projects Section ─────────────────────────────────────── */}
      {!loading && data.fundingProjects.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">Funding Projects</h2>
          <ClearAllFiltersButton hasActiveFilters={fundingFilter.hasActiveFilters} onClear={fundingFilter.clearAll} />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={fundingAllValues.company} activeValues={fundingFilter.filters.company} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="title" label="Project Title" allValues={fundingAllValues.title} activeValues={fundingFilter.filters.title} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <Th className="w-[15%]">Award</Th>
                  <Th className="w-[10%]">Award Date</Th>
                  <Th className="w-[15%]">Project Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredFunding.map((project, i) => {
                  const rowKey = project.id || project.appl_id
                  const hasExpandContent = !!(project.public_health_relevance && project.public_health_relevance.trim())
                  const isExpanded = expandedFundingRows.has(rowKey)
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getFundingDisplayName(project)
                  const isClient = isPastClient(displayName)

                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() => hasExpandContent && toggleFundingRow(rowKey)}
                        className={`${rowBg} hover:bg-[#263045] ${hasExpandContent ? 'cursor-pointer' : ''} transition-colors`}
                      >
                        <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                          {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                          {displayName || '—'}
                        </td>
                        <td className="px-3 py-3 text-sm text-white" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{project.project_title || '—'}</td>
                        <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatAward(project.award_amount)}</td>
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(project.award_notice_date)}</td>
                        <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                          {project.project_url ? (
                            <a href={project.project_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Project &#8599;</a>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                      </tr>
                      {isExpanded && hasExpandContent && (
                        <tr>
                          <td colSpan={5} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Summary:</h4>
                              <p className="text-sm text-gray-300 leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>{project.public_health_relevance}</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function PastBuyersPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/contacts?table=past_buyers')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <p className="text-gray-400 text-sm">Contacts at companies that have purchased staffing services. <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" /> = current buyer (timesheet approver).</span></p>
      <BuyerCandidateTable
        rows={rows}
        emptyMessage="No past buyers found."
        loading={loading}
        showBuyerDot
        table="past_buyers"
        onDeleteRow={id => setRows(prev => prev.filter(r => r.id !== id))}
      />
    </div>
  )
}

function PastCandidatesPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/contacts?table=past_candidates')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <p className="text-gray-400 text-sm">Candidates previously placed or engaged with through staffing services.</p>
      <BuyerCandidateTable
        rows={rows}
        emptyMessage="No past candidates found."
        loading={loading}
        table="past_candidates"
        onDeleteRow={id => setRows(prev => prev.filter(r => r.id !== id))}
      />
    </div>
  )
}


function OtherContactsPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const loadContacts = () => {
    setLoading(true)
    fetch('/api/contacts?table=other_contacts')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { loadContacts() }, [])

  const handleMove = async (id, toTable) => {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, from_table: 'other_contacts', to_table: toTable }),
    })
    if (res.ok) {
      setRows(prev => prev.filter(r => r.id !== id))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-gray-400 text-sm">Uncategorized contacts. Use the action buttons to move them to Past Buyers or Past Candidates.</p>
      <ContactsTable
        rows={rows}
        columns={['Name', 'Company', 'Title', 'Email', 'Phone']}
        emptyMessage="No other contacts found."
        loading={loading}
        showActions
        onAction={handleMove}
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
  const [activePage, setActivePage]     = useState('dashboard')
  const [signals, setSignals]           = useState([])
  const [loading, setLoading]           = useState(true)
  const [agentRuns, setAgentRuns]       = useState([])
  const [repName, setRepName]           = useState('')
  const [showNameModal, setShowNameModal] = useState(false)
  const [leads, setLeads]               = useState([])
  const [showAllLeads, setShowAllLeads] = useState(false)
  const [expandedRows, setExpandedRows] = useState(new Set())
  const [notes, setNotes]               = useState({})
  const [savingNotes, setSavingNotes]   = useState(new Set())
  const [agentRunning, setAgentRunning] = useState(false)
  const [toast, setToast]               = useState(null)
  const [dismissTarget, setDismissTarget] = useState(null) // { signal, tabKey }
  const [sidebarCounts, setSidebarCounts] = useState({})

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

  const fetchLeads = useCallback(async () => {
    try {
      const res = await fetch('/api/leads', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setLeads(data.leads || [])
    } catch (err) {
      console.error('Error fetching leads:', err)
    }
  }, [])

  const fetchSidebarCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/sidebar-counts', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setSidebarCounts(data || {})
    } catch (err) {
      console.error('Error fetching sidebar counts:', err)
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('biosignal_rep_name')
    if (stored) {
      setRepName(stored)
    } else {
      setShowNameModal(true)
    }
    fetchSignals()
    fetchAgentRuns()
    fetchLeads()
    fetchSidebarCounts()
  }, [fetchSignals, fetchAgentRuns, fetchLeads, fetchSidebarCounts])

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
  const tabCounts = {
    clinical:       clinicalSignals.length,
    funding:        fundingSignals.length,
    competitor:     competitorSignals.length,
    stale:          staleSignals.length,
    leads:          repName ? leads.filter(l => l.claimed_by === repName).length : 0,
    madison_leads:  sidebarCounts.madison_leads || 0,
    clinical_new:   sidebarCounts.clinical_new || 0,
    ma_funding_new: sidebarCounts.ma_funding_new || 0,
    funding_new:    sidebarCounts.funding_new || 0,
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
    const claimedAt = new Date().toISOString()
    setSignals(prev => prev.map(s => s.id === signal.id ? { ...s, claimed_by: repName, status: 'claimed' } : s))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signal.id, claimed_by: repName, status: 'claimed', claimed_at: claimedAt }),
      })
      const d = parseDetail(signal.signal_detail)
      const companyName = signal.companies?.name || d.company_name || d.sponsor || d.acquirer_name || ''
      const signalSummary = d.job_title || d.study_title || d.deal_summary || d.funding_summary || signal.signal_summary || ''
      await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signal_id: signal.id,
          signal_type: signal.signal_type,
          company_name: companyName,
          signal_summary: signalSummary,
          claimed_by: repName,
          claimed_at: claimedAt,
        }),
      })
      fetchSignals()
      fetchLeads()
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

  // ─── Update inferred client ───────────────────────────────────────────────

  const updateInferredClient = async (signalId, clientName) => {
    // Optimistic local update
    setSignals(prev => prev.map(s => {
      if (s.id !== signalId) return s
      const detail = typeof s.signal_detail === 'object' ? { ...s.signal_detail } : {}
      detail.inferred_client = clientName
      return { ...s, signal_detail: detail }
    }))

    try {
      const res = await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: signalId, inferred_client: clientName }),
      })
      if (!res.ok) {
        console.error('[UpdateClient] PATCH failed:', res.status)
        fetchSignals()
      }
    } catch (err) {
      console.error('[UpdateClient] Error:', err)
      fetchSignals()
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

  const saveRepName = (name) => {
    setRepName(name)
    localStorage.setItem('biosignal_rep_name', name)
    document.cookie = `biosignal_rep_name=${encodeURIComponent(name)}; path=/`
    setShowNameModal(false)
  }

  const updateLeadStatus = async (leadId, newStatus) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus } : l))
    try {
      await fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: leadId, status: newStatus }),
      })
    } catch (err) {
      console.error('Error updating lead status:', err)
      fetchLeads()
    }
  }

  const updateLeadNotes = async (leadId, noteText) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, notes: noteText } : l))
    try {
      await fetch('/api/leads', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: leadId, notes: noteText }),
      })
    } catch (err) {
      console.error('Error updating lead notes:', err)
      fetchLeads()
    }
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
          onRefresh={fetchSignals}
          onRunAgents={runAgents}
          onShowNameModal={() => setShowNameModal(true)}
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
                  onUpdateClient={updateInferredClient}
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
                  leads={leads}
                  repName={repName}
                  showAllLeads={showAllLeads}
                  onToggleShowAll={() => setShowAllLeads(prev => !prev)}
                  onUpdateStatus={updateLeadStatus}
                  onUpdateNotes={updateLeadNotes}
                  onUpdateClient={updateInferredClient}
                />
              )}
              {activePage === 'clinical_new' && <ClinicalTrialsNewPage />}
              {activePage === 'ma_funding_new' && <MAFundingNewPage />}
              {activePage === 'funding_new' && <FundingNewPage />}
              {activePage === 'madison_leads' && <MadisonLeadsPage />}
              {activePage === 'buyers'     && <PastBuyersPage />}
              {activePage === 'candidates' && <PastCandidatesPage />}
              {activePage === 'contacts'   && <OtherContactsPage />}
              {activePage === 'settings'   && <SettingsPage />}
            </>
          )}
        </main>
      </div>

      {/* Name modal — shown on first visit or when clicking name */}
      {showNameModal && (
        <NameModal onSave={saveRepName} />
      )}

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
