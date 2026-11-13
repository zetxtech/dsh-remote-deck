/**
 * The transfer routes: folder archive download and file upload.
 *
 * A fake host stands in for SSH, so the routes — validation, streaming, the
 * size guard and the token rules — are exercised over real HTTP without a
 * remote machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createApi } from '../lib/api.js'

const TOKEN = 'test-token'
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

function makeSftp({ written, isDirectory, existing }) {
  const attrsFor = (path) => ({
    isDirectory: () => isDirectory(path),
    isFile: () => !isDirectory(path),
    size: 0,
    mtime: 0,
  })
  const missing = (path) => {
    const error = new Error('No such file: ' + path)
    error.code = 2
    return error
  }
  const known = (path) => written.has(path) || (existing !== undefined && existing.has(path))
  return {
    // The upload route asks before it replaces anything, so the fake has to be
    // able to say "that name is taken".
    lstat(path, callback) {
      if (known(path)) return callback(null, attrsFor(path))
      return callback(missing(path))
    },
    stat(path, callback) {
      if (existing !== undefined && !known(path)) return callback(missing(path))
      const attrs = {
        isDirectory: () => isDirectory(path),
        isFile: () => !isDirectory(path),
        size: 0,
        mtime: 0,
      }
      callback(null, attrs)
    },
    createWriteStream(path) {
      // A real SFTP write stream opens with 'w', so an overwrite starts empty.
      written.delete(path)
      const sink = new Writable({
        write(chunk, _encoding, done) {
          written.set(path, Buffer.concat([written.get(path) ?? Buffer.alloc(0), Buffer.from(chunk)]))
          done()
        },
      })
      return sink
    },
  }
}

async function startApi({ transferLimitBytes, archiveBytes = 'FAKEGZIP', isDirectory = () => true, existingFiles } = {}) {
  const written = new Map()
  const existing = existingFiles === undefined ? undefined : new Set(Object.keys(existingFiles))
  if (existingFiles !== undefined) {
    for (const [path, content] of Object.entries(existingFiles)) written.set(path, Buffer.from(content))
  }
  const sftp = makeSftp({ written, isDirectory, existing })
  const host = {
    ensure: async () => {},
    requireSftp: () => sftp,
    streamCommand: async () => {
      const stream = Readable.from([Buffer.from(archiveBytes)])
      stream.stderr = new EventEmitter()
      return stream
    },
  }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-transfer-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
    transferLimitBytes,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, written, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('uploads a file to the requested directory', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/upload?path=/srv/app&name=notes.txt`, {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN, 'content-type': 'application/octet-stream' },
      body: 'hello world',
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.path, '/srv/app/notes.txt')
    assert.equal(body.bytes, 11)
    assert.equal(api.written.get('/srv/app/notes.txt').toString('utf8'), 'hello world')
  } finally {
    await api.close()
  }
})

test('a same-named file is never replaced without overwrite=1', async () => {
  const api = await startApi({ existingFiles: { '/srv/app/notes.txt': 'old' } })
  try {
    const target = `${api.base}/connections/c1/upload?path=/srv/app&name=notes.txt`
    const refused = await fetch(target, {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN, 'content-type': 'application/octet-stream' },
      body: 'new',
    })
    assert.equal(refused.status, 409)
    const body = await refused.json()
    assert.equal(body.code, 'EXISTS')
    assert.equal(api.written.get('/srv/app/notes.txt').toString('utf8'), 'old', 'the original survives')

    const allowed = await fetch(target + '&overwrite=1', {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN, 'content-type': 'application/octet-stream' },
      body: 'new',
    })
    assert.equal(allowed.status, 200)
    assert.equal(api.written.get('/srv/app/notes.txt').toString('utf8'), 'new', 'the confirmed overwrite lands')
  } finally {
    await api.close()
  }
})

test('rejects a name that could leave the directory, and a non-POSIX path', async () => {
  const api = await startApi()
  try {
    const traversal = await fetch(`${api.base}/connections/c1/upload?path=/srv&name=${encodeURIComponent('../evil')}`, {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN },
      body: 'x',
    })
    assert.equal(traversal.status, 400)
    assert.equal(api.written.size, 0)

    const relative = await fetch(`${api.base}/connections/c1/upload?path=srv&name=a.txt`, {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN },
      body: 'x',
    })
    assert.equal(relative.status, 400)
    assert.equal((await relative.json()).code, 'NOT_REMOTE_PATH')
  } finally {
    await api.close()
  }
})

test('refuses an upload larger than the transfer limit', async () => {
  const api = await startApi({ transferLimitBytes: 4 })
  try {
    const response = await fetch(`${api.base}/connections/c1/upload?path=/srv&name=big.bin`, {
      method: 'POST',
      headers: { 'x-dsh-remote-token': TOKEN },
      body: 'way more than four bytes',
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.code, 'TRANSFER_TOO_LARGE')
    assert.equal(api.written.size, 0)
  } finally {
    await api.close()
  }
})

test('streams a folder archive with a download name', async () => {
  const api = await startApi({ archiveBytes: 'TARGZDATA' })
  try {
    const response = await fetch(`${api.base}/connections/c1/archive?path=/srv/app&token=${TOKEN}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/gzip')
    assert.match(response.headers.get('content-disposition') || '', /app\.tar\.gz/)
    assert.equal(await response.text(), 'TARGZDATA')
  } finally {
    await api.close()
  }
})

test('archives only folders, and needs the token', async () => {
  const api = await startApi({ isDirectory: () => false })
  try {
    const file = await fetch(`${api.base}/connections/c1/archive?path=/srv/app/a.txt&token=${TOKEN}`)
    assert.equal(file.status, 400)
  } finally {
    await api.close()
  }
  const guarded = await startApi()
  try {
    const denied = await fetch(`${guarded.base}/connections/c1/upload?path=/srv&name=a.txt`, {
      method: 'POST',
      body: 'x',
    })
    assert.equal(denied.status, 403)
    const archiveDenied = await fetch(`${guarded.base}/connections/c1/archive?path=/srv`)
    assert.equal(archiveDenied.status, 403)
  } finally {
    await guarded.close()
  }
})
