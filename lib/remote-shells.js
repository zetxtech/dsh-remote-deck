/**
 * Remote shell discovery for the sidebar terminal's shell menu.
 *
 * The stock controller builds that menu with `shells(agent, signal)`, which
 * resolves `discoverShells(this.execution(agent).subprocess, ...)` and therefore
 * describes the *local* execution provider — in a remote workspace it offers
 * `cmd.exe`/`powershell`. `shells` is the only method on that path that receives
 * the agent, and the gateway resolves the method on every call
 * (`Reflect.get(callReceiver, implementation)`,
 * `dsh-api-gateway/lib/index.js:1244`, verified in the installed app.asar), so
 * replacing that one method answers for remote Sessions while every local
 * Session keeps the stock list.
 *
 * Two more facts from the installed build shaped this module:
 * - the controller's own `spawn` looks the chosen path up in `this.shells(...)`
 *   (line 984), so the same replacement also decides which shells can be picked;
 * - the service is registered by the cordis `Service` base class under the name
 *   `terminalController` (`super(ctx, "terminalController", ...)`, line 771), so
 *   `ctx.inject(['terminalController'], ...)` reaches it.
 *
 * Guarantees the replacement keeps:
 * - a local Session calls the original method and returns its result untouched;
 * - a remote Session gets one bounded probe per connection, cached, and the
 *   original result whenever the probe fails or finds nothing — never an empty
 *   menu;
 * - `restore()` puts the original method back.
 */
import { shellQuote } from './util.js'

/** POSIX shells offered for a remote Session, most preferred first. */
export const REMOTE_SHELL_NAMES = Object.freeze(['bash', 'zsh', 'fish', 'dash', 'ksh', 'sh'])
/** The argument every offered shell is started with, and reported with. */
export const REMOTE_SHELL_ARGS = Object.freeze(['-l'])
/** Remote-side probe budget, in seconds, when the host has `timeout`. */
export const SHELL_PROBE_TIMEOUT_SECONDS = 6
/** How long a discovered list stays valid for one connection. */
export const DEFAULT_SHELL_CACHE_MS = 60000
/** How long a failed probe is remembered, so a dead host is probed once, not per menu open. */
export const DEFAULT_SHELL_FAILURE_CACHE_MS = 15000
/** Hard cap on one probe, including connecting a dropped session; a menu must answer. */
export const DEFAULT_SHELL_PROBE_TIMEOUT_MS = 10000

const MAX_SHELL_PATH_LENGTH = 1024

/** The last path segment, which is also the name the controller dedupes by. */
export function shellName(path) {
  const value = String(path)
  return value.slice(value.lastIndexOf('/') + 1)
}

/**
 * Whether a value may be started as a remote login shell.
 *
 * Only absolute POSIX paths whose program name is one of the offered shells get
 * through: the value arrives in `spawnTerminal`'s `argv`, where a local
 * `C:\Windows\System32\cmd.exe` or a bare `bash` means nothing on the remote
 * side. The path is still single-quoted where it is used, and traversal and
 * control characters are rejected rather than quoted.
 *
 * @param {unknown} value candidate path
 * @param {readonly string[]} [names] allowed program names
 * @returns {boolean}
 */
export function isRemoteShellPath(value, names = REMOTE_SHELL_NAMES) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SHELL_PATH_LENGTH) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.split('/').includes('..')) return false
  return names.includes(shellName(value))
}

/**
 * The bounded probe: print the absolute path of every candidate shell that
 * exists and is executable, one per line, in preference order.
 *
 * `command -v` walks the login PATH, the `/*` case drops shell builtins and
 * aliases, and `[ -x ]` drops a PATH hit that cannot be started. A hit that is
 * not an absolute path — BusyBox resolves its own applets that way, so `sh` can
 * come back as the bare word `sh` — falls back to the usual bin directories,
 * which is also what saves a host whose PATH is minimal. `timeout` bounds the
 * whole thing where the host has it — a PATH on a dead network mount must not
 * hold the menu — and the caller's own deadline covers a host without `timeout`.
 *
 * @param {readonly string[]} [names] candidate program names, most preferred first
 * @param {number} [timeoutSeconds] remote-side budget
 * @returns {string} command for the remote shell
 */
export function shellProbeCommand(names = REMOTE_SHELL_NAMES, timeoutSeconds = SHELL_PROBE_TIMEOUT_SECONDS) {
  const candidates = names.map((candidate) => shellQuote(candidate)).join(' ')
  const body = [
    `for name in ${candidates}; do`,
    '  p=$(command -v "$name" 2>/dev/null) || p=""',
    `  case "$p" in /*) ;; *) p="" ;; esac`,
    '  if [ -z "$p" ]; then',
    '    for dir in /bin /usr/bin /usr/local/bin; do',
    '      if [ -x "$dir/$name" ]; then p="$dir/$name"; break; fi',
    '    done',
    '  fi',
    `  if [ -n "$p" ] && [ -x "$p" ]; then printf '%s\\n' "$p"; fi`,
    'done',
  ].join('\n')
  const guarded = shellQuote(body)
  return [
    'if command -v timeout >/dev/null 2>&1; then',
    `  timeout ${timeoutSeconds} sh -c ${guarded}`,
    'else',
    `  sh -c ${guarded}`,
    'fi',
  ].join('\n')
}

/**
 * Read the probe's output into the controller's shell-profile shape.
 *
 * Lines may arrive in any order and unknown or malformed lines are dropped:
 * anything that is not an absolute path to one of the offered shells is noise,
 * including a truncated last line. The result is ordered by preference, so the
 * first entry is the menu default (bash when it exists).
 *
 * @param {unknown} text probe stdout
 * @param {readonly string[]} [names] allowed program names
 * @returns {Array<{ path: string, name: string, args: string[] }>}
 */
export function parseShellProbeOutput(text, names = REMOTE_SHELL_NAMES) {
  if (typeof text !== 'string' || text.length === 0) return []
  const rank = new Map(names.map((name, index) => [name, index]))
  const seen = new Set()
  const found = []
  for (const raw of text.split('\n')) {
    const path = raw.trim()
    if (seen.has(path) || !isRemoteShellPath(path, names)) continue
    seen.add(path)
    found.push({ path, name: shellName(path), args: [...REMOTE_SHELL_ARGS] })
  }
  return found.sort((a, b) => rank.get(a.name) - rank.get(b.name))
}

/**
 * Find the object that owns `method` on a service instance.
 *
 * Walks the prototype chain instead of reading the property: `ctx.get(name)`
 * returns a fresh cordis traceable proxy, and `Object.getPrototypeOf` on that
 * proxy reaches the real prototype, which is the one object both the gateway's
 * `Reflect.get` and the controller's own `this.shells(...)` resolve through.
 *
 * @param {unknown} service the service instance (or a proxy over it)
 * @param {string} method method name
 * @returns {{ owner: object, descriptor: PropertyDescriptor, original: Function } | null}
 */
function findMethodHome(service, method) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return null
  let owner = service
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, method)
    if (descriptor !== undefined) {
      if (typeof descriptor.value !== 'function') return null
      // A frozen method cannot be replaced, and a non-configurable one cannot be
      // restored; leave the stock behaviour alone in both cases.
      if (descriptor.configurable === false && descriptor.writable === false) return null
      return { owner, descriptor, original: descriptor.value }
    }
    owner = Object.getPrototypeOf(owner)
  }
  return null
}

/** A finite, non-negative number, or the fallback. */
function duration(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Bound a promise that may hang before its own deadline applies.
 *
 * The probe command carries its own `timeout` and the exec carries a deadline,
 * but connecting a dropped session happens first and can stall; this is the cap
 * that keeps the shell menu answering. The timer is deliberately referenced: an
 * unref'd deadline would not fire once the event loop is otherwise idle.
 */
function withDeadline(promise, ms) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`remote-deck: shell probe timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Replace `terminalController.shells` with a remote-aware version.
 *
 * @param {unknown} service the terminal controller service
 * @param {object} deps
 * @param {(agent: object) => string | undefined} deps.cwdFor committed Session directory
 * @param {(cwd: string) => ({ connectionId: string, path?: string } | null)} deps.resolveTarget remote target for a path
 * @param {(connectionId: string) => Promise<string>} deps.probe runs {@link shellProbeCommand} on one connection and resolves its stdout
 * @param {(target: object, shells: object[]) => void} [deps.onRemote] observability hook, called only when a remote list is used
 * @param {() => number} [deps.now] clock, injectable for deterministic tests
 * @param {number} [deps.cacheTtlMs] how long a discovered list stays valid
 * @param {number} [deps.failureCacheTtlMs] how long a failed probe is remembered
 * @param {number} [deps.probeTimeoutMs] hard cap on one probe, connecting included
 * @param {readonly string[]} [deps.shellNames] candidate program names
 * @returns {{ installed: boolean, reason?: string, restore: () => void }}
 */
export function installRemoteShells(service, deps) {
  const home = findMethodHome(service, 'shells')
  if (home === null) {
    return { installed: false, reason: 'terminalController.shells is not a replaceable method', restore: () => {} }
  }

  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const cacheTtlMs = duration(deps.cacheTtlMs, DEFAULT_SHELL_CACHE_MS)
  const failureCacheTtlMs = duration(deps.failureCacheTtlMs, DEFAULT_SHELL_FAILURE_CACHE_MS)
  const probeTimeoutMs = duration(deps.probeTimeoutMs, DEFAULT_SHELL_PROBE_TIMEOUT_MS)
  const names = Array.isArray(deps.shellNames) && deps.shellNames.length > 0 ? deps.shellNames : REMOTE_SHELL_NAMES
  const results = new Map()
  const inflight = new Map()

  /** The remote target of one agent's Session, or null for every unprovable case. */
  const targetOf = (agent) => {
    if (agent === null || typeof agent !== 'object') return null
    let cwd
    try {
      cwd = deps.cwdFor(agent)
    } catch {
      return null
    }
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    let resolved
    try {
      resolved = deps.resolveTarget(cwd)
    } catch {
      return null
    }
    if (resolved === null || typeof resolved !== 'object') return null
    if (typeof resolved.connectionId !== 'string' || resolved.connectionId.length === 0) return null
    return { connectionId: resolved.connectionId, path: typeof resolved.path === 'string' ? resolved.path : '' }
  }

  /** One probe per connection, cached; concurrent callers share the running one. */
  const discover = (connectionId) => {
    const cached = results.get(connectionId)
    if (cached !== undefined) {
      const ttl = cached.error === null ? cacheTtlMs : failureCacheTtlMs
      if (now() - cached.at < ttl) {
        return cached.error === null ? Promise.resolve(cached.list) : Promise.reject(cached.error)
      }
      results.delete(connectionId)
    }
    const running = inflight.get(connectionId)
    if (running !== undefined) return running

    const started = Promise.resolve()
      .then(() => withDeadline(deps.probe(connectionId), probeTimeoutMs))
      .then((stdout) => {
        const list = typeof stdout === 'string' ? parseShellProbeOutput(stdout, names) : []
        results.set(connectionId, { at: now(), list, error: null })
        return list
      })
      .catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        results.set(connectionId, { at: now(), list: [], error: failure })
        throw failure
      })
    inflight.set(connectionId, started)
    const settle = () => {
      if (inflight.get(connectionId) === started) inflight.delete(connectionId)
    }
    started.then(settle, settle)
    return started
  }

  /**
   * The replacement. Parameter names are part of the contract: the gateway can
   * fall back to reading them off the function source for signature validation.
   */
  function shells(agent, signal) {
    if (signal !== undefined && signal !== null && typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
    const target = targetOf(agent)
    if (target === null) return home.original.call(this, agent, signal)
    return discover(target.connectionId).then(
      (list) => {
        if (list.length === 0) return home.original.call(this, agent, signal)
        if (typeof deps.onRemote === 'function') {
          try {
            deps.onRemote(target, list)
          } catch {
            /* diagnostics must never break the menu */
          }
        }
        return list
      },
      () => home.original.call(this, agent, signal),
    )
  }

  try {
    Object.defineProperty(home.owner, 'shells', { ...home.descriptor, value: shells })
  } catch {
    return { installed: false, reason: 'terminalController.shells cannot be replaced', restore: () => {} }
  }

  return {
    installed: true,
    restore: () => {
      const current = Object.getOwnPropertyDescriptor(home.owner, 'shells')
      // Only take back what is still ours, so a later patch is not clobbered.
      if (current === undefined || current.value !== shells) return
      Object.defineProperty(home.owner, 'shells', home.descriptor)
    },
  }
}
