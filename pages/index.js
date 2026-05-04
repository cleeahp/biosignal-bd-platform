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

const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const s = String(dateStr).trim()
  if (!s) return '—'
  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDateOnly) {
    const monthIdx = parseInt(isoDateOnly[2], 10) - 1
    if (monthIdx >= 0 && monthIdx <= 11) {
      return `${SHORT_MONTH_NAMES[monthIdx]} ${parseInt(isoDateOnly[3], 10)}, ${isoDateOnly[1]}`
    }
  }
  const isoDateTime = s.match(/^(\d{4})-(\d{2})-(\d{2})T/)
  if (isoDateTime && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const monthIdx = parseInt(isoDateTime[2], 10) - 1
    if (monthIdx >= 0 && monthIdx <= 11) {
      return `${SHORT_MONTH_NAMES[monthIdx]} ${parseInt(isoDateTime[3], 10)}, ${isoDateTime[1]}`
    }
  }
  const d = new Date(s)
  if (!isNaN(d)) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return s
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

// ─── Date Column Sort + Hierarchical Filter ──────────────────────────────────

const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const NO_DATE_KEY = '__none__'

function parseDateValue(raw) {
  if (!raw) return null
  if (raw instanceof Date) return isNaN(raw) ? null : raw
  const s = String(raw).trim()
  if (!s) return null
  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDateOnly) {
    const dt = new Date(parseInt(isoDateOnly[1], 10), parseInt(isoDateOnly[2], 10) - 1, parseInt(isoDateOnly[3], 10))
    return isNaN(dt) ? null : dt
  }
  for (const c of [s, s.replace(/\s+at\s+/i, ' ')]) {
    const d = new Date(c)
    if (!isNaN(d)) return d
  }
  return null
}

function formatDayKey(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function formatDayLabel(y, m, d) {
  return `${MONTH_NAMES_FULL[m - 1]} ${d}, ${y}`
}

function toYearMonthDay(raw) {
  const d = parseDateValue(raw)
  if (!d) return null
  return formatDayKey(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

function useDateColumn() {
  const [sortDir, setSortDir] = useState(null) // null | 'desc' | 'asc'
  const [dateFilter, setDateFilter] = useState([])

  const cycleSortDir = useCallback(() => {
    setSortDir(cur => (cur === null ? 'desc' : cur === 'desc' ? 'asc' : null))
  }, [])

  const clearDateFilter = useCallback(() => setDateFilter([]), [])

  const hasDateFilter = dateFilter.length > 0

  return { sortDir, cycleSortDir, dateFilter, setDateFilter, hasDateFilter, clearDateFilter }
}

function IndeterminateCheckbox({ state, onChange }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'indeterminate'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      onChange={onChange}
      onClick={e => e.stopPropagation()}
      className="rounded border-gray-600 bg-[#111827] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
    />
  )
}

function HierarchicalDateFilter({ label, sortDir, onCycleSort, allRawDates, activeDateKeys, onApplyFilter, className = '' }) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set(activeDateKeys || []))
  const [expandedYears, setExpandedYears] = useState(new Set())
  const [expandedMonths, setExpandedMonths] = useState(new Set())
  const thRef = useRef(null)
  const filterBtnRef = useRef(null)
  const dropdownRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const hasFilter = activeDateKeys && activeDateKeys.length > 0

  useEffect(() => {
    setSelected(new Set(activeDateKeys || []))
  }, [activeDateKeys])

  // Build full tree from all raw dates: Map<year, Map<month, Set<day>>>
  const tree = useMemo(() => {
    const years = new Map()
    let hasNone = false
    for (const raw of allRawDates || []) {
      const d = parseDateValue(raw)
      if (!d) { hasNone = true; continue }
      const y = d.getFullYear()
      const m = d.getMonth() + 1
      const day = d.getDate()
      if (!years.has(y)) years.set(y, new Map())
      const months = years.get(y)
      if (!months.has(m)) months.set(m, new Set())
      months.get(m).add(day)
    }
    return { years, hasNone }
  }, [allRawDates])

  // All leaf keys (day keys + NO_DATE_KEY) — used for Select All
  const allLeafKeys = useMemo(() => {
    const keys = []
    for (const [y, months] of tree.years) {
      for (const [m, days] of months) {
        for (const d of days) keys.push(formatDayKey(y, m, d))
      }
    }
    if (tree.hasNone) keys.push(NO_DATE_KEY)
    return keys
  }, [tree])

  // Precompute, for each year and month, the list of day keys (used for checkbox state + toggles)
  const daysByYear = useMemo(() => {
    const map = new Map()
    for (const [y, months] of tree.years) {
      const keys = []
      for (const [m, days] of months) {
        for (const d of days) keys.push(formatDayKey(y, m, d))
      }
      map.set(y, keys)
    }
    return map
  }, [tree])

  const daysByMonth = useMemo(() => {
    const map = new Map()
    for (const [y, months] of tree.years) {
      for (const [m, days] of months) {
        const keys = [...days].map(d => formatDayKey(y, m, d))
        map.set(`${y}-${m}`, keys)
      }
    }
    return map
  }, [tree])

  // Derive checkbox state from selection (for the full, non-searched tree — so toggling "Select All" of a partially-filtered view still reflects correctly at the top level)
  const tripleState = (keys) => {
    if (!keys || keys.length === 0) return 'unchecked'
    let allIn = true, anyIn = false
    for (const k of keys) {
      if (selected.has(k)) anyIn = true
      else allIn = false
      if (anyIn && !allIn) break
    }
    if (allIn) return 'checked'
    if (anyIn) return 'indeterminate'
    return 'unchecked'
  }

  const yearState = (y) => tripleState(daysByYear.get(y))
  const monthState = (y, m) => tripleState(daysByMonth.get(`${y}-${m}`))

  // Filtered tree based on search (search matches year number, month name, or day label)
  const filteredTree = useMemo(() => {
    if (!search) return tree
    const q = search.toLowerCase()
    const years = new Map()
    for (const [y, months] of tree.years) {
      const yLabel = String(y)
      const keepYearEntirely = yLabel.includes(q)
      const matchedMonths = new Map()
      for (const [m, days] of months) {
        const mLabel = MONTH_NAMES_FULL[m - 1].toLowerCase()
        const keepMonthEntirely = keepYearEntirely || mLabel.includes(q)
        const matchedDays = new Set()
        for (const day of days) {
          if (keepMonthEntirely) {
            matchedDays.add(day)
          } else {
            const label = formatDayLabel(y, m, day).toLowerCase()
            if (label.includes(q)) matchedDays.add(day)
          }
        }
        if (matchedDays.size > 0) matchedMonths.set(m, matchedDays)
      }
      if (matchedMonths.size > 0) years.set(y, matchedMonths)
    }
    const hasNone = tree.hasNone && ('no date'.includes(q) || 'none'.includes(q))
    return { years, hasNone }
  }, [tree, search])

  const sortedYears = useMemo(() => [...filteredTree.years.keys()].sort((a, b) => b - a), [filteredTree])

  const sortedMonthsFor = useCallback((y) => {
    const months = filteredTree.years.get(y)
    if (!months) return []
    return [...months.keys()].sort((a, b) => b - a)
  }, [filteredTree])

  const sortedDaysFor = useCallback((y, m) => {
    const months = filteredTree.years.get(y)
    if (!months || !months.has(m)) return []
    return [...months.get(m)].sort((a, b) => b - a)
  }, [filteredTree])

  // Toggle handlers
  const toggleYear = (y) => {
    const keys = daysByYear.get(y) || []
    const state = yearState(y)
    setSelected(prev => {
      const next = new Set(prev)
      if (state === 'checked') {
        for (const k of keys) next.delete(k)
      } else {
        for (const k of keys) next.add(k)
      }
      return next
    })
  }

  const toggleMonth = (y, m) => {
    const keys = daysByMonth.get(`${y}-${m}`) || []
    const state = monthState(y, m)
    setSelected(prev => {
      const next = new Set(prev)
      if (state === 'checked') {
        for (const k of keys) next.delete(k)
      } else {
        for (const k of keys) next.add(k)
      }
      return next
    })
  }

  const toggleDay = (y, m, d) => {
    const k = formatDayKey(y, m, d)
    setSelected(prev => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
  }

  const toggleNone = () => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(NO_DATE_KEY) ? next.delete(NO_DATE_KEY) : next.add(NO_DATE_KEY)
      return next
    })
  }

  const toggleYearExpand = (y) => {
    setExpandedYears(prev => {
      const next = new Set(prev)
      next.has(y) ? next.delete(y) : next.add(y)
      return next
    })
  }

  const toggleMonthExpand = (y, m) => {
    const key = `${y}-${m}`
    setExpandedMonths(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(allLeafKeys))
  const clearLocal = () => setSelected(new Set())

  const openDropdown = (e) => {
    e.stopPropagation()
    if (filterBtnRef.current) {
      const rect = filterBtnRef.current.getBoundingClientRect()
      const width = 288
      setPos({
        top: rect.bottom + 4,
        left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)),
      })
    }
    setSearch('')
    setExpandedYears(new Set())
    setExpandedMonths(new Set())
    setIsOpen(true)
  }

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) && filterBtnRef.current && !filterBtnRef.current.contains(e.target)) {
        onApplyFilter([...selected])
        setIsOpen(false)
      }
    }
    const handleKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        onApplyFilter([...selected])
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isOpen, selected, onApplyFilter])

  const sortArrow = sortDir === 'desc' ? '▼' : sortDir === 'asc' ? '▲' : null
  const nothingToShow = sortedYears.length === 0 && !filteredTree.hasNone

  return (
    <>
      <th
        ref={thRef}
        onClick={onCycleSort}
        className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#1a2234] whitespace-nowrap cursor-pointer hover:text-gray-200 select-none ${className}`}
      >
        <span className="inline-flex items-center gap-1.5">
          {label}
          {sortArrow && <span className="text-blue-400">{sortArrow}</span>}
          {hasFilter && <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />}
          <button
            ref={filterBtnRef}
            type="button"
            onClick={openDropdown}
            className="ml-0.5 text-gray-500 hover:text-white focus:outline-none"
            aria-label="Filter by date"
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 01.78 1.625L12 11.25V16a1 1 0 01-1.447.894l-2-1A1 1 0 018 15v-3.75L3.22 5.625A1 1 0 013 5z" clipRule="evenodd" />
            </svg>
          </button>
        </span>
      </th>
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000 }}
          className="w-72 bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          <div className="p-2 border-b border-[#374151] flex flex-col gap-2">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="w-full bg-[#111827] border border-[#374151] rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center gap-3 text-xs">
              <button onClick={selectAll} className="text-blue-400 hover:text-blue-300">Select All</button>
              <button onClick={clearLocal} className="text-gray-400 hover:text-white">Clear All</button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {nothingToShow && (
              <p className="text-xs text-gray-500 px-3 py-2">No values</p>
            )}
            {sortedYears.map(y => {
              const isYExpanded = expandedYears.has(y) || !!search
              const yState = yearState(y)
              return (
                <div key={y}>
                  <div
                    className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#374151] text-xs text-gray-200"
                    style={{ paddingLeft: 8 }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleYearExpand(y)}
                      className="w-3 text-gray-500 hover:text-white text-[10px] leading-none"
                      aria-label={isYExpanded ? 'Collapse' : 'Expand'}
                    >
                      {isYExpanded ? '▼' : '▶'}
                    </button>
                    <IndeterminateCheckbox state={yState} onChange={() => toggleYear(y)} />
                    <span
                      className="truncate cursor-pointer select-none flex-1 font-medium"
                      onClick={() => toggleYearExpand(y)}
                    >
                      {y}
                    </span>
                  </div>
                  {isYExpanded && sortedMonthsFor(y).map(m => {
                    const mkey = `${y}-${m}`
                    const isMExpanded = expandedMonths.has(mkey) || !!search
                    const mState = monthState(y, m)
                    return (
                      <div key={mkey}>
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#374151] text-xs text-gray-300"
                          style={{ paddingLeft: 24 }}
                        >
                          <button
                            type="button"
                            onClick={() => toggleMonthExpand(y, m)}
                            className="w-3 text-gray-500 hover:text-white text-[10px] leading-none"
                            aria-label={isMExpanded ? 'Collapse' : 'Expand'}
                          >
                            {isMExpanded ? '▼' : '▶'}
                          </button>
                          <IndeterminateCheckbox state={mState} onChange={() => toggleMonth(y, m)} />
                          <span
                            className="truncate cursor-pointer select-none flex-1"
                            onClick={() => toggleMonthExpand(y, m)}
                          >
                            {MONTH_NAMES_FULL[m - 1]}
                          </span>
                        </div>
                        {isMExpanded && sortedDaysFor(y, m).map(day => {
                          const dKey = formatDayKey(y, m, day)
                          return (
                            <label
                              key={dKey}
                              className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#374151] cursor-pointer text-xs text-gray-400"
                              style={{ paddingLeft: 40 }}
                            >
                              <input
                                type="checkbox"
                                checked={selected.has(dKey)}
                                onChange={() => toggleDay(y, m, day)}
                                className="rounded border-gray-600 bg-[#111827] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                              />
                              <span className="truncate">{formatDayLabel(y, m, day)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {filteredTree.hasNone && (
              <label
                className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#374151] cursor-pointer text-xs text-gray-300"
                style={{ paddingLeft: 8 }}
              >
                <span className="w-3" />
                <input
                  type="checkbox"
                  checked={selected.has(NO_DATE_KEY)}
                  onChange={toggleNone}
                  className="rounded border-gray-600 bg-[#111827] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
                <span className="truncate">No Date</span>
              </label>
            )}
          </div>
          <div className="p-2 border-t border-[#374151] flex justify-between">
            <button
              onClick={() => { setSelected(new Set()); onApplyFilter([]); setIsOpen(false) }}
              className="text-xs text-gray-400 hover:text-white"
            >
              Clear
            </button>
            <button
              onClick={() => { onApplyFilter([...selected]); setIsOpen(false) }}
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

function filterRowsByDateKeys(rows, getRawDate, selectedKeys) {
  if (!selectedKeys || selectedKeys.length === 0) return rows
  const set = new Set(selectedKeys)
  return rows.filter(r => {
    const ymd = toYearMonthDay(getRawDate(r))
    return set.has(ymd || NO_DATE_KEY)
  })
}

function sortRowsByDate(rows, getRawDate, sortDir) {
  if (!sortDir) return rows
  const arr = [...rows]
  const mul = sortDir === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    const da = parseDateValue(getRawDate(a))
    const db = parseDateValue(getRawDate(b))
    const ta = da ? da.getTime() : 0
    const tb = db ? db.getTime() : 0
    return (ta - tb) * mul
  })
  return arr
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
    case 'file-text':
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="16" y2="17"/>
          <line x1="8" y1="9" x2="10" y2="9"/>
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
  { key: 'dashboard',      label: 'Company Dashboard',      icon: 'grid' },
  { key: 'madison_leads',  label: 'Madison Leads',          icon: 'clipboard', countKey: 'madison_leads' },
  { key: 'jim_leads',      label: 'Jim Leads',              icon: 'clipboard', countKey: 'jim_leads' },
  { key: 'tim_leads',      label: 'Tim Leads',              icon: 'clipboard', countKey: 'tim_leads' },
  { key: 'clinical_new',   label: 'Clinical Trials',        icon: 'flask',     countKey: 'clinical_new' },
  { key: 'ma_funding_new', label: 'M&A',                    icon: 'trending',  countKey: 'ma_funding_new' },
  { key: 'funding_new',    label: 'Funding',                icon: 'dollar',    countKey: 'funding_new' },
  { key: 'jobs_new',       label: 'Jobs',                   icon: 'briefcase', countKey: 'jobs_new' },
  { key: 'competitor_jobs_new', label: 'Competitor Jobs',   icon: 'users',     countKey: 'competitor_jobs_new' },
  { key: 'news',           label: 'News',                   icon: 'file-text', countKey: 'news' },
  { key: 'buyers',         label: 'Past Buyers',            icon: 'users' },
  { key: 'candidates',     label: 'Past Candidates',        icon: 'user' },
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
  dashboard:       'Company Dashboard',
  madison_leads:   'Madison Leads',
  jim_leads:       'Jim Leads',
  tim_leads:       'Tim Leads',
  clinical_new:    'Clinical Trials',
  ma_funding_new:  'M&A',
  funding_new:     'Funding',
  jobs_new:        'Jobs',
  competitor_jobs_new: 'Competitor Jobs',
  news:            'News',
  buyers:          'Past Buyers',
  candidates:      'Past Candidates',
  settings:        'Settings',
}

function TopBar({ activePage, repName, onShowNameModal }) {
  return (
    <div className="bg-[#1f2937] border-b border-[#374151] px-6 py-3 flex items-center justify-between gap-4 sticky top-0 z-30">
      {/* Page title */}
      <h1 className="text-base font-semibold text-white truncate">
        {PAGE_TITLES[activePage] || activePage}
      </h1>

      {/* Right actions */}
      <div className="flex items-center gap-2 shrink-0">
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

// ─── Company Dashboard ────────────────────────────────────────────────────────

function usePastClientChecker(pastClients) {
  const matchedSet = useMemo(
    () => new Set((pastClients || []).map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())),
    [pastClients],
  )
  const nameSet = useMemo(
    () => new Set((pastClients || []).map(c => c.name).filter(Boolean).map(n => n.toLowerCase())),
    [pastClients],
  )
  return useCallback(name => {
    if (!name) return false
    const lower = String(name).toLowerCase()
    return matchedSet.has(lower) || nameSet.has(lower)
  }, [matchedSet, nameSet])
}

function AddToLeadsButton({ companyName }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [status, setStatus] = useState('idle') // idle | pending | added | duplicate | error
  const btnRef = useRef(null)
  const dropdownRef = useRef(null)
  const resetTimerRef = useRef(null)

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        btnRef.current && !btnRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const handleOpen = (e) => {
    e.stopPropagation()
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({
        top: rect.bottom + 4,
        left: Math.max(4, Math.min(rect.left, window.innerWidth - 220)),
      })
    }
    setOpen(true)
  }

  const setTransientStatus = (next) => {
    setStatus(next)
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => setStatus('idle'), 2000)
  }

  const submit = async (route, e) => {
    e.stopPropagation()
    setOpen(false)
    setStatus('pending')
    try {
      const res = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: companyName }),
      })
      if (res.ok) {
        setTransientStatus('added')
        return
      }
      const body = await res.json().catch(() => ({}))
      const msg = String(body.error || '').toLowerCase()
      if (msg.includes('duplicate') || msg.includes('unique')) {
        setTransientStatus('duplicate')
      } else {
        setTransientStatus('error')
      }
    } catch {
      setTransientStatus('error')
    }
  }

  let label = '+'
  let title = 'Add to leads'
  let className = 'text-gray-400 hover:text-blue-300 hover:bg-blue-600/20'
  if (status === 'pending') { label = '…'; title = 'Adding…'; className = 'text-gray-400' }
  else if (status === 'added') { label = '✓'; title = 'Added'; className = 'text-green-400 bg-green-600/20' }
  else if (status === 'duplicate') { label = '✓'; title = 'Already added'; className = 'text-amber-400 bg-amber-600/20' }
  else if (status === 'error') { label = '!'; title = 'Failed to add'; className = 'text-red-400 bg-red-600/20' }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title={title}
        className={`shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-xs font-bold leading-none transition-colors ${className}`}
      >
        {label}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000 }}
          className="w-52 bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl py-1"
        >
          <button
            onClick={e => submit('/api/madison-leads', e)}
            className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors"
          >
            Add to Madison Leads
          </button>
          <button
            onClick={e => submit('/api/jim-leads', e)}
            className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors"
          >
            Add to Jim Leads
          </button>
          <button
            onClick={e => submit('/api/tim-leads', e)}
            className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors"
          >
            Add to Tim Leads
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

function NewCountBadge({ value }) {
  if (!value || value <= 0) return null
  return <span className="ml-1.5 text-green-400 text-xs font-semibold tabular-nums">↑{value}</span>
}

function CompanyRankingTable({ companies, pastClients, summary, onSelect, onRefresh, refreshing }) {
  const [sortKey, setSortKey] = useState('total_count')
  const [sortDir, setSortDir] = useState('desc')
  const [signalView, setSignalView] = useState('all') // 'all' | 'new'
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const isPastClient = usePastClientChecker(pastClients)

  const extractors = useMemo(() => ({
    company: c => c.company_name || '',
  }), [])

  const allValues = useMemo(() => ({
    company: companies.map(c => c.company_name || ''),
  }), [companies])

  const cycleSort = key => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('desc')
      return
    }
    if (sortDir === 'desc') {
      setSortKey('total_count')
      setSortDir('desc')
    } else {
      setSortDir('desc')
    }
  }

  const sorted = useMemo(() => {
    const arr = [...companies]
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
      const diff = bv - av
      if (diff !== 0) return sortDir === 'desc' ? diff : -diff
      return (a.company_name || '').localeCompare(b.company_name || '')
    })
    return arr
  }, [companies, sortKey, sortDir])

  const filtered = useMemo(() => {
    const colFiltered = applyFilters(sorted, extractors)
    return signalView === 'new'
      ? colFiltered.filter(r => (r.total_new || 0) > 0)
      : colFiltered
  }, [sorted, applyFilters, extractors, signalView])

  const SortableTh = ({ colKey, label, className }) => {
    const active = sortKey === colKey
    const arrow = active ? (sortDir === 'desc' ? '▼' : '▲') : ''
    return (
      <th
        onClick={() => cycleSort(colKey)}
        className={`px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider bg-[#1a2234] cursor-pointer select-none whitespace-nowrap ${active ? 'text-blue-300' : 'text-gray-400 hover:text-gray-200'} ${className}`}
      >
        <span className="inline-flex items-center gap-1.5 justify-end">
          {label}
          {active && <span className="text-[10px]">{arrow}</span>}
        </span>
      </th>
    )
  }

  const stat = summary || { total_companies: 0, total_signals: 0, total_new_signals: 0 }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-[#1f2937] border border-[#374151] rounded-lg px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-gray-500">Companies</div>
          <div className="text-2xl font-bold text-white tabular-nums">{stat.total_companies.toLocaleString()}</div>
        </div>
        <div className="bg-[#1f2937] border border-[#374151] rounded-lg px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-gray-500">Total Signals</div>
          <div className="text-2xl font-bold text-white tabular-nums">{stat.total_signals.toLocaleString()}</div>
        </div>
        <div className="bg-[#1f2937] border border-[#374151] rounded-lg px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-gray-500">New Signals (Yesterday)</div>
          <div className="text-2xl font-bold text-green-400 tabular-nums">↑{stat.total_new_signals.toLocaleString()}</div>
        </div>
      </div>

      {onRefresh && (
        <div className="flex justify-end">
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-wait font-medium"
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border border-[#374151] overflow-hidden">
          <button
            onClick={() => setSignalView('all')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
              signalView === 'all'
                ? 'bg-blue-600/30 text-blue-300'
                : 'bg-[#1f2937] text-gray-400 hover:text-white hover:bg-[#263045]'
            }`}
          >
            All Signals
          </button>
          <button
            onClick={() => setSignalView('new')}
            className={`px-3 py-1.5 text-xs font-semibold border-l border-[#374151] transition-colors ${
              signalView === 'new'
                ? 'bg-green-600/30 text-green-300'
                : 'bg-[#1f2937] text-gray-400 hover:text-white hover:bg-[#263045]'
            }`}
          >
            New Signals
          </button>
        </div>
        <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      </div>

      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <SortableTh colKey="clinical_trials_count" label="Clinical Trials" className="w-[15%]" />
              <SortableTh colKey="ma_count" label="M&A" className="w-[15%]" />
              <SortableTh colKey="funding_count" label="Funding" className="w-[15%]" />
              <SortableTh colKey="news_count" label="News" className="w-[15%]" />
              <SortableTh colKey="total_count" label="Total" className="w-[10%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">{signalView === 'new' ? 'No companies with new signals from yesterday.' : 'No companies with signals yet.'}</p></td></tr>
            ) : filtered.map((row, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const isClient = isPastClient(row.company_name)
              return (
                <tr
                  key={row.company_name}
                  onClick={() => onSelect(row.company_name)}
                  className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                >
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    <span className="inline-flex items-start gap-2">
                      <AddToLeadsButton companyName={row.company_name} />
                      <span>
                        {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                        {row.company_name}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 text-right tabular-nums">
                    {row.clinical_trials_count}<NewCountBadge value={row.clinical_trials_new} />
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 text-right tabular-nums">
                    {row.ma_count}<NewCountBadge value={row.ma_new} />
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 text-right tabular-nums">
                    {row.funding_count}<NewCountBadge value={row.funding_new} />
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 text-right tabular-nums">
                    {row.news_count}<NewCountBadge value={row.news_new} />
                  </td>
                  <td className="px-3 py-3 text-sm text-white text-right tabular-nums font-bold">
                    {row.total_count}<NewCountBadge value={row.total_new} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Section components for the per-company drilldown ─────────────────────────

function TrialsSection({ trials, pastClients }) {
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  const isPastClient = usePastClientChecker(pastClients)
  const getDisplayName = useCallback(t => t.matched_name || t.lead_sponsor_name || '', [])
  const getCategory = useCallback(t => {
    const drug = t.is_fda_regulated_drug
    const device = t.is_fda_regulated_device
    if (drug && device) return 'Drug / Device'
    if (drug) return 'Drug'
    if (device) return 'Device'
    return ''
  }, [])

  const toggleRow = useCallback(id => {
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const extractors = useMemo(() => ({
    nct_id: t => t.nct_id || '',
    company: t => getDisplayName(t),
    title: t => t.brief_title || '',
    phase: t => t.phase || '',
    category: t => getCategory(t),
  }), [getDisplayName, getCategory])

  const allValues = useMemo(() => ({
    nct_id: trials.map(t => t.nct_id || ''),
    company: trials.map(t => getDisplayName(t)),
    title: trials.map(t => t.brief_title || ''),
    phase: trials.map(t => t.phase || ''),
    category: trials.map(t => getCategory(t)),
  }), [trials, getDisplayName, getCategory])

  const allRawDates = useMemo(() => trials.map(t => t.study_start_date), [trials])
  const getRawDate = useCallback(t => t.study_start_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...trials]
    arr.sort((a, b) => {
      const da = parseDateValue(a.study_start_date)?.getTime() || 0
      const db = parseDateValue(b.study_start_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [trials])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={allValues.nct_id} activeValues={filters.nct_id} onApply={setFilter} className="w-[12%]" />
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[22%]" />
              <ColumnFilterDropdown colKey="title" label="Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="phase" label="Phase" allValues={allValues.phase} activeValues={filters.phase} onApply={setFilter} className="w-[10%]" />
              <ColumnFilterDropdown colKey="category" label="Category" allValues={allValues.category} activeValues={filters.category} onApply={setFilter} className="w-[12%]" />
              <HierarchicalDateFilter label="Start Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[14%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((trial, i) => {
              const rowKey = trial.id || trial.nct_id
              const isExpanded = expandedRows.has(rowKey)
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(trial)
              const isClient = isPastClient(displayName)
              const category = getCategory(trial)
              const contacts = Array.isArray(trial.central_contacts) ? trial.central_contacts : []
              return (
                <Fragment key={rowKey}>
                  <tr
                    onClick={() => toggleRow(rowKey)}
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
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(trial.study_start_date)}</td>
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
  )
}

function FilingsSection({ filings, pastClients }) {
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  const isPastClient = usePastClientChecker(pastClients)
  const getDisplayName = useCallback(f => f.matched_name || f.company_name || '', [])

  const toggleRow = useCallback(id => {
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const extractors = useMemo(() => ({
    company: f => getDisplayName(f),
    transaction: f => f._transaction || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: filings.map(f => getDisplayName(f)),
    transaction: filings.map(f => f._transaction || ''),
  }), [filings, getDisplayName])

  const allRawDates = useMemo(() => filings.map(f => f.filing_date), [filings])
  const getRawDate = useCallback(f => f.filing_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...filings]
    arr.sort((a, b) => {
      const da = parseDateValue(a.filing_date)?.getTime() || 0
      const db = parseDateValue(b.filing_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [filings])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={allValues.transaction} activeValues={filters.transaction} onApply={setFilter} className="w-[20%]" />
              <HierarchicalDateFilter label="Filing Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[20%]" />
              <Th className="w-[30%]">Filing Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((filing, i) => {
              const rowKey = filing.id || filing.accession_number
              const isExpanded = expandedRows.has(rowKey)
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(filing)
              const isClient = isPastClient(displayName)
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
  )
}

function FundingSection({ projects, pastClients }) {
  const [expandedRows, setExpandedRows] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  const isPastClient = usePastClientChecker(pastClients)
  const getDisplayName = useCallback(p => p.matched_name || '', [])

  const toggleRow = useCallback(id => {
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const extractors = useMemo(() => ({
    company: p => getDisplayName(p),
    title: p => p.project_title || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: projects.map(p => getDisplayName(p)),
    title: projects.map(p => p.project_title || ''),
  }), [projects, getDisplayName])

  const allRawDates = useMemo(() => projects.map(p => p.award_notice_date), [projects])
  const getRawDate = useCallback(p => p.award_notice_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...projects]
    arr.sort((a, b) => {
      const da = parseDateValue(a.award_notice_date)?.getTime() || 0
      const db = parseDateValue(b.award_notice_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [projects])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="title" label="Project Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <Th className="w-[15%]">Award</Th>
              <HierarchicalDateFilter label="Award Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[10%]" />
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
              const isClient = isPastClient(displayName)
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
  )
}

function NewsSection({ articles, pastClients }) {
  const { filters, setFilter, clearAll, hasActiveFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  const isPastClient = usePastClientChecker(pastClients)

  const allValues = useMemo(() => {
    const companySet = new Set()
    for (const a of articles) {
      if (Array.isArray(a.matched_names)) {
        for (const n of a.matched_names) if (n) companySet.add(n)
      }
    }
    return {
      company: [...companySet],
      title: articles.map(a => a.title || ''),
      source: articles.map(a => a._source || ''),
    }
  }, [articles])

  const allRawDates = useMemo(() => articles.map(a => a.date), [articles])
  const getRawDate = useCallback(a => a.date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...articles]
    arr.sort((a, b) => {
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        const da = parseDateValue(a.date)?.getTime() || 0
        const db = parseDateValue(b.date)?.getTime() || 0
        return db - da
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [articles])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => {
    const colFiltered = !hasActiveFilters ? sorted : sorted.filter(a => {
      for (const [colKey, allowedValues] of Object.entries(filters)) {
        if (!allowedValues || allowedValues.length === 0) continue
        const allowedLower = allowedValues.map(v => String(v).toLowerCase())
        if (colKey === 'company') {
          const names = Array.isArray(a.matched_names) ? a.matched_names : []
          if (!names.some(n => allowedLower.includes(String(n).toLowerCase()))) return false
        } else if (colKey === 'title') {
          if (!allowedLower.includes(String(a.title || '').toLowerCase())) return false
        } else if (colKey === 'source') {
          if (!allowedLower.includes(String(a._source || '').toLowerCase())) return false
        }
      }
      return true
    })
    return filterRowsByDateKeys(colFiltered, getRawDate, dateCol.dateFilter)
  }, [sorted, filters, hasActiveFilters, getRawDate, dateCol.dateFilter])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
              <ColumnFilterDropdown colKey="title" label="Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[35%]" />
              <HierarchicalDateFilter label="Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="source" label="Source" allValues={allValues.source} activeValues={filters.source} onApply={setFilter} className="w-[15%]" />
              <Th className="w-[15%]">Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((article, i) => {
              const rowKey = article.url
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const names = Array.isArray(article.matched_names) ? article.matched_names : []
              return (
                <tr key={rowKey} className={`${rowBg} transition-colors`}>
                  <td className="px-3 py-3 text-sm text-gray-200 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    <div className="flex flex-col gap-1">
                      {names.length === 0 && <span className="text-gray-600">—</span>}
                      {names.map(n => (
                        <span key={n} className="text-gray-100">
                          {isPastClient(n) && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                          {n}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{article.title || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{article.date ? formatDate(article.date) : '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{article._source || '—'}</td>
                  <td className="px-3 py-3 text-sm align-top">
                    {article.url ? (
                      <a href={article.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">Read Article &#8599;</a>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function JobsSection({ jobs, pastClients }) {
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  const isPastClient = usePastClientChecker(pastClients)
  const getDisplayName = useCallback(j => j.matched_name || j.company_name || '', [])

  const extractors = useMemo(() => ({
    company: j => getDisplayName(j),
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: jobs.map(j => getDisplayName(j)),
    title: jobs.map(j => j.job_title || ''),
    location: jobs.map(j => j.location || ''),
  }), [jobs, getDisplayName])

  const allRawDates = useMemo(() => jobs.map(j => j.date_posted), [jobs])
  const getRawDate = useCallback(j => j.date_posted, [])

  const defaultSorted = useMemo(() => {
    const arr = [...jobs]
    arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    return arr
  }, [jobs])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
              <ColumnFilterDropdown colKey="title" label="Job Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="location" label="Location" allValues={allValues.location} activeValues={filters.location} onApply={setFilter} className="w-[15%]" />
              <Th className="w-[10%]">Domain</Th>
              <HierarchicalDateFilter label="Date Posted" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[10%]" />
              <Th className="w-[15%]">Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((job, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(job)
              const isClient = isPastClient(displayName)
              return (
                <tr key={job.id} className={`${rowBg} transition-colors`}>
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                    {displayName || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.job_title || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.location || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.company_domain || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatClayDate(job.date_posted)}</td>
                  <td className="px-3 py-3 text-sm align-top">
                    {job.job_url ? (
                      <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Job &#8599;</a>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PastContactsSection({ rows, emailField, emptyLabel }) {
  const [expandedIds, setExpandedIds] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  const toggleRow = useCallback(id => {
    setExpandedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const extractors = useMemo(() => ({
    person_name: r => r.person_name || '',
    current_title: r => r.current_title || '',
    current_company: r => r.current_company || '',
    original_title: r => r.original_title || '',
    original_company: r => r.original_company || '',
    current_location: r => r.current_location || '',
  }), [])

  const allValues = useMemo(() => ({
    person_name: rows.map(r => r.person_name || ''),
    current_title: rows.map(r => r.current_title || ''),
    current_company: rows.map(r => r.current_company || ''),
    original_title: rows.map(r => r.original_title || ''),
    original_company: rows.map(r => r.original_company || ''),
    current_location: rows.map(r => r.current_location || ''),
  }), [rows])

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const aRank = pastBuyerCompanyChanged(a) ? 0 : pastBuyerRoleChanged(a) ? 1 : 2
      const bRank = pastBuyerCompanyChanged(b) ? 0 : pastBuyerRoleChanged(b) ? 1 : 2
      if (aRank !== bRank) return aRank - bRank
      return (a.person_name || '').localeCompare(b.person_name || '')
    })
    return arr
  }, [rows])

  const filtered = useMemo(() => applyFilters(sorted, extractors), [sorted, applyFilters, extractors])

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="person_name"      label="Full Name"        allValues={allValues.person_name}      activeValues={filters.person_name}      onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="current_title"    label="Current Role"     allValues={allValues.current_title}    activeValues={filters.current_title}    onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="current_company"  label="Current Company"  allValues={allValues.current_company}  activeValues={filters.current_company}  onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="original_title"   label="Former Role"      allValues={allValues.original_title}   activeValues={filters.original_title}   onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="original_company" label="Former Company"   allValues={allValues.original_company} activeValues={filters.original_company} onApply={setFilter} className="w-[13%]" />
              <ColumnFilterDropdown colKey="current_location" label="Current Location" allValues={allValues.current_location} activeValues={filters.current_location} onApply={setFilter} className="w-[13%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">{emptyLabel}</p></td></tr>
            ) : filtered.map((row, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const isExpanded = expandedIds.has(row.id)
              const companyChanged = pastBuyerCompanyChanged(row)
              const roleChanged = pastBuyerRoleChanged(row)
              const email = row[emailField]
              return (
                <Fragment key={row.id}>
                  <tr
                    onClick={() => toggleRow(row.id)}
                    className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.person_name || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_title || '—'}</span>
                        {roleChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
                            Role Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_company || '—'}</span>
                        {companyChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 whitespace-nowrap">
                            Company Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_title || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_company || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.current_location || '—'}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Email</span>
                            {email
                              ? <a href={`mailto:${email}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{email}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Phone</span>
                            {row.phone
                              ? <a href={`tel:${row.phone}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.phone}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1 sm:col-span-2">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">LinkedIn</span>
                            {row.linkedin_url
                              ? <a href={row.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{row.linkedin_url}</a>
                              : <span className="text-sm text-gray-500">—</span>}
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

function CompanyDetailView({ company, onBack }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/company-detail?company=${encodeURIComponent(company)}`)
      .then(r => r.json().then(d => ({ ok: r.ok, body: d })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Failed to load')
        setData(body)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [company])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-sm text-blue-400 hover:text-blue-300 font-medium px-3 py-1.5 rounded bg-blue-900/30 hover:bg-blue-900/50 transition-colors"
        >
          ← Back to Dashboard
        </button>
      </div>
      <h1 className="text-2xl font-bold text-white">{company}</h1>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}
      {!loading && !error && data && (
        <>
          {data.clinicalTrials.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">Clinical Trials ({data.clinicalTrials.length})</h2>
              <TrialsSection trials={data.clinicalTrials} pastClients={data.pastClients} />
            </div>
          )}
          {data.filings.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">M&A and Filings ({data.filings.length})</h2>
              <FilingsSection filings={data.filings} pastClients={data.pastClients} />
            </div>
          )}
          {data.fundingProjects.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">Funding Projects ({data.fundingProjects.length})</h2>
              <FundingSection projects={data.fundingProjects} pastClients={data.pastClients} />
            </div>
          )}
          {data.newsArticles.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">News ({data.newsArticles.length})</h2>
              <NewsSection articles={data.newsArticles} pastClients={data.pastClients} />
            </div>
          )}
          {data.jobs.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">Jobs ({data.jobs.length})</h2>
              <JobsSection jobs={data.jobs} pastClients={data.pastClients} />
            </div>
          )}
          {(data.pastBuyers || []).length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">Past Buyers ({data.pastBuyers.length})</h2>
              <PastContactsSection rows={data.pastBuyers} emailField="original_email" emptyLabel="No past buyers found." />
            </div>
          )}
          {(data.pastCandidates || []).length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-white text-base font-semibold">Past Candidates ({data.pastCandidates.length})</h2>
              <PastContactsSection rows={data.pastCandidates} emailField="email" emptyLabel="No past candidates found." />
            </div>
          )}
          {data.clinicalTrials.length === 0 && data.filings.length === 0 && data.fundingProjects.length === 0 && data.newsArticles.length === 0 && data.jobs.length === 0 && (data.pastBuyers || []).length === 0 && (data.pastCandidates || []).length === 0 && (
            <EmptyState message={`No signals found for ${company}.`} />
          )}
        </>
      )}
    </div>
  )
}

function CompanyDashboardPage() {
  const [companies, setCompanies] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState(null)

  const loadData = useCallback((forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true)
    else setLoading(true)
    const url = forceRefresh ? '/api/company-dashboard?refresh=true' : '/api/company-dashboard'
    fetch(url)
      .then(r => r.json())
      .then(data => {
        setCompanies(data.companies || [])
        setPastClients(data.pastClients || [])
        setSummary(data.summary || null)
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => { loadData(false) }, [loadData])

  if (selectedCompany) {
    return <CompanyDetailView company={selectedCompany} onBack={() => setSelectedCompany(null)} />
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <CompanyRankingTable
      companies={companies}
      pastClients={pastClients}
      summary={summary}
      onSelect={name => setSelectedCompany(name)}
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    />
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
  const dateCol = useDateColumn()

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

  const pastClientMatchedNames = useMemo(() => new Set(pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const pastClientNames = useMemo(() => new Set(pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])

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
    if (!name) return false
    if (pastClientMatchedNames.has(name)) return true
    return pastClientNames.has(name)
  }, [pastClientMatchedNames, pastClientNames, getDisplayName])

  const extractors = useMemo(() => ({
    nct_id: t => t.nct_id || '',
    company: t => getDisplayName(t),
    title: t => t.brief_title || '',
    phase: t => t.phase || '',
    category: t => getCategory(t),
  }), [getDisplayName, getCategory])

  const allValues = useMemo(() => ({
    nct_id: trials.map(t => t.nct_id || ''),
    company: trials.map(t => getDisplayName(t)),
    title: trials.map(t => t.brief_title || ''),
    phase: trials.map(t => t.phase || ''),
    category: trials.map(t => getCategory(t)),
  }), [trials, getDisplayName, getCategory])

  const allRawDates = useMemo(() => trials.map(t => t.study_start_date), [trials])
  const getRawDate = useCallback(t => t.study_start_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...trials]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = parseDateValue(a.study_start_date)?.getTime() || 0
      const db = parseDateValue(b.study_start_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [trials, isPastClient])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

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
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={allValues.nct_id} activeValues={filters.nct_id} onApply={setFilter} className="w-[12%]" />
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[22%]" />
              <ColumnFilterDropdown colKey="title" label="Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="phase" label="Phase" allValues={allValues.phase} activeValues={filters.phase} onApply={setFilter} className="w-[10%]" />
              <ColumnFilterDropdown colKey="category" label="Category" allValues={allValues.category} activeValues={filters.category} onApply={setFilter} className="w-[12%]" />
              <HierarchicalDateFilter label="Start Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[14%]" />
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
                      {formatDate(trial.study_start_date)}
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
  const dateCol = useDateColumn()

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

  const pastClientMatchedNames = useMemo(() => new Set(pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const pastClientNames = useMemo(() => new Set(pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])

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
    if (!name) return false
    if (pastClientMatchedNames.has(name)) return true
    return pastClientNames.has(name)
  }, [pastClientMatchedNames, pastClientNames, getDisplayName])

  const extractors = useMemo(() => ({
    company: f => getDisplayName(f),
    transaction: f => f._transaction || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: filings.map(f => getDisplayName(f)),
    transaction: filings.map(f => f._transaction || ''),
  }), [filings, getDisplayName])

  const allRawDates = useMemo(() => filings.map(f => f.filing_date), [filings])
  const getRawDate = useCallback(f => f.filing_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...filings]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = parseDateValue(a.filing_date)?.getTime() || 0
      const db = parseDateValue(b.filing_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [filings, isPastClient])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

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
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={allValues.transaction} activeValues={filters.transaction} onApply={setFilter} className="w-[20%]" />
              <HierarchicalDateFilter label="Filing Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[20%]" />
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
  const dateCol = useDateColumn()

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

  const pastClientMatchedNames = useMemo(() => new Set(pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const pastClientNames = useMemo(() => new Set(pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])

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
    if (!name) return false
    if (pastClientMatchedNames.has(name)) return true
    return pastClientNames.has(name)
  }, [pastClientMatchedNames, pastClientNames, getDisplayName])

  const extractors = useMemo(() => ({
    company: p => getDisplayName(p),
    title: p => p.project_title || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: projects.map(p => getDisplayName(p)),
    title: projects.map(p => p.project_title || ''),
  }), [projects, getDisplayName])

  const allRawDates = useMemo(() => projects.map(p => p.award_notice_date), [projects])
  const getRawDate = useCallback(p => p.award_notice_date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...projects]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const da = parseDateValue(a.award_notice_date)?.getTime() || 0
      const db = parseDateValue(b.award_notice_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [projects, isPastClient])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

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
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company Name" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="title" label="Project Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <Th className="w-[15%]">Award</Th>
              <HierarchicalDateFilter label="Award Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[10%]" />
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

// ─── Jobs - NEW Page ─────────────────────────────────────────────────────────

function formatClayDate(raw) {
  if (!raw) return '—'
  const s = String(raw).trim()
  if (!s) return '—'
  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDateOnly) {
    const monthIdx = parseInt(isoDateOnly[2], 10) - 1
    if (monthIdx >= 0 && monthIdx <= 11) {
      return `${SHORT_MONTH_NAMES[monthIdx]} ${parseInt(isoDateOnly[3], 10)}, ${isoDateOnly[1]}`
    }
  }
  const candidates = [s, s.replace(/\s+at\s+/i, ' ')]
  for (const c of candidates) {
    const d = new Date(c)
    if (!isNaN(d)) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }
  }
  return s
}

function JobsNewPage() {
  const [jobs, setJobs] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [loading, setLoading] = useState(true)
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  useEffect(() => {
    fetch('/api/jobs-new')
      .then(r => r.json())
      .then(data => {
        setJobs(data.jobs || [])
        setPastClients(data.pastClients || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const pastClientMatchedNames = useMemo(() => new Set(pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const pastClientNames = useMemo(() => new Set(pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])

  const getDisplayName = useCallback((j) => j.matched_name || j.company_name || '', [])

  const isPastClient = useCallback((j) => {
    const name = getDisplayName(j).toLowerCase()
    if (!name) return false
    if (pastClientMatchedNames.has(name)) return true
    return pastClientNames.has(name)
  }, [pastClientMatchedNames, pastClientNames, getDisplayName])

  const extractors = useMemo(() => ({
    company: j => getDisplayName(j),
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [getDisplayName])

  const allValues = useMemo(() => ({
    company: jobs.map(j => getDisplayName(j)),
    title: jobs.map(j => j.job_title || ''),
    location: jobs.map(j => j.location || ''),
  }), [jobs, getDisplayName])

  const allRawDates = useMemo(() => jobs.map(j => j.date_posted), [jobs])
  const getRawDate = useCallback(j => j.date_posted, [])

  const defaultSorted = useMemo(() => {
    const arr = [...jobs]
    arr.sort((a, b) => {
      const aPast = isPastClient(a) ? 1 : 0
      const bPast = isPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [jobs, isPastClient])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (jobs.length === 0) return <EmptyState message="No jobs found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
              <ColumnFilterDropdown colKey="title" label="Job Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="location" label="Location" allValues={allValues.location} activeValues={filters.location} onApply={setFilter} className="w-[15%]" />
              <Th className="w-[10%]">Domain</Th>
              <HierarchicalDateFilter label="Date Posted" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[10%]" />
              <Th className="w-[15%]">Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((job, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const displayName = getDisplayName(job)
              const isClient = isPastClient(job)
              return (
                <tr key={job.id} className={`${rowBg} transition-colors`}>
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                    {displayName || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.job_title || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.location || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.company_domain || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {formatClayDate(job.date_posted)}
                  </td>
                  <td className="px-3 py-3 text-sm align-top">
                    {job.job_url ? (
                      <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">
                        View Job &#8599;
                      </a>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Competitor Jobs - NEW Page ──────────────────────────────────────────────

function CompetitorJobsNewPage() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  useEffect(() => {
    fetch('/api/competitor-jobs-new')
      .then(r => r.json())
      .then(data => {
        setJobs(data.jobs || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const extractors = useMemo(() => ({
    company: j => j.company_name || '',
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [])

  const allValues = useMemo(() => ({
    company: jobs.map(j => j.company_name || ''),
    title: jobs.map(j => j.job_title || ''),
    location: jobs.map(j => j.location || ''),
  }), [jobs])

  const allRawDates = useMemo(() => jobs.map(j => j.date_posted), [jobs])
  const getRawDate = useCallback(j => j.date_posted, [])

  const defaultSorted = useMemo(() => {
    const arr = [...jobs]
    arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    return arr
  }, [jobs])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => (
    filterRowsByDateKeys(applyFilters(sorted, extractors), getRawDate, dateCol.dateFilter)
  ), [sorted, applyFilters, extractors, getRawDate, dateCol.dateFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (jobs.length === 0) return <EmptyState message="No competitor jobs found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
              <ColumnFilterDropdown colKey="title" label="Job Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[30%]" />
              <ColumnFilterDropdown colKey="location" label="Location" allValues={allValues.location} activeValues={filters.location} onApply={setFilter} className="w-[15%]" />
              <Th className="w-[10%]">Domain</Th>
              <HierarchicalDateFilter label="Date Posted" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[10%]" />
              <Th className="w-[15%]">Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((job, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              return (
                <tr key={job.id} className={`${rowBg} transition-colors`}>
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.company_name || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.job_title || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.location || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {job.company_domain || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {formatClayDate(job.date_posted)}
                  </td>
                  <td className="px-3 py-3 text-sm align-top">
                    {job.job_url ? (
                      <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">
                        View Job &#8599;
                      </a>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── News Page ───────────────────────────────────────────────────────────────

function AssignCompanyModal({ article, onClose, onSaved }) {
  const [selected, setSelected] = useState(() => {
    const names = Array.isArray(article.matched_names) ? article.matched_names : []
    return names.map(name => ({ name, alternate_name: '' }))
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchPos, setSearchPos] = useState({ top: 0, left: 0, width: 0 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const debounceRef = useRef(null)
  const searchRef = useRef(null)
  const dropdownRef = useRef(null)

  const hadExisting = Array.isArray(article.matched_names) && article.matched_names.length > 0

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = searchQuery.trim()
    if (q.length < 2) {
      setSearchResults([])
      setSearchOpen(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      fetch(`/api/company-search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(results => {
          setSearchResults(Array.isArray(results) ? results : [])
          setSearchOpen(true)
        })
        .catch(() => {})
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [searchQuery])

  useEffect(() => {
    if (!searchOpen) return
    const handleClick = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target)
        && searchRef.current && !searchRef.current.contains(e.target)
      ) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [searchOpen])

  useEffect(() => {
    if (!searchOpen) return
    const updatePos = () => {
      if (!searchRef.current) return
      const rect = searchRef.current.getBoundingClientRect()
      setSearchPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [searchOpen, searchResults])

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const addCompany = (name) => {
    setSelected(prev => prev.some(s => s.name === name) ? prev : [...prev, { name, alternate_name: '' }])
    setSearchQuery('')
    setSearchOpen(false)
  }

  const removeCompany = (name) => {
    setSelected(prev => prev.filter(s => s.name !== name))
  }

  const updateAlternateName = (name, value) => {
    setSelected(prev => prev.map(s => s.name === name ? { ...s, alternate_name: value } : s))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const alternateEntries = []
    for (const s of selected) {
      if (s.alternate_name === null || s.alternate_name === undefined) continue
      const trimmed = String(s.alternate_name).trim()
      if (trimmed.length < 1) continue
      alternateEntries.push({ directory_name: s.name, alternate_name: trimmed })
    }
    const body = {
      article_url: article.url,
      source_table: article.source_table,
      company_names: selected.map(s => s.name),
      alternate_entries: alternateEntries,
    }
    try {
      const response = await fetch('/api/news-company', {
        method: hadExisting ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error || `HTTP ${response.status}`)
      }
      onSaved(selected.map(s => s.name))
      onClose()
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const availableResults = searchResults.filter(r => !selected.some(s => s.name === r.name))

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-xl mx-4 bg-[#1f2937] border border-[#374151] rounded-lg shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between gap-4 p-4 border-b border-[#374151]">
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Assign Companies</h3>
            <p
              className="mt-1 text-sm text-gray-100 font-semibold"
              style={{ userSelect: 'text', cursor: 'text' }}
            >
              {article.title}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none shrink-0" aria-label="Close">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div ref={searchRef}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search companies..."
              className="w-full bg-[#111827] text-sm text-white px-3 py-2 rounded border border-[#374151] outline-none focus:border-blue-500 placeholder-gray-500"
            />
          </div>
          {searchOpen && availableResults.length > 0 && createPortal(
            <div
              ref={dropdownRef}
              style={{
                position: 'fixed',
                top: searchPos.top,
                left: searchPos.left,
                width: searchPos.width,
                zIndex: 1100,
              }}
              className="max-h-60 overflow-y-auto bg-[#111827] border border-[#374151] rounded shadow-2xl"
            >
              {availableResults.slice(0, 50).map(r => (
                <button
                  key={r.name}
                  onClick={() => addCompany(r.name)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors"
                >
                  {r.name}
                </button>
              ))}
            </div>,
            document.body,
          )}

          {selected.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No companies selected yet.</p>
          ) : (
            <div className="space-y-3">
              {selected.map(s => (
                <div key={s.name} className="bg-[#111827] rounded border border-[#374151] p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-sm font-semibold text-gray-100">{s.name}</span>
                    <button
                      onClick={() => removeCompany(s.name)}
                      className="text-gray-500 hover:text-red-400 text-base leading-none"
                      aria-label={`Remove ${s.name}`}
                    >
                      &times;
                    </button>
                  </div>
                  <input
                    type="text"
                    value={s.alternate_name}
                    onChange={e => updateAlternateName(s.name, e.target.value)}
                    placeholder="Alternate name (paste from title above)"
                    className="w-full bg-[#1f2937] text-sm text-gray-200 px-2 py-1.5 rounded border border-[#374151] outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="p-4 border-t border-[#374151] flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function NewsPage() {
  const [articles, setArticles] = useState([])
  const [pastClients, setPastClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [assignArticle, setAssignArticle] = useState(null)
  const { filters, setFilter, clearAll, hasActiveFilters } = useColumnFilters()
  const dateCol = useDateColumn()

  useEffect(() => {
    fetch('/api/news')
      .then(r => r.json())
      .then(data => {
        setArticles(data.articles || [])
        setPastClients(data.pastClients || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const pastClientMatchedNames = useMemo(() => new Set(pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const pastClientNames = useMemo(() => new Set(pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [pastClients])
  const isPastClientName = useCallback((name) => {
    if (!name) return false
    const lower = String(name).toLowerCase()
    if (pastClientMatchedNames.has(lower)) return true
    return pastClientNames.has(lower)
  }, [pastClientMatchedNames, pastClientNames])
  const articleHasPastClient = useCallback((a) => {
    const names = Array.isArray(a.matched_names) ? a.matched_names : []
    return names.some(isPastClientName)
  }, [isPastClientName])

  const allValues = useMemo(() => {
    const companySet = new Set()
    for (const a of articles) {
      if (Array.isArray(a.matched_names)) {
        for (const n of a.matched_names) if (n) companySet.add(n)
      }
    }
    return {
      company: [...companySet],
      title: articles.map(a => a.title || ''),
      source: articles.map(a => a._source || ''),
    }
  }, [articles])

  const allRawDates = useMemo(() => articles.map(a => a.date), [articles])
  const getRawDate = useCallback(a => a.date, [])

  const defaultSorted = useMemo(() => {
    const arr = [...articles]
    arr.sort((a, b) => {
      const aPast = articleHasPastClient(a) ? 1 : 0
      const bPast = articleHasPastClient(b) ? 1 : 0
      if (bPast !== aPast) return bPast - aPast
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        const da = parseDateValue(a.date)?.getTime() || 0
        const db = parseDateValue(b.date)?.getTime() || 0
        return db - da
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [articles, articleHasPastClient])

  const sorted = useMemo(() => (
    dateCol.sortDir === null ? defaultSorted : sortRowsByDate(defaultSorted, getRawDate, dateCol.sortDir)
  ), [defaultSorted, dateCol.sortDir, getRawDate])

  const filtered = useMemo(() => {
    const colFiltered = !hasActiveFilters ? sorted : sorted.filter(a => {
      for (const [colKey, allowedValues] of Object.entries(filters)) {
        if (!allowedValues || allowedValues.length === 0) continue
        const allowedLower = allowedValues.map(v => String(v).toLowerCase())
        if (colKey === 'company') {
          const names = Array.isArray(a.matched_names) ? a.matched_names : []
          if (!names.some(n => allowedLower.includes(String(n).toLowerCase()))) return false
        } else if (colKey === 'title') {
          if (!allowedLower.includes(String(a.title || '').toLowerCase())) return false
        } else if (colKey === 'source') {
          if (!allowedLower.includes(String(a._source || '').toLowerCase())) return false
        }
      }
      return true
    })
    return filterRowsByDateKeys(colFiltered, getRawDate, dateCol.dateFilter)
  }, [sorted, filters, hasActiveFilters, getRawDate, dateCol.dateFilter])

  const updateArticleMatches = useCallback((url, newMatches) => {
    setArticles(prev => prev.map(a =>
      a.url === url
        ? { ...a, matched_names: newMatches && newMatches.length > 0 ? newMatches : null }
        : a
    ))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (articles.length === 0) return <EmptyState message="No news articles found." />

  return (
    <div className="flex flex-col gap-2">
      <ClearAllFiltersButton
        hasActiveFilters={hasActiveFilters || dateCol.hasDateFilter}
        onClear={() => { clearAll(); dateCol.clearDateFilter() }}
      />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="company" label="Company" allValues={allValues.company} activeValues={filters.company} onApply={setFilter} className="w-[20%]" />
              <ColumnFilterDropdown colKey="title" label="Title" allValues={allValues.title} activeValues={filters.title} onApply={setFilter} className="w-[35%]" />
              <HierarchicalDateFilter label="Date" sortDir={dateCol.sortDir} onCycleSort={dateCol.cycleSortDir} allRawDates={allRawDates} activeDateKeys={dateCol.dateFilter} onApplyFilter={dateCol.setDateFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="source" label="Source" allValues={allValues.source} activeValues={filters.source} onApply={setFilter} className="w-[15%]" />
              <Th className="w-[15%]">Link</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {filtered.map((article, i) => {
              const rowKey = article.url
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const names = Array.isArray(article.matched_names) ? article.matched_names : []
              return (
                <tr key={rowKey} className={`${rowBg} transition-colors`}>
                  <td className="px-3 py-3 text-sm text-gray-200 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    <div className="flex flex-col gap-1">
                      {names.length === 0 && <span className="text-gray-600">—</span>}
                      {names.map(n => (
                        <span key={n} className="text-gray-100">
                          {isPastClientName(n) && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                          {n}
                        </span>
                      ))}
                      <button
                        onClick={() => setAssignArticle(article)}
                        className="self-start mt-1 text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:bg-blue-600/20 transition-colors"
                      >
                        {names.length > 0 ? 'Edit' : '+ Assign'}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {article.title || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {article.date ? formatDate(article.date) : '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                    {article._source || '—'}
                  </td>
                  <td className="px-3 py-3 text-sm align-top">
                    {article.url ? (
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 font-medium"
                      >
                        Read Article &#8599;
                      </a>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {assignArticle && (
        <AssignCompanyModal
          article={assignArticle}
          onClose={() => setAssignArticle(null)}
          onSaved={(newMatches) => updateArticleMatches(assignArticle.url, newMatches)}
        />
      )}
    </div>
  )
}

// ─── Madison Leads Page ──────────────────────────────────────────────────────

function MadisonLeadsPage() {
  const [data, setData] = useState({ trackedCompanies: [], clinicalTrials: [], filings: [], fundingProjects: [], newsArticles: [], clayJobs: [], pastClients: [] })
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedTrialRows, setExpandedTrialRows] = useState(new Set())
  const [expandedFilingRows, setExpandedFilingRows] = useState(new Set())
  const [expandedFundingRows, setExpandedFundingRows] = useState(new Set())
  const [assignArticle, setAssignArticle] = useState(null)
  const searchRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceRef = useRef(null)

  const trialsFilter = useColumnFilters()
  const filingsFilter = useColumnFilters()
  const fundingFilter = useColumnFilters()
  const jobsFilter = useColumnFilters()
  const newsFilter = useColumnFilters()

  const trialsDateCol = useDateColumn()
  const filingsDateCol = useDateColumn()
  const fundingDateCol = useDateColumn()
  const jobsDateCol = useDateColumn()
  const newsDateCol = useDateColumn()

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

  const pastClientMatchedNames = useMemo(() => new Set(data.pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])
  const pastClientNames = useMemo(() => new Set(data.pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])

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
    if (!lower) return false
    if (pastClientMatchedNames.has(lower)) return true
    return pastClientNames.has(lower)
  }, [pastClientMatchedNames, pastClientNames])

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
  }), [getTrialDisplayName, getCategory])

  const trialAllValues = useMemo(() => ({
    nct_id: data.clinicalTrials.map(t => t.nct_id || ''),
    company: data.clinicalTrials.map(t => getTrialDisplayName(t)),
    title: data.clinicalTrials.map(t => t.brief_title || ''),
    phase: data.clinicalTrials.map(t => t.phase || ''),
    category: data.clinicalTrials.map(t => getCategory(t)),
  }), [data.clinicalTrials, getTrialDisplayName, getCategory])

  const trialsRawDates = useMemo(() => data.clinicalTrials.map(t => t.study_start_date), [data.clinicalTrials])
  const getTrialDate = useCallback(t => t.study_start_date, [])

  const defaultSortedTrials = useMemo(() => {
    const arr = [...data.clinicalTrials]
    arr.sort((a, b) => {
      const ap = isPastClient(getTrialDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getTrialDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.study_start_date)?.getTime() || 0
      const db = parseDateValue(b.study_start_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.clinicalTrials, isPastClient, getTrialDisplayName])

  const sortedTrials = useMemo(() => (
    trialsDateCol.sortDir === null ? defaultSortedTrials : sortRowsByDate(defaultSortedTrials, getTrialDate, trialsDateCol.sortDir)
  ), [defaultSortedTrials, trialsDateCol.sortDir, getTrialDate])

  const filteredTrials = useMemo(() => (
    filterRowsByDateKeys(trialsFilter.applyFilters(sortedTrials, trialExtractors), getTrialDate, trialsDateCol.dateFilter)
  ), [sortedTrials, trialsFilter.applyFilters, trialExtractors, getTrialDate, trialsDateCol.dateFilter])

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

  const filingsRawDates = useMemo(() => data.filings.map(f => f.filing_date), [data.filings])
  const getFilingDate = useCallback(f => f.filing_date, [])

  const defaultSortedFilings = useMemo(() => {
    const arr = [...data.filings]
    arr.sort((a, b) => {
      const ap = isPastClient(getFilingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFilingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.filing_date)?.getTime() || 0
      const db = parseDateValue(b.filing_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.filings, isPastClient, getFilingDisplayName])

  const sortedFilings = useMemo(() => (
    filingsDateCol.sortDir === null ? defaultSortedFilings : sortRowsByDate(defaultSortedFilings, getFilingDate, filingsDateCol.sortDir)
  ), [defaultSortedFilings, filingsDateCol.sortDir, getFilingDate])

  const filteredFilings = useMemo(() => (
    filterRowsByDateKeys(filingsFilter.applyFilters(sortedFilings, filingExtractors), getFilingDate, filingsDateCol.dateFilter)
  ), [sortedFilings, filingsFilter.applyFilters, filingExtractors, getFilingDate, filingsDateCol.dateFilter])

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

  const fundingRawDates = useMemo(() => data.fundingProjects.map(p => p.award_notice_date), [data.fundingProjects])
  const getFundingDate = useCallback(p => p.award_notice_date, [])

  const defaultSortedFunding = useMemo(() => {
    const arr = [...data.fundingProjects]
    arr.sort((a, b) => {
      const ap = isPastClient(getFundingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFundingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.award_notice_date)?.getTime() || 0
      const db = parseDateValue(b.award_notice_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.fundingProjects, isPastClient, getFundingDisplayName])

  const sortedFunding = useMemo(() => (
    fundingDateCol.sortDir === null ? defaultSortedFunding : sortRowsByDate(defaultSortedFunding, getFundingDate, fundingDateCol.sortDir)
  ), [defaultSortedFunding, fundingDateCol.sortDir, getFundingDate])

  const filteredFunding = useMemo(() => (
    filterRowsByDateKeys(fundingFilter.applyFilters(sortedFunding, fundingExtractors), getFundingDate, fundingDateCol.dateFilter)
  ), [sortedFunding, fundingFilter.applyFilters, fundingExtractors, getFundingDate, fundingDateCol.dateFilter])

  // ── Clay Jobs table logic ─────────────────────────────────────────────────

  const getJobDisplayName = useCallback((j) => j.matched_name || j.company_name || '', [])

  const jobExtractors = useMemo(() => ({
    company: j => getJobDisplayName(j),
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [getJobDisplayName])

  const jobAllValues = useMemo(() => ({
    company: (data.clayJobs || []).map(j => getJobDisplayName(j)),
    title: (data.clayJobs || []).map(j => j.job_title || ''),
    location: (data.clayJobs || []).map(j => j.location || ''),
  }), [data.clayJobs, getJobDisplayName])

  const jobsRawDates = useMemo(() => (data.clayJobs || []).map(j => j.date_posted), [data.clayJobs])
  const getJobDate = useCallback(j => j.date_posted, [])

  const defaultSortedJobs = useMemo(() => {
    const arr = [...(data.clayJobs || [])]
    arr.sort((a, b) => {
      const ap = isPastClient(getJobDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getJobDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.clayJobs, isPastClient, getJobDisplayName])

  const sortedJobs = useMemo(() => (
    jobsDateCol.sortDir === null ? defaultSortedJobs : sortRowsByDate(defaultSortedJobs, getJobDate, jobsDateCol.sortDir)
  ), [defaultSortedJobs, jobsDateCol.sortDir, getJobDate])

  const filteredJobs = useMemo(() => (
    filterRowsByDateKeys(jobsFilter.applyFilters(sortedJobs, jobExtractors), getJobDate, jobsDateCol.dateFilter)
  ), [sortedJobs, jobsFilter.applyFilters, jobExtractors, getJobDate, jobsDateCol.dateFilter])

  // ── News table logic ──────────────────────────────────────────────────────

  const articleHasPastClient = useCallback((a) => {
    const names = Array.isArray(a.matched_names) ? a.matched_names : []
    return names.some(n => isPastClient(n))
  }, [isPastClient])

  const newsAllValues = useMemo(() => {
    const companySet = new Set()
    for (const a of data.newsArticles || []) {
      if (Array.isArray(a.matched_names)) {
        for (const n of a.matched_names) if (n) companySet.add(n)
      }
    }
    return {
      company: [...companySet],
      title: (data.newsArticles || []).map(a => a.title || ''),
      source: (data.newsArticles || []).map(a => a._source || ''),
    }
  }, [data.newsArticles])

  const newsRawDates = useMemo(() => (data.newsArticles || []).map(a => a.date), [data.newsArticles])
  const getNewsDate = useCallback(a => a.date, [])

  const defaultSortedNews = useMemo(() => {
    const arr = [...(data.newsArticles || [])]
    arr.sort((a, b) => {
      const ap = articleHasPastClient(a) ? 1 : 0
      const bp = articleHasPastClient(b) ? 1 : 0
      if (bp !== ap) return bp - ap
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        const da = parseDateValue(a.date)?.getTime() || 0
        const db = parseDateValue(b.date)?.getTime() || 0
        return db - da
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.newsArticles, articleHasPastClient])

  const sortedNews = useMemo(() => (
    newsDateCol.sortDir === null ? defaultSortedNews : sortRowsByDate(defaultSortedNews, getNewsDate, newsDateCol.sortDir)
  ), [defaultSortedNews, newsDateCol.sortDir, getNewsDate])

  const filteredNews = useMemo(() => {
    const colFiltered = !newsFilter.hasActiveFilters ? sortedNews : sortedNews.filter(a => {
      for (const [colKey, allowedValues] of Object.entries(newsFilter.filters)) {
        if (!allowedValues || allowedValues.length === 0) continue
        const allowedLower = allowedValues.map(v => String(v).toLowerCase())
        if (colKey === 'company') {
          const names = Array.isArray(a.matched_names) ? a.matched_names : []
          if (!names.some(n => allowedLower.includes(String(n).toLowerCase()))) return false
        } else if (colKey === 'title') {
          if (!allowedLower.includes(String(a.title || '').toLowerCase())) return false
        } else if (colKey === 'source') {
          if (!allowedLower.includes(String(a._source || '').toLowerCase())) return false
        }
      }
      return true
    })
    return filterRowsByDateKeys(colFiltered, getNewsDate, newsDateCol.dateFilter)
  }, [sortedNews, newsFilter.filters, newsFilter.hasActiveFilters, getNewsDate, newsDateCol.dateFilter])

  const updateNewsMatches = useCallback((url, newMatches) => {
    setData(prev => ({
      ...prev,
      newsArticles: (prev.newsArticles || []).map(a =>
        a.url === url
          ? { ...a, matched_names: newMatches && newMatches.length > 0 ? newMatches : null }
          : a
      ),
    }))
  }, [])

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
          <ClearAllFiltersButton
            hasActiveFilters={trialsFilter.hasActiveFilters || trialsDateCol.hasDateFilter}
            onClear={() => { trialsFilter.clearAll(); trialsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={trialAllValues.nct_id} activeValues={trialsFilter.filters.nct_id} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={trialAllValues.company} activeValues={trialsFilter.filters.company} onApply={trialsFilter.setFilter} className="w-[22%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={trialAllValues.title} activeValues={trialsFilter.filters.title} onApply={trialsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="phase" label="Phase" allValues={trialAllValues.phase} activeValues={trialsFilter.filters.phase} onApply={trialsFilter.setFilter} className="w-[10%]" />
                  <ColumnFilterDropdown colKey="category" label="Category" allValues={trialAllValues.category} activeValues={trialsFilter.filters.category} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <HierarchicalDateFilter label="Start Date" sortDir={trialsDateCol.sortDir} onCycleSort={trialsDateCol.cycleSortDir} allRawDates={trialsRawDates} activeDateKeys={trialsDateCol.dateFilter} onApplyFilter={trialsDateCol.setDateFilter} className="w-[14%]" />
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
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(trial.study_start_date)}</td>
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
          <ClearAllFiltersButton
            hasActiveFilters={filingsFilter.hasActiveFilters || filingsDateCol.hasDateFilter}
            onClear={() => { filingsFilter.clearAll(); filingsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={filingAllValues.company} activeValues={filingsFilter.filters.company} onApply={filingsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={filingAllValues.transaction} activeValues={filingsFilter.filters.transaction} onApply={filingsFilter.setFilter} className="w-[20%]" />
                  <HierarchicalDateFilter label="Filing Date" sortDir={filingsDateCol.sortDir} onCycleSort={filingsDateCol.cycleSortDir} allRawDates={filingsRawDates} activeDateKeys={filingsDateCol.dateFilter} onApplyFilter={filingsDateCol.setDateFilter} className="w-[20%]" />
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
          <ClearAllFiltersButton
            hasActiveFilters={fundingFilter.hasActiveFilters || fundingDateCol.hasDateFilter}
            onClear={() => { fundingFilter.clearAll(); fundingDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={fundingAllValues.company} activeValues={fundingFilter.filters.company} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="title" label="Project Title" allValues={fundingAllValues.title} activeValues={fundingFilter.filters.title} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <Th className="w-[15%]">Award</Th>
                  <HierarchicalDateFilter label="Award Date" sortDir={fundingDateCol.sortDir} onCycleSort={fundingDateCol.cycleSortDir} allRawDates={fundingRawDates} activeDateKeys={fundingDateCol.dateFilter} onApplyFilter={fundingDateCol.setDateFilter} className="w-[10%]" />
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

      {/* ── Jobs Section ─────────────────────────────────────────────────── */}
      {!loading && (data.clayJobs || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">Jobs</h2>
          <ClearAllFiltersButton
            hasActiveFilters={jobsFilter.hasActiveFilters || jobsDateCol.hasDateFilter}
            onClear={() => { jobsFilter.clearAll(); jobsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={jobAllValues.company} activeValues={jobsFilter.filters.company} onApply={jobsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Job Title" allValues={jobAllValues.title} activeValues={jobsFilter.filters.title} onApply={jobsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="location" label="Location" allValues={jobAllValues.location} activeValues={jobsFilter.filters.location} onApply={jobsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[10%]">Domain</Th>
                  <HierarchicalDateFilter label="Date Posted" sortDir={jobsDateCol.sortDir} onCycleSort={jobsDateCol.cycleSortDir} allRawDates={jobsRawDates} activeDateKeys={jobsDateCol.dateFilter} onApplyFilter={jobsDateCol.setDateFilter} className="w-[10%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredJobs.map((job, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getJobDisplayName(job)
                  const isClient = isPastClient(displayName)
                  return (
                    <tr key={job.id} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                        {displayName || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.job_title || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.location || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.company_domain || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatClayDate(job.date_posted)}</td>
                      <td className="px-3 py-3 text-sm align-top">
                        {job.job_url ? (
                          <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Job &#8599;</a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── News Section ─────────────────────────────────────────────────── */}
      {!loading && (data.newsArticles || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">News</h2>
          <ClearAllFiltersButton
            hasActiveFilters={newsFilter.hasActiveFilters || newsDateCol.hasDateFilter}
            onClear={() => { newsFilter.clearAll(); newsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={newsAllValues.company} activeValues={newsFilter.filters.company} onApply={newsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={newsAllValues.title} activeValues={newsFilter.filters.title} onApply={newsFilter.setFilter} className="w-[35%]" />
                  <HierarchicalDateFilter label="Date" sortDir={newsDateCol.sortDir} onCycleSort={newsDateCol.cycleSortDir} allRawDates={newsRawDates} activeDateKeys={newsDateCol.dateFilter} onApplyFilter={newsDateCol.setDateFilter} className="w-[15%]" />
                  <ColumnFilterDropdown colKey="source" label="Source" allValues={newsAllValues.source} activeValues={newsFilter.filters.source} onApply={newsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredNews.map((article, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const names = Array.isArray(article.matched_names) ? article.matched_names : []
                  return (
                    <tr key={article.url} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm text-gray-200 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        <div className="flex flex-col gap-1">
                          {names.length === 0 && <span className="text-gray-600">—</span>}
                          {names.map(n => (
                            <span key={n} className="text-gray-100">
                              {isPastClient(n) && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                              {n}
                            </span>
                          ))}
                          <button
                            onClick={() => setAssignArticle(article)}
                            className="self-start mt-1 text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:bg-blue-600/20 transition-colors"
                          >
                            {names.length > 0 ? 'Edit' : '+ Assign'}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.title || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.date ? formatDate(article.date) : '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article._source || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm align-top">
                        {article.url ? (
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 font-medium"
                          >
                            Read Article &#8599;
                          </a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assignArticle && (
        <AssignCompanyModal
          article={assignArticle}
          onClose={() => setAssignArticle(null)}
          onSaved={(newMatches) => updateNewsMatches(assignArticle.url, newMatches)}
        />
      )}
    </div>
  )
}

// ─── Jim Leads Page ──────────────────────────────────────────────────────────

function JimLeadsPage() {
  const [data, setData] = useState({ trackedCompanies: [], clinicalTrials: [], filings: [], fundingProjects: [], newsArticles: [], clayJobs: [], pastClients: [] })
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedTrialRows, setExpandedTrialRows] = useState(new Set())
  const [expandedFilingRows, setExpandedFilingRows] = useState(new Set())
  const [expandedFundingRows, setExpandedFundingRows] = useState(new Set())
  const [assignArticle, setAssignArticle] = useState(null)
  const searchRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceRef = useRef(null)

  const trialsFilter = useColumnFilters()
  const filingsFilter = useColumnFilters()
  const fundingFilter = useColumnFilters()
  const jobsFilter = useColumnFilters()
  const newsFilter = useColumnFilters()

  const trialsDateCol = useDateColumn()
  const filingsDateCol = useDateColumn()
  const fundingDateCol = useDateColumn()
  const jobsDateCol = useDateColumn()
  const newsDateCol = useDateColumn()

  const loadData = useCallback(() => {
    setLoading(true)
    fetch('/api/jim-leads')
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
    await fetch('/api/jim-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    setSearchQuery('')
    setSearchOpen(false)
    loadData()
  }

  const removeCompany = async (name) => {
    await fetch('/api/jim-leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    loadData()
  }

  const pastClientMatchedNames = useMemo(() => new Set(data.pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])
  const pastClientNames = useMemo(() => new Set(data.pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])

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
    if (!lower) return false
    if (pastClientMatchedNames.has(lower)) return true
    return pastClientNames.has(lower)
  }, [pastClientMatchedNames, pastClientNames])

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
  }), [getTrialDisplayName, getCategory])

  const trialAllValues = useMemo(() => ({
    nct_id: data.clinicalTrials.map(t => t.nct_id || ''),
    company: data.clinicalTrials.map(t => getTrialDisplayName(t)),
    title: data.clinicalTrials.map(t => t.brief_title || ''),
    phase: data.clinicalTrials.map(t => t.phase || ''),
    category: data.clinicalTrials.map(t => getCategory(t)),
  }), [data.clinicalTrials, getTrialDisplayName, getCategory])

  const trialsRawDates = useMemo(() => data.clinicalTrials.map(t => t.study_start_date), [data.clinicalTrials])
  const getTrialDate = useCallback(t => t.study_start_date, [])

  const defaultSortedTrials = useMemo(() => {
    const arr = [...data.clinicalTrials]
    arr.sort((a, b) => {
      const ap = isPastClient(getTrialDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getTrialDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.study_start_date)?.getTime() || 0
      const db = parseDateValue(b.study_start_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.clinicalTrials, isPastClient, getTrialDisplayName])

  const sortedTrials = useMemo(() => (
    trialsDateCol.sortDir === null ? defaultSortedTrials : sortRowsByDate(defaultSortedTrials, getTrialDate, trialsDateCol.sortDir)
  ), [defaultSortedTrials, trialsDateCol.sortDir, getTrialDate])

  const filteredTrials = useMemo(() => (
    filterRowsByDateKeys(trialsFilter.applyFilters(sortedTrials, trialExtractors), getTrialDate, trialsDateCol.dateFilter)
  ), [sortedTrials, trialsFilter.applyFilters, trialExtractors, getTrialDate, trialsDateCol.dateFilter])

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

  const filingsRawDates = useMemo(() => data.filings.map(f => f.filing_date), [data.filings])
  const getFilingDate = useCallback(f => f.filing_date, [])

  const defaultSortedFilings = useMemo(() => {
    const arr = [...data.filings]
    arr.sort((a, b) => {
      const ap = isPastClient(getFilingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFilingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.filing_date)?.getTime() || 0
      const db = parseDateValue(b.filing_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.filings, isPastClient, getFilingDisplayName])

  const sortedFilings = useMemo(() => (
    filingsDateCol.sortDir === null ? defaultSortedFilings : sortRowsByDate(defaultSortedFilings, getFilingDate, filingsDateCol.sortDir)
  ), [defaultSortedFilings, filingsDateCol.sortDir, getFilingDate])

  const filteredFilings = useMemo(() => (
    filterRowsByDateKeys(filingsFilter.applyFilters(sortedFilings, filingExtractors), getFilingDate, filingsDateCol.dateFilter)
  ), [sortedFilings, filingsFilter.applyFilters, filingExtractors, getFilingDate, filingsDateCol.dateFilter])

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

  const fundingRawDates = useMemo(() => data.fundingProjects.map(p => p.award_notice_date), [data.fundingProjects])
  const getFundingDate = useCallback(p => p.award_notice_date, [])

  const defaultSortedFunding = useMemo(() => {
    const arr = [...data.fundingProjects]
    arr.sort((a, b) => {
      const ap = isPastClient(getFundingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFundingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.award_notice_date)?.getTime() || 0
      const db = parseDateValue(b.award_notice_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.fundingProjects, isPastClient, getFundingDisplayName])

  const sortedFunding = useMemo(() => (
    fundingDateCol.sortDir === null ? defaultSortedFunding : sortRowsByDate(defaultSortedFunding, getFundingDate, fundingDateCol.sortDir)
  ), [defaultSortedFunding, fundingDateCol.sortDir, getFundingDate])

  const filteredFunding = useMemo(() => (
    filterRowsByDateKeys(fundingFilter.applyFilters(sortedFunding, fundingExtractors), getFundingDate, fundingDateCol.dateFilter)
  ), [sortedFunding, fundingFilter.applyFilters, fundingExtractors, getFundingDate, fundingDateCol.dateFilter])

  // ── Clay Jobs table logic ─────────────────────────────────────────────────

  const getJobDisplayName = useCallback((j) => j.matched_name || j.company_name || '', [])

  const jobExtractors = useMemo(() => ({
    company: j => getJobDisplayName(j),
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [getJobDisplayName])

  const jobAllValues = useMemo(() => ({
    company: (data.clayJobs || []).map(j => getJobDisplayName(j)),
    title: (data.clayJobs || []).map(j => j.job_title || ''),
    location: (data.clayJobs || []).map(j => j.location || ''),
  }), [data.clayJobs, getJobDisplayName])

  const jobsRawDates = useMemo(() => (data.clayJobs || []).map(j => j.date_posted), [data.clayJobs])
  const getJobDate = useCallback(j => j.date_posted, [])

  const defaultSortedJobs = useMemo(() => {
    const arr = [...(data.clayJobs || [])]
    arr.sort((a, b) => {
      const ap = isPastClient(getJobDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getJobDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.clayJobs, isPastClient, getJobDisplayName])

  const sortedJobs = useMemo(() => (
    jobsDateCol.sortDir === null ? defaultSortedJobs : sortRowsByDate(defaultSortedJobs, getJobDate, jobsDateCol.sortDir)
  ), [defaultSortedJobs, jobsDateCol.sortDir, getJobDate])

  const filteredJobs = useMemo(() => (
    filterRowsByDateKeys(jobsFilter.applyFilters(sortedJobs, jobExtractors), getJobDate, jobsDateCol.dateFilter)
  ), [sortedJobs, jobsFilter.applyFilters, jobExtractors, getJobDate, jobsDateCol.dateFilter])

  // ── News table logic ──────────────────────────────────────────────────────

  const articleHasPastClient = useCallback((a) => {
    const names = Array.isArray(a.matched_names) ? a.matched_names : []
    return names.some(n => isPastClient(n))
  }, [isPastClient])

  const newsAllValues = useMemo(() => {
    const companySet = new Set()
    for (const a of data.newsArticles || []) {
      if (Array.isArray(a.matched_names)) {
        for (const n of a.matched_names) if (n) companySet.add(n)
      }
    }
    return {
      company: [...companySet],
      title: (data.newsArticles || []).map(a => a.title || ''),
      source: (data.newsArticles || []).map(a => a._source || ''),
    }
  }, [data.newsArticles])

  const newsRawDates = useMemo(() => (data.newsArticles || []).map(a => a.date), [data.newsArticles])
  const getNewsDate = useCallback(a => a.date, [])

  const defaultSortedNews = useMemo(() => {
    const arr = [...(data.newsArticles || [])]
    arr.sort((a, b) => {
      const ap = articleHasPastClient(a) ? 1 : 0
      const bp = articleHasPastClient(b) ? 1 : 0
      if (bp !== ap) return bp - ap
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        const da = parseDateValue(a.date)?.getTime() || 0
        const db = parseDateValue(b.date)?.getTime() || 0
        return db - da
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.newsArticles, articleHasPastClient])

  const sortedNews = useMemo(() => (
    newsDateCol.sortDir === null ? defaultSortedNews : sortRowsByDate(defaultSortedNews, getNewsDate, newsDateCol.sortDir)
  ), [defaultSortedNews, newsDateCol.sortDir, getNewsDate])

  const filteredNews = useMemo(() => {
    const colFiltered = !newsFilter.hasActiveFilters ? sortedNews : sortedNews.filter(a => {
      for (const [colKey, allowedValues] of Object.entries(newsFilter.filters)) {
        if (!allowedValues || allowedValues.length === 0) continue
        const allowedLower = allowedValues.map(v => String(v).toLowerCase())
        if (colKey === 'company') {
          const names = Array.isArray(a.matched_names) ? a.matched_names : []
          if (!names.some(n => allowedLower.includes(String(n).toLowerCase()))) return false
        } else if (colKey === 'title') {
          if (!allowedLower.includes(String(a.title || '').toLowerCase())) return false
        } else if (colKey === 'source') {
          if (!allowedLower.includes(String(a._source || '').toLowerCase())) return false
        }
      }
      return true
    })
    return filterRowsByDateKeys(colFiltered, getNewsDate, newsDateCol.dateFilter)
  }, [sortedNews, newsFilter.filters, newsFilter.hasActiveFilters, getNewsDate, newsDateCol.dateFilter])

  const updateNewsMatches = useCallback((url, newMatches) => {
    setData(prev => ({
      ...prev,
      newsArticles: (prev.newsArticles || []).map(a =>
        a.url === url
          ? { ...a, matched_names: newMatches && newMatches.length > 0 ? newMatches : null }
          : a
      ),
    }))
  }, [])

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
          <ClearAllFiltersButton
            hasActiveFilters={trialsFilter.hasActiveFilters || trialsDateCol.hasDateFilter}
            onClear={() => { trialsFilter.clearAll(); trialsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={trialAllValues.nct_id} activeValues={trialsFilter.filters.nct_id} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={trialAllValues.company} activeValues={trialsFilter.filters.company} onApply={trialsFilter.setFilter} className="w-[22%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={trialAllValues.title} activeValues={trialsFilter.filters.title} onApply={trialsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="phase" label="Phase" allValues={trialAllValues.phase} activeValues={trialsFilter.filters.phase} onApply={trialsFilter.setFilter} className="w-[10%]" />
                  <ColumnFilterDropdown colKey="category" label="Category" allValues={trialAllValues.category} activeValues={trialsFilter.filters.category} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <HierarchicalDateFilter label="Start Date" sortDir={trialsDateCol.sortDir} onCycleSort={trialsDateCol.cycleSortDir} allRawDates={trialsRawDates} activeDateKeys={trialsDateCol.dateFilter} onApplyFilter={trialsDateCol.setDateFilter} className="w-[14%]" />
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
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(trial.study_start_date)}</td>
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
          <ClearAllFiltersButton
            hasActiveFilters={filingsFilter.hasActiveFilters || filingsDateCol.hasDateFilter}
            onClear={() => { filingsFilter.clearAll(); filingsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={filingAllValues.company} activeValues={filingsFilter.filters.company} onApply={filingsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={filingAllValues.transaction} activeValues={filingsFilter.filters.transaction} onApply={filingsFilter.setFilter} className="w-[20%]" />
                  <HierarchicalDateFilter label="Filing Date" sortDir={filingsDateCol.sortDir} onCycleSort={filingsDateCol.cycleSortDir} allRawDates={filingsRawDates} activeDateKeys={filingsDateCol.dateFilter} onApplyFilter={filingsDateCol.setDateFilter} className="w-[20%]" />
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
          <ClearAllFiltersButton
            hasActiveFilters={fundingFilter.hasActiveFilters || fundingDateCol.hasDateFilter}
            onClear={() => { fundingFilter.clearAll(); fundingDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={fundingAllValues.company} activeValues={fundingFilter.filters.company} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="title" label="Project Title" allValues={fundingAllValues.title} activeValues={fundingFilter.filters.title} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <Th className="w-[15%]">Award</Th>
                  <HierarchicalDateFilter label="Award Date" sortDir={fundingDateCol.sortDir} onCycleSort={fundingDateCol.cycleSortDir} allRawDates={fundingRawDates} activeDateKeys={fundingDateCol.dateFilter} onApplyFilter={fundingDateCol.setDateFilter} className="w-[10%]" />
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

      {/* ── Jobs Section ─────────────────────────────────────────────────── */}
      {!loading && (data.clayJobs || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">Jobs</h2>
          <ClearAllFiltersButton
            hasActiveFilters={jobsFilter.hasActiveFilters || jobsDateCol.hasDateFilter}
            onClear={() => { jobsFilter.clearAll(); jobsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={jobAllValues.company} activeValues={jobsFilter.filters.company} onApply={jobsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Job Title" allValues={jobAllValues.title} activeValues={jobsFilter.filters.title} onApply={jobsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="location" label="Location" allValues={jobAllValues.location} activeValues={jobsFilter.filters.location} onApply={jobsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[10%]">Domain</Th>
                  <HierarchicalDateFilter label="Date Posted" sortDir={jobsDateCol.sortDir} onCycleSort={jobsDateCol.cycleSortDir} allRawDates={jobsRawDates} activeDateKeys={jobsDateCol.dateFilter} onApplyFilter={jobsDateCol.setDateFilter} className="w-[10%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredJobs.map((job, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getJobDisplayName(job)
                  const isClient = isPastClient(displayName)
                  return (
                    <tr key={job.id} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                        {displayName || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.job_title || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.location || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.company_domain || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatClayDate(job.date_posted)}</td>
                      <td className="px-3 py-3 text-sm align-top">
                        {job.job_url ? (
                          <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Job &#8599;</a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── News Section ─────────────────────────────────────────────────── */}
      {!loading && (data.newsArticles || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">News</h2>
          <ClearAllFiltersButton
            hasActiveFilters={newsFilter.hasActiveFilters || newsDateCol.hasDateFilter}
            onClear={() => { newsFilter.clearAll(); newsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={newsAllValues.company} activeValues={newsFilter.filters.company} onApply={newsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={newsAllValues.title} activeValues={newsFilter.filters.title} onApply={newsFilter.setFilter} className="w-[35%]" />
                  <HierarchicalDateFilter label="Date" sortDir={newsDateCol.sortDir} onCycleSort={newsDateCol.cycleSortDir} allRawDates={newsRawDates} activeDateKeys={newsDateCol.dateFilter} onApplyFilter={newsDateCol.setDateFilter} className="w-[15%]" />
                  <ColumnFilterDropdown colKey="source" label="Source" allValues={newsAllValues.source} activeValues={newsFilter.filters.source} onApply={newsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredNews.map((article, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const names = Array.isArray(article.matched_names) ? article.matched_names : []
                  return (
                    <tr key={article.url} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm text-gray-200 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        <div className="flex flex-col gap-1">
                          {names.length === 0 && <span className="text-gray-600">—</span>}
                          {names.map(n => (
                            <span key={n} className="text-gray-100">
                              {isPastClient(n) && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                              {n}
                            </span>
                          ))}
                          <button
                            onClick={() => setAssignArticle(article)}
                            className="self-start mt-1 text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:bg-blue-600/20 transition-colors"
                          >
                            {names.length > 0 ? 'Edit' : '+ Assign'}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.title || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.date ? formatDate(article.date) : '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article._source || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm align-top">
                        {article.url ? (
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 font-medium"
                          >
                            Read Article &#8599;
                          </a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assignArticle && (
        <AssignCompanyModal
          article={assignArticle}
          onClose={() => setAssignArticle(null)}
          onSaved={(newMatches) => updateNewsMatches(assignArticle.url, newMatches)}
        />
      )}
    </div>
  )
}

// ─── Tim Leads Page ──────────────────────────────────────────────────────────

function TimLeadsPage() {
  const [data, setData] = useState({ trackedCompanies: [], clinicalTrials: [], filings: [], fundingProjects: [], newsArticles: [], clayJobs: [], pastClients: [] })
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedTrialRows, setExpandedTrialRows] = useState(new Set())
  const [expandedFilingRows, setExpandedFilingRows] = useState(new Set())
  const [expandedFundingRows, setExpandedFundingRows] = useState(new Set())
  const [assignArticle, setAssignArticle] = useState(null)
  const searchRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceRef = useRef(null)

  const trialsFilter = useColumnFilters()
  const filingsFilter = useColumnFilters()
  const fundingFilter = useColumnFilters()
  const jobsFilter = useColumnFilters()
  const newsFilter = useColumnFilters()

  const trialsDateCol = useDateColumn()
  const filingsDateCol = useDateColumn()
  const fundingDateCol = useDateColumn()
  const jobsDateCol = useDateColumn()
  const newsDateCol = useDateColumn()

  const loadData = useCallback(() => {
    setLoading(true)
    fetch('/api/tim-leads')
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
    await fetch('/api/tim-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    setSearchQuery('')
    setSearchOpen(false)
    loadData()
  }

  const removeCompany = async (name) => {
    await fetch('/api/tim-leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: name }),
    })
    loadData()
  }

  const pastClientMatchedNames = useMemo(() => new Set(data.pastClients.map(c => c.matched_name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])
  const pastClientNames = useMemo(() => new Set(data.pastClients.map(c => c.name).filter(Boolean).map(n => n.toLowerCase())), [data.pastClients])

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
    if (!lower) return false
    if (pastClientMatchedNames.has(lower)) return true
    return pastClientNames.has(lower)
  }, [pastClientMatchedNames, pastClientNames])

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
  }), [getTrialDisplayName, getCategory])

  const trialAllValues = useMemo(() => ({
    nct_id: data.clinicalTrials.map(t => t.nct_id || ''),
    company: data.clinicalTrials.map(t => getTrialDisplayName(t)),
    title: data.clinicalTrials.map(t => t.brief_title || ''),
    phase: data.clinicalTrials.map(t => t.phase || ''),
    category: data.clinicalTrials.map(t => getCategory(t)),
  }), [data.clinicalTrials, getTrialDisplayName, getCategory])

  const trialsRawDates = useMemo(() => data.clinicalTrials.map(t => t.study_start_date), [data.clinicalTrials])
  const getTrialDate = useCallback(t => t.study_start_date, [])

  const defaultSortedTrials = useMemo(() => {
    const arr = [...data.clinicalTrials]
    arr.sort((a, b) => {
      const ap = isPastClient(getTrialDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getTrialDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.study_start_date)?.getTime() || 0
      const db = parseDateValue(b.study_start_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.clinicalTrials, isPastClient, getTrialDisplayName])

  const sortedTrials = useMemo(() => (
    trialsDateCol.sortDir === null ? defaultSortedTrials : sortRowsByDate(defaultSortedTrials, getTrialDate, trialsDateCol.sortDir)
  ), [defaultSortedTrials, trialsDateCol.sortDir, getTrialDate])

  const filteredTrials = useMemo(() => (
    filterRowsByDateKeys(trialsFilter.applyFilters(sortedTrials, trialExtractors), getTrialDate, trialsDateCol.dateFilter)
  ), [sortedTrials, trialsFilter.applyFilters, trialExtractors, getTrialDate, trialsDateCol.dateFilter])

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

  const filingsRawDates = useMemo(() => data.filings.map(f => f.filing_date), [data.filings])
  const getFilingDate = useCallback(f => f.filing_date, [])

  const defaultSortedFilings = useMemo(() => {
    const arr = [...data.filings]
    arr.sort((a, b) => {
      const ap = isPastClient(getFilingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFilingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.filing_date)?.getTime() || 0
      const db = parseDateValue(b.filing_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.filings, isPastClient, getFilingDisplayName])

  const sortedFilings = useMemo(() => (
    filingsDateCol.sortDir === null ? defaultSortedFilings : sortRowsByDate(defaultSortedFilings, getFilingDate, filingsDateCol.sortDir)
  ), [defaultSortedFilings, filingsDateCol.sortDir, getFilingDate])

  const filteredFilings = useMemo(() => (
    filterRowsByDateKeys(filingsFilter.applyFilters(sortedFilings, filingExtractors), getFilingDate, filingsDateCol.dateFilter)
  ), [sortedFilings, filingsFilter.applyFilters, filingExtractors, getFilingDate, filingsDateCol.dateFilter])

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

  const fundingRawDates = useMemo(() => data.fundingProjects.map(p => p.award_notice_date), [data.fundingProjects])
  const getFundingDate = useCallback(p => p.award_notice_date, [])

  const defaultSortedFunding = useMemo(() => {
    const arr = [...data.fundingProjects]
    arr.sort((a, b) => {
      const ap = isPastClient(getFundingDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getFundingDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      const da = parseDateValue(a.award_notice_date)?.getTime() || 0
      const db = parseDateValue(b.award_notice_date)?.getTime() || 0
      return db - da
    })
    return arr
  }, [data.fundingProjects, isPastClient, getFundingDisplayName])

  const sortedFunding = useMemo(() => (
    fundingDateCol.sortDir === null ? defaultSortedFunding : sortRowsByDate(defaultSortedFunding, getFundingDate, fundingDateCol.sortDir)
  ), [defaultSortedFunding, fundingDateCol.sortDir, getFundingDate])

  const filteredFunding = useMemo(() => (
    filterRowsByDateKeys(fundingFilter.applyFilters(sortedFunding, fundingExtractors), getFundingDate, fundingDateCol.dateFilter)
  ), [sortedFunding, fundingFilter.applyFilters, fundingExtractors, getFundingDate, fundingDateCol.dateFilter])

  // ── Clay Jobs table logic ─────────────────────────────────────────────────

  const getJobDisplayName = useCallback((j) => j.matched_name || j.company_name || '', [])

  const jobExtractors = useMemo(() => ({
    company: j => getJobDisplayName(j),
    title: j => j.job_title || '',
    location: j => j.location || '',
  }), [getJobDisplayName])

  const jobAllValues = useMemo(() => ({
    company: (data.clayJobs || []).map(j => getJobDisplayName(j)),
    title: (data.clayJobs || []).map(j => j.job_title || ''),
    location: (data.clayJobs || []).map(j => j.location || ''),
  }), [data.clayJobs, getJobDisplayName])

  const jobsRawDates = useMemo(() => (data.clayJobs || []).map(j => j.date_posted), [data.clayJobs])
  const getJobDate = useCallback(j => j.date_posted, [])

  const defaultSortedJobs = useMemo(() => {
    const arr = [...(data.clayJobs || [])]
    arr.sort((a, b) => {
      const ap = isPastClient(getJobDisplayName(a)) ? 1 : 0
      const bp = isPastClient(getJobDisplayName(b)) ? 1 : 0
      if (bp !== ap) return bp - ap
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.clayJobs, isPastClient, getJobDisplayName])

  const sortedJobs = useMemo(() => (
    jobsDateCol.sortDir === null ? defaultSortedJobs : sortRowsByDate(defaultSortedJobs, getJobDate, jobsDateCol.sortDir)
  ), [defaultSortedJobs, jobsDateCol.sortDir, getJobDate])

  const filteredJobs = useMemo(() => (
    filterRowsByDateKeys(jobsFilter.applyFilters(sortedJobs, jobExtractors), getJobDate, jobsDateCol.dateFilter)
  ), [sortedJobs, jobsFilter.applyFilters, jobExtractors, getJobDate, jobsDateCol.dateFilter])

  // ── News table logic ──────────────────────────────────────────────────────

  const articleHasPastClient = useCallback((a) => {
    const names = Array.isArray(a.matched_names) ? a.matched_names : []
    return names.some(n => isPastClient(n))
  }, [isPastClient])

  const newsAllValues = useMemo(() => {
    const companySet = new Set()
    for (const a of data.newsArticles || []) {
      if (Array.isArray(a.matched_names)) {
        for (const n of a.matched_names) if (n) companySet.add(n)
      }
    }
    return {
      company: [...companySet],
      title: (data.newsArticles || []).map(a => a.title || ''),
      source: (data.newsArticles || []).map(a => a._source || ''),
    }
  }, [data.newsArticles])

  const newsRawDates = useMemo(() => (data.newsArticles || []).map(a => a.date), [data.newsArticles])
  const getNewsDate = useCallback(a => a.date, [])

  const defaultSortedNews = useMemo(() => {
    const arr = [...(data.newsArticles || [])]
    arr.sort((a, b) => {
      const ap = articleHasPastClient(a) ? 1 : 0
      const bp = articleHasPastClient(b) ? 1 : 0
      if (bp !== ap) return bp - ap
      const aHas = a.date ? 1 : 0
      const bHas = b.date ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (a.date && b.date) {
        const da = parseDateValue(a.date)?.getTime() || 0
        const db = parseDateValue(b.date)?.getTime() || 0
        return db - da
      }
      return new Date(b.created_at || 0) - new Date(a.created_at || 0)
    })
    return arr
  }, [data.newsArticles, articleHasPastClient])

  const sortedNews = useMemo(() => (
    newsDateCol.sortDir === null ? defaultSortedNews : sortRowsByDate(defaultSortedNews, getNewsDate, newsDateCol.sortDir)
  ), [defaultSortedNews, newsDateCol.sortDir, getNewsDate])

  const filteredNews = useMemo(() => {
    const colFiltered = !newsFilter.hasActiveFilters ? sortedNews : sortedNews.filter(a => {
      for (const [colKey, allowedValues] of Object.entries(newsFilter.filters)) {
        if (!allowedValues || allowedValues.length === 0) continue
        const allowedLower = allowedValues.map(v => String(v).toLowerCase())
        if (colKey === 'company') {
          const names = Array.isArray(a.matched_names) ? a.matched_names : []
          if (!names.some(n => allowedLower.includes(String(n).toLowerCase()))) return false
        } else if (colKey === 'title') {
          if (!allowedLower.includes(String(a.title || '').toLowerCase())) return false
        } else if (colKey === 'source') {
          if (!allowedLower.includes(String(a._source || '').toLowerCase())) return false
        }
      }
      return true
    })
    return filterRowsByDateKeys(colFiltered, getNewsDate, newsDateCol.dateFilter)
  }, [sortedNews, newsFilter.filters, newsFilter.hasActiveFilters, getNewsDate, newsDateCol.dateFilter])

  const updateNewsMatches = useCallback((url, newMatches) => {
    setData(prev => ({
      ...prev,
      newsArticles: (prev.newsArticles || []).map(a =>
        a.url === url
          ? { ...a, matched_names: newMatches && newMatches.length > 0 ? newMatches : null }
          : a
      ),
    }))
  }, [])

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
          <ClearAllFiltersButton
            hasActiveFilters={trialsFilter.hasActiveFilters || trialsDateCol.hasDateFilter}
            onClear={() => { trialsFilter.clearAll(); trialsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="nct_id" label="NCT ID" allValues={trialAllValues.nct_id} activeValues={trialsFilter.filters.nct_id} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={trialAllValues.company} activeValues={trialsFilter.filters.company} onApply={trialsFilter.setFilter} className="w-[22%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={trialAllValues.title} activeValues={trialsFilter.filters.title} onApply={trialsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="phase" label="Phase" allValues={trialAllValues.phase} activeValues={trialsFilter.filters.phase} onApply={trialsFilter.setFilter} className="w-[10%]" />
                  <ColumnFilterDropdown colKey="category" label="Category" allValues={trialAllValues.category} activeValues={trialsFilter.filters.category} onApply={trialsFilter.setFilter} className="w-[12%]" />
                  <HierarchicalDateFilter label="Start Date" sortDir={trialsDateCol.sortDir} onCycleSort={trialsDateCol.cycleSortDir} allRawDates={trialsRawDates} activeDateKeys={trialsDateCol.dateFilter} onApplyFilter={trialsDateCol.setDateFilter} className="w-[14%]" />
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
                        <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatDate(trial.study_start_date)}</td>
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
          <ClearAllFiltersButton
            hasActiveFilters={filingsFilter.hasActiveFilters || filingsDateCol.hasDateFilter}
            onClear={() => { filingsFilter.clearAll(); filingsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={filingAllValues.company} activeValues={filingsFilter.filters.company} onApply={filingsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="transaction" label="Transaction" allValues={filingAllValues.transaction} activeValues={filingsFilter.filters.transaction} onApply={filingsFilter.setFilter} className="w-[20%]" />
                  <HierarchicalDateFilter label="Filing Date" sortDir={filingsDateCol.sortDir} onCycleSort={filingsDateCol.cycleSortDir} allRawDates={filingsRawDates} activeDateKeys={filingsDateCol.dateFilter} onApplyFilter={filingsDateCol.setDateFilter} className="w-[20%]" />
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
          <ClearAllFiltersButton
            hasActiveFilters={fundingFilter.hasActiveFilters || fundingDateCol.hasDateFilter}
            onClear={() => { fundingFilter.clearAll(); fundingDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company Name" allValues={fundingAllValues.company} activeValues={fundingFilter.filters.company} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="title" label="Project Title" allValues={fundingAllValues.title} activeValues={fundingFilter.filters.title} onApply={fundingFilter.setFilter} className="w-[30%]" />
                  <Th className="w-[15%]">Award</Th>
                  <HierarchicalDateFilter label="Award Date" sortDir={fundingDateCol.sortDir} onCycleSort={fundingDateCol.cycleSortDir} allRawDates={fundingRawDates} activeDateKeys={fundingDateCol.dateFilter} onApplyFilter={fundingDateCol.setDateFilter} className="w-[10%]" />
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

      {/* ── Jobs Section ─────────────────────────────────────────────────── */}
      {!loading && (data.clayJobs || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">Jobs</h2>
          <ClearAllFiltersButton
            hasActiveFilters={jobsFilter.hasActiveFilters || jobsDateCol.hasDateFilter}
            onClear={() => { jobsFilter.clearAll(); jobsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={jobAllValues.company} activeValues={jobsFilter.filters.company} onApply={jobsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Job Title" allValues={jobAllValues.title} activeValues={jobsFilter.filters.title} onApply={jobsFilter.setFilter} className="w-[30%]" />
                  <ColumnFilterDropdown colKey="location" label="Location" allValues={jobAllValues.location} activeValues={jobsFilter.filters.location} onApply={jobsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[10%]">Domain</Th>
                  <HierarchicalDateFilter label="Date Posted" sortDir={jobsDateCol.sortDir} onCycleSort={jobsDateCol.cycleSortDir} allRawDates={jobsRawDates} activeDateKeys={jobsDateCol.dateFilter} onApplyFilter={jobsDateCol.setDateFilter} className="w-[10%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredJobs.map((job, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const displayName = getJobDisplayName(job)
                  const isClient = isPastClient(displayName)
                  return (
                    <tr key={job.id} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {isClient && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                        {displayName || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-white align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.job_title || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.location || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{job.company_domain || '—'}</td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>{formatClayDate(job.date_posted)}</td>
                      <td className="px-3 py-3 text-sm align-top">
                        {job.job_url ? (
                          <a href={job.job_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-medium">View Job &#8599;</a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── News Section ─────────────────────────────────────────────────── */}
      {!loading && (data.newsArticles || []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-base font-semibold">News</h2>
          <ClearAllFiltersButton
            hasActiveFilters={newsFilter.hasActiveFilters || newsDateCol.hasDateFilter}
            onClear={() => { newsFilter.clearAll(); newsDateCol.clearDateFilter() }}
          />
          <div className="rounded-lg border border-[#374151] overflow-hidden">
            <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <ColumnFilterDropdown colKey="company" label="Company" allValues={newsAllValues.company} activeValues={newsFilter.filters.company} onApply={newsFilter.setFilter} className="w-[20%]" />
                  <ColumnFilterDropdown colKey="title" label="Title" allValues={newsAllValues.title} activeValues={newsFilter.filters.title} onApply={newsFilter.setFilter} className="w-[35%]" />
                  <HierarchicalDateFilter label="Date" sortDir={newsDateCol.sortDir} onCycleSort={newsDateCol.cycleSortDir} allRawDates={newsRawDates} activeDateKeys={newsDateCol.dateFilter} onApplyFilter={newsDateCol.setDateFilter} className="w-[15%]" />
                  <ColumnFilterDropdown colKey="source" label="Source" allValues={newsAllValues.source} activeValues={newsFilter.filters.source} onApply={newsFilter.setFilter} className="w-[15%]" />
                  <Th className="w-[15%]">Link</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#374151]">
                {filteredNews.map((article, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
                  const names = Array.isArray(article.matched_names) ? article.matched_names : []
                  return (
                    <tr key={article.url} className={`${rowBg} transition-colors`}>
                      <td className="px-3 py-3 text-sm text-gray-200 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        <div className="flex flex-col gap-1">
                          {names.length === 0 && <span className="text-gray-600">—</span>}
                          {names.map(n => (
                            <span key={n} className="text-gray-100">
                              {isPastClient(n) && <span className="text-yellow-400 mr-1" title="Past client">&#9733;</span>}
                              {n}
                            </span>
                          ))}
                          <button
                            onClick={() => setAssignArticle(article)}
                            className="self-start mt-1 text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:bg-blue-600/20 transition-colors"
                          >
                            {names.length > 0 ? 'Edit' : '+ Assign'}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm font-semibold text-gray-100 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.title || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-400 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article.date ? formatDate(article.date) : '—'}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-300 align-top" style={{ whiteSpace: 'normal', wordWrap: 'break-word' }}>
                        {article._source || '—'}
                      </td>
                      <td className="px-3 py-3 text-sm align-top">
                        {article.url ? (
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 font-medium"
                          >
                            Read Article &#8599;
                          </a>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assignArticle && (
        <AssignCompanyModal
          article={assignArticle}
          onClose={() => setAssignArticle(null)}
          onSaved={(newMatches) => updateNewsMatches(assignArticle.url, newMatches)}
        />
      )}
    </div>
  )
}

function pastBuyerCompanyChanged(row) {
  const orig = (row.original_company || '').trim().toLowerCase()
  const curr = (row.current_company || '').trim().toLowerCase()
  if (!orig || !curr) return false
  return orig !== curr
}

function pastBuyerRoleChanged(row) {
  const origCompany = (row.original_company || '').trim().toLowerCase()
  const currCompany = (row.current_company || '').trim().toLowerCase()
  if (!origCompany || !currCompany || origCompany !== currCompany) return false
  const origTitle = (row.original_title || '').trim().toLowerCase()
  const currTitle = (row.current_title || '').trim().toLowerCase()
  if (!origTitle || !currTitle) return false
  return origTitle !== currTitle
}

function PastBuyersPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  useEffect(() => {
    fetch('/api/contacts?table=past_buyers')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const toggleRow = useCallback(id => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const extractors = useMemo(() => ({
    person_name: r => r.person_name || '',
    current_title: r => r.current_title || '',
    current_company: r => r.current_company || '',
    original_title: r => r.original_title || '',
    original_company: r => r.original_company || '',
    current_location: r => r.current_location || '',
  }), [])

  const allValues = useMemo(() => ({
    person_name: rows.map(r => r.person_name || ''),
    current_title: rows.map(r => r.current_title || ''),
    current_company: rows.map(r => r.current_company || ''),
    original_title: rows.map(r => r.original_title || ''),
    original_company: rows.map(r => r.original_company || ''),
    current_location: rows.map(r => r.current_location || ''),
  }), [rows])

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const aRank = pastBuyerCompanyChanged(a) ? 0 : pastBuyerRoleChanged(a) ? 1 : 2
      const bRank = pastBuyerCompanyChanged(b) ? 0 : pastBuyerRoleChanged(b) ? 1 : 2
      if (aRank !== bRank) return aRank - bRank
      return (a.person_name || '').localeCompare(b.person_name || '')
    })
    return arr
  }, [rows])

  const filtered = useMemo(() => applyFilters(sorted, extractors), [sorted, applyFilters, extractors])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-gray-400 text-sm">Contacts at companies that have purchased staffing services.</p>
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="person_name"      label="Full Name"        allValues={allValues.person_name}      activeValues={filters.person_name}      onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="current_title"    label="Current Role"     allValues={allValues.current_title}    activeValues={filters.current_title}    onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="current_company"  label="Current Company"  allValues={allValues.current_company}  activeValues={filters.current_company}  onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="original_title"   label="Former Role"      allValues={allValues.original_title}   activeValues={filters.original_title}   onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="original_company" label="Former Company"   allValues={allValues.original_company} activeValues={filters.original_company} onApply={setFilter} className="w-[13%]" />
              <ColumnFilterDropdown colKey="current_location" label="Current Location" allValues={allValues.current_location} activeValues={filters.current_location} onApply={setFilter} className="w-[13%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm">Loading…</p></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">No past buyers found.</p></td></tr>
            ) : filtered.map((row, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const isExpanded = expandedIds.has(row.id)
              const companyChanged = pastBuyerCompanyChanged(row)
              const roleChanged = pastBuyerRoleChanged(row)
              return (
                <Fragment key={row.id}>
                  <tr
                    onClick={() => toggleRow(row.id)}
                    className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.person_name || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_title || '—'}</span>
                        {roleChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
                            Role Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_company || '—'}</span>
                        {companyChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 whitespace-nowrap">
                            Company Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_title || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_company || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.current_location || '—'}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Email</span>
                            {row.original_email
                              ? <a href={`mailto:${row.original_email}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{row.original_email}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Phone</span>
                            {row.phone
                              ? <a href={`tel:${row.phone}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.phone}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1 sm:col-span-2">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">LinkedIn</span>
                            {row.linkedin_url
                              ? <a href={row.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{row.linkedin_url}</a>
                              : <span className="text-sm text-gray-500">—</span>}
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

function PastCandidatesPage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const { filters, setFilter, clearAll, hasActiveFilters, applyFilters } = useColumnFilters()

  useEffect(() => {
    fetch('/api/contacts?table=past_candidates')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const toggleRow = useCallback(id => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const extractors = useMemo(() => ({
    person_name: r => r.person_name || '',
    current_title: r => r.current_title || '',
    current_company: r => r.current_company || '',
    original_title: r => r.original_title || '',
    original_company: r => r.original_company || '',
    current_location: r => r.current_location || '',
  }), [])

  const allValues = useMemo(() => ({
    person_name: rows.map(r => r.person_name || ''),
    current_title: rows.map(r => r.current_title || ''),
    current_company: rows.map(r => r.current_company || ''),
    original_title: rows.map(r => r.original_title || ''),
    original_company: rows.map(r => r.original_company || ''),
    current_location: rows.map(r => r.current_location || ''),
  }), [rows])

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const aRank = pastBuyerCompanyChanged(a) ? 0 : pastBuyerRoleChanged(a) ? 1 : 2
      const bRank = pastBuyerCompanyChanged(b) ? 0 : pastBuyerRoleChanged(b) ? 1 : 2
      if (aRank !== bRank) return aRank - bRank
      return (a.person_name || '').localeCompare(b.person_name || '')
    })
    return arr
  }, [rows])

  const filtered = useMemo(() => applyFilters(sorted, extractors), [sorted, applyFilters, extractors])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-gray-400 text-sm">Candidates previously placed or engaged with through staffing services.</p>
      <ClearAllFiltersButton hasActiveFilters={hasActiveFilters} onClear={clearAll} />
      <div className="rounded-lg border border-[#374151] overflow-hidden">
        <table className="w-full divide-y divide-[#374151]" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <ColumnFilterDropdown colKey="person_name"      label="Full Name"        allValues={allValues.person_name}      activeValues={filters.person_name}      onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="current_title"    label="Current Role"     allValues={allValues.current_title}    activeValues={filters.current_title}    onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="current_company"  label="Current Company"  allValues={allValues.current_company}  activeValues={filters.current_company}  onApply={setFilter} className="w-[15%]" />
              <ColumnFilterDropdown colKey="original_title"   label="Former Role"      allValues={allValues.original_title}   activeValues={filters.original_title}   onApply={setFilter} className="w-[17%]" />
              <ColumnFilterDropdown colKey="original_company" label="Former Company"   allValues={allValues.original_company} activeValues={filters.original_company} onApply={setFilter} className="w-[13%]" />
              <ColumnFilterDropdown colKey="current_location" label="Current Location" allValues={allValues.current_location} activeValues={filters.current_location} onApply={setFilter} className="w-[13%]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#374151]">
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm">Loading…</p></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-12 text-center"><p className="text-gray-500 text-sm italic">No past candidates found.</p></td></tr>
            ) : filtered.map((row, i) => {
              const rowBg = i % 2 === 0 ? 'bg-[#1f2937]' : 'bg-[#18202e]'
              const isExpanded = expandedIds.has(row.id)
              const companyChanged = pastBuyerCompanyChanged(row)
              const roleChanged = pastBuyerRoleChanged(row)
              return (
                <Fragment key={row.id}>
                  <tr
                    onClick={() => toggleRow(row.id)}
                    className={`${rowBg} hover:bg-[#263045] cursor-pointer transition-colors`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold text-gray-100" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.person_name || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_title || '—'}</span>
                        {roleChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
                            Role Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      <div className="flex flex-wrap items-start gap-1.5">
                        <span>{row.current_company || '—'}</span>
                        {companyChanged && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 whitespace-nowrap">
                            Company Changed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_title || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-300" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.original_company || '—'}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400" style={{ whiteSpace: 'normal', wordWrap: 'break-word', overflowWrap: 'anywhere' }}>
                      {row.current_location || '—'}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="bg-[#263045] px-8 py-5 border-b border-[#374151]">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Email</span>
                            {row.email
                              ? <a href={`mailto:${row.email}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{row.email}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Phone</span>
                            {row.phone
                              ? <a href={`tel:${row.phone}`} onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline">{row.phone}</a>
                              : <span className="text-sm text-gray-500">—</span>}
                          </div>
                          <div className="flex flex-col gap-1 sm:col-span-2">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">LinkedIn</span>
                            {row.linkedin_url
                              ? <a href={row.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-sm text-blue-400 hover:text-blue-300 hover:underline break-all">{row.linkedin_url}</a>
                              : <span className="text-sm text-gray-500">—</span>}
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
  const [repName, setRepName]           = useState('')
  const [showNameModal, setShowNameModal] = useState(false)
  const [expandedRows, setExpandedRows] = useState(new Set())
  const [notes, setNotes]               = useState({})
  const [savingNotes, setSavingNotes]   = useState(new Set())
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
    fetchSidebarCounts()
  }, [fetchSignals, fetchSidebarCounts])

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

  const tabCounts = {
    madison_leads:  sidebarCounts.madison_leads || 0,
    jim_leads:      sidebarCounts.jim_leads || 0,
    tim_leads:      sidebarCounts.tim_leads || 0,
    clinical_new:   sidebarCounts.clinical_new || 0,
    ma_funding_new: sidebarCounts.ma_funding_new || 0,
    funding_new:    sidebarCounts.funding_new || 0,
    jobs_new:       sidebarCounts.jobs_new || 0,
    competitor_jobs_new: sidebarCounts.competitor_jobs_new || 0,
    news:           sidebarCounts.news || 0,
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

  const saveRepName = (name) => {
    setRepName(name)
    localStorage.setItem('biosignal_rep_name', name)
    document.cookie = `biosignal_rep_name=${encodeURIComponent(name)}; path=/`
    setShowNameModal(false)
  }

  return (
    <div className="flex min-h-screen bg-[#111827]">
      <Sidebar activePage={activePage} setActivePage={setActivePage} tabCounts={tabCounts} />

      <div className="flex-1 lg:ml-[220px] ml-16 min-w-0 flex flex-col">
        <TopBar
          activePage={activePage}
          repName={repName}
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
              {activePage === 'dashboard'  && <CompanyDashboardPage />}
              {activePage === 'clinical_new' && <ClinicalTrialsNewPage />}
              {activePage === 'ma_funding_new' && <MAFundingNewPage />}
              {activePage === 'funding_new' && <FundingNewPage />}
              {activePage === 'jobs_new' && <JobsNewPage />}
              {activePage === 'competitor_jobs_new' && <CompetitorJobsNewPage />}
              {activePage === 'news' && <NewsPage />}
              {activePage === 'madison_leads' && <MadisonLeadsPage />}
              {activePage === 'jim_leads' && <JimLeadsPage />}
              {activePage === 'tim_leads' && <TimLeadsPage />}
              {activePage === 'buyers'     && <PastBuyersPage />}
              {activePage === 'candidates' && <PastCandidatesPage />}
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
