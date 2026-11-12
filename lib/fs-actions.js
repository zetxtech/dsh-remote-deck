/**
 * The file page's three single-name actions: rename, new folder, new file.
 *
 * Rename takes an existing file or directory; new folder and new file take an
 * existing directory. All three share the same path and name rules:
 *
 * - **The path is the file page's path.** `isPlainRemotePath` /
 *   `canonicalRemotePath` from `lib/file-ops.js` decide what an acceptable
 *   remote path is, exactly as copy and move do; nothing is invented here.
 * - **The name is one segment.** No `/`, no NUL, not `.`/`..`, not empty, and
 *   no longer than {@link FS_ACTION_MAX_NAME_BYTES} bytes — the usual POSIX
 *   `NAME_MAX`. It is trimmed first (outer whitespace is an accident, not a
 *   name) and otherwise never rewritten: a bad name is refused so the client
 *   can show it back to the reader.
 * - **Nothing is overwritten.** `rename` on OpenSSH replaces the destination and
 *   `writeFile` always truncates, so existence is checked before the write and
 *   again if the server refuses the operation. The answer is `EXISTS` (409),
 *   never a silent replacement.
 * - **A missing source is `NOT_FOUND` (404)**, decided before any write so the
 *   reply does not depend on how one SFTP server words its status codes.
 *
 * The route in `api.js` owns the HTTP meaning of these outcomes; this module
 * only validates and talks SFTP.
 */
import { posix } from 'node:path'
import { canonicalRemotePath, isPlainRemotePath } from './file-ops.js'
import { sftpCall } from './util.js'

/** The path is not a plain absolute remote POSIX path. */
export const FS_ACTION_INVALID_PATH_CODE = 'NOT_REMOTE_PATH'
/** The name is not a plain single path segment. */
export const FS_ACTION_BAD_NAME_CODE = 'BAD_NAME'
/** The source path does not exist on the remote host. */
export const FS_ACTION_MISSING_CODE = 'NOT_FOUND'
/** An entry with that name is already there. */
export const FS_ACTION_EXISTS_CODE = 'EXISTS'
/** Longest accepted name, in UTF-8 bytes (`NAME_MAX`). */
export const FS_ACTION_MAX_NAME_BYTES = 255

/** SSH_FX_NO_SUCH_FILE, as ssh2 reports it. */
const SFTP_NO_SUCH_FILE = 2
/** `fsError('FS_NOT_FOUND')` from `sftpCall`, and the raw SFTP status code. */
const FS_NOT_FOUND = 'FS_NOT_FOUND'

function refuse(code, message) {
  return { ok: false, code, message }
}

function isMissing(error) {
  return Boolean(error) && (error.code === FS_NOT_FOUND || error.code === SFTP_NO_SUCH_FILE)
}

/**
 * Validate one remote path. `/` itself is accepted: it is a directory the file
 * page can show, so "new folder in /" must work. `renameRemotePath` is the one
 * caller that refuses it later.
 *
 * @param {unknown} value `path` from the request body
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
function parsePath(value) {
  if (!isPlainRemotePath(value)) return refuse(FS_ACTION_INVALID_PATH_CODE, 'A remote POSIX path is required.')
  return { ok: true, path: canonicalRemotePath(value) }
}

/**
 * Validate one new name.
 *
 * The value is trimmed first — trailing whitespace is an accident, not a name —
 * and the trimmed spelling is what the caller gets back. Anything that is not
 * one plain segment is refused rather than repaired.
 *
 * @param {unknown} value `name` from the request body
 * @returns {{ ok: true, name: string } | { ok: false, code: string, message: string }}
 */
function parseName(value) {
  if (typeof value !== 'string') return refuse(FS_ACTION_BAD_NAME_CODE, 'A name is required.')
  const name = value.trim()
  if (name.length === 0) return refuse(FS_ACTION_BAD_NAME_CODE, 'A name cannot be empty.')
  if (name === '.' || name === '..') return refuse(FS_ACTION_BAD_NAME_CODE, 'A name cannot be "." or "..".')
  if (name.includes('/')) return refuse(FS_ACTION_BAD_NAME_CODE, 'A name cannot contain "/".')
  if (name.includes('\u0000')) return refuse(FS_ACTION_BAD_NAME_CODE, 'A name cannot contain a NUL byte.')
  if (Buffer.byteLength(name, 'utf8') > FS_ACTION_MAX_NAME_BYTES) {
    return refuse(FS_ACTION_BAD_NAME_CODE, `A name cannot be longer than ${FS_ACTION_MAX_NAME_BYTES} bytes.`)
  }
  return { ok: true, name }
}

/**
 * Validate the shape of a rename/mkdir/touch request — no filesystem access.
 *
 * @param {unknown} body parsed JSON body
 * @returns {{ ok: true, path: string, name: string } | { ok: false, code: string, message: string }}
 */
export function parseNameRequest(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  const target = parsePath(source.path)
  if (target.ok !== true) return target
  const name = parseName(source.name)
  if (name.ok !== true) return name
  return { ok: true, path: target.path, name: name.name }
}

/** Whether anything at all sits at `path`, links and dangling links included. */
async function pathExists(invoke, sftp, path) {
  try {
    await invoke(sftp, 'lstat', path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Ask for a `lstat`, folding "no such file" into `null`. */
async function lstatOrNull(invoke, sftp, path) {
  try {
    return await invoke(sftp, 'lstat', path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function joinName(directory, name) {
  return posix.join(directory, name)
}

/**
 * Rename one entry inside its own directory.
 *
 * `name` is a single segment, so a rename can never move something to another
 * directory. The source is checked first: a rename that the server reports as
 * missing would otherwise be indistinguishable from any other failure on a
 * server that answers `SSH_FX_FAILURE` for everything.
 *
 * The destination is checked before the rename as well as after a failed one —
 * OpenSSH's rename replaces the destination silently, and the rule is that an
 * existing name is reported, never replaced.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {string} input.path existing absolute remote path (file or directory)
 * @param {string} input.name new single-segment name
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string }>}
 */
export async function renameRemotePath({ sftp, path, name, call } = {}) {
  const parsed = parseNameRequest({ path, name })
  if (parsed.ok !== true) return parsed
  // "/" has no parent to rename inside of; the name contract cannot express it.
  if (posix.basename(parsed.path) === '') {
    return refuse(FS_ACTION_INVALID_PATH_CODE, 'The filesystem root cannot be renamed.')
  }
  const invoke = typeof call === 'function' ? call : sftpCall
  const source = parsed.path
  const destination = joinName(posix.dirname(source), parsed.name)

  const sourceAttrs = await lstatOrNull(invoke, sftp, source)
  if (sourceAttrs === null) return refuse(FS_ACTION_MISSING_CODE, `No such remote path: ${source}`)
  if (await pathExists(invoke, sftp, destination)) {
    return refuse(FS_ACTION_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
  }

  try {
    await invoke(sftp, 'rename', source, destination)
  } catch (error) {
    // The rename may have failed for any reason; a destination that appeared
    // meanwhile is the one outcome the client must not read as "server broken".
    if (await pathExists(invoke, sftp, destination)) {
      return refuse(FS_ACTION_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
    }
    if (isMissing(error)) return refuse(FS_ACTION_MISSING_CODE, `No such remote path: ${source}`)
    throw error
  }
  return { ok: true, path: destination }
}

/**
 * Create one directory named `name` inside `path`.
 *
 * @param {object} input `{ sftp, path, name, call }`, as {@link renameRemotePath}
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string }>}
 */
export async function mkdirRemotePath({ sftp, path, name, call } = {}) {
  const parsed = parseNameRequest({ path, name })
  if (parsed.ok !== true) return parsed
  const invoke = typeof call === 'function' ? call : sftpCall
  const destination = joinName(parsed.path, parsed.name)

  if (await pathExists(invoke, sftp, destination)) {
    return refuse(FS_ACTION_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
  }
  try {
    await invoke(sftp, 'mkdir', destination)
  } catch (error) {
    // A server that cannot tell "already there" from a read-only folder gets
    // the existence check; the code is only EXISTS when something really is.
    if (await pathExists(invoke, sftp, destination)) {
      return refuse(FS_ACTION_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
    }
    // A missing parent is the one expected refusal; it is a 404, not a fault.
    if (isMissing(error)) return refuse(FS_ACTION_MISSING_CODE, `No such remote folder: ${parsed.path}`)
    throw error
  }
  return { ok: true, path: destination }
}

/**
 * Create one empty file named `name` inside `path`.
 *
 * `writeFile` truncates, so the destination is checked before the write: an
 * existing file must answer `EXISTS`, never "silently emptied". The write is a
 * zero-length buffer — no content, no options, so every SFTP server accepts it.
 *
 * @param {object} input `{ sftp, path, name, call }`, as {@link renameRemotePath}
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string }>}
 */
export async function touchRemotePath({ sftp, path, name, call } = {}) {
  const parsed = parseNameRequest({ path, name })
  if (parsed.ok !== true) return parsed
  const invoke = typeof call === 'function' ? call : sftpCall
  const destination = joinName(parsed.path, parsed.name)

  if (await pathExists(invoke, sftp, destination)) {
    return refuse(FS_ACTION_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
  }
  try {
    await invoke(sftp, 'writeFile', destination, Buffer.alloc(0))
  } catch (error) {
    if (isMissing(error)) return refuse(FS_ACTION_MISSING_CODE, `No such remote folder: ${parsed.path}`)
    throw error
  }
  return { ok: true, path: destination }
}