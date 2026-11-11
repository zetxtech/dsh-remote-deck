/**
 * Local port forwarding over SSH.
 *
 * A forward listens on 127.0.0.1 and pipes each accepted socket through an
 * ssh2 direct-tcpip channel to a port on the remote host. Saved forwards are
 * restored when their connection comes back, and each one remembers whether the
 * console or the agent opened it.
 */
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './util.js'

export function parseListeningPorts(text) {
  const ports = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || /^State/i.test(trimmed)) continue
    if (!/LISTEN/i.test(trimmed) && !/^tcp/i.test(trimmed)) continue
    for (const token of trimmed.split(/\s+/)) {
      if (!token.includes(':') || token.endsWith(':*')) continue
      const match = /:(\d{1,5})$/.exec(token)
      if (match === null) continue
      const port = Number(match[1])
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        ports.add(port)
        break
      }
    }
  }
  return [...ports].sort((a, b) => a - b)
}

export class ForwardManager {
  constructor({ hostFor, secrets, dataDir, onLog }) {
    this.hostFor = hostFor
    this.secrets = secrets
    this.file = join(dataDir, 'forwards.json')
    this.onLog = onLog ?? (() => {})
    this.forwards = new Map()
    const saved = readJsonFile(this.file, null)
    this.saved = saved !== null && Array.isArray(saved.forwards) ? saved.forwards : []
  }

  #view(record) {
    return {
      id: record.id,
      connectionId: record.connectionId,
      remotePort: record.remotePort,
      localPort: record.localPort,
      origin: record.origin === 'agent' ? 'agent' : 'user',
      createdAt: record.createdAt,
      url: 'http://127.0.0.1:' + record.localPort,
    }
  }

  list() {
    return [...this.forwards.values()].map((record) => this.#view(record))
  }

  #persist() {
    const rows = this.list().map((row) => ({
      connectionId: row.connectionId,
      remotePort: row.remotePort,
      localPort: row.localPort,
      origin: row.origin,
    }))
    writeJsonFile(this.file, { version: 1, forwards: rows })
    this.saved = rows
  }

  async start(connectionId, remotePort, localPort, origin) {
    const host = this.hostFor(connectionId)
    if (host === undefined) throw new Error('connection not found')
    const port = Number(remotePort)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid remote port')
    await host.connect(this.secrets)

    const server = net.createServer((socket) => {
      host
        .forwardOut('127.0.0.1', socket.remotePort || 0, '127.0.0.1', port)
        .then((stream) => {
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => stream.destroy())
          stream.on('error', () => socket.destroy())
          stream.on('close', () => socket.destroy())
        })
        .catch(() => {
          socket.destroy()
        })
    })
    const bindPort = Number(localPort) > 0 ? Number(localPort) : 0
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error)
      server.once('error', fail)
      server.listen(bindPort, '127.0.0.1', () => {
        server.removeListener('error', fail)
        resolve()
      })
    })
    const actual = server.address().port
    const record = {
      id: randomUUID(),
      connectionId,
      remotePort: port,
      localPort: actual,
      origin: origin === 'agent' ? 'agent' : 'user',
      createdAt: Date.now(),
      server,
    }
    server.on('error', (error) => this.onLog('forward error', connectionId, String(error && error.message ? error.message : error)))
    this.forwards.set(record.id, record)
    this.#persist()
    this.onLog('forward start', connectionId, ':' + port, '->', actual)
    return this.#view(record)
  }

  stop(id) {
    const record = this.forwards.get(id)
    if (record === undefined) return false
    try {
      record.server.close()
    } catch {
      /* ignore */
    }
    this.forwards.delete(id)
    this.#persist()
    return true
  }

  stopForConnection(connectionId) {
    for (const record of [...this.forwards.values()]) {
      if (record.connectionId === connectionId) this.stop(record.id)
    }
  }

  async restoreFor(connectionId) {
    for (const row of this.saved) {
      if (row.connectionId !== connectionId) continue
      const already = [...this.forwards.values()].some((record) => record.connectionId === connectionId && record.remotePort === row.remotePort)
      if (already) continue
      try {
        await this.start(connectionId, row.remotePort, row.localPort, row.origin)
      } catch (error) {
        this.onLog('forward restore failed', connectionId, row.remotePort, String(error && error.message ? error.message : error))
      }
    }
  }

  async detect(connectionId) {
    const host = this.hostFor(connectionId)
    if (host === undefined) throw new Error('connection not found')
    await host.connect(this.secrets)
    const result = await host.runCommand('ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null', null, { maxBytes: 256 * 1024 })
    const ports = parseListeningPorts(result.stdout)
    const forwarded = new Map()
    for (const record of this.forwards.values()) {
      if (record.connectionId === connectionId) forwarded.set(record.remotePort, record.localPort)
    }
    return ports.map((port) => ({ port, localPort: forwarded.get(port) ?? null }))
  }

  closeAll() {
    for (const id of [...this.forwards.keys()]) this.stop(id)
  }
}
