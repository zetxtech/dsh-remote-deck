/**
 * The remote_job tool.
 *
 * It exposes the background jobs that the `bash` tool starts with
 * run_in_background: true: list them, read incremental output, stop one, or
 * forget a finished one. All job state lives in RemoteJobManager; this module
 * only shapes what the model sees and waits briefly when it asks to.
 */
import { errorText } from './util.js'

const DEFAULT_WAIT_MS = 30000
const MAX_WAIT_MS = 120000
const WAIT_POLL_MS = 1000
const OUTPUT_BYTES = 128 * 1024
const COMMAND_MAX = 120

const HINT = 'Background jobs are started by the bash tool with run_in_background: true; read new output with action "output" and the returned offset, stop one with action "kill", and drop a finished one with action "forget".'
const NO_SESSION_NOTE = '(no remote workspace in this session: showing background jobs for every host)'

export function remoteJobToolSpec({ resolveSession, jobs }) {
  const scopeFor = async (exec) => {
    if (typeof resolveSession !== 'function') return { remote: true }
    try {
      const target = await resolveSession(exec)
      if (target === undefined || target === null) return { remote: false }
      return { remote: true }
    } catch {
      // A session lookup failure must never block job control: ids are explicit.
      return { remote: true }
    }
  }

  const requireId = (input) => {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id.length === 0) throw new Error('this action needs an "id"; run action "list" to see the background jobs')
    return id
  }

  const listJobs = async (scope) => {
    await jobs.refreshAll()
    const views = jobs.list()
    const lines = views.length === 0
      ? ['no background jobs']
      : views.map((view) => {
        const end = typeof view.finishedAt === 'number' ? view.finishedAt : Date.now()
        const seconds = Math.max(0, Math.round((end - view.startedAt) / 1000))
        return `${view.id} [${view.status}] pid ${Number.isInteger(view.pid) ? view.pid : '-'} ${seconds}s — ${oneLine(view.command)}`
      })
    if (!scope.remote) lines.push(NO_SESSION_NOTE)
    lines.push(HINT)
    return { text: lines.join('\n'), exitCode: 0 }
  }

  const readOutput = async (input, exec) => {
    const id = requireId(input)
    const offset = normalizeOffset(input.offset)
    const wait = input.wait === true
    const timeoutMs = normalizeTimeout(input.timeoutMs)
    let view = await jobs.refresh(id)
    if (wait && view.status === 'running') {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && exec?.signal?.aborted !== true) {
        await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())))
        try {
          view = await jobs.refresh(id)
        } catch {
          break
        }
        if (view.status !== 'running') break
      }
    }
    const result = await jobs.read(id, { offset, maxBytes: OUTPUT_BYTES })
    const settled = result.status !== 'running'
    const trimmed = result.text.replace(/\s+$/, '')
    const body = trimmed.length === 0 ? '(no new output)' : trimmed
    const marks = [`[status: ${result.status}]`]
    if (result.exitCode !== null) marks.push(`[exit code: ${result.exitCode}]`)
    const trailer = settled
      ? `next offset: ${result.offset}; the job has finished, use action "forget" to remove its remote directory`
      : `next offset: ${result.offset}`
    return { text: `${body}\n${marks.join(' ')}\n${trailer}`, exitCode: 0 }
  }

  const killJob = async (input) => {
    const id = requireId(input)
    const result = await jobs.kill(id, 'requested by the agent')
    if (result.ok !== true) {
      return { text: `job ${id} already finished with status ${result.status}; nothing was killed.`, exitCode: 0 }
    }
    const status = jobs.get(id)?.status ?? result.status
    if (status === 'running') {
      return { text: `sent a kill signal to job ${id}, but it is still running; check again with action "output".`, exitCode: 0 }
    }
    return { text: `killed job ${id} (status: ${status}).`, exitCode: 0 }
  }

  const forgetJob = async (input) => {
    const id = requireId(input)
    const view = jobs.get(id)
    const removed = await jobs.forget(id)
    if (removed !== true) throw new Error(`no background job with id ${id}`)
    if (view !== undefined && view.status === 'running') {
      return { text: `stopped tracking job ${id}; it is still running on the remote host, use action "kill" to stop the process.`, exitCode: 0 }
    }
    return { text: `forgot job ${id} and removed its remote directory.`, exitCode: 0 }
  }

  return {
    name: 'remote_job',
    description:
      'Manage background jobs started on a remote SSH host by the bash tool with run_in_background: true. Actions: "list" shows running and finished jobs, "output" reads new log output (pass the offset it returns to read on), "kill" terminates a job, "forget" drops a finished job and deletes its remote directory.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'output', 'kill', 'forget'], description: 'What to do: list jobs, read output, kill a running job, or forget a finished job.' },
        id: { type: 'string', description: 'Job id; required for output, kill and forget.' },
        offset: { type: 'number', description: 'Byte offset to read from for output; use the offset returned by the previous read.' },
        wait: { type: 'boolean', description: 'For output: wait until the job finishes (or timeoutMs passes) before reading.' },
        timeoutMs: { type: 'number', description: 'For output with wait: how long to wait, default 30000, maximum 120000.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
        required: ['text', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const input = args ?? {}
        const action = String(input.action ?? '').trim().toLowerCase()
        const scope = await scopeFor(exec)
        if (action === 'list') return await listJobs(scope)
        if (action === 'output') return await readOutput(input, exec)
        if (action === 'kill') return await killJob(input)
        if (action === 'forget') return await forgetJob(input)
        throw new Error(`unknown action ${JSON.stringify(action)}; expected "list", "output", "kill" or "forget"`)
      } catch (error) {
        return { text: `remote_job failed: ${errorText(error)}`, exitCode: 1 }
      }
    },
  }
}

function oneLine(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > COMMAND_MAX ? `${flat.slice(0, COMMAND_MAX - 3)}...` : flat
}

function normalizeOffset(value) {
  const offset = Number(value)
  return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
}

function normalizeTimeout(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.floor(ms))
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
