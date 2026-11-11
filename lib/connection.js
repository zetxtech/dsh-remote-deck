/**
 * Connections, credentials and live SSH sessions.
 *
 * Each configured machine owns one persistent ssh2 client. Commands open an
 * exec channel on that client, files use its SFTP channel, so a session costs
 * one handshake instead of one per operation. The client keeps itself alive
 * and, when it was connected on purpose, reconnects with backoff.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  HOST_COLORS,
  errorText,
  fsError,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from './util.js'

const CONNECTIONS_VERSION = 2
const PROBE_SCRIPT = `printf '%s\\n' "$(uname -s)" "$(uname -r)" "$(uname -m)" "$SHELL" "$HOME"`
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export class ConnectionStore {
  constructor({ dataDir, legacyDir }) {
    this.file = join(dataDir, 'connections.json')
    this.legacyFile = join(legacyDir, 'connections.json')
    this.records = []
    this.load()
  }

  load() {
    const current = readJsonFile(this.file, null)
    if (current !== null && Array.isArray(current.connections)) {
      this.records = current.connections.filter((row) => row && row.id)
      return
    }
    // First run after the rename: adopt dsh-remote-ssh connections once.
    const legacy = readJsonFile(this.legacyFile, null)
    if (legacy !== null && Array.isArray(legacy.connections) && legacy.connections.length > 0) {
      this.records = legacy.connections.filter((row) => row && row.id).map((row, index) => this.#normalize(row, index))
      this.save()
      return
    }
    this.records = []
  }

  save() {
    writeJsonFile(this.file, { version: CONNECTIONS_VERSION, connections: this.records })
  }

  list() {
    return this.records
  }

  get(id) {
    return this.records.find((row) => row.id === id)
  }

  #nextColor() {
    return HOST_COLORS[this.records.length % HOST_COLORS.length]
  }

  #normalize(input, index) {
    const existing = typeof input.id === 'string' ? this.get(input.id) : undefined
    const color = typeof input.color === 'string' && HOST_COLORS.includes(input.color)
      ? input.color
      : existing?.color ?? HOST_COLORS[(index ?? this.records.length) % HOST_COLORS.length]
    return {
      id: input.id,
      name: String(input.name || '').trim() || String(input.host || '').trim() || 'remote',
      host: String(input.host || '').trim(),
      port: Number.isInteger(input.port) && input.port > 0 && input.port < 65536 ? input.port : 22,
      username: String(input.username || '').trim() || 'root',
      authType: input.authType === 'password' ? 'password' : 'key',
      privateKeyPath: typeof input.privateKeyPath === 'string' ? input.privateKeyPath.trim() : '',
      jump: typeof input.jump === 'string' ? input.jump.trim() : '',
      color,
      autoConnect: input.autoConnect === true,
      notes: typeof input.notes === 'string' ? input.notes : '',
      createdAt: existing?.createdAt ?? input.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }
  }

  upsert(input) {
    const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : randomUUID()
    const existing = this.get(id)
    const record = this.#normalize({ ...input, id, createdAt: existing?.createdAt }, this.records.length)
    if (existing) this.records = this.records.map((row) => (row.id === id ? record : row))
    else this.records.push(record)
    this.save()
    return record
  }

  remove(id) {
    this.records = this.records.filter((row) => row.id !== id)
    this.save()
  }
}

export class Secrets {
  constructor({ dataDir, legacyDir, credentials }) {
    this.credentials = credentials
    this.file = join(dataDir, 'secrets.json')
    this.legacyFile = join(legacyDir, 'secrets.json')
    this.local = readJsonFile(this.file, null) ?? readJsonFile(this.legacyFile, {})
  }

  #ref(connectionId, kind) {
    return `REMOTE_DECK_${connectionId.replace(/-/g, '_')}_${kind}`
  }

  #legacyRef(connectionId, kind) {
    return `REMOTE_SSH_${connectionId.replace(/-/g, '_')}_${kind}`
  }

  async #resolve(ref) {
    if (this.credentials === undefined) return null
    try {
      const hit = await this.credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      /* credential store unavailable: fall back to the local file */
    }
    return null
  }

  async get(connectionId, kind) {
    const value = await this.#resolve(this.#ref(connectionId, kind))
    if (value !== null) return value
    const legacy = await this.#resolve(this.#legacyRef(connectionId, kind))
    if (legacy !== null) {
      // Move the secret forward so later releases only look at the new name.
      await this.set(connectionId, kind, legacy)
      return legacy
    }
    const local = this.local[`${connectionId}:${kind}`]
    return typeof local === 'string' && local.length > 0 ? local : null
  }

  async set(connectionId, kind, value) {
    if (typeof value !== 'string' || value.length === 0) return this.clear(connectionId, kind)
    if (this.credentials !== undefined) {
      try {
        await this.credentials.set(this.#ref(connectionId, kind), value)
        return
      } catch {
        /* fall through to the local file */
      }
    }
    this.local[`${connectionId}:${kind}`] = value
    writeJsonFile(this.file, this.local)
  }

  async clear(connectionId, kind) {
    if (this.credentials !== undefined) {
      try {
        await this.credentials.unset(this.#ref(connectionId, kind))
        await this.credentials.unset(this.#legacyRef(connectionId, kind))
      } catch {
        /* ignore */
      }
    }
    delete this.local[`${connectionId}:${kind}`]
    writeJsonFile(this.file, this.local)
  }

  async describe(connectionId) {
    const [password, passphrase] = await Promise.all([
      this.get(connectionId, 'PASSWORD'),
      this.get(connectionId, 'PASSPHRASE'),
    ])
    return { password: password !== null, passphrase: passphrase !== null }
  }
}

// ssh2 is vendored under vendor/node_modules so the plugin has no npm
// dependencies and plugin managers never run install scripts. Loading it with
// createRequire avoids the ESM/CJS interop differences between the DSH plugin
// loader instances (the UI host, session runner and asset server resolve
// dynamic imports differently).
const requireFromPlugin = createRequire(import.meta.url)
let ssh2ClientClass = null

function pickSsh2Client(value) {
  for (const candidate of [value, value?.default, value?.default?.default]) {
    if (candidate && typeof candidate.Client === 'function') return candidate.Client
  }
  return null
}

async function loadSsh2Client() {
  if (ssh2ClientClass !== null) return ssh2ClientClass
  let failure = null
  try {
    const required = requireFromPlugin('../vendor/node_modules/ssh2/lib/index.js')
    const client = pickSsh2Client(required)
    if (client !== null) {
      ssh2ClientClass = client
      return client
    }
    failure = new Error('require() returned a module without a Client constructor')
  } catch (error) {
    failure = error
  }
  try {
    const loaded = await import('../vendor/node_modules/ssh2/lib/index.js')
    const client = pickSsh2Client(loaded)
    if (client !== null) {
      ssh2ClientClass = client
      return client
    }
    failure = new Error('import() returned a module without a Client constructor')
  } catch (error) {
    failure = error
  }
  if (process.env.DSH_REMOTE_DECK_DEBUG === '1') {
    console.error('[remote-deck] ssh2 load failed', process.pid, errorText(failure))
  }
  throw fsError('REMOTE_DECK_NO_SSH2', `the bundled ssh2 Client is unavailable (pid ${process.pid}): ${errorText(failure)}`)
}

/**
 * Load the bundled ssh2 once and verify the Client constructor is usable.
 * DSH loads the plugin in several runtime instances; this runs in each of them
 * so a broken loader shape is visible in the diagnostics instead of surfacing
 * later as "ssh2.Client is not a constructor" during a session run.
 */
export async function ssh2SelfTest() {
  const started = Date.now()
  try {
    const Client = await loadSsh2Client()
    const probe = new Client()
    try {
      probe.end()
    } catch {
      /* constructor-only probe */
    }
    return { ok: true, pid: process.pid, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, pid: process.pid, ms: Date.now() - started, error: errorText(error) }
  }
}

/**
 * One ProxyJump hop: `[user@]host[:port]`, the syntax ssh itself accepts. A
 * value may name a comma-separated chain, ordered from the client outwards.
 */
export function parseJumpSpec(value) {
  const hops = []
  for (const part of String(value ?? '').split(',')) {
    const text = part.trim()
    if (text.length === 0) continue
    const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(text)
    if (match === null) continue
    const host = match[2].replace(/^\[/, '').replace(/\]$/, '').trim()
    if (host.length === 0) continue
    const port = match[3] === undefined ? 22 : Number(match[3])
    hops.push({
      user: (match[1] ?? '').trim(),
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    })
  }
  return hops
}

export class RemoteHost {
  constructor(record, hooks) {
    this.record = record
    this.hooks = hooks ?? {}
    this.client = null
    this.sftp = null
    this.state = 'disconnected'
    this.error = ''
    this.since = null
    this.latencyMs = null
    this.sys = null
    this.connecting = null
    this.wanted = false
    this.disposed = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.pendingExec = new Set()
    this.jumpClients = []
  }

  #failPendingExec(message) {
    const pending = this.pendingExec
    this.pendingExec = new Set()
    for (const entry of pending) {
      try {
        entry.fail(message)
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    return {
      id: this.record.id,
      state: this.state,
      error: this.error || undefined,
      since: this.since,
      latencyMs: this.latencyMs,
      sys: this.sys,
    }
  }

  async connect(secrets) {
    if (this.state === 'connected' && this.client !== null) return
    if (this.connecting !== null) return this.connecting
    this.wanted = true
    clearTimeout(this.reconnectTimer)
    this.connecting = this.#connect(secrets)
      .catch((error) => {
        // Any failure before the client is created (ssh2 missing, unreadable
        // key, bad config) must still leave a visible error state.
        if (this.state !== 'disconnected') {
          this.state = 'error'
          this.error = errorText(error)
        }
        throw error
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  async #connect(secrets) {
    this.state = 'connecting'
    this.error = ''
    const Ssh2Client = await loadSsh2Client()
    const config = {
      host: this.record.host,
      port: this.record.port,
      username: this.record.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    }
    if (this.record.authType === 'password') {
      const password = await secrets.get(this.record.id, 'PASSWORD')
      if (password === null) throw fsError('REMOTE_DECK_NO_SECRET', 'No stored password for this connection; edit it and set one.')
      config.password = password
    } else {
      if (!this.record.privateKeyPath) throw fsError('REMOTE_DECK_NO_KEY', 'No private key path configured.')
      let key
      try {
        key = await readFile(this.record.privateKeyPath)
      } catch (error) {
        throw fsError('REMOTE_DECK_NO_KEY', `Cannot read the private key: ${errorText(error)}`)
      }
      config.privateKey = key
      const passphrase = await secrets.get(this.record.id, 'PASSPHRASE')
      if (passphrase !== null) config.passphrase = passphrase
    }

    const hops = parseJumpSpec(this.record.jump)
    if (hops.length > 0) {
      try {
        config.sock = await this.#openJumpChain(hops, secrets)
      } catch (error) {
        this.state = 'error'
        this.error = errorText(error)
        this.#closeJumpClients()
        throw error
      }
    }

    const client = new Ssh2Client()
    this.client = client
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        this.state = 'error'
        this.error = errorText(error)
        try {
          client.end()
        } catch {
          /* ignore */
        }
        this.#closeJumpClients()
        reject(fsError('REMOTE_DECK_CONNECT_FAILED', this.error))
      }
      client.once('ready', resolve)
      client.once('error', fail)
      try {
        client.connect(config)
      } catch (error) {
        fail(error)
      }
    })

    this.sftp = await new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) reject(fsError('REMOTE_DECK_SFTP_FAILED', errorText(error)))
        else resolve(sftp)
      })
    })

    this.state = 'connected'
    this.since = Date.now()
    this.error = ''
    this.reconnectAttempt = 0

    client.on('close', () => {
      if (this.client !== client) return
      this.#failPendingExec('Connection closed; the running command was interrupted.')
      this.client = null
      this.sftp = null
      this.#closeJumpClients()
      this.since = null
      if (this.state === 'error') return
      this.state = 'disconnected'
      this.error = 'Connection closed'
      this.#scheduleReconnect(secrets)
    })
    client.on('error', (error) => {
      this.error = errorText(error)
      this.hooks.onLog?.('ssh error', this.record.name, this.error)
    })

    try {
      await this.probe()
    } catch {
      /* a connected host without a shell still serves files */
    }
    try {
      this.hooks.onConnected?.(this)
    } catch {
      /* restoration hooks must not break the connection */
    }
  }

  #scheduleReconnect(secrets) {
    if (!this.wanted || this.disposed || this.reconnectTimer !== null) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.wanted || this.disposed) return
      this.connect(secrets).catch(() => {
        /* the next close schedules another attempt */
      })
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  /** Round-trip latency plus remote identity, measured over one exec channel. */
  async probe() {
    const started = Date.now()
    const result = await this.runCommand(PROBE_SCRIPT, null, { maxBytes: 64 * 1024 })
    const elapsed = Date.now() - started
    const lines = result.stdout.split('\n').map((line) => line.trim())
    this.latencyMs = elapsed
    this.sys = {
      os: lines[0] || '',
      kernel: lines[1] || '',
      arch: lines[2] || '',
      shell: lines[3] || '',
      home: lines[4] || '',
    }
    return { latencyMs: this.latencyMs, sys: this.sys }
  }

  async ensure(secrets) {
    if (this.state === 'connected' && this.client !== null) return
    await this.connect(secrets)
  }

  /**
   * Open the ProxyJump chain and return the stream that reaches the target's
   * own host:port. Each hop authenticates with the configured connection it
   * names when one matches, and otherwise falls back to the target's own
   * credentials — the usual "one key everywhere" setup.
   */
  async #openJumpChain(hops, secrets) {
    const Ssh2Client = await loadSsh2Client()
    let sock
    for (let index = 0; index < hops.length; index += 1) {
      const hop = hops[index]
      const next = index + 1 < hops.length
        ? hops[index + 1]
        : { host: this.record.host, port: this.record.port }
      const auth = await this.#jumpAuth(hop, secrets)
      const label = `${hop.user.length > 0 ? hop.user + '@' : ''}${hop.host}:${hop.port}`
      const client = new Ssh2Client()
      this.jumpClients.push(client)
      await new Promise((resolve, reject) => {
        const fail = (error) => {
          try {
            client.end()
          } catch {
            /* ignore */
          }
          reject(fsError('REMOTE_DECK_JUMP_FAILED', `jump host ${label}: ${errorText(error)}`))
        }
        client.once('ready', resolve)
        client.once('error', fail)
        const hopConfig = {
          host: hop.host,
          port: hop.port,
          username: auth.username,
          readyTimeout: 20000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
        }
        if (auth.privateKey !== undefined) hopConfig.privateKey = auth.privateKey
        if (auth.password !== undefined) hopConfig.password = auth.password
        if (auth.passphrase !== undefined) hopConfig.passphrase = auth.passphrase
        if (sock !== undefined) hopConfig.sock = sock
        try {
          client.connect(hopConfig)
        } catch (error) {
          fail(error)
        }
      })
      sock = await new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, next.host, next.port, (error, stream) => {
          if (error) {
            reject(fsError(
              'REMOTE_DECK_JUMP_FORWARD_FAILED',
              `jump host ${label} could not reach ${next.host}:${next.port}: ${errorText(error)}`,
            ))
          } else {
            resolve(stream)
          }
        })
      })
    }
    return sock
  }

  async #jumpAuth(hop, secrets) {
    const resolver = this.hooks.resolveHop
    const resolved = typeof resolver === 'function' ? await resolver(hop) : undefined
    const record = resolved ?? this.record
    const username = hop.user.length > 0 ? hop.user : record.username || this.record.username
    if (record.authType === 'password') {
      const password = await secrets.get(record.id, 'PASSWORD')
      if (password === null) throw fsError('REMOTE_DECK_NO_SECRET', `No stored password for jump host ${hop.host}.`)
      return { username, password }
    }
    const keyPath = record.privateKeyPath || this.record.privateKeyPath
    if (!keyPath) throw fsError('REMOTE_DECK_NO_KEY', `No private key configured for jump host ${hop.host}.`)
    let privateKey
    try {
      privateKey = await readFile(keyPath)
    } catch (error) {
      throw fsError('REMOTE_DECK_NO_KEY', `Cannot read the jump host key: ${errorText(error)}`)
    }
    const passphrase = await secrets.get(record.id, 'PASSPHRASE')
    return passphrase === null ? { username, privateKey } : { username, privateKey, passphrase }
  }

  #closeJumpClients() {
    for (const client of this.jumpClients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    this.jumpClients = []
  }

  disconnect() {
    this.wanted = false
    this.#failPendingExec('Connection closed; the running command was interrupted.')
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.client !== null) {
      try {
        this.client.end()
      } catch {
        /* ignore */
      }
    }
    this.client = null
    this.sftp = null
    this.#closeJumpClients()
    this.state = 'disconnected'
    this.since = null
  }

  requireSftp() {
    if (this.sftp === null || this.state !== 'connected') {
      throw fsError('REMOTE_DECK_NOT_CONNECTED', `Connection "${this.record.name}" is not connected.`)
    }
    return this.sftp
  }

  async runCommand(command, cwd, options) {
    const client = this.client
    if (client === null || this.state !== 'connected') {
      throw fsError('REMOTE_DECK_NOT_CONNECTED', `Connection "${this.record.name}" is not connected.`)
    }
    const opts = options ?? {}
    const script = cwd ? `cd ${quote(cwd)} 2>/dev/null || cd ~; ${command}` : command
    const cap = opts.maxBytes ?? 4 * 1024 * 1024
    return await new Promise((resolve) => {
      const out = []
      const err = []
      let outBytes = 0
      let errBytes = 0
      let finished = false
      const finish = (result) => {
        if (finished) return
        finished = true
        this.pendingExec.delete(entry)
        resolve(result)
      }
      const entry = {
        stream: null,
        fail: (message) => {
          try {
            if (entry.stream !== null) entry.stream.close()
          } catch {
            /* ignore */
          }
          finish({
            code: -1,
            signal: null,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: message,
          })
        },
      }
      this.pendingExec.add(entry)
      try {
        client.exec(script, (error, stream) => {
          if (finished) {
            try {
              stream.close()
            } catch {
              /* ignore */
            }
            return
          }
          if (error) {
            finish({ code: -1, stdout: '', stderr: errorText(error) })
            return
          }
          entry.stream = stream
          stream.on('data', (chunk) => {
            if (outBytes < cap) {
              out.push(chunk)
              outBytes += chunk.length
            }
          })
          stream.stderr.on('data', (chunk) => {
            if (errBytes < cap) {
              err.push(chunk)
              errBytes += chunk.length
            }
          })
          stream.on('close', (code, signal) => {
            finish({
              code: typeof code === 'number' ? code : -1,
              signal: signal ?? null,
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(err).toString('utf8'),
            })
          })
          if (opts.signal) {
            const abort = () => {
              try {
                stream.close()
              } catch {
                /* ignore */
              }
            }
            if (opts.signal.aborted) abort()
            else opts.signal.addEventListener('abort', abort, { once: true })
          }
        })
      } catch (error) {
        finish({ code: -1, stdout: '', stderr: errorText(error) })
      }
    })
  }

  /**
   * Open a raw exec channel for callers that stream the output instead of
   * collecting it — a `tar` archive piped straight into an HTTP response, for
   * instance. The caller owns the stream.
   */
  async streamCommand(command, cwd) {
    const client = this.client
    if (client === null || this.state !== 'connected') {
      throw fsError('REMOTE_DECK_NOT_CONNECTED', `Connection "${this.record.name}" is not connected.`)
    }
    const script = cwd ? `cd ${quote(cwd)} 2>/dev/null || cd ~; ${command}` : command
    return await new Promise((resolve, reject) => {
      try {
        client.exec(script, (error, stream) => {
          if (error) reject(fsError('REMOTE_DECK_EXEC_FAILED', errorText(error)))
          else resolve(stream)
        })
      } catch (error) {
        reject(fsError('REMOTE_DECK_EXEC_FAILED', errorText(error)))
      }
    })
  }

  /** Interactive shell (PTY). Caller owns the stream lifecycle. */
  async shell({ cols = 120, rows = 30, term = 'xterm-256color' } = {}) {
    const client = this.client
    if (client === null || this.state !== 'connected') {
      throw fsError('REMOTE_DECK_NOT_CONNECTED', `Connection "${this.record.name}" is not connected.`)
    }
    return await new Promise((resolve, reject) => {
      client.shell({ term, cols, rows }, (error, stream) => {
        if (error) reject(fsError('REMOTE_DECK_SHELL_FAILED', errorText(error)))
        else resolve(stream)
      })
    })
  }

  forwardOut(srcIP, srcPort, dstHost, dstPort) {
    const client = this.client
    if (client === null || this.state !== 'connected') {
      throw fsError('REMOTE_DECK_NOT_CONNECTED', `Connection "${this.record.name}" is not connected.`)
    }
    return new Promise((resolve, reject) => {
      client.forwardOut(srcIP, srcPort, dstHost, dstPort, (error, stream) => {
        if (error) reject(fsError('REMOTE_DECK_FORWARD_FAILED', errorText(error)))
        else resolve(stream)
      })
    })
  }

  dispose() {
    this.disposed = true
    this.disconnect()
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
