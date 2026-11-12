/**
 * Cancellable remote deletion: the path guard, the recursive SFTP walk and the
 * `POST /connections/<id>/delete` route.
 *
 * Everything is hermetic — an in-memory SFTP tree stands in for the host and the
 * route is exercised over loopback HTTP.
 *
 * The lifecycle notes in these tests are measured, not guessed: on Node 20 a
 * POST body is fully consumed before the handler runs, and the `IncomingMessage`
 * is destroyed immediately afterwards, so `request.destroyed` is true during a
 * perfectly healthy delete. The tests therefore drive cancellation the way the
 * browser does — aborting the request — and assert the route stops.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../lib/api.js'
import {
  DELETE_CANCELLED_CODE,
  DELETE_MISSING_CODE,
  DELETE_ROOT_CODE,
  DELETE_INVALID_CODE,
  emptyDeleteCounts,
  isDeleteCancelled,
  isProtectedDeleteRoot,
  parseDeleteTarget,
  removeRemoteTree,
} from '../lib/delete.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

/** A small remote tree: two files, a nested directory, a link out of the tree. */
const TREE = {
  '/data/ws': { type: 'dir' },
  '/data/ws/a.txt': { type: 'file', size: 10 },
  '/data/ws/sub': { type: 'dir' },
  '/data/ws/sub/b.txt': { type: 'file', size: 20 },
  '/data/ws/link': { type: 'link', size: 7, target: '/elsewhere/secret' },
  '/elsewhere/secret': { type: 'dir' },
  '/elsewhere/secret/keep.txt': { type: 'file', size: 99 },
}

function fileNode(size) {
  return { type: 'file', size }
}

/**
 * Minimal SFTP surface: `lstat`, `readdir`, `unlink`, `rmdir` and a call log.
 *
 * @param {Map<string, object>} nodes path -> node, mutated like a real host
 * @param {object} [options]
 * @param {(op: string, path: string) => string | null} [options.fail] injected failure
 * @param {(op: string, path: string) => Promise<void> | null} [options.hold] block one operation
 * @param {(op: string, path: string) => void} [options.onCall] observe every call
 * @param {(path: string) => string[]} [options.ghosts] entries that list but no longer exist
 */
function makeSftp(nodes, options = {}) {
  const calls = []
  const record = (op, path) => {
    calls.push([op, path])
    if (typeof options.onCall === 'function') options.onCall(op, path)
  }
  const attrsFor = (node) => ({
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    isSymbolicLink: () => node.type === 'link',
    size: node.size || 0,
    mtime: 0,
  })
  const sftp = {
    lstat(path, callback) {
      record('lstat', path)
      const node = nodes.get(path)
      if (node === undefined) {
        const error = new Error(`No such file: ${path}`)
        error.code = 2
        callback(error)
        return
      }
      callback(null, attrsFor(node))
    },
    readdir(path, callback) {
      record('readdir', path)
      const prefix = path === '/' ? '/' : `${path}/`
      const entries = []
      for (const [key, node] of nodes) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.length === 0 || rest.includes('/')) continue
        entries.push({ filename: rest, attrs: attrsFor(node) })
      }
      for (const name of options.ghosts?.(path) ?? []) entries.push({ filename: name, attrs: attrsFor(fileNode(1)) })
      callback(null, entries)
    },
    unlink(path, callback) {
      record('unlink', path)
      const failure = options.fail?.('unlink', path)
      if (failure) {
        callback(new Error(failure))
        return
      }
      const gate = options.hold?.('unlink', path)
      const finish = () => {
        nodes.delete(path)
        callback(null)
      }
      if (gate) gate.then(finish, finish)
      else finish()
    },
    rmdir(path, callback) {
      record('rmdir', path)
      const failure = options.fail?.('rmdir', path)
      if (failure) {
        callback(new Error(failure))
        return
      }
      nodes.delete(path)
      callback(null)
    },
  }
  return { sftp, calls }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(10)
  }
  throw new Error('timed out waiting for the delete to reach that point')
}

// ------------------------------------------------------------- path guard

test('a delete target must be a plain absolute remote path', () => {
  assert.deepEqual(parseDeleteTarget('/data/ws'), { ok: true, path: '/data/ws' })
  assert.deepEqual(parseDeleteTarget('/data/ws/sub/a b.txt'), { ok: true, path: '/data/ws/sub/a b.txt' })
  // Redundant but harmless spellings are normalized, not rejected.
  assert.equal(parseDeleteTarget('/data/ws/').path, '/data/ws')
  assert.equal(parseDeleteTarget('/data//ws').path, '/data/ws')
  assert.equal(parseDeleteTarget('/data/ws/./sub').path, '/data/ws/sub')

  for (const bad of ['', 'data/ws', './ws', 'C:\\data\\ws', '//data/ws', '/data/../etc', '/..', '/data/..', undefined, null, 42, {}, []]) {
    const result = parseDeleteTarget(bad)
    assert.equal(result.ok, false, String(bad))
    assert.equal(result.code, DELETE_INVALID_CODE, String(bad))
  }
  // The filesystem root is refused even with force: there is no sensible delete.
  assert.equal(parseDeleteTarget('/').code, DELETE_ROOT_CODE)
})

test('only a workspace root (and the filesystem root) is protected', () => {
  assert.equal(isProtectedDeleteRoot('/data/ws', ['/data/ws']), true)
  assert.equal(isProtectedDeleteRoot('/data/ws', ['/data/ws/']), true)
  assert.equal(isProtectedDeleteRoot('/data/ws/sub', ['/data/ws']), false)
  assert.equal(isProtectedDeleteRoot('/data/other', ['/data/ws']), false)
  assert.equal(isProtectedDeleteRoot('/', []), true)
  assert.equal(isProtectedDeleteRoot('/data/ws', undefined), false)
  assert.equal(isProtectedDeleteRoot('/data/ws', [null, 42, '']), false)
})

// --------------------------------------------------------------- the walk

test('a directory is removed depth first and counted', async () => {
  const nodes = new Map(Object.entries(TREE))
  const { sftp, calls } = makeSftp(nodes)
  const counts = await removeRemoteTree({ sftp, path: '/data/ws' })

  assert.deepEqual(counts, { files: 3, dirs: 2, bytes: 37 })
  assert.equal(nodes.has('/data/ws'), false)
  assert.equal(nodes.has('/data/ws/sub/b.txt'), false)
  assert.equal(nodes.has('/data/ws/link'), false)
  // The link target is a different tree and must be untouched.
  assert.equal(nodes.has('/elsewhere/secret'), true)
  assert.equal(nodes.has('/elsewhere/secret/keep.txt'), true)
  // Directories are removed after their contents, and the root goes last.
  assert.deepEqual(calls.filter((call) => call[0] === 'rmdir').map((call) => call[1]), ['/data/ws/sub', '/data/ws'])
  const indexOf = (op, path) => calls.findIndex((call) => call[0] === op && call[1] === path)
  assert.ok(indexOf('rmdir', '/data/ws/sub') > indexOf('unlink', '/data/ws/sub/b.txt'))
  assert.equal(calls.at(-1)[0], 'rmdir')
  assert.equal(calls.at(-1)[1], '/data/ws')
})

test('a symlink is unlinked as an entry, never followed', async () => {
  const nodes = new Map(Object.entries({
    '/data/ws': { type: 'dir' },
    '/data/ws/loop': { type: 'link', size: 8, target: '/data/ws' },
    '/data/ws/up': { type: 'link', size: 6, target: '/data' },
    '/data/ws/real.txt': fileNode(3),
    '/data/keep.txt': fileNode(1),
  }))
  const { sftp, calls } = makeSftp(nodes)
  const counts = await removeRemoteTree({ sftp, path: '/data/ws' })

  assert.deepEqual(counts, { files: 3, dirs: 1, bytes: 17 })
  // A followed self-link would recurse forever; exactly one readdir proves it did not.
  assert.deepEqual(calls.filter((call) => call[0] === 'readdir').map((call) => call[1]), ['/data/ws'])
  assert.deepEqual(
    calls.filter((call) => call[0] === 'unlink').map((call) => call[1]).sort(),
    ['/data/ws/loop', '/data/ws/real.txt', '/data/ws/up'],
  )
  assert.equal(nodes.has('/data/keep.txt'), true)
})

test('a missing root is reported as missing', async () => {
  const { sftp, calls } = makeSftp(new Map())
  await assert.rejects(
    removeRemoteTree({ sftp, path: '/nope' }),
    (error) => error.code === DELETE_MISSING_CODE && isDeleteCancelled(error) === false,
  )
  assert.deepEqual(calls, [['lstat', '/nope']])
})

test('an entry that vanished mid-walk is skipped instead of failing the delete', async () => {
  const nodes = new Map(Object.entries({
    '/data/ws': { type: 'dir' },
    '/data/ws/real.txt': fileNode(4),
  }))
  const { sftp } = makeSftp(nodes, { ghosts: (path) => (path === '/data/ws' ? ['ghost.txt'] : []) })
  const counts = await removeRemoteTree({ sftp, path: '/data/ws' })
  assert.deepEqual(counts, { files: 1, dirs: 1, bytes: 4 })
  assert.equal(nodes.has('/data/ws'), false)
})

test('a failure in the middle keeps the tally of what was removed', async () => {
  const nodes = new Map(Object.entries(TREE))
  const { sftp } = makeSftp(nodes, {
    fail: (op, path) => (op === 'unlink' && path === '/data/ws/sub/b.txt' ? 'permission denied' : null),
  })
  const counts = emptyDeleteCounts()
  await assert.rejects(removeRemoteTree({ sftp, path: '/data/ws', counts }), /permission denied/)

  // a.txt went first; the rest of the tree is still there.
  assert.deepEqual(counts, { files: 1, dirs: 0, bytes: 10 })
  assert.equal(nodes.has('/data/ws/a.txt'), false)
  assert.equal(nodes.has('/data/ws/sub/b.txt'), true)
  assert.equal(nodes.has('/data/ws'), true)
})

test('cancellation stops the walk before the next operation', async () => {
  const nodes = new Map(Object.entries(TREE))
  const signal = { aborted: false }
  const { sftp, calls } = makeSftp(nodes, {
    // The browser aborts while the first unlink is in flight.
    onCall: (op) => {
      if (op === 'unlink') signal.aborted = true
    },
  })
  const counts = emptyDeleteCounts()
  const error = await removeRemoteTree({ sftp, path: '/data/ws', counts, signal }).catch((thrown) => thrown)

  assert.equal(error.code, DELETE_CANCELLED_CODE)
  assert.equal(isDeleteCancelled(error), true)
  assert.deepEqual(counts, { files: 1, dirs: 0, bytes: 10 })
  assert.equal(calls.filter((call) => call[0] === 'unlink').length, 1)
  assert.equal(calls.filter((call) => call[0] === 'rmdir').length, 0)
})

test('an isCancelled predicate is asked before the very first operation', async () => {
  const nodes = new Map(Object.entries({ '/data/ws': { type: 'dir' }, '/data/ws/a.txt': fileNode(1) }))
  const { sftp, calls } = makeSftp(nodes)
  const error = await removeRemoteTree({ sftp, path: '/data/ws', isCancelled: () => true }).catch((thrown) => thrown)
  assert.equal(error.code, DELETE_CANCELLED_CODE)
  // Nothing was even inspected, let alone unlinked.
  assert.deepEqual(calls, [])
  assert.equal(nodes.has('/data/ws/a.txt'), true)
})

// -------------------------------------------------------------- the route

async function startApi({ nodes = TREE, workspaces = [], ...sftpOptions } = {}) {
  const tree = new Map(Object.entries(nodes))
  const { sftp, calls } = makeSftp(tree, sftpOptions)
  const host = {
    ensure: async () => {},
    requireSftp: () => sftp,
  }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => workspaces, invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-delete-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    tree,
    calls,
    // A connection whose client aborted is left half-open by the HTTP server,
    // and `close()` alone waits out its keep-alive timeout; a test must not pay
    // five seconds for that.
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function deleteRequest(base, path, extra = {}) {
  return fetch(`${base}/connections/c1/delete`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ path, ...extra }),
  })
}

test('the route deletes the tree over SFTP and reports the tally', async () => {
  const api = await startApi()
  try {
    const response = await deleteRequest(api.base, '/data/ws')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, deleted: { files: 3, dirs: 2, bytes: 37 } })
    assert.equal(api.tree.has('/data/ws'), false)
    assert.equal(api.tree.has('/elsewhere/secret/keep.txt'), true)
  } finally {
    await api.close()
  }
})

test('a workspace root needs force; nested paths and other connections\' roots do not', async () => {
  const nodes = { ...TREE, '/data/other': { type: 'dir' }, '/data/other/x.txt': fileNode(2) }
  const api = await startApi({
    nodes,
    workspaces: [{ connectionId: 'c1', path: '/data/ws' }, { connectionId: 'other', path: '/data/other' }],
  })
  try {
    const denied = await deleteRequest(api.base, '/data/ws')
    assert.equal(denied.status, 400)
    assert.equal((await denied.json()).code, DELETE_ROOT_CODE)
    assert.equal(api.tree.has('/data/ws'), true)
    // Refused before the host is touched at all.
    assert.deepEqual(api.calls, [])
    // The same folder spelled with a trailing slash is the same root.
    assert.equal((await deleteRequest(api.base, '/data/ws/')).status, 400)

    // Deleting *inside* a root is an ordinary delete.
    const nested = await deleteRequest(api.base, '/data/ws/sub')
    assert.equal(nested.status, 200)
    assert.deepEqual((await nested.json()).deleted, { files: 1, dirs: 1, bytes: 20 })

    // A root of another connection is not this connection's root.
    assert.equal((await deleteRequest(api.base, '/data/other')).status, 200)

    const forced = await deleteRequest(api.base, '/data/ws', { force: true })
    assert.equal(forced.status, 200)
    assert.equal((await forced.json()).ok, true)
    assert.equal(api.tree.has('/data/ws'), false)
  } finally {
    await api.close()
  }
})

test('the route can delete a single file', async () => {
  const api = await startApi()
  try {
    const response = await deleteRequest(api.base, '/data/ws/a.txt')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, deleted: { files: 1, dirs: 0, bytes: 10 } })
    assert.equal(api.tree.has('/data/ws/a.txt'), false)
    assert.equal(api.tree.has('/data/ws'), true)
  } finally {
    await api.close()
  }
})

test('the route refuses relative, traversing and empty paths', async () => {
  const api = await startApi()
  try {
    for (const path of ['data/ws', '/data/../etc', '../etc', '', '/', '//data/ws']) {
      const response = await deleteRequest(api.base, path)
      assert.equal(response.status, 400, path)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.ok([DELETE_INVALID_CODE, DELETE_ROOT_CODE].includes(body.code), `${path} -> ${body.code}`)
    }
    assert.deepEqual(api.calls, [])
    assert.equal(api.tree.has('/data/ws'), true)
  } finally {
    await api.close()
  }
})

test('deleting something that is not there answers 404', async () => {
  const api = await startApi()
  try {
    const response = await deleteRequest(api.base, '/data/missing')
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.code, DELETE_MISSING_CODE)
    assert.equal(body.ok, false)
  } finally {
    await api.close()
  }
})

test('a partial delete answers 200 with the error and the tally', async () => {
  const api = await startApi({
    fail: (op, path) => (op === 'unlink' && path === '/data/ws/sub/b.txt' ? 'permission denied' : null),
  })
  try {
    const response = await deleteRequest(api.base, '/data/ws')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.match(body.error, /permission denied/)
    assert.deepEqual(body.deleted, { files: 1, dirs: 0, bytes: 10 })
  } finally {
    await api.close()
  }
})

test('the route needs the token', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/data/ws' }),
    })
    assert.equal(response.status, 403)
    assert.equal(api.tree.has('/data/ws'), true)
  } finally {
    await api.close()
  }
})

test('aborting the request stops the walk and writes no response', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = await startApi({
    hold: (op, path) => (op === 'unlink' && path === '/data/ws/sub/b.txt' ? gate : null),
  })
  try {
    const controller = new AbortController()
    const pending = fetch(`${api.base}/connections/c1/delete`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/data/ws' }),
      signal: controller.signal,
    }).then(
      (response) => `status:${response.status}`,
      (error) => error.name,
    )
    // The delete is one operation in when the client walks away.
    await waitFor(() => api.calls.some((call) => call[0] === 'unlink' && call[1] === '/data/ws/sub/b.txt'))
    controller.abort()
    // The server notices the closed socket; the in-flight SFTP call then returns.
    await delay(250)
    release()
    assert.equal(await pending, 'AbortError')

    const settled = api.calls.length
    await delay(200)
    assert.equal(api.calls.length, settled, 'the walk must not continue after the client is gone')
    assert.equal(api.calls.filter((call) => call[0] === 'rmdir').length, 0)
    assert.equal(api.tree.has('/data/ws'), true)
    assert.equal(api.tree.has('/data/ws/sub/b.txt'), false, 'the operation already in flight still finished')
  } finally {
    await api.close()
  }
})
