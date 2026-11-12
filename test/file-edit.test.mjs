/**
 * The editor's read and write endpoints: bounded reads, binary detection,
 * UTF-8 tolerance, conflict detection and the save path.
 *
 * Hermetic — an in-memory SFTP tree stands in for the host and the routes are
 * exercised over loopback HTTP.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApi } from '../lib/api.js'
import {
  EDIT_MISSING_CODE,
  EDIT_NOT_FILE_CODE,
  EDIT_STALE_CODE,
  EDIT_TOO_LARGE_CODE,
  READ_DEFAULT_MAX_BYTES,
  READ_MAX_BYTES,
  WRITE_MAX_BYTES,
  isEditCancelled,
  parseFileTarget,
  parseReadLimit,
  parseWriteRequest,
} from '../lib/file-edit.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

const MODES = { dir: 0o040755, file: 0o100644, link: 0o120777, fifo: 0o010644, socket: 0o140755, char: 0o020666, block: 0o060660 }

/** 中文测试\n第二行\n in GBK, the bytes a Windows editor writes. */
const GBK_LINES = Buffer.from([
  0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a,
  0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0, 0x0a,
])
/** 中文 in Big5. */
const BIG5_CN = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])

function attrsOf(node) {
  return {
    mode: MODES[node.type] ?? MODES.file,
    size: Buffer.isBuffer(node.content)
      ? node.content.length
      : typeof node.content === 'string' ? Buffer.byteLength(node.content) : 0,
    mtime: node.mtime ?? 0,
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
 * @param {Record<string, object>} initial path -> node
 * @param {object} [options]
 * @param {(op: string, path: string) => Error | null} [options.fail]
 * @param {(op: string, path: string) => Promise<void> | null} [options.hold]
 */
function makeSftp(initial, options = {}) {
  const nodes = new Map(Object.entries(initial ?? {}))
  const calls = []
  // The exact bytes of every writeFile, so an encoded save can be checked
  // against the bytes the file already had.
  const writes = []
  let clock = 1700000000
  const record = (op, path) => {
    calls.push([op, path])
  }
  const sftp = {
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
    createReadStream(path, optionsRead = {}) {
      record('createReadStream', path)
      const node = nodes.get(path)
      const buffer = node === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(node.content) ? node.content : typeof node.content === 'string' ? Buffer.from(node.content, 'utf8') : Buffer.alloc(0)
      const start = Number.isInteger(optionsRead.start) ? optionsRead.start : 0
      const end = Number.isInteger(optionsRead.end) ? Math.min(optionsRead.end, buffer.length - 1) : buffer.length - 1
      return Readable.from([buffer.subarray(start, end + 1)])
    },
    writeFile(path, buffer, callback) {
      record('writeFile', path)
      writes.push({ path, buffer: Buffer.from(buffer) })
      const failure = options.fail?.('writeFile', path)
      if (failure) {
        callback(failure)
        return
      }
      const finish = () => {
        clock += 1
        nodes.set(path, { type: 'file', content: Buffer.from(buffer).toString('utf8'), mtime: clock })
        callback(null)
      }
      const gate = options.hold?.('writeFile', path)
      if (gate === undefined || gate === null) finish()
      else gate.then(finish, () => callback(new Error('held write failed')))
    },
    unlink(path, callback) {
      record('unlink', path)
      nodes.delete(path)
      callback(null)
    },
    rename(from, to, callback) {
      record('rename', from)
      const node = nodes.get(from)
      if (node === undefined) {
        callback(notFound(from))
        return
      }
      nodes.delete(from)
      nodes.set(to, node)
      callback(null)
    },
    ext_openssh_rename(from, to, callback) {
      record('ext_openssh_rename', from)
      const node = nodes.get(from)
      if (node === undefined) {
        callback(notFound(from))
        return
      }
      nodes.delete(from)
      nodes.set(to, node)
      callback(null)
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

// --------------------------------------------------------------- pure rules

test('path, window and body validation', () => {
  assert.deepEqual(parseFileTarget('/d/a.txt'), { ok: true, path: '/d/a.txt' })
  assert.equal(parseFileTarget('/d/a.txt/').path, '/d/a.txt')
  for (const bad of ['', 'd/a.txt', '/d/../etc', '/', '//d/a.txt', undefined, 42]) {
    assert.equal(parseFileTarget(bad).code, 'NOT_REMOTE_PATH', String(bad))
  }
  assert.equal(parseReadLimit(undefined), READ_DEFAULT_MAX_BYTES)
  assert.equal(parseReadLimit('abc'), READ_DEFAULT_MAX_BYTES)
  assert.equal(parseReadLimit('0'), READ_DEFAULT_MAX_BYTES)
  assert.equal(parseReadLimit(10), 10)
  assert.equal(parseReadLimit(String(READ_MAX_BYTES * 3)), READ_MAX_BYTES)

  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 'x' }).ok, true)
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 42 }).code, 'NOT_REMOTE_PATH')
  assert.equal(parseWriteRequest({ path: '/d/a.txt' }).code, 'NOT_REMOTE_PATH')
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 'x', expectedMtime: 'nope' }).expectedMtime, undefined)
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 'x', expectedMtime: 5.4 }).expectedMtime, 5)
  const encoded = parseWriteRequest({ path: '/d/a.txt', content: 'x', encoding: 'GB18030', eol: 'crlf' })
  assert.equal(encoded.encoding, 'gb18030')
  assert.equal(encoded.eol, 'crlf')
  // Older callers omit both and keep the UTF-8/LF behaviour.
  const legacy = parseWriteRequest({ path: '/d/a.txt', content: 'x' })
  assert.equal(legacy.encoding, undefined)
  assert.equal(legacy.eol, undefined)
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 'x', encoding: 42 }).encoding, undefined)
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: 'x', eol: 'weird' }).eol, undefined)
  const big = 'x'.repeat(WRITE_MAX_BYTES + 1)
  assert.equal(parseWriteRequest({ path: '/d/a.txt', content: big }).code, EDIT_TOO_LARGE_CODE)
})

// ---------------------------------------------------------------- the route

async function startApi(nodes = {}, options = {}) {
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
    dataDir: mkdtempSync(join(tmpdir(), 'rd-edit-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    nodes: fake.nodes,
    calls: fake.calls,
    writes: fake.writes,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function readUrl(base, path, extra = '') {
  return `${base}/connections/c1/read?path=${encodeURIComponent(path)}${extra}`
}

function readRequest(url) {
  return fetch(url, { headers: { [TOKEN_HEADER]: TOKEN } })
}

function writeUrl(base) {
  return `${base}/connections/c1/write`
}

function writeRequest(base, body, init = {}) {
  return fetch(writeUrl(base), {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

// ------------------------------------------------------------------- read

test('a text file comes back with its size, mtime and text', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'hello\nworld', mtime: 1700000000 } })
  try {
    const response = await readRequest(readUrl(api.base, '/d/a.txt'))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, {
      ok: true,
      path: '/d/a.txt',
      size: 11,
      mtime: 1700000000000,
      text: 'hello\nworld',
      truncated: false,
      binary: false,
      encoding: 'utf-8',
      exact: true,
      writable: true,
      eol: 'lf',
      mixedEol: false,
    })
  } finally {
    await api.close()
  }
})

test('the read window is 2 MiB by default, capped at 8 MiB, and never silently short', async () => {
  const big = 'a'.repeat(READ_DEFAULT_MAX_BYTES + 1024)
  const api = await startApi({ '/d/big.txt': { type: 'file', content: big, mtime: 1 } })
  try {
    const byDefault = await (await readRequest(readUrl(api.base, '/d/big.txt'))).json()
    assert.equal(byDefault.truncated, true)
    assert.equal(Buffer.byteLength(byDefault.text), READ_DEFAULT_MAX_BYTES)

    const limited = await startApi({ '/d/big.txt': { type: 'file', content: big, mtime: 1 } })
    try {
      const custom = await (await readRequest(readUrl(limited.base, '/d/big.txt', '&maxBytes=10'))).json()
      assert.equal(custom.text, 'a'.repeat(10))
      assert.equal(custom.truncated, true)
      assert.equal(custom.size, big.length)

      const nonsense = await (await readRequest(readUrl(limited.base, '/d/big.txt', '&maxBytes=abc'))).json()
      assert.equal(Buffer.byteLength(nonsense.text), READ_DEFAULT_MAX_BYTES)
    } finally {
      await limited.close()
    }

    // Asking for more than the ceiling is capped, not refused.
    const huge = 'b'.repeat(READ_MAX_BYTES + 1024)
    const capped = await startApi({ '/d/huge.txt': { type: 'file', content: huge, mtime: 1 } })
    try {
      const body = await (await readRequest(readUrl(capped.base, '/d/huge.txt', '&maxBytes=999999999'))).json()
      assert.equal(body.truncated, true)
      assert.equal(Buffer.byteLength(body.text), READ_MAX_BYTES)
    } finally {
      await capped.close()
    }
  } finally {
    await api.close()
  }
})

test('a file that fits is not marked truncated', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: '0123456789', mtime: 1 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/a.txt', '&maxBytes=10'))).json()
    assert.equal(body.truncated, false)
    assert.equal(body.text, '0123456789')
  } finally {
    await api.close()
  }
})

test('a NUL byte marks the file binary and no text is sent', async () => {
  const api = await startApi({ '/d/bin.dat': { type: 'file', content: 'abc\u0000def', mtime: 7 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/bin.dat'))).json()
    assert.deepEqual(body, { ok: true, binary: true, size: 7, mtime: 7000 })
    assert.equal('text' in body, false)
  } finally {
    await api.close()
  }
})

test('invalid UTF-8 is decoded as a read-only guess, never an error', async () => {
  const api = await startApi({ '/d/latin1.txt': { type: 'file', content: 'a\u00ffb', mtime: 1 } })
  try {
    // Raw bytes that are not valid UTF-8: the node holds a Buffer directly.
    api.nodes.set('/d/raw.bin', { type: 'file', content: Buffer.from([0x61, 0xff, 0x62]), mtime: 1 })
    const response = await readRequest(readUrl(api.base, '/d/raw.bin'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.binary, false)
    // Not UTF-8: the answer is GB18030's lenient reading, flagged as a guess.
    assert.equal(body.encoding, 'gb18030')
    assert.equal(body.exact, false)
    assert.equal(body.writable, false)
    assert.equal(body.text, 'a\uFFFDb')
  } finally {
    await api.close()
  }
})

test('a GBK file read without a chosen encoding is a read-only GB18030 guess', async () => {
  const api = await startApi({ '/d/gbk.txt': { type: 'file', content: GBK_LINES, mtime: 1700000000 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/gbk.txt'))).json()
    // GB18030 accepts nearly any byte pair, so a successful decode is not
    // evidence of the encoding: the file is shown, but never writable.
    assert.equal(body.encoding, 'gb18030')
    assert.equal(body.exact, false)
    assert.equal(body.writable, false)
    assert.equal(body.text, '中文测试\n第二行\n')
    assert.equal(body.size, GBK_LINES.length)
    assert.equal(body.eol, 'lf')
    assert.equal(body.mixedEol, false)
  } finally {
    await api.close()
  }
})

test('a reader who names the encoding gets an exact, writable decode', async () => {
  const api = await startApi({ '/d/gbk.txt': { type: 'file', content: GBK_LINES, mtime: 1700000000 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/gbk.txt', '&encoding=GB18030'))).json()
    assert.equal(body.encoding, 'gb18030')
    assert.equal(body.exact, true)
    assert.equal(body.writable, true)
    assert.equal(body.text, '中文测试\n第二行\n')

    // Nonsense in the query never becomes writable, and never a 500 either.
    const bogus = await (await readRequest(readUrl(api.base, '/d/gbk.txt', '&encoding=bogus'))).json()
    assert.equal(bogus.exact, false)
    assert.equal(bogus.writable, false)
  } finally {
    await api.close()
  }
})

test('CRLF and mixed line endings are reported on the file', async () => {
  const api = await startApi({
    '/d/crlf.txt': { type: 'file', content: 'one\r\ntwo\r\n', mtime: 1 },
    '/d/mixed.txt': { type: 'file', content: 'one\r\ntwo\nthree\r\n', mtime: 1 },
  })
  try {
    const crlf = await (await readRequest(readUrl(api.base, '/d/crlf.txt'))).json()
    assert.equal(crlf.eol, 'crlf')
    assert.equal(crlf.mixedEol, false)
    assert.equal(crlf.text, 'one\r\ntwo\r\n')

    const mixed = await (await readRequest(readUrl(api.base, '/d/mixed.txt'))).json()
    assert.equal(mixed.eol, 'crlf')
    assert.equal(mixed.mixedEol, true)
  } finally {
    await api.close()
  }
})

test('a truncated read is never writable', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: '0123456789', mtime: 1 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/a.txt', '&maxBytes=4'))).json()
    assert.equal(body.truncated, true)
    assert.equal(body.text, '0123')
    // The window decoded cleanly, yet half a file must not be saved.
    assert.equal(body.exact, true)
    assert.equal(body.writable, false)
  } finally {
    await api.close()
  }
})

test('an empty file reads as an editable, empty UTF-8 file', async () => {
  const api = await startApi({ '/d/empty.txt': { type: 'file', content: '', mtime: 1 } })
  try {
    const body = await (await readRequest(readUrl(api.base, '/d/empty.txt'))).json()
    assert.deepEqual(body, {
      ok: true,
      path: '/d/empty.txt',
      size: 0,
      mtime: 1000,
      text: '',
      truncated: false,
      binary: false,
      encoding: 'utf-8',
      exact: true,
      writable: true,
      eol: 'lf',
      mixedEol: false,
    })
  } finally {
    await api.close()
  }
})

test('a directory or a special file is refused as not a regular file', async () => {
  const api = await startApi({
    '/d/dir': { type: 'dir' },
    '/d/pipe': { type: 'fifo' },
    '/d/sock': { type: 'socket' },
  })
  try {
    for (const path of ['/d/dir', '/d/pipe', '/d/sock']) {
      const response = await readRequest(readUrl(api.base, path))
      assert.equal(response.status, 400, path)
      assert.equal((await response.json()).code, EDIT_NOT_FILE_CODE, path)
    }
    assert.ok(!api.calls.some((call) => call[0] === 'createReadStream'), 'a special file is never read')
  } finally {
    await api.close()
  }
})

test('a missing file is 404 and a bad path is 400', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'x', mtime: 1 } })
  try {
    const missing = await readRequest(readUrl(api.base, '/d/nope.txt'))
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, EDIT_MISSING_CODE)

    for (const path of ['relative.txt', '/d/../etc/passwd', '', '/']) {
      const response = await readRequest(readUrl(api.base, path))
      assert.equal(response.status, 400, path)
      assert.equal((await response.json()).code, 'NOT_REMOTE_PATH', path)
    }
  } finally {
    await api.close()
  }
})

test('the read route needs the token', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'x', mtime: 1 } })
  try {
    const response = await fetch(readUrl(api.base, '/d/a.txt').replace('?', '?token=wrong&'))
    assert.equal(response.status, 403)
  } finally {
    await api.close()
  }
})

// ------------------------------------------------------------------ write

test('a new file is created and a save leaves no temp file behind', async () => {
  const api = await startApi({ '/d': { type: 'dir' } })
  try {
    const response = await writeRequest(api.base, { path: '/d/new.txt', content: 'hi there' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.size, 8)
    assert.ok(body.mtime > 0)
    assert.equal(api.nodes.get('/d/new.txt').content, 'hi there')
    assert.deepEqual([...api.nodes.keys()].filter((key) => key.includes('.dsh-tmp-')), [])
  } finally {
    await api.close()
  }
})

test('an existing file is replaced, not appended to', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'old content', mtime: 5 } })
  try {
    const response = await writeRequest(api.base, { path: '/d/a.txt', content: 'new' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.size, 3)
    assert.equal(api.nodes.get('/d/a.txt').content, 'new')
  } finally {
    await api.close()
  }
})

test('a matching expectedMtime saves, a stale one answers 409 and writes nothing', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'mine', mtime: 1700000000 } })
  try {
    const good = await writeRequest(api.base, {
      path: '/d/a.txt',
      content: 'edited',
      expectedMtime: 1700000000000,
    })
    assert.equal(good.status, 200)
    assert.equal(api.nodes.get('/d/a.txt').content, 'edited')

    // Someone else changed the file after the editor loaded it.
    api.nodes.get('/d/a.txt').mtime = 1700000123
    api.nodes.get('/d/a.txt').content = 'theirs'
    const stale = await writeRequest(api.base, {
      path: '/d/a.txt',
      content: 'my overwrite',
      expectedMtime: 1700000000000,
    })
    assert.equal(stale.status, 409)
    const body = await stale.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, EDIT_STALE_CODE)
    assert.equal(body.mtime, 1700000123000)
    assert.equal(api.nodes.get('/d/a.txt').content, 'theirs')
    assert.deepEqual([...api.nodes.keys()].filter((key) => key.includes('.dsh-tmp-')), [])
  } finally {
    await api.close()
  }
})

test('a missing file with an expectedMtime is stale, not created', async () => {
  const api = await startApi()
  try {
    const response = await writeRequest(api.base, {
      path: '/d/gone.txt',
      content: 'x',
      expectedMtime: 1700000000000,
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, EDIT_STALE_CODE)
    assert.equal(body.mtime, null)
    assert.equal(api.nodes.has('/d/gone.txt'), false)
  } finally {
    await api.close()
  }
})

test('oversized, non-string and malformed writes are refused before any SFTP call', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'x', mtime: 1 } })
  try {
    const tooLarge = await writeRequest(api.base, {
      path: '/d/a.txt',
      content: 'x'.repeat(WRITE_MAX_BYTES + 1),
    })
    assert.equal(tooLarge.status, 400)
    assert.equal((await tooLarge.json()).code, EDIT_TOO_LARGE_CODE)

    for (const body of [{ path: '/d/a.txt', content: 42 }, { path: '/d/a.txt' }, { content: 'x' }]) {
      const response = await writeRequest(api.base, body)
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'NOT_REMOTE_PATH')
    }
    for (const path of ['relative.txt', '/d/../etc/passwd', '/']) {
      const response = await writeRequest(api.base, { path, content: 'x' })
      assert.equal(response.status, 400, path)
      assert.equal((await response.json()).code, 'NOT_REMOTE_PATH', path)
    }
    assert.equal(api.nodes.get('/d/a.txt').content, 'x')
    assert.deepEqual(api.calls, [])
  } finally {
    await api.close()
  }
})

test('writing a directory is refused without touching it', async () => {
  const api = await startApi({ '/d/dir': { type: 'dir' } })
  try {
    const response = await writeRequest(api.base, { path: '/d/dir', content: 'x' })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, EDIT_NOT_FILE_CODE)
    assert.ok(!api.calls.some((call) => call[0] === 'writeFile'))
  } finally {
    await api.close()
  }
})

test('a failed write keeps the previous content and leaves no temp file', async () => {
  const api = await startApi(
    { '/d/a.txt': { type: 'file', content: 'precious', mtime: 5 } },
    { fail: (op, path) => (op === 'writeFile' && path.includes('.dsh-tmp-') ? new Error('quota exceeded') : null) },
  )
  try {
    const response = await writeRequest(api.base, { path: '/d/a.txt', content: 'lost?' })
    assert.equal(response.status, 500)
    assert.equal(api.nodes.get('/d/a.txt').content, 'precious')
    assert.deepEqual([...api.nodes.keys()].filter((key) => key.includes('.dsh-tmp-')), [])
  } finally {
    await api.close()
  }
})

test('the write route needs the token', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'x', mtime: 1 } })
  try {
    const response = await fetch(writeUrl(api.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/d/a.txt', content: 'y' }),
    })
    assert.equal(response.status, 403)
    assert.equal(api.nodes.get('/d/a.txt').content, 'x')
  } finally {
    await api.close()
  }
})

test('aborting the request stops the save and writes no response', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = await startApi(
    { '/d/a.txt': { type: 'file', content: 'original', mtime: 5 } },
    { hold: (op, path) => (op === 'writeFile' && path.includes('.dsh-tmp-') ? gate : null) },
  )
  try {
    const controller = new AbortController()
    const pending = writeRequest(
      api.base,
      { path: '/d/a.txt', content: 'never lands' },
      { signal: controller.signal },
    ).then(
      (response) => `status:${response.status}`,
      (error) => error.name,
    )
    await waitFor(() => api.calls.some((call) => call[0] === 'writeFile' && call[1].includes('.dsh-tmp-')))
    controller.abort()
    // Let the server notice the closed socket, then let the in-flight write end.
    await delay(250)
    release()
    assert.equal(await pending, 'AbortError')
    // The client is gone the moment it aborts; the server still has to finish
    // the operation it was already in and clean up after it.
    await delay(250)
    assert.equal(api.nodes.get('/d/a.txt').content, 'original')
    assert.deepEqual([...api.nodes.keys()].filter((key) => key.includes('.dsh-tmp-')), [], 'the temp file is cleaned up')
    assert.ok(!api.calls.some((call) => call[0] === 'ext_openssh_rename'))
  } finally {
    await api.close()
  }
})

test('a GBK file read with an explicit encoding saves back the same bytes', async () => {
  const api = await startApi({ '/d/gbk.txt': { type: 'file', content: GBK_LINES, mtime: 1700000000 } })
  try {
    const read = await (await readRequest(readUrl(api.base, '/d/gbk.txt', '&encoding=gb18030'))).json()
    assert.equal(read.encoding, 'gb18030')
    assert.equal(read.writable, true)

    const response = await writeRequest(api.base, {
      path: '/d/gbk.txt',
      content: read.text,
      encoding: read.encoding,
      eol: read.eol,
      expectedMtime: read.mtime,
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    // The temp file got exactly the bytes the file already had: the save is a
    // no-op on disk, not a UTF-8 rewrite of GBK text.
    assert.equal(api.writes.length, 1)
    assert.deepEqual(api.writes[0].buffer, GBK_LINES)
    assert.deepEqual([...api.nodes.keys()].filter((key) => key.includes('.dsh-tmp-')), [])
  } finally {
    await api.close()
  }
})

test('a CRLF file is written back with CRLFs, not the LF text the editor holds', async () => {
  const api = await startApi({ '/d/crlf.txt': { type: 'file', content: 'one\r\ntwo\r\n', mtime: 1700000000 } })
  try {
    const read = await (await readRequest(readUrl(api.base, '/d/crlf.txt'))).json()
    assert.equal(read.eol, 'crlf')
    // The editor hands back LF text; the file's own convention is restored.
    const response = await writeRequest(api.base, {
      path: '/d/crlf.txt',
      content: read.text.replace(/\r\n/g, '\n'),
      encoding: read.encoding,
      eol: read.eol,
      expectedMtime: read.mtime,
    })
    assert.equal(response.status, 200)
    assert.equal(api.writes.length, 1)
    assert.deepEqual(api.writes[0].buffer, Buffer.from('one\r\ntwo\r\n', 'utf8'))
  } finally {
    await api.close()
  }
})

test('a Big5 save is refused before the host is asked to write anything', async () => {
  const api = await startApi({ '/d/big5.txt': { type: 'file', content: BIG5_CN, mtime: 1700000000 } })
  try {
    const guessed = await (await readRequest(readUrl(api.base, '/d/big5.txt'))).json()
    assert.equal(guessed.encoding, 'gb18030')
    assert.equal(guessed.exact, false)
    assert.equal(guessed.writable, false)

    const explicit = await (await readRequest(readUrl(api.base, '/d/big5.txt', '&encoding=big5'))).json()
    assert.equal(explicit.encoding, 'big5')
    assert.equal(explicit.text, '中文')
    assert.equal(explicit.exact, true)
    // Big5 has no encoder here, so even an exact read stays read-only.
    assert.equal(explicit.writable, false)

    const response = await writeRequest(api.base, {
      path: '/d/big5.txt',
      content: explicit.text,
      encoding: explicit.encoding,
      eol: explicit.eol,
      expectedMtime: explicit.mtime,
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, 'UNSUPPORTED_ENCODING')
    // No writeFile ever reached the host and the original bytes stand.
    assert.equal(api.writes.length, 0)
    assert.equal(api.calls.filter((call) => call[0] === 'writeFile').length, 0)
    assert.deepEqual(api.nodes.get('/d/big5.txt').content, BIG5_CN)
  } finally {
    await api.close()
  }
})

test('a save that names no encoding still writes UTF-8 and LF, as before', async () => {
  const api = await startApi({ '/d/a.txt': { type: 'file', content: 'old', mtime: 5 } })
  try {
    const content = 'héllo\n世界'
    const response = await writeRequest(api.base, { path: '/d/a.txt', content })
    assert.equal(response.status, 200)
    assert.equal(api.writes.length, 1)
    assert.deepEqual(api.writes[0].buffer, Buffer.from(content, 'utf8'))
  } finally {
    await api.close()
  }
})

test('isEditCancelled recognises only the cancellation error', () => {
  assert.equal(isEditCancelled({ code: 'REMOTE_DECK_EDIT_CANCELLED' }), true)
  assert.equal(isEditCancelled({ code: EDIT_STALE_CODE }), false)
  assert.equal(isEditCancelled(null), false)
})
