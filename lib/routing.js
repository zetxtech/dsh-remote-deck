/**
 * Workspace routing: marker files, the remote/host path bridge, and the
 * `ctx.fs` patch that makes a marked directory behave like a local one.
 *
 * A remote workspace is a stub directory holding `.dsh-remote.json`:
 *   { version, connectionId, path: '/data/work/app', host: 'dev-box' }
 * Everything under the stub resolves to `path` on the host, so tools, the file
 * tree and the previews need no remote-specific code.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import {
  MARKER,
  MAX_TEXT_BYTES,
  attrsType,
  attrsVersion,
  ensureDir,
  ensureRemoteDir,
  errorText,
  fsError,
  normalizeRemotePath,
  sftpCall,
  shellQuote,
  slugFor,
  writeJsonFile,
} from './util.js'

/**
 * Replace an existing remote file with an already-written temporary sibling.
 *
 * OpenSSH's sftp-server refuses a plain SSH_FXP_RENAME when the destination
 * exists (SSH_FX_FAILURE), so a remote edit or overwrite used to fail while a
 * fresh create worked. Prefer the posix-rename@openssh.com extension (atomic
 * overwrite), then a plain rename for servers that do overwrite, and finally
 * an in-place write for a conservative SFTP server.
 *
 * @param {object} sftp connected ssh2 SFTP session
 * @param {string} temp temporary source path holding the new content
 * @param {string} target destination path, possibly existing
 * @param {Buffer} buffer the new content, for the in-place fallback
 * @returns {Promise<'posix-rename' | 'rename' | 'direct-write'>} strategy used
 */
export async function replaceRemoteFile(sftp, temp, target, buffer) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await sftpCall(sftp, 'ext_openssh_rename', temp, target)
      return 'posix-rename'
    } catch {
      /* extension unsupported or refused: fall through */
    }
  }
  try {
    await sftpCall(sftp, 'rename', temp, target)
    return 'rename'
  } catch {
    /* target exists and the server refuses to overwrite: fall through */
  }
  await sftpCall(sftp, 'writeFile', target, buffer)
  return 'direct-write'
}

export class Routing {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot directory for new workspace stubs
   * @param {string[]} options.legacyRoots older stub roots, adopted in place
   * @param {(id: string) => import('./connection.js').RemoteHost | undefined} options.hostFor
   * @param {(connectionId: string) => Promise<void>} [options.ensureConnected]
   * @param {() => any} [options.getRegistry]
   */
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot
    this.roots = [options.workspaceRoot, ...(options.legacyRoots ?? [])]
    this.hostFor = options.hostFor
    this.ensureConnected = options.ensureConnected ?? (async () => {})
    this.getRegistry = options.getRegistry ?? (() => undefined)
    this.markerCache = new Map()
    this.rootsCache = { at: 0, rows: [] }
    this.targetMeta = new WeakMap()
    this.pathIndex = new Map()
  }

  // ------------------------------------------------------------- markers

  readMarker(dir) {
    const cached = this.markerCache.get(dir)
    if (cached !== undefined && Date.now() - cached.at < 2000) return cached.value
    let value = null
    try {
      const markerText = readFileSync(join(dir, MARKER), 'utf8')
      const parsed = JSON.parse(markerText.charCodeAt(0) === 0xfeff ? markerText.slice(1) : markerText)
      if (parsed && typeof parsed.connectionId === 'string' && typeof parsed.path === 'string') {
        value = {
          connectionId: parsed.connectionId,
          path: normalizeRemotePath(parsed.path),
          host: typeof parsed.host === 'string' ? parsed.host : '',
          color: typeof parsed.color === 'string' ? parsed.color : '',
        }
      }
    } catch {
      value = null
    }
    this.markerCache.set(dir, { at: Date.now(), value })
    return value
  }

  mappingFor(absPath) {
    let dir = absPath
    for (let depth = 0; depth < 14; depth += 1) {
      const marker = this.readMarker(dir)
      if (marker !== null) return { dir, marker }
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  }

  /** Every marked stub across the new and legacy roots. */
  knownWorkspaceRoots() {
    if (Date.now() - this.rootsCache.at < 2000) return this.rootsCache.rows
    const rows = []
    for (const root of this.roots) {
      if (!existsSync(root)) continue
      try {
        for (const connectionDir of readdirSync(root, { withFileTypes: true })) {
          if (!connectionDir.isDirectory()) continue
          const dir = join(root, connectionDir.name)
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const stub = join(dir, entry.name)
            const marker = this.readMarker(stub)
            if (marker !== null) rows.push({ stub, ...marker })
          }
        }
      } catch {
        /* one unreadable root must not hide the others */
      }
    }
    this.rootsCache = { at: Date.now(), rows }
    return rows
  }

  invalidate() {
    this.rootsCache = { at: 0, rows: [] }
    this.markerCache.clear()
  }

  // ------------------------------------------------------------- path mapping

  /**
   * Resolve a tool path to { connectionId, path } on a remote host, or null
   * when it belongs to the local machine.
   */
  resolveTarget(path, cwd) {
    if (typeof path !== 'string' || path.length === 0) return null
    const isPosix = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    const cwdMapping = typeof cwd === 'string' && !isPosix(cwd) ? this.mappingFor(cwd) : null
    // A POSIX cwd inside a registered remote workspace is a remote Session.
    // A POSIX cwd outside every workspace (for example `/`, the local drive
    // root) is not: local Windows paths must still resolve against the local
    // machine, otherwise a remote Session could never switch back to a local
    // workspace and local paths would be rejected.
    const posixCwd = isPosix(cwd) ? posix.normalize(cwd) : null
    const cwdRoot = posixCwd === null ? null : this.bestRoot(posixCwd)

    if (posixCwd !== null && !isPosix(path)) {
      // Remote development still needs local Windows resources: an explicit
      // drive/backslash path means the local machine, even inside a remote
      // Session. POSIX names resolve on the remote host, including paths that
      // step outside the workspace (/tmp, /var, ...).
      if (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) return null
      const candidate = posix.normalize(posix.join(posixCwd, path))
      const best = this.bestRoot(candidate)
      if (best !== null) return { connectionId: best.connectionId, path: candidate }
      if (cwdRoot !== null) return { connectionId: cwdRoot.connectionId, path: candidate }
      return null
    }
    if (isPosix(path)) {
      if (cwdMapping !== null) {
        return { connectionId: cwdMapping.marker.connectionId, path: normalizeRemotePath(path) }
      }
      const normalized = normalizeRemotePath(path)
      const best = this.bestRoot(normalized)
      if (best !== null) return { connectionId: best.connectionId, path: normalized }
      // A POSIX absolute path outside every workspace root inside a remote
      // Session still names the remote machine (/tmp, /var, /home/...).
      // Without this fallback the file tools silently resolved the same
      // spelling against the local Windows drive (for example /tmp -> E:\tmp).
      if (cwdRoot !== null) return { connectionId: cwdRoot.connectionId, path: normalized }
      return null
    }
    const base = isAbsolute(path) ? path : join(cwdMapping === null ? cwd || process.cwd() : cwdMapping.dir, path)
    const mapping = this.mappingFor(base)
    if (mapping === null) {
      const drive = /^([A-Za-z]):[\\/](.*)$/.exec(base)
      if (drive !== null) {
        const candidate = normalizeRemotePath(`/${drive[2].replace(/\\/g, '/')}`)
        const best = this.bestRoot(candidate)
        if (best !== null) return { connectionId: best.connectionId, path: candidate }
      }
      return null
    }
    const rel = relative(mapping.dir, base)
    const remotePath =
      rel === '' ? mapping.marker.path : posix.normalize(posix.join(mapping.marker.path, rel.split(sep).join('/')))
    return { connectionId: mapping.marker.connectionId, path: remotePath }
  }

  bestRoot(candidate) {
    const rows = this.knownWorkspaceRoots()
      .filter((row) => candidate === row.path || candidate.startsWith(`${row.path}/`))
      .sort((a, b) => b.path.length - a.path.length)
    return rows.length === 0 ? null : rows[0]
  }

  remember(target, meta) {
    this.targetMeta.set(target, meta)
    this.pathIndex.set(target.targetKey, meta)
    if (this.pathIndex.size > 2000) {
      const first = this.pathIndex.keys().next().value
      this.pathIndex.delete(first)
    }
    return target
  }

  metaOf(target) {
    if (target === undefined || target === null) return undefined
    const direct = this.targetMeta.get(target)
    if (direct !== undefined) return direct
    return this.pathIndex.get(target.targetKey)
  }

  // ------------------------------------------------------------- workspaces

  listWorkspaces() {
    return this.knownWorkspaceRoots().map((row) => ({
      stub: row.stub,
      connectionId: row.connectionId,
      path: row.path,
      host: row.host,
      color: row.color,
      folder: posix.basename(row.path) || '/',
      title: `${row.host || 'remote'} · ${posix.basename(row.path) || '/'}`,
    }))
  }

  async createWorkspace(connectionId, remotePath, record, options = {}) {
    const host = this.hostFor(connectionId)
    if (host === undefined) throw fsError('REMOTE_DECK_UNKNOWN', 'Connection does not exist.')
    const sftp = host.requireSftp()
    const target = normalizeRemotePath(remotePath)
    await ensureRemoteDir(sftp, target)
    const info = await sftpCall(sftp, 'stat', target)
    if (attrsType(info) !== 'directory') throw fsError('REMOTE_DECK_NOT_DIR', `${target} is not a directory.`)

    const stub = join(this.workspaceRoot, connectionId, slugFor(target))
    if (options.writeGuide !== false) await this.#ensureGuide(sftp, target, record)
    ensureDir(stub)
    writeJsonFile(join(stub, MARKER), {
      version: 1,
      connectionId,
      path: target,
      host: record?.name ?? host.record.name,
      color: record?.color ?? '',
    })
    this.markerCache.delete(stub)
    this.invalidate()

    const fallbackTitle = `${record?.name ?? host.record.name} · ${posix.basename(target) || '/'}`
    const title = typeof options.title === 'string' && options.title.trim().length > 0
      ? options.title.trim().slice(0, 120)
      : fallbackTitle
    const registry = this.getRegistry()
    let workspace
    if (registry !== undefined) workspace = await registry.create(stub, title)
    return {
      stub,
      path: target,
      connectionId,
      title,
      workspace: workspace === undefined ? undefined : { id: workspace.id, path: workspace.path, title: workspace.title },
    }
  }

  async #ensureGuide(sftp, target, record) {
    try {
      await sftpCall(sftp, 'stat', posix.join(target, 'AGENTS.md'))
      return
    } catch {
      /* write the guide below */
    }
    const hostName = record?.name ?? 'remote'
    const guide = [
      '# Remote workspace',
      '',
      `- This workspace lives on the remote host "${hostName}" at \`${target}\` (POSIX path).`,
      '- Run commands with the `bash` tool; file reads, writes, edits and listings already go to the remote filesystem.',
      '- `grep` and `glob` run ripgrep on the remote host; use POSIX paths.',
      '- Write anything the user should preview into this directory.',
      '',
    ].join('\n')
    await sftpCall(sftp, 'writeFile', posix.join(target, 'AGENTS.md'), Buffer.from(guide, 'utf8')).catch(() => {})
  }

  async removeWorkspace(stub) {
    const registry = this.getRegistry()
    if (registry === undefined) throw fsError('REMOTE_DECK_NO_REGISTRY', 'Workspace registry is unavailable.')
    let entity = await registry.resolveByPath(stub).catch(() => undefined)
    if (entity === undefined) {
      const target = await realpath(stub).catch(() => stub)
      for (const candidate of registry.list()) {
        const canonical = await realpath(candidate.path).catch(() => candidate.path)
        if (canonical.toLowerCase() === target.toLowerCase()) {
          entity = candidate
          break
        }
      }
    }
    if (entity === undefined) throw fsError('REMOTE_DECK_NOT_REGISTERED', 'This workspace is not in the DSH registry.')
    await registry.delete(entity.id)
    try {
      const entries = readdirSync(stub)
      if (entries.every((name) => name === MARKER)) rmSync(stub, { recursive: true, force: true })
    } catch {
      /* the stub may already be gone */
    }
    this.invalidate()
    return { removed: true }
  }

  // ------------------------------------------------------------- remote text

  async readText(host, remotePath) {
    const sftp = host.requireSftp()
    const info = await sftpCall(sftp, 'stat', remotePath)
    if (attrsType(info) !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `"${remotePath}" is not a regular file`)
    if ((info.size || 0) > MAX_TEXT_BYTES) throw fsError('FS_TOO_LARGE', `"${remotePath}" exceeds the text read limit`)
    const buffer = await sftpCall(sftp, 'readFile', remotePath)
    if (buffer.includes(0)) throw fsError('FS_NOT_TEXT', `"${remotePath}" is binary, not UTF-8 text`)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw fsError('FS_NOT_TEXT', `"${remotePath}" is not valid UTF-8 text`)
    }
  }

  async writeText(host, remotePath, content) {
    const sftp = host.requireSftp()
    const dir = posix.dirname(remotePath)
    const temp = posix.join(dir, `.dsh-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const buffer = Buffer.from(content, 'utf8')
    await sftpCall(sftp, 'writeFile', temp, buffer)
    try {
      await replaceRemoteFile(sftp, temp, remotePath, buffer)
    } finally {
      await sftpCall(sftp, 'unlink', temp).catch(() => {})
    }
  }

  // ------------------------------------------------------------- fs patch

  installFs(fsService) {
    const routing = this
    const originals = new Map()
    const wrap = (name, factory) => {
      const original = fsService[name]
      if (typeof original !== 'function') return
      originals.set(name, original)
      fsService[name] = factory(original.bind(fsService))
    }

    const remoteFor = (path, cwd) => {
      const mapped = this.resolveTarget(path, cwd)
      if (mapped === null) return null
      const host = this.hostFor(mapped.connectionId)
      if (host === undefined) return null
      return { host, path: mapped.path }
    }

    wrap('resolve', (original) => async (path, opts) => {
      const remote = remoteFor(path, opts && opts.cwd)
      if (remote === null) return original(path, opts)
      await this.ensureConnected(remote.host.record.id)
      return this.remember({ targetKey: `${remote.host.record.id}\u0000${remote.path}`, displayPath: remote.path }, {
        connectionId: remote.host.record.id,
        path: remote.path,
      })
    })

    wrap('stat', (original) => async (target, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, signal)
      const host = this.hostFor(meta.connectionId)
      if (host === undefined) return undefined
      try {
        const attrs = await sftpCall(host.requireSftp(), 'stat', meta.path)
        return { version: attrsVersion(attrs), type: attrsType(attrs), size: attrs.size || 0 }
      } catch (error) {
        if (error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
    })

    wrap('lstat', (original) => async (path, opts, signal) => {
      const remote = remoteFor(path, opts && opts.cwd)
      if (remote === null) return original(path, opts, signal)
      try {
        const attrs = await sftpCall(remote.host.requireSftp(), 'lstat', remote.path)
        return { version: attrsVersion(attrs), type: attrsType(attrs), size: attrs.size || 0 }
      } catch (error) {
        if (error.code === 'FS_NOT_FOUND') return undefined
        throw error
      }
    })

    wrap('readText', (original) => async (target, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, signal)
      return this.readText(this.hostFor(meta.connectionId), meta.path)
    })

    wrap('streamText', (original) => (target, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, signal)
      const host = this.hostFor(meta.connectionId)
      return (async function* stream() {
        yield await routing.readText(host, meta.path)
      })()
    })

    wrap('readBytes', (original) => async (target, signal, maxBytes) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, signal, maxBytes)
      const sftp = this.hostFor(meta.connectionId).requireSftp()
      const info = await sftpCall(sftp, 'stat', meta.path)
      if (attrsType(info) !== 'file') throw fsError('FS_NOT_REGULAR_FILE', 'not a regular file')
      if ((info.size || 0) > maxBytes) throw fsError('FS_TOO_LARGE', `file is larger than the ${maxBytes}-byte cap`)
      return await sftpCall(sftp, 'readFile', meta.path)
    })

    wrap('readByteRange', (original) => async (target, range, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, range, signal)
      const offset = Math.max(0, Math.floor(Number(range?.offset) || 0))
      const length = Math.max(0, Math.floor(Number(range?.length) || 0))
      if (length === 0) return Buffer.alloc(0)
      const host = this.hostFor(meta.connectionId)
      const sftp = host.requireSftp()
      const info = await sftpCall(sftp, 'stat', meta.path)
      if (attrsType(info) !== 'file') throw fsError('FS_NOT_REGULAR_FILE', 'not a regular file')
      const total = Number(info.size) || 0
      const start = Math.min(offset, total)
      const endExclusive = Math.min(offset + length, total)
      if (endExclusive <= start) return Buffer.alloc(0)
      return await new Promise((resolve, reject) => {
        const chunks = []
        let settled = false
        let stream = null
        const finish = (error, buffer) => {
          if (settled) return
          settled = true
          if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
          if (error) reject(error)
          else resolve(buffer)
        }
        const onAbort = () => {
          try {
            stream?.destroy()
          } catch {
            /* ignore */
          }
          finish(fsError('REMOTE_DECK_ABORTED', 'remote read aborted'))
        }
        try {
          stream = sftp.createReadStream(meta.path, { start, end: endExclusive - 1 })
        } catch (error) {
          finish(error)
          return
        }
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('error', (error) => finish(error))
        stream.on('end', () => finish(null, Buffer.concat(chunks)))
        if (signal !== undefined) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    })

    wrap('listDir', (original) => async (target, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, signal)
      const sftp = this.hostFor(meta.connectionId).requireSftp()
      const entries = await sftpCall(sftp, 'readdir', meta.path)
      return entries
        .map((entry) => {
          const childPath = posix.join(meta.path, entry.filename)
          const type = attrsType(entry.attrs)
          const row = {
            name: entry.filename,
            type,
            target: { targetKey: childPath, displayPath: childPath },
            version: attrsVersion(entry.attrs),
            ...(type === 'file' ? { size: entry.attrs.size || 0 } : {}),
          }
          this.targetMeta.set(row.target, { connectionId: meta.connectionId, path: childPath })
          return row
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    })

    wrap('writeText', (original) => async (target, content, expected, signal, sandboxPolicy) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, content, expected, signal, sandboxPolicy)
      const host = this.hostFor(meta.connectionId)
      const sftp = host.requireSftp()
      let existing
      try {
        existing = await sftpCall(sftp, 'stat', meta.path)
      } catch (error) {
        if (error.code !== 'FS_NOT_FOUND') throw error
        existing = undefined
      }
      if (expected && expected.kind === 'replaceIfVersion') {
        if (existing === undefined) throw fsError('FS_STALE_VERSION', `cannot write "${meta.path}": file no longer exists`)
        if (attrsVersion(existing) !== expected.version) throw fsError('FS_STALE_VERSION', `cannot write "${meta.path}": file changed since it was read`)
      } else if (expected && expected.kind === 'createIfAbsent' && existing !== undefined) {
        throw fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${meta.path}" without reading it first`)
      }
      const before = existing !== undefined && (existing.size || 0) <= 1024 * 1024
        ? await this.readText(host, meta.path).catch(() => null)
        : null
      await this.writeText(host, meta.path, content)
      const after = await sftpCall(sftp, 'stat', meta.path)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: attrsVersion(after),
        before,
        after: content.replace(/\r\n/g, '\n'),
      }
    })

    wrap('editText', (original) => async (target, edit, expected, signal, sandboxPolicy) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, edit, expected, signal, sandboxPolicy)
      const host = this.hostFor(meta.connectionId)
      const sftp = host.requireSftp()
      const info = await sftpCall(sftp, 'stat', meta.path)
      if (expected && attrsVersion(info) !== expected.version) {
        throw fsError('FS_STALE_VERSION', `cannot edit "${meta.path}": file changed since it was read`)
      }
      const originalText = await this.readText(host, meta.path)
      const normalized = originalText.replace(/\r\n/g, '\n')
      const oldNorm = String(edit.oldString).replace(/\r\n/g, '\n')
      const newNorm = String(edit.newString).replace(/\r\n/g, '\n')
      if (oldNorm.length === 0) throw fsError('FS_EDIT_NOT_FOUND', 'old_string must be a non-empty string')
      const count = normalized.split(oldNorm).length - 1
      if (count === 0) throw fsError('FS_EDIT_NOT_FOUND', `old_string was not found in "${meta.path}"`)
      if (edit.replaceAll !== true && count > 1) throw fsError('FS_AMBIGUOUS_EDIT', `old_string matched ${count} times in "${meta.path}"`)
      const replaced = normalized.split(oldNorm).join(newNorm)
      const output = originalText.includes('\r\n') ? replaced.replace(/\n/g, '\r\n') : replaced
      await this.writeText(host, meta.path, output)
      const after = await sftpCall(sftp, 'stat', meta.path)
      return { version: attrsVersion(after), before: originalText, after: replaced }
    })

    wrap('watch', (original) => (target, changed, signal) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, changed, signal)
      let closed = false
      let timer = null
      let last
      const poll = async () => {
        if (closed) return
        try {
          const sftp = this.hostFor(meta.connectionId).requireSftp()
          const attrs = await sftpCall(sftp, 'stat', meta.path)
          const version = attrsVersion(attrs)
          if (last !== undefined && last !== version) changed()
          last = version
        } catch {
          /* transient poll failure: keep the watcher alive */
        }
        if (!closed) timer = setTimeout(poll, 1500)
      }
      return (async () => {
        signal.throwIfAborted()
        await poll()
        return async () => {
          closed = true
          if (timer !== null) clearTimeout(timer)
        }
      })()
    })

    wrap('contains', (original) => (parent, child) => {
      const parentMeta = this.metaOf(parent)
      const childMeta = this.metaOf(child)
      if (parentMeta === undefined || childMeta === undefined) return original(parent, child)
      if (parentMeta.connectionId !== childMeta.connectionId) return false
      const rel = posix.relative(parentMeta.path, childMeta.path)
      return rel === '' || (rel !== '..' && !rel.startsWith('../'))
    })

    wrap('fileUrl', (original) => (target) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target)
      return `file://${encodeURI(meta.path)}`
    })

    wrap('processPath', (original) => (target) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target)
      return meta.path
    })

    wrap('patchText', (original) => async (target, ...rest) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, ...rest)
      throw fsError('REMOTE_DECK_UNSUPPORTED', `apply_patch is not supported on remote workspaces yet; edit or write "${meta.path}" instead`)
    })

    wrap('deleteFile', (original) => async (target, ...rest) => {
      const meta = this.metaOf(target)
      if (meta === undefined) return original(target, ...rest)
      const sftp = this.hostFor(meta.connectionId).requireSftp()
      try {
        await sftpCall(sftp, 'unlink', meta.path)
      } catch (error) {
        if (error.code !== 'FS_NOT_FOUND') throw error
      }
      return { operation: 'delete' }
    })

    wrap('moveFile', (original) => async (source, destination, ...rest) => {
      const sourceMeta = this.metaOf(source)
      const destinationMeta = this.metaOf(destination)
      if (sourceMeta === undefined && destinationMeta === undefined) return original(source, destination, ...rest)
      if (sourceMeta === undefined || destinationMeta === undefined || sourceMeta.connectionId !== destinationMeta.connectionId) {
        throw fsError('REMOTE_DECK_UNSUPPORTED', 'moving files between the local machine and a remote host is not supported')
      }
      const sftp = this.hostFor(sourceMeta.connectionId).requireSftp()
      try {
        await sftpCall(sftp, 'ext_openssh_rename', sourceMeta.path, destinationMeta.path)
      } catch {
        await sftpCall(sftp, 'rename', sourceMeta.path, destinationMeta.path)
      }
      return { operation: 'move' }
    })

    wrap('processPathFromHostPath', (original) => (hostPath) => {
      const mapped = this.resolveTarget(hostPath, undefined)
      return mapped === null ? original(hostPath) : mapped.path
    })

    return () => {
      for (const [name, original] of originals) {
        try {
          fsService[name] = original
        } catch {
          /* ignore */
        }
      }
      originals.clear()
    }
  }

  /** Replace the local ripgrep process with one running on the remote host. */
  makeRemoteRipgrep(host, cwd, args, spec) {
    let stdout = ''
    let stderr = ''
    let settle
    const done = new Promise((resolve) => {
      settle = resolve
    })
    let stdoutLossy = false
    let stderrLossy = false
    const abort = new AbortController()
    const signal = spec.signal === undefined
      ? abort.signal
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([spec.signal, abort.signal]) : spec.signal)
    const configured = Number(spec?.stdio?.stdout?.maxBytes)
    const cap = Number.isFinite(configured) && configured > 0 ? configured : 8 * 1024 * 1024
    const command = `rg ${args.map(shellQuote).join(' ')}`
    host
      .runCommand(command, cwd, { signal, maxBytes: cap, timeoutMs: 120000 })
      .then((result) => {
        stdout = result.stdout
        stderr = result.stderr
        stdoutLossy = result.truncatedOut === true
        stderrLossy = result.truncatedErr === true
        settle({ exitCode: result.code, signal: null })
      })
      .catch((error) => {
        stderr = errorText(error)
        settle({ exitCode: 255, signal: null })
      })
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: stdoutLossy }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: stderrLossy }) },
      },
      kill() {
        try {
          abort.abort()
        } catch {
          /* ignore */
        }
        settle({ exitCode: 130, signal: null })
      },
    }
  }
}
