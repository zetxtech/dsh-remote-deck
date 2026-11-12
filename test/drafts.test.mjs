/**
 * Editor drafts: the on-disk store, the routes over it, and the lazy sweep.
 *
 * Hermetic — a real temporary data directory stands in for DSH's, and the routes
 * are exercised over loopback HTTP.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../lib/api.js'
import { DRAFT_DIR_NAME, DRAFT_MAX_AGE_MS, DRAFT_TEMP_MAX_AGE_MS, draftFileName } from '../lib/drafts.js'

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

async function startApi() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rd-drafts-'))
  const server = createApi({
    token: TOKEN,
    // The connection-scoped draft route resolves its connection like every
    // other route under `/connections/<id>` does.
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: () => undefined,
    listHosts: () => [],
    routing: { listWorkspaces: () => [RECORD], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir,
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    dir: join(dataDir, DRAFT_DIR_NAME),
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function headers(extra = {}) {
  return { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', ...extra }
}

function postDraft(api, body) {
  return fetch(`${api.base}/draft`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
}

function getDraft(api, path, connectionId) {
  const query = `path=${encodeURIComponent(path)}${connectionId === undefined ? '' : `&connectionId=${encodeURIComponent(connectionId)}`}`
  return fetch(`${api.base}/draft?${query}`, { headers: headers() })
}

function listDrafts(api) {
  return fetch(`${api.base}/drafts`, { headers: headers() })
}

const draftFiles = (api) => (existsSync(api.dir) ? readdirSync(api.dir) : [])

test('a draft round-trips and is stored under its hashed name', async () => {
  const api = await startApi()
  try {
    const before = Date.now()
    const response = await postDraft(api, { path: '/d/a.txt', content: 'unsaved words', baseMtime: 1700000000000 })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.ok(body.savedAt >= before && body.savedAt <= Date.now())

    // The file is named after connection+path only, and holds the frozen shape.
    const name = draftFileName('', '/d/a.txt')
    assert.equal(name, draftFileName('', '/d/a.txt'))
    assert.deepEqual(draftFiles(api), [name])
    const stored = JSON.parse(readFileSync(join(api.dir, name), 'utf8'))
    assert.deepEqual(stored, {
      connectionId: '',
      path: '/d/a.txt',
      content: 'unsaved words',
      baseMtime: 1700000000000,
      savedAt: body.savedAt,
    })

    const read = await getDraft(api, '/d/a.txt')
    const readBody = await read.json()
    assert.equal(read.status, 200)
    assert.deepEqual(readBody, {
      ok: true,
      draft: { path: '/d/a.txt', content: 'unsaved words', baseMtime: 1700000000000, savedAt: body.savedAt },
    })
  } finally {
    await api.close()
  }
})

test('a second save replaces the first, one file per path', async () => {
  const api = await startApi()
  try {
    const first = await (await postDraft(api, { path: '/d/a.txt', content: 'v1' })).json()
    const second = await (await postDraft(api, { path: '/d/a.txt', content: 'v2 is longer' })).json()
    assert.ok(second.savedAt >= first.savedAt)

    const draft = (await (await getDraft(api, '/d/a.txt')).json()).draft
    assert.equal(draft.content, 'v2 is longer')
    assert.equal(draft.savedAt, second.savedAt)
    assert.equal(draft.baseMtime, null)
    assert.deepEqual(draftFiles(api), [draftFileName('', '/d/a.txt')])
  } finally {
    await api.close()
  }
})

test('a path with no draft answers null, not 404', async () => {
  const api = await startApi()
  try {
    const response = await getDraft(api, '/d/never-saved.txt')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, draft: null })
  } finally {
    await api.close()
  }
})

test('deleting a draft is idempotent, by either route', async () => {
  const api = await startApi()
  try {
    await postDraft(api, { path: '/d/a.txt', content: 'x' })
    const first = await fetch(`${api.base}/draft?path=${encodeURIComponent('/d/a.txt')}`, { method: 'DELETE', headers: headers() })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true })
    assert.deepEqual(draftFiles(api), [])

    const again = await fetch(`${api.base}/draft?path=${encodeURIComponent('/d/a.txt')}`, { method: 'DELETE', headers: headers() })
    assert.equal(again.status, 200)
    assert.deepEqual(await again.json(), { ok: true })

    await postDraft(api, { path: '/d/other.txt', content: 'y' })
    const posted = await fetch(`${api.base}/draft/delete`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ path: '/d/other.txt' }),
    })
    assert.equal(posted.status, 200)
    assert.deepEqual(draftFiles(api), [])
  } finally {
    await api.close()
  }
})

test('the listing carries metadata for every draft and no content', async () => {
  const api = await startApi()
  try {
    await postDraft(api, { path: '/d/a.txt', content: 'aaa', connectionId: 'conn1' })
    await postDraft(api, { path: '/d/b.txt', content: 'bbbb', connectionId: 'conn1', baseMtime: 5 })
    await postDraft(api, { path: '/d/a.txt', content: 'ccccc', connectionId: 'conn2' })

    const body = await (await listDrafts(api)).json()
    assert.equal(body.ok, true)
    assert.equal(body.drafts.length, 3)
    for (const row of body.drafts) {
      assert.deepEqual(Object.keys(row).sort(), ['bytes', 'connectionId', 'path', 'savedAt'])
    }
    const byKey = Object.fromEntries(body.drafts.map((row) => [`${row.connectionId}:${row.path}`, row]))
    assert.equal(byKey['conn1:/d/a.txt'].bytes, 3)
    assert.equal(byKey['conn1:/d/b.txt'].bytes, 4)
    assert.equal(byKey['conn2:/d/a.txt'].bytes, 5)
    // Newest first.
    const times = body.drafts.map((row) => row.savedAt)
    assert.deepEqual(times, [...times].sort((a, b) => b - a))
  } finally {
    await api.close()
  }
})

test('the editor’s connection-scoped routes share the same store', async () => {
  const api = await startApi()
  try {
    const scoped = (suffix, init = {}) => fetch(`${api.base}/connections/c1/draft${suffix}`, { headers: headers(), ...init })
    const post = await scoped('', {
      method: 'POST',
      body: JSON.stringify({ path: '/d/a.txt', content: 'live text', baseMtime: 99 }),
    })
    const posted = await post.json()
    assert.equal(post.status, 200)
    assert.equal(posted.ok, true)
    // The file is keyed by the connection from the URL, not by the body.
    assert.deepEqual(draftFiles(api), [draftFileName('c1', '/d/a.txt')])

    const read = await scoped(`?path=${encodeURIComponent('/d/a.txt')}`)
    assert.deepEqual((await read.json()).draft, {
      path: '/d/a.txt',
      content: 'live text',
      baseMtime: 99,
      savedAt: posted.savedAt,
    })
    // A flat request without a connection is a different namespace.
    assert.equal((await (await getDraft(api, '/d/a.txt')).json()).draft, null)

    const drop = await scoped(`?path=${encodeURIComponent('/d/a.txt')}`, { method: 'DELETE' })
    assert.deepEqual(await drop.json(), { ok: true })
    assert.equal((await (await scoped(`?path=${encodeURIComponent('/d/a.txt')}`)).json()).draft, null)
    assert.deepEqual(draftFiles(api), [])
  } finally {
    await api.close()
  }
})

test('the same path on two connections keeps two drafts', async () => {
  const api = await startApi()
  try {
    await postDraft(api, { path: '/d/a.txt', content: 'from one', connectionId: 'conn1' })
    await postDraft(api, { path: '/d/a.txt', content: 'from two', connectionId: 'conn2' })
    assert.equal(draftFiles(api).length, 2)
    assert.equal((await (await getDraft(api, '/d/a.txt', 'conn1')).json()).draft.content, 'from one')
    assert.equal((await (await getDraft(api, '/d/a.txt', 'conn2')).json()).draft.content, 'from two')
  } finally {
    await api.close()
  }
})

test('an oversized draft, a wrong type and a bad path are refused without writing', async () => {
  const api = await startApi()
  try {
    const tooLarge = await postDraft(api, { path: '/d/a.txt', content: 'x'.repeat(8 * 1024 * 1024 + 1) })
    assert.equal(tooLarge.status, 400)
    assert.equal((await tooLarge.json()).code, 'TOO_LARGE')

    const notText = await postDraft(api, { path: '/d/a.txt', content: 42 })
    assert.equal(notText.status, 400)
    assert.equal((await notText.json()).code, 'NOT_TEXT')

    for (const path of ['relative.txt', '/d/../etc/passwd', '', '/']) {
      const response = await postDraft(api, { path, content: 'x' })
      assert.equal(response.status, 400, path)
      assert.equal((await response.json()).code, 'NOT_REMOTE_PATH', path)
    }
    assert.deepEqual(draftFiles(api), [])
  } finally {
    await api.close()
  }
})

test('a failed write leaves no half-written draft and no temp file', async () => {
  const api = await startApi()
  try {
    mkdirSync(api.dir, { recursive: true })
    // A directory where the draft file belongs makes the final rename fail.
    mkdirSync(join(api.dir, draftFileName('', '/d/a.txt')))
    const response = await postDraft(api, { path: '/d/a.txt', content: 'nope' })
    assert.equal(response.status, 500)
    assert.deepEqual(draftFiles(api).filter((name) => name.includes('.tmp-')), [])
  } finally {
    await api.close()
  }
})

test('a draft older than the keep-by date disappears on the next visit', async () => {
  const api = await startApi()
  try {
    await postDraft(api, { path: '/d/old.txt', content: 'stale' })
    await postDraft(api, { path: '/d/fresh.txt', content: 'current' })

    const stale = join(api.dir, draftFileName('', '/d/old.txt'))
    const record = JSON.parse(readFileSync(stale, 'utf8'))
    record.savedAt = Date.now() - DRAFT_MAX_AGE_MS - 60_000
    writeFileSync(stale, JSON.stringify(record), 'utf8')
    const past = new Date(Date.now() - DRAFT_MAX_AGE_MS - 60_000)
    utimesSync(stale, past, past)

    const body = await (await listDrafts(api)).json()
    assert.deepEqual(body.drafts.map((row) => row.path), ['/d/fresh.txt'])
    assert.equal(existsSync(stale), false)
    assert.deepEqual(draftFiles(api), [draftFileName('', '/d/fresh.txt')])
  } finally {
    await api.close()
  }
})

test('orphan temp files are swept, live ones are left alone', async () => {
  const api = await startApi()
  try {
    mkdirSync(api.dir, { recursive: true })
    const orphan = join(api.dir, `${draftFileName('', '/d/x.txt')}.tmp-old`)
    const live = join(api.dir, `${draftFileName('', '/d/y.txt')}.tmp-new`)
    writeFileSync(orphan, '{}', 'utf8')
    writeFileSync(live, '{}', 'utf8')
    const past = new Date(Date.now() - DRAFT_TEMP_MAX_AGE_MS - 60_000)
    utimesSync(orphan, past, past)

    await listDrafts(api)
    assert.equal(existsSync(orphan), false)
    assert.equal(existsSync(live), true)
  } finally {
    await api.close()
  }
})

test('the whole directory can be cleared', async () => {
  const api = await startApi()
  try {
    await postDraft(api, { path: '/d/a.txt', content: 'a', connectionId: 'conn1' })
    await postDraft(api, { path: '/d/b.txt', content: 'b', connectionId: 'conn2' })
    const response = await fetch(`${api.base}/drafts`, { method: 'DELETE', headers: headers() })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, removed: 2 })
    assert.deepEqual(draftFiles(api), [])
    assert.deepEqual((await (await listDrafts(api)).json()).drafts, [])
  } finally {
    await api.close()
  }
})

test('the draft routes need the token', async () => {
  const api = await startApi()
  try {
    for (const request of [
      () => fetch(`${api.base}/draft`),
      () => fetch(`${api.base}/drafts`),
      () => fetch(`${api.base}/draft`, { method: 'POST', body: JSON.stringify({ path: '/d/a.txt', content: 'x' }) }),
      () => fetch(`${api.base}/draft?path=${encodeURIComponent('/d/a.txt')}`, { method: 'DELETE' }),
    ]) {
      assert.equal((await request()).status, 403)
    }
    assert.deepEqual(draftFiles(api), [])
  } finally {
    await api.close()
  }
})

test('the draft file name is stable, hashed and free of separators', () => {
  const name = draftFileName('conn1', '/d/a.txt')
  assert.match(name, /^[0-9a-f]{32}\.json$/)
  assert.equal(name, draftFileName('conn1', '/d/a.txt'))
  assert.notEqual(name, draftFileName('conn2', '/d/a.txt'))
  assert.notEqual(name, draftFileName('conn1', '/d/b.txt'))
  assert.notEqual(name, draftFileName('conn1', '/d/../a.txt'.replace('/d/../', '/')))
  assert.ok(!name.includes('/') && !name.includes('\\') && !name.includes('..'))
})
