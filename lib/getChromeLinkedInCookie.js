/**
 * lib/getChromeLinkedInCookie.js
 *
 * Extracts the LinkedIn li_at session cookie directly from Chrome on Windows.
 *
 * Two extraction strategies are tried in order:
 *
 *  1. Chrome DevTools Protocol (CDP) — works while Chrome is running.
 *     Requires Chrome to be launched with --remote-debugging-port=9222.
 *     Enable once by editing your Chrome shortcut:
 *       Target: "C:\...\chrome.exe" --remote-debugging-port=9222
 *
 *  2. Cookies SQLite file (filesystem) — works when Chrome is NOT running.
 *     Chrome 127+ uses App-Bound Encryption (v20 prefix), which is not
 *     decryptable here; this path only works for Chrome < 127 cookies.
 *     Cookie format: b"v10" + 12-byte nonce + ciphertext + 16-byte GCM tag.
 *     AES key: base64(b"DPAPI" + DPAPI-encrypted key) in Local State.
 */

import { execSync }         from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join }             from 'node:path'
import { homedir }          from 'node:os'

const LOCALAPPDATA       = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
const CHROME_DIR         = join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
const CHROME_COOKIES     = join(CHROME_DIR, 'Default', 'Network', 'Cookies')
const CHROME_LOCAL_STATE = join(CHROME_DIR, 'Local State')

// ── Strategy 1: Chrome DevTools Protocol ─────────────────────────────────────
// Connects to Chrome's remote debugging port (localhost:9222) and uses the
// Network.getAllCookies CDP command to read all in-memory cookies.
// This works for Chrome 127+ (App-Bound Encryption) and while Chrome is running.
// Requires: chrome.exe --remote-debugging-port=9222

async function extractViaCDP(port = 9222) {
  // Check if Chrome DevTools Protocol is available
  let targets
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    targets = await resp.json()
  } catch {
    throw new Error(`Chrome remote debugging not available on port ${port}`)
  }

  // Find a connectable page target
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!target) throw new Error('No connectable Chrome page target found')

  // Connect via WebSocket and request all cookies
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')) }, 10_000)

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.id !== 1) return
        clearTimeout(timeout)
        ws.close()

        const cookies = msg.result?.cookies ?? []
        const liAt = cookies.find(c => c.name === 'li_at' && c.domain?.includes('linkedin'))
        if (!liAt) {
          reject(new Error('li_at cookie not found via CDP — is LinkedIn open in Chrome?'))
        } else {
          resolve(liAt.value)
        }
      } catch (e) {
        clearTimeout(timeout)
        ws.close()
        reject(e)
      }
    }

    ws.onerror = (err) => {
      clearTimeout(timeout)
      reject(new Error(`CDP WebSocket error: ${err.message ?? err}`))
    }
  })
}

// ── Strategy 2: Filesystem (Chrome not running or Chrome < 127) ───────────────
// Copies the SQLite Cookies DB (Chrome must be closed), decrypts the li_at
// cookie value using the DPAPI-protected AES key from Local State.

function dpApiDecrypt(encryptedBytes) {
  const base64 = Buffer.from(encryptedBytes).toString('base64')
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$enc = [Convert]::FromBase64String('${base64}')`,
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)',
  ].join('\n')

  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const result  = execSync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { encoding: 'utf8', timeout: 15_000 },
  )
  return Buffer.from(result.trim(), 'base64')
}

async function extractViaFilesystem() {
  if (!existsSync(CHROME_COOKIES)) {
    throw new Error(`Chrome cookie database not found at:\n  ${CHROME_COOKIES}`)
  }

  // node:sqlite is built-in from Node 22+ (DatabaseSync)
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdir, rm }    = await import('node:fs/promises')
  const { tmpdir }       = await import('node:os')

  const tmpSubDir = join(tmpdir(), `chrome-cookies-${Date.now()}`)
  const tmpPath   = join(tmpSubDir, 'Cookies')
  await mkdir(tmpSubDir, { recursive: true })

  // Use fs.copyFile — only works when Chrome is closed (no file lock)
  const { copyFile } = await import('node:fs/promises')
  try {
    await copyFile(CHROME_COOKIES, tmpPath)
  } catch (e) {
    await rm(tmpSubDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(
      `Cannot copy Chrome cookie database (Chrome may be running):\n  ${e.message}\n` +
      `Close Chrome and retry, or launch Chrome with --remote-debugging-port=9222.`,
    )
  }

  let db
  try {
    db = new DatabaseSync(tmpPath, { open: true })
    const row = db.prepare(
      `SELECT value, encrypted_value
       FROM cookies
       WHERE host_key LIKE '%linkedin.com%' AND name = 'li_at'
       LIMIT 1`,
    ).get()

    if (!row) throw new Error('li_at cookie not found in Chrome — sign in to LinkedIn first')
    if (row.value) return row.value

    const encryptedValue = Buffer.from(row.encrypted_value)
    if (encryptedValue.length === 0) throw new Error('li_at encrypted_value is empty')

    const localState = JSON.parse(readFileSync(CHROME_LOCAL_STATE, 'utf8'))
    const encryptedKeyB64 = localState?.os_crypt?.encrypted_key
    if (!encryptedKeyB64) {
      throw new Error(
        `os_crypt.encrypted_key not found — Chrome v127+ uses App-Bound Encryption.\n` +
        `Launch Chrome with --remote-debugging-port=9222 for auto-extraction.`,
      )
    }

    const withPrefix   = Buffer.from(encryptedKeyB64, 'base64')
    const encryptedKey = withPrefix.slice(5)
    const aesKey       = dpApiDecrypt(encryptedKey)

    const prefix = encryptedValue.slice(0, 3).toString('ascii')
    if (prefix !== 'v10') {
      throw new Error(
        `Unexpected cookie encryption prefix "${prefix}" — expected "v10".\n` +
        `Chrome v127+ uses App-Bound Encryption. Launch Chrome with --remote-debugging-port=9222.`,
      )
    }

    const nonce      = encryptedValue.slice(3, 15)
    const tag        = encryptedValue.slice(-16)
    const ciphertext = encryptedValue.slice(15, -16)

    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } finally {
    if (db) db.close()
    await rm(tmpSubDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function getChromeLinkedInCookie() {
  // Try CDP first (Chrome 127+ compatible, works while Chrome is running)
  try {
    return await extractViaCDP()
  } catch (cdpErr) {
    // CDP not available — fall through to filesystem approach
    if (!cdpErr.message.includes('not available') && !cdpErr.message.includes('timeout')) {
      // Surface real CDP errors (wrong cookie, WebSocket errors, etc.)
      throw cdpErr
    }
  }

  // Fallback: read the Cookies SQLite file (requires Chrome to be closed)
  return extractViaFilesystem()
}
