/**
 * The unified settings document: defaults, deep merge, font-family cleaning,
 * clamping, the legacy monitor.json migration and the two endpoints that read
 * and write it (/settings and the compatibility /monitor).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../lib/api.js'
import {
  DEFAULT_SETTINGS,
  FONT_FAMILY_MAX_LENGTH,
  TRANSFER_LIMIT_MAX_BYTES,
  TRANSFER_LIMIT_MIN_BYTES,
  migrateSettings,
  normalizeSettings,
  sanitizeFontFamily,
} from '../lib/metrics.js'

const TOKEN = 'test-token'

async function startApi(dataDir) {
  const server = createApi({
    token: TOKEN,
    store: { get: () => undefined, list: () => [] },
    secrets: { describe: async () => ({}) },
    hostFor: () => undefined,
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir,
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, options = {}) => {
    const headers = { 'x-dsh-remote-token': TOKEN, ...(options.headers ?? {}) }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${base}${path}`, { ...options, headers })
    return { status: response.status, body: await response.json() }
  }
  return { base, call, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function withTempDir(name, run) {
  const dir = mkdtempSync(join(tmpdir(), name))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the settings defaults carry every section', () => {
  const config = normalizeSettings(null)
  assert.deepEqual(config, {
    terminal: { fontFamily: '', fontSize: 12.5, lineHeight: 1.35, letterSpacing: 0 },
    monitor: {
      enabled: true,
      intervalMs: 30000,
      cpu: { enabled: true, threshold: 90 },
      mem: { enabled: true, threshold: 90 },
      disk: { enabled: true, threshold: 90 },
    },
    transfer: { limitBytes: 536870912 },
    editor: { autoSave: true, autoSaveDelayMs: 1000 },
  })
  assert.deepEqual(config, DEFAULT_SETTINGS)
  // Every call returns fresh objects; the frozen defaults must not be reachable.
  config.terminal.fontSize = 20
  assert.equal(DEFAULT_SETTINGS.terminal.fontSize, 12.5)
})

test('a partial update deep-merges over the stored document', () => {
  const stored = normalizeSettings({ terminal: { fontFamily: 'Menlo' }, transfer: { limitBytes: 2 * 1024 * 1024 } })
  const updated = normalizeSettings({ monitor: { cpu: { threshold: 50 } } }, stored)
  assert.equal(updated.terminal.fontFamily, 'Menlo')
  assert.equal(updated.transfer.limitBytes, 2 * 1024 * 1024)
  assert.equal(updated.monitor.cpu.threshold, 50)
  assert.equal(updated.monitor.cpu.enabled, true)
  assert.equal(updated.monitor.mem.threshold, stored.monitor.mem.threshold)
  assert.deepEqual(normalizeSettings({}, stored), stored)
  assert.deepEqual(normalizeSettings({ terminal: { fontSize: 16 } }, stored).monitor, stored.monitor)
})

test('the font family is cleaned of anything that could leave the declaration', () => {
  assert.equal(sanitizeFontFamily(''), '')
  assert.equal(sanitizeFontFamily('   '), '')
  assert.equal(sanitizeFontFamily('Menlo, Monaco, "Courier New", monospace'), 'Menlo, Monaco, Courier New, monospace')
  // A line break disappears, the tab around it collapses to a single space.
  assert.equal(sanitizeFontFamily('Arial\n\t Bold  '), 'Arial Bold')
  assert.equal(sanitizeFontFamily('a\\b`c'), 'abc')
  assert.equal(sanitizeFontFamily('F'.repeat(300)).length, FONT_FAMILY_MAX_LENGTH)
  // Anything that is not a usable string means "use the built-in font".
  assert.equal(sanitizeFontFamily(''), '')
  assert.equal(sanitizeFontFamily(42), '')
  assert.equal(sanitizeFontFamily(null), '')
  assert.equal(sanitizeFontFamily({ family: 'Menlo' }), '')
  assert.equal(sanitizeFontFamily(['Menlo']), '')
  assert.equal(sanitizeFontFamily(';{}<>"\'\\`'), '')
  // The document carries the cleaned value.
  assert.equal(normalizeSettings({ terminal: { fontFamily: 'Menlo; } body{}' } }).terminal.fontFamily, 'Menlo body')
})

test('no injected sample keeps a CSS delimiter', () => {
  const samples = [
    'x; color: red',
    'a}body{background:url(javascript:alert(1))',
    '<script>alert(1)</script>',
    'Menlo" onload="x',
    "Arial'\\",
    'a`b',
    'line\nbreak\r\n',
    'a b\tc',
  ]
  for (const sample of samples) {
    const cleaned = sanitizeFontFamily(sample)
    assert.doesNotMatch(cleaned, /[;{}<>"'\\`]/, `kept a delimiter: ${JSON.stringify(sample)}`)
    assert.doesNotMatch(cleaned, /[\r\n\t]/, `kept a control character: ${JSON.stringify(sample)}`)
    assert.equal(cleaned, cleaned.trim())
    assert.ok(cleaned.length <= FONT_FAMILY_MAX_LENGTH)
  }
})

test('every numeric field is clamped, and font sizes snap to half points', () => {
  const low = normalizeSettings({
    terminal: { fontSize: 2, lineHeight: 0.2, letterSpacing: -9 },
    monitor: { intervalMs: 1, cpu: { threshold: 0 } },
    transfer: { limitBytes: 1 },
  })
  assert.equal(low.terminal.fontSize, 9)
  assert.equal(low.terminal.lineHeight, 1)
  assert.equal(low.terminal.letterSpacing, -0.5)
  assert.equal(low.monitor.intervalMs, 10000)
  assert.equal(low.monitor.cpu.threshold, 1)
  assert.equal(low.transfer.limitBytes, TRANSFER_LIMIT_MIN_BYTES)

  const high = normalizeSettings({
    terminal: { fontSize: 99, lineHeight: 5, letterSpacing: 9 },
    monitor: { intervalMs: 9e9, cpu: { threshold: 1e6 } },
    transfer: { limitBytes: 1e15 },
  })
  assert.equal(high.terminal.fontSize, 24)
  assert.equal(high.terminal.lineHeight, 2)
  assert.equal(high.terminal.letterSpacing, 2)
  assert.equal(high.monitor.intervalMs, 300000)
  assert.equal(high.monitor.cpu.threshold, 100)
  assert.equal(high.transfer.limitBytes, TRANSFER_LIMIT_MAX_BYTES)

  const snapped = normalizeSettings({ terminal: { fontSize: 12.3, lineHeight: 1.349, letterSpacing: 0.126 } })
  assert.equal(snapped.terminal.fontSize, 12.5)
  assert.equal(snapped.terminal.lineHeight, 1.35)
  assert.equal(snapped.terminal.letterSpacing, 0.13)
  assert.equal(normalizeSettings({ terminal: { fontSize: 12.2 } }).terminal.fontSize, 12)

  // A value of the wrong type never replaces the stored one.
  const stored = normalizeSettings({ terminal: { fontSize: 20 }, transfer: { limitBytes: 4 * 1024 * 1024 } })
  assert.equal(normalizeSettings({ terminal: { fontSize: '30' } }, stored).terminal.fontSize, 20)
  assert.equal(normalizeSettings({ terminal: { fontFamily: 7 } }, stored).terminal.fontFamily, '')
  assert.equal(normalizeSettings({ transfer: { limitBytes: null } }, stored).transfer.limitBytes, 4 * 1024 * 1024)
})

test('unknown fields are dropped, not stored', () => {
  const config = normalizeSettings({ junk: true, terminal: { family: 'x', fontSize: 18 }, monitor: { mystery: 1 } })
  assert.deepEqual(Object.keys(config).sort(), ['editor', 'monitor', 'terminal', 'transfer'])
  assert.deepEqual(Object.keys(config.terminal).sort(), ['fontFamily', 'fontSize', 'letterSpacing', 'lineHeight'])
  assert.deepEqual(Object.keys(config.transfer), ['limitBytes'])
  assert.equal(config.terminal.fontSize, 18)
})

test('the editor section clamps its delay and keeps the switch', () => {
  const off = normalizeSettings({ editor: { autoSave: false } })
  assert.equal(off.editor.autoSave, false)
  assert.equal(off.editor.autoSaveDelayMs, 1000)
  assert.equal(normalizeSettings({ editor: { autoSaveDelayMs: 10 } }).editor.autoSaveDelayMs, 300)
  assert.equal(normalizeSettings({ editor: { autoSaveDelayMs: 99999 } }).editor.autoSaveDelayMs, 10000)
  assert.equal(normalizeSettings({ editor: { autoSave: 'nope' } }).editor.autoSave, true)
  assert.equal(normalizeSettings({ editor: { autoSaveDelayMs: 2500 } }).editor.autoSaveDelayMs, 2500)
})

test('migrateSettings carries a legacy monitor.json into settings.monitor', () => {
  const legacy = { enabled: false, intervalMs: 60000, cpu: { enabled: false, threshold: 10 } }
  const migrated = migrateSettings(null, legacy)
  assert.equal(migrated.monitor.enabled, false)
  assert.equal(migrated.monitor.intervalMs, 60000)
  assert.deepEqual(migrated.monitor.cpu, { enabled: false, threshold: 10 })
  assert.deepEqual(migrated.monitor.mem, DEFAULT_SETTINGS.monitor.mem)
  assert.deepEqual(migrated.terminal, DEFAULT_SETTINGS.terminal)
  assert.deepEqual(migrated.transfer, DEFAULT_SETTINGS.transfer)

  // A stored document with its own monitor section always wins.
  const stored = normalizeSettings({ monitor: { intervalMs: 15000 } })
  assert.equal(migrateSettings(stored, legacy).monitor.intervalMs, 15000)

  // One without it still picks the legacy values up.
  const merged = migrateSettings({ terminal: { fontSize: 16 } }, legacy)
  assert.equal(merged.terminal.fontSize, 16)
  assert.equal(merged.monitor.intervalMs, 60000)

  assert.deepEqual(migrateSettings(null, null), DEFAULT_SETTINGS)
})

test('GET /settings answers the complete document and POST persists a partial update', async () => {
  await withTempDir('rd-settings-', async (dir) => {
    const api = await startApi(dir)
    try {
      const initial = await api.call('/settings')
      assert.equal(initial.status, 200)
      assert.equal(initial.body.ok, true)
      assert.deepEqual(initial.body.config, DEFAULT_SETTINGS)

      const saved = await api.call('/settings', {
        method: 'POST',
        body: JSON.stringify({ terminal: { fontFamily: 'Menlo', fontSize: 14 }, monitor: { enabled: false } }),
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.ok, true)
      assert.equal(saved.body.config.terminal.fontFamily, 'Menlo')
      assert.equal(saved.body.config.terminal.fontSize, 14)
      assert.equal(saved.body.config.monitor.enabled, false)
      assert.equal(saved.body.config.transfer.limitBytes, DEFAULT_SETTINGS.transfer.limitBytes)

      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), saved.body.config)
      assert.deepEqual((await api.call('/settings')).body.config, saved.body.config)

      // A later partial update keeps what the first one stored.
      const second = await api.call('/settings', { method: 'POST', body: JSON.stringify({ transfer: { limitBytes: 2 * 1024 * 1024 } }) })
      assert.equal(second.body.config.transfer.limitBytes, 2 * 1024 * 1024)
      assert.equal(second.body.config.terminal.fontFamily, 'Menlo')
      assert.equal(second.body.config.monitor.enabled, false)

      // Both the bare document and a `{ config }` envelope are accepted.
      const wrapped = await api.call('/settings', { method: 'POST', body: JSON.stringify({ config: { terminal: { letterSpacing: 0.5 } } }) })
      assert.equal(wrapped.body.config.terminal.letterSpacing, 0.5)
      assert.equal(wrapped.body.config.terminal.fontFamily, 'Menlo')

      // Junk input falls back to the stored document instead of failing.
      const junk = await api.call('/settings', { method: 'POST', body: 'not json at all' })
      assert.equal(junk.status, 200)
      assert.deepEqual(junk.body.config, wrapped.body.config)
    } finally {
      await api.close()
    }
  })
})

test('a data directory that only holds monitor.json migrates on read', async () => {
  await withTempDir('rd-settings-legacy-', async (dir) => {
    writeFileSync(join(dir, 'monitor.json'), JSON.stringify({ enabled: false, intervalMs: 120000, cpu: { threshold: 42 } }), 'utf8')
    const api = await startApi(dir)
    try {
      const settings = await api.call('/settings')
      assert.equal(settings.status, 200)
      assert.equal(settings.body.config.monitor.intervalMs, 120000)
      assert.equal(settings.body.config.monitor.enabled, false)
      assert.equal(settings.body.config.monitor.cpu.threshold, 42)
      assert.equal(settings.body.config.terminal.fontSize, 12.5)

      // /monitor sees exactly the same section.
      const monitor = await api.call('/monitor')
      assert.deepEqual(monitor.body.config, settings.body.config.monitor)

      // Reading alone does not rewrite the data directory.
      assert.equal(existsSync(join(dir, 'settings.json')), false)

      // The first write materialises the migration and keeps the other sections.
      await api.call('/settings', { method: 'POST', body: JSON.stringify({ terminal: { fontSize: 16 } }) })
      const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
      assert.equal(written.monitor.intervalMs, 120000)
      assert.equal(written.monitor.cpu.threshold, 42)
      assert.equal(written.terminal.fontSize, 16)
    } finally {
      await api.close()
    }
  })
})

test('/monitor and /settings stay in step in both directions', async () => {
  await withTempDir('rd-settings-both-', async (dir) => {
    const api = await startApi(dir)
    try {
      await api.call('/settings', { method: 'POST', body: JSON.stringify({ monitor: { intervalMs: 45000, disk: { threshold: 70 } } }) })
      const viaSettings = await api.call('/monitor')
      assert.equal(viaSettings.body.config.intervalMs, 45000)
      assert.equal(viaSettings.body.config.disk.threshold, 70)

      const viaMonitor = await api.call('/monitor', { method: 'POST', body: JSON.stringify({ intervalMs: 20000, mem: { enabled: false } }) })
      assert.equal(viaMonitor.body.ok, true)
      assert.equal(viaMonitor.body.config.intervalMs, 20000)
      assert.equal(viaMonitor.body.config.mem.enabled, false)
      // A monitor update never drops the sections it does not mention.
      assert.equal(viaMonitor.body.config.disk.threshold, 70)

      const settings = await api.call('/settings')
      assert.equal(settings.body.config.monitor.intervalMs, 20000)
      assert.equal(settings.body.config.monitor.disk.threshold, 70)
      assert.equal(settings.body.config.monitor.mem.enabled, false)
      assert.deepEqual(settings.body.config.monitor, viaMonitor.body.config)

      // The unified document is the only file written; the legacy one stays read-only.
      assert.equal(existsSync(join(dir, 'monitor.json')), false)
      assert.ok(existsSync(join(dir, 'settings.json')))
    } finally {
      await api.close()
    }
  })
})

test('/settings needs the session token', async () => {
  await withTempDir('rd-settings-token-', async (dir) => {
    const api = await startApi(dir)
    try {
      const response = await fetch(`${api.base}/settings`)
      assert.equal(response.status, 403)
      const posted = await fetch(`${api.base}/settings`, { method: 'POST', body: '{}' })
      assert.equal(posted.status, 403)
      assert.equal(existsSync(join(dir, 'settings.json')), false)
    } finally {
      await api.close()
    }
  })
})
