/**
 * The vendor assets the browser half loads: the terminal bundle and the
 * editor's CodeMirror build, served by exact name only.
 *
 * The files are the real vendored ones, so a name in the allow-list that has no
 * file behind it fails here rather than in the browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEMIRROR_ASSET_FILES, createApi } from '../lib/api.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const XTERM_DIR = join(root, 'vendor', 'xterm')
const CODEMIRROR_DIR = join(root, 'vendor', 'codemirror')
const XTERM_FILES = ['xterm.js', 'xterm.css', 'addon-fit.js']
const TOKEN = 'test-token'

const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'zzs', authType: 'key', privateKeyPath: '/k', color: 'blue' }

async function startApi() {
  const server = createApi({
    token: TOKEN,
    store: { get: () => undefined, list: () => [] },
    secrets: { describe: async () => ({}) },
    hostFor: () => undefined,
    listHosts: () => [],
    routing: { listWorkspaces: () => [RECORD], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-assets-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
    assetDir: XTERM_DIR,
    assetDirs: [{ dir: CODEMIRROR_DIR, files: CODEMIRROR_ASSET_FILES }],
  })
  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve_) => server.close(resolve_))
    },
  }
}

/** A browser `<script>`/`<link>` cannot send headers, so the token rides along. */
function assetUrl(base, name) {
  return `${base}/assets/${name}?token=${TOKEN}`
}

test('every allowed CodeMirror file is served byte for byte', async () => {
  const api = await startApi()
  try {
    assert.ok(CODEMIRROR_ASSET_FILES.length >= 18)
    for (const name of CODEMIRROR_ASSET_FILES) {
      const response = await fetch(assetUrl(api.base, name))
      assert.equal(response.status, 200, name)
      const expected = readFileSync(join(CODEMIRROR_DIR, name))
      assert.ok(expected.length > 500, `${name} looks empty`)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, name)
      assert.equal(
        response.headers.get('content-type'),
        name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        name,
      )
      assert.equal(response.headers.get('cache-control'), 'public, max-age=3600')
    }
  } finally {
    await api.close()
  }
})

test('the terminal bundle keeps working unchanged', async () => {
  const api = await startApi()
  try {
    for (const name of XTERM_FILES) {
      const response = await fetch(assetUrl(api.base, name))
      assert.equal(response.status, 200, name)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(XTERM_DIR, name)), name)
      assert.equal(
        response.headers.get('content-type'),
        name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        name,
      )
    }
  } finally {
    await api.close()
  }
})

test('anything outside the allow-list is not found', async () => {
  const api = await startApi()
  try {
    const refused = [
      'nope.js',
      'LICENSE', // vendored, deliberately not served
      'README.md',
      'mode/javascript/javascript.js', // the unminified name we do not ship
      '..%2fpackage.json',
      'lib/codemirror.min.js.map',
      '',
    ]
    for (const name of refused) {
      const response = await fetch(assetUrl(api.base, name))
      assert.equal(response.status, 404, name)
    }
    // A dot segment — literal or percent-encoded — is folded away by the URL
    // parser before routing, so it can only ever name a listed file, and one
    // that climbs out of the prefix stops being an asset request entirely.
    for (const path of ['/assets/../package.json', '/assets/%2e%2e/package.json']) {
      const response = await fetch(`${api.base}${path}?token=${TOKEN}`)
      assert.notEqual(response.status, 200, path)
    }
    // And the listed file it folds down to is still the only thing served.
    assert.equal((await fetch(assetUrl(api.base, 'lib/codemirror.min.js'))).status, 200)
  } finally {
    await api.close()
  }
})

test('the asset prefix still needs the session token', async () => {
  const api = await startApi()
  try {
    const denied = await fetch(`${api.base}/assets/lib/codemirror.min.js`)
    assert.equal(denied.status, 403)
    const wrong = await fetch(`${api.base}/assets/lib/codemirror.min.js?token=nope`)
    assert.equal(wrong.status, 403)
  } finally {
    await api.close()
  }
})

test('an unconfigured asset directory answers 404 instead of throwing', async () => {
  const server = createApi({
    token: TOKEN,
    store: { get: () => undefined, list: () => [] },
    secrets: { describe: async () => ({}) },
    hostFor: () => undefined,
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-assets-none-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/assets/lib/codemirror.min.js?token=${TOKEN}`)).status, 404)
    assert.equal((await fetch(`${base}/assets/xterm.js?token=${TOKEN}`)).status, 404)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve_) => server.close(resolve_))
  }
})
