import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const realtimeClient =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null

// ─── Signal type metadata ──────────────────────────────────────────────────────
const SIGNAL_META = {
  clinical_trial_phase_transition: { label: 'Phase Transition', color: 'bg-blue-100 text-blue-800' },
  clinical_trial_new_ind:          { label: 'New IND',          color: 'bg-cyan-100 text-cyan-800' },
  clinical_trial_site_activation:  { label: 'Site Activation',  color: 'bg-teal-100 text-teal-800' },
  clinical_trial_completion:       { label: 'Trial Completion',  color: 'bg-purple-100 text-purple-800' },
  funding_new_award:               { label: 'New Award',         color: 'bg-green-100 text-green-800' },
  funding_renewal:                 { label: 'Funding Renewal',   color: 'bg-lime-100 text-lime-800' },
  ma_acquirer:                     { label: 'M&A Acquirer',      color: 'bg-orange-100 text-orange-800' },
  ma_acquired:                     { label: 'M&A Acquired',      color: 'bg-amber-100 text-amber-800' },
  competitor_job_posting:          { label: 'Competitor Job',    color: 'bg-red-100 text-red-800' },
  stale_job_posting:               { label: 'Stale Job',         color: 'bg-gray-100 text-gray-700' },
}

const WARMTH_META = {
  active_client: { label: 'Active Client', color: 'bg-green-500 text-white' },
  past_client:   { label: 'Past Client',   color: 'bg-blue-500 text-white' },
  in_ats:        { label: 'In ATS',        color: 'bg-gray-400 text-white' },
  new_prospect:  { label: 'New Prospect',  color: 'border border-gray-300 text-gray-600' },
}

const KANBAN_COLUMNS = [
  { key: 'new',             label: 'New Signals' },
  { key: 'carried_forward', label: 'Carried Forward' },
  { key: 'claimed',         label: 'Claimed' },
  { key: 'contacted',       label: 'Contacted' },
  { key: 'closed',          label: 'Closed' },
]

const ALL_SIGNAL_TYPES = Object.keys(SIGNAL_META)
const ALL_WARMTH_TYPES = Object.keys(WARMTH_META)

// ─── Signal-type column definitions ───────────────────────────────────────────
// Each entry defines the columns shown for that signal type in the table view.
// 'key' is the path into signal_detail (or a computed value), 'label' is the header.
const SIGNAL_TYPE_COLUMNS = {
  clinical_trial_phase_transition: [
    { label: 'Transition',    key: 'transition',    render: (d) => d ? `${d.phase_from || '?'} → ${d.phase_to || '?'}` : '—' },
    { label: 'Study Summary', key: 'study_summary', render: (d) => d?.study_summary || d?.nct_id || '—' },
    { label: 'Date Updated',  key: 'date_updated',  render: (d) => fmtDate(d?.date_updated) },
  ],
  clinical_trial_new_ind: [
    { label: 'Phase',         key: 'phases',        render: (d) => (d?.phases || []).join(', ') || 'Phase 1' },
    { label: 'Study Summary', key: 'study_summary', render: (d) => d?.study_summary || '—' },
    { label: 'Date Updated',  key: 'date_updated',  render: (d) => fmtDate(d?.date_updated) },
  ],
  clinical_trial_site_activation: [
    { label: 'Sites',         key: 'n_locations',   render: (d) => d?.n_locations ? `${d.n_locations} sites` : '—' },
    { label: 'Study Summary', key: 'study_summary', render: (d) => d?.study_summary || '—' },
    { label: 'Date Updated',  key: 'date_updated',  render: (d) => fmtDate(d?.date_updated) },
  ],
  clinical_trial_completion: [
    { label: 'Days to Close', key: 'days_until_completion', render: (d) => d?.days_until_completion != null ? `${d.days_until_completion}d` : '—' },
    { label: 'Study Summary', key: 'study_summary',         render: (d) => d?.study_summary || '—' },
    { label: 'Completion',    key: 'primary_completion_date', render: (d) => fmtDate(d?.primary_completion_date) },
  ],
  funding_new_award: [
    { label: 'Funding Type',  key: 'funding_type',    render: (d) => fmtFundingType(d?.funding_type) },
    { label: 'Amount',        key: 'funding_amount',  render: (d) => d?.funding_amount || '—' },
    { label: 'Summary',       key: 'funding_summary', render: (d) => trunc(d?.funding_summary, 80) },
    { label: 'Date',          key: 'date_announced',  render: (d) => fmtDate(d?.date_announced) },
  ],
  funding_renewal: [
    { label: 'Funding Type',  key: 'funding_type',    render: (d) => fmtFundingType(d?.funding_type) },
    { label: 'Amount',        key: 'funding_amount',  render: (d) => d?.funding_amount || '—' },
    { label: 'Summary',       key: 'funding_summary', render: (d) => trunc(d?.funding_summary, 80) },
    { label: 'Date',          key: 'date_announced',  render: (d) => fmtDate(d?.date_announced) },
  ],
  ma_acquirer: [
    { label: 'Deal Summary', key: 'funding_summary', render: (d) => trunc(d?.funding_summary || d?.description, 100) },
    { label: 'Date',         key: 'date_announced',  render: (d) => fmtDate(d?.date_announced) },
  ],
  ma_acquired: [
    { label: 'Deal Summary', key: 'funding_summary', render: (d) => trunc(d?.funding_summary || d?.description, 100) },
    { label: 'Date',         key: 'date_announced',  render: (d) => fmtDate(d?.date_announced) },
  ],
  competitor_job_posting: [
    { label: 'Role',             key: 'job_title',              render: (d) => d?.job_title || '—' },
    { label: 'Location',         key: 'job_location',           render: (d) => d?.job_location || '—' },
    { label: 'Competitor Firm',  key: 'competitor_firm',        render: (d) => d?.competitor_firm || '—' },
    { label: 'Likely Client',    key: 'likely_client',          render: (d) => likelyClientCell(d) },
    { label: 'Posted',           key: 'posting_date',           render: (d) => fmtDate(d?.posting_date) },
  ],
  stale_job_posting: [
    { label: 'Role',        key: 'job_title',    render: (d) => d?.job_title || '—' },
    { label: 'Location',    key: 'job_location', render: (d) => d?.job_location || '—' },
    { label: 'Date Posted', key: 'date_posted',  render: (d) => fmtDate(d?.date_posted) },
    { label: 'Days Posted', key: 'days_posted',  render: (d) => d?.days_posted != null ? `${d.days_posted}d` : '—' },
  ],
}

// Default columns for signal types without specific definitions
const DEFAULT_COLUMNS = [
  { label: 'Summary', key: 'summary', render: () => null }, // uses signal_summary instead
]

function getColumnsForType(signalType) {
  return SIGNAL_TYPE_COLUMNS[signalType] || DEFAULT_COLUMNS
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '—'
  const d = new Date(str)
  if (isNaN(d)) return str
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

function fmtFundingType(type) {
  const map = {
    venture_capital: 'VC Round',
    ipo: 'IPO',
    pharma_partnership: 'Partnership',
    government_grant: 'Gov Grant',
    acquisition: 'Acquisition',
  }
  return map[type] || type || '—'
}

function likelyClientCell(d) {
  if (!d?.likely_client || d.likely_client === 'Unknown') return <span className="text-gray-400">Unknown</span>
  const conf = d?.likely_client_confidence
  const color = conf === 'high' ? 'text-green-700' : conf === 'medium' ? 'text-amber-700' : 'text-gray-500'
  return (
    <span>
      <span className="font-medium">{d.likely_client}</span>
      {conf && <span className={`ml-1 text-xs ${color}`}>({conf})</span>}
    </span>
  )
}

function trunc(str, max = 80) {
  if (!str) return '—'
  return str.length > max ? str.slice(0, max) + '…' : str
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function initials(name) {
  if (!name) return '?'
  return name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).slice(0, 2).join('')
}

// ─── SignalTypeBadge ───────────────────────────────────────────────────────────
function SignalTypeBadge({ type }) {
  const meta = SIGNAL_META[type] || { label: type, color: 'bg-gray-100 text-gray-700' }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${meta.color}`}>
      {meta.label}
    </span>
  )
}

// ─── WarmthBadge ──────────────────────────────────────────────────────────────
function WarmthBadge({ warmth }) {
  const meta = WARMTH_META[warmth] || WARMTH_META.new_prospect
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${meta.color}`}>
      {meta.label}
    </span>
  )
}

// ─── ContactStatusBadge ────────────────────────────────────────────────────────
function ContactStatusBadge({ hasContacts }) {
  if (hasContacts) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
        Contact Ready
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 inline-block" />
      Contact Needed
    </span>
  )
}

// ─── ClaimButton ──────────────────────────────────────────────────────────────
function ClaimButton({ signal, currentRep, onClaim }) {
  const claimed = signal.claimed_by && signal.claimed_by.trim() !== ''
  const claimedByMe = claimed && signal.claimed_by === currentRep

  if (!claimed) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClaim(signal.id, currentRep) }}
        className="px-3 py-1 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700 transition"
      >
        Claim
      </button>
    )
  }
  if (claimedByMe) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClaim(signal.id, '') }}
        className="px-3 py-1 text-xs font-semibold rounded bg-blue-100 text-blue-700 border border-blue-300 hover:bg-blue-200 transition"
      >
        Claimed by You
      </button>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gray-200 text-gray-700 text-xs font-bold"
      title={signal.claimed_by}
      onClick={(e) => e.stopPropagation()}
    >
      {initials(signal.claimed_by)}
    </span>
  )
}

// ─── SignalDetailCard: expandable row content ──────────────────────────────────
function SignalDetailCard({ signal }) {
  const detail = signal.signal_detail || {}

  return (
    <div className="bg-blue-50 border-t border-blue-100 px-6 py-4">
      <div className="flex flex-wrap gap-6">
        {/* Left: structured fields from signal_detail */}
        <div className="flex-1 min-w-0">
          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Signal Detail</h4>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            {Object.entries(detail)
              .filter(([k, v]) => v != null && v !== '' && k !== 'sample_titles')
              .map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-gray-400 font-medium capitalize">{key.replace(/_/g, ' ')}</dt>
                  <dd className="text-gray-800 truncate max-w-xs">
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </dd>
                </div>
              ))}
          </dl>
          {/* Sample titles for competitor job signals */}
          {Array.isArray(detail.sample_titles) && detail.sample_titles.length > 0 && (
            <div className="mt-2">
              <span className="text-xs font-medium text-gray-400">Sample Roles: </span>
              <span className="text-xs text-gray-700">{detail.sample_titles.slice(0, 8).join(' · ')}</span>
            </div>
          )}
        </div>

        {/* Right: metadata */}
        <div className="w-48 shrink-0">
          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Metadata</h4>
          <div className="space-y-1.5 text-xs">
            <div>
              <span className="text-gray-400">Score: </span>
              <span className="font-semibold text-blue-700">{signal.priority_score}</span>
            </div>
            <div>
              <span className="text-gray-400">Status: </span>
              <span className="capitalize">{signal.status}</span>
            </div>
            {signal.claimed_by && (
              <div>
                <span className="text-gray-400">Claimed: </span>
                <span>{signal.claimed_by}</span>
              </div>
            )}
            {signal.days_in_queue > 0 && (
              <div>
                <span className="text-gray-400">In Queue: </span>
                <span className={signal.days_in_queue >= 7 ? 'text-red-600 font-semibold' : ''}>{signal.days_in_queue}d</span>
              </div>
            )}
          </div>
          {signal.source_url && !signal.source_url.includes('#') && (
            <a
              href={signal.source_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-3 block text-xs text-blue-600 hover:underline truncate"
            >
              View source ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── RepModal ─────────────────────────────────────────────────────────────────
function RepModal({ onSave }) {
  const [name, setName] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Welcome to BioSignal</h2>
        <p className="text-gray-500 text-sm mb-6">Enter your name so teammates can see who claimed leads.</p>
        <input
          autoFocus
          type="text"
          placeholder="Your full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          disabled={!name.trim()}
          onClick={() => onSave(name.trim())}
          className="w-full bg-blue-600 text-white rounded-lg py-2 font-semibold text-sm disabled:opacity-40 hover:bg-blue-700 transition"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// ─── KanbanCard ───────────────────────────────────────────────────────────────
function KanbanCard({ signal, onDragStart }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, signal.id)}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 mb-2 cursor-grab active:cursor-grabbing hover:shadow-md transition"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-gray-800 text-sm leading-tight">{signal.company_name}</span>
        <span className="text-xs text-gray-400 whitespace-nowrap">#{signal.priority_score}</span>
      </div>
      <div className="mb-1.5">
        <SignalTypeBadge type={signal.signal_type} />
      </div>
      <p className="text-xs text-gray-500 line-clamp-2 mb-2">{signal.signal_summary}</p>
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{signal.days_in_queue ?? 0}d in queue</span>
        {signal.claimed_by && (
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-xs font-bold">
            {initials(signal.claimed_by)}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── KanbanColumn ─────────────────────────────────────────────────────────────
function KanbanColumn({ column, signals, onDrop, onDragOver, onDragStart }) {
  return (
    <div className="flex-1 min-w-0" onDragOver={onDragOver} onDrop={(e) => onDrop(e, column.key)}>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="font-semibold text-gray-700 text-sm">{column.label}</h3>
        <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-medium">{signals.length}</span>
      </div>
      <div className="min-h-32 bg-gray-50 rounded-xl p-2 border-2 border-dashed border-gray-200">
        {signals.map((s) => <KanbanCard key={s.id} signal={s} onDragStart={onDragStart} />)}
        {signals.length === 0 && <p className="text-center text-gray-300 text-xs pt-8">Drop signals here</p>}
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [signals, setSignals]           = useState([])
  const [stats, setStats]               = useState({ totalActive: 0, newToday: 0, claimed: 0 })
  const [lastUpdated, setLastUpdated]   = useState(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)
  const [currentRep, setCurrentRep]     = useState(null)
  const [showRepModal, setShowRepModal] = useState(false)
  const [editingRep, setEditingRep]     = useState(false)
  const [repInput, setRepInput]         = useState('')
  const [view, setView]                 = useState('table')
  const [filterTypes, setFilterTypes]   = useState([])
  const [filterWarmth, setFilterWarmth] = useState('')
  const [filterClaimed, setFilterClaimed] = useState('')
  const [sortBy, setSortBy]             = useState('priority_score')
  const [expandedRows, setExpandedRows] = useState(new Set())
  const dragSignalId = useRef(null)

  useEffect(() => {
    const stored = localStorage.getItem('biosignal_rep')
    if (stored) setCurrentRep(stored)
    else setShowRepModal(true)
  }, [])

  const fetchSignals = useCallback(async () => {
    try {
      const resp = await fetch('/api/signals')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      setSignals(json.signals || [])
      setStats(json.stats || { totalActive: 0, newToday: 0, claimed: 0 })
      setLastUpdated(json.lastUpdated)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSignals() }, [fetchSignals])

  useEffect(() => {
    if (!realtimeClient) return
    const channel = realtimeClient
      .channel('signals-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, () => fetchSignals())
      .subscribe()
    return () => { realtimeClient.removeChannel(channel) }
  }, [fetchSignals])

  const handleClaim = useCallback(async (signalId, repName) => {
    setSignals((prev) =>
      prev.map((s) => (s.id === signalId ? { ...s, claimed_by: repName, status: repName ? 'claimed' : 'new' } : s))
    )
    await fetch('/api/signals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: signalId, claimed_by: repName, status: repName ? 'claimed' : 'new' }),
    })
  }, [])

  const handleDragStart = useCallback((e, signalId) => {
    dragSignalId.current = signalId
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(async (e, targetStatus) => {
    e.preventDefault()
    const id = dragSignalId.current
    if (!id) return
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: targetStatus } : s)))
    await fetch('/api/signals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: targetStatus }),
    })
    dragSignalId.current = null
  }, [])

  const handleRepSave = useCallback((name) => {
    localStorage.setItem('biosignal_rep', name)
    setCurrentRep(name)
    setShowRepModal(false)
    setEditingRep(false)
  }, [])

  const toggleRow = useCallback((id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const filteredSignals = signals
    .filter((s) => {
      if (filterTypes.length > 0 && !filterTypes.includes(s.signal_type)) return false
      if (filterWarmth && s.relationship_warmth !== filterWarmth) return false
      if (filterClaimed === 'claimed' && (!s.claimed_by || s.claimed_by.trim() === '')) return false
      if (filterClaimed === 'unclaimed' && s.claimed_by && s.claimed_by.trim() !== '') return false
      if (filterClaimed === 'mine' && s.claimed_by !== currentRep) return false
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'priority_score') return (b.priority_score || 0) - (a.priority_score || 0)
      if (sortBy === 'company_name') return (a.company_name || '').localeCompare(b.company_name || '')
      if (sortBy === 'days_in_queue') return (b.days_in_queue || 0) - (a.days_in_queue || 0)
      return 0
    })

  const kanbanGroups = KANBAN_COLUMNS.reduce((acc, col) => {
    acc[col.key] = filteredSignals.filter((s) => s.status === col.key)
    return acc
  }, {})

  const formatDate = (iso) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const toggleTypeFilter = (type) => {
    setFilterTypes((prev) => prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type])
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      {showRepModal && <RepModal onSave={handleRepSave} />}

      {/* ── Header ── */}
      <header style={{ backgroundColor: '#0f172a' }} className="text-white px-6 py-4 shadow-lg">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-extrabold tracking-tight text-white">BioSignal</span>
              <span className="hidden sm:inline text-sm text-blue-300 font-medium mt-0.5">
                Daily BD Intelligence for Life Sciences Staffing
              </span>
            </div>
            {lastUpdated && <p className="text-xs text-slate-400 mt-0.5">Last updated: {formatDate(lastUpdated)}</p>}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-2">
              <span className="bg-blue-600 text-white text-xs font-bold px-3 py-1 rounded-full">{stats.totalActive} Active</span>
              <span className="bg-green-600 text-white text-xs font-bold px-3 py-1 rounded-full">{stats.newToday} New Today</span>
              <span className="bg-orange-500 text-white text-xs font-bold px-3 py-1 rounded-full">{stats.claimed} Claimed</span>
            </div>
            <div className="flex bg-slate-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setView('table')}
                className={`px-3 py-1.5 text-xs font-semibold transition ${view === 'table' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}`}
              >
                Table
              </button>
              <button
                onClick={() => setView('kanban')}
                className={`px-3 py-1.5 text-xs font-semibold transition ${view === 'kanban' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}`}
              >
                Kanban
              </button>
            </div>
            {editingRep ? (
              <div className="flex gap-1">
                <input
                  autoFocus type="text" value={repInput}
                  onChange={(e) => setRepInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && repInput.trim() && handleRepSave(repInput.trim())}
                  className="bg-slate-700 text-white text-xs px-2 py-1 rounded border border-slate-500 w-28 focus:outline-none"
                  placeholder="Your name"
                />
                <button onClick={() => repInput.trim() && handleRepSave(repInput.trim())} className="bg-blue-600 text-white text-xs px-2 py-1 rounded hover:bg-blue-700">Save</button>
              </div>
            ) : (
              <button
                onClick={() => { setRepInput(currentRep || ''); setEditingRep(true) }}
                className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition"
              >
                <span className="w-5 h-5 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">
                  {initials(currentRep || '?')}
                </span>
                {currentRep || 'Set Name'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Filters ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-screen-xl mx-auto flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs font-semibold text-gray-500 mr-1">Type:</span>
            {ALL_SIGNAL_TYPES.map((type) => {
              const meta = SIGNAL_META[type]
              const active = filterTypes.includes(type)
              return (
                <button
                  key={type}
                  onClick={() => toggleTypeFilter(type)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition font-medium ${
                    active ? meta.color + ' border-transparent' : 'border-gray-300 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  {meta.label}
                </button>
              )
            })}
            {filterTypes.length > 0 && (
              <button onClick={() => setFilterTypes([])} className="text-xs text-gray-400 hover:text-gray-600 underline ml-1">Clear</button>
            )}
          </div>
          <div className="h-4 w-px bg-gray-200 hidden sm:block" />
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-500">Relationship:</span>
            <select value={filterWarmth} onChange={(e) => setFilterWarmth(e.target.value)}
              className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">All</option>
              {ALL_WARMTH_TYPES.map((w) => <option key={w} value={w}>{WARMTH_META[w].label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-500">Claimed:</span>
            <select value={filterClaimed} onChange={(e) => setFilterClaimed(e.target.value)}
              className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">All</option>
              <option value="unclaimed">Unclaimed</option>
              <option value="claimed">Claimed</option>
              <option value="mine">Mine</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs font-semibold text-gray-500">Sort:</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="priority_score">Priority Score</option>
              <option value="company_name">Company Name</option>
              <option value="days_in_queue">Days in Queue</option>
            </select>
          </div>
          <button onClick={fetchSignals} className="ml-2 text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition font-semibold">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Main Content ── */}
      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {loading && (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">Loading signals...</div>
        )}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
            Failed to load signals: {error}
          </div>
        )}
        {!loading && !error && filteredSignals.length === 0 && (
          <div className="text-center py-20 text-gray-400">
            <p className="text-lg font-medium mb-1">No signals found</p>
            <p className="text-sm">Try adjusting your filters or run the orchestrator to generate signals.</p>
          </div>
        )}

        {/* ── TABLE VIEW ── */}
        {!loading && !error && view === 'table' && filteredSignals.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider w-12">#</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Company</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                    {/* Dynamic signal-type columns — shown for the most common type in current filter */}
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-48">Details</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Relationship</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider w-20">Days</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Claim</th>
                    <th className="px-4 py-3 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredSignals.map((signal, idx) => {
                    const cols = getColumnsForType(signal.signal_type)
                    const detail = signal.signal_detail || {}
                    const isExpanded = expandedRows.has(signal.id)

                    return (
                      <>
                        <tr
                          key={signal.id}
                          onClick={() => toggleRow(signal.id)}
                          className={`hover:bg-blue-50 transition cursor-pointer ${isExpanded ? 'bg-blue-50' : ''}`}
                        >
                          {/* Rank + score */}
                          <td className="px-4 py-3">
                            <div className="flex flex-col items-center">
                              <span className="text-xs font-bold text-gray-400">{idx + 1}</span>
                              <span className="text-xs font-semibold text-blue-600">{signal.priority_score}</span>
                            </div>
                          </td>

                          {/* Company */}
                          <td className="px-4 py-3">
                            <div className="font-semibold text-gray-900 text-sm">{signal.company_name}</div>
                            {signal.is_carried_forward && (
                              <span className="inline-block mt-0.5 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">
                                ↑ Carried
                              </span>
                            )}
                          </td>

                          {/* Signal Type badge */}
                          <td className="px-4 py-3">
                            <SignalTypeBadge type={signal.signal_type} />
                          </td>

                          {/* Signal-type-specific detail columns */}
                          <td className="px-4 py-3 text-xs text-gray-700">
                            {cols.length === 1 && cols[0].key === 'summary' ? (
                              // Default: show signal_summary
                              <span className="line-clamp-2 text-gray-600">{signal.signal_summary}</span>
                            ) : (
                              // Type-specific: show first 2 key fields inline
                              <div className="space-y-0.5">
                                {cols.slice(0, 2).map((col) => {
                                  const rendered = col.render(detail)
                                  return rendered ? (
                                    <div key={col.key} className="flex gap-1">
                                      <span className="text-gray-400 shrink-0">{col.label}:</span>
                                      <span className="text-gray-800 truncate max-w-48">{rendered}</span>
                                    </div>
                                  ) : null
                                })}
                              </div>
                            )}
                          </td>

                          {/* Relationship */}
                          <td className="px-4 py-3">
                            <WarmthBadge warmth={signal.relationship_warmth} />
                          </td>

                          {/* Days in queue */}
                          <td className="px-4 py-3">
                            <span className={`text-xs font-semibold ${signal.days_in_queue >= 7 ? 'text-red-600' : signal.days_in_queue >= 3 ? 'text-amber-600' : 'text-gray-500'}`}>
                              {signal.days_in_queue ?? 0}d
                            </span>
                          </td>

                          {/* Claim */}
                          <td className="px-4 py-3">
                            <ClaimButton signal={signal} currentRep={currentRep} onClaim={handleClaim} />
                          </td>

                          {/* Expand chevron */}
                          <td className="px-2 py-3 text-gray-400 text-xs">
                            {isExpanded ? '▲' : '▼'}
                          </td>
                        </tr>

                        {/* Expanded detail row */}
                        {isExpanded && (
                          <tr key={`${signal.id}-detail`}>
                            <td colSpan={8} className="p-0">
                              <SignalDetailCard signal={signal} />
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-400">
              Showing {filteredSignals.length} of {signals.length} signals · Click any row to expand details
            </div>
          </div>
        )}

        {/* ── KANBAN VIEW ── */}
        {!loading && !error && view === 'kanban' && (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {KANBAN_COLUMNS.map((col) => (
              <div key={col.key} className="min-w-56 flex-1">
                <KanbanColumn
                  column={col}
                  signals={kanbanGroups[col.key] || []}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragStart={handleDragStart}
                />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
