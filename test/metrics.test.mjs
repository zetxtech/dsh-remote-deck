/**
 * The monitor collector: command shape, parsing (including the zsh-safe memory
 * read) and the per-connection cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MONITOR_CONFIG,
  METRICS_MIN_TTL_MS,
  MetricsManager,
  metricsCommand,
  normalizeMonitorConfig,
  parseMetrics,
  topLevelDir,
} from '../lib/metrics.js'

const LINUX = [
  'rd-core 8',
  'rd-load 1.50',
  'rd-cpu 400 1000',
  'rd-mem 8000 6000',
  'rd-disk /dev/sda1 100000 40000 55000 42% /home',
].join('\n')

test('topLevelDir keeps the first segment of the session directory', () => {
  assert.equal(topLevelDir('/home/zzs/project'), '/home')
  assert.equal(topLevelDir('/var'), '/var')
  assert.equal(topLevelDir('/'), '/')
  assert.equal(topLevelDir('relative/path'), null)
  assert.equal(topLevelDir(''), null)
})

test('metricsCommand marks every reading and quotes the directory', () => {
  const script = metricsCommand("/home/a b/it's")
  for (const marker of ['rd-core', 'rd-load', 'rd-cpu', 'rd-mem', 'rd-disk']) {
    assert.ok(script.includes(marker), `missing ${marker}`)
  }
  // The command works on the top level of the session directory, quoted.
  assert.ok(script.includes("'/home'"), 'the top-level directory must be quoted')
  assert.ok(script.includes('df -Pk'), 'disk usage must come from df')
})

test('metricsCommand never relies on shell word splitting', () => {
  // Regression: the remote login shell may be zsh, which does not split an
  // unquoted expansion. `set -- $fields` therefore left $2 empty and the memory
  // reading silently vanished on a real host.
  const script = metricsCommand('/home/zzs')
  assert.ok(!/\bset --\s+\$/.test(script), 'no positional-parameter splitting')
  assert.ok(script.includes('${__rd_fields%% *}'), 'memory fields must be split with parameter expansion')
})

test('parseMetrics reads a Linux sample', () => {
  const value = parseMetrics(LINUX, null)
  assert.equal(value.cpu.cores, 8)
  assert.equal(value.cpu.load1, 1.5)
  assert.equal(value.cpu.source, 'load')
  assert.equal(value.cpu.percent, 18.8)
  assert.equal(value.mem.totalBytes, 8000)
  assert.equal(value.mem.usedBytes, 2000)
  assert.equal(value.mem.percent, 25)
  assert.equal(value.disk.mount, '/home')
  assert.equal(value.disk.totalBytes, 100000 * 1024)
  assert.equal(value.disk.availableBytes, 55000 * 1024)
  assert.ok(Math.abs(value.disk.percent - 45) < 0.1)
  assert.equal(typeof value.sampledAt, 'string')
})

test('parseMetrics differentiates two /proc/stat samples', () => {
  // `previous` is the sample the manager keeps ({ idle, total }), which is what
  // `sampleFor()` exposes; a parsed result carries no raw counters.
  const previous = { idle: 400, total: 1000 }
  const second = parseMetrics(LINUX.replace('rd-cpu 400 1000', 'rd-cpu 450 1200'), previous)
  assert.equal(second.cpu.source, 'stat')
  assert.equal(second.cpu.percent, 75)
})

test('parseMetrics tolerates missing readings', () => {
  const value = parseMetrics('rd-disk /dev/sda1 100 40 55 42% /srv', null)
  assert.equal(value.cpu.percent, null)
  assert.equal(value.mem.percent, null)
  assert.equal(value.disk.mount, '/srv')
})

test('normalizeMonitorConfig merges defaults and clamps values', () => {
  const merged = normalizeMonitorConfig({ intervalMs: 1000, cpu: { threshold: 500 } })
  assert.equal(merged.intervalMs, 10000)
  assert.equal(merged.cpu.threshold, 100)
  assert.equal(merged.cpu.enabled, true)
  assert.deepEqual(merged.mem, DEFAULT_MONITOR_CONFIG.mem)
  const off = normalizeMonitorConfig({ enabled: false, disk: { enabled: false, threshold: 30 } }, merged)
  assert.equal(off.enabled, false)
  assert.equal(off.disk.enabled, false)
  assert.equal(off.disk.threshold, 30)
  assert.equal(off.cpu.threshold, 100, 'unspecified sections keep the base config')
})

test('MetricsManager caches a reading inside the TTL and keeps the cpu sample', async () => {
  let calls = 0
  const host = {
    async runCommand() {
      calls += 1
      return { stdout: LINUX, stderr: '', code: 0 }
    },
  }
  const manager = new MetricsManager({ hostFor: () => host, onLog: () => {} })
  const first = await manager.read('c1', '/home/zzs')
  const second = await manager.read('c1', '/home/zzs')
  assert.equal(calls, 1, 'the second read must come from the cache')
  assert.equal(second.mem.percent, first.mem.percent)
  assert.deepEqual(manager.sampleFor('c1'), { idle: 400, total: 1000 })
  assert.ok(METRICS_MIN_TTL_MS >= 1000)
})
