/**
 * Remote copy and move for the file page: clipboard (copy / cut / paste) and
 * drag-and-drop both land here.
 *
 * Rules that shape this module:
 *
 * - **The batch never fails as a whole.** One entry that cannot be transferred
 *   is one `ok: false` row; the remaining entries still run. Only a malformed
 *   request is refused outright, and it is refused before any filesystem work.
 * - **Nothing is overwritten.** An existing destination is an `EXISTS` row,
 *   which the browser half turns into "already there, pick another name".
 * - **Symbolic links are recreated, never followed**: `readlink` then `symlink`
 *   at the new location, so a link to a directory copies as a link.
 * - **FIFOs, sockets and devices are never read.** They are `UNSUPPORTED` when
 *   requested directly, and skipped when met inside a directory being copied.
 * - **A move tries `rename` first.** SFTP cannot report EXDEV apart from any
 *   other failure (OpenSSH maps it to `SSH_FX_FAILURE` with no message), so any
 *   rename failure that is not "the source is gone" falls back to copy-then-
 *   delete, which reuses the delete walk's no-follow semantics.
 * - **Cancellation is checked before every operation** and between file chunks:
 *   the browser stops a transfer by aborting the HTTP request.
 */
import { posix } from 'node:path'
import { removeRemoteTree } from './delete.js'
import { sftpCall } from './util.js'

/** How many paths one copy/move request may carry. */
export const TRANSFER_MAX_PATHS = 200
/** The path is not a plain absolute remote POSIX path. */
export const TRANSFER_INVALID_CODE = 'NOT_REMOTE_PATH'
/** The paste target is not an existing directory. */
export const TRANSFER_NOT_DIR_CODE = 'NOT_REMOTE_DIR'
/** The paste target sits inside a directory that is being transferred. */
export const TRANSFER_INSIDE_SOURCE_CODE = 'DEST_INSIDE_SOURCE'
/** More paths than {@link TRANSFER_MAX_PATHS}. */
export const TRANSFER_TOO_MANY_CODE = 'TOO_MANY_PATHS'
/** The client went away; nothing is written back. */
export const TRANSFER_CANCELLED_CODE = 'REMOTE_DECK_TRANSFER_CANCELLED'

/** FS_NOT_FOUND from `sftpCall`, and the raw SFTP status code for it. */
const FS_NOT_FOUND = 'FS_NOT_FOUND'
const SFTP_NO_SUCH_FILE = 2

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** A refusal the route answers with 400. */
function refuse(code, message) {
  return { ok: false, code, message }
}

/** One failed entry inside an otherwise successful batch. */
function failed(entry, code, message) {
  return { path: entry.path, name: entry.name, ok: false, code, message }
}

function succeeded(entry) {
  return { path: entry.path, name: entry.name, ok: true }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error) {
  return Boolean(error) && (error.code === FS_NOT_FOUND || error.code === SFTP_NO_SUCH_FILE)
}

function isCancelledError(error) {
  return Boolean(error) && error.code === TRANSFER_CANCELLED_CODE
}

/** A plain absolute remote path: no relative spelling, no `..`, no `//`. */
export function isPlainRemotePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  return !value.split('/').includes('..')
}

/** Normalized, and without the trailing slash `posix.normalize` keeps. */
export function canonicalRemotePath(value) {
  const normalized = posix.normalize(String(value))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * Whether `child` is `parent` itself or below it.
 *
 * Compares the canonical spellings, so `/a/b/` cannot slip past as "not inside".
 * Both arguments must already be canonical and absolute.
 */
export function isInside(parent, child) {
  if (parent === child) return true
  const prefix = parent === '/' ? '/' : `${parent}/`
  return child.startsWith(prefix)
}

/**
 * The kind of one entry, from its SFTP attrs.
 *
 * The POSIX type bits decide first: ssh2's predicates are not reliable for every
 * type (a unix socket and a block device both report their predicate false), and
 * misreading a socket as a regular file here would mean trying to read it. The
 * predicate chain stays as the fallback for a server that sends no mode, and a
 * link always wins, so nothing is ever followed.
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

/** Directory entries that must never be re-joined. */
function usableName(entry) {
  const name = entry !== null && typeof entry === 'object' ? entry.filename : undefined
  if (typeof name !== 'string' || name.length === 0) return null
  if (name === '.' || name === '..' || name.includes('/')) return null
  return name
}

/**
 * Validate the request itself — no filesystem access.
 *
 * @param {unknown} body parsed JSON body
 * @returns {{ ok: true, paths: string[], toDir: string, move: boolean } | { ok: false, code: string, message: string }}
 */
export function parseTransferRequest(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  if (!isPlainRemotePath(source.toDir)) {
    return refuse(TRANSFER_INVALID_CODE, 'A remote POSIX target directory is required.')
  }
  const toDir = canonicalRemotePath(source.toDir)
  const paths = Array.isArray(source.paths) ? source.paths : []
  if (paths.length === 0) return refuse(TRANSFER_INVALID_CODE, 'At least one remote path is required.')
  if (paths.length > TRANSFER_MAX_PATHS) {
    return refuse(TRANSFER_TOO_MANY_CODE, `At most ${TRANSFER_MAX_PATHS} paths can be transferred at once.`)
  }
  const clean = []
  const seen = new Set()
  for (const value of paths) {
    if (!isPlainRemotePath(value)) return refuse(TRANSFER_INVALID_CODE, 'Not a remote POSIX path.')
    const path = canonicalRemotePath(value)
    if (posix.basename(path) === '') return refuse(TRANSFER_INVALID_CODE, 'Cannot transfer that path.')
    if (path === toDir) return refuse(TRANSFER_INVALID_CODE, 'A path cannot be transferred into itself.')
    if (seen.has(path)) continue
    seen.add(path)
    clean.push(path)
  }
  return { ok: true, paths: clean, toDir, move: source.move === true }
}

/**
 * Read the request against the host: the target must be a directory, and no
 * directory may be copied or moved into itself.
 *
 * @returns {Promise<{ ok: true, entries: object[] } | { ok: false, code: string, message: string }>}
 */
async function preflight({ sftp, paths, toDir, invoke, guard }) {
  guard()
  let targetAttrs = null
  try {
    targetAttrs = await invoke(sftp, 'stat', toDir)
  } catch (error) {
    if (isMissing(error)) return refuse(TRANSFER_NOT_DIR_CODE, 'The target directory does not exist.')
    throw error
  }
  if (entryKind(targetAttrs) !== 'dir') return refuse(TRANSFER_NOT_DIR_CODE, 'The target is not a directory.')

  const entries = []
  for (const path of paths) {
    guard()
    let attrs = null
    try {
      attrs = await invoke(sftp, 'lstat', path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    entries.push({ path, name: posix.basename(path), attrs })
  }
  for (const entry of entries) {
    // A link is copied as a link, so only a real directory can swallow the
    // target. Copy and move are both checked: either one would recurse forever.
    if (entry.attrs !== null && entryKind(entry.attrs) === 'dir' && isInside(entry.path, toDir)) {
      return refuse(TRANSFER_INSIDE_SOURCE_CODE, 'The target directory is inside a folder being transferred.')
    }
  }
  return { ok: true, entries }
}

/** Whether anything already sits at the destination, links included. */
async function destinationExists(invoke, sftp, path) {
  try {
    await invoke(sftp, 'lstat', path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Stream one regular file.
 *
 * `pipe` carries the backpressure; both ends are destroyed on any failure, and a
 * half-written destination is unlinked so a failed copy never leaves something
 * that looks complete.
 */
function copyFile({ sftp, source, destination, guard, isCancelled }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let read = null
    let write = null
    const finish = (error) => {
      if (settled) return
      settled = true
      try {
        read?.destroy()
      } catch {
        /* already gone */
      }
      try {
        write?.destroy()
      } catch {
        /* already gone */
      }
      if (error === null || error === undefined) {
        resolve()
        return
      }
      sftp.unlink(destination, () => reject(error))
    }
    try {
      read = sftp.createReadStream(source)
      write = sftp.createWriteStream(destination)
    } catch (error) {
      finish(error)
      return
    }
    read.on('data', () => {
      if (!settled && isCancelled()) finish(coded(TRANSFER_CANCELLED_CODE, 'The transfer was cancelled.'))
    })
    read.on('error', (error) => finish(error))
    write.on('error', (error) => finish(error))
    write.on('close', () => finish(null))
    read.pipe(write)
  })
}

/**
 * Copy one entry, recursing through real directories only.
 *
 * @param {object} input
 * @param {'file'|'dir'|'link'} input.kind already classified by {@link entryKind}
 */
async function copyEntry({ sftp, source, destination, kind, invoke, guard, isCancelled }) {
  guard()
  if (kind === 'link') {
    const target = await invoke(sftp, 'readlink', source)
    guard()
    await invoke(sftp, 'symlink', target, destination)
    return
  }
  if (kind !== 'dir') {
    await copyFile({ sftp, source, destination, guard, isCancelled })
    return
  }
  await invoke(sftp, 'mkdir', destination)
  const entries = await invoke(sftp, 'readdir', source)
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = usableName(entry)
    if (name === null) continue
    const attrs = entry !== null && typeof entry === 'object' ? entry.attrs : undefined
    // `readdir` reports the mode of every entry; a server that sends none gets
    // one `lstat`, which keeps a socket from being streamed as a file.
    const childKind = attrs === undefined || attrs === null
      ? entryKind(await invoke(sftp, 'lstat', posix.join(source, name)))
      : entryKind(attrs)
    if (childKind !== 'file' && childKind !== 'dir' && childKind !== 'link') continue
    await copyEntry({
      sftp,
      source: posix.join(source, name),
      destination: posix.join(destination, name),
      kind: childKind,
      invoke,
      guard,
      isCancelled,
    })
  }
}

/**
 * Copy or move every requested path into `toDir`.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {unknown} input.body the request body
 * @param {() => boolean} [input.isCancelled] asked before every operation
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ ok: true, results: object[] } | { ok: false, code: string, message: string } | { cancelled: true, results: object[] }>}
 */
export async function transferRemotePaths({ sftp, body, isCancelled, call } = {}) {
  const invoke = typeof call === 'function' ? call : sftpCall
  const cancelled = typeof isCancelled === 'function' ? isCancelled : () => false
  const guard = () => {
    if (cancelled()) throw coded(TRANSFER_CANCELLED_CODE, 'The transfer was cancelled.')
  }

  const parsed = parseTransferRequest(body)
  if (parsed.ok !== true) return parsed

  let planned
  try {
    planned = await preflight({ sftp, paths: parsed.paths, toDir: parsed.toDir, invoke, guard })
  } catch (error) {
    if (isCancelledError(error)) return { cancelled: true, results: [] }
    throw error
  }
  if (planned.ok !== true) return planned

  const results = []
  for (const entry of planned.entries) {
    try {
      guard()
      results.push(await transferEntry({ sftp, entry, toDir: parsed.toDir, move: parsed.move, invoke, guard, isCancelled: cancelled }))
    } catch (error) {
      if (isCancelledError(error)) return { cancelled: true, results }
      // Anything unexpected is this entry's failure, never the batch's.
      results.push(failed(entry, 'FAILED', errorText(error)))
    }
  }
  return { ok: true, results }
}

/** One row of the batch. */
async function transferEntry({ sftp, entry, toDir, move, invoke, guard, isCancelled }) {
  if (entry.attrs === null) return failed(entry, 'MISSING', 'No such remote path.')
  const kind = entryKind(entry.attrs)
  if (kind !== 'file' && kind !== 'dir' && kind !== 'link') {
    return failed(entry, 'UNSUPPORTED', 'That kind of entry cannot be copied.')
  }
  const destination = posix.join(toDir, entry.name)
  // Checked before a rename as well: OpenSSH's rename overwrites, and the rule
  // is that an existing entry is reported, never replaced.
  guard()
  if (await destinationExists(invoke, sftp, destination)) {
    return failed(entry, 'EXISTS', 'An entry with that name is already there.')
  }

  if (move) {
    try {
      guard()
      await invoke(sftp, 'rename', entry.path, destination)
      return succeeded(entry)
    } catch (error) {
      if (isMissing(error)) return failed(entry, 'MISSING', 'No such remote path.')
      // Cross-filesystem renames land here too: SFTP reports them as a plain
      // failure, so the copy-then-delete path is the only way to tell.
    }
  }

  try {
    await copyEntry({ sftp, source: entry.path, destination, kind, invoke, guard, isCancelled })
  } catch (error) {
    if (isCancelledError(error)) throw error
    return failed(entry, 'FAILED', errorText(error))
  }
  if (!move) return succeeded(entry)

  try {
    await removeRemoteTree({ sftp, path: entry.path, isCancelled, call: invoke })
  } catch (error) {
    if (isCancelledError(error)) throw error
    if (Boolean(error) && error.code === 'REMOTE_DECK_DELETE_CANCELLED') {
      throw coded(TRANSFER_CANCELLED_CODE, 'The transfer was cancelled.')
    }
    // The copy is safely in place, but leaving the source behind would look
    // like a successful move: report the half-done state instead.
    return failed(entry, 'FAILED', `copied, but the source could not be removed: ${errorText(error)}`)
  }
  return succeeded(entry)
}
