/**
 * Remote server metrics: one probe command, its parser, and a small per
 * connection manager.
 *
 * Everything is answered in a single shell round trip. Each value carries its
 * own `rd-*` marker so a tool that only exists on one platform degrades that
 * one field instead of failing the sample: `nproc` is missing on macOS,
 * `/proc/stat` does not exist there at all, and minimal Linux images ship
 * without `free`. A value that no probe could produce stays `null` and the
 * browser half renders it as unavailable.
 *
 * The command is POSIX shell; Linux and macOS are both covered. The only
 * platform branch is `/proc/stat`, which Linux alone can answer — the CPU
 * percentage is a difference between two samples of the same connection, so
 * the manager keeps the previous sample per connection id.
 */
import { posix } from 'node:path'
import { errorText, isPosixPath, shellQuote } from './util.js'

/** A cached sample younger than this is reused instead of re-running the probe. */
export const METRICS_MIN_TTL_MS = 5000
const METRICS_TIMEOUT_MS = 8000
const METRICS_MAX_BYTES = 64 * 1024

export const MONITOR_INTERVAL_MIN_MS = 10000
export const MONITOR_INTERVAL_MAX_MS = 300000
export const MONITOR_THRESHOLD_MIN = 1
export const MONITOR_THRESHOLD_MAX = 100

/** Terminal appearance bounds; font sizes move in half-point steps. */
export const FONT_FAMILY_MAX_LENGTH = 200
export const FONT_SIZE_MIN = 9
export const FONT_SIZE_MAX = 24
export const FONT_SIZE_STEP = 0.5
export const LINE_HEIGHT_MIN = 1
export const LINE_HEIGHT_MAX = 2
export const LETTER_SPACING_MIN = -0.5
export const LETTER_SPACING_MAX = 2

/** A single transfer (upload or archive download) stays inside this range. */
export const TRANSFER_LIMIT_MIN_BYTES = 1024 * 1024
export const TRANSFER_LIMIT_MAX_BYTES = 8 * 1024 * 1024 * 1024

export const DEFAULT_MONITOR_CONFIG = Object.freeze({
  enabled: true,
  intervalMs: 30000,
  cpu: Object.freeze({ enabled: true, threshold: 90 }),
  mem: Object.freeze({ enabled: true, threshold: 90 }),
  disk: Object.freeze({ enabled: true, threshold: 90 }),
})

export const DEFAULT_TERMINAL_CONFIG = Object.freeze({
  fontFamily: '',
  fontSize: 12.5,
  lineHeight: 1.35,
  letterSpacing: 0,
})

export const DEFAULT_TRANSFER_CONFIG = Object.freeze({ limitBytes: 512 * 1024 * 1024 })

/**
 * The one document the DSH settings page reads and writes: terminal
 * appearance, monitoring and the transfer cap. `monitor` is the same shape the
 * monitor-only endpoints have always used.
 */
/** Editor behaviour: auto-save on by default, a second after typing stops. */
export const EDITOR_AUTOSAVE_MIN_MS = 300
export const EDITOR_AUTOSAVE_MAX_MS = 10000
export const DEFAULT_EDITOR_CONFIG = Object.freeze({
  autoSave: true,
  autoSaveDelayMs: 1000,
})

export const DEFAULT_SETTINGS = Object.freeze({
  terminal: DEFAULT_TERMINAL_CONFIG,
  monitor: DEFAULT_MONITOR_CONFIG,
  transfer: DEFAULT_TRANSFER_CONFIG,
  editor: DEFAULT_EDITOR_CONFIG,
})

/**
 * The storage body a path lives on: `/home/alice/proj` -> `/home`.
 *
 * A relative path, a Windows path or a UNC path has no storage body to ask
 * about, so the caller falls back to `$HOME` on the remote side.
 */
export function topLevelDir(dir) {
  if (!isPosixPath(dir)) return null
  const parts = posix.normalize(dir).split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return '/'
  return `/${parts[0]}`
}

/**
 * The probe script. Every line is independent and swallows its own failure, so
 * one missing tool removes one marker instead of blanking the answer.
 *
 * @param {string | null | undefined} dir remote POSIX directory to measure disk usage for
 * @returns {string} POSIX shell script
 */
export function metricsCommand(dir) {
  const top = topLevelDir(dir)
  // A validated POSIX path never looks like an option, so no `--` is needed
  // (BSD `df` does not reliably accept one).
  const diskTarget = top === null ? '"${HOME:-/}"' : shellQuote(top)
  return [
    // cores: GNU, then POSIX getconf, then BSD/macOS
    '__rd_core="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"',
    `printf 'rd-core %s\\n' "$__rd_core"`,
    // 1 minute load: Linux /proc/loadavg, then BSD/macOS `{ 1.2 3.4 5.6 }`
    `__rd_load="$(awk '{print $1; exit}' /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null)"`,
    `printf 'rd-load %s\\n' "$__rd_load"`,
    // Linux only: idle and total jiffies from the first /proc/stat line. The
    // next sample of this connection differentiates them into a real CPU%.
    // The sum stays in shell arithmetic: mawk (Debian's default awk) clamps
    // `printf %d` at INT_MAX, which a busy /proc/stat line passes quickly.
    '__rd_cpu=""',
    '[ -r /proc/stat ] && read -r __rd_tag __rd_u __rd_n __rd_s __rd_idle __rd_w __rd_irq __rd_sirq __rd_steal __rd_rest < /proc/stat || true',
    '[ "$__rd_tag" = "cpu" ] && __rd_total=$((__rd_u + __rd_n + __rd_s + __rd_idle + __rd_w + __rd_irq + __rd_sirq + __rd_steal)) || true',
    '[ -n "$__rd_total" ] && [ "$__rd_total" -gt 0 ] && __rd_cpu="$__rd_idle $__rd_total" || true',
    `[ -n "$__rd_cpu" ] && printf 'rd-cpu %s\\n' "$__rd_cpu" || true`,
    // memory as "totalBytes availableBytes". awk only selects fields here; the
    // multiplications stay in shell arithmetic for the same reason as above: a
    // byte count above 2 GiB cannot survive mawk's `printf %d`.
    '__rd_mem=""',
    `__rd_fields="$(free -b 2>/dev/null | awk '$1=="Mem:"{printf "%s %s", $2, $7; exit}')"`,
    // Never `set --` here: the remote login shell may be zsh, which does not
    // word-split an unquoted expansion, so $2 would stay empty and the reading
    // would silently disappear. POSIX parameter expansion works in every shell.
    '__rd_a="${__rd_fields%% *}"; __rd_b="${__rd_fields#* }"',
    '[ -n "$__rd_a" ] && [ "$__rd_a" != "$__rd_b" ] && __rd_mem="$__rd_a $__rd_b" || true',
    'if [ -z "$__rd_mem" ]; then',
    `  __rd_fields="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} END{if(t!="") printf "%s %s", t, (a!=""?a:f)}' /proc/meminfo 2>/dev/null)"`,
    '  __rd_a="${__rd_fields%% *}"; __rd_b="${__rd_fields#* }"',
    '  [ -n "$__rd_a" ] && [ "$__rd_a" != "$__rd_b" ] && __rd_mem="$(( __rd_a * 1024 )) $(( __rd_b * 1024 ))" || true',
    'fi',
    'if [ -z "$__rd_mem" ]; then',
    '  __rd_ram="$(sysctl -n hw.memsize 2>/dev/null)"',
    '  __rd_page="$(sysctl -n hw.pagesize 2>/dev/null)"',
    `  __rd_pages="$(vm_stat 2>/dev/null | awk '/Pages free:/{fr=$NF+0} /Pages inactive:/{ia=$NF+0} /Pages speculative:/{sp=$NF+0} END{if(fr+ia+sp>0) printf "%d", fr+ia+sp}')"`,
    '  [ -n "$__rd_ram" ] && [ -n "$__rd_pages" ] && [ -n "$__rd_page" ] && __rd_mem="$__rd_ram $(( __rd_pages * __rd_page ))" || true',
    'fi',
    `printf 'rd-mem %s\\n' "$__rd_mem"`,
    // The filesystem behind the top level directory, in POSIX form so the
    // mount point (which may contain blanks) is the only free-form field.
    `printf 'rd-disk %s\\n' "$(df -Pk ${diskTarget} 2>/dev/null | tail -n 1)"`,
  ].join('\n')
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numbersIn(raw) {
  const match = String(raw ?? '').match(/-?\d+(?:\.\d+)?/g)
  return match === null ? [] : match.map(Number).filter((value) => Number.isFinite(value))
}

function firstInteger(raw) {
  const values = numbersIn(raw)
  return values.length > 0 ? Math.trunc(values[0]) : null
}

function positiveInt(raw) {
  const value = firstInteger(raw)
  return value !== null && value > 0 ? value : null
}

function nonNegativeNumber(raw) {
  const values = numbersIn(raw)
  return values.length > 0 && values[0] >= 0 ? values[0] : null
}

/**
 * A `/proc/stat` sample, accepted in any of the shapes we hand around:
 * `{ idle, total }`, a previous full result (`{ cpu: { idle, total } }`), the
 * raw first line, or the two numbers the probe prints.
 */
function parseCpuSample(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return sampleFromNumbers(value.map(Number))
  if (typeof value === 'object') {
    if (value.cpu !== undefined) return parseCpuSample(value.cpu)
    return sampleFromNumbers([Number(value.idle), Number(value.total)])
  }
  const text = String(value).trim()
  if (text.length === 0) return null
  const numbers = numbersIn(text)
  if (/^cpu\b/.test(text) && numbers.length >= 4) {
    // Raw /proc/stat line: user nice system idle ... -> idle is the 4th field.
    const total = numbers.reduce((sum, part) => sum + part, 0)
    return total > 0 ? { idle: numbers[3], total } : null
  }
  return sampleFromNumbers(numbers.slice(0, 2))
}

function sampleFromNumbers(numbers) {
  const [idle, total] = numbers
  if (!Number.isFinite(idle) || !Number.isFinite(total) || total <= 0) return null
  return { idle, total }
}

function emptyDisk() {
  return { mount: null, totalBytes: null, usedBytes: null, availableBytes: null, percent: null }
}

/**
 * `df -Pk` prints, per line:
 *   Filesystem 1024-blocks Used Available Capacity Mounted on
 * The capacity column is the anchor: the three fields before it are total,
 * used and available, and everything after it is the mount point (which may
 * contain spaces). Locating it instead of counting from the left also survives
 * device names that contain spaces (`map auto_home` on macOS).
 */
function parseDiskLine(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || /^Filesystem\b/i.test(text)) return emptyDisk()
  const fields = text.split(/\s+/)
  const capacityAt = fields.findIndex((field) => /^\d+%$/.test(field))
  let totalKb = null
  let availableKb = null
  let mount = null
  if (capacityAt >= 3) {
    totalKb = firstInteger(fields[capacityAt - 3])
    availableKb = firstInteger(fields[capacityAt - 1])
    mount = fields.slice(capacityAt + 1).join(' ')
  } else if (fields.length >= 6) {
    totalKb = firstInteger(fields[1])
    availableKb = firstInteger(fields[3])
    mount = fields.slice(5).join(' ')
  }
  if (totalKb === null || totalKb <= 0 || availableKb === null) return emptyDisk()
  const totalBytes = totalKb * 1024
  const availableBytes = Math.max(0, availableKb) * 1024
  const usedBytes = Math.max(0, totalBytes - availableBytes)
  return {
    mount: mount === null || mount.length === 0 ? null : mount,
    totalBytes,
    usedBytes,
    availableBytes,
    percent: round1((usedBytes / totalBytes) * 100),
  }
}

function markerValues(text) {
  const values = new Map()
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = /^(rd-[a-z]+)\s*(.*)$/.exec(rawLine.trim())
    if (match !== null) values.set(match[1], match[2].trim())
  }
  return values
}

/**
 * Parse one probe answer. Markers may arrive in any order and may be missing
 * or empty; every section is always present, with `null` for what the remote
 * could not answer.
 *
 * @param {string} text probe stdout
 * @param {{ idle: number, total: number } | null | undefined} previous last `/proc/stat` sample of the same connection
 */
export function parseMetrics(text, previous) {
  const values = markerValues(text)
  const cores = positiveInt(values.get('rd-core'))
  const load1 = nonNegativeNumber(values.get('rd-load'))
  const sample = parseCpuSample(values.get('rd-cpu'))
  const before = parseCpuSample(previous)

  let percent = null
  let source = null
  if (sample !== null && before !== null) {
    const totalDelta = sample.total - before.total
    const idleDelta = sample.idle - before.idle
    // Counters reset on reboot and may be read out of order; a nonsensical
    // delta falls through to the load average instead of reporting garbage.
    if (totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
      percent = round1(((totalDelta - idleDelta) / totalDelta) * 100)
      source = 'stat'
    }
  }
  if (percent === null && load1 !== null && cores !== null) {
    percent = round1(Math.min(100, (load1 / cores) * 100))
    source = 'load'
  }

  const memNumbers = numbersIn(values.get('rd-mem'))
  const memTotal = memNumbers.length > 0 && memNumbers[0] > 0 ? memNumbers[0] : null
  const memAvailable = memNumbers.length > 1 ? Math.max(0, memNumbers[1]) : null
  const memUsed = memTotal !== null && memAvailable !== null ? Math.max(0, memTotal - memAvailable) : null
  const memPercent = memTotal !== null && memUsed !== null ? round1(Math.min(100, (memUsed / memTotal) * 100)) : null

  return {
    cpu: { percent, cores, load1, source },
    mem: { totalBytes: memTotal, usedBytes: memUsed, percent: memPercent },
    disk: parseDiskLine(values.get('rd-disk')),
    sampledAt: new Date().toISOString(),
  }
}

function cloneMetrics(value) {
  return {
    cpu: { ...value.cpu },
    mem: { ...value.mem },
    disk: { ...value.disk },
    sampledAt: value.sampledAt,
  }
}

function hasData(value) {
  return (
    value.cpu.cores !== null ||
    value.cpu.percent !== null ||
    value.cpu.load1 !== null ||
    value.mem.totalBytes !== null ||
    value.disk.totalBytes !== null
  )
}

function firstLine(text) {
  const line = String(text ?? '').trim().split(/\r?\n/)[0].trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Per connection metric reads with a short cache.
 *
 * The cache is keyed by connection *and* directory, because the disk answer is
 * about the storage behind that directory; the CPU sample is keyed by
 * connection alone, because it is a difference between two reads of the same
 * machine. Concurrent reads of the same key share one probe.
 */
export class MetricsManager {
  constructor({ hostFor, onLog, ttlMs, now } = {}) {
    this.hostFor = hostFor
    this.onLog = typeof onLog === 'function' ? onLog : () => {}
    // `ttlMs` and `now` are test seams; the floor keeps a busy UI from ever
    // probing the remote host more often than every five seconds.
    this.ttlMs = Math.max(METRICS_MIN_TTL_MS, Number.isFinite(ttlMs) ? Math.round(ttlMs) : METRICS_MIN_TTL_MS)
    this.now = typeof now === 'function' ? now : Date.now
    this.cache = new Map()
    this.inflight = new Map()
    this.samples = new Map()
  }

  /** The last `/proc/stat` sample of a connection, or null before the first read. */
  sampleFor(connectionId) {
    return this.samples.get(String(connectionId)) ?? null
  }

  async read(connectionId, dir) {
    const id = String(connectionId)
    const target = typeof dir === 'string' ? dir.trim() : ''
    const key = `${id}\u0000${target}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cloneMetrics(cached.value)
    let pending = this.inflight.get(key)
    if (pending === undefined) {
      pending = this.#collect(id, target, key)
      this.inflight.set(key, pending)
      const clear = () => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key)
      }
      pending.then(clear, clear)
    }
    return cloneMetrics(await pending)
  }

  async #collect(connectionId, dir, key) {
    const host = this.hostFor(connectionId)
    if (host === undefined) throw new Error('connection not found')
    let result
    try {
      result = await host.runCommand(metricsCommand(dir), null, { maxBytes: METRICS_MAX_BYTES, timeoutMs: METRICS_TIMEOUT_MS })
    } catch (error) {
      this.onLog('metrics failed', connectionId, errorText(error))
      throw error
    }
    if (result.transportError) {
      this.onLog('metrics failed', connectionId, result.transportError)
      throw new Error(result.transportError)
    }
    const value = parseMetrics(result.stdout, this.samples.get(connectionId) ?? null)
    const sample = parseCpuSample(markerValues(result.stdout).get('rd-cpu'))
    if (sample !== null) this.samples.set(connectionId, sample)
    if (!hasData(value)) {
      const message = firstLine(result.stderr) || 'the remote host returned no metrics'
      this.onLog('metrics unavailable', connectionId, message)
      throw new Error(message)
    }
    this.cache.set(key, { at: this.now(), value })
    return value
  }
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeSection(value, fallback) {
  const source = plainObject(value)
  return {
    enabled: booleanOr(source.enabled, fallback.enabled),
    threshold: clampInt(source.threshold, MONITOR_THRESHOLD_MIN, MONITOR_THRESHOLD_MAX, fallback.threshold),
  }
}

/**
 * Fill in what a stored or posted monitor config left out, clamp what is out of
 * range and drop unknown fields. `base` is the previously stored config, so a
 * partial update keeps the settings it does not mention.
 */
export function normalizeMonitorConfig(value, base) {
  const source = plainObject(value)
  const fallback = base === undefined ? DEFAULT_MONITOR_CONFIG : normalizeMonitorConfig(base, undefined)
  return {
    enabled: booleanOr(source.enabled, fallback.enabled),
    intervalMs: clampInt(source.intervalMs, MONITOR_INTERVAL_MIN_MS, MONITOR_INTERVAL_MAX_MS, fallback.intervalMs),
    cpu: normalizeSection(source.cpu, fallback.cpu),
    mem: normalizeSection(source.mem, fallback.mem),
    disk: normalizeSection(source.disk, fallback.disk),
  }
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function clampNumber(value, min, max, decimals, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, roundTo(value, decimals)))
}

function quantize(value, min, max, step, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, roundTo(Math.round(value / step) * step, 2)))
}

const FONT_FAMILY_FORBIDDEN = /[;{}<>"'\\`]/g
const FONT_FAMILY_BREAKS = /[\r\n\u2028\u2029]/g

/**
 * A font family lands in a CSS declaration, so only what a font stack can
 * legitimately contain survives: the statement delimiters `;{}<>`, quotes,
 * backslash and backtick are dropped, line breaks vanish, and every other
 * whitespace run collapses to one space. Nothing left means "use the built-in
 * font" (`''`).
 */
export function sanitizeFontFamily(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(FONT_FAMILY_FORBIDDEN, '')
    .replace(FONT_FAMILY_BREAKS, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FONT_FAMILY_MAX_LENGTH)
    .trim()
}

function normalizeTerminalConfig(value, fallback) {
  const source = plainObject(value)
  return {
    // Absent keeps the stored family; anything that is not a usable string
    // clears back to the built-in font.
    fontFamily: source.fontFamily === undefined ? fallback.fontFamily : sanitizeFontFamily(source.fontFamily),
    fontSize: quantize(source.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP, fallback.fontSize),
    lineHeight: clampNumber(source.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 2, fallback.lineHeight),
    letterSpacing: clampNumber(source.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 2, fallback.letterSpacing),
  }
}

function normalizeTransferConfig(value, fallback) {
  const source = plainObject(value)
  return {
    limitBytes: clampInt(source.limitBytes, TRANSFER_LIMIT_MIN_BYTES, TRANSFER_LIMIT_MAX_BYTES, fallback.limitBytes),
  }
}

/**
 * Fill in what a stored or posted settings document left out (deep merge over
 * `base`, the stored document), clamp what is out of range and drop unknown
 * fields. Every call returns the complete three-section shape.
 */
export function normalizeSettings(value, base) {
  const source = plainObject(value)
  const fallback = base === undefined ? DEFAULT_SETTINGS : normalizeSettings(base, undefined)
  return {
    terminal: normalizeTerminalConfig(source.terminal, fallback.terminal),
    monitor: normalizeMonitorConfig(source.monitor, fallback.monitor),
    transfer: normalizeTransferConfig(source.transfer, fallback.transfer),
    editor: {
      autoSave: booleanOr(source.editor?.autoSave, fallback.editor.autoSave),
      autoSaveDelayMs: clampInt(
        source.editor?.autoSaveDelayMs,
        EDITOR_AUTOSAVE_MIN_MS,
        EDITOR_AUTOSAVE_MAX_MS,
        fallback.editor.autoSaveDelayMs,
      ),
    },
  }
}

/**
 * The settings document for a data directory that may still hold only the old
 * `monitor.json`: its config becomes `settings.monitor`, so a saved interval or
 * threshold survives the upgrade. A monitor section in the stored settings
 * always wins; the legacy file is consulted only while none has been saved.
 */
export function migrateSettings(stored, legacyMonitor) {
  const source = plainObject(stored)
  if (source.monitor !== undefined) return normalizeSettings(source)
  return normalizeSettings({ ...source, monitor: legacyMonitor })
}
