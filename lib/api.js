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
  safeRemoteName,
  shellQuote,
  sftpCall,
} from './util.js'

const TOKEN_HEADER = 'x-dsh-remote-token'
const DOWNLOAD_ROOT = joinPath(homedir(), 'Downloads', 'Remote Deck')

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

export function createApi({ token, store, secrets, hostFor, listHosts, routing, getRegistry, build, dataDir, readSshConfig, testConnection, terminals, forwards, assetDir, diagnostics, homeDir, transferLimitBytes }) {
  const transferLimit = Number.isFinite(transferLimitBytes) && transferLimitBytes > 0
    ? Math.floor(transferLimitBytes)
    : MAX_TRANSFER_BYTES
  const transferLimitText = `${Math.round(transferLimit / 1024 / 1024)} MB`
  const server = http.createServer(async (request, response) => {
    const headers = {
      'access-control-allow-origin': '*',
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
    // Browser tags (script/link) cannot send headers, so static terminal assets
    // accept the same token as a query parameter; every JSON route stays header-only.
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
      const body = request.method === 'POST' && !isUpload ? await readJsonBody(request) : {}

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
            'access-control-allow-origin': '*',
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
        if (!/^(xterm\.js|xterm\.css|addon-fit\.js)$/.test(name) || typeof assetDir !== 'string') {
          return send(404, { ok: false, message: 'not found' })
        }
        try {
          const data = readFileSync(posix.join(assetDir, name))
          response.writeHead(200, {
            'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'public, max-age=3600',
            'access-control-allow-origin': '*',
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
              'access-control-allow-origin': '*',
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
        const record = store.upsert(body)
        if (typeof body.password === 'string' && body.password.length > 0) await secrets.set(record.id, 'PASSWORD', body.password)
        if (body.clearPassword === true) await secrets.clear(record.id, 'PASSWORD')
        if (typeof body.passphrase === 'string' && body.passphrase.length > 0) await secrets.set(record.id, 'PASSPHRASE', body.passphrase)
        if (body.clearPassphrase === true) await secrets.clear(record.id, 'PASSPHRASE')
        return send(200, { ok: true, connection: await connectionView(record) })
      }

      const match = /^\/connections\/([^/]+)(?:\/(action|dirs|mkdir|workspaces|probe|files|auto-connect|download|archive|upload|save-local|reveal))?$/.exec(pathname)
      if (match !== null) {
        const id = decodeURIComponent(match[1])
        const action = match[2]
        const record = store.get(id)
        if (record === undefined) return send(404, { ok: false, message: 'Connection not found.' })

        if (request.method === 'DELETE' && action === undefined) {
          const host = hostFor(id)
          host?.disconnect()
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
              size: entry.attrs.size || 0,
              mtime: (entry.attrs.mtime || 0) * 1000,
              link: Boolean(entry.attrs.isSymbolicLink && entry.attrs.isSymbolicLink()),
            }))
            .sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'dir' ? -1 : 1))
          const parent = resolved === '/' ? null : posix.dirname(resolved)
          return send(200, { ok: true, connectionId: id, path: resolved, parent, entries: rows })
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
            'access-control-allow-origin': '*',
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
          const stream = await host.streamCommand(
            `tar czf - -C ${shellQuote(posix.dirname(target))} ${shellQuote(base)}`,
            null,
          )
          const name = `${base}.tar.gz`
          response.writeHead(200, {
            'content-type': 'application/gzip',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          })
          let sent = 0
          let cut = false
          stream.stderr.on('data', () => {
            /* tar writes its diagnostics here; the exit code settles the request */
          })
          stream.on('data', (chunk) => {
            sent += chunk.length
            if (sent > transferLimit) {
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
          if (Number.isFinite(declared) && declared > transferLimit) {
            return send(413, {
              ok: false,
              code: 'TRANSFER_TOO_LARGE',
              message: `That file is larger than the ${transferLimitText} transfer limit.`,
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
            if (received > transferLimit) abort(`That file is larger than the ${transferLimitText} transfer limit.`)
          })
          request.on('error', () => abort('The upload was interrupted.'))
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
            writeGuide: body.writeGuide !== false,
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
      return send(500, {
        ok: false,
        code: error && error.code,
        message: errorText(error),
      })
    }
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

function readJsonBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      if (body.length < 131072) body += String(chunk)
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
