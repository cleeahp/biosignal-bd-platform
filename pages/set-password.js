import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabaseClient'

export default function SetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(true)
  const passwordRef = useRef(null)

  useEffect(() => {
    if (!supabase) {
      setError('Supabase auth is not configured.')
      setChecking(false)
      return
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (!data?.session) {
        router.replace('/login')
        return
      }
      setChecking(false)
      if (passwordRef.current) passwordRef.current.focus()
    })
    return () => { cancelled = true }
  }, [router])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!password || !confirmPassword) {
      setError('Please fill in both fields.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (!supabase) {
      setError('Supabase auth is not configured.')
      return
    }
    setSubmitting(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError(updateError.message || 'Failed to set password.')
        setSubmitting(false)
        return
      }
      router.replace('/')
    } catch (err) {
      setError(err?.message || 'Failed to set password.')
      setSubmitting(false)
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#111827]">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#111827] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-md bg-blue-600 flex items-center justify-center shrink-0">
            <span className="text-white text-base font-bold select-none">B</span>
          </div>
          <div className="text-left">
            <div className="text-white font-bold text-base leading-tight">BioSignal</div>
            <div className="text-blue-400/60 text-[10px] font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#1f2937] border border-[#374151] rounded-xl p-8 shadow-2xl"
        >
          <h2 className="text-white text-lg font-bold mb-1">Set Your Password</h2>
          <p className="text-gray-400 text-sm mb-6">Choose a password to finish setting up your account.</p>

          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            New Password
          </label>
          <input
            ref={passwordRef}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(null) }}
            placeholder="At least 8 characters"
            className="w-full bg-[#111827] border border-[#374151] focus:border-blue-500 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none mb-4"
            disabled={submitting}
          />

          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Confirm Password
          </label>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => { setConfirmPassword(e.target.value); setError(null) }}
            placeholder="Re-enter password"
            className="w-full bg-[#111827] border border-[#374151] focus:border-blue-500 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none mb-4"
            disabled={submitting}
          />

          {error && (
            <div className="mb-4 px-3 py-2 rounded-md bg-red-900/40 border border-red-700/60 text-red-200 text-xs">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-wait text-white font-semibold rounded-lg transition-colors text-sm"
          >
            {submitting ? 'Setting password…' : 'Set Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
