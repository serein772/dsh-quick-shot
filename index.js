/**
 * Host half of the Quick shot bundle.
 *
 * It owns one same-origin route (`POST /quick-shot/capture`). The browser half
 * asks it for a shot; the Host runs a small standalone helper that hides the
 * window, shows a rubber-band selection overlay, restores the window and answers
 * with the PNG as base64.
 *
 * The helper is a compiled C# executable (`helper.cs`), built once with the
 * in-box .NET Framework compiler and cached by source hash under
 * `%LOCALAPPDATA%\dsh-quick-shot`. A capture spawns it and waits, so there is no
 * warm process and no idle memory; process start plus overlay is ~0.3-0.5 s.
 * If compilation is unavailable, a one-shot PowerShell fallback (`capture.ps1`)
 * keeps the feature working.
 *
 * The route sits behind the Web carrier's trust check, so only the Harness page
 * can ask for a capture. Nothing is written to disk and no pixel leaves the
 * machine: the image travels page -> Host -> page.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CAPTURE_ROUTE = '/quick-shot/capture'
const HELPER_SOURCE = fileURLToPath(new URL('./helper.cs', import.meta.url))
const FALLBACK_SCRIPT = fileURLToPath(new URL('./capture.ps1', import.meta.url))
const BODY_LIMIT = 8 * 1024
const ERROR_LIMIT = 8 * 1024
const MIN_TIMEOUT_SECONDS = 15
const MAX_TIMEOUT_SECONDS = 180
const DEFAULT_TIMEOUT_SECONDS = 120
const HELPER_READY_WAIT_MS = 12000
const HELPER_GRACE_MS = 25000
const BUILD_TIMEOUT_MS = 60000

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Refuse a request the Web carrier does not trust. Fails closed when the
 * connection service is missing, because this route drives the user's desktop.
 */
function refused(ctx, req, res) {
  const connection = ctx.get('connection')
  let rejection
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      rejection = connection.requestRejection(req)
    } catch (error) {
      ctx.logger?.warn?.(`quick-shot: trust check failed: ${error?.message ?? String(error)}`)
      rejection = 403
    }
  } else {
    rejection = 403
  }
  if (rejection === undefined || rejection === null) return false
  sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
  return true
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    req.on('data', (chunk) => {
      if (settled || tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (tooLarge) {
        reject(httpError(413, 'request body too large'))
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        resolve(parsed)
      } catch {
        reject(httpError(400, 'invalid json body'))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function runHandler(res, work) {
  try {
    await work()
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

function clampTimeout(value) {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)))
}

function clampMode(value) {
  return value === 'window' ? 'window' : 'desktop'
}

function buildDirectory() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'dsh-quick-shot')
}

function findCompiler() {
  const windows = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Build (or reuse) the standalone helper. Resolves to the executable path; the
 * build result is memoized, and a failed build is retried on the next request.
 */
function createHelperBuilder(ctx) {
  let pending = null
  let built = null
  let lastError = null

  const build = () =>
    new Promise((resolve, reject) => {
      if (built !== null && existsSync(built.exe)) {
        resolve(built)
        return
      }
      const compiler = findCompiler()
      if (compiler === null) {
        reject(Object.assign(new Error('csc-not-found'), { code: 'csc-not-found' }))
        return
      }
      let source
      try {
        source = readFileSync(HELPER_SOURCE, 'utf8')
      } catch (error) {
        reject(Object.assign(new Error(`helper source unreadable: ${error?.message ?? String(error)}`), { code: 'build-failed' }))
        return
      }
      const key = createHash('sha256').update(source).digest('hex').slice(0, 12)
      const directory = buildDirectory()
      const exe = join(directory, `quick-shot-${key}.exe`)
      if (existsSync(exe)) {
        built = { exe, key, directory, compiler }
        resolve(built)
        return
      }
      try {
        mkdirSync(directory, { recursive: true })
      } catch (error) {
        reject(Object.assign(new Error(`build directory unavailable: ${error?.message ?? String(error)}`), { code: 'build-failed' }))
        return
      }
      const framework = dirname(compiler)
      let child
      try {
        child = spawn(
          compiler,
          [
            '/nologo',
            '/target:exe',
            '/optimize+',
            '/utf8output',
            `/out:${exe}`,
            `/reference:${join(framework, 'System.dll')}`,
            `/reference:${join(framework, 'System.Windows.Forms.dll')}`,
            `/reference:${join(framework, 'System.Drawing.dll')}`,
            HELPER_SOURCE,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        reject(Object.assign(new Error(`compiler did not start: ${error?.message ?? String(error)}`), { code: 'build-failed' }))
        return
      }
      let output = ''
      const collect = (chunk) => {
        if (output.length < ERROR_LIMIT) output += chunk.toString('utf8')
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        reject(Object.assign(new Error('helper build timed out'), { code: 'build-failed' }))
      }, BUILD_TIMEOUT_MS)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(Object.assign(new Error(`compiler error: ${error?.message ?? String(error)}`), { code: 'build-failed' }))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (!existsSync(exe)) {
          const detail = output.trim().split('\n').slice(-3).join(' | ')
          ctx.logger?.warn?.(`quick-shot: helper build failed (${code}): ${detail}`)
          reject(Object.assign(new Error('helper build failed'), { code: 'build-failed', detail }))
          return
        }
        built = { exe, key, directory, compiler }
        resolve(built)
      })
    })

  return {
    ready() {
      if (pending === null) {
        pending = build().catch((error) => {
          lastError = error?.detail ? `${error.message}: ${error.detail}` : String(error?.message ?? error)
          pending = null
          throw error
        })
      }
      return pending
    },
    peek() {
      return built
    },
    lastError() {
      return lastError
    },
  }
}

/**
 * Spawn the compiled helper for one capture. The helper prints a `started` line
 * first (so the Host can measure process start) and then one result line.
 */
function runHelper(helper, payload, timeoutSeconds) {
  return new Promise((resolve) => {
    const spawnStart = Date.now()
    const args = [
      '--title-b64',
      payload.titleB64,
      '--mode',
      payload.mode === 'window' ? 'window' : 'desktop',
      '--timeout',
      String(timeoutSeconds),
    ]
    if (payload.selfTest === true) args.push('--selftest')
    if (payload.autoDrag === true) args.push('--auto-drag')
    let child
    try {
      child = spawn(helper.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: false, error: 'spawn-failed' })
      return
    }
    let buffer = ''
    let stderr = ''
    let spawnMs = null
    let result = null
    let settled = false
    let killTimer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (killTimer !== null) clearTimeout(killTimer)
      resolve(value)
    }

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (trimmed === '') return
      let message = null
      try {
        message = JSON.parse(trimmed)
      } catch {
        return
      }
      if (message === null || typeof message !== 'object') return
      if (message.type === 'started') {
        spawnMs = Date.now() - spawnStart
        return
      }
      if (message.type === 'result') {
        result = message
        delete result.type
        if (spawnMs !== null) {
          result.timings = result.timings ?? {}
          result.timings.spawnMs = spawnMs
        }
        finish(result)
      }
    }

    killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'capture-timeout' })
    }, (timeoutSeconds + HELPER_GRACE_MS / 1000) * 1000)

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < ERROR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ ok: false, error: 'spawn-failed', detail: String(error?.message ?? error).slice(0, 300) })
    })
    child.on('close', () => {
      if (result !== null) return
      finish({ ok: false, error: 'helper-error', detail: stderr.slice(0, 300) })
    })
  })
}

/**
 * One-shot PowerShell fallback: slower start, but keeps the feature usable when
 * the in-box C# compiler is missing or the build fails.
 */
function runFallbackCapture({ titleB64, timeoutSeconds, activeChildren }) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'unsupported-platform' })
      return
    }
    const seconds = clampTimeout(timeoutSeconds)
    let child
    try {
      child = spawn(
        'powershell.exe',
        [
          '-STA',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          FALLBACK_SCRIPT,
          '-TitleB64',
          titleB64,
          '-TimeoutSeconds',
          String(seconds),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch {
      resolve({ ok: false, error: 'spawn-failed' })
      return
    }
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      activeChildren.delete(child)
      clearTimeout(killTimer)
      resolve(value)
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'capture-timeout' })
    }, (seconds + HELPER_GRACE_MS / 1000) * 1000)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 96 * 1024 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < ERROR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ ok: false, error: 'spawn-failed', detail: String(error?.message ?? error).slice(0, 300) })
    })
    child.on('close', (code) => {
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        parsed = null
      }
      if (parsed !== null && typeof parsed === 'object') {
        finish(parsed)
        return
      }
      finish({ ok: false, error: 'fallback-error', detail: (stderr || stdout || `exit ${code}`).slice(0, 300) })
    })
  })
}

export function apply(ctx) {
  const activeChildren = new Set()
  const builder = createHelperBuilder(ctx)
  let busy = false

  // Build the helper ahead of the first click; failure falls back to PowerShell.
  ctx.effect(() => {
    if (process.platform !== 'win32') return () => {}
    builder.ready().catch(() => {})
    return () => {}
  }, 'quick-shot: build capture helper')

  const captureOnce = async ({ titleB64, timeoutSeconds, mode, selfTest, autoDrag }) => {
    let helper = null
    try {
      const ready = await Promise.race([
        builder.ready(),
        new Promise((resolve) => setTimeout(() => resolve(null), HELPER_READY_WAIT_MS)),
      ])
      helper = ready ?? builder.peek()
    } catch {
      helper = null
    }
    if (helper !== null && existsSync(helper.exe)) {
      return runHelper(helper, { titleB64, mode, selfTest, autoDrag }, timeoutSeconds)
    }
    if (mode === 'window') return { ok: false, error: 'window-mode-unavailable' }
    return runFallbackCapture({ titleB64, timeoutSeconds, activeChildren })
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const server = child.webServer
      if (!server || typeof server.register !== 'function') {
        child.logger?.warn?.('quick-shot: the web server service carries no route registry')
        return undefined
      }

      const disposeRoute = server.register({
        kind: 'exact',
        path: CAPTURE_ROUTE,
        handler: (req, res) => {
          if (refused(ctx, req, res)) return
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end()
            return
          }
          void runHandler(res, async () => {
            if (busy) throw httpError(409, 'capture in progress')
            const body = await readJsonBody(req, BODY_LIMIT)
            const title = typeof body.title === 'string' ? body.title.slice(0, 400) : ''
            const seconds = clampTimeout(body.timeoutSeconds)
            const mode = clampMode(body.mode)
            const titleB64 = Buffer.from(title, 'utf8').toString('base64')
            busy = true
            try {
              const result = await captureOnce({ titleB64, timeoutSeconds: seconds, mode })
              sendJson(res, 200, result)
            } finally {
              busy = false
            }
          })
        },
      })

      return () => {
        for (const process of activeChildren) {
          try {
            process.kill()
          } catch {
            /* already gone */
          }
        }
        activeChildren.clear()
        try {
          disposeRoute()
        } catch (error) {
          child.logger?.warn?.(`quick-shot: route disposal failed: ${error?.message ?? String(error)}`)
        }
      }
    }, 'quick-shot: capture route')
  })
}
