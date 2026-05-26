import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabaseClient'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const emailRef = useRef(null)

  useEffect(() => {
    if (!supabase) {
      setError('Supabase auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.')
      return
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (data?.session) {
        router.replace('/')
      } else if (emailRef.current) {
        emailRef.current.focus()
      }
    })
    return () => { cancelled = true }
  }, [router])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) {
      setError('Please enter your email and password.')
      return
    }
    if (!supabase) {
      setError('Supabase auth is not configured.')
      return
    }
    setSubmitting(true)
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (authError) {
        const msg = (authError.message || '').toLowerCase()
        if (msg.includes('invalid login')) {
          setError('Incorrect email or password.')
        } else if (msg.includes('email not confirmed')) {
          setError('Email not confirmed. Check your invite link.')
        } else {
          setError(authError.message || 'Sign in failed.')
        }
        setSubmitting(false)
        return
      }
      if (data?.session) {
        router.replace('/')
      } else {
        setError('Sign in failed.')
        setSubmitting(false)
      }
    } catch (err) {
      setError(err?.message || 'Sign in failed.')
      setSubmitting(false)
    }
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
          <h2 className="text-white text-lg font-bold mb-1">Sign in</h2>
          <p className="text-gray-400 text-sm mb-6">Access your BioSignal account.</p>

          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Email
          </label>
          <input
            ref={emailRef}
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(null) }}
            placeholder="you@company.com"
            className="w-full bg-[#111827] border border-[#374151] focus:border-blue-500 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none mb-4"
            disabled={submitting}
          />

          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Password
          </label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(null) }}
            placeholder="••••••••"
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
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>

          <p className="text-gray-500 text-xs mt-5 text-center">
            Access is by invitation only.
          </p>
        </form>
      </div>
    </div>
  )
}
