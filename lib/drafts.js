/**
 * Editor drafts, kept on disk so an unsaved buffer survives a closed tab — or a
 * closed DSH.
 *
 * One JSON file per (connection, path), named after the sha256 of both, inside
 * `<data dir>/drafts/`. The content is the whole buffer, so a draft is written
 * once, atomically: a temp file in the same directory is renamed over the target
 * and is removed again if anything fails, which is what keeps a crash from
 * leaving half a draft behind.
 *
 * Drafts are not a version history: saving the same path again replaces the
 * file, and a draft is only meant to be read back by the tab that lost it.
 *
 * Nothing here expires on a timer. `sweep()` runs whenever a draft route is
 * used, which is the only moment the directory matters, and it drops two kinds
 * of garbage: drafts whose `savedAt` is older than {@link DRAFT_MAX_AGE_MS}, and
 * orphan temp files from a process that died mid-write. A draft's file mtime is
 * its `savedAt` (the file is written once), so a fresh file needs no read at all
 * and only a stale one is parsed to confirm.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { canonicalRemotePath, isPlainRemotePath } from './file-ops.js'

/** Largest draft one request may carry. */
export const DRAFT_MAX_BYTES = 8 * 1024 * 1024
/** How long an untouched draft is kept. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** A temp file older than this can only be an orphan of a dead process. */
export const DRAFT_TEMP_MAX_AGE_MS = 60 * 60 * 1000
/** Directory name under the plugin's data directory. */
export const DRAFT_DIR_NAME = 'drafts'
/** Longest connection id kept in a draft record. */
const MAX_CONNECTION_ID = 128

export const DRAFT_INVALID_CODE = 'NOT_REMOTE_PATH'
export const DRAFT_NOT_TEXT_CODE = 'NOT_TEXT'
export const DRAFT_TOO_LARGE_CODE = 'TOO_LARGE'

function refuse(code, message) {
  return { ok: false, code, message }
}

/** The file one draft lives in: stable, and free of path separators. */
export function draftFileName(connectionId, path) {
  const digest = createHash('sha256').update(`${connectionId}\u0000${path}`).digest('hex')
  return `${digest.slice(0, 32)}.json`
}

/**
 * Validate the path a draft is filed under.
 *
 * The same rules as the editor's read/write: absolute POSIX, no `..`, no `//`,
 * something left to name.
 *
 * @param {unknown} value
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function parseDraftPath(value) {
  if (!isPlainRemotePath(value)) return refuse(DRAFT_INVALID_CODE, 'A remote POSIX file path is required.')
  const path = canonicalRemotePath(value)
  if (posix.basename(path) === '') return refuse(DRAFT_INVALID_CODE, 'Cannot keep a draft for that path.')
  return { ok: true, path }
}

/**
 * Validate a draft write.
 *
 * @param {unknown} body parsed JSON body
 * @returns {{ ok: true, draft: { connectionId: string, path: string, content: string, baseMtime: number | null } } | { ok: false, code: string, message: string }}
 */
export function parseDraftWrite(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  const target = parseDraftPath(source.path)
  if (target.ok !== true) return target
  if (typeof source.connectionId === 'string' && source.connectionId.length > MAX_CONNECTION_ID) {
    return refuse(DRAFT_INVALID_CODE, 'That connection id is not addressable.')
  }
  if (typeof source.content !== 'string') return refuse(DRAFT_NOT_TEXT_CODE, 'Content must be a string.')
  if (Buffer.byteLength(source.content, 'utf8') > DRAFT_MAX_BYTES) {
    return refuse(DRAFT_TOO_LARGE_CODE, `A draft is limited to ${Math.round(DRAFT_MAX_BYTES / 1024 / 1024)} MB.`)
  }
  const baseMtime = typeof source.baseMtime === 'number' && Number.isFinite(source.baseMtime)
    ? Math.round(source.baseMtime)
    : null
  return {
    ok: true,
    draft: {
      connectionId: typeof source.connectionId === 'string' ? source.connectionId : '',
      path: target.path,
      content: source.content,
      baseMtime,
    },
  }
}

/** Read one draft file, or null when it is missing or unreadable. */
function readDraftFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.path !== 'string' || typeof parsed.content !== 'string') return null
    return {
      connectionId: typeof parsed.connectionId === 'string' ? parsed.connectionId : '',
      path: parsed.path,
      content: parsed.content,
      baseMtime: typeof parsed.baseMtime === 'number' && Number.isFinite(parsed.baseMtime) ? parsed.baseMtime : null,
      savedAt: Number.isFinite(Number(parsed.savedAt)) ? Number(parsed.savedAt) : 0,
    }
  } catch {
    return null
  }
}

/**
 * The draft directory, resolved once per API server.
 *
 * A store without a directory (no data dir configured) is simply unavailable:
 * every route answers 500 rather than pretending a draft was kept.
 */
export class DraftStore {
  #dir
  #now

  /**
   * @param {object} options
   * @param {string | null} options.dir absolute path of the drafts directory
   * @param {() => number} [options.now] clock, injectable for tests
   */
  constructor({ dir, now = () => Date.now() }) {
    this.#dir = typeof dir === 'string' && dir.length > 0 ? dir : null
    this.#now = now
  }

  get available() {
    return this.#dir !== null
  }

  get dir() {
    return this.#dir
  }

  #file(connectionId, path) {
    return join(this.#dir, draftFileName(connectionId, path))
  }

  #ensureDir() {
    mkdirSync(this.#dir, { recursive: true })
  }

  /**
   * Drop what has aged out: drafts past their keep-by date, and temp files an
   * interrupted write left behind. Safe to call on every request.
   *
   * @returns {{ expired: number, orphans: number }}
   */
  sweep() {
    const result = { expired: 0, orphans: 0 }
    if (this.#dir === null || !existsSync(this.#dir)) return result
    const now = this.#now()
    let entries
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = join(this.#dir, entry.name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (entry.name.endsWith('.json')) {
        if (now - stat.mtimeMs <= DRAFT_MAX_AGE_MS) continue
        const draft = readDraftFile(file)
        // An unreadable file is left alone: it is not this sweep's business.
        if (draft === null) continue
        if (now - draft.savedAt > DRAFT_MAX_AGE_MS) {
          try {
            unlinkSync(file)
            result.expired += 1
          } catch {
            /* something else removed it; nothing to do */
          }
        }
        continue
      }
      if (entry.name.includes('.tmp-') && now - stat.mtimeMs > DRAFT_TEMP_MAX_AGE_MS) {
        try {
          unlinkSync(file)
          result.orphans += 1
        } catch {
          /* already gone */
        }
      }
    }
    return result
  }

  /**
   * Keep the newest buffer for one path. Writes a temp file and renames it into
   * place, so a reader never sees half a draft.
   */
  save({ connectionId, path, content, baseMtime }) {
    const savedAt = this.#now()
    const file = this.#file(connectionId, path)
    const temp = `${file}.tmp-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`
    const payload = JSON.stringify({ connectionId, path, content, baseMtime, savedAt })
    this.#ensureDir()
    try {
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* the temp file was never created, or is already gone */
      }
      throw error
    }
    return { savedAt }
  }

  /** The newest draft for one path, or null when there is none. */
  read({ connectionId, path }) {
    if (this.#dir === null) return null
    const draft = readDraftFile(this.#file(connectionId, path))
    if (draft === null) return null
    return { path: draft.path, content: draft.content, baseMtime: draft.baseMtime, savedAt: draft.savedAt }
  }

  /** Drop one draft. Removing what is not there is a success. */
  remove({ connectionId, path }) {
    if (this.#dir === null) return false
    try {
      unlinkSync(this.#file(connectionId, path))
      return true
    } catch {
      return false
    }
  }

  /** Metadata of every draft, newest first. The content stays on disk. */
  list() {
    if (this.#dir === null || !existsSync(this.#dir)) return []
    const rows = []
    let entries
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const draft = readDraftFile(join(this.#dir, entry.name))
      if (draft === null) continue
      rows.push({
        connectionId: draft.connectionId,
        path: draft.path,
        savedAt: draft.savedAt,
        bytes: Buffer.byteLength(draft.content, 'utf8'),
      })
    }
    return rows.sort((a, b) => b.savedAt - a.savedAt)
  }

  /** Drop every draft, temp files included. */
  clear() {
    if (this.#dir === null || !existsSync(this.#dir)) return 0
    let removed = 0
    let entries
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.json') && !entry.name.includes('.tmp-')) continue
      try {
        unlinkSync(join(this.#dir, entry.name))
        if (entry.name.endsWith('.json')) removed += 1
      } catch {
        /* already gone */
      }
    }
    return removed
  }
}
