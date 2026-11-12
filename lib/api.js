/**
 * Loopback JSON API used by the browser half.
 *
 * The server binds an ephemeral port on 127.0.0.1 and requires a per-session
 * token, injected into the page by the host half. No terminal or file endpoint
 * is reachable without it.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join as joinPath, posix, resolve, sep } from 'node:path'
import {
  MAX_TRANSFER_BYTES,
  ensureRemoteDir,
  errorText,
  normalizeRemotePath,
  readJsonFile,
  safeRemoteName,
  sftpCall,
  writeJsonFile,
} from './util.js'
import {
  DELETE_MISSING_CODE,
  DELETE_ROOT_CODE,
  emptyDeleteCounts,
  isDeleteCancelled,
  isDeleteMissing,
  isProtectedDeleteRoot,
  parseDeleteTarget,
  removeRemoteTree,
} from './delete.js'
import {
  EDIT_MISSING_CODE,
  EDIT_STALE_CODE,
  WRITE_MAX_BYTES,
  isEditCancelled,
  parseWriteRequest,
  readRemoteFile,
  writeRemoteFile,
} from './file-edit.js'
import { transferRemotePaths } from './file-ops.js'
import { DRAFT_DIR_NAME, DraftStore, parseDraftPath, parseDraftWrite } from './drafts.js'
import { archiveCommand, archivePathsCommand, parseScanOutput, scanCommand } from './transfer.js'
import { MetricsManager, migrateSettings, normalizeMonitorConfig, normalizeSettings } from './metrics.js'

const TOKEN_HEADER = 'x-dsh-remote-token'
const DOWNLOAD_ROOT = joinPath(homedir(), 'Downloads', 'Remote Deck')
// The remote scan is time-boxed on both ends: `timeout` on the far side and
// this abort, which covers a remote that has no `timeout` at all.
const SCAN_TIMEOUT_MS = 20000
const SCAN_MAX_BYTES = 256 * 1024
/** How many selected paths one archive request may carry. */
const ARCHIVE_MAX_PATHS = 200
/** Every JSON route but the editor's save stays under this. */
const JSON_BODY_LIMIT = 131072
// JSON escaping can inflate text (a quote or a control character costs six
// bytes), so the editor's 8 MiB of content gets room to arrive intact.
const WRITE_BODY_LIMIT = WRITE_MAX_BYTES * 6 + 65536

/**
 * Every CodeMirror file the file editor may load, by exact path inside
 * `vendor/codemirror`. The editor's imports and this list are edited together:
 * a file that is not named here is not reachable from the page at all.
 */
export const CODEMIRROR_ASSET_FILES = Object.freeze([
  'lib/codemirror.min.js',
  'lib/codemirror.css',
  'mode/javascript/javascript.min.js',
  'mode/xml/xml.min.js',
  'mode/css/css.min.js',
  'mode/htmlmixed/htmlmixed.min.js',
  'mode/markdown/markdown.min.js',
  'mode/python/python.min.js',
  'mode/shell/shell.min.js',
  'mode/yaml/yaml.min.js',
  'mode/clike/clike.min.js',
  'mode/rust/rust.min.js',
  'mode/go/go.min.js',
  'addon/edit/closebrackets.min.js',
  'addon/edit/matchbrackets.min.js',
  'addon/search/search.min.js',
  'addon/search/searchcursor.min.js',
  'addon/selection/active-line.min.js',
])

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tgz': 'application/gzip',
}

function mimeFor(name) {
  return MIME[extname(name).toLowerCase()] || 'application/octet-stream'
}

/**
 * The display kind of one directory entry: dir, link, fifo, socket, char, block
 * or file.
 *
 * The POSIX type bits decide first — a real host reports them for everything,
 * while ssh2's predicates are not reliable for every type: measured against ws,
 * a unix socket (`mode` 140775) and a block device (`mode` 060660) both report
 * `isSocket()`/`isBlockDevice()` false and would otherwise be filed as ordinary
 * files. A symlink is never followed: its own bits win, so a link to a directory
 * (or a dangling one) stays a link.
 *
 * The predicate chain remains as the fallback for a server that reports no mode,
 * and anything unrecognised is a plain file.
 */
export function entryKind(attrs) {
  const mode = Number(attrs?.mode)
  if (Number.isFinite(mode)) {
    switch (mode & 0o170000) {
      case 0o120000: return 'link'
      case 0o040000: return 'dir'
      case 0o010000: return 'fifo'
      case 0o140000: return 'socket'
      case 0o020000: return 'char'
      case 0o060000: return 'block'
      case 0o100000: return 'file'
      default: break
    }
  }
  const flag = (name) => typeof attrs?.[name] === 'function' && attrs[name]() === true
  if (flag('isSymbolicLink')) return 'link'
  if (flag('isDirectory')) return 'dir'
  if (flag('isFIFO')) return 'fifo'
  if (flag('isSocket')) return 'socket'
  if (flag('isCharacterDevice')) return 'char'
  if (flag('isBlockDevice')) return 'block'
  return 'file'
}

function safeLocalName(value) {
  const cleaned = String(value).replace(/[\x00-\x1f<>:"|?*\\]/g, '_').replace(/^[. ]+|[. ]+$/g, '')
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file'
}

function localTarget(root, hostName, remotePath) {
  const hostDir = safeLocalName(hostName || 'host')
  const segments = remotePath
    .split('/')
    .filter((part) => part.length > 0)
    .map(safeLocalName)
  const fileName = segments.pop() || 'file'
  const dir = joinPath(root, hostDir, ...segments)
  mkdirSync(dir, { recursive: true })
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = joinPath(dir, fileName)
  let index = 2
  while (existsSync(candidate)) {
    candidate = joinPath(dir, `${stem} (${index})${ext}`)
    index += 1
  }
  return candidate
}

function insideDownloadRoot(candidate) {
  const root = DOWNLOAD_ROOT + sep
  return typeof candidate === 'string' && candidate.startsWith(root)
}

/**
 * Only the local DSH page may read loopback API responses. The desktop build
 * serves the app from its custom `dsh-app://app` scheme, so that origin must be
 * accepted alongside loopback HTTP(S); the token still guards every route.
 */
export function localOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    if (url.protocol === 'dsh-app:') return value
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return value
  } catch {
    /* ignore */
  }
  return null
}

export function createApi({ token, store, secrets, hostFor, dropHost, listHosts, routing, getRegistry, build, dataDir, readSshConfig, testConnection, terminals, forwards, assetDir, assetDirs, diagnostics, homeDir, transferLimitBytes }) {
  // An explicit option wins; otherwise the cap comes from the settings document,
  // read per transfer so a change in Settings applies to the next upload or
  // archive without restarting the Host.
  const configuredTransferLimit = Number.isFinite(transferLimitBytes) && transferLimitBytes > 0
    ? Math.floor(transferLimitBytes)
    : null
  const transferLimitNow = () => {
    if (configuredTransferLimit !== null) return configuredTransferLimit
    try {
      const value = readSettings().transfer?.limitBytes
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : MAX_TRANSFER_BYTES
    } catch {
      return MAX_TRANSFER_BYTES
    }
  }
  const transferLimitText = () => `${Math.round(transferLimitNow() / 1024 / 1024)} MB`

  // Metric probes are cached per connection for a few seconds, so a polling
  // UI cannot hammer a remote host; see lib/metrics.js.
  const metrics = new MetricsManager({
    hostFor,
    onLog: (...args) => {
      if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck]', ...args)
    },
  })
  const monitorFile = typeof dataDir === 'string' && dataDir.length > 0 ? joinPath(dataDir, 'monitor.json') : null
  const settingsFile = typeof dataDir === 'string' && dataDir.length > 0 ? joinPath(dataDir, 'settings.json') : null
  // Editor drafts live beside the settings: one JSON file per connection+path.
  const drafts = new DraftStore({
    dir: typeof dataDir === 'string' && dataDir.length > 0 ? joinPath(dataDir, DRAFT_DIR_NAME) : null,
  })
  // The unified settings document supersedes monitor.json; a data directory
  // that only holds the old file still reads its monitor section back here.
  const readSettings = () =>
    settingsFile === null
      ? normalizeSettings(null)
      : migrateSettings(readJsonFile(settingsFile, null), readJsonFile(monitorFile, null))

  /**
   * The registered workspace roots of one connection. Deleting exactly one of
   * them is the only delete the browser half asks about twice (`force: true`):
   * a mis-click there would remove the folder the Session itself lives in.
   */
  const workspaceRootsFor = (connectionId) => {
    try {
      const rows = typeof routing.listWorkspaces === 'function' ? routing.listWorkspaces() : []
      return rows
        .filter((row) => row !== null
          && typeof row === 'object'
          && row.connectionId === connectionId
          && typeof row.path === 'string'
          && row.path.length > 0)
        .map((row) => row.path)
    } catch {
      return []
    }
  }
  /**
   * Whether the browser walked away from a request in flight.
   *
   * A POST body is complete — and its IncomingMessage closed — before the
   * handler runs, so `request` itself says nothing about the client. The
   * response (closed unfinished only when the connection went away) and the
   * socket do.
   */
  const clientGone = (request, response, controller) => () => controller.signal.aborted === true
    || response.destroyed === true
    || (request.socket !== null && request.socket !== undefined && request.socket.destroyed === true)

  /**
   * Resolve one extra vendor asset by exact relative path.
   *
   * Each root carries its own allow-list and a request must match one entry
   * character for character, so neither `..` nor an absolute name can reach a
   * file outside the directory and an unlisted file is simply not found.
   */
  const additionalAsset = (name) => {
    const roots = Array.isArray(assetDirs) ? assetDirs : []
    for (const root of roots) {
      if (root === null || typeof root !== 'object') continue
      if (typeof root.dir !== 'string' || !Array.isArray(root.files)) continue
      if (root.files.includes(name)) return { dir: root.dir, name }
    }
    return null
  }

  const handle = async (request, response) => {
    const allowOrigin = localOrigin(request.headers.origin)
    const headers = {
      ...(allowOrigin === null ? {} : { 'access-control-allow-origin': allowOrigin, vary: 'Origin' }),
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
      'access-control-max-age': '600',
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }
    const send = (status, body) => {
      response.writeHead(status, headers)
      response.end(JSON.stringify(body))
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers)
      response.end()
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    // Browser tags cannot send headers, so the streaming GETs accept the token
    // as a query parameter; every JSON route stays header-only.
    const queryToken =
      (pathname.startsWith('/assets/') || pathname.endsWith('/download') || pathname.endsWith('/archive')) &&
      url.searchParams.get('token') === token
    const authorized = request.headers[TOKEN_HEADER] === token || queryToken
    if (!authorized) {
      send(403, { ok: false, message: 'forbidden' })
      return
    }
    try {
      // The upload route streams raw bytes; every other POST carries JSON, and
      // reading that here keeps the route handlers free of body parsing.
      const isUpload = request.method === 'POST' && pathname.endsWith('/upload')
      const bodyLimit = pathname.endsWith('/write') || pathname === '/draft' ? WRITE_BODY_LIMIT : JSON_BODY_LIMIT
      const body = request.method === 'POST' && !isUpload ? await readJsonBody(request, bodyLimit) : {}

      if (request.method === 'GET' && pathname === '/local/download') {
        const requested = String(url.searchParams.get('path') || '')
        const home = typeof homeDir === 'string' ? resolve(homeDir) : ''
        const target = resolve(requested)
        if (home.length === 0 || (target !== home && !target.startsWith(home + sep))) {
          return send(400, { ok: false, code: 'LOCAL_PATH_DENIED', message: 'Path is outside DSH_HOME.' })
        }
        try {
          const info = statSync(target)
          if (!info.isFile()) return send(400, { ok: false, code: 'NOT_A_FILE', message: 'Not a file.' })
          const name = posix.basename(target.replace(/\\/g, '/'))
          response.writeHead(200, {
            'content-type': mimeFor(name),
            'content-length': String(info.size),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
            ...(allowOrigin === null ? {} : { 'access-control-allow-origin': allowOrigin }),
          })
          const stream = createReadStream(target)
          stream.on('error', () => response.destroy())
          response.on('close', () => stream.destroy())
          stream.pipe(response)
          return
        } catch {
          return send(404, { ok: false, code: 'FS_NOT_FOUND', message: 'No such file.' })
        }
      }

      if (request.method === 'GET' && pathname.startsWith('/assets/')) {
        const name = pathname.slice('/assets/'.length)
        const vendor = /^(xterm\.js|xterm\.css|addon-fit\.js)$/.test(name) && typeof assetDir === 'string'
          ? { dir: assetDir, name }
          : additionalAsset(name)
        if (vendor === null) {
          return send(404, { ok: false, message: 'not found' })
        }
        try {
          const data = readFileSync(posix.join(vendor.dir, vendor.name))
          response.writeHead(200, {
            'content-type': vendor.name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'public, max-age=3600',
            ...(allowOrigin === null ? {} : { 'access-control-allow-origin': allowOrigin }),
          })
          response.end(data)
          return
        } catch {
          return send(404, { ok: false, message: 'not found' })
        }
      }

      if (request.method === 'GET' && pathname === '/health') return send(200, { ok: true, build })
      if (request.method === 'POST' && pathname === '/debug/report' && process.env.DSH_REMOTE_DECK_DEBUG === '1') {
        writeFileSync(posix.join(dataDir, 'probe.json'), JSON.stringify(body, null, 2), 'utf8')
        return send(200, { ok: true })
      }
      if (request.method === 'GET' && pathname === '/state') {
        const connections = []
        for (const record of store.list()) connections.push(await connectionView(record))
        const workspaces = routing.listWorkspaces().map((row) => {
          const record = store.get(row.connectionId)
          return {
            ...row,
            host: record?.name ?? row.host,
            color: record?.color ?? row.color,
            connected: (hostFor(row.connectionId)?.state ?? 'disconnected') === 'connected',
          }
        })
        const counts = new Map()
        for (const row of workspaces) counts.set(row.connectionId, (counts.get(row.connectionId) ?? 0) + 1)
        return send(200, {
          ok: true,
          ready: true,
          build,
          dataDir,
          connections: connections.map((row) => ({ ...row, workspaceCount: counts.get(row.id) ?? 0 })),
          workspaces,
          forwards: forwards !== undefined ? forwards.list() : [],
          diagnostics: diagnostics ?? null,
        })
      }

      // ---------------------------------------------------- settings
      // The unified settings document (terminal appearance, monitoring and the
      // transfer cap) replaced the monitor-only file. `/monitor` below stays
      // for an older browser half and maps onto `settings.monitor`.
      if (request.method === 'GET' && pathname === '/settings') {
        if (settingsFile === null) return send(500, { ok: false, message: 'settings storage is unavailable' })
        return send(200, { ok: true, config: readSettings() })
      }
      if (request.method === 'POST' && pathname === '/settings') {
        if (settingsFile === null) return send(500, { ok: false, message: 'settings storage is unavailable' })
        const incoming = body.config !== undefined ? body.config : body
        const config = normalizeSettings(incoming, readSettings())
        writeJsonFile(settingsFile, config)
        return send(200, { ok: true, config })
      }

      // ---------------------------------------------------- monitoring
      // Superseded by GET/POST /settings (settings.monitor); kept so an older
      // browser half keeps working. Both endpoints read and write the unified
      // document, migrating a legacy monitor.json on the first read.
      if (request.method === 'GET' && pathname === '/monitor') {
        if (settingsFile === null) return send(500, { ok: false, message: 'monitor storage is unavailable' })
        return send(200, { ok: true, config: readSettings().monitor })
      }
      if (request.method === 'POST' && pathname === '/monitor') {
        if (settingsFile === null) return send(500, { ok: false, message: 'monitor storage is unavailable' })
        const current = readSettings()
        const config = normalizeMonitorConfig(body.config !== undefined ? body.config : body, current.monitor)
        writeJsonFile(settingsFile, { ...current, monitor: config })
        return send(200, { ok: true, config })
      }

      // ---------------------------------------------------- terminals
      if (terminals !== undefined) {
        if (request.method === 'GET' && pathname === '/terminals') return send(200, { ok: true, terminals: terminals.list() })
        if (request.method === 'POST' && pathname === '/terminals') {
          const opened = await terminals.open(String(body.connectionId || ''), { cols: body.cols, rows: body.rows, title: body.title })
          return send(200, { ok: true, ...opened })
        }
        const termMatch = /^\/terminals\/([^/]+)(?:\/(stream|input|resize))?$/.exec(pathname)
        if (termMatch !== null) {
          const terminalId = decodeURIComponent(termMatch[1])
          const action = termMatch[2]
          if (request.method === 'GET' && action === 'stream') {
            response.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              ...(allowOrigin === null ? {} : { 'access-control-allow-origin': allowOrigin }),
              'x-accel-buffering': 'no',
            })
            response.write(': connected\n\n')
            const detach = terminals.attach(terminalId, (event) => {
              try {
                response.write('data: ' + JSON.stringify(event) + '\n\n')
              } catch {
                /* client vanished */
              }
            })
            if (detach === null) {
              response.end()
              return
            }
            const keepAlive = setInterval(() => {
              try {
                response.write(': ping\n\n')
              } catch {
                /* ignore */
              }
            }, 15000)
            if (typeof keepAlive.unref === 'function') keepAlive.unref()
            request.on('close', () => {
              clearInterval(keepAlive)
              detach()
            })
            return
          }
          if (request.method === 'POST' && action === 'input') {
            terminals.write(terminalId, String(body.data || ''))
            return send(200, { ok: true })
          }
          if (request.method === 'POST' && action === 'resize') {
            terminals.resize(terminalId, Number(body.cols) || 0, Number(body.rows) || 0)
            return send(200, { ok: true })
          }
          if (request.method === 'DELETE' && action === undefined) {
            terminals.close(terminalId)
            return send(200, { ok: true })
          }
        }
      }

      // ---------------------------------------------------- port forwarding
      if (forwards !== undefined) {
        if (request.method === 'GET' && pathname === '/forwards') return send(200, { ok: true, forwards: forwards.list() })
        if (request.method === 'POST' && pathname === '/forwards') {
          const started = await forwards.start(
            String(body.connectionId || ''),
            Number(body.remotePort),
            Number(body.localPort) || 0,
            body.origin === 'agent' ? 'agent' : 'user',
          )
          return send(200, { ok: true, forward: started })
        }
        const forwardMatch = /^\/forwards\/([^/]+)$/.exec(pathname)
        if (forwardMatch !== null && request.method === 'DELETE') {
          const removed = forwards.stop(decodeURIComponent(forwardMatch[1]))
          return send(removed ? 200 : 404, removed ? { ok: true } : { ok: false, message: 'forward not found' })
        }
      }

      const portMatch = /^\/connections\/([^/]+)\/ports$/.exec(pathname)
      if (portMatch !== null && request.method === 'GET' && forwards !== undefined) {
        const ports = await forwards.detect(decodeURIComponent(portMatch[1]))
        return send(200, { ok: true, ports })
      }

      // ---------------------------------------------------- connections
      if (request.method === 'GET' && pathname === '/ssh-config') {
        if (typeof readSshConfig !== 'function') return send(200, { ok: true, path: '', exists: false, hosts: [], keys: [] })
        return send(200, { ok: true, ...readSshConfig() })
      }

      if (request.method === 'POST' && pathname === '/connections/test') {
        if (typeof testConnection !== 'function') return send(501, { ok: false, message: 'connection test unavailable' })
        const result = await testConnection(body)
        return send(200, { ok: true, ...result })
      }

      if (request.method === 'POST' && pathname === '/connections') {
        const previous = typeof body.id === 'string' ? store.get(body.id) : undefined
        const record = store.upsert(body)
        if (typeof body.password === 'string' && body.password.length > 0) await secrets.set(record.id, 'PASSWORD', body.password)
        if (body.clearPassword === true) await secrets.clear(record.id, 'PASSWORD')
        if (typeof body.passphrase === 'string' && body.passphrase.length > 0) await secrets.set(record.id, 'PASSPHRASE', body.passphrase)
        if (body.clearPassphrase === true) await secrets.clear(record.id, 'PASSPHRASE')
        if (previous !== undefined) {
          const identity = ['host', 'port', 'username', 'authType', 'privateKeyPath']
          const identityChanged = identity.some((key) => previous[key] !== record[key])
          const secretChanged =
            (typeof body.password === 'string' && body.password.length > 0) || body.clearPassword === true ||
            (typeof body.passphrase === 'string' && body.passphrase.length > 0) || body.clearPassphrase === true
          if (identityChanged || secretChanged) {
            const existing = hostFor(record.id)
            if (existing !== undefined && existing.state === 'connected') {
              existing.disconnect()
              await existing.connect(secrets).catch(() => {})
            }
          }
        }
        return send(200, { ok: true, connection: await connectionView(record) })
      }

      // ---------------------------------------------------- metrics
      // A collection failure stays inside a 200 so the browser half can show
      // "unavailable" for a host that cannot answer instead of an error toast.
      const metricsMatch = /^\/connections\/([^/]+)\/metrics$/.exec(pathname)
      if (metricsMatch !== null && request.method === 'GET') {
        const id = decodeURIComponent(metricsMatch[1])
        if (store.get(id) === undefined) return send(404, { ok: false, message: 'Connection not found.' })
        const host = hostFor(id)
        if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
        try {
          await host.ensure(secrets)
          const snapshot = await metrics.read(id, url.searchParams.get('path') || '')
          return send(200, { ok: true, ...snapshot })
        } catch (error) {
          return send(200, { ok: true, error: errorText(error) })
        }
      }

      // ---------------------------------------------------- editor drafts
      // An unsaved editor buffer is kept on disk, so closing the tab — or DSH
      // itself — does not lose it. Every visit also sweeps what has aged out.
      if (pathname === '/draft' || pathname === '/draft/delete' || pathname === '/drafts') {
        if (drafts.available !== true) return send(500, { ok: false, message: 'draft storage is unavailable' })
        drafts.sweep()
        const draftConnectionId = typeof body.connectionId === 'string' && body.connectionId.length > 0
          ? body.connectionId
          : url.searchParams.get('connectionId') || ''

        if (request.method === 'GET' && pathname === '/drafts') {
          return send(200, { ok: true, drafts: drafts.list() })
        }
        if (request.method === 'DELETE' && pathname === '/drafts') {
          return send(200, { ok: true, removed: drafts.clear() })
        }
        if (request.method === 'POST' && pathname === '/draft') {
          const parsed = parseDraftWrite({ ...body, connectionId: draftConnectionId })
          if (parsed.ok !== true) return send(400, { ok: false, code: parsed.code, message: parsed.message })
          return send(200, { ok: true, savedAt: drafts.save(parsed.draft).savedAt })
        }
        if ((request.method === 'DELETE' && pathname === '/draft') || (request.method === 'POST' && pathname === '/draft/delete')) {
          const target = parseDraftPath(url.searchParams.get('path') ?? body.path)
          if (target.ok !== true) return send(400, { ok: false, code: target.code, message: target.message })
          drafts.remove({ connectionId: draftConnectionId, path: target.path })
          return send(200, { ok: true })
        }
        if (request.method === 'GET' && pathname === '/draft') {
          const target = parseDraftPath(url.searchParams.get('path'))
          if (target.ok !== true) return send(400, { ok: false, code: target.code, message: target.message })
          return send(200, { ok: true, draft: drafts.read({ connectionId: draftConnectionId, path: target.path }) })
        }
        return send(404, { ok: false, message: 'not found' })
      }

      const match = /^\/connections\/([^/]+)(?:\/(action|dirs|mkdir|workspaces|probe|files|scan|delete|transfer|read|write|auto-connect|download|archive|upload|save-local|reveal))?$/.exec(pathname)
      if (match !== null) {
        const id = decodeURIComponent(match[1])
        const action = match[2]
        const record = store.get(id)
        if (record === undefined) return send(404, { ok: false, message: 'Connection not found.' })

        if (request.method === 'DELETE' && action === undefined) {
          const host = hostFor(id)
          host?.disconnect()
          dropHost?.(id)
          store.remove(id)
          await secrets.clear(id, 'PASSWORD')
          await secrets.clear(id, 'PASSPHRASE')
          if (forwards !== undefined) forwards.stopForConnection(id)
          routing.invalidate()
          return send(200, { ok: true })
        }

        if (request.method === 'POST' && action === 'action') {
          const name = String(body.action || '')
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          if (name === 'connect' || name === 'reconnect') {
            if (name === 'reconnect') host.disconnect()
            await host.connect(secrets)
            return send(200, { ok: true, connection: await connectionView(record) })
          }
          if (name === 'disconnect') {
            host.disconnect()
            return send(200, { ok: true, connection: await connectionView(record) })
          }
          if (name === 'probe') {
            await host.ensure(secrets)
            await host.probe()
            return send(200, { ok: true, connection: await connectionView(record) })
          }
          return send(400, { ok: false, message: 'Unknown action.' })
        }

        if (request.method === 'POST' && action === 'auto-connect') {
          const updated = store.upsert({ ...record, autoConnect: body.enabled === true })
          return send(200, { ok: true, connection: await connectionView(updated) })
        }

        if (request.method === 'GET' && action === 'dirs') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const sftp = host.requireSftp()
          let target = url.searchParams.get('path') || '~'
          if (target === '~') target = '.'
          const resolved = await sftpCall(sftp, 'realpath', target)
          const entries = await sftpCall(sftp, 'readdir', resolved)
          const dirs = entries
            .filter((entry) => entry.attrs.isDirectory && entry.attrs.isDirectory())
            .map((entry) => ({
              name: entry.filename,
              path: posix.join(resolved, entry.filename),
              mtime: (entry.attrs.mtime || 0) * 1000,
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          const parent = resolved === '/' ? null : posix.dirname(resolved)
          return send(200, { ok: true, connectionId: id, path: resolved, parent, dirs })
        }

        if (request.method === 'GET' && action === 'files') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const sftp = host.requireSftp()
          let target = url.searchParams.get('path') || '~'
          if (target === '~' || target === '') target = '.'
          const resolved = await sftpCall(sftp, 'realpath', target)
          const entries = await sftpCall(sftp, 'readdir', resolved)
          const rows = entries
            .map((entry) => ({
              name: entry.filename,
              path: posix.join(resolved, entry.filename),
              type: entry.attrs.isDirectory && entry.attrs.isDirectory() ? 'dir' : 'file',
              kind: entryKind(entry.attrs),
              size: entry.attrs.size || 0,
              mtime: (entry.attrs.mtime || 0) * 1000,
              link: Boolean(entry.attrs.isSymbolicLink && entry.attrs.isSymbolicLink()),
            }))
            .sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'dir' ? -1 : 1))
          const parent = resolved === '/' ? null : posix.dirname(resolved)
          return send(200, { ok: true, connectionId: id, path: resolved, parent, entries: rows })
        }

        if (request.method === 'GET' && action === 'scan') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const requested = String(url.searchParams.get('path') || '/')
          if (!requested.startsWith('/')) {
            return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Not a remote POSIX path.' })
          }
          const target = normalizeRemotePath(requested)
          const attrs = await sftpCall(host.requireSftp(), 'stat', target)
          if (!(attrs.isDirectory && attrs.isDirectory())) {
            return send(400, { ok: false, message: 'Only a folder can be scanned.' })
          }
          const started = Date.now()
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)
          let result
          try {
            result = await host.runCommand(scanCommand(target), null, {
              maxBytes: SCAN_MAX_BYTES,
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timer)
          }
          // A timeout cuts the read short, but what did arrive is still worth
          // reporting — `complete` stays false unless the remote finished.
          return send(200, {
            ok: true,
            ...parseScanOutput(result.stdout),
            path: target,
            durationMs: Date.now() - started,
          })
        }

        if (request.method === 'POST' && action === 'delete') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const target = parseDeleteTarget(body.path)
          if (target.ok !== true) return send(400, { ok: false, code: target.code, message: target.message })
          if (body.force !== true && isProtectedDeleteRoot(target.path, workspaceRootsFor(id))) {
            return send(400, {
              ok: false,
              code: DELETE_ROOT_CODE,
              message: 'That folder is a workspace root; send "force": true to delete it.',
            })
          }
          // A POST body is complete — and its IncomingMessage already destroyed —
          // before this handler runs (verified against Node 20), so
          // `request.destroyed` and `request.on('close')` say nothing about the
          // client. The socket and the response do: the browser cancels by
          // aborting the request, which closes the response unfinished.
          const controller = new AbortController()
          response.on('close', () => {
            if (response.writableEnded !== true) controller.abort()
          })
          const isCancelled = () => controller.signal.aborted === true
            || response.destroyed === true
            || (request.socket !== null && request.socket !== undefined && request.socket.destroyed === true)
          const counts = emptyDeleteCounts()
          try {
            await removeRemoteTree({ sftp: host.requireSftp(), path: target.path, counts, isCancelled })
          } catch (error) {
            // The client is gone; never write into a dead socket.
            if (isDeleteCancelled(error)) return
            if (isDeleteMissing(error)) {
              return send(404, { ok: false, code: DELETE_MISSING_CODE, message: errorText(error) })
            }
            // Partially deleted: report the tally so the client can say
            // "N items were removed, then it failed".
            return send(200, { ok: false, error: errorText(error), deleted: counts })
          }
          return send(200, { ok: true, deleted: counts })
        }

        if (request.method === 'POST' && action === 'transfer') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          // A batch of copies can run long, and the browser cancels it by
          // aborting the request, which closes the response unfinished. The
          // liveness signals are the delete route's: a POST body is already
          // consumed here, so `request` itself says nothing about the client.
          const controller = new AbortController()
          response.on('close', () => {
            if (response.writableEnded !== true) controller.abort()
          })
          const isCancelled = () => controller.signal.aborted === true
            || response.destroyed === true
            || (request.socket !== null && request.socket !== undefined && request.socket.destroyed === true)
          const outcome = await transferRemotePaths({ sftp: host.requireSftp(), body, isCancelled })
          // The client is gone: never write into a dead socket.
          if (outcome.cancelled === true) return
          if (outcome.ok !== true) return send(400, { ok: false, code: outcome.code, message: outcome.message })
          return send(200, { ok: true, results: outcome.results })
        }

        if (request.method === 'GET' && action === 'read') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const controller = new AbortController()
          response.on('close', () => {
            if (response.writableEnded !== true) controller.abort()
          })
          try {
            const outcome = await readRemoteFile({
              sftp: host.requireSftp(),
              path: url.searchParams.get('path') || '',
              maxBytes: url.searchParams.get('maxBytes'),
              isCancelled: clientGone(request, response, controller),
            })
            if (outcome.ok !== true) {
              const status = outcome.code === EDIT_MISSING_CODE ? 404 : 400
              return send(status, { ok: false, code: outcome.code, message: outcome.message })
            }
            return send(200, { ok: true, ...outcome.file })
          } catch (error) {
            // The client is gone; never write into a dead socket.
            if (isEditCancelled(error)) return
            throw error
          }
        }

        if (request.method === 'POST' && action === 'write') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const parsed = parseWriteRequest(body)
          if (parsed.ok !== true) return send(400, { ok: false, code: parsed.code, message: parsed.message })
          const controller = new AbortController()
          response.on('close', () => {
            if (response.writableEnded !== true) controller.abort()
          })
          let outcome
          try {
            outcome = await writeRemoteFile({
              sftp: host.requireSftp(),
              path: parsed.path,
              content: parsed.content,
              expectedMtime: parsed.expectedMtime,
              isCancelled: clientGone(request, response, controller),
            })
          } catch (error) {
            if (isEditCancelled(error)) return
            throw error
          }
          if (outcome.ok !== true) {
            const status = outcome.code === EDIT_STALE_CODE ? 409 : 400
            const payload = { ok: false, code: outcome.code, message: outcome.message }
            if (outcome.mtime !== undefined) payload.mtime = outcome.mtime
            return send(status, payload)
          }
          return send(200, { ok: true, ...outcome.file })
        }

        if (request.method === 'GET' && action === 'download') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const sftp = host.requireSftp()
          const requested = String(url.searchParams.get('path') || '/')
          if (!requested.startsWith('/')) {
            return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Not a remote POSIX path.' })
          }
          const target = normalizeRemotePath(requested)
          const attrs = await sftpCall(sftp, 'stat', target)
          if (attrs.isDirectory && attrs.isDirectory()) return send(400, { ok: false, message: 'Cannot download a folder.' })
          const name = posix.basename(target)
          response.writeHead(200, {
            'content-type': mimeFor(name),
            'content-length': String(attrs.size || 0),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
            ...(allowOrigin === null ? {} : { 'access-control-allow-origin': allowOrigin }),
          })
          const stream = sftp.createReadStream(target)
          stream.on('error', () => response.destroy())
          response.on('close', () => stream.destroy())
          stream.pipe(response)
          return
        }

        if (request.method === 'GET' && action === 'archive') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const requestedPaths = url.searchParams.getAll('path')
          if (requestedPaths.length > ARCHIVE_MAX_PATHS) {
            return send(400, {
              ok: false,
              code: 'TOO_MANY_PATHS',
              message: `At most ${ARCHIVE_MAX_PATHS} paths can be archived at once.`,
            })
          }
          let command
          let cwd
          let name
          if (requestedPaths.length > 1) {
            // A multi-selection becomes one flat archive. Nothing is stat'ed
            // here: a path that disappeared since the listing is skipped by
            // `find` — one line on stderr, empty list — instead of failing the
            // whole download. Paths must still be plain absolute POSIX names,
            // and duplicates are collapsed so no member is stored twice.
            const targets = []
            const seen = new Set()
            for (const raw of requestedPaths) {
              const value = String(raw)
              if (!value.startsWith('/') || value.split('/').includes('..')) {
                return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Not a remote POSIX path.' })
              }
              const target = normalizeRemotePath(value)
              if (safeRemoteName(posix.basename(target)) === '') {
                return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Cannot archive that path.' })
              }
              const key = target.replace(/\/+$/, '') || '/'
              if (seen.has(key)) continue
              seen.add(key)
              targets.push(target)
            }
            command = archivePathsCommand(targets)
            cwd = null
            name = `${safeRemoteName(posix.basename(targets[0]))}.tar.gz`
          } else {
            const requested = String(url.searchParams.get('path') || '/')
            if (!requested.startsWith('/')) {
              return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Not a remote POSIX path.' })
            }
            const target = normalizeRemotePath(requested)
            const base = safeRemoteName(posix.basename(target))
            if (base === '') return send(400, { ok: false, message: 'Cannot archive that folder.' })
            const attrs = await sftpCall(host.requireSftp(), 'stat', target)
            if (!(attrs.isDirectory && attrs.isDirectory())) {
              return send(400, { ok: false, message: 'Only a folder is archived; download a file directly.' })
            }
            command = archiveCommand(base)
            cwd = posix.dirname(target)
            name = `${base}.tar.gz`
          }
          const stream = await host.streamCommand(command, cwd)
          response.writeHead(200, {
            'content-type': 'application/gzip',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          })
          let sent = 0
          let cut = false
          stream.stderr.on('data', (chunk) => {
            // `find` reports a skipped path here and tar its diagnostics; the
            // exit code settles the request, so the line is only read while the
            // plugin is being debugged.
            if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck] archive:', String(chunk).trim())
          })
          stream.on('data', (chunk) => {
            sent += chunk.length
            if (sent > transferLimitNow()) {
              cut = true
              stream.destroy()
              response.destroy()
            }
          })
          stream.on('error', () => response.destroy())
          stream.on('close', () => {
            if (!cut) response.end()
          })
          stream.pipe(response, { end: false })
          request.on('close', () => stream.destroy())
          return
        }

        if (request.method === 'POST' && action === 'upload') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const requested = String(url.searchParams.get('path') || '/')
          if (!requested.startsWith('/')) {
            return send(400, { ok: false, code: 'NOT_REMOTE_PATH', message: 'Not a remote POSIX path.' })
          }
          const name = safeRemoteName(url.searchParams.get('name') || '')
          if (name === '') return send(400, { ok: false, message: 'A plain file name is required.' })
          const declared = Number(request.headers['content-length'])
          if (Number.isFinite(declared) && declared > transferLimitNow()) {
            return send(413, {
              ok: false,
              code: 'TRANSFER_TOO_LARGE',
              message: `That file is larger than the ${transferLimitText()} transfer limit.`,
            })
          }
          const target = posix.join(normalizeRemotePath(requested), name)
          const writeStream = host.requireSftp().createWriteStream(target)
          let received = 0
          let failed = false
          const abort = (message) => {
            if (failed) return
            failed = true
            try {
              writeStream.destroy()
            } catch {
              /* ignore */
            }
            try {
              request.destroy()
            } catch {
              /* ignore */
            }
            if (!response.headersSent) {
              send(400, { ok: false, code: 'TRANSFER_FAILED', message })
            } else {
              response.destroy()
            }
          }
          request.on('data', (chunk) => {
            received += chunk.length
            if (received > transferLimitNow()) abort(`That file is larger than the ${transferLimitText()} transfer limit.`)
          })
          request.on('error', () => abort('The upload was interrupted.'))
          // Once the request body ends, its IncomingMessage closes even though
          // the SFTP write is still running, so `request` cannot report a client
          // that walked away. The response can: it only closes unfinished when
          // the connection went away.
          response.on('close', () => {
            if (response.writableEnded !== true) abort('The upload was interrupted.')
          })
          writeStream.on('error', (error) => abort(errorText(error)))
          writeStream.on('close', () => {
            if (!failed) send(200, { ok: true, path: target, bytes: received })
          })
          request.pipe(writeStream)
          return
        }

        if (request.method === 'POST' && action === 'save-local') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const sftp = host.requireSftp()
          const target = normalizeRemotePath(String(body.path || ''))
          const attrs = await sftpCall(sftp, 'stat', target)
          if (attrs.isDirectory && attrs.isDirectory()) return send(400, { ok: false, message: 'Cannot save a folder.' })
          const localPath = localTarget(DOWNLOAD_ROOT, record.name, target)
          await new Promise((resolve, reject) => {
            const writeStream = createWriteStream(localPath)
            const readStream = sftp.createReadStream(target)
            writeStream.on('close', resolve)
            writeStream.on('error', reject)
            readStream.on('error', reject)
            readStream.pipe(writeStream)
          })
          return send(200, { ok: true, localPath, root: DOWNLOAD_ROOT })
        }

        if (request.method === 'POST' && action === 'reveal') {
          const target = String(body.localPath || '')
          if (!insideDownloadRoot(target)) return send(400, { ok: false, message: 'Path is outside the download folder.' })
          spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref()
          return send(200, { ok: true })
        }

        if (request.method === 'POST' && action === 'mkdir') {
          const host = hostFor(id)
          if (host === undefined) return send(404, { ok: false, message: 'Connection not found.' })
          await host.ensure(secrets)
          const sftp = host.requireSftp()
          if (body.recursive === true) {
            const target = normalizeRemotePath(String(body.path || '/'))
            await ensureRemoteDir(sftp, target)
            return send(200, { ok: true, path: target })
          }
          const base = normalizeRemotePath(String(body.path || '/'))
          const name = String(body.name || '').trim()
          if (name.length === 0 || /[/\\\0]/.test(name) || name === '.' || name === '..') {
            return send(400, { ok: false, message: 'Invalid folder name.' })
          }
          const created = posix.join(base, name)
          await sftpCall(sftp, 'mkdir', created)
          return send(200, { ok: true, path: created })
        }

        if (request.method === 'POST' && action === 'workspaces') {
          const created = await routing.createWorkspace(id, String(body.path || ''), record, {
            title: typeof body.title === 'string' ? body.title : undefined,
          })
          return send(200, { ok: true, ...created })
        }
      }

      if (request.method === 'DELETE' && pathname === '/workspaces') {
        const stub = url.searchParams.get('stub') || ''
        if (stub === '') return send(400, { ok: false, message: 'Missing stub parameter.' })
        if (getRegistry() === undefined) return send(500, { ok: false, message: 'Workspace registry is unavailable.' })
        await routing.removeWorkspace(stub)
        return send(200, { ok: true })
      }

      if (request.method === 'GET' && pathname === '/map') {
        return send(200, {
          ok: true,
          workspaces: routing.listWorkspaces().map((row) => ({
            stub: row.stub,
            connectionId: row.connectionId,
            path: row.path,
            host: row.host,
            color: row.color,
          })),
        })
      }

      return send(404, { ok: false, message: 'not found' })
    } catch (error) {
      if (response.headersSent) {
        try {
          response.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      return send(500, {
        ok: false,
        code: error && error.code,
        message: errorText(error),
      })
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      try {
        if (response.headersSent) {
          response.destroy()
          return
        }
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: false, message: errorText(error) }))
      } catch {
        try {
          response.destroy()
        } catch {
          /* ignore */
        }
      }
    })
  })

  async function connectionView(record) {
    const host = hostFor(record.id)
    const status = host === undefined ? { state: 'disconnected' } : host.status()
    const described = await secrets.describe(record.id)
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authType: record.authType,
      privateKeyPath: record.privateKeyPath,
      jump: typeof record.jump === 'string' ? record.jump : '',
      color: record.color,
      autoConnect: record.autoConnect,
      notes: record.notes,
      status: status.state,
      error: status.error,
      since: status.since,
      latencyMs: status.latencyMs ?? null,
      sys: status.sys ?? null,
      hasPassword: described.password,
      hasPassphrase: described.passphrase,
    }
  }

  return server
}

function readJsonBody(request, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      if (body.length < limit) body += String(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
    request.on('error', () => resolve({}))
  })
}
