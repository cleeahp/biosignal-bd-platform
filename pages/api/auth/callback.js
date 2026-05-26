import { createServerClient } from '@supabase/ssr'
import { serialize } from 'cookie'

export default async function handler(req, res) {
  const code = req.query.code
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/')
    ? req.query.next
    : '/set-password'

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    res.redirect(302, '/login?error=auth_not_configured')
    return
  }

  if (!code) {
    res.redirect(302, '/login?error=missing_code')
    return
  }

  const setCookieHeaders = []
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return Object.entries(req.cookies || {}).map(([name, value]) => ({ name, value }))
        },
        setAll(cookies) {
          for (const { name, value, options } of cookies) {
            setCookieHeaders.push(serialize(name, value, { ...options, path: options?.path || '/' }))
          }
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (setCookieHeaders.length) {
    res.setHeader('Set-Cookie', setCookieHeaders)
  }

  if (error) {
    res.redirect(302, `/login?error=${encodeURIComponent(error.message || 'auth_error')}`)
    return
  }

  res.redirect(302, next)
}
