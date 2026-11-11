/**
 * The built-in Web sidebar terminal, served from this plugin's own ssh2 session.
 *
 * The sidebar (`@deepseek-ai/dsh-api-terminal-controller`) does not use
 * `ctx.terminals`: its `spawn(agent, owner, request, signal)` calls
 * `subprocess.spawnTerminal(...)` directly and wraps the result
 * (`dsh-api-terminal-controller/lib/index.js:981-1009`, verified in the
 * installed app.asar):
 *
 *   const handle = await subprocess.spawnTerminal({
 *     argv: [shell.path, ...shell.args], cwd, cols, rows,
 *     terminalType: 'xterm-256color',
 *     env: { DSH_SESSION_ID: agent.id },
 *     shellActivity: true, graceMs, signal,
 *   })
 *   return new BrowserTerminal(handle, info, scrollback, maxBufferedBytes)
 *
 * In a remote workspace that request cannot work: `cwd` is the remote POSIX
 * path, so the local shell never starts. Rather than shelling out to a system
 * OpenSSH client — which a trimmed Windows, a container or an unprivileged host
 * may not have — this module answers the request itself with the ssh2 session the
 * plugin already owns for that connection.
 *
 * Handle contract, read off the only consumer (`BrowserTerminal`, same file,
 * lines 315-573) and the reference producer (`LocalTerminalHandle`,
 * `dsh-subprocess-local/lib/index.js:918-1090`). The consumer uses exactly:
 *
 * - `done` — Promise settling with `{ exitCode, signal }`; a rejection becomes
 *   the published `state: 'failed'` with the error message (lines 534-557).
 * - `output` — async-iterable byte chunks; the loop ends when the process ends
 *   (line 539). Only these two are read after `write`/`resize`/`terminate`.
 * - `write(data)` — async; throws once the process has exited (line 434).
 * - `resize(cols, rows)` — async; must map to the remote PTY window (line 438).
 * - `inspectActivity()` — async `{ state: 'idle'|'busy'|'unknown', revision }`
 *   (lines 360/1011), polled by `TerminalRetention` only while no browser is
 *   attached; a continuous `'idle'` for `unattendedTimeoutMs` closes it
 *   (`types/retention.js:120-151`).
 * - `terminate()` — async, idempotent, awaited before the screen is released
 *   (lines 509/1013) and again by `closeProcess`'s `drained` wait.
 *
 * `pid`, `inspectForeground`, `signalForeground` and `running` are NOT part of
 * the consumed surface: nothing in the controller reads them, and a remote
 * session has no local pid to report, so this handle omits them.
 */
import { PassThrough } from 'node:stream'
import { isRemoteShellPath } from './remote-shells.js'
import { shellQuote } from './util.js'

/** `terminalType` the sidebar terminal alone requests (controller line 991). */
export const SIDEBAR_TERMINAL_TYPE = 'xterm-256color'
/** Fallback terminate grace when the request carries none. */
export const DEFAULT_TERMINATE_GRACE_MS = 3000
/** Output silence after which activity stops being provably busy. */
export const DEFAULT_ACTIVITY_SILENCE_MS = 3000

/**
 * Is this `spawnTerminal` request the Web sidebar terminal?
 *
 * Both conditions are literals at the sidebar call site and both are absent from
 * the other in-tree PTY consumer (`dsh-terminal-bash` passes
 * `terminalType: 'dumb'` and never `shellActivity`), so the model-facing
 * terminal tools keep their local backend.
 */
export function isSidebarTerminalSpec(spec) {
  return spec !== null
    && typeof spec === 'object'
    && spec.terminalType === SIDEBAR_TERMINAL_TYPE
    && spec.shellActivity === true
    && Array.isArray(spec.argv)
    && spec.argv.length > 0
}

/**
 * The remote command line: change into the workspace, then start a shell.
 *
 * It runs under the connection's login shell on a PTY, so a login shell keeps the
 * user's normal profile and `sh` covers hosts without bash. The path is
 * POSIX-single-quoted, and a missing directory leaves the user in `$HOME`
 * instead of failing the terminal.
 *
 * `shellPath` is the shell picked in the sidebar menu. It is honoured only when
 * {@link isRemoteShellPath} accepts it — an absolute POSIX path to one of the
 * offered shells; a local default such as `cmd.exe`, or a bare name, is not a
 * remote program and keeps the bash-then-sh chain. The chosen shell is still
 * checked on the host before it is exec'd: the menu can be a minute stale, and a
 * terminal that will not start is worse than the fallback the user already has.
 *
 * @param {string} remotePath absolute remote directory
 * @param {unknown} [shellPath] shell chosen in the sidebar menu
 * @returns {string} command for the remote shell
 */
export function remoteTerminalCommand(remotePath, shellPath) {
  const cd = `cd -- ${shellQuote(remotePath)} 2>/dev/null`
  const fallback = 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'
  if (!isRemoteShellPath(shellPath)) return `${cd}; ${fallback}`
  const quoted = shellQuote(shellPath)
  return `${cd}; if [ -x ${quoted} ]; then exec ${quoted} -l; fi; ${fallback}`
}

/**
 * Decide whether one terminal request should run on the remote host, and how.
 *
 * Every rejection returns null, which means "call the original provider": a
 * local Session, an unreadable workspace, a connection that is no longer
 * configured, or a malformed request all keep today's behaviour instead of
 * guessing. Nothing here throws on bad input.
 *
 * Credentials are deliberately not inspected: ssh2 authenticates with the
 * connection's stored key or password, so both authentication types qualify.
 *
 * @param {object} spec the intercepted `spawnTerminal` request
 * @param {object} deps
 * @param {(cwd: string) => ({ connectionId: string, path: string } | null)} deps.resolveTarget remote target for a path
 * @param {(connectionId: string) => object | undefined} deps.connectionFor configured connection record
 * @returns {{ connectionId: string, remotePath: string, remoteCommand: string, cols: number, rows: number, term: string, graceMs: number } | null}
 */
export function planRemoteTerminal(spec, deps) {
  if (!isSidebarTerminalSpec(spec)) return null
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) return null

  let target
  try {
    target = deps.resolveTarget(spec.cwd)
  } catch {
    return null
  }
  if (target === null || typeof target !== 'object' || typeof target.path !== 'string' || target.path.length === 0) return null

  let record
  try {
    record = deps.connectionFor(target.connectionId)
  } catch {
    return null
  }
  if (record === null || typeof record !== 'object') return null
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  const username = typeof record.username === 'string' ? record.username.trim() : ''
  if (host.length === 0 || username.length === 0) return null

  return {
    connectionId: target.connectionId,
    remotePath: target.path,
    remoteCommand: remoteTerminalCommand(target.path, spec.argv[0]),
    cols: Number.isSafeInteger(spec.cols) && spec.cols >= 2 ? spec.cols : 80,
    rows: Number.isSafeInteger(spec.rows) && spec.rows >= 1 ? spec.rows : 24,
    term: SIDEBAR_TERMINAL_TYPE,
    graceMs: Number.isFinite(spec.graceMs) && spec.graceMs > 0 ? Math.round(spec.graceMs) : DEFAULT_TERMINATE_GRACE_MS,
  }
}

/**
 * Bounded wait for the grace race.
 *
 * Deliberately referenced: `terminate()` must settle even when the rest of the
 * process is already idle (shutdown, or a test with nothing else pending), and
 * the wait is capped by the request's grace.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * One remote PTY, exposed through the subprocess terminal-handle contract.
 *
 * The class is exported so the contract can be tested against a fake channel.
 */
export class SshTerminalHandle {
  #channel
  #output = new PassThrough()
  #graceMs
  #idleSilenceMs
  #now
  #resolveDone = null
  #rejectDone = null
  #done
  #settled = false
  #terminating = false
  #cleanup = null
  #sawExit = false
  #exitCode = null
  #exitSignal = null
  #paused = false
  #lastOutputAt = Number.NEGATIVE_INFINITY
  #activityState = 'unknown'
  #activityRevision = 0

  /**
   * @param {object} input
   * @param {object} input.channel connected ssh2 session channel carrying a PTY
   * @param {number} [input.graceMs] terminate grace before settlement is forced
   * @param {number} [input.idleSilenceMs] output silence that ends a provable `busy`
   * @param {() => number} [input.now] clock, injectable for deterministic tests
   */
  constructor({ channel, graceMs = DEFAULT_TERMINATE_GRACE_MS, idleSilenceMs = DEFAULT_ACTIVITY_SILENCE_MS, now = () => Date.now() }) {
    this.#channel = channel
    this.#graceMs = graceMs
    this.#idleSilenceMs = idleSilenceMs
    this.#now = now
    this.#done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
    })
    // The consumer attaches to `done` after the constructor returns; keep an
    // early failure from surfacing as an unhandled rejection.
    this.#done.catch(() => {})

    channel.on('data', (chunk) => this.#push(chunk))
    // A PTY merges the remote stderr into the session stream; a server that
    // still sends extended data must not lose it.
    if (channel.stderr !== null && typeof channel.stderr === 'object' && typeof channel.stderr.on === 'function') {
      channel.stderr.on('data', (chunk) => this.#push(chunk))
    }
    channel.on('exit', (code, signal) => {
      // ssh2 reports `code` for a normal exit and `code = null, signal = 'SIGTERM'`
      // for a signalled one (vendor/node_modules/ssh2/lib/client.js:670-679).
      this.#sawExit = true
      this.#exitCode = Number.isInteger(code) ? code : null
      this.#exitSignal = typeof signal === 'string' && signal.length > 0 ? signal : null
    })
    channel.on('close', () => {
      if (this.#sawExit) this.#finish({ exitCode: this.#exitCode, signal: this.#exitSignal })
      else if (this.#terminating) this.#finish({ exitCode: null, signal: null })
      else this.#fail(new Error('remote-deck: the remote shell channel closed without an exit status'))
    })
    channel.on('error', (error) => this.#fail(error))

    this.#output.on('drain', () => {
      if (!this.#paused || this.#settled) return
      this.#paused = false
      try {
        channel.resume()
      } catch {
        /* the channel is gone; the close path settles the handle */
      }
    })
  }

  /** Byte stream for `BrowserTerminal.consume()`. */
  get output() {
    return this.#output
  }

  /** Settles with `{ exitCode, signal }`, or rejects when the transport failed. */
  get done() {
    return this.#done
  }

  /** Whether the remote shell has ended and the handle is quiescent. */
  get exited() {
    return this.#settled
  }

  async write(data) {
    if (this.#settled) throw new Error('terminal process has exited')
    this.#channel.write(data)
  }

  async resize(cols, rows) {
    if (this.#settled) throw new Error('terminal process has exited')
    // ssh2 takes rows first (vendor/node_modules/ssh2/lib/Channel.js:221-235).
    this.#channel.setWindow(rows, cols, 0, 0)
  }

  /**
   * Approximate remote activity.
   *
   * Exact stdin-wait evidence is a provider-local capability this transport does
   * not have, and `TerminalRetention` closes a terminal after a continuous
   * `'idle'`, so the conservative rule is: `'idle'` only once the shell has
   * actually ended, `'busy'` while output is arriving, and `'unknown'` otherwise.
   * An unattended remote terminal is therefore never reclaimed on a guess.
   */
  async inspectActivity() {
    const now = this.#now()
    let state = 'unknown'
    if (this.#settled) state = 'idle'
    else if (now - this.#lastOutputAt < this.#idleSilenceMs) state = 'busy'
    if (state !== this.#activityState) {
      this.#activityState = state
      this.#activityRevision += 1
    }
    return { state, revision: this.#activityRevision }
  }

  /**
   * Close the remote session and settle the handle.
   *
   * Idempotent. A half-dead socket must not hang `BrowserTerminal.closeProcess()`,
   * which awaits `terminate()` and then the drained output, so settlement is
   * forced after the grace even when the server never answers.
   */
  terminate() {
    if (this.#cleanup !== null) return this.#cleanup
    this.#terminating = true
    this.#cleanup = (async () => {
      const channel = this.#channel
      try {
        channel.signal('HUP')
      } catch {
        /* the server may not accept signals; closing the channel is enough */
      }
      try {
        channel.end()
      } catch {
        /* already closed */
      }
      try {
        channel.close()
      } catch {
        /* already closed */
      }
      if (!this.#settled) await Promise.race([this.#done.catch(() => {}), delay(this.#graceMs)])
      this.#finish({ exitCode: null, signal: null })
    })()
    return this.#cleanup
  }

  #push(chunk) {
    if (this.#settled || chunk === undefined || chunk === null) return
    this.#lastOutputAt = this.#now()
    // Mirror the local provider: stop reading the session while the consumer is
    // behind, so a slow browser cannot grow this buffer without bound.
    if (!this.#output.write(chunk) && !this.#paused) {
      this.#paused = true
      try {
        this.#channel.pause()
      } catch {
        /* the channel is gone; the close path settles the handle */
      }
    }
  }

  #finish(outcome) {
    if (this.#settled) return
    this.#settled = true
    this.#output.end()
    this.#resolveDone(outcome)
  }

  #fail(error) {
    if (this.#settled) return
    this.#settled = true
    this.#output.end()
    this.#rejectDone(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Open the remote PTY and wrap it in a handle.
 *
 * Rejections here are the controller's `state: 'failed'` path, so every failure
 * keeps its own message: an unknown connection, an unreachable host, a refused
 * shell request, or a cancelled request.
 *
 * @param {object} input
 * @param {object} input.host the connected (or connectable) `RemoteHost`
 * @param {object} input.secrets credential store for `host.connect`
 * @param {object} input.plan result of {@link planRemoteTerminal}
 * @param {AbortSignal} [input.signal] request cancellation
 * @param {() => number} [input.now] clock, injectable for deterministic tests
 * @returns {Promise<SshTerminalHandle>}
 */
export async function createSshTerminalHandle({ host, secrets, plan, signal, now }) {
  if (host === undefined || host === null) {
    throw new Error('remote-deck: the connection is no longer configured')
  }
  signal?.throwIfAborted()
  await host.connect(secrets)
  signal?.throwIfAborted()
  const channel = await host.shellCommand(plan.remoteCommand, { cols: plan.cols, rows: plan.rows, term: plan.term })
  if (signal?.aborted === true) {
    // Cancelled while the shell request was in flight: never publish a PTY the
    // caller has already stopped waiting for.
    try {
      channel.close()
    } catch {
      /* already closed */
    }
    signal.throwIfAborted()
  }
  return new SshTerminalHandle({ channel, graceMs: plan.graceMs, now })
}

/**
 * Install the redirect on one subprocess provider.
 *
 * A planned request is answered here and the original provider is never called
 * for it — not even when opening the remote PTY fails, because a silent fallback
 * would hand the user a local shell inside a remote workspace. Unplanned
 * requests reach the original exactly once.
 *
 * @param {{ spawnTerminal?: Function }} subprocess the provider to patch
 * @param {object} deps
 * @param {(cwd: string) => object | null} deps.resolveTarget remote target for a path
 * @param {(connectionId: string) => object | undefined} deps.connectionFor configured connection record
 * @param {(plan: object, spec: object) => Promise<object>} deps.open opens the remote handle
 * @param {(plan: object) => void} [deps.onRemote] observability hook, called only on a takeover
 * @returns {{ restore: () => void }} teardown for the plugin's effect
 */
export function installTerminalRedirect(subprocess, deps) {
  const original = subprocess === undefined || subprocess === null ? undefined : subprocess.spawnTerminal
  if (typeof original !== 'function') return { restore: () => {} }
  subprocess.spawnTerminal = async function (spec) {
    let plan = null
    try {
      plan = planRemoteTerminal(spec, deps)
    } catch {
      plan = null
    }
    if (plan === null) return original.call(subprocess, spec)
    if (typeof deps.onRemote === 'function') {
      try {
        deps.onRemote(plan)
      } catch {
        /* diagnostics must never break the terminal */
      }
    }
    return deps.open(plan, spec)
  }
  return {
    restore: () => {
      subprocess.spawnTerminal = original
    },
  }
}
