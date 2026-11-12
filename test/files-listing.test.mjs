/**
 * The `/files` listing: every entry is described by `kind`, while the older
 * `type`/`link` fields keep their exact meaning for the shipped browser half.
 *
 * Hermetic: a fake SFTP supplies the `attrs` predicates, so each filesystem
 * object the route can meet — including the ones a real host rarely has — is
 * checked without a remote machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../lib/api.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'zzs', authType: 'key', privateKeyPath: '/k', color: 'blue' }

/**
 * Attrs carrying only the predicates a test names, like an ssh2 reply.
 *
 * @param {string[]} [methods] predicate names that answer true
 * @param {{ size?: number, mtime?: number }} [extra]
 */
function attrsOf(methods = [], extra = {}) {
  const attrs = { ...extra }
  for (const method of methods) attrs[method] = () => true
  return attrs
}

function entry(filename, methods, extra) {
  return { filename, longname: filename, attrs: attrsOf(methods, extra) }
}

async function startApi(entries, resolved = '/data') {
  const sftp = {
    realpath(path, callback) {
      callback(null, resolved)
    },
    readdir(path, callback) {
      callback(null, entries)
    },
  }
  const host = { ensure: async () => {}, requireSftp: () => sftp }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-files-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

async function listing(entries, query = 'path=/data') {
  const api = await startApi(entries)
  try {
    const response = await fetch(`${api.base}/connections/c1/files?${query}`, { headers: { [TOKEN_HEADER]: TOKEN } })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    return body
  } finally {
    await api.close()
  }
}

test('every kind of directory entry gets its own kind', async () => {
  const body = await listing([
    entry('plain.txt', []),
    entry('file.txt', ['isFile']),
    entry('folder', ['isDirectory']),
    entry('link', ['isSymbolicLink']),
    entry('dirlink', ['isDirectory', 'isSymbolicLink']),
    entry('pipe', ['isFIFO']),
    entry('sock', ['isSocket']),
    entry('tty', ['isCharacterDevice']),
    entry('disk', ['isBlockDevice']),
  ])
  const kinds = Object.fromEntries(body.entries.map((row) => [row.name, row.kind]))
  assert.deepEqual(kinds, {
    'plain.txt': 'file',
    'file.txt': 'file',
    folder: 'dir',
    link: 'link',
    // A link is a link however the server fills the other flags.
    dirlink: 'link',
    pipe: 'fifo',
    sock: 'socket',
    tty: 'char',
    disk: 'block',
  })
})

test('an attrs object without usable predicates falls back to file', async () => {
  const body = await listing([
    entry('nopredicates', undefined),
    entry('unknown', ['isOtherThing']),
    entry('falsy', []),
  ])
  for (const row of body.entries) assert.equal(row.kind, 'file', row.name)
  assert.deepEqual(body.entries.map((row) => row.name).sort(), ['falsy', 'nopredicates', 'unknown'])
})

test('the type and link fields keep their shipped meaning', async () => {
  const body = await listing([
    entry('folder', ['isDirectory']),
    entry('dirlink', ['isDirectory', 'isSymbolicLink']),
    entry('link', ['isSymbolicLink']),
    entry('pipe', ['isFIFO']),
  ])
  const rows = Object.fromEntries(body.entries.map((row) => [row.name, row]))
  assert.deepEqual(
    { type: rows.folder.type, link: rows.folder.link, kind: rows.folder.kind },
    { type: 'dir', link: false, kind: 'dir' },
  )
  // Unchanged compatibility quirk: `type` still follows isDirectory() alone,
  // while `kind` is the one that says "this is a link".
  assert.deepEqual(
    { type: rows.dirlink.type, link: rows.dirlink.link, kind: rows.dirlink.kind },
    { type: 'dir', link: true, kind: 'link' },
  )
  assert.deepEqual(
    { type: rows.link.type, link: rows.link.link, kind: rows.link.kind },
    { type: 'file', link: true, kind: 'link' },
  )
  assert.deepEqual(
    { type: rows.pipe.type, link: rows.pipe.link, kind: rows.pipe.kind },
    { type: 'file', link: false, kind: 'fifo' },
  )
})

test('size and mtime keep their fallbacks, and mtime stays in milliseconds', async () => {
  const body = await listing([
    entry('described', ['isFile'], { size: 12, mtime: 1700000000 }),
    entry('bare', ['isFile']),
    entry('zero', ['isFile'], { size: 0, mtime: 0 }),
  ])
  const rows = Object.fromEntries(body.entries.map((row) => [row.name, row]))
  assert.deepEqual([rows.described.size, rows.described.mtime], [12, 1700000000000])
  assert.deepEqual([rows.bare.size, rows.bare.mtime], [0, 0])
  assert.deepEqual([rows.zero.size, rows.zero.mtime], [0, 0])
})

test('directories sort first, names ascend, and hidden entries are not filtered', async () => {
  const body = await listing([
    entry('zeta.txt', ['isFile']),
    entry('.hidden', ['isFile']),
    entry('Beta', ['isDirectory']),
    entry('alpha', ['isDirectory']),
    entry('pipe', ['isFIFO']),
    entry('link', ['isSymbolicLink']),
  ])
  assert.deepEqual(body.entries.map((row) => row.name), ['Beta', 'alpha', '.hidden', 'link', 'pipe', 'zeta.txt'])
  assert.deepEqual(body.entries.map((row) => row.type), ['dir', 'dir', 'file', 'file', 'file', 'file'])
  // Paths are joined onto the resolved directory.
  assert.equal(body.path, '/data')
  assert.equal(body.parent, '/')
  assert.equal(body.entries[0].path, '/data/Beta')
})

test('a query parameter cannot filter the listing by kind', async () => {
  const body = await listing([
    entry('folder', ['isDirectory']),
    entry('pipe', ['isFIFO']),
    entry('plain.txt', []),
  ], 'path=/data&kind=fifo')
  assert.deepEqual(body.entries.map((row) => row.name), ['folder', 'pipe', 'plain.txt'])
  assert.deepEqual(body.entries.map((row) => row.kind), ['dir', 'fifo', 'file'])
})
