/**
 * Resumable (chunked) uploads: `lib/upload-chunks.js` and the four routes.
 *
 * Two layers are exercised:
 *
 * - The module on its own: validation and the exact SFTP calls (through an
 *   injected `call` where a server would only get in the way).
 * - `GET  /connections/:id/upload/status`
 *   `POST /connections/:id/upload/part`
 *   `POST /connections/:id/upload/commit`
 *   `POST /connections/:id/upload/abort`
 *   over loopback HTTP against an in-memory SFTP tree that records `open`,
 *   `stat`, `write` positions, `rename` and `unlink`. Status codes, the frozen
 *   response shapes and the offset rules are asserted there.
 *
 * Hermetic like the sibling route tests: an ephemeral port, a fake host and a
 * temp data directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { createApi } from '../lib/api.js'
import {
  UPLOAD_BAD_OFFSET_CODE,
  UPLOAD_EMPTY_PART_CODE,
  UPLOAD_EXISTS_CODE,
  UPLOAD_MISSING_CODE,
  UPLOAD_OFFSET_MISMATCH_CODE,
  UPLOAD_PART_MAX_BYTES,
  UPLOAD_PART_TOO_LARGE_CODE,
  UPLOAD_TEMP_HASH_LENGTH,
  UPLOAD_TEMP_PREFIX,
  parseUploadOffset,
  parseUploadTarget,
  uploadTempPath,
} from '../lib/upload-chunks.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = {
  id: 'c1',
  name: 'ws',
  host: 'example.test',
  port: 22,
  username: 'demo',
  authType: 'key',
  privateKeyPath: '/k',
  color: 'blue',
}

const MODES = { dir: 0o040755, file: 0o100644 }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The temporary file the route is expected to use for `name`. */
function tempName(name) {
  return UPLOAD_TEMP_PREFIX + createHash('sha1').update(name).digest('hex').slice(0, UPLOAD_TEMP_HASH_LENGTH)
}

function attrsOf(node) {
  return {
    mode: MODES[node.type] ?? MODES.file,
    size: node.type === 'file' ? node.content.length : 0,
    mtime: 0,
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    isSymbolicLink: () => false,
  }
}

function notFound(path) {
  const error = new Error(`No such file: ${path}`)
  error.code = 2
  return error
}

/**
 * Minimal SFTP surface for one directory tree: `stat`/`lstat`, `open`, `write`,
 * `close`, `rename` and `unlink`. Every call and every write position is
 * recorded so assertions can pin the exact protocol.
 *
 * Nodes are `{ type: 'dir' }` or `{ type: 'file', content: Buffer }`.
 */
function makeSftp(initial, options = {}) {
  const nodes = new Map(Object.entries(initial ?? {}))
  const calls = []
  let handleSeq = 0
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
  /** `/` always exists; every other parent must be a directory in the tree. */
  const parentMissing = (path) => {
    const parent = posix.dirname(path)
    if (parent === '/') return false
    return !(nodes.has(parent) && nodes.get(parent).type === 'dir')
  }
  const finish = (gate, callback, error, value) => {
    const done = () => (error ? callback(error) : callback(null, value))
    if (gate === null) done()
    else gate.then(done, done)
  }
  const sftp = {
    lstat(path, callback) {
      record('lstat', path)
      const failure = failureFor('lstat', path)
      if (failure !== null) return callback(failure)
      const node = nodes.get(path)
      if (node === undefined) return callback(notFound(path))
      const gate = gateFor('lstat', path)
      finish(gate, callback, null, attrsOf(node))
    },
    stat(path, callback) {
      record('stat', path)
      const failure = failureFor('stat', path)
      if (failure !== null) return callback(failure)
      const node = nodes.get(path)
      if (node === undefined) return callback(notFound(path))
      const gate = gateFor('stat', path)
      finish(gate, callback, null, attrsOf(node))
    },
    open(path, flags, mode, callback) {
      record('open', path, flags)
      const failure = failureFor('open', path, flags)
      if (failure !== null) return callback(failure)
      const gate = gateFor('open', path, flags)
      const done = () => {
        if (flags === 'w') {
          if (parentMissing(path)) return callback(notFound(posix.dirname(path)))
          nodes.set(path, { type: 'file', content: Buffer.alloc(0) })
        } else if (nodes.has(path) !== true) {
          return callback(notFound(path))
        }
        handleSeq += 1
        callback(null, { id: handleSeq, path })
      }
      if (gate === null) done()
      else gate.then(done, done)
    },
    write(handle, buffer, offset, length, position, callback) {
      record('write', handle.path, position, Buffer.from(buffer).subarray(offset, offset + length).length)
      const failure = failureFor('write', handle.path, position)
      if (failure !== null) return callback(failure)
      const gate = gateFor('write', handle.path, position)
      const done = () => {
        const node = nodes.get(handle.path)
        if (node === undefined) return callback(notFound(handle.path))
        const bytes = Buffer.from(buffer).subarray(offset, offset + length)
        const end = position + bytes.length
        const next = Buffer.alloc(Math.max(node.content.length, end))
        node.content.copy(next)
        bytes.copy(next, position)
        node.content = next
        callback(null)
      }
      if (gate === null) done()
      else gate.then(done, done)
    },
    close(handle, callback) {
      record('close', handle.path)
      callback(null)
    },
    rename(from, to, callback) {
      record('rename', from, to)
      const failure = failureFor('rename', from, to)
      if (failure !== null) return callback(failure)
      const node = nodes.get(from)
      if (node === undefined) return callback(notFound(from))
      nodes.delete(from)
      nodes.set(to, node)
      callback(null)
    },
    unlink(path, callback) {
      record('unlink', path)
      const failure = failureFor('unlink', path)
      if (failure !== null) return callback(failure)
      if (nodes.has(path) !== true) return callback(notFound(path))
      nodes.delete(path)
      callback(null)
    },
  }
  return { sftp, nodes, calls }
}

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
    dataDir: mkdtempSync(join(tmpdir(), 'rd-upload-chunks-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    nodes: fake.nodes,
    calls: fake.calls,
    ensures: () => ensured,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function withToken(headers, token) {
  if (token !== null) headers[TOKEN_HEADER] = token
  return headers
}

function queryOf({ dir = '/d', name = 'big.bin' }) {
  return `path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`
}

function statusRequest(base, options = {}) {
  const { id = RECORD.id, token = TOKEN } = options
  return fetch(`${base}/connections/${id}/upload/status?${queryOf(options)}`, {
    headers: withToken({}, token),
  })
}

function partRequest(base, options = {}) {
  const { id = RECORD.id, token = TOKEN, offset = 0, data = Buffer.from('') } = options
  const url = `${base}/connections/${id}/upload/part?${queryOf(options)}&offset=${encodeURIComponent(String(offset))}`
  return fetch(url, {
    method: 'POST',
    headers: withToken({ 'content-type': 'application/octet-stream' }, token),
    body: data,
  })
}

function jsonRequest(base, operation, options = {}) {
  const { id = RECORD.id, token = TOKEN, overwrite } = options
  const extra = overwrite === undefined ? '' : `&overwrite=${encodeURIComponent(String(overwrite))}`
  return fetch(`${base}/connections/${id}/upload/${operation}?${queryOf(options)}${extra}`, {
    method: 'POST',
    headers: withToken({ 'content-type': 'application/json' }, token),
    body: '{}',
  })
}

async function bodyOf(response) {
  return response.json()
}

// ------------------------------------------------------------------ pure rules

test('uploadTempPath hashes the name into one hidden sibling of the directory', () => {
  const path = uploadTempPath('/data/ws', '报告 final.txt')
  assert.equal(path, posix.join('/data/ws', tempName('报告 final.txt')))
  assert.match(path, /^\/data\/ws\/\.dsh-part-[0-9a-f]{12}$/)
  // The name itself never reaches the path: slashes and dots cannot escape.
  assert.equal(uploadTempPath('/', '../a.bin'), '/' + tempName('../a.bin'))
  // Same name, different directory: different temporary files.
  assert.notEqual(uploadTempPath('/data/ws', 'a.bin'), uploadTempPath('/data/other', 'a.bin'))
})

test('parseUploadTarget reuses the file page path and name rules', () => {
  const parsed = parseUploadTarget({ path: '/data/ws/', name: '  a.bin  ' })
  assert.deepEqual(parsed, {
    ok: true,
    dir: '/data/ws',
    name: 'a.bin',
    target: '/data/ws/a.bin',
    temp: '/data/ws/' + tempName('a.bin'),
  })
  for (const bad of ['', 'data/ws', './ws', '../ws', '/data/../etc', '//data/ws', null, 42]) {
    assert.equal(parseUploadTarget({ path: bad, name: 'a.bin' }).code, 'NOT_REMOTE_PATH', String(bad))
  }
  for (const bad of ['', '..', '.', 'a/b', '/a', 'a\u0000b', null, 42]) {
    assert.equal(parseUploadTarget({ path: '/d', name: bad }).code, 'BAD_NAME', String(bad))
  }
})

test('parseUploadOffset accepts only a non-negative integer', () => {
  assert.deepEqual(parseUploadOffset(0), { ok: true, offset: 0 })
  assert.deepEqual(parseUploadOffset('0'), { ok: true, offset: 0 })
  assert.deepEqual(parseUploadOffset('4194304'), { ok: true, offset: 4194304 })
  for (const bad of ['-1', '1.5', '1e3', ' 1', 'abc', '', '+1', null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseUploadOffset(bad).code, UPLOAD_BAD_OFFSET_CODE, String(bad))
  }
  // Bigger than any file a browser can hold: refused as an integer.
  assert.equal(parseUploadOffset('9007199254740993').code, UPLOAD_BAD_OFFSET_CODE)
})

test('the module talks SFTP through an injected call, status included', async () => {
  const { sftp, nodes, calls } = makeSftp({ '/d': { type: 'dir' } })
  const { readUploadStatus, writeUploadPart, commitUpload, abortUpload } = await import('../lib/upload-chunks.js')
  assert.deepEqual(await readUploadStatus({ sftp, dir: '/d', name: 'a.bin' }), { ok: true, exists: false, received: 0 })
  assert.deepEqual(await writeUploadPart({ sftp, dir: '/d', name: 'a.bin', offset: 0, data: Buffer.from('abc') }), { ok: true, received: 3 })
  assert.deepEqual(await readUploadStatus({ sftp, dir: '/d', name: 'a.bin' }), { ok: true, exists: true, received: 3 })
  assert.deepEqual(await commitUpload({ sftp, dir: '/d', name: 'a.bin' }), { ok: true, path: '/d/a.bin' })
  assert.deepEqual(await abortUpload({ sftp, dir: '/d', name: 'a.bin' }), { ok: true })
  assert.equal(nodes.get('/d/a.bin').content.toString('utf8'), 'abc')
  assert.deepEqual(calls.filter((call) => call[0] === 'write'), [['write', '/d/' + tempName('a.bin'), 0, 3]])
})

// ------------------------------------------------------------------ status

test('status answers 0 without creating anything until a part arrives', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    const before = await statusRequest(api.base)
    assert.equal(before.status, 200)
    assert.deepEqual(await bodyOf(before), { ok: true, exists: false, received: 0 })
    assert.equal(api.nodes.has('/d/' + tempName('big.bin')), false, 'status is read-only')

    const part = await partRequest(api.base, { offset: 0, data: Buffer.from('hello') })
    assert.equal(part.status, 200)
    assert.deepEqual(await bodyOf(part), { ok: true, received: 5 })
    const after = await statusRequest(api.base)
    assert.deepEqual(await bodyOf(after), { ok: true, exists: true, received: 5 })
    assert.deepEqual(api.calls, [
      ['stat', '/d/' + tempName('big.bin')],
      ['stat', '/d/' + tempName('big.bin')],
      ['open', '/d/' + tempName('big.bin'), 'w'],
      ['write', '/d/' + tempName('big.bin'), 0, 5],
      ['close', '/d/' + tempName('big.bin')],
      ['stat', '/d/' + tempName('big.bin')],
    ])
    assert.equal(api.ensures(), 3, 'every chunk request makes sure the connection is up')
  } finally {
    await api.close()
  }
})

// -------------------------------------------------------------------- parts

test('a first part at 0 creates the temporary file and later parts append', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    assert.equal((await partRequest(api.base, { offset: 0, data: Buffer.from('abcd') })).status, 200)
    assert.deepEqual(await bodyOf(await partRequest(api.base, { offset: 4, data: Buffer.from('ef') })), { ok: true, received: 6 })
    const temp = '/d/' + tempName('big.bin')
    assert.equal(api.nodes.get(temp).content.toString('utf8'), 'abcdef')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'open'), [['open', temp, 'w'], ['open', temp, 'r+']])
    assert.deepEqual(api.calls.filter((call) => call[0] === 'write').map((call) => call[2]), [0, 4])

    // Offset 0 always rebuilds: a resumed upload may deliberately start over.
    assert.deepEqual(await bodyOf(await partRequest(api.base, { offset: 0, data: Buffer.from('XY') })), { ok: true, received: 2 })
    assert.equal(api.nodes.get(temp).content.toString('utf8'), 'XY')
  } finally {
    await api.close()
  }
})

test('an offset that does not match the remote is 409 OFFSET_MISMATCH with the real count', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('abcd') })
    const temp = '/d/' + tempName('big.bin')
    const opens = api.calls.filter((call) => call[0] === 'open').length

    for (const offset of [2, 6]) {
      const response = await partRequest(api.base, { offset, data: Buffer.from('zz') })
      const body = await bodyOf(response)
      assert.equal(response.status, 409)
      assert.equal(body.ok, false)
      assert.equal(body.code, UPLOAD_OFFSET_MISMATCH_CODE)
      assert.equal(body.received, 4, 'the answer says where to continue')
    }
    assert.equal(api.calls.filter((call) => call[0] === 'open').length, opens, 'a mismatch never opens the file')
    assert.equal(api.nodes.get(temp).content.toString('utf8'), 'abcd', 'nothing was written')

    // The correct offset continues from what the remote really has.
    assert.deepEqual(await bodyOf(await partRequest(api.base, { offset: 4, data: Buffer.from('ef') })), { ok: true, received: 6 })
    assert.equal(api.nodes.get(temp).content.toString('utf8'), 'abcdef')
  } finally {
    await api.close()
  }
})

test('a part larger than 8 MiB or an empty part is refused with 400', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    const tooLarge = await partRequest(api.base, { offset: 0, data: Buffer.alloc(UPLOAD_PART_MAX_BYTES + 1, 7) })
    assert.equal(tooLarge.status, 400)
    assert.equal((await bodyOf(tooLarge)).code, UPLOAD_PART_TOO_LARGE_CODE)
    // Refused from the declared length before the connection is woken up.
    assert.equal(api.ensures(), 0)
    assert.equal(api.calls.length, 0)

    const empty = await partRequest(api.base, { offset: 0, data: Buffer.alloc(0) })
    assert.equal(empty.status, 400)
    assert.equal((await bodyOf(empty)).code, UPLOAD_EMPTY_PART_CODE)
    assert.equal(api.nodes.has('/d/' + tempName('big.bin')), false, 'an empty part creates nothing')

    // The limit is inclusive: exactly 8 MiB is one legal part.
    const exact = await partRequest(api.base, { offset: 0, data: Buffer.alloc(UPLOAD_PART_MAX_BYTES, 7) })
    assert.equal(exact.status, 200)
    assert.equal((await bodyOf(exact)).received, UPLOAD_PART_MAX_BYTES)
    assert.equal(api.nodes.get('/d/' + tempName('big.bin')).content.length, UPLOAD_PART_MAX_BYTES)
  } finally {
    await api.close()
  }
})

test('a part into a folder that is not there is refused, not mistaken for a mismatch', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    const response = await partRequest(api.base, { dir: '/missing', offset: 0, data: Buffer.from('x') })
    assert.equal(response.status, 404)
    assert.equal((await bodyOf(response)).code, UPLOAD_MISSING_CODE)
  } finally {
    await api.close()
  }
})

test('offset, path and name are validated before the connection is touched', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    for (const offset of ['-1', '1.5', 'abc', '']) {
      const response = await partRequest(api.base, { offset, data: Buffer.from('x') })
      assert.equal(response.status, 400, offset)
      assert.equal((await bodyOf(response)).code, UPLOAD_BAD_OFFSET_CODE, offset)
    }
    for (const name of ['', 'a/b', '..']) {
      const response = await statusRequest(api.base, { name })
      assert.equal(response.status, 400, name)
      assert.equal((await bodyOf(response)).code, 'BAD_NAME', name)
    }
    for (const dir of ['relative', '/d/../etc', '']) {
      const response = await statusRequest(api.base, { dir })
      assert.equal(response.status, 400, dir)
      assert.equal((await bodyOf(response)).code, 'NOT_REMOTE_PATH', dir)
    }
    assert.equal(api.ensures(), 0, 'a refused request never wakes the host')
    assert.equal(api.calls.length, 0)
  } finally {
    await api.close()
  }
})

// ------------------------------------------------------------------- commit

test('commit renames the temporary file onto the destination', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('abc') })
    await partRequest(api.base, { offset: 3, data: Buffer.from('def') })
    const temp = '/d/' + tempName('big.bin')
    const response = await jsonRequest(api.base, 'commit')
    assert.equal(response.status, 200)
    assert.deepEqual(await bodyOf(response), { ok: true, path: '/d/big.bin' })
    assert.equal(api.nodes.has(temp), false)
    assert.equal(api.nodes.get('/d/big.bin').content.toString('utf8'), 'abcdef')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [['rename', temp, '/d/big.bin']])
  } finally {
    await api.close()
  }
})

test('commit refuses to replace an existing destination with 409 EXISTS', async () => {
  const api = await startApi({
    '/d': { type: 'dir' },
    '/d/big.bin': { type: 'file', content: Buffer.from('old') },
  })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('new') })
    const response = await jsonRequest(api.base, 'commit')
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.ok, false)
    assert.equal(body.code, UPLOAD_EXISTS_CODE)
    assert.equal(api.nodes.get('/d/big.bin').content.toString('utf8'), 'old', 'never replaced')
    assert.equal(api.nodes.has('/d/' + tempName('big.bin')), true, 'the temporary file stays for a retry')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [])
  } finally {
    await api.close()
  }
})

test('commit with overwrite=1 replaces the file and still renames the temp', async () => {
  const api = await startApi({
    '/d': { type: 'dir' },
    '/d/big.bin': { type: 'file', content: Buffer.from('old') },
  })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('new') })
    const response = await jsonRequest(api.base, 'commit', { overwrite: '1' })
    assert.equal(response.status, 200)
    const body = await bodyOf(response)
    assert.equal(body.ok, true)
    assert.equal(api.nodes.get('/d/big.bin').content.toString('utf8'), 'new', 'the confirmed overwrite lands')
    assert.equal(api.nodes.has('/d/' + tempName('big.bin')), false, 'the temp file is consumed')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename').length, 1)
  } finally {
    await api.close()
  }
})

test('commit with overwrite=1 still refuses to replace a directory', async () => {
  const api = await startApi({ '/d': { type: 'dir' }, '/d/sub': { type: 'dir' } })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('x'), name: 'sub' })
    const response = await jsonRequest(api.base, 'commit', { name: 'sub', overwrite: '1' })
    assert.equal(response.status, 409)
    const body = await bodyOf(response)
    assert.equal(body.code, UPLOAD_EXISTS_CODE)
    assert.equal(api.nodes.get('/d/sub').type, 'dir', 'the directory is untouched')
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rmdir' || call[0] === 'unlink'), [])
  } finally {
    await api.close()
  }
})

test('commit without a temporary file is 404 NOT_FOUND', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    const response = await jsonRequest(api.base, 'commit')
    assert.equal(response.status, 404)
    assert.equal((await bodyOf(response)).code, UPLOAD_MISSING_CODE)
    assert.deepEqual(api.calls.filter((call) => call[0] === 'rename'), [])
  } finally {
    await api.close()
  }
})

// -------------------------------------------------------------------- abort

test('abort deletes the temporary file and is idempotent', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    await partRequest(api.base, { offset: 0, data: Buffer.from('abc') })
    const temp = '/d/' + tempName('big.bin')
    assert.deepEqual(await bodyOf(await jsonRequest(api.base, 'abort')), { ok: true })
    assert.equal(api.nodes.has(temp), false)
    // A second abort of the same upload still answers ok.
    const again = await jsonRequest(api.base, 'abort')
    assert.equal(again.status, 200)
    assert.deepEqual(await bodyOf(again), { ok: true })
  } finally {
    await api.close()
  }
})

// ------------------------------------------------------------- access rules

test('the chunk routes need the token and a known connection', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    for (const operation of ['status', 'part', 'commit', 'abort']) {
      const headers = { 'content-type': 'application/octet-stream' }
      const method = operation === 'status' ? 'GET' : 'POST'
      const unauthenticated = await fetch(
        `${api.base}/connections/${RECORD.id}/upload/${operation}?${queryOf({})}${operation === 'part' ? '&offset=0' : ''}`,
        { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) },
      )
      assert.equal(unauthenticated.status, 403, operation)
      // A query token is not accepted on these routes: header only.
      const queryToken = await fetch(
        `${api.base}/connections/${RECORD.id}/upload/${operation}?${queryOf({})}&token=${TOKEN}${operation === 'part' ? '&offset=0' : ''}`,
        { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) },
      )
      assert.equal(queryToken.status, 403, operation + ' query token')
    }
    assert.equal((await statusRequest(api.base, { id: 'nope' })).status, 404)
    assert.equal((await partRequest(api.base, { id: 'nope', data: Buffer.from('x') })).status, 404)
    assert.equal((await jsonRequest(api.base, 'commit', { id: 'nope' })).status, 404)
    assert.equal((await jsonRequest(api.base, 'abort', { id: 'nope' })).status, 404)
    // Wrong method for the operation is not found, not a write.
    const wrong = await fetch(`${api.base}/connections/${RECORD.id}/upload/status?${queryOf({})}`, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(wrong.status, 404)
  } finally {
    await api.close()
  }
})

test('a client that walks away mid-part gets no response and breaks nothing', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = await startApi({ '/d': { type: 'dir' } }, {
    // Hold the temporary-file open so the client can abort while the route is
    // inside SFTP, which is where a dropped connection really lands.
    hold: (op) => (op === 'open' ? gate : null),
  })
  try {
    const controller = new AbortController()
    const aborted = fetch(`${api.base}/connections/${RECORD.id}/upload/part?${queryOf({})}&offset=0`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/octet-stream' },
      body: Buffer.from('abc'),
      signal: controller.signal,
    }).then(
      (response) => `status:${response.status}`,
      (error) => error.name,
    )
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && api.calls.some((call) => call[0] === 'open') !== true) await delay(10)
    assert.equal(api.calls.some((call) => call[0] === 'open'), true, 'the route reached SFTP')
    controller.abort()
    // Give the server a turn to see the closed socket, then let the held SFTP
    // call finish: the handler must return without writing into a dead socket.
    await delay(200)
    release()
    assert.equal(await aborted, 'AbortError')
    await delay(100)
    // The server survived the aborted request: the next one is answered.
    const after = await statusRequest(api.base)
    assert.equal(after.status, 200)
    assert.equal((await bodyOf(after)).received, 3, 'the part was written before the client vanished')
  } finally {
    await api.close()
  }
})
