/**
 * Read and write one remote text file, for the plugin's own editor.
 *
 * DSH's built-in file preview is read-only ("Preview, not editing."), so
 * double-clicking a file has to be served here.
 *
 * Decisions worth knowing:
 *
 * - **A read is bounded.** The default window is 2 MiB and nothing reads more
 *   than 8 MiB; a longer file answers with `truncated: true` and the text of the
 *   window it did read, which is what the browser half turns into "too large,
 *   saving disabled".
 * - **Binary is decided by a NUL byte** in the window that was read: such a file
 *   answers without `text` at all. Invalid UTF-8 is never an error — Node's
 *   decoder substitutes U+FFFD, so a stray byte cannot fail the request.
 * - **A write never truncates the original in place.** The content goes to a
 *   sibling temp file first and is then renamed over the target (the same
 *   `replaceRemoteFile` the plugin's `ctx.fs` patch uses, with the OpenSSH
 *   posix-rename extension when the server offers it), so a failed save leaves
 *   the previous content untouched. The temp file is removed either way.
 * - **`expectedMtime` is a conflict check**, not a lock: a mismatch answers
 *   `STALE` with the current mtime and writes nothing.
 * - Cancellation (the client aborted the request) is asked before every
 *   operation and while a read is streaming.
 */
import { posix } from 'node:path'
import { applyEol, canWriteEncoding, decodeText, detectEol, ENCODING_UTF8, encodeText, EOL_LF } from './encoding.js'
import { canonicalRemotePath, entryKind, isPlainRemotePath } from './file-ops.js'
import { replaceRemoteFile } from './routing.js'
import { sftpCall } from './util.js'

/** Window read when the request asks for nothing. */
export const READ_DEFAULT_MAX_BYTES = 8 * 1024 * 1024
/** Hard ceiling for one read, whatever the request asks for. */
export const READ_MAX_BYTES = 32 * 1024 * 1024
/** Largest content one write may carry. */
export const WRITE_MAX_BYTES = 8 * 1024 * 1024

export const EDIT_INVALID_CODE = 'NOT_REMOTE_PATH'
export const EDIT_NOT_FILE_CODE = 'NOT_REGULAR_FILE'
export const EDIT_MISSING_CODE = 'NOT_FOUND'
export const EDIT_TOO_LARGE_CODE = 'TOO_LARGE'
export const EDIT_STALE_CODE = 'STALE'
export const EDIT_CANCELLED_CODE = 'REMOTE_DECK_EDIT_CANCELLED'

const FS_NOT_FOUND = 'FS_NOT_FOUND'
const SFTP_NO_SUCH_FILE = 2

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function refuse(code, message) {
  return { ok: false, code, message }
}

function isMissing(error) {
  return Boolean(error) && (error.code === FS_NOT_FOUND || error.code === SFTP_NO_SUCH_FILE)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The request was cancelled by the client going away. */
export function isEditCancelled(error) {
  return Boolean(error) && error.code === EDIT_CANCELLED_CODE
}

/** ssh2 reports mtime in seconds; the browser half works in milliseconds. */
export function mtimeMsOf(attrs) {
  const seconds = Number(attrs?.mtime)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

/** Size of an attrs record, missing or nonsense values folded to 0. */
function sizeOf(attrs) {
  const size = Number(attrs?.size)
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
}

/**
 * Validate one remote file path.
 *
 * Reuses the file page's rules: absolute POSIX, no `..`, no `//`, and something
 * left to name. The parent is not checked here — a missing directory is a
 * write failure, not a malformed request.
 *
 * @param {unknown} value
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function parseFileTarget(value) {
  if (!isPlainRemotePath(value)) return refuse(EDIT_INVALID_CODE, 'A remote POSIX file path is required.')
  const path = canonicalRemotePath(value)
  if (posix.basename(path) === '') return refuse(EDIT_INVALID_CODE, 'Cannot edit that path.')
  return { ok: true, path }
}

/**
 * The read window: default when absent or nonsense, capped at
 * {@link READ_MAX_BYTES} when larger.
 */
export function parseReadLimit(value) {
  const requested = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return READ_DEFAULT_MAX_BYTES
  return Math.min(READ_MAX_BYTES, Math.floor(requested))
}

/**
 * Validate a write body.
 *
 * @param {unknown} body parsed JSON body
 * @returns {{ ok: true, path: string, content: string, expectedMtime?: number } | { ok: false, code: string, message: string }}
 */
export function parseWriteRequest(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  const target = parseFileTarget(source.path)
  if (target.ok !== true) return target
  if (typeof source.content !== 'string') return refuse(EDIT_INVALID_CODE, 'Content must be a string.')
  if (Buffer.byteLength(source.content, 'utf8') > WRITE_MAX_BYTES) {
    return refuse(EDIT_TOO_LARGE_CODE, `Content is larger than ${Math.round(WRITE_MAX_BYTES / 1024 / 1024)} MB.`)
  }
  const expectedMtime = typeof source.expectedMtime === 'number' && Number.isFinite(source.expectedMtime)
    ? Math.round(source.expectedMtime)
    : undefined
  // The encoding and line ending are optional for compatibility with older
  // callers, which get UTF-8/LF — the behaviour before encodings existed. A
  // client that read a GBK file must name it here or the save would be wrong.
  const encoding = typeof source.encoding === 'string' ? source.encoding.toLowerCase() : ''
  const eol = source.eol === 'crlf' ? 'crlf' : source.eol === 'lf' ? 'lf' : ''
  return {
    ok: true,
    path: target.path,
    content: source.content,
    expectedMtime,
    encoding: encoding.length > 0 ? encoding : undefined,
    eol: eol.length > 0 ? eol : undefined,
  }
}

/** Collect at most `length` bytes from the first `length` bytes of a file. */
function readBytes({ sftp, path, length, guard, isCancelled }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let stream = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try {
        stream?.destroy()
      } catch {
        /* already gone */
      }
      if (error === null || error === undefined) resolve(value)
      else reject(error)
    }
    try {
      stream = sftp.createReadStream(path, { start: 0, end: length - 1 })
    } catch (error) {
      finish(error)
      return
    }
    const chunks = []
    stream.on('data', (chunk) => {
      if (settled) return
      if (isCancelled()) {
        finish(coded(EDIT_CANCELLED_CODE, 'The read was cancelled.'))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    stream.on('error', (error) => finish(error))
    stream.on('end', () => finish(null, Buffer.concat(chunks)))
    stream.on('close', () => finish(null, Buffer.concat(chunks)))
  })
}

/**
 * Read one remote text file.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {unknown} input.path requested remote path
 * @param {unknown} [input.maxBytes] requested window
 * @param {() => boolean} [input.isCancelled] asked before every operation
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ ok: true, file: object } | { ok: false, code: string, message: string }>}
 * @throws a coded `REMOTE_DECK_EDIT_CANCELLED` when the client is gone
 */
export async function readRemoteFile({ sftp, path, maxBytes, encoding, isCancelled, call } = {}) {
  const invoke = typeof call === 'function' ? call : sftpCall
  const cancelled = typeof isCancelled === 'function' ? isCancelled : () => false
  const guard = () => {
    if (cancelled()) throw coded(EDIT_CANCELLED_CODE, 'The read was cancelled.')
  }

  const target = parseFileTarget(path)
  if (target.ok !== true) return target

  guard()
  let attrs
  try {
    // `stat`, so a link to a file is edited through the link, like every editor.
    attrs = await invoke(sftp, 'stat', target.path)
  } catch (error) {
    if (isMissing(error)) return refuse(EDIT_MISSING_CODE, 'No such remote path.')
    throw error
  }
  if (entryKind(attrs) !== 'file') return refuse(EDIT_NOT_FILE_CODE, 'Only a regular file can be read.')

  const size = sizeOf(attrs)
  const mtime = mtimeMsOf(attrs)
  const window = Math.min(size, parseReadLimit(maxBytes))
  const truncated = size > window
  if (window === 0) {
    return {
      ok: true,
      file: {
        path: target.path, size, mtime, text: '', truncated, binary: false,
        encoding: ENCODING_UTF8, exact: true, writable: true, eol: EOL_LF, mixedEol: false,
      },
    }
  }
  guard()
  const buffer = await readBytes({ sftp, path: target.path, length: window, guard, isCancelled: cancelled })
  // A NUL byte in the window is the binary signal; the rest of the file is
  // never inspected, which is what keeps an 8 MiB read bounded.
  if (buffer.includes(0)) return { ok: true, file: { binary: true, size, mtime } }
  const decoded = decodeText(buffer, { encoding: typeof encoding === 'string' && encoding.length > 0 ? encoding : undefined })
  const eol = detectEol(decoded.text)
  // A window that cut the file in half can end mid-character, so an exact
  // decode is only promised for a complete read; a truncated read keeps its
  // encoding but is never writable.
  const writable = decoded.exact === true && truncated !== true && canWriteEncoding(decoded.encoding)
  return {
    ok: true,
    file: {
      path: target.path,
      size,
      mtime,
      text: decoded.text,
      truncated,
      binary: false,
      encoding: decoded.encoding,
      exact: decoded.exact === true,
      writable,
      eol: eol.eol,
      mixedEol: eol.mixed,
    },
  }
}

/**
 * Write one remote text file.
 *
 * @param {object} input
 * @param {object} input.sftp connected SFTP session
 * @param {string} input.path already validated absolute path
 * @param {string} input.content already validated string
 * @param {number} [input.expectedMtime] mtime the editor loaded, in milliseconds
 * @param {string} [input.encoding] the encoding the read reported; UTF-8 by default
 * @param {string} [input.eol] `lf` or `crlf`; the file's own convention wins
 * @param {() => boolean} [input.isCancelled] asked before every operation
 * @param {Function} [input.call] `sftpCall`, injectable for tests
 * @returns {Promise<{ ok: true, file: { size: number, mtime: number } } | { ok: false, code: string, message: string, mtime?: number | null }>}
 * @throws a coded `REMOTE_DECK_EDIT_CANCELLED` when the client is gone
 */
export async function writeRemoteFile({ sftp, path, content, expectedMtime, encoding, eol, isCancelled, call } = {}) {
  const invoke = typeof call === 'function' ? call : sftpCall
  const cancelled = typeof isCancelled === 'function' ? isCancelled : () => false
  const guard = () => {
    if (cancelled()) throw coded(EDIT_CANCELLED_CODE, 'The write was cancelled.')
  }

  guard()
  let current = null
  try {
    current = await invoke(sftp, 'stat', path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (current !== null && entryKind(current) !== 'file') {
    return refuse(EDIT_NOT_FILE_CODE, 'Only a regular file can be written.')
  }
  const mtime = current === null ? null : mtimeMsOf(current)
  if (expectedMtime !== undefined && (current === null || mtime !== expectedMtime)) {
    return {
      ok: false,
      code: EDIT_STALE_CODE,
      message: current === null
        ? 'The file is no longer there.'
        : 'The file changed on the remote host since it was read.',
      mtime,
    }
  }

  // The client must say which encoding it read; guessing here is what turns a
  // GBK file into mojibake.
  const targetEncoding = typeof encoding === 'string' && encoding.length > 0 ? encoding : ENCODING_UTF8
  const encoded = encodeText(applyEol(content, eol), targetEncoding)
  if (encoded.ok !== true) return refuse(encoded.code, encoded.message)
  const buffer = encoded.buffer

  // Saving through a symlink must not replace the link with a regular file: the
  // bytes belong to the target, so resolve it first. `realpath` answers for a
  // live link; a dangling one is resolved by hand, which creates the file it
  // points at instead of clobbering the link.
  let written = path
  try {
    const real = await invoke(sftp, 'realpath', path)
    if (typeof real === 'string' && real.length > 0) written = real
  } catch {
    const link = await invoke(sftp, 'readlink', path).catch(() => null)
    if (typeof link === 'string' && link.length > 0) {
      written = posix.isAbsolute(link) ? link : posix.join(posix.dirname(path), link)
    }
  }

  const temp = posix.join(posix.dirname(written), `.dsh-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  guard()
  await invoke(sftp, 'writeFile', temp, buffer)
  try {
    guard()
    await replaceRemoteFile(sftp, temp, written, buffer)
  } catch (error) {
    if (isEditCancelled(error)) throw error
    throw coded('REMOTE_DECK_EDIT_WRITE_FAILED', errorText(error))
  } finally {
    await invoke(sftp, 'unlink', temp).catch(() => {})
  }

  guard()
  const after = await invoke(sftp, 'stat', written)
  const file = { size: sizeOf(after), mtime: mtimeMsOf(after) }
  if (written !== path) file.wroteThrough = written
  return { ok: true, file }
}
