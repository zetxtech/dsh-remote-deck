/**
 * Remote copy and move: the batch rules, the recursive copy, the move fallback
 * and the cancellation semantics of `POST /connections/<id>/transfer`.
 *
 * Hermetic — an in-memory SFTP tree stands in for the host, and the route is
 * exercised over loopback HTTP.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { createApi } from '../lib/api.js'
import {
  TRANSFER_INSIDE_SOURCE_CODE,
  TRANSFER_INVALID_CODE,
  TRANSFER_NOT_DIR_CODE,
  TRANSFER_TOO_MANY_CODE,
  canonicalRemotePath,
  entryKind,
  isInside,
  parseTransferRequest,
} from '../lib/file-ops.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

const MODES = {
  dir: 0o040755,
  file: 0o100644,
  link: 0o120777,
  fifo: 0o010644,
  socket: 0o140755,
  char: 0o020666,
  block: 0o060660,
}

function attrsOf(node) {
  return {
    mode: MODES[node.type],
    size: typeof node.content === 'string' ? Buffer.byteLength(node.content) : 0,
    mtime: 0,
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    isSymbolicLink: () => node.type === 'link',
  }
}

function notFound(path) {
  const error = new Error(`No such file: ${path}`)
  error.code = 2
  return error
}

/**
 * A flat path -> node map with the SFTP calls the transfer path uses.
 *
 * @param {object} [options]
 * @param {(op: string, path: string) => Error | null} [options.fail] injected failure
 * @param {(op: string, path: string) => Promise<void> | null} [options.hold] block one call
 * @param {(op: string, path: string) => void} [options.onCall] observe every call
 */
function makeSftp(initial, options = {}) {
  const nodes = new Map(Object.entries(initial ?? {}))
  const calls = []
  const record = (op, path) => {
    calls.push([op, path])
    if (typeof options.onCall === 'function') options.onCall(op, path)
  }
  const held = (op, path) => {
    const gate = options.hold?.(op, path)
    return gate === undefined || gate === null ? null : gate
  }
  const children = (dir) => {
    const entries = []
    for (const [key, node] of nodes) {
      const rest = key.slice(dir === '/' ? 1 : dir.length + 1)
      if (!key.startsWith(dir === '/' ? '/' : `${dir}/`)) continue
      if (rest.length === 0 || rest.includes('/')) continue
      entries.push({ filename: rest, attrs: attrsOf(node) })
    }
    return entries
  }
  const sftp = {
    lstat(path, callback) {
      record('lstat', path)
      const node = nodes.get(path)
      if (node === undefined) {
        callback(notFound(path))
        return
      }
      callback(null, attrsOf(node))
    },
    stat(path, callback) {
      record('stat', path)
      let node = nodes.get(path)
      if (node !== undefined && node.type === 'link') node = nodes.get(node.target)
      if (node === undefined) {
        callback(notFound(path))
        return
      }
      callback(null, attrsOf(node))
    },
    readdir(path, callback) {
      record('readdir', path)
      callback(null, children(path))
    },
    mkdir(path, callback) {
      record('mkdir', path)
      const failure = options.fail?.('mkdir', path)
      if (failure) {
        callback(failure)
        return
      }
      if (nodes.has(path)) {
        callback(Object.assign(new Error('already there'), { code: 4 }))
        return
      }
      nodes.set(path, { type: 'dir' })
      callback(null)
    },
    rmdir(path, callback) {
      record('rmdir', path)
      nodes.delete(path)
      callback(null)
    },
    unlink(path, callback) {
      record('unlink', path)
      const failure = options.fail?.('unlink', path)
      if (failure) {
        callback(failure)
        return
      }
      nodes.delete(path)
      callback(null)
    },
    readlink(path, callback) {
      record('readlink', path)
      const node = nodes.get(path)
      if (node === undefined || node.type !== 'link') {
        callback(notFound(path))
        return
      }
      callback(null, node.target)
    },
    symlink(target, path, callback) {
      record('symlink', path)
      if (nodes.has(path)) {
        callback(Object.assign(new Error('already there'), { code: 4 }))
        return
      }
      nodes.set(path, { type: 'link', target })
      callback(null)
    },
    rename(from, to, callback) {
      record('rename', from)
      const failure = options.fail?.('rename', from)
      if (failure) {
        callback(failure)
        return
      }
      if (!nodes.has(from)) {
        callback(notFound(from))
        return
      }
      const moved = []
      for (const [key, node] of nodes) {
        if (key === from || key.startsWith(`${from}/`)) moved.push([key, node])
      }
      for (const [key] of moved) nodes.delete(key)
      for (const [key, node] of moved) nodes.set(to + key.slice(from.length), node)
      callback(null)
    },
    createReadStream(path) {
      record('createReadStream', path)
      const node = nodes.get(path)
      const gate = held('createReadStream', path)
      const body = node !== undefined && typeof node.content === 'string' ? node.content : ''
      if (gate === null) return Readable.from([Buffer.from(body)])
      // A stream that has produced nothing yet, so the copy really is in flight.
      const stream = new PassThrough()
      gate.then(
        () => stream.end(Buffer.from(body)),
        () => stream.destroy(new Error('held read failed')),
      )
      return stream
    },
    createWriteStream(path) {
      record('createWriteStream', path)
      const pieces = []
      const stream = new Writable({
        write(chunk, _encoding, done) {
          const failure = options.fail?.('write', path)
          if (failure) {
            done(failure)
            return
          }
          pieces.push(Buffer.from(chunk))
          done()
        },
        final(done) {
          nodes.set(path, { type: 'file', content: Buffer.concat(pieces).toString('utf8') })
          done()
        },
      })
      return stream
    },
  }
  return { sftp, nodes, calls }
}

/** `/a` with a file, a nested directory, a link and a FIFO. */
const TREE = {
  '/a': { type: 'dir' },
  '/a/f1.txt': { type: 'file', content: 'one' },
  '/a/sub': { type: 'dir' },
  '/a/sub/f2.txt': { type: 'file', content: 'two' },
  '/a/link': { type: 'link', target: '/a/sub' },
  '/a/pipe': { type: 'fifo' },
  '/b': { type: 'dir' },
  '/b/keep.txt': { type: 'file', content: 'keep' },
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(10)
  }
  throw new Error('timed out waiting for the transfer to reach that point')
}

// ------------------------------------------------------------- pure helpers

test('the request is validated before any filesystem work', () => {
  assert.deepEqual(parseTransferRequest({ paths: ['/a/f1.txt'], toDir: '/b' }), {
    ok: true,
    paths: ['/a/f1.txt'],
    toDir: '/b',
    move: false,
  })
  // Redundant spellings are canonicalized, duplicates collapse.
  assert.deepEqual(parseTransferRequest({ paths: ['/a//f1.txt', '/a/f1.txt'], toDir: '/b/' }).paths, ['/a/f1.txt'])
  assert.equal(parseTransferRequest({ paths: ['/a/f1.txt'], toDir: '/b', move: true }).move, true)

  const refusals = [
    [{ paths: [], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: 'x', toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/a/f1.txt'] }, TRANSFER_INVALID_CODE],
    [{ paths: ['/a/f1.txt'], toDir: 'b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/a/f1.txt'], toDir: '/b/../c' }, TRANSFER_INVALID_CODE],
    [{ paths: ['relative'], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/a/../etc'], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/'], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/b'], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: ['/b/'], toDir: '/b' }, TRANSFER_INVALID_CODE],
    [{ paths: Array.from({ length: 201 }, (_, index) => `/d/p${index}`), toDir: '/b' }, TRANSFER_TOO_MANY_CODE],
  ]
  for (const [body, code] of refusals) {
    const result = parseTransferRequest(body)
    assert.equal(result.ok, false, JSON.stringify(body).slice(0, 60))
    assert.equal(result.code, code)
  }
  assert.equal(parseTransferRequest({ paths: Array.from({ length: 200 }, (_, index) => `/d/p${index}`), toDir: '/b' }).ok, true)
})

test('containment and kind helpers', () => {
  assert.equal(isInside('/a', '/a'), true)
  assert.equal(isInside('/a', '/a/b'), true)
  assert.equal(isInside('/a', '/ab'), false)
  assert.equal(isInside('/', '/a'), true)
  assert.equal(canonicalRemotePath('/a/b/'), '/a/b')
  assert.equal(canonicalRemotePath('/'), '/')
  // Mode bits decide, because ssh2's predicates miss sockets and devices.
  assert.equal(entryKind({ mode: MODES.socket }), 'socket')
  assert.equal(entryKind({ mode: MODES.char }), 'char')
  assert.equal(entryKind({ mode: MODES.block }), 'block')
  assert.equal(entryKind({ mode: MODES.link, isDirectory: () => true }), 'link')
  assert.equal(entryKind({ isFIFO: () => true }), 'fifo')
  assert.equal(entryKind({}), 'file')
})

// ---------------------------------------------------------------- the route

async function startApi({ nodes = TREE, ...options } = {}) {
  const fake = makeSftp(nodes, options)
  const host = { ensure: async () => {}, requireSftp: () => fake.sftp }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-fileops-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    nodes: fake.nodes,
    calls: fake.calls,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function transfer(base, body, init = {}) {
  return fetch(`${base}/connections/c1/transfer`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

test('a file is streamed to its new name and the source stays', async () => {
  const api = await startApi()
  try {
    const response = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/b' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, results: [{ path: '/a/f1.txt', name: 'f1.txt', ok: true }] })
    assert.equal(api.nodes.get('/b/f1.txt').content, 'one')
    assert.equal(api.nodes.get('/a/f1.txt').content, 'one')
  } finally {
    await api.close()
  }
})

test('a directory is copied recursively, links rebuilt and specials skipped', async () => {
  const api = await startApi()
  try {
    const response = await transfer(api.base, { paths: ['/a'], toDir: '/b' })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).results, [{ path: '/a', name: 'a', ok: true }])

    assert.equal(api.nodes.get('/b/a/sub/f2.txt').content, 'two')
    assert.equal(api.nodes.get('/b/a/f1.txt').content, 'one')
    // The link is recreated as a link with the same target, never followed.
    assert.deepEqual(api.nodes.get('/b/a/link'), { type: 'link', target: '/a/sub' })
    assert.ok(!api.calls.some((call) => call[0] === 'readdir' && call[1] === '/a/link'))
    // A FIFO inside the tree is skipped, not streamed and not fatal.
    assert.equal(api.nodes.has('/b/a/pipe'), false)
    assert.ok(!api.calls.some((call) => call[0] === 'createReadStream' && call[1] === '/a/pipe'))
    // The source tree is untouched.
    assert.equal(api.nodes.get('/a/sub/f2.txt').content, 'two')
  } finally {
    await api.close()
  }
})

test('a move prefers rename and never copies', async () => {
  const api = await startApi()
  try {
    const response = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/b', move: true })
    assert.deepEqual((await response.json()).results, [{ path: '/a/f1.txt', name: 'f1.txt', ok: true }])
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [['rename', '/a/f1.txt']])
    assert.equal(api.nodes.has('/a/f1.txt'), false)
    assert.equal(api.nodes.get('/b/f1.txt').content, 'one')
    assert.ok(!api.calls.some((call) => call[0] === 'createReadStream'))
  } finally {
    await api.close()
  }
})

test('a refused rename falls back to copy then delete of the source', async () => {
  const api = await startApi({
    // Cross-filesystem renames arrive as a plain SFTP failure.
    fail: (op) => (op === 'rename' ? Object.assign(new Error('Failure'), { code: 4 }) : null),
  })
  try {
    const response = await transfer(api.base, { paths: ['/a'], toDir: '/b', move: true })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).results, [{ path: '/a', name: 'a', ok: true }])

    assert.equal(api.nodes.get('/b/a/sub/f2.txt').content, 'two')
    assert.equal(api.nodes.has('/a'), false)
    assert.equal(api.nodes.has('/a/f1.txt'), false)
    // The fallback deletes through the same no-follow walk as the delete route.
    assert.ok(api.calls.some((call) => call[0] === 'rmdir' && call[1] === '/a/sub'))
  } finally {
    await api.close()
  }
})

test('an existing destination is reported and left alone', async () => {
  const api = await startApi({
    nodes: { ...TREE, '/b/f1.txt': { type: 'file', content: 'theirs' } },
  })
  try {
    const copy = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/b' })
    const copied = await copy.json()
    assert.equal(copied.ok, true)
    assert.equal(copied.results[0].ok, false)
    assert.equal(copied.results[0].code, 'EXISTS')
    assert.equal(api.nodes.get('/b/f1.txt').content, 'theirs')

    // A move into the folder the entry already lives in is the same failure.
    const moved = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/a', move: true })
    const body = await moved.json()
    assert.equal(body.results[0].code, 'EXISTS')
    assert.equal(api.nodes.has('/a/f1.txt'), true)
  } finally {
    await api.close()
  }
})

test('the target must be an existing directory', async () => {
  const api = await startApi()
  try {
    const missing = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/nope' })
    assert.equal(missing.status, 400)
    const body = await missing.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, TRANSFER_NOT_DIR_CODE)

    const file = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/b/keep.txt' })
    assert.equal(file.status, 400)
    assert.equal((await file.json()).code, TRANSFER_NOT_DIR_CODE)
    // The target check is the only thing that ran: no entry was touched.
    assert.deepEqual([...new Set(api.calls.map((call) => call[0]))], ['stat'])
  } finally {
    await api.close()
  }
})

test('a target inside a transferred directory is refused', async () => {
  const api = await startApi()
  try {
    for (const move of [false, true]) {
      const response = await transfer(api.base, { paths: ['/a'], toDir: '/a/sub', move })
      assert.equal(response.status, 400, `move=${move}`)
      assert.equal((await response.json()).code, TRANSFER_INSIDE_SOURCE_CODE)
    }
    const identity = await transfer(api.base, { paths: ['/a'], toDir: '/a' })
    assert.equal(identity.status, 400)
    assert.equal((await identity.json()).code, TRANSFER_INVALID_CODE)
    assert.equal(api.nodes.has('/a/sub'), true)
  } finally {
    await api.close()
  }
})

test('devices, sockets and FIFOs are refused as unsupported', async () => {
  const api = await startApi({
    nodes: {
      ...TREE,
      '/dev/tty': { type: 'char' },
      '/dev/sock': { type: 'socket' },
      '/dev/disk': { type: 'block' },
    },
  })
  try {
    const response = await transfer(api.base, {
      paths: ['/a/pipe', '/dev/tty', '/dev/sock', '/dev/disk'],
      toDir: '/b',
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.results.map((row) => [row.name, row.ok, row.code]), [
      ['pipe', false, 'UNSUPPORTED'],
      ['tty', false, 'UNSUPPORTED'],
      ['sock', false, 'UNSUPPORTED'],
      ['disk', false, 'UNSUPPORTED'],
    ])
    assert.ok(!api.calls.some((call) => call[0] === 'createReadStream'), 'a special file is never read')
  } finally {
    await api.close()
  }
})

test('one failing entry does not stop the rest of the batch', async () => {
  const api = await startApi({
    nodes: { ...TREE, '/b/f1.txt': { type: 'file', content: 'theirs' } },
  })
  try {
    const response = await transfer(api.base, {
      paths: ['/a/f1.txt', '/a/sub/f2.txt', '/a/gone.txt'],
      toDir: '/b',
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.results.map((row) => [row.name, row.ok, row.code ?? null]), [
      ['f1.txt', false, 'EXISTS'],
      ['f2.txt', true, null],
      ['gone.txt', false, 'MISSING'],
    ])
    // The entry after the failures still arrived.
    assert.equal(api.nodes.get('/b/f2.txt').content, 'two')
  } finally {
    await api.close()
  }
})

test('a failed write leaves no half-written file behind', async () => {
  const api = await startApi({ fail: (op) => (op === 'write' ? new Error('disk full') : null) })
  try {
    const response = await transfer(api.base, { paths: ['/a/f1.txt'], toDir: '/b' })
    const body = await response.json()
    assert.equal(body.results[0].ok, false)
    assert.equal(body.results[0].code, 'FAILED')
    assert.match(body.results[0].message, /disk full/)
    assert.equal(api.nodes.has('/b/f1.txt'), false)
    assert.ok(api.calls.some((call) => call[0] === 'unlink' && call[1] === '/b/f1.txt'))
  } finally {
    await api.close()
  }
})

test('the request is refused above two hundred paths and accepted at the cap', async () => {
  const api = await startApi({ nodes: { ...TREE } })
  try {
    const tooMany = await transfer(api.base, { paths: Array.from({ length: 201 }, (_, index) => `/d/p${index}`), toDir: '/b' })
    assert.equal(tooMany.status, 400)
    assert.equal((await tooMany.json()).code, TRANSFER_TOO_MANY_CODE)

    const atCap = await transfer(api.base, { paths: Array.from({ length: 200 }, (_, index) => `/d/p${index}`), toDir: '/b' })
    const body = await atCap.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 200)
    assert.ok(body.results.every((row) => row.code === 'MISSING'))
  } finally {
    await api.close()
  }
})

test('the route needs the token', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['/a/f1.txt'], toDir: '/b' }),
    })
    assert.equal(response.status, 403)
    assert.equal(api.nodes.has('/b/f1.txt'), false)
  } finally {
    await api.close()
  }
})

test('aborting the request stops the batch', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = await startApi({
    nodes: { ...TREE, '/c': { type: 'dir' }, '/c/big.txt': { type: 'file', content: 'big' } },
    hold: (op, path) => (op === 'createReadStream' && path === '/c/big.txt' ? gate : null),
  })
  try {
    const controller = new AbortController()
    const pending = transfer(
      api.base,
      { paths: ['/c/big.txt', '/a/f1.txt'], toDir: '/b' },
      { signal: controller.signal },
    ).then(
      (response) => `status:${response.status}`,
      (error) => error.name,
    )
    await waitFor(() => api.calls.some((call) => call[0] === 'createReadStream' && call[1] === '/c/big.txt'))
    controller.abort()
    // Let the server see the closed socket, then let the in-flight read finish.
    await delay(250)
    release()
    assert.equal(await pending, 'AbortError')

    const settled = api.calls.length
    await delay(200)
    assert.equal(api.calls.length, settled, 'the batch must stop once the client is gone')
    assert.equal(api.nodes.has('/b/f1.txt'), false, 'the next entry is never started')
  } finally {
    await api.close()
  }
})
