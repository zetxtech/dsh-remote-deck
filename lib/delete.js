/**
 * Recursive remote deletion over SFTP, built for a request the client can cancel.
 *
 * The browser half deletes one path at a time, and its task bar can walk away
 * mid-way by aborting the HTTP request. Three properties matter here:
 *
 * - **No symlink is ever followed.** `lstat` settles the type, a symlink is
 *   unlinked as an entry, and only a real directory is read and descended into.
 *   A link to `/`, to an ancestor or to another tree therefore removes the link.
 * - **Cancellation is checked before every operation**, so a cancelled delete
 *   stops within one SFTP round trip. Counters collected so far are kept.
 * - **A partial delete reports what it already removed**: the caller's counters
 *   object is mutated as it goes, so the counts are available with the error.
 *
 * The route owns the meaning of "gone" (see the delete handler in `api.js`);
 * this module only asks `isCancelled()` / `signal.aborted` and never writes a
 * response.
 */
import { posix } from 'node:path'
import { normalizeRemotePath, sftpCall } from './util.js'

/** The path is not a plain absolute remote POSIX path. */
export const DELETE_INVALID_CODE = 'NOT_REMOTE_PATH'
/** The path is a protected root (the filesystem root, or a workspace root without `force`). */
export const DELETE_ROOT_CODE = 'REMOTE_DECK_DELETE_ROOT'
/** The path does not exist on the remote host. */
export const DELETE_MISSING_CODE = 'REMOTE_DECK_DELETE_MISSING'
/** The request went away; nothing is written back. */
export const DELETE_CANCELLED_CODE = 'REMOTE_DECK_DELETE_CANCELLED'

/** SSH_FX_NO_SUCH_FILE, as ssh2 reports it. */
const SFTP_NO_SUCH_FILE = 2
/** `fsError('FS_NOT_FOUND')` from `sftpCall`, and the raw SFTP status code. */
const FS_NOT_FOUND = 'FS_NOT_FOUND'

/**
 * The one spelling of a remote path this module compares and deletes: normal
 * POSIX, no trailing slash. Without it `/data/ws/` would not compare equal to a
 * registered `/data/ws` and the workspace-root guard could be stepped around.
 */
function canonicalPath(value) {
  const normalized = normalizeRemotePath(value)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** A fresh `{ files, dirs, bytes }` tally. */
export function emptyDeleteCounts() {
  return { files: 0, dirs: 0, bytes: 0 }
}

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** The delete was cancelled by the client going away. */
export function isDeleteCancelled(error) {
  return Boolean(error) && error.code === DELETE_CANCELLED_CODE
}

/** The path (or the whole tree) was not there to begin with. */
export function isDeleteMissing(error) {
  return Boolean(error) && error.code === DELETE_MISSING_CODE
}

function isMissing(error) {
  return Boolean(error) && (error.code === FS_NOT_FOUND || error.code === SFTP_NO_SUCH_FILE)
}

/**
 * Validate the requested target.
 *
 * Only a plain absolute POSIX path survives: empty, relative, UNC-style (`//`)
 * and traversal spellings are rejected rather than normalized away, so a client
 * cannot smuggle a different location past the confirmation box. The filesystem
 * root is refused outright — no `force` can make that sensible.
 *
 * @param {unknown} value `path` from the request body
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function parseDeleteTarget(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, code: DELETE_INVALID_CODE, message: 'A remote POSIX path is required.' }
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return { ok: false, code: DELETE_INVALID_CODE, message: 'Not a remote POSIX path.' }
  }
  if (value.split('/').includes('..')) {
    return { ok: false, code: DELETE_INVALID_CODE, message: 'A delete path cannot contain "..".' }
  }
  const path = canonicalPath(value)
  if (path === '/' || path.length === 0) {
    return { ok: false, code: DELETE_ROOT_CODE, message: 'The filesystem root cannot be deleted.' }
  }
  return { ok: true, path }
}

/**
 * Whether deleting this path needs an explicit `force` from the client.
 *
 * Exactly a workspace root counts: deleting the registered folder itself is the
 * one operation a mis-click can turn into "my whole remote project is gone", and
 * the browser half asks a second time for it. Paths below a root are ordinary.
 *
 * @param {string} path validated absolute path
 * @param {readonly string[]} [workspaceRoots] registered roots of the connection
 * @returns {boolean}
 */
export function isProtectedDeleteRoot(path, workspaceRoots) {
  if (typeof path !== 'string' || path.length === 0) return false
  const target = canonicalPath(path)
  if (target === '/') return true
  if (!Array.isArray(workspaceRoots)) return false
  return workspaceRoots.some((root) => typeof root === 'string' && root.length > 0 && canonicalPath(root) === target)
}

/** Directory entries that must never be re-joined or deleted. */
function usableName(entry) {
  const name = entry !== null && typeof entry === 'object' ? entry.filename : undefined
  if (typeof name !== 'string' || name.length === 0) return null
  if (name === '.' || name === '..') return null
  if (name.includes('/')) return null
  return name
}

function attrsOf(value) {
  const attrs = value !== null && typeof value === 'object' ? value : {}
  return {
    directory: typeof attrs.isDirectory === 'function' && attrs.isDirectory() === true,
    link: typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink() === true,
    size: Number.isFinite(attrs.size) && attrs.size > 0 ? Math.floor(attrs.size) : 0,
  }
}

/**
 * Walk and remove one tree.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {string} input.path absolute remote path
 * @param {{ files: number, dirs: number, bytes: number }} [input.counts] tally, mutated as it goes
 * @param {AbortSignal} [input.signal] cancellation
 * @param {() => boolean} [input.isCancelled] extra cancellation check, asked before every operation
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ files: number, dirs: number, bytes: number }>}
 * @throws an error coded `REMOTE_DECK_DELETE_MISSING` for an absent root, \
 *   `REMOTE_DECK_DELETE_CANCELLED` once cancelled, or the failing SFTP error — \
 *   with `counts` already holding what was removed.
 */
export async function removeRemoteTree({ sftp, path, counts, signal, isCancelled, call } = {}) {
  const tally = counts !== undefined && counts !== null && typeof counts === 'object' ? counts : emptyDeleteCounts()
  const invoke = typeof call === 'function' ? call : sftpCall
  const cancelled = () => (typeof isCancelled === 'function' && isCancelled() === true)
    || (signal !== undefined && signal !== null && signal.aborted === true)
  const guard = () => {
    if (cancelled()) throw coded(DELETE_CANCELLED_CODE, 'The delete was cancelled.')
  }

  /**
   * @param {string} target
   * @param {boolean} tolerateMissing a child that vanished mid-walk is already gone
   */
  const remove = async (target, tolerateMissing) => {
    guard()
    let attrs
    try {
      attrs = attrsOf(await invoke(sftp, 'lstat', target))
    } catch (error) {
      if (isMissing(error)) {
        if (tolerateMissing) return
        throw coded(DELETE_MISSING_CODE, `No such remote path: ${target}`)
      }
      throw error
    }
    // A symlink is an entry, never a subtree: `lstat` reports the link itself,
    // so this branch unlinks it and never reads what it points at.
    if (!attrs.directory || attrs.link) {
      guard()
      await invoke(sftp, 'unlink', target)
      tally.files += 1
      tally.bytes += attrs.size
      return
    }
    guard()
    const entries = await invoke(sftp, 'readdir', target)
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = usableName(entry)
      if (name === null) continue
      await remove(posix.join(target, name), true)
    }
    guard()
    await invoke(sftp, 'rmdir', target)
    tally.dirs += 1
  }

  await remove(path, false)
  return tally
}
