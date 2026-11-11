/**
 * Remote PTY sessions.
 *
 * Each terminal is one ssh2 shell channel on the host's persistent client.
 * Output is buffered (bounded) so a reconnecting page can replay what it
 * missed; the API streams it as server-sent events.
 */
import { randomUUID } from 'node:crypto'

const MAX_BUFFER = 256 * 1024

export class TerminalManager {
  constructor({ hostFor, secrets, onLog }) {
    this.hostFor = hostFor
    this.secrets = secrets
    this.onLog = onLog ?? (() => {})
    this.terminals = new Map()
  }

  list() {
    return [...this.terminals.values()].map((term) => ({
      id: term.id,
      connectionId: term.connectionId,
      cols: term.cols,
      rows: term.rows,
      createdAt: term.createdAt,
      exitCode: term.exitCode,
      title: term.title,
    }))
  }

  async open(connectionId, options = {}) {
    const host = this.hostFor(connectionId)
    if (host === undefined) throw new Error('connection not found')
    await host.connect(this.secrets)
    const cols = Number(options.cols) || 120
    const rows = Number(options.rows) || 30
    const stream = await host.shell({ cols, rows })
    const term = {
      id: randomUUID(),
      connectionId,
      stream,
      cols,
      rows,
      createdAt: Date.now(),
      exitCode: null,
      title: options.title || 'bash',
      buffer: [],
      bufferBytes: 0,
      listeners: new Set(),
    }
    const push = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      term.buffer.push(buffer)
      term.bufferBytes += buffer.length
      while (term.bufferBytes > MAX_BUFFER && term.buffer.length > 1) {
        term.bufferBytes -= term.buffer.shift().length
      }
      const payload = { type: 'data', b64: buffer.toString('base64') }
      for (const listener of term.listeners) listener(payload)
    }
    stream.on('data', push)
    if (stream.stderr) stream.stderr.on('data', push)
    stream.on('close', (code) => {
      term.exitCode = typeof code === 'number' ? code : null
      for (const listener of term.listeners) listener({ type: 'exit', code: term.exitCode })
      term.listeners.clear()
      // Keep the short replay for a reconnecting page, then release the buffer.
      const cleanup = setTimeout(() => this.terminals.delete(term.id), 60000)
      cleanup.unref?.()
    })
    stream.on('error', (error) => {
      for (const listener of term.listeners) listener({ type: 'error', message: String(error && error.message ? error.message : error) })
    })
    this.terminals.set(term.id, term)
    this.onLog('terminal open', connectionId, term.id)
    return { id: term.id, cols, rows }
  }

  write(id, data) {
    const term = this.terminals.get(id)
    if (term === undefined) throw new Error('terminal not found')
    if (term.exitCode !== null) return
    term.stream.write(String(data))
  }

  resize(id, cols, rows) {
    const term = this.terminals.get(id)
    if (term === undefined) return
    term.cols = Number(cols) || term.cols
    term.rows = Number(rows) || term.rows
    try {
      term.stream.setWindow(term.rows, term.cols, 0, 0)
    } catch {
      /* some servers refuse window changes */
    }
  }

  close(id) {
    const term = this.terminals.get(id)
    if (term === undefined) return
    try {
      term.stream.end()
    } catch {
      /* ignore */
    }
    this.terminals.delete(id)
  }

  /** Replay the buffer, then stream live events. Returns a detach function. */
  attach(id, onEvent) {
    const term = this.terminals.get(id)
    if (term === undefined) return null
    for (const chunk of term.buffer) onEvent({ type: 'data', b64: chunk.toString('base64') })
    if (term.exitCode !== null) onEvent({ type: 'exit', code: term.exitCode })
    term.listeners.add(onEvent)
    return () => term.listeners.delete(onEvent)
  }

  closeAll() {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}
