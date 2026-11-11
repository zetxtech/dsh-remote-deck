/**
 * Remote Deck — host half.
 *
 * One DSH, many execution environments. Each configured SSH host owns one
 * persistent connection; marked workspace stubs route `ctx.fs` through SFTP,
 * a `bash` tool runs commands on the host, and ripgrep moves there too.
 * The agent also gets remote background jobs (`bash` with
 * `run_in_background`, managed through `remote_job`) and loopback port
 * forwards (`remote_forward`).
 * A loopback API feeds the sidebar chip, the quick panel and the console.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './lib/api.js'
import { ConnectionStore, RemoteHost, Secrets, ssh2SelfTest } from './lib/connection.js'
import { ForwardManager } from './lib/forwards.js'
import { RemoteJobManager } from './lib/remote-jobs.js'
import { Routing } from './lib/routing.js'
import { readSshConfig } from './lib/ssh-config.js'
import { TerminalManager } from './lib/terminal.js'
import { portForwardToolSpec } from './lib/tool-forward.js'
import { remoteJobToolSpec } from './lib/tool-remote-jobs.js'
import { errorText, normalizeRemotePath } from './lib/util.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'vendor', 'xterm')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'remote-deck')
const LEGACY_DIR = join(DSH_HOME, 'remote-ssh')
const WORKSPACE_ROOT = join(DATA_DIR, 'workspaces')
const LEGACY_WORKSPACE_ROOT = join(LEGACY_DIR, 'workspaces')
const BUILD = '1.6.0'
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
  const remoteSettlers = new Map()
  const jobs = new RemoteJobManager({
    hostFor,
    secrets,
    onLog: debug,
    onSettle: (view) => {
      debug('remote job settled', view.id, view.status)
      const settle = remoteSettlers.get(view.id)
      if (settle !== undefined) {
        remoteSettlers.delete(view.id)
        settle(view)
      }
    },
  })

  // --- ctx.fs routing -------------------------------------------------------
  const restoreFs = routing.installFs(ctx.fs)
  ctx.effect(() => () => restoreFs(), 'remote-deck: fs patch')

  // --- bash tool ------------------------------------------------------------
  ctx.tools.register({
    name: 'bash',
    description:
      'Run a shell command on the connected remote SSH host. Use it for every command inside a remote workspace: build, test, git, ripgrep, package managers. The working directory is the remote workspace (a POSIX path); use POSIX paths, not Windows paths. Set run_in_background to true for servers, watchers and other long-running work: the command is detached on the remote host and is managed with the remote_job tool.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run on the remote host.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words.' },
        workdir: { type: 'string', description: 'Optional absolute POSIX working directory on the remote host; defaults to the session workspace.' },
        run_in_background: { type: 'boolean', description: 'Start the command detached on the remote host and return immediately with a job id; read, list and stop it with the remote_job tool.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
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
        const cwd = typeof args.workdir === 'string' && args.workdir.startsWith('/')
          ? normalizeRemotePath(args.workdir)
          : target.path
        if (args.run_in_background === true) {
          const started = await jobs.start(target.connectionId, {
            command: args.command,
            cwd,
            label: typeof args.description === 'string' && args.description.trim().length > 0
              ? args.description.trim()
              : args.command.split('\n')[0].slice(0, 120),
          })
          const published = publishJob(started, exec)
          const text = [
            `started background job ${started.id} (pid ${started.pid}) on ${started.host} in ${cwd}`,
            `read output: remote_job { "action": "output", "id": "${started.id}" }  (add "wait": true to follow until it exits)`,
            `stop: remote_job { "action": "kill", "id": "${started.id}" }`,
          ]
          if (published !== undefined) {
            text.push(
              `this job is also in the DSH job list: job_output { "job_id": "${published}" }, or stop it with job_kill { "job_id": "${published}" }`,
            )
          }
          return { text: text.join('\n'), exitCode: 0 }
        }
        const result = await host.runCommand(args.command, cwd, { signal: exec.signal, maxBytes: 4 * 1024 * 1024 })
        const parts = [result.stdout]
        if (result.stderr.trim().length > 0) parts.push(`[stderr]\n${result.stderr}`)
        if (result.code !== 0) parts.push(`[exit code: ${result.code}]`)
        return { text: parts.filter((part) => part.length > 0).join('\n').trimEnd(), exitCode: result.code }
      } catch (error) {
        return { text: errorText(error), exitCode: 1 }
      }
    },
  })

  // --- shared session -> remote target resolution ---------------------------
  const resolveSession = async (exec) => {
    const sessionCwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return routing.resolveTarget(sessionCwd, undefined)
  }

  // --- DSH job registry bridge ---------------------------------------------
  // Remote background jobs are mirrored into the composition's job registry so
  // they show up in the session job list, deliver completion notices and answer
  // the built-in job_list / job_output / job_kill tools. The registry is
  // optional: without it (or without a live owner) everything still works
  // through the remote_job tool.
  let jobRegistry
  const bridgeTimers = new Set()

  ctx.inject(['jobs'], (jobCtx) => {
    jobRegistry = jobCtx.jobs
    debug('dsh job registry available')
  })

  const jobOutcome = (view) => {
    if (view.status === 'killed') return { status: 'killed', detail: 'stopped by the user' }
    const code = view.exitCode === null || view.exitCode === undefined ? 'unknown' : view.exitCode
    if (view.status === 'failed') return { status: 'failed', detail: `exit code: ${code}` }
    return { status: 'completed', detail: `exit code: ${code}` }
  }

  /** Register one remote background job in the DSH job registry. */
  const publishJob = (view, exec) => {
    if (jobRegistry === undefined || typeof jobRegistry.start !== 'function') return undefined
    const owner = exec !== null && exec !== undefined && exec.agent !== null && exec.agent !== undefined
      ? exec.agent.id
      : undefined
    if (typeof owner !== 'string' || owner.length === 0) return undefined
    try {
      return jobRegistry.start({
        kind: 'remote-bash',
        label: view.label,
        owner,
        output: [],
        run: (handle) => {
          let offset = 0
          let settled = false
          const pump = setInterval(() => {
            if (settled) return
            void jobs.read(view.id, { offset })
              .then((chunk) => {
                if (chunk.text.length > 0) {
                  offset = chunk.offset
                  handle.append(chunk.text, { channel: 'stdout' })
                }
                handle.updateProgress(`${offset} bytes from ${view.host}`)
              })
              .catch((error) => debug('job pump failed', errorText(error)))
          }, 500)
          if (typeof pump.unref === 'function') pump.unref()
          bridgeTimers.add(pump)
          const done = new Promise((resolve) => {
            remoteSettlers.set(view.id, (settledView) => {
              settled = true
              clearInterval(pump)
              bridgeTimers.delete(pump)
              void jobs.read(view.id, { offset })
                .then((chunk) => {
                  if (chunk.text.length > 0) handle.append(chunk.text, { channel: 'stdout' })
                })
                .catch(() => {})
                .then(() => resolve(jobOutcome(settledView)))
            })
          })
          return {
            cancel: (reason) => {
              void jobs.kill(view.id, reason === undefined ? 'stopped by the user' : reason)
                .catch((error) => debug('job cancel failed', errorText(error)))
            },
            done,
          }
        },
      })
    } catch (error) {
      debug('job registry rejected the job', errorText(error))
      return undefined
    }
  }

  const closeJobBridge = () => {
    for (const timer of bridgeTimers) clearInterval(timer)
    bridgeTimers.clear()
    remoteSettlers.clear()
  }

  // --- agent-facing remote background jobs ---------------------------------
  ctx.tools.register(remoteJobToolSpec({ resolveSession, jobs }))

  // --- agent-facing port forwarding ----------------------------------------
  ctx.tools.register(portForwardToolSpec({
    resolveSession,
    forwards,
    hostNameFor: (connectionId) => store.get(connectionId)?.name,
  }))

  // Running background jobs are polled so completions settle and are noticed
  // without a remote round trip on every request.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void jobs.refreshAll().catch((error) => debug('job poll failed', errorText(error)))
    }, 3000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'remote-deck: job poller')

  // --- ripgrep on the connected host ---------------------------------------
  const subprocessService = ctx.get('subprocess')
  let originalSpawn = null
  if (subprocessService !== undefined && typeof subprocessService.spawn === 'function') {
    originalSpawn = subprocessService.spawn
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
    ctx.effect(() => () => {
      if (originalSpawn !== null) subprocessService.spawn = originalSpawn
    }, 'remote-deck: subprocess patch')
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

  const server = createApi({
    token,
    store,
    secrets,
    hostFor,
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
    closeJobBridge()
    jobs.closeAll()
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
