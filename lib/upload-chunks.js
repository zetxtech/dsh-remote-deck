/**
 * Resumable uploads: the file page sends files larger than 8 MiB in 4 MiB
 * parts, so a connection that drops mid-transfer can continue at the last byte
 * the remote host actually has.
 *
 * The parts of one file collect in a temporary sibling of the destination:
 * `<dir>/.dsh-part-<first 12 hex chars of sha1(name)>`. The name is hashed so a
 * part file can never collide with the user's own `.dsh-part-*` file, and the
 * directory keeps two same-named files in different folders apart. The
 * protocol is the four routes in `lib/api.js`:
 *
 * - `status` only `stat`s the temporary file (`received` bytes, 0 when absent).
 * - `part` writes one chunk at `offset`. Offset 0 recreates the file (a resumed
 *   upload may start over); every other offset must equal the current size or
 *   the request is refused with `OFFSET_MISMATCH` and the real byte count. A
 *   failed write leaves whatever the server accepted, and the next `status`
 *   tells the client where to continue — nothing here can create a hole.
 * - `commit` renames the temporary file onto the destination. An existing
 *   destination is `EXISTS`, never a silent replacement (OpenSSH's rename would
 *   replace it), and a missing temporary file is `NOT_FOUND`.
 * - `abort` deletes the temporary file and is idempotent.
 *
 * Path and name rules are the file page's own (`lib/fs-actions.js`), so a
 * chunked upload accepts exactly what `rename`/`mkdir`/`touch` accept.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { entryKind } from './file-ops.js'
import { parseNameRequest } from './fs-actions.js'
import { sftpCall } from './util.js'

/** Largest part the `part` route accepts, in bytes. */
export const UPLOAD_PART_MAX_BYTES = 8 * 1024 * 1024
/** The temporary file's prefix inside the destination directory. */
export const UPLOAD_TEMP_PREFIX = '.dsh-part-'
/** How much of the name's SHA-1 the temporary file name carries. */
export const UPLOAD_TEMP_HASH_LENGTH = 12
/** No part carried any bytes. */
export const UPLOAD_EMPTY_PART_CODE = 'EMPTY_PART'
/** The part is larger than {@link UPLOAD_PART_MAX_BYTES}. */
export const UPLOAD_PART_TOO_LARGE_CODE = 'PART_TOO_LARGE'
/** `offset` was not a finite, non-negative integer. */
export const UPLOAD_BAD_OFFSET_CODE = 'BAD_OFFSET'
/** The remote temporary file is not where the client said it is. */
export const UPLOAD_OFFSET_MISMATCH_CODE = 'OFFSET_MISMATCH'
/** Something with the destination name is already there. */
export const UPLOAD_EXISTS_CODE = 'EXISTS'
/** The temporary file the commit/abort named is gone. */
export const UPLOAD_MISSING_CODE = 'NOT_FOUND'

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
 * The temporary file one destination collects its parts in.
 *
 * @param {string} directory absolute remote POSIX directory
 * @param {string} name one remote file name (only its hash reaches the path)
 * @returns {string} absolute remote POSIX path
 */
export function uploadTempPath(directory, name) {
  const hash = createHash('sha1').update(String(name)).digest('hex').slice(0, UPLOAD_TEMP_HASH_LENGTH)
  return posix.join(directory, UPLOAD_TEMP_PREFIX + hash)
}

/**
 * Validate the `path` + `name` a status/part/commit/abort request names.
 *
 * @param {{ path?: unknown, name?: unknown }} value
 * @returns {{ ok: true, dir: string, name: string, target: string, temp: string }
 *   | { ok: false, code: string, message: string }}
 */
export function parseUploadTarget(value) {
  const parsed = parseNameRequest(value)
  if (parsed.ok !== true) return parsed
  return {
    ok: true,
    dir: parsed.path,
    name: parsed.name,
    target: posix.join(parsed.path, parsed.name),
    temp: uploadTempPath(parsed.path, parsed.name),
  }
}

/**
 * Parse the `offset` query parameter. Query strings reach the route as text, so
 * a run of digits is the only spelling accepted; a number (the module's own
 * tests) must be a non-negative safe integer.
 *
 * @param {unknown} value
 * @returns {{ ok: true, offset: number } | { ok: false, code: string, message: string }}
 */
export function parseUploadOffset(value) {
  let number = null
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && /^[0-9]+$/.test(value)) number = Number(value)
  if (number === null || Number.isSafeInteger(number) !== true || number < 0) {
    return refuse(UPLOAD_BAD_OFFSET_CODE, 'offset must be a non-negative integer.')
  }
  return { ok: true, offset: number }
}

function partBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

/** Ask for a `stat`, folding "no such file" into `null`. */
async function statOrNull(invoke, sftp, path) {
  try {
    return await invoke(sftp, 'stat', path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
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

/** The size `stat` reports, or 0 for a server that omits it. */
function sizeOf(attrs) {
  const size = Number(attrs && attrs.size)
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
}

/**
 * How much of one file the remote already has.
 *
 * Read-only: a status for a file that was never started does not create the
 * temporary file.
 *
 * @param {object} input `{ sftp, dir, name, call }`, `call` injectable for tests
 * @returns {Promise<{ ok: true, exists: boolean, received: number }
 *   | { ok: false, code: string, message: string }>}
 */
export async function readUploadStatus({ sftp, dir, name, call } = {}) {
  const parsed = parseUploadTarget({ path: dir, name })
  if (parsed.ok !== true) return parsed
  const invoke = typeof call === 'function' ? call : sftpCall
  const attrs = await statOrNull(invoke, sftp, parsed.temp)
  if (attrs === null) return { ok: true, exists: false, received: 0 }
  return { ok: true, exists: true, received: sizeOf(attrs) }
}

/**
 * Write one part at `offset` of the file's temporary file.
 *
 * The current size is read first, so an offset that does not line up with the
 * remote's file is refused before anything is written — the client's answer is
 * always the byte count it should continue from. `offset === 0` recreates the
 * temporary file (an explicit restart), every other offset appends.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {string} input.dir absolute remote POSIX directory
 * @param {string} input.name destination file name
 * @param {number|string} input.offset byte offset to write the chunk at
 * @param {Uint8Array|ArrayBuffer} input.data raw chunk bytes
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ ok: true, received: number }
 *   | { ok: false, code: string, message: string, received?: number }>}
 */
export async function writeUploadPart({ sftp, dir, name, offset, data, call } = {}) {
  const parsed = parseUploadTarget({ path: dir, name })
  if (parsed.ok !== true) return parsed
  const position = parseUploadOffset(offset)
  if (position.ok !== true) return position
  const bytes = partBytes(data)
  if (bytes === null) return refuse(UPLOAD_EMPTY_PART_CODE, 'A part body is required.')
  if (bytes.length === 0) return refuse(UPLOAD_EMPTY_PART_CODE, 'A part cannot be empty.')
  if (bytes.length > UPLOAD_PART_MAX_BYTES) {
    return refuse(UPLOAD_PART_TOO_LARGE_CODE, `A part cannot be larger than ${UPLOAD_PART_MAX_BYTES} bytes.`)
  }
  const invoke = typeof call === 'function' ? call : sftpCall
  const attrs = await statOrNull(invoke, sftp, parsed.temp)
  const current = attrs === null ? 0 : sizeOf(attrs)
  if (position.offset !== 0 && position.offset !== current) {
    return {
      ok: false,
      code: UPLOAD_OFFSET_MISMATCH_CODE,
      received: current,
      message: `The remote has ${current} bytes; a part at ${position.offset} would leave a hole.`,
    }
  }
  // `w` truncates and creates, `r+` keeps what is there and writes at a
  // position. The stat above chose which one is correct.
  const flags = position.offset === 0 ? 'w' : 'r+'
  let handle
  try {
    handle = await invoke(sftp, 'open', parsed.temp, flags, 0o600)
  } catch (error) {
    if (isMissing(error)) {
      // A missing parent directory is a real refusal: nothing could have been
      // written, and no offset is right.
      if (position.offset === 0) return refuse(UPLOAD_MISSING_CODE, 'The remote folder no longer exists.')
      // Otherwise the temporary file vanished between the stat and the open:
      // the client is as far behind as an empty file, and the answer says so.
      return {
        ok: false,
        code: UPLOAD_OFFSET_MISMATCH_CODE,
        received: 0,
        message: 'The remote temporary file is gone; start from 0.',
      }
    }
    throw error
  }
  try {
    await invoke(sftp, 'write', handle, bytes, 0, bytes.length, position.offset)
  } finally {
    // A handle left open leaks an SFTP slot on the host; the write error is the
    // one worth reporting, so a failing close stays silent.
    await invoke(sftp, 'close', handle).catch(() => {})
  }
  return { ok: true, received: position.offset + bytes.length }
}

/**
 * Rename the temporary file onto the destination.
 *
 * The destination is checked before the rename and again when the server
 * refuses it, because OpenSSH's rename replaces silently and the rule here is
 * that an existing name is reported, never replaced.
 *
 * @param {object} input `{ sftp, dir, name, call }`, as {@link readUploadStatus}
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string }>}
 */
export async function commitUpload({ sftp, dir, name, overwrite, call } = {}) {
  const parsed = parseUploadTarget({ path: dir, name })
  if (parsed.ok !== true) return parsed
  const invoke = typeof call === 'function' ? call : sftpCall
  if (await pathExists(invoke, sftp, parsed.target)) {
    // Never replace something unless the caller said so: the client asks the
    // reader first and only then re-sends with `overwrite`.
    if (overwrite !== true) {
      return refuse(UPLOAD_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
    }
    let existing = null
    try {
      existing = await invoke(sftp, 'lstat', parsed.target)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (existing !== null && entryKind(existing) !== 'file') {
      return refuse(UPLOAD_EXISTS_CODE, `"${parsed.name}" is not a regular file; it will not be replaced.`)
    }
    try {
      await invoke(sftp, 'unlink', parsed.target)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  if ((await pathExists(invoke, sftp, parsed.temp)) !== true) {
    return refuse(UPLOAD_MISSING_CODE, 'The temporary upload file is not there any more.')
  }
  try {
    await invoke(sftp, 'rename', parsed.temp, parsed.target)
  } catch (error) {
    // The rename may have failed for any reason; a destination that appeared
    // meanwhile is the one outcome the client must not read as "server broken".
    if (await pathExists(invoke, sftp, parsed.target)) {
      return refuse(UPLOAD_EXISTS_CODE, `An entry named "${parsed.name}" is already there.`)
    }
    if (isMissing(error)) return refuse(UPLOAD_MISSING_CODE, 'The temporary upload file is not there any more.')
    throw error
  }
  return { ok: true, path: parsed.target }
}

/**
 * Delete the temporary file. Idempotent: aborting an upload that never started,
 * or one that was already committed, still answers `ok`.
 *
 * @param {object} input `{ sftp, dir, name, call }`, as {@link readUploadStatus}
 * @returns {Promise<{ ok: true }>}
 */
export async function abortUpload({ sftp, dir, name, call } = {}) {
  const parsed = parseUploadTarget({ path: dir, name })
  if (parsed.ok !== true) return parsed
  const invoke = typeof call === 'function' ? call : sftpCall
  try {
    await invoke(sftp, 'unlink', parsed.temp)
  } catch (error) {
    if (isMissing(error) !== true) throw error
  }
  return { ok: true }
}
