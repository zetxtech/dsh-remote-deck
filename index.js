/**
 * Remote Deck — host half.
 *
 * One DSH, many execution environments. Each configured SSH host owns one
 * persistent connection; marked workspace stubs route `ctx.fs` through SFTP,
 * a `bash` tool runs commands on the host, and ripgrep moves there too.
 * The agent also gets remote background jobs (`bash` with `run_in_background` or
 * a foreground wait that promotes to a job; collected with the built-in
 * job_output / job_kill) and loopback port forwards (`remote_forward`).
 * A loopback API feeds the sidebar chip, the quick panel and the console.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEMIRROR_ASSET_FILES, createApi } from './lib/api.js'
import { ConnectionStore, RemoteHost, Secrets, ssh2SelfTest } from './lib/connection.js'
import { ForwardManager } from './lib/forwards.js'
import { installWorkspacePromptGuide } from './lib/guide.js'
import { installRemoteShells, shellProbeCommand } from './lib/remote-shells.js'
import { createSshTerminalHandle, installTerminalRedirect } from './lib/remote-terminal.js'
import { Routing } from './lib/routing.js'
import { readSshConfig } from './lib/ssh-config.js'
import { TerminalManager } from './lib/terminal.js'
import { portForwardToolSpec } from './lib/tool-forward.js'
import { errorText } from './lib/util.js'
import { renderBashResult, renderPromoted, resolveWorkdir } from './lib/bash-result.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'vendor', 'xterm')
/** The editor's CodeMirror build; the served file list lives with the server. */
const CODEMIRROR_DIR = join(PLUGIN_DIR, 'vendor', 'codemirror')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'remote-deck')
const LEGACY_DIR = join(DSH_HOME, 'remote-ssh')
const WORKSPACE_ROOT = join(DATA_DIR, 'workspaces')
const LEGACY_WORKSPACE_ROOT = join(LEGACY_DIR, 'workspaces')
const BUILD = '1.28.0'
const diagnostics = { pid: process.pid, ssh2: 'pending', ssh2Error: '', checkedAt: 0 }
void ssh2SelfTest().then((result) => {
  diagnostics.ssh2 = result.ok ? 'ok' : 'failed'
  diagnostics.ssh2Error = result.ok ? '' : result.error
  diagnostics.checkedAt = Date.now()
  if (process.env.DSH_REMOTE_DECK_DEBUG === '1') {
    console.error('[remote-deck] ssh2 self-test', JSON.stringify(diagnostics))
  }
})
const SHELL_TIMEOUT_MS = 120000
/** Shell discovery only fills a menu: bounded hard, and never worth a long wait. */
const SHELL_PROBE_MAX_BYTES = 4096
const SHELL_PROBE_TIMEOUT_MS = 8000

/** Clamp an integer environment override; invalid values fall back to the default. */
function readIntEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Remote bash execution limits; dsh-remote-deck-fix/DESIGN.md 5.5 is the contract. */
const BASH_CONFIG = Object.freeze({
  foregroundTimeoutMs: readIntEnv('DSH_REMOTE_DECK_FOREGROUND_TIMEOUT_MS', 600000, 1000, 7200000),
  maxOutputBytes: readIntEnv('DSH_REMOTE_DECK_MAX_OUTPUT_BYTES', 4 * 1024 * 1024, 65536, 16 * 1024 * 1024),
  killGraceMs: readIntEnv('DSH_REMOTE_DECK_KILL_GRACE_MS', 1000, 200, 10000),
  progressIntervalMs: readIntEnv('DSH_REMOTE_DECK_PROGRESS_MS', 5000, 1000, 60000),
})

/** Resolve a request timeout against the configured default and hard cap. */
function clampTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return BASH_CONFIG.foregroundTimeoutMs
  return Math.min(7200000, Math.max(1000, Math.round(value)))
}

/** Services the plugin needs; web server and credentials store stay optional. */
export const inject = ['fs', 'workingDirectory', 'tools']
export const name = 'dsh-remote-deck'

export function apply(ctx) {
  const debug = (...args) => {
    if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck]', ...args)
  }

  const store = new ConnectionStore({ dataDir: DATA_DIR, legacyDir: LEGACY_DIR })
  const secrets = new Secrets({ dataDir: DATA_DIR, legacyDir: LEGACY_DIR, credentials: ctx.get('credentials') })
  const hosts = new Map()

  const hostFor = (id) => {
    let host = hosts.get(id)
    if (host === undefined) {
      const record = store.get(id)
      if (record === undefined) return undefined
      host = new RemoteHost(record, {
        onLog: debug,
        onConnected: (connected) => {
          void forwards.restoreFor(connected.record.id)
        },
        // A ProxyJump hop reuses the credentials of the configured connection it
        // names (by alias, or by host/port/user), so a bastion does not need a
        // second copy of its key in the store.
        resolveHop: (hop) => store.list().find((row) => {
          if (row.name === hop.host) return true
          if (row.host !== hop.host) return false
          if (hop.user.length > 0 && row.username !== hop.user) return false
          return row.port === hop.port
        }),
      })
      hosts.set(id, host)
    } else {
      const record = store.get(id)
      if (record !== undefined) host.record = record
    }
    return host
  }

  const listHosts = () => [...hosts.values()]

  const ensureConnected = async (id) => {
    const record = store.get(id)
    if (record === undefined) return
    const host = hostFor(id)
    if (host === undefined) return
    if (host.state === 'connected') return
    if (record.autoConnect === true || process.env.DSH_REMOTE_DECK_AUTOCONNECT === '1') {
      await host.connect(secrets)
    }
  }

  const routing = new Routing({
    workspaceRoot: WORKSPACE_ROOT,
    legacyRoots: [LEGACY_WORKSPACE_ROOT],
    hostFor,
    ensureConnected,
    getRegistry: () => ctx.get('workspaceRegistry'),
  })

  const forwards = new ForwardManager({ hostFor, secrets, dataDir: DATA_DIR, onLog: debug })
  const terminals = new TerminalManager({ hostFor, secrets, onLog: debug })
  // --- ctx.fs routing -------------------------------------------------------
  const restoreFs = routing.installFs(ctx.fs)
  ctx.effect(() => () => restoreFs(), 'remote-deck: fs patch')

  // --- remote workspace prompt guidance -------------------------------------
  // Adding a remote workspace used to write an `AGENTS.md` into the user's own
  // project directory. Nothing is written now: the model learns that the
  // workspace is remote from a system-prompt section plus one runtime-context
  // line. Both are registered once and resolved per model step, so a local
  // Session contributes empty text and never sees them; `ctx.inject` keeps this
  // plugin loadable on a profile that exposes no `systemPrompt` service.
  ctx.inject(['systemPrompt'], (scope) => {
    installWorkspacePromptGuide(scope, {
      directoryOf: (agent) => ctx.workingDirectory.get(agent.session),
      resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
      hostNameFor: (connectionId) => store.get(connectionId)?.name,
    })
  })

  // --- bash tool ------------------------------------------------------------
  /**
   * Bounded foreground execution used only when the profile exposes no job
   * controller (or the job preflight rejects the call). The deadline closes
   * the channel instead of leaving the turn waiting forever; the remote
   * process may continue, which the notice states explicitly.
   */
  const runForegroundWithDeadline = async (host, cwd, exec, timeoutMs, command) => {
    const controller = new AbortController()
    let timedOut = false
    const forwardAbort = () => controller.abort()
    if (exec.signal !== undefined) {
      if (exec.signal.aborted === true) controller.abort()
      else exec.signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
    try {
      const result = await host.runCommand(command, cwd, {
        signal: controller.signal,
        maxBytes: BASH_CONFIG.maxOutputBytes,
      })
      if (timedOut === true) {
        return {
          text: `[command still running after ${timeoutMs}ms; background jobs are unavailable in this profile, so it may keep running on the remote host]`,
          exitCode: null,
        }
      }
      return renderBashResult(result, { maxBytes: BASH_CONFIG.maxOutputBytes })
    } finally {
      clearTimeout(timer)
      if (exec.signal !== undefined) exec.signal.removeEventListener('abort', forwardAbort)
    }
  }

  // Every call registers a DSH background job, waits a bounded time in the
  // foreground, and on timeout returns the job id instead of killing the
  // remote process. This mirrors @deepseek-ai/dsh-tool-bash: long legitimate
  // tasks are promoted, never interrupted; only job_kill / the Stop button
  // terminate the remote process.
  const bashToolConfiguration = {
    name: 'bash',
    description:
      'Run a shell command on the connected remote SSH host. Use it for every command inside a remote workspace: build, test, git, ripgrep, package managers. The working directory is the remote workspace (a POSIX path); use POSIX paths, not Windows paths. The working directory is strict: a missing directory fails the command instead of falling back to the home directory. Long commands keep running as a background job after the foreground wait; use job_output to read their output and job_kill to stop them.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run on the remote host.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words.' },
        workdir: { type: 'string', description: 'Optional remote working directory. An absolute POSIX path is used as-is; a relative path resolves against the session workspace.' },
        timeoutMs: { type: 'number', description: 'How long to wait in the foreground before moving the command to a background job. Defaults to the plugin limit; the command is not killed on timeout.' },
        run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately; collect it with job_output and stop it with job_kill.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          jobId: { type: 'string' },
        },
        required: ['text', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const sessionCwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const target = routing.resolveTarget(sessionCwd, undefined)
        if (target === null) {
          return {
            text: `The bash tool only runs inside a remote workspace. The current working directory is local: ${JSON.stringify(sessionCwd)}. Use pwsh for local commands.`,
            exitCode: 1,
          }
        }
        const host = hostFor(target.connectionId)
        if (host === undefined) return { text: 'That connection no longer exists; recreate it.', exitCode: 1 }
        await host.connect(secrets)
        const resolved = resolveWorkdir(args.workdir, target.path)
        if (resolved.error !== undefined) return { text: resolved.error, exitCode: 1 }
        if (exec.signal !== undefined && exec.signal.aborted === true) {
          return { text: 'Error: tool call aborted', exitCode: 1 }
        }
        const timeoutMs = clampTimeoutMs(args.timeoutMs)
        const background = args.run_in_background === true
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          if (background === true) {
            return {
              text: 'Error: run_in_background requires the DSH background-jobs capability (load @deepseek-ai/dsh-tool-jobs in this profile).',
              exitCode: 1,
            }
          }
          return await runForegroundWithDeadline(host, resolved.cwd, exec, timeoutMs, args.command)
        }
        const owner = exec.agent?.id
        const jobKey = randomUUID().replaceAll('-', '').slice(0, 16)
        const startedAt = Date.now()
        let commandResultPromise = null
        let commandHandle = null
        let pendingKill = null
        let jobId
        try {
          jobId = jobs.start({
            kind: 'bash',
            label: String(args.command).slice(0, 80),
            ...(owner !== undefined ? { owner } : {}),
            ...(typeof exec.callId === 'string'
              ? { toolCall: { callId: exec.callId, ...(typeof exec.rootCallId === 'string' ? { rootCallId: exec.rootCallId } : {}) } }
              : {}),
            outputLimitBytes: BASH_CONFIG.maxOutputBytes,
            run: (handle) => {
              commandResultPromise = (async () => {
                const started = await host.startCommand(args.command, resolved.cwd, {
                  jobKey,
                  maxBytes: BASH_CONFIG.maxOutputBytes,
                  killGraceMs: BASH_CONFIG.killGraceMs,
                  onChunk: (channel, text) => {
                    try {
                      handle.append(text, { channel })
                    } catch {
                      /* job already settled */
                    }
                  },
                })
                commandHandle = started
                if (pendingKill !== null) void started.kill(pendingKill)
                return await started.done
              })()
              const timer = setInterval(() => {
                try {
                  handle.updateProgress(`running for ${Math.round((Date.now() - startedAt) / 1000)}s`)
                } catch {
                  /* settled */
                }
              }, BASH_CONFIG.progressIntervalMs)
              timer.unref?.()
              const done = commandResultPromise.then(
                (result) => {
                  clearInterval(timer)
                  if (typeof result.transportError === 'string' && result.transportError.length > 0) {
                    return { status: 'failed', detail: result.transportError }
                  }
                  if (pendingKill !== null || (typeof result.signal === 'string' && result.signal.length > 0)) {
                    return {
                      status: 'killed',
                      detail: pendingKill !== null ? pendingKill : `signal: ${result.signal}`,
                    }
                  }
                  return { status: 'completed', detail: `exit code: ${result.code}` }
                },
                (error) => {
                  clearInterval(timer)
                  return { status: 'failed', detail: errorText(error) }
                },
              )
              return {
                done,
                cancel: (reason) => {
                  pendingKill = typeof reason === 'string' && reason.length > 0 ? reason : 'killed'
                  if (commandHandle !== null) void commandHandle.kill(pendingKill)
                },
              }
            },
          })
        } catch (jobError) {
          const message = errorText(jobError)
          if (!/job controller|jobs unavailable|no job controller/i.test(message)) {
            return { text: `Error: ${message}`, exitCode: 1 }
          }
          if (background === true) {
            return { text: `Error: run_in_background is unavailable in this profile: ${message}`, exitCode: 1 }
          }
          const rendered = await runForegroundWithDeadline(host, resolved.cwd, exec, timeoutMs, args.command)
          const notice = `[background jobs unavailable: ${message}]`
          return { ...rendered, text: `${notice}\n${rendered.text}`.trimEnd() }
        }
        if (background === true) {
          return {
            text: `[started background job ${jobId}; use job_output to read output, job_kill to stop]`,
            exitCode: null,
            jobId,
          }
        }
        let view
        try {
          view = await jobs.wait(jobId, timeoutMs, owner, exec.signal)
        } catch (waitError) {
          if (exec.signal === undefined || exec.signal.aborted !== true) {
            try {
              jobs.kill(jobId, owner, 'wait failed')
            } catch {
              /* already settled */
            }
            return { text: `Error: ${errorText(waitError)}`, exitCode: null, jobId }
          }
          try {
            jobs.kill(jobId, owner, 'tool call aborted')
          } catch {
            /* already settled */
          }
          try {
            await jobs.wait(jobId, 5000, owner)
          } catch {
            /* settlement takes longer; the record stays */
          }
          try {
            jobs.remove(jobId, owner)
          } catch {
            /* not settled/removable yet */
          }
          return { text: 'Error: tool call aborted', exitCode: null, jobId }
        }
        if (view.status === 'running' || view.status === 'stopping') {
          try {
            const read = jobs.read(jobId, owner)
            return renderPromoted(read, jobId, timeoutMs)
          } catch {
            return {
              text: `[still running after ${timeoutMs}ms; moved to background job ${jobId}; use job_output to read output, job_kill to stop]`,
              exitCode: null,
              jobId,
            }
          }
        }
        let result = null
        try {
          result = commandResultPromise === null ? null : await commandResultPromise
        } catch (starterError) {
          try {
            jobs.remove(jobId, owner)
          } catch {
            /* keep the record when removal is not allowed */
          }
          return { text: errorText(starterError), exitCode: 1, jobId }
        }
        try {
          jobs.remove(jobId, owner)
        } catch {
          /* keep the record when removal is not allowed */
        }
        return renderBashResult(result ?? { code: -1 }, { maxBytes: BASH_CONFIG.maxOutputBytes })
      } catch (error) {
        return { text: errorText(error), exitCode: 1 }
      }
    },
  }
  try {
    ctx.tools.register(bashToolConfiguration)
  } catch (error) {
    // POSIX compositions already register the official bash tool; a duplicate
    // name throws and used to abort the whole plugin load. Fall back to a
    // remote-only tool name instead of failing the composition.
    const message = errorText(error)
    debug('bash tool registration failed:', message)
    try {
      ctx.tools.register({
        ...bashToolConfiguration,
        name: 'remote_bash',
        description: `${bashToolConfiguration.description} (remote-only tool; the official bash tool is already registered on this platform)`,
      })
    } catch (fallbackError) {
      debug('remote bash fallback registration failed:', errorText(fallbackError))
    }
  }

  // --- shared session -> remote target resolution ---------------------------
  const resolveSession = async (exec) => {
    const sessionCwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return routing.resolveTarget(sessionCwd, undefined)
  }

  // --- agent-facing port forwarding ----------------------------------------
  ctx.tools.register(portForwardToolSpec({
    resolveSession,
    forwards,
    hostNameFor: (connectionId) => store.get(connectionId)?.name,
  }))

  // --- subprocess patch: remote ripgrep and the remote sidebar terminal -----
  const subprocessService = ctx.get('subprocess')
  const originalSpawn = subprocessService !== undefined && typeof subprocessService.spawn === 'function'
    ? subprocessService.spawn
    : null
  if (originalSpawn !== null) {
    subprocessService.spawn = function (spec) {
      try {
        const argv = spec !== null && typeof spec === 'object' && Array.isArray(spec.argv) ? spec.argv : null
        if (argv !== null && argv.length > 0 && /(^|[\\/])rg(\.exe)?$/i.test(String(argv[0]))) {
          const target = routing.resolveTarget(spec.cwd, undefined)
          if (target !== null) {
            const host = hostFor(target.connectionId)
            if (host !== undefined) return routing.makeRemoteRipgrep(host, target.path, argv.slice(1), spec)
          }
        }
      } catch {
        /* fall back to the local process */
      }
      return originalSpawn.call(this, spec)
    }
  }

  // The built-in Web sidebar terminal opens its PTY through `spawnTerminal`,
  // not through `ctx.terminals`. In a remote workspace the local shell cannot
  // start at all (its `cwd` is a POSIX path), so that one request is answered
  // with a PTY on the ssh2 session this plugin already owns for the connection —
  // no system OpenSSH client is required. Every other terminal request keeps the
  // local shell untouched, and a failed remote open is reported instead of
  // quietly falling back.
  // `DSH_REMOTE_DECK_REMOTE_TERMINAL=0` turns the redirect off entirely and
  // leaves the provider's local terminal, for a deployment that wants the
  // stock behaviour back without uninstalling the plugin.
  const remoteTerminalEnabled = process.env.DSH_REMOTE_DECK_REMOTE_TERMINAL !== '0'
  const terminalRedirect = remoteTerminalEnabled
    ? installTerminalRedirect(subprocessService, {
      resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
      connectionFor: (connectionId) => store.get(connectionId),
      onRemote: (plan) => debug('remote sidebar terminal on', plan.connectionId, plan.remotePath),
      open: (plan, spec) => {
        const host = hostFor(plan.connectionId)
        if (host === undefined) throw new Error(`remote-deck: connection ${plan.connectionId} is no longer configured`)
        const signal = spec !== null && typeof spec === 'object' ? spec.signal : undefined
        return createSshTerminalHandle({ host, secrets, plan, signal })
      },
    })
    : { restore: () => {} }
  ctx.effect(() => () => {
    if (subprocessService === undefined) return
    if (originalSpawn !== null) subprocessService.spawn = originalSpawn
    terminalRedirect.restore()
  }, 'remote-deck: subprocess patch')

  // --- remote shell menu ----------------------------------------------------
  // The sidebar's shell dropdown asks `terminalController.shells(agent, signal)`
  // for the shells of the Session's execution environment. That method is the
  // only one on the path that receives the agent, and the gateway resolves it on
  // every call, so a remote Session can answer with its own shells while every
  // local Session keeps the stock list. `DSH_REMOTE_DECK_REMOTE_TERMINAL=0`
  // turns this off with the terminal it belongs to: with the local shell back in
  // place, offering remote shells would be a lie.
  if (remoteTerminalEnabled) {
    ctx.inject(['terminalController'], (scope) => {
      const remoteShells = installRemoteShells(scope.get('terminalController'), {
        // The controller reads the committed directory through the agent's own
        // context (`this.execution(agent).workingDirectory.get(agent.session)`,
        // dsh-api-terminal-controller/lib/index.js:785-790); the provider this
        // plugin injects is the same service, and is the fallback here.
        cwdFor: (agent) => {
          if (agent === null || typeof agent !== 'object') return undefined
          let workingDirectory = ctx.workingDirectory
          try {
            const scoped = agent.ctx !== undefined && typeof agent.ctx.get === 'function' ? agent.ctx.get('workingDirectory') : undefined
            if (scoped !== undefined) workingDirectory = scoped
          } catch {
            /* the agent context is gone; the plugin's provider still answers */
          }
          if (workingDirectory === undefined || typeof workingDirectory.get !== 'function') return undefined
          try {
            const cwd = workingDirectory.get(agent.session)
            return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
          } catch {
            return undefined
          }
        },
        resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
        probe: async (connectionId) => {
          const host = hostFor(connectionId)
          if (host === undefined) throw new Error(`remote-deck: connection ${connectionId} is no longer configured`)
          await host.ensure(secrets)
          const result = await host.runCommand(shellProbeCommand(), null, {
            maxBytes: SHELL_PROBE_MAX_BYTES,
            timeoutMs: SHELL_PROBE_TIMEOUT_MS,
          })
          if (typeof result.transportError === 'string' && result.transportError.length > 0) throw new Error(result.transportError)
          return result.stdout
        },
        onRemote: (target, list) => debug('remote shells on', target.connectionId, list.map((shell) => shell.name).join(',')),
      })
      debug('remote shell menu:', remoteShells.installed ? 'installed' : remoteShells.reason)
      scope.effect(() => () => remoteShells.restore(), 'remote-deck: remote shells')
    })
  }

  // --- loopback API ---------------------------------------------------------
  const token = randomBytes(24).toString('hex')
  let apiPort = 0

  const testConnection = async (input) => {
    const record = {
      id: 'test-' + randomBytes(4).toString('hex'),
      name: String(input.name || 'test'),
      host: String(input.host || '').trim(),
      port: Number(input.port) || 22,
      username: String(input.username || '').trim() || 'root',
      authType: input.authType === 'password' ? 'password' : 'key',
      privateKeyPath: String(input.privateKeyPath || '').trim(),
      color: 'blue',
    }
    if (record.host.length === 0) throw new Error('host is required')
    const tempSecrets = {
      get: async (_id, kind) => {
        if (kind === 'PASSWORD') return typeof input.password === 'string' && input.password.length > 0 ? input.password : null
        return typeof input.passphrase === 'string' && input.passphrase.length > 0 ? input.passphrase : null
      },
      set: async () => {},
      clear: async () => {},
      describe: async () => ({ password: Boolean(input.password), passphrase: Boolean(input.passphrase) }),
    }
    const host = new RemoteHost(record, {})
    try {
      await host.connect(tempSecrets)
      const status = host.status()
      return { latencyMs: status.latencyMs ?? null, sys: status.sys ?? null }
    } finally {
      host.dispose()
    }
  }

  const dropHost = (id) => {
    const host = hosts.get(id)
    hosts.delete(id)
    try {
      host?.dispose()
    } catch {
      /* ignore */
    }
  }

  const server = createApi({
    token,
    store,
    secrets,
    hostFor,
    dropHost,
    listHosts,
    routing,
    getRegistry: () => ctx.get('workspaceRegistry'),
    build: BUILD,
    diagnostics,
    homeDir: DSH_HOME,
    dataDir: DATA_DIR,
    readSshConfig,
    testConnection,
    terminals,
    forwards,
    assetDir: ASSET_DIR,
    assetDirs: [{ dir: CODEMIRROR_DIR, files: CODEMIRROR_ASSET_FILES }],
  })
  server.on('error', (error) => {
    console.error('[remote-deck] api server failed:', errorText(error))
  })
  if (process.env.DSH_REMOTE_DECK_DEBUG === '1') debug('api token', token)
  server.listen(0, '127.0.0.1', () => {
    apiPort = server.address().port
    debug('api ready on', apiPort)
  })

  ctx.effect(() => () => {
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }, 'remote-deck: api')

  // --- inject connection info into the page --------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'global',
        name: '__DSH_REMOTE_DECK__',
        value: {
          get port() {
            return apiPort
          },
          token,
          build: BUILD,
          dataDir: DATA_DIR,
        },
      })
    })
  })

  // --- auto-connect at startup ---------------------------------------------
  ctx.effect(() => {
    const timer = setTimeout(() => {
      for (const record of store.list()) {
        if (record.autoConnect !== true) continue
        hostFor(record.id)?.connect(secrets).catch((error) => debug('auto-connect failed', record.name, errorText(error)))
      }
    }, 1500)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'remote-deck: auto-connect')

  // A moved DSH home (folder migration, drive change, junction) leaves stored
  // workspace paths spelled with the old alias; re-register under the canonical
  // path keeping the title, otherwise sessions cannot attach.
  ctx.inject(['workspaceRegistry'], (scope) => {
    void (async () => {
      const registry = scope.get('workspaceRegistry')
      if (registry === undefined) return
      const roots = [WORKSPACE_ROOT, LEGACY_WORKSPACE_ROOT].filter((root) => existsSync(root))
      for (const entity of [...registry.list()]) {
        try {
          const canonical = await realpath(entity.path)
          if (canonical === entity.path) continue
          if (!roots.some((root) => canonical.toLowerCase().startsWith(root.toLowerCase()))) continue
          const title = entity.title
          await registry.delete(entity.id)
          await registry.create(canonical, title)
          console.log('[remote-deck] re-registered moved workspace', canonical)
        } catch (error) {
          debug('workspace heal failed:', errorText(error))
        }
      }
    })()
  })

  // --- teardown -------------------------------------------------------------
  ctx.effect(() => () => {
    terminals.closeAll()
    forwards.closeAll()
    for (const host of hosts.values()) host.dispose()
    hosts.clear()
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }, 'remote-deck: teardown')

  debug('loaded', BUILD, 'data dir', DATA_DIR, 'legacy', LEGACY_DIR)
}
