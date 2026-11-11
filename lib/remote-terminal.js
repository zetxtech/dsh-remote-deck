/**
 * The built-in Web sidebar terminal, opened on the remote host.
 *
 * The sidebar (`@deepseek-ai/dsh-api-terminal-controller`) does not use
 * `ctx.terminals`: its `spawn(agent, owner, request, signal)` calls
 * `subprocess.spawnTerminal(...)` directly, with the local shell discovered from
 * `subprocess.terminalEnvironment()` (verified in the installed app.asar,
 * `dsh-api-terminal-controller/lib/index.js:981-996`):
 *
 *   await subprocess.spawnTerminal({
 *     argv: [shell.path, ...shell.args], cwd, cols, rows,
 *     terminalType: 'xterm-256color',
 *     env: { DSH_SESSION_ID: agent.id },
 *     shellActivity: true, graceMs, signal,
 *   })
 *
 * In a remote workspace that request cannot work: `cwd` is the remote POSIX
 * path, and a local Windows shell cannot start in it. This module rewrites that
 * one request into `ssh -tt` so the provider's own ConPTY hosts an SSH client
 * attached to an interactive bash on the host, which keeps resize, teardown and
 * process-tree ownership in the provider that already owns them.
 *
 * Why not the other seams (all verified in the same app.asar):
 *
 * - A custom `ctx.terminals` backend is never consulted; the sidebar bypasses
 *   `ctx.terminals` entirely.
 * - `sandboxPolicy`/`subprocess` are resolved per Agent through
 *   `agent.ctx.get(...)`, but both are single global services; the shipped
 *   `@deepseek-ai/dsh-subprocess-ssh` family the Lead mentioned is not present
 *   in this build (the asar has no `dsh-ssh`, `dsh-subprocess-ssh`,
 *   `dsh-sandbox-ssh` or `dsh-fs-ssh` package).
 * - `terminalEnvironment(signal)` and `resolveExecutable(command, env, signal)`
 *   take no Agent, so they cannot answer per Session: rewriting them globally
 *   would hand every local Session a POSIX shell. The shell menu therefore still
 *   lists the local shells; whatever it spawns is replaced by this module.
 */
import { existsSync } from 'node:fs'
import { shellQuote } from './util.js'

/** `terminalType` the sidebar terminal alone requests (controller line 991). */
export const SIDEBAR_TERMINAL_TYPE = 'xterm-256color'
/** Known-good OpenSSH client locations, first match wins. */
export function sshCandidates(env) {
  const source = env ?? {}
  const candidates = []
  const override = typeof source.DSH_REMOTE_DECK_SSH === 'string' ? source.DSH_REMOTE_DECK_SSH.trim() : ''
  if (override.length > 0) candidates.push(override)
  const systemRoot = typeof source.SystemRoot === 'string' ? source.SystemRoot.trim() : ''
  // Spelled with backslashes so the candidate is identical on every host that
  // runs these tests, not only on Windows.
  if (systemRoot.length > 0) candidates.push(`${systemRoot.replace(/[\\/]+$/, '')}\\System32\\OpenSSH\\ssh.exe`)
  candidates.push('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  candidates.push('/usr/bin/ssh')
  return candidates
}

/**
 * Locate a local OpenSSH client.
 *
 * Only a client that actually starts can host the remote shell, so a miss means
 * "leave the request alone" rather than a failed terminal.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] environment supplying `DSH_REMOTE_DECK_SSH` / `SystemRoot`
 * @param {(path: string) => boolean} [options.exists] filesystem probe (injected in tests)
 * @param {(command: string) => Promise<string>} [options.resolveExecutable] PATH resolution through `ctx.subprocess`
 * @returns {Promise<string | null>} absolute client path, or null
 */
export async function resolveSshPath({ env, exists = existsSync, resolveExecutable } = {}) {
  for (const candidate of sshCandidates(env ?? process.env)) {
    if (exists(candidate)) return candidate
  }
  if (typeof resolveExecutable === 'function') {
    try {
      const found = await resolveExecutable('ssh')
      if (typeof found === 'string' && found.length > 0) return found
    } catch {
      /* not on PATH: fall through to "unavailable" */
    }
  }
  return null
}

/**
 * Is this `spawnTerminal` request the Web sidebar terminal?
 *
 * Both conditions are literals at the sidebar call site and both are absent from
 * the other in-tree PTY consumer (`dsh-terminal-bash` passes
 * `terminalType: 'dumb'` and never `shellActivity`). Requiring both keeps every
 * other terminal local; a future change here silently disables the rewrite
 * instead of redirecting someone else's PTY.
 */
export function isSidebarTerminalSpec(spec) {
  return spec !== null
    && typeof spec === 'object'
    && spec.terminalType === SIDEBAR_TERMINAL_TYPE
    && spec.shellActivity === true
    && Array.isArray(spec.argv)
    && spec.argv.length > 0
}

/** Already an ssh client? Then someone upstream owns the redirect. */
export function isSshProgram(program) {
  return /(^|[\\/])ssh(\.exe)?$/i.test(String(program ?? ''))
}

/**
 * The remote command line: change into the workspace, then start a bash.
 *
 * `-tt` gives this command the remote PTY; a login bash keeps the user's normal
 * profile, and `sh` covers hosts without bash. The path is POSIX-single-quoted
 * and travels as one argv element, so ssh hands it to the remote shell verbatim.
 *
 * @param {string} remotePath absolute remote directory
 * @returns {string} command for the remote shell
 */
export function remoteTerminalCommand(remotePath) {
  return `cd -- ${shellQuote(remotePath)} 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`
}

/**
 * Build the ssh argv.
 *
 * `StrictHostKeyChecking=accept-new` keeps OpenSSH's own trust policy (a changed
 * key is still refused) because the plugin's pinned fingerprint is a ssh2-side
 * fact this client cannot consume; `IdentitiesOnly` pins the configured key so
 * an ambient agent cannot change which identity answers.
 *
 * @param {object} input
 * @param {string} input.sshPath local OpenSSH client
 * @param {object} input.record connection record
 * @param {string} input.remoteCommand command from {@link remoteTerminalCommand}
 * @returns {string[]} argv for `spawnTerminal`
 */
export function buildSshTerminalArgv({ sshPath, record, remoteCommand }) {
  const argv = [
    sshPath,
    '-tt',
    '-p', String(record.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ServerAliveInterval=30',
  ]
  const jump = typeof record.jump === 'string' ? record.jump.trim() : ''
  if (jump.length > 0) argv.push('-J', jump)
  argv.push(
    '-i', record.privateKeyPath,
    '-l', record.username,
    record.host,
    remoteCommand,
  )
  return argv
}

/**
 * Decide whether one terminal request should run remotely, and how.
 *
 * Every rejection returns null, which means "call the original provider": an
 * unreadable workspace, a password-authenticated or keyless connection, a
 * malformed record, or a missing client all keep today's behaviour instead of
 * guessing. Nothing here throws on bad input.
 *
 * @param {object} spec the intercepted `spawnTerminal` request
 * @param {object} deps
 * @param {(cwd: string) => ({ connectionId: string, path: string } | null)} deps.resolveTarget remote target for a path
 * @param {(connectionId: string) => object | undefined} deps.connectionFor configured connection record
 * @param {string | null} deps.sshPath local OpenSSH client
 * @param {string} deps.localCwd existing local directory to start the client in
 * @param {(path: string) => boolean} [deps.keyExists] key-file probe
 * @returns {{ argv: string[], cwd: string, connectionId: string, remotePath: string } | null}
 */
export function planRemoteTerminal(spec, deps) {
  if (!isSidebarTerminalSpec(spec)) return null
  if (typeof deps.sshPath !== 'string' || deps.sshPath.length === 0) return null
  if (isSshProgram(spec.argv[0])) return null
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
  // A password cannot be forwarded to an interactive ssh client, and a pinned
  // key is the only credential this path can present non-interactively.
  if (record.authType !== 'key') return null
  const privateKeyPath = typeof record.privateKeyPath === 'string' ? record.privateKeyPath.trim() : ''
  if (privateKeyPath.length === 0) return null
  if (typeof deps.keyExists === 'function' && !deps.keyExists(privateKeyPath)) return null
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  const username = typeof record.username === 'string' ? record.username.trim() : ''
  if (host.length === 0 || username.length === 0) return null
  // The store always writes a number; anything else is a record we do not
  // understand and must not guess about.
  const port = record.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65536) return null
  const localCwd = typeof deps.localCwd === 'string' && deps.localCwd.length > 0 ? deps.localCwd : null
  if (localCwd === null) return null

  const remotePath = target.path
  return {
    argv: buildSshTerminalArgv({
      sshPath: deps.sshPath,
      record: { host, username, port, privateKeyPath, jump: record.jump },
      remoteCommand: remoteTerminalCommand(remotePath),
    }),
    cwd: localCwd,
    connectionId: target.connectionId,
    remotePath,
  }
}

/**
 * Install the redirect on one subprocess provider.
 *
 * Only the decision is guarded. Once a remote plan exists the provider's own
 * result — or its failure — is returned unchanged and exactly once, so a broken
 * ssh client can never fall back into a second, local, spawn.
 *
 * @param {{ spawnTerminal?: Function }} subprocess the provider to patch
 * @param {object} deps
 * @param {() => Promise<string | null>} deps.sshPath resolves the local OpenSSH client
 * @param {(plan: object) => void} [deps.onRemote] observability hook, called only on a rewrite
 * @returns {{ restore: () => void }} teardown for the plugin's effect
 */
export function installTerminalRedirect(subprocess, deps) {
  const original = subprocess === undefined || subprocess === null ? undefined : subprocess.spawnTerminal
  if (typeof original !== 'function') return { restore: () => {} }
  const delegate = (spec) => original.call(subprocess, spec)
  subprocess.spawnTerminal = async function (spec) {
    let executable = null
    try {
      executable = typeof deps.sshPath === 'function' ? await deps.sshPath() : deps.sshPath
    } catch {
      executable = null
    }
    let plan = null
    if (typeof executable === 'string' && executable.length > 0) {
      try {
        plan = planRemoteTerminal(spec, { ...deps, sshPath: executable })
      } catch {
        plan = null
      }
    }
    if (plan === null) return delegate(spec)
    if (typeof deps.onRemote === 'function') {
      try {
        deps.onRemote(plan)
      } catch {
        /* diagnostics must never break the terminal */
      }
    }
    return delegate({ ...spec, argv: plan.argv, cwd: plan.cwd })
  }
  return {
    restore: () => {
      subprocess.spawnTerminal = original
    },
  }
}
