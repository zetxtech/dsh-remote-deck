/**
 * The file page's single-name write actions: rename, new folder, new file.
 *
 * Two layers are exercised:
 *
 * - `lib/fs-actions.js` on its own: the path/name rules and the exact SFTP
 *   calls (through an injected `call`, so the happy path is asserted without a
 *   server).
 * - The `POST /connections/<id>/rename|mkdir|touch` routes over loopback HTTP,
 *   against an in-memory SFTP tree: status codes, the frozen response shapes,
 *   and the rule that an existing name answers 409 instead of being replaced.
 *
 * Hermetic like the sibling route tests: an ephemeral port, a fake host and a
 * temp data directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { createApi } from '../lib/api.js'
import {
  FS_ACTION_BAD_NAME_CODE,
  FS_ACTION_EXISTS_CODE,
  FS_ACTION_INVALID_PATH_CODE,
  FS_ACTION_MAX_NAME_BYTES,
  FS_ACTION_MISSING_CODE,
  mkdirRemotePath,
  parseNameRequest,
  renameRemotePath,
  touchRemotePath,
} from '../lib/fs-actions.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

const MODES = { dir: 0o040755, file: 0o100644, link: 0o120777 }

function attrsOf(node) {
  return {
    mode: MODES[node.type] ?? MODES.file,
    size: node.size ?? 0,
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
 * Minimal SFTP surface: `lstat`/`stat`, `rename`, `mkdir`, `writeFile`, plus a
 * log of every call and of the bytes written.
 *
 * @param {Record<string, object>} initial path -> node
 * @param {object} [options]
 * @param {(op: string, ...args: unknown[]) => (Error | string | null)} [options.fail] injected failure
 * @param {(op: string, ...args: unknown[]) => Promise<void> | null} [options.hold] block one operation
 * @param {(op: string, ...args: unknown[]) => void} [options.onCall] observe every call
 */
function makeSftp(initial, options = {}) {
  const nodes = new Map(Object.entries(initial ?? {}))
  const calls = []
  const writes = []
  const record = (op, ...args) => {
    calls.push([op, ...args])
    if (typeof options.onCall === 'function') options.onCall(op, ...args)
  }
  const failureFor = (op, ...args) => {
    const failure = typeof options.fail === 'function' ? options.fail(op, ...args) : null
    if (failure === null || failure === undefined || failure === false) return null
    if (failure instanceof Error) return failure
    const error = new Error(String(failure))
    error.code = 4
    return error
  }
  const gateFor = (op, ...args) => {
    const gate = typeof options.hold === 'function' ? options.hold(op, ...args) : null
    return gate === null || gate === undefined ? null : gate
  }
  const send = (callback, error, attrs) => {
    if (error !== null) {
      callback(error)
      return
    }
    callback(null, attrs)
  }
  /** `/` always exists; every other parent must be a directory in the tree. */
  const parentMissing = (path) => {
    const parent = posix.dirname(path)
    if (parent === '/') return false
    return !(nodes.has(parent) && nodes.get(parent).type === 'dir')
  }
  const sftp = {
    lstat(path, callback) {
      record('lstat', path)
      const failure = failureFor('lstat', path)
      if (failure !== null) {
        send(callback, failure, null)
        return
      }
      const attrs = nodes.has(path) ? attrsOf(nodes.get(path)) : null
      const gate = gateFor('lstat', path)
      const finish = () => send(callback, attrs === null ? notFound(path) : null, attrs)
      if (gate === null) finish()
      else gate.then(finish, finish)
    },
    stat(path, callback) {
      record('stat', path)
      const failure = failureFor('stat', path)
      if (failure !== null) {
        send(callback, failure, null)
        return
      }
      send(callback, nodes.has(path) ? null : notFound(path), nodes.has(path) ? attrsOf(nodes.get(path)) : null)
    },
    rename(from, to, callback) {
      record('rename', from, to)
      const failure = failureFor('rename', from, to)
      if (failure !== null) {
        send(callback, failure, null)
        return
      }
      const node = nodes.get(from)
      if (node === undefined) {
        send(callback, notFound(from), null)
        return
      }
      nodes.delete(from)
      nodes.set(to, node)
      send(callback, null, null)
    },
    mkdir(path, callback) {
      record('mkdir', path)
      const failure = failureFor('mkdir', path)
      if (failure !== null) {
        send(callback, failure, null)
        return
      }
      if (parentMissing(path)) {
        send(callback, notFound(posix.dirname(path)), null)
        return
      }
      if (nodes.has(path)) {
        const error = new Error('SSH_FX_FAILURE')
        error.code = 4
        send(callback, error, null)
        return
      }
      nodes.set(path, { type: 'dir' })
      send(callback, null, null)
    },
    writeFile(path, buffer, callback) {
      record('writeFile', path)
      const failure = failureFor('writeFile', path, buffer)
      if (failure !== null) {
        send(callback, failure, null)
        return
      }
      if (parentMissing(path)) {
        send(callback, notFound(posix.dirname(path)), null)
        return
      }
      writes.push({ path, buffer: Buffer.from(buffer) })
      nodes.set(path, { type: 'file', content: Buffer.from(buffer).toString('utf8'), size: Buffer.from(buffer).length })
      send(callback, null, null)
    },
  }
  return { sftp, nodes, calls, writes }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(10)
  }
  throw new Error('timed out waiting for the request to reach that point')
}

// ------------------------------------------------------------- pure rules

test('parseNameRequest accepts a plain path and one trimmed name segment', () => {
  assert.deepEqual(parseNameRequest({ path: '/data/ws', name: 'a.txt' }), { ok: true, path: '/data/ws', name: 'a.txt' })
  // Redundant but harmless spellings are normalized, not rejected.
  assert.deepEqual(parseNameRequest({ path: '/data/ws/', name: 'a.txt' }), { ok: true, path: '/data/ws', name: 'a.txt' })
  assert.deepEqual(parseNameRequest({ path: '/data//ws', name: 'a.txt' }), { ok: true, path: '/data/ws', name: 'a.txt' })
  // The name is trimmed: outer whitespace is an accident, not a name.
  assert.equal(parseNameRequest({ path: '/d', name: '  a.txt  ' }).name, 'a.txt')
  // The filesystem root is a directory the page can show: "new folder in /".
  assert.deepEqual(parseNameRequest({ path: '/', name: 'top' }), { ok: true, path: '/', name: 'top' })
})

test('a name is one plain segment, at most 255 bytes', () => {
  for (const bad of ['', '   ', '.', '..', 'a/b', '/a', 'a\u0000b', undefined, null, 42, {}, ['a']]) {
    const result = parseNameRequest({ path: '/d', name: bad })
    assert.equal(result.ok, false, String(bad))
    assert.equal(result.code, FS_ACTION_BAD_NAME_CODE, String(bad))
    assert.equal(typeof result.message, 'string')
  }
  // The limit is UTF-8 bytes, exactly NAME_MAX: 255 passes, 256 does not.
  assert.equal(parseNameRequest({ path: '/d', name: 'a'.repeat(FS_ACTION_MAX_NAME_BYTES) }).ok, true)
  assert.equal(parseNameRequest({ path: '/d', name: 'a'.repeat(FS_ACTION_MAX_NAME_BYTES + 1) }).code, FS_ACTION_BAD_NAME_CODE)
  // Three bytes per character: 86 characters are already 258 bytes.
  assert.equal(parseNameRequest({ path: '/d', name: '汉'.repeat(86) }).code, FS_ACTION_BAD_NAME_CODE)
  assert.equal(parseNameRequest({ path: '/d', name: '汉'.repeat(85) }).ok, true)
})

test('a path must be a plain absolute remote POSIX path', () => {
  for (const bad of ['', 'data/ws', './ws', '../ws', '/data/../etc', '//data/ws', 'C:\\data\\ws', undefined, null, 42, {}]) {
    const result = parseNameRequest({ path: bad, name: 'x' })
    assert.equal(result.ok, false, String(bad))
    assert.equal(result.code, FS_ACTION_INVALID_PATH_CODE, String(bad))
  }
  assert.equal(parseNameRequest({ path: '/', name: 'x' }).ok, true)
})

test('the three helpers talk SFTP through an injected call', async () => {
  const tree = new Set(['/d', '/d/a.txt'])
  const calls = []
  const call = async (_sftp, method, ...args) => {
    calls.push([method, ...args])
    if (method === 'lstat' || method === 'stat') {
      if (!tree.has(args[0])) throw notFound(args[0])
      return { isDirectory: () => args[0] === '/d', isFile: () => args[0] !== '/d', size: 0 }
    }
    if (method === 'rename') {
      if (!tree.has(args[0])) throw notFound(args[0])
      tree.delete(args[0])
      tree.add(args[1])
      return undefined
    }
    if (method === 'mkdir' || method === 'writeFile') {
      tree.add(args[0])
      return undefined
    }
    throw new Error(`unexpected SFTP call: ${method}`)
  }
  const options = { sftp: {}, call }

  assert.deepEqual(await renameRemotePath({ ...options, path: '/d/a.txt', name: 'b.txt' }), { ok: true, path: '/d/b.txt' })
  assert.deepEqual(await mkdirRemotePath({ ...options, path: '/d', name: 'sub' }), { ok: true, path: '/d/sub' })
  assert.deepEqual(await touchRemotePath({ ...options, path: '/d', name: 'empty.txt' }), { ok: true, path: '/d/empty.txt' })

  const write = calls.find((row) => row[0] === 'writeFile')
  assert.equal(Buffer.isBuffer(write[2]), true)
  assert.equal(write[2].length, 0)
  assert.deepEqual(calls, [
    ['lstat', '/d/a.txt'],
    ['lstat', '/d/b.txt'],
    ['rename', '/d/a.txt', '/d/b.txt'],
    ['lstat', '/d/sub'],
    ['mkdir', '/d/sub'],
    ['lstat', '/d/empty.txt'],
    ['writeFile', '/d/empty.txt', Buffer.alloc(0)],
  ])

  // The helpers validate on their own too, and a refused request never reaches SFTP.
  const settled = calls.length
  assert.equal((await touchRemotePath({ sftp: {}, path: 'relative', name: 'x' })).code, FS_ACTION_INVALID_PATH_CODE)
  assert.equal((await mkdirRemotePath({ sftp: {}, path: '/d', name: 'a/b' })).code, FS_ACTION_BAD_NAME_CODE)
  assert.equal(calls.length, settled)
})

// ---------------------------------------------------------------- the routes

const SECRETS = { describe: async () => ({}), set: async () => {}, clear: async () => {} }

async function startApi(nodes = {}, options = {}) {
  const fake = makeSftp(nodes, options)
  let ensured = 0
  const host = {
    ensure: async () => {
      ensured += 1
    },
    requireSftp: () => fake.sftp,
  }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: SECRETS,
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-actions-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    nodes: fake.nodes,
    calls: fake.calls,
    writes: fake.writes,
    ensures: () => ensured,
    // A connection whose client aborted would otherwise hold `close()` open for
    // the keep-alive timeout; the sibling route tests do the same.
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * One POST to a connection action. `token: null` sends no token at all;
 * `id` selects another connection id.
 */
function actionRequest(base, action, body, { token = TOKEN, id = RECORD.id } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers[TOKEN_HEADER] = token
  return fetch(`${base}/connections/${id}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

// ------------------------------------------------------------------ rename

test('rename answers the new absolute path and the name', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 3 } })
  try {
    const response = await actionRequest(api.base, 'rename', { path: '/data/ws/a.txt', name: 'b.txt' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, path: '/data/ws/b.txt', name: 'b.txt' })
    // The request is validated and executed against the connection the route
    // resolved, which is what `host.ensure` guarantees first.
    assert.equal(api.ensures(), 1)
    assert.deepEqual(api.calls, [
      ['lstat', '/data/ws/a.txt'],
      ['lstat', '/data/ws/b.txt'],
      ['rename', '/data/ws/a.txt', '/data/ws/b.txt'],
    ])
    assert.equal(api.nodes.has('/data/ws/a.txt'), false)
    assert.equal(api.nodes.has('/data/ws/b.txt'), true)
  } finally {
    await api.close()
  }
})

test('rename moves a directory just like a file', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/old': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'rename', { path: '/data/ws/old', name: 'new' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).path, '/data/ws/new')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [['rename', '/data/ws/old', '/data/ws/new']])
    assert.equal(api.nodes.get('/data/ws/new').type, 'dir')
  } finally {
    await api.close()
  }
})

test('renaming a path that is not there answers 404', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'rename', { path: '/data/ws/missing.txt', name: 'x.txt' })
    const body = await response.json()
    assert.equal(response.status, 404)
    assert.equal(body.ok, false)
    assert.equal(body.code, FS_ACTION_MISSING_CODE)
    // Refused before any rename: the source is checked first.
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [])
  } finally {
    await api.close()
  }
})

test('a name that already exists answers 409 instead of replacing it', async () => {
  const api = await startApi({
    '/data/ws': { type: 'dir' },
    '/data/ws/a.txt': { type: 'file', size: 1 },
    '/data/ws/b.txt': { type: 'file', size: 2 },
  })
  try {
    const response = await actionRequest(api.base, 'rename', { path: '/data/ws/a.txt', name: 'b.txt' })
    const body = await response.json()
    assert.equal(response.status, 409)
    assert.equal(body.ok, false)
    assert.equal(body.code, FS_ACTION_EXISTS_CODE)
    // OpenSSH's rename would have replaced b.txt silently: no rename may run.
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [])
    assert.equal(api.nodes.has('/data/ws/b.txt'), true)
    assert.equal(api.nodes.has('/data/ws/a.txt'), true)
  } finally {
    await api.close()
  }
})

test('a server-side rename failure with the destination present is 409, not a 500', async () => {
  let api
  api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } }, {
    fail: (op) => (op === 'rename' ? 'SSH_FX_FAILURE' : null),
    // The destination appears after this route checked it and before the
    // server's refusal comes back: a race the client must read as EXISTS.
    onCall: (op) => {
      if (op === 'rename') api.nodes.set('/data/ws/b.txt', { type: 'file', size: 0 })
    },
  })
  try {
    const response = await actionRequest(api.base, 'rename', { path: '/data/ws/a.txt', name: 'b.txt' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, FS_ACTION_EXISTS_CODE)
  } finally {
    await api.close()
  }
})

// -------------------------------------------------------------------- mkdir

test('mkdir creates the folder and answers its absolute path', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'mkdir', { path: '/data/ws', name: '新文件夹' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, path: '/data/ws/新文件夹' })
    assert.equal(api.ensures(), 1)
    assert.deepEqual(api.calls, [['lstat', '/data/ws/新文件夹'], ['mkdir', '/data/ws/新文件夹']])
    assert.equal(api.nodes.get('/data/ws/新文件夹').type, 'dir')
  } finally {
    await api.close()
  }
})

test('mkdir works in the filesystem root', async () => {
  const api = await startApi({})
  try {
    const response = await actionRequest(api.base, 'mkdir', { path: '/', name: 'top' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).path, '/top')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'mkdir'), [['mkdir', '/top']])
  } finally {
    await api.close()
  }
})

test('mkdir on an existing name answers 409', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/taken': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'mkdir', { path: '/data/ws', name: 'taken' })
    const body = await response.json()
    assert.equal(response.status, 409)
    assert.equal(body.code, FS_ACTION_EXISTS_CODE)
    assert.deepEqual(api.calls.filter((call) => call[0] === 'mkdir'), [])
  } finally {
    await api.close()
  }
})

test('mkdir in a folder that does not exist answers 404', async () => {
  const api = await startApi({ '/data': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'mkdir', { path: '/data/missing', name: 'sub' })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, FS_ACTION_MISSING_CODE)
  } finally {
    await api.close()
  }
})

// -------------------------------------------------------------------- touch

test('touch creates an empty file', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'touch', { path: '/data/ws', name: 'new.txt' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, path: '/data/ws/new.txt' })
    assert.equal(api.ensures(), 1)
    assert.deepEqual(api.calls, [['lstat', '/data/ws/new.txt'], ['writeFile', '/data/ws/new.txt']])
    // An empty file: zero bytes, written as a Buffer, and no content invented.
    assert.equal(api.writes.length, 1)
    assert.equal(api.writes[0].path, '/data/ws/new.txt')
    assert.equal(Buffer.isBuffer(api.writes[0].buffer), true)
    assert.equal(api.writes[0].buffer.length, 0)
    const node = api.nodes.get('/data/ws/new.txt')
    assert.equal(node.type, 'file')
    assert.equal(node.size, 0)
  } finally {
    await api.close()
  }
})

test('touch on an existing name answers 409 and leaves the file alone', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/taken.txt': { type: 'file', size: 5 } })
  try {
    const response = await actionRequest(api.base, 'touch', { path: '/data/ws', name: 'taken.txt' })
    const body = await response.json()
    assert.equal(response.status, 409)
    assert.equal(body.code, FS_ACTION_EXISTS_CODE)
    // writeFile would have truncated it; it must not even be attempted.
    assert.deepEqual(api.calls.filter((call) => call[0] === 'writeFile'), [])
    assert.equal(api.nodes.get('/data/ws/taken.txt').size, 5)
  } finally {
    await api.close()
  }
})

test('touch in a folder that does not exist answers 404', async () => {
  const api = await startApi({ '/data': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'touch', { path: '/data/missing', name: 'x.txt' })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, FS_ACTION_MISSING_CODE)
    assert.deepEqual(api.writes, [])
  } finally {
    await api.close()
  }
})

// ------------------------------------------------------- shared validation

test('all three routes refuse a bad name with 400 BAD_NAME', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } })
  try {
    const badNames = ['', '   ', '.', '..', 'a/b', '/a', 'a\u0000b', 'a'.repeat(256), '汉'.repeat(86)]
    for (const action of ['rename', 'mkdir', 'touch']) {
      for (const name of badNames) {
        const response = await actionRequest(api.base, action, { path: '/data/ws', name })
        assert.equal(response.status, 400, `${action} ${JSON.stringify(name)}`)
        const body = await response.json()
        assert.equal(body.ok, false)
        assert.equal(body.code, FS_ACTION_BAD_NAME_CODE, `${action} ${JSON.stringify(name)}`)
      }
    }
    // Nothing malformed reached the filesystem.
    assert.deepEqual(api.calls, [])
    assert.equal(api.nodes.has('/data/ws/a.txt'), true)
  } finally {
    await api.close()
  }
})

test('all three routes refuse a bad path with 400 NOT_REMOTE_PATH', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } })
  try {
    const badPaths = ['', 'data/ws', './ws', '../ws', '/data/../etc', '//data/ws', 'C:\\data\\ws', undefined, null, 42]
    for (const action of ['rename', 'mkdir', 'touch']) {
      for (const path of badPaths) {
        const response = await actionRequest(api.base, action, { path, name: 'x' })
        assert.equal(response.status, 400, `${action} ${String(path)}`)
        const body = await response.json()
        assert.equal(body.ok, false)
        assert.equal(body.code, FS_ACTION_INVALID_PATH_CODE, `${action} ${String(path)}`)
      }
    }
    assert.deepEqual(api.calls, [])
  } finally {
    await api.close()
  }
})

test('all three routes need the token', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } })
  try {
    for (const action of ['rename', 'mkdir', 'touch']) {
      const response = await actionRequest(api.base, action, { path: '/data/ws', name: 'x' }, { token: null })
      assert.equal(response.status, 403, action)
      assert.equal((await response.json()).ok, false)
    }
    // Refused at the door: not even the connection was resolved.
    assert.equal(api.ensures(), 0)
    assert.deepEqual(api.calls, [])
  } finally {
    await api.close()
  }
})

test('all three routes answer 404 for a connection that does not exist', async () => {
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } })
  try {
    for (const action of ['rename', 'mkdir', 'touch']) {
      const response = await actionRequest(api.base, action, { path: '/data/ws', name: 'x' }, { id: 'nope' })
      assert.equal(response.status, 404, action)
      assert.equal((await response.json()).ok, false)
    }
    assert.equal(api.ensures(), 0)
    assert.deepEqual(api.calls, [])
  } finally {
    await api.close()
  }
})

// ---------------------------------------------------------------------- misc

test('the path-bar chain mkdir (recursive) still creates every missing parent', async () => {
  const api = await startApi({ '/data': { type: 'dir' } })
  try {
    const response = await actionRequest(api.base, 'mkdir', { path: '/data/a/b', recursive: true })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, path: '/data/a/b' })
    assert.deepEqual(api.calls.filter((call) => call[0] === 'mkdir').map((call) => call[1]), ['/data/a', '/data/a/b'])
    assert.equal(api.nodes.get('/data/a/b').type, 'dir')
  } finally {
    await api.close()
  }
})

test('a client that walks away mid-rename gets no response and breaks nothing', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = await startApi({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': { type: 'file', size: 1 } }, {
    // Hold the rename route's source check, so the client can abort mid-flight.
    hold: (op, path) => (op === 'lstat' && path === '/data/ws/a.txt' ? gate : null),
  })
  try {
    const controller = new AbortController()
    const pending = fetch(`${api.base}/connections/${RECORD.id}/rename`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/data/ws/a.txt', name: 'b.txt' }),
      signal: controller.signal,
    }).then(
      (response) => `status:${response.status}`,
      (error) => error.name,
    )
    await waitFor(() => api.calls.some((call) => call[0] === 'lstat' && call[1] === '/data/ws/a.txt'))
    controller.abort()
    // Give the server a turn to see the closed socket, then let the held SFTP
    // call finish: the handler must return without writing into a dead socket.
    await delay(200)
    release()
    assert.equal(await pending, 'AbortError')
    await delay(100)
    // The server survived the aborted request: the next one is answered.
    const after = await actionRequest(api.base, 'touch', { path: '/data/ws', name: 'after.txt' })
    assert.equal(after.status, 200)
  } finally {
    await api.close()
  }
})
