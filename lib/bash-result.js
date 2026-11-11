/**
 * Helpers for the remote bash tool: working-directory resolution and result
 * rendering. Kept in lib/ so both index.js and the unit tests share one
 * implementation (see docs/DESIGN in the workspace for the contract).
 */
import { isPosixPath, normalizeRemotePath } from './util.js'

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Resolve the effective remote working directory.
 * - omitted -> session workspace
 * - absolute POSIX -> normalized as-is
 * - relative POSIX -> resolved against the session workspace
 * - Windows path / backslashes -> hard error (never guess)
 *
 * @param {unknown} workdir raw tool argument
 * @param {string} sessionPath remote workspace path
 * @returns {{ cwd: string } | { error: string }}
 */
export function resolveWorkdir(workdir, sessionPath) {
  const raw = typeof workdir === 'string' ? workdir.trim() : ''
  if (raw.length === 0) return { cwd: normalizeRemotePath(sessionPath) }
  if (raw.startsWith('~')) {
    return { error: `remote-deck: workdir must be a remote POSIX path, not a home-relative path: ${JSON.stringify(raw)}` }
  }
  if (WINDOWS_PATH.test(raw) || raw.includes('\\')) {
    return { error: `remote-deck: workdir must be a POSIX path on the remote host: ${JSON.stringify(raw)}` }
  }
  if (isPosixPath(raw)) return { cwd: normalizeRemotePath(raw) }
  const base = normalizeRemotePath(sessionPath).replace(/\/+$/, '')
  return { cwd: normalizeRemotePath(`${base}/${raw}`) }
}

/**
 * Render one command result for the model.
 * Explicit markers keep truncation, transport failures and signals
 * distinguishable from a normal non-zero exit code.
 *
 * @param {{
 *   stdout?: string, stderr?: string, code?: number|null, signal?: string|null,
 *   truncatedOut?: boolean, truncatedErr?: boolean, transportError?: string|null,
 * }} result
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ text: string, exitCode: number }}
 */
export function renderBashResult(result, options) {
  const cap = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const parts = []
  if (typeof result.stdout === 'string' && result.stdout.length > 0) parts.push(result.stdout)
  if (typeof result.stderr === 'string' && result.stderr.trim().length > 0) parts.push(`[stderr]\n${result.stderr}`)
  if (result.truncatedOut === true || result.truncatedErr === true) {
    parts.push(`[output truncated; first ${cap} bytes captured]`)
  }
  if (typeof result.transportError === 'string' && result.transportError.length > 0) {
    parts.push(`[transport error: ${result.transportError}]`)
  }
  const code = typeof result.code === 'number' ? result.code : -1
  const transportFailed = typeof result.transportError === 'string' && result.transportError.length > 0
  if (typeof result.signal === 'string' && result.signal.length > 0) {
    parts.push(`[killed by signal: ${result.signal}]`)
  } else if (!transportFailed && code !== 0) {
    parts.push(`[exit code: ${code}]`)
  }
  return { text: parts.filter((part) => part.length > 0).join('\n').trimEnd(), exitCode: code }
}

/**
 * Render an in-flight job read for a promoted foreground call, matching the
 * official bash prompt: output so far, a lossy notice, then the job pointer.
 *
 * @param {{ chunks?: Array<{ text?: string, channel?: string }>, lossy?: boolean }} read
 * @param {string} jobId
 * @param {number} timeoutMs
 * @returns {{ text: string, exitCode: null, jobId: string }}
 */
export function renderPromoted(read, jobId, timeoutMs) {
  const chunks = Array.isArray(read?.chunks) ? read.chunks : []
  let stdout = ''
  let stderr = ''
  for (const chunk of chunks) {
    const value = typeof chunk?.text === 'string' ? chunk.text : ''
    if (chunk?.channel === 'stderr') stderr += value
    else stdout += value
  }
  const parts = []
  if (stdout.length > 0) parts.push(stdout)
  if (stderr.trim().length > 0) parts.push(`[stderr]\n${stderr}`)
  if (read?.lossy === true) parts.push('[some output was dropped from memory; continue with job_output]')
  parts.push(`[still running after ${timeoutMs}ms; moved to background job ${jobId}; use job_output to read output, job_kill to stop]`)
  return { text: parts.filter((part) => part.length > 0).join('\n').trimEnd(), exitCode: null, jobId }
}
