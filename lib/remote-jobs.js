/**
 * Remote background jobs.
 *
 * A job is a small shell script staged under
 * "$TMPDIR/dsh-remote-deck-jobs/<id>" and launched detached — setsid where it
 * exists, nohup otherwise — so it outlives the SSH exec channel that started
 * it. The command's output accumulates in out.log and its exit code lands in
 * exit; both are read back over SFTP. Nothing here polls on its own: the host
 * half drives refresh()/refreshAll(), every job that leaves "running" reports
 * exactly once through onSettle(), and closeAll() only stops tracking — it
 * never kills a remote process.
 */
import { randomUUID } from 'node:crypto'
import {
  ensureRemoteDir,
  errorText,
  fsError,
  shellQuote,
  sftpCall,
  statusSftpError,
} from './util.js'

const JOBS_DIR = 'dsh-remote-deck-jobs'
const RUN_SCRIPT = 'run.sh'
const LOG_FILE = 'out.log'
const EXIT_FILE = 'exit'
const CONTROL_MAX_BYTES = 8 * 1024
const DEFAULT_READ_BYTES = 128 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
const KILL_TIMEOUT_MS = 2000
const KILL_POLL_MS = 100

/**
 * The script that actually runs the job. It is written verbatim to
 * <dir>/run.sh; the shell, not SFTP, decides the exit code so a missing cd
 * target never becomes a job failure.
 */
export function buildRunScript({ command, cwd, dir }) {
  const target = typeof cwd === 'string' && cwd.length > 0 ? cwd : '~'
  const exitPath = `${shellQuote(dir)}/${EXIT_FILE}`
  return [
    '#!/bin/bash',
    `cd ${shellQuote(target)} 2>/dev/null || cd ~`,
    // The command runs in a subshell: an `exit` of its own — common in
    // submission and wrapper scripts — must end the subshell, never this
    // wrapper, or everything below is skipped and the job loses its status.
    '(',
    String(command ?? ''),
    ')',
    'status=$?',
    // Publish the code atomically: a reader must never see a half-written exit
    // file, where "not written yet" and "process already gone" look identical.
    `printf '%s\\n' "$status" > ${exitPath}.tmp && mv -f ${exitPath}.tmp ${exitPath}`,
    'exit "$status"',
    '',
  ].join('\n')
}

/**
 * The one command that detaches run.sh and echoes the handles the manager
 * needs afterwards: the pid (also the process group id under setsid) and
 * whether the whole group can be signalled at once.
 */
export function buildLaunchCommand({ dir }) {
  const quoted = shellQuote(dir)
  return [
    `if command -v setsid >/dev/null 2>&1; then setsid bash ${quoted}/${RUN_SCRIPT} >${quoted}/${LOG_FILE} 2>&1 </dev/null & grouped=1; else nohup bash ${quoted}/${RUN_SCRIPT} >${quoted}/${LOG_FILE} 2>&1 </dev/null & grouped=0; fi`,
    'echo "pid=$!"',
    'echo "grouped=$grouped"',
  ].join('\n')
}

/** Read the exit file's content; anything that is not a single integer is unknown. */
export function parseExitCode(text) {
  const match = /^\s*(-?\d+)\s*$/.exec(String(text ?? ''))
  if (match === null) return null
  const code = Number(match[1])
  return Number.isSafeInteger(code) ? code : null
}

/**
 * Decide a job's status from the evidence available. An exit code wins over a
 * liveness probe, but a kill we requested and that took the process down is
 * reported as killed even though the shell could not write a meaningful code.
 */
export function classifyStatus({ exitCode, killRequested, alive }) {
  const code = typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null
  if (code === null) {
    if (alive === true) return 'running'
    return killRequested === true ? 'killed' : 'failed'
  }
  if (killRequested === true) return 'killed'
  return code === 0 ? 'exited' : 'failed'
}

export class RemoteJobManager {
  constructor({ hostFor, secrets, onLog, onSettle }) {
    this.hostFor = hostFor
    this.secrets = secrets
    this.onLog = typeof onLog === 'function' ? onLog : () => {}
    this.onSettle = typeof onSettle === 'function' ? onSettle : () => {}
    this.jobs = new Map()
  }

  #log(...args) {
    try {
      this.onLog(...args)
    } catch {
      /* logging must never break a job */
    }
  }

  #view(record) {
    return {
      id: record.id,
      connectionId: record.connectionId,
      host: record.host,
      pid: record.pid,
      command: record.command,
      label: record.label,
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      bytes: record.bytes,
      dir: record.dir,
    }
  }

  #record(id) {
    const key = String(id)
    const record = this.jobs.get(key)
    if (record === undefined) {
      throw fsError('REMOTE_DECK_JOB_NOT_FOUND', `no background job with id ${JSON.stringify(key)}`)
    }
    return record
  }

  async #connect(record) {
    const host = this.hostFor(record.connectionId)
    if (host === undefined) {
      throw fsError('REMOTE_DECK_JOB_NO_HOST', `Connection ${record.connectionId} no longer exists.`)
    }
    await host.connect(this.secrets)
    return host
  }

  /** Move a job out of "running" exactly once and announce it. */
  #finish(record, status, exitCode) {
    if (record.status !== 'running' || record.settled === true) return false
    record.status = status
    record.exitCode = exitCode
    record.finishedAt = Date.now()
    record.settled = true
    this.#log('job settle', record.id, status, exitCode)
    const view = this.#view(record)
    try {
      this.onSettle(view)
    } catch (error) {
      this.#log('job settle hook failed', record.id, errorText(error))
    }
    return true
  }

  /** { present, code } — the exit file is the only proof of a real exit status. */
  async #readExit(host, record) {
    const path = `${record.dir}/${EXIT_FILE}`
    try {
      await sftpCall(host.requireSftp(), 'stat', path)
    } catch (error) {
      if (isNotFound(error)) return { present: false, code: null }
      throw error
    }
    try {
      const data = await sftpCall(host.requireSftp(), 'readFile', path)
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '')
      return { present: true, code: parseExitCode(text) }
    } catch (error) {
      if (isNotFound(error)) return { present: false, code: null }
      throw error
    }
  }

  async #exitPresent(host, record) {
    try {
      return (await this.#readExit(host, record)).present
    } catch {
      return false
    }
  }

  /** Keep jobView.bytes in step with the log; the log is cosmetic, never fatal. */
  async #statBytes(host, record) {
    try {
      const attrs = await sftpCall(host.requireSftp(), 'stat', `${record.dir}/${LOG_FILE}`)
      const size = Number(attrs && attrs.size)
      if (Number.isFinite(size) && size >= 0) record.bytes = size
    } catch {
      /* the log may not exist yet, or the channel is gone */
    }
  }

  /** true (alive), false (dead) or null (the probe itself was inconclusive). */
  async #alive(host, record) {
    if (!Number.isInteger(record.pid) || record.pid <= 0) return false
    const result = await host.runCommand(
      `kill -0 ${record.pid} 2>/dev/null && echo alive || echo dead`,
      null,
      { maxBytes: CONTROL_MAX_BYTES },
    )
    const stdout = String(result && result.stdout ? result.stdout : '')
    if (/^alive$/m.test(stdout)) return true
    if (/^dead$/m.test(stdout)) return false
    return null
  }

  /**
   * One refresh pass over a running job. The exit file decides, but it is read
   * twice around the liveness probe: the code can be published between the two,
   * and "no code yet" plus "process gone" must never be settled as a failure.
   * run.sh moves the code into place before it dies, so a dead process has
   * necessarily published its code by the time the second read runs.
   */
  async #poll(record) {
    const host = await this.#connect(record)
    const exit = await this.#readExit(host, record)
    if (exit.code !== null) {
      this.#finish(record, classifyStatus({ exitCode: exit.code, killRequested: record.killRequested, alive: false }), exit.code)
      await this.#statBytes(host, record)
      return
    }
    const alive = await this.#alive(host, record)
    if (alive === false) {
      const late = await this.#readExit(host, record)
      this.#finish(
        record,
        classifyStatus({ exitCode: late.code, killRequested: record.killRequested, alive: false }),
        late.code,
      )
    }
    await this.#statBytes(host, record)
  }

  /**
   * Stage and detach one command. Resolves as soon as the remote shell reports
   * a pid; failure to launch is the only reason this rejects.
   */
  async start(connectionId, options = {}) {
    const input = options ?? {}
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (command.length === 0) {
      throw fsError('REMOTE_DECK_JOB_NO_COMMAND', 'a background job needs a non-empty command')
    }
    const host = this.hostFor(connectionId)
    if (host === undefined) {
      throw fsError('REMOTE_DECK_JOB_NO_HOST', `Connection ${connectionId} does not exist.`)
    }
    await host.connect(this.secrets)
    const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : ''
    const id = randomUUID()
    const created = await host.runCommand(
      `dir="\${TMPDIR:-/tmp}/${JOBS_DIR}/${id}"; mkdir -p "$dir"; echo "dir=$dir"`,
      null,
      { maxBytes: CONTROL_MAX_BYTES },
    )
    const dir = parseEchoedValue(created && created.stdout, 'dir')
    if (dir === null || dir.length === 0) {
      throw fsError('REMOTE_DECK_JOB_NO_DIR', `could not create the job directory: ${commandDetail(created)}`)
    }

    try {
      const sftp = host.requireSftp()
      // A relative TMPDIR is spelled relative by the shell too; SFTP resolves it
      // against the login directory, exactly like the launch channel does.
      if (dir.startsWith('/')) await ensureRemoteDir(sftp, dir)
      await sftpCall(sftp, 'writeFile', `${dir}/${RUN_SCRIPT}`, buildRunScript({ command, cwd, dir }))
      const launched = await host.runCommand(buildLaunchCommand({ dir }), null, { maxBytes: CONTROL_MAX_BYTES })
      const pid = Number.parseInt(parseEchoedValue(launched && launched.stdout, 'pid') ?? '', 10)
      if (!Number.isInteger(pid) || pid <= 0) {
        throw fsError('REMOTE_DECK_JOB_LAUNCH_FAILED', `the background job did not report a pid: ${commandDetail(launched)}`)
      }
      const record = {
        id,
        connectionId,
        host: String(host.record && host.record.name ? host.record.name : ''),
        pid,
        grouped: parseEchoedValue(launched && launched.stdout, 'grouped') === '1',
        command,
        label: typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : deriveLabel(command),
        cwd,
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        finishedAt: null,
        bytes: 0,
        dir,
        killRequested: false,
        settled: false,
      }
      this.jobs.set(id, record)
      this.#log('job start', connectionId, id, pid, command)
      return this.#view(record)
    } catch (error) {
      // The job never started (or we lost its handles): drop what we staged.
      await host.runCommand(`rm -rf ${shellQuote(dir)}`, null, { maxBytes: CONTROL_MAX_BYTES }).catch(() => {})
      throw error
    }
  }

  list() {
    return [...this.jobs.values()].map((record) => this.#view(record))
  }

  get(id) {
    const record = this.jobs.get(String(id))
    return record === undefined ? undefined : this.#view(record)
  }

  /**
   * Read the log from `offset` on. A missing log is empty, not an error, and
   * `eof` only becomes true once the job has settled and the file is exhausted.
   */
  async read(id, options = {}) {
    const record = this.#record(id)
    const input = options ?? {}
    const offset = normalizeOffset(input.offset)
    const maxBytes = normalizeMaxBytes(input.maxBytes)
    const host = await this.#connect(record)
    const chunk = await this.#readLog(host, record, offset, maxBytes)
    if (chunk === null) {
      return { text: '', offset, eof: false, status: record.status, exitCode: record.exitCode }
    }
    const reachedEnd = chunk.size < maxBytes
    const next = offset + chunk.size
    if (reachedEnd) record.bytes = next
    else if (record.bytes < next) record.bytes = next
    const eof = record.status !== 'running' && (reachedEnd || next >= record.bytes)
    return {
      text: new TextDecoder('utf-8').decode(chunk.buffer),
      offset: next,
      eof,
      status: record.status,
      exitCode: record.exitCode,
    }
  }

  /** null when the log does not exist yet. */
  #readLog(host, record, offset, maxBytes) {
    return new Promise((resolve, reject) => {
      let stream
      try {
        stream = host.requireSftp().createReadStream(`${record.dir}/${LOG_FILE}`, {
          start: offset,
          end: offset + maxBytes - 1,
        })
      } catch (error) {
        reject(error)
        return
      }
      const parts = []
      let size = 0
      let done = false
      const finish = (settle, value) => {
        if (done) return
        done = true
        settle(value)
      }
      stream.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        parts.push(buffer)
        size += buffer.length
      })
      stream.on('error', (error) => {
        // A log that does not exist yet is empty output, not a failure.
        if (isNotFound(error)) finish(resolve, null)
        else finish(reject, statusSftpError(error))
      })
      stream.on('end', () => finish(resolve, { buffer: Buffer.concat(parts), size }))
      // Some servers close without a clean EOF; hand back what was read.
      stream.on('close', () => finish(resolve, { buffer: Buffer.concat(parts), size }))
    })
  }

  /** Re-read the exit file (and the log size) for one job. */
  async refresh(id) {
    const record = this.#record(id)
    if (record.status === 'running') await this.#poll(record)
    return this.#view(record)
  }

  /** Refresh every running job; settles each one at most once, failures are logged. */
  async refreshAll() {
    const settled = []
    for (const record of [...this.jobs.values()]) {
      if (record.status !== 'running') continue
      try {
        await this.#poll(record)
      } catch (error) {
        this.#log('job refresh failed', record.id, errorText(error))
        continue
      }
      if (record.status !== 'running') settled.push(this.#view(record))
    }
    return { settled }
  }

  /**
   * SIGTERM the process group (or the bare pid when setsid was unavailable),
   * escalate to SIGKILL after ~2s, then settle from the exit file. A job that
   * finished in the meantime is reported, never thrown.
   */
  async kill(id, reason) {
    const record = this.#record(id)
    if (record.status !== 'running') return { ok: false, status: record.status }
    const host = await this.#connect(record)
    if (!Number.isInteger(record.pid) || record.pid <= 0) {
      await this.#poll(record)
      return { ok: false, status: record.status }
    }
    record.killRequested = true
    this.#log('job kill', record.id, record.pid, reason ?? '')
    await this.#signal(host, record, 'TERM')
    const deadline = Date.now() + KILL_TIMEOUT_MS
    let alive = await this.#alive(host, record)
    while (alive !== false && Date.now() < deadline) {
      await delay(KILL_POLL_MS)
      // It may have exited on its own; never escalate against a recycled pid.
      if (await this.#exitPresent(host, record)) {
        alive = false
        break
      }
      alive = await this.#alive(host, record)
    }
    if (alive !== false && !(await this.#exitPresent(host, record))) {
      await this.#signal(host, record, 'KILL')
      await delay(KILL_POLL_MS)
    }
    await this.#poll(record)
    return { ok: true, status: record.status }
  }

  async #signal(host, record, signal) {
    const target = record.grouped === true ? `-- -${record.pid}` : `${record.pid}`
    try {
      await host.runCommand(`kill -${signal} ${target}`, null, { maxBytes: CONTROL_MAX_BYTES })
    } catch (error) {
      this.#log('job signal failed', record.id, signal, errorText(error))
    }
  }

  /**
   * Drop a job from the table. A finished job also loses its remote directory;
   * a running one keeps it, because the process still writes there.
   */
  async forget(id) {
    const key = String(id)
    const record = this.jobs.get(key)
    if (record === undefined) return false
    this.jobs.delete(key)
    record.settled = true
    if (record.status !== 'running') {
      try {
        const host = this.hostFor(record.connectionId)
        if (host !== undefined) {
          await host.connect(this.secrets)
          await host.runCommand(`rm -rf ${shellQuote(record.dir)}`, null, { maxBytes: CONTROL_MAX_BYTES })
        }
      } catch (error) {
        this.#log('job cleanup failed', record.id, errorText(error))
      }
    }
    this.#log('job forget', record.id, record.status)
    return true
  }

  /** Stop tracking every job; running processes keep running on the remote host. */
  closeAll() {
    for (const record of this.jobs.values()) record.settled = true
    this.jobs.clear()
  }
}

function parseEchoedValue(text, key) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(String(text ?? ''))
  return match === null ? null : match[1].trim()
}

function commandDetail(result) {
  const stderr = String((result && result.stderr) || '').trim()
  if (stderr.length > 0) return stderr
  const stdout = String((result && result.stdout) || '').trim()
  if (stdout.length > 0) return stdout
  return 'the remote host returned no output'
}

function deriveLabel(command) {
  const first = String(command).split('\n')[0].replace(/\s+/g, ' ').trim()
  return first.length > 80 ? `${first.slice(0, 77)}...` : first
}

function normalizeOffset(value) {
  const offset = Number(value)
  return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
}

function normalizeMaxBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_READ_BYTES
  return Math.min(MAX_READ_BYTES, Math.floor(bytes))
}

function isNotFound(error) {
  if (error === undefined || error === null) return false
  return error.code === 'FS_NOT_FOUND' || error.code === 2 || error.code === 'ENOENT'
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
