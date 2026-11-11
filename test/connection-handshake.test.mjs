import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { RemoteHost } = await import(pathToFileURL(`${root}/lib/connection.js`).href)

test('connect() survives the second error ssh2 emits on a failed handshake', { timeout: 20000 }, async () => {
  // Accept TCP but never send an SSH banner: the handshake times out, then
  // ssh2 emits "Timed out while waiting for handshake" *and*
  // "Connection lost before handshake" while cleaning up. A single once()
  // listener used to let the second error kill the whole host process.
  const sockets = new Set()
  const silent = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolveListen) => silent.listen(0, '127.0.0.1', resolveListen))
  const port = silent.address().port
  const host = new RemoteHost(
    { id: 'silent', name: 'silent', host: '127.0.0.1', port, username: 'none', authType: 'password', readyTimeoutMs: 900 },
    {},
  )
  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    const outcome = await Promise.race([
      host.connect({ get: async () => 'x' }).then(() => 'connected', (error) => error),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 8000)),
    ])
    assert.notEqual(outcome, 'timeout', 'connect() must settle instead of hanging')
    assert.ok(outcome instanceof Error, 'handshake must reject')
    await new Promise((wait) => setTimeout(wait, 300))
    assert.deepEqual(uncaught, [], 'failed handshake must not surface an uncaught exception')
    assert.equal(host.state, 'error')
  } finally {
    process.removeListener('uncaughtException', onUncaught)
    host.dispose()
    for (const socket of sockets) socket.destroy()
    silent.unref?.()
    await new Promise((close) => silent.close(close))
  }
})
