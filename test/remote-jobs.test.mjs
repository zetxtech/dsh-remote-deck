/**
 * Hermetic tests for the remote background-job module: no network, no SSH.
 *
 * A fake host backs RemoteJobManager with an in-memory remote filesystem and a
 * tiny shell simulator that answers exactly the commands the manager issues
 * (mkdir, setsid/nohup launch, kill -0/-TERM/-KILL, rm -rf), so the whole
 * start -> read -> refresh -> kill -> forget lifecycle runs in-process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  RemoteJobManager,
  buildLaunchCommand,
  buildRunScript,
  classifyStatus,
  parseExitCode,
} from '../lib/remote-jobs.js'
import { remoteJobToolSpec } from '../lib/tool-remote-jobs.js'

const CONNECTION = 'conn-1'
const PID = 4242
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function attrs(size, directory) {
  return {
    size,
    mtime: 0,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  }
}

function missing(path) {
  const error = new Error(`No such file: ${path}`)
  error.code = 2
  return error
}

function reply(stdout, code = 0) {
  return { code, signal: null, stdout, stderr: '' }
}

function unquoteShell(value) {
  if (!value.startsWith("'")) return value
  return value.slice(1, -1).replace(/'\\''/g, "'")
}

/** Callback-style SFTP stand-in: dirs in a Set, files as Buffers in a Map. */
class FakeSftp {
  constructor() {
    this.dirs = new Set(['/', '/tmp'])
    this.files = new Map()
    this.mkdirs = []
    this.statGates = new Map()
    this.emptyReads = new Map()
  }

  /** Report `path` as missing for the next `times` stats (a write landing late). */
  hideStat(path, times) {
    this.statGates.set(path, times)
  }

  /** Return an empty file for the next `times` reads (created, not yet written). */
  emptyRead(path, times) {
    this.emptyReads.set(path, times)
  }

  stat(path, callback) {
    const gate = this.statGates.get(path)
    if (gate !== undefined && gate > 0) {
      this.statGates.set(path, gate - 1)
      callback(missing(path))
      return
    }
    if (this.dirs.has(path)) {
      callback(null, attrs(0, true))
      return
    }
    const file = this.files.get(path)
    if (file === undefined) callback(missing(path))
    else callback(null, attrs(file.length, false))
  }

  readFile(path, callback) {
    const empty = this.emptyReads.get(path)
    if (empty !== undefined && empty > 0) {
      this.emptyReads.set(path, empty - 1)
      callback(null, Buffer.alloc(0))
      return
    }
    const file = this.files.get(path)
    if (file === undefined) callback(missing(path))
    else callback(null, Buffer.from(file))
  }

  writeFile(path, data, callback) {
    this.files.set(path, Buffer.from(data))
    callback(null)
  }

  mkdir(path, callback) {
    this.mkdirs.push(path)
    this.dirs.add(path)
    callback(null)
  }

  createReadStream(path, options = {}) {
    const stream = new EventEmitter()
    const file = this.files.get(path)
    const start = Math.max(0, Number(options.start) || 0)
    const end = Number.isFinite(Number(options.end)) ? Math.max(start, Number(options.end)) : undefined
    queueMicrotask(() => {
      if (file === undefined) {
        stream.emit('error', missing(path))
        return
      }
      const slice = file.subarray(start, end === undefined ? file.length : end + 1)
      if (slice.length > 0) stream.emit('data', slice)
      stream.emit('end')
    })
    return stream
  }
}

/** A machine whose shell answers the job-control commands the manager sends. */
class FakeRemote {
  constructor(options = {}) {
    this.record = { id: CONNECTION, name: options.name ?? 'ws' }
    this.state = 'connected'
    this.sftp = new FakeSftp()
    this.commands = []
    this.connectCalls = 0
    this.dir = null
    this.pid = null
    this.alive = false
    this.withSetsid = options.withSetsid !== false
    this.grouped = this.withSetsid
    this.exitCode = null
    this.log = Buffer.alloc(0)
    this.hideLog = options.hideLog === true
    this.relativeTmp = options.relativeTmp === true
    this.failLaunch = options.failLaunch === true
    this.ignoresTerm = options.ignoresTerm === true
    this.termCount = 0
    this.killCount = 0
    this.removedDirs = []
  }

  async connect() {
    this.connectCalls += 1
  }

  requireSftp() {
    return this.sftp
  }

  async runCommand(command, cwd, options) {
    this.commands.push({ command, cwd, options })
    if (command.startsWith('dir="${TMPDIR:-/tmp}/')) {
      const match = /dir="\$\{TMPDIR:-\/tmp\}\/([^"]+)"/.exec(command)
      this.dir = this.relativeTmp ? `rel/${match[1]}` : `/tmp/${match[1]}`
      this.sftp.dirs.add(this.dir)
      if (!this.relativeTmp) this.sftp.dirs.add('/tmp/dsh-remote-deck-jobs')
      return reply(`dir=${this.dir}\n`)
    }
    if (command.startsWith('if command -v setsid')) {
      if (this.failLaunch) return reply('grouped=1\n')
      this.pid = PID
      this.alive = true
      this.grouped = this.withSetsid
      if (!this.hideLog) this.syncLog()
      return reply(`pid=${this.pid}\ngrouped=${this.withSetsid ? 1 : 0}\n`)
    }
    if (command.startsWith('kill -0 ')) return reply(this.alive ? 'alive\n' : 'dead\n')
    if (command.startsWith('kill -TERM')) {
      this.termCount += 1
      if (!this.ignoresTerm) this.alive = false
      return reply('')
    }
    if (command.startsWith('kill -KILL')) {
      this.killCount += 1
      this.alive = false
      return reply('')
    }
    if (command.startsWith('rm -rf ')) {
      const target = unquoteShell(command.slice('rm -rf '.length))
      this.removedDirs.push(target)
      this.sftp.dirs.delete(target)
      for (const key of [...this.sftp.files.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) this.sftp.files.delete(key)
      }
      return reply('')
    }
    return reply('')
  }

  writeLog(text) {
    this.log = Buffer.concat([this.log, Buffer.from(text, 'utf8')])
    this.syncLog()
  }

  /** The script finishing on its own: it writes the exit file and disappears. */
  finish(code) {
    this.exitCode = code
    this.alive = false
    this.syncLog()
    this.sftp.files.set(`${this.dir}/exit`, Buffer.from(`${code}\n`))
  }

  syncLog() {
    if (this.dir !== null && !this.hideLog) this.sftp.files.set(`${this.dir}/out.log`, this.log)
  }

  killCommands() {
    return this.commands.filter((entry) => /^kill -(TERM|KILL)/.test(entry.command))
  }
}

async function setup(options = {}) {
  const remote = new FakeRemote(options)
  const settles = []
  const logs = []
  const manager = new RemoteJobManager({
    hostFor: (id) => (id === CONNECTION ? remote : undefined),
    secrets: {},
    onLog: (...args) => logs.push(args),
    onSettle: (view) => settles.push(view),
  })
  const view = await manager.start(CONNECTION, options.start ?? { command: 'sleep 30', cwd: '/srv/app' })
  return { remote, manager, settles, logs, view, id: view.id }
}

function toolFor(manager, resolveSession) {
  if (resolveSession === undefined) return remoteJobToolSpec({ jobs: manager })
  return remoteJobToolSpec({ jobs: manager, resolveSession })
}

const remoteSession = () => ({ connectionId: CONNECTION, path: '/srv/app' })

// --- pure helpers -----------------------------------------------------------

test('buildRunScript quotes cwd, dir and keeps the command verbatim', () => {
  const script = buildRunScript({
    command: 'echo "hi"\nexit 3',
    cwd: "/srv/my app/it's",
    dir: '/tmp/dsh-remote-deck-jobs/abc',
  })
  assert.equal(
    script,
    [
      '#!/bin/bash',
      `cd '/srv/my app/it'\\''s' 2>/dev/null || cd ~`,
      '(',
      'echo "hi"',
      'exit 3',
      ')',
      'status=$?',
      `printf '%s\\n' "$status" > '/tmp/dsh-remote-deck-jobs/abc'/exit.tmp && mv -f '/tmp/dsh-remote-deck-jobs/abc'/exit.tmp '/tmp/dsh-remote-deck-jobs/abc'/exit`,
      'exit "$status"',
      '',
    ].join('\n'),
  )
})

test('buildRunScript falls back to the home directory without a cwd', () => {
  const script = buildRunScript({ command: 'make', cwd: '', dir: '/tmp/jobs/1' })
  assert.match(script, /^#!\/bin\/bash\ncd '~' 2>\/dev\/null \|\| cd ~\n\(\nmake\n\)\n/)
  // The code is published atomically: never a plain redirect into exit.
  assert.ok(script.includes(`printf '%s\\n' "$status" > '/tmp/jobs/1'/exit.tmp && mv -f '/tmp/jobs/1'/exit.tmp '/tmp/jobs/1'/exit`))
  assert.ok(!script.includes('echo "$status" >'))
})

test('buildRunScript keeps an inner exit from skipping the exit code', () => {
  const script = buildRunScript({ command: 'echo bye; exit 7', cwd: '/srv', dir: '/tmp/jobs/9' })
  const lines = script.split('\n')
  const open = lines.indexOf('(')
  const close = lines.indexOf(')')
  const body = lines.indexOf('echo bye; exit 7')
  const status = lines.indexOf('status=$?')
  assert.ok(open >= 0, 'the command must be wrapped in a subshell')
  assert.ok(close > open && body > open && body < close, 'the command must sit inside the subshell')
  assert.ok(status > close, 'the status capture must run after the subshell')
  assert.ok(script.includes(`mv -f '/tmp/jobs/9'/exit.tmp '/tmp/jobs/9'/exit`))
})

test('buildLaunchCommand detaches with setsid and echoes pid and grouped', () => {
  const command = buildLaunchCommand({ dir: '/tmp/my jobs/1' })
  assert.equal(
    command,
    [
      `if command -v setsid >/dev/null 2>&1; then setsid bash '/tmp/my jobs/1'/run.sh >'/tmp/my jobs/1'/out.log 2>&1 </dev/null & grouped=1; else nohup bash '/tmp/my jobs/1'/run.sh >'/tmp/my jobs/1'/out.log 2>&1 </dev/null & grouped=0; fi`,
      'echo "pid=$!"',
      'echo "grouped=$grouped"',
    ].join('\n'),
  )
  assert.ok(!command.includes('&& echo "pid"'))
})

test('parseExitCode accepts one integer and rejects everything else', () => {
  assert.equal(parseExitCode('0'), 0)
  assert.equal(parseExitCode('1\n'), 1)
  assert.equal(parseExitCode('  143  '), 143)
  assert.equal(parseExitCode('-1'), -1)
  assert.equal(parseExitCode(''), null)
  assert.equal(parseExitCode('  \n'), null)
  assert.equal(parseExitCode('exit 0'), null)
  assert.equal(parseExitCode('0\n1'), null)
  assert.equal(parseExitCode('abc'), null)
  assert.equal(parseExitCode(null), null)
  assert.equal(parseExitCode(undefined), null)
  assert.equal(parseExitCode('9'.repeat(40)), null)
})

test('classifyStatus prefers evidence: exit code, then liveness, then kill', () => {
  assert.equal(classifyStatus({ exitCode: null, killRequested: false, alive: true }), 'running')
  assert.equal(classifyStatus({ exitCode: null, killRequested: true, alive: true }), 'running')
  assert.equal(classifyStatus({ exitCode: 0, killRequested: false, alive: false }), 'exited')
  assert.equal(classifyStatus({ exitCode: 2, killRequested: false, alive: false }), 'failed')
  assert.equal(classifyStatus({ exitCode: null, killRequested: false, alive: false }), 'failed')
  assert.equal(classifyStatus({ exitCode: null, killRequested: true, alive: false }), 'killed')
  assert.equal(classifyStatus({ exitCode: 143, killRequested: true, alive: false }), 'killed')
  assert.equal(classifyStatus({}), 'failed')
})

// --- start ------------------------------------------------------------------

test('start stages run.sh, launches detached and reports a running job', async () => {
  const { remote, manager, view } = await setup({ start: { command: 'sleep 30', cwd: '/srv/app', label: 'long sleep' } })
  assert.match(view.id, JOB_ID_RE)
  assert.equal(view.connectionId, CONNECTION)
  assert.equal(view.host, 'ws')
  assert.equal(view.pid, PID)
  assert.equal(view.command, 'sleep 30')
  assert.equal(view.label, 'long sleep')
  assert.equal(view.cwd, '/srv/app')
  assert.equal(view.status, 'running')
  assert.equal(view.exitCode, null)
  assert.equal(view.finishedAt, null)
  assert.equal(view.bytes, 0)
  assert.equal(view.dir, `/tmp/dsh-remote-deck-jobs/${view.id}`)
  assert.equal(typeof view.startedAt, 'number')
  assert.equal(remote.connectCalls, 1)

  const mkdir = remote.commands[0]
  assert.equal(mkdir.command, `dir="\${TMPDIR:-/tmp}/dsh-remote-deck-jobs/${view.id}"; mkdir -p "$dir"; echo "dir=$dir"`)
  assert.equal(mkdir.cwd, null)
  const script = remote.sftp.files.get(`${view.dir}/run.sh`)
  assert.equal(script.toString('utf8'), buildRunScript({ command: 'sleep 30', cwd: '/srv/app', dir: view.dir }))
  const launch = remote.commands.at(-1)
  assert.equal(launch.command, buildLaunchCommand({ dir: view.dir }))
  assert.equal(launch.cwd, null)

  assert.equal(manager.list().length, 1)
  assert.deepEqual(manager.get(view.id), view)
  assert.equal(manager.get('nope'), undefined)
})

test('start derives a one-line label and rejects bad input', async () => {
  const remote = new FakeRemote()
  const manager = new RemoteJobManager({ hostFor: (id) => (id === CONNECTION ? remote : undefined), secrets: {} })
  const view = await manager.start(CONNECTION, { command: '  echo one\n   echo two  ' })
  assert.equal(view.command, 'echo one\n   echo two')
  assert.equal(view.label, 'echo one')
  assert.equal(view.cwd, '')

  await assert.rejects(manager.start(CONNECTION, { command: '   ' }), /non-empty command/)
  await assert.rejects(manager.start('missing', { command: 'ls' }), /does not exist/)
  await assert.rejects(manager.start(CONNECTION), /non-empty command/)
})

test('start keeps a relative TMPDIR exactly as the shell echoed it', async () => {
  const { remote, manager, view } = await setup({ relativeTmp: true })
  assert.equal(view.dir, `rel/dsh-remote-deck-jobs/${view.id}`)
  assert.equal(remote.sftp.dirs.has(`rel/dsh-remote-deck-jobs/${view.id}`), true)
  // No SFTP-side directory repair: the shell's relative path must not be turned
  // into an absolute one that the launch channel never uses.
  assert.deepEqual(remote.sftp.mkdirs, [])
  assert.equal(remote.sftp.files.has(`${view.dir}/run.sh`), true)
  assert.ok(remote.commands.at(-1).command.includes(`'${view.dir}'/run.sh`))
  remote.writeLog('rel\n')
  const read = await manager.read(view.id, { offset: 0 })
  assert.equal(read.text, 'rel\n')
})

test('start cleans up and rejects when the job never reports a pid', async () => {
  const remote = new FakeRemote({ failLaunch: true })
  const manager = new RemoteJobManager({ hostFor: (id) => (id === CONNECTION ? remote : undefined), secrets: {} })
  await assert.rejects(manager.start(CONNECTION, { command: 'sleep 30' }), /did not report a pid/)
  assert.equal(manager.list().length, 0)
  assert.deepEqual(remote.removedDirs, [`/tmp/dsh-remote-deck-jobs/${remote.dir.split('/').pop()}`])
})

// --- read -------------------------------------------------------------------

test('read returns incremental output and advances the offset', async () => {
  const { remote, manager, id } = await setup()
  remote.writeLog('line one\n')
  const first = await manager.read(id, { offset: 0 })
  assert.deepEqual(first, { text: 'line one\n', offset: 9, eof: false, status: 'running', exitCode: null })

  remote.writeLog('line two\n')
  const second = await manager.read(id, { offset: first.offset })
  assert.equal(second.text, 'line two\n')
  assert.equal(second.offset, 18)

  const third = await manager.read(id, { offset: second.offset })
  assert.deepEqual(third, { text: '', offset: 18, eof: false, status: 'running', exitCode: null })

  remote.finish(0)
  await manager.refresh(id)
  const last = await manager.read(id, { offset: second.offset })
  assert.equal(last.status, 'exited')
  assert.equal(last.exitCode, 0)
  assert.equal(last.eof, true)
})

test('read honours maxBytes and tolerates a UTF-8 character split in half', async () => {
  const { remote, manager, id } = await setup()
  remote.writeLog(`${'x'.repeat(200)}héllo\n`)
  const first = await manager.read(id, { offset: 0, maxBytes: 100 })
  assert.equal(first.text.length, 100)
  assert.equal(first.offset, 100)
  assert.equal(first.eof, false)

  const second = await manager.read(id, { offset: first.offset, maxBytes: 107 })
  assert.equal(second.offset, 207)
  assert.ok(second.text.includes('llo'))

  const split = await manager.read(id, { offset: 200, maxBytes: 2 })
  assert.equal(split.text, 'h\uFFFD')
  const rest = await manager.read(id, { offset: split.offset })
  assert.equal(rest.text, '\uFFFDllo\n')
})

test('read treats a missing log as empty output', async () => {
  const { remote, manager, id } = await setup({ hideLog: true })
  const empty = await manager.read(id, { offset: 0 })
  assert.deepEqual(empty, { text: '', offset: 0, eof: false, status: 'running', exitCode: null })

  remote.finish(0)
  await manager.refresh(id)
  const settled = await manager.read(id, { offset: 0 })
  assert.deepEqual(settled, { text: '', offset: 0, eof: false, status: 'exited', exitCode: 0 })
})

test('read rejects for an unknown job', async () => {
  const { manager } = await setup()
  await assert.rejects(manager.read('nope'), /no background job with id "nope"/)
})

// --- refresh ----------------------------------------------------------------

test('refresh settles once on the exit file and never fires onSettle twice', async () => {
  const { remote, manager, settles, id } = await setup()
  remote.writeLog('working\n')
  remote.finish(0)

  const view = await manager.refresh(id)
  assert.equal(view.status, 'exited')
  assert.equal(view.exitCode, 0)
  assert.equal(view.bytes, 8)
  assert.ok(view.finishedAt >= view.startedAt)
  assert.equal(settles.length, 1)
  assert.equal(settles[0].id, id)
  assert.equal(settles[0].status, 'exited')

  await manager.refresh(id)
  await manager.refreshAll()
  await manager.kill(id, 'too late')
  assert.equal(settles.length, 1)
})

test('refresh reports a non-zero exit as failed and a vanished process as failed', async () => {
  const first = await setup()
  first.remote.finish(3)
  assert.equal((await first.manager.refresh(first.id)).status, 'failed')
  assert.equal(first.settles.length, 1)
  assert.equal(first.settles[0].exitCode, 3)

  const second = await setup()
  second.remote.alive = false
  const view = await second.manager.refresh(second.id)
  assert.equal(view.status, 'failed')
  assert.equal(view.exitCode, null)
  assert.equal(second.settles.length, 1)
  assert.equal(second.remote.killCommands().length, 0)
})

test('refresh probes liveness with kill -0 and leaves a live job running', async () => {
  const { remote, manager, settles, id } = await setup()
  const view = await manager.refresh(id)
  assert.equal(view.status, 'running')
  assert.equal(settles.length, 0)
  assert.ok(remote.commands.some((entry) => entry.command === `kill -0 ${PID} 2>/dev/null && echo alive || echo dead`))
})

test('refresh re-reads the exit file when the code lands during the liveness probe', async () => {
  const { remote, manager, settles, id, view } = await setup()
  // The script published exit and died between the manager's stat and its probe:
  // the first stat still misses the file, the probe says dead, the re-read finds it.
  remote.finish(0)
  remote.sftp.hideStat(`${view.dir}/exit`, 1)

  const result = await manager.refresh(id)
  assert.equal(result.status, 'exited')
  assert.equal(result.exitCode, 0)
  assert.equal(settles.length, 1)
  assert.equal(settles[0].exitCode, 0)
})

test('refresh never settles on a half-published exit file while the job lives', async () => {
  const { remote, manager, settles, id, view } = await setup()
  remote.sftp.files.set(`${view.dir}/exit`, Buffer.from('0\n'))
  remote.sftp.emptyRead(`${view.dir}/exit`, 1)

  const running = await manager.refresh(id)
  assert.equal(running.status, 'running')
  assert.equal(settles.length, 0)

  remote.alive = false
  const settled = await manager.refresh(id)
  assert.equal(settled.status, 'exited')
  assert.equal(settled.exitCode, 0)
  assert.equal(settles.length, 1)
})

test('refresh re-reads a half-published exit file once the process is gone', async () => {
  const { remote, manager, settles, id, view } = await setup()
  remote.sftp.files.set(`${view.dir}/exit`, Buffer.from('0\n'))
  remote.sftp.emptyRead(`${view.dir}/exit`, 1)
  remote.alive = false

  const result = await manager.refresh(id)
  assert.equal(result.status, 'exited')
  assert.equal(result.exitCode, 0)
  assert.equal(settles.length, 1)
})

test('refresh still fails a job that died without ever writing an exit code', async () => {
  const { remote, manager, settles, id } = await setup()
  remote.alive = false
  const result = await manager.refresh(id)
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, null)
  assert.equal(settles.length, 1)
})

test('refreshAll reports each settled job once and survives a dead connection', async () => {
  const remote = new FakeRemote()
  const settles = []
  const manager = new RemoteJobManager({
    hostFor: (id) => (id === CONNECTION ? remote : undefined),
    secrets: {},
    onSettle: (view) => settles.push(view),
  })
  const first = await manager.start(CONNECTION, { command: 'one' })
  const second = await manager.start(CONNECTION, { command: 'two' })
  remote.writeLog('both done\n')
  remote.finish(0)

  const { settled } = await manager.refreshAll()
  assert.equal(settled.length, 2)
  assert.deepEqual(settled.map((view) => view.id).sort(), [first.id, second.id].sort())
  assert.equal(settles.length, 2)
  assert.deepEqual(await manager.refreshAll(), { settled: [] })

  manager.hostFor = () => undefined
  const orphan = await manager.start(CONNECTION, { command: 'three' }).catch(() => null)
  assert.equal(orphan, null)
  assert.deepEqual(await manager.refreshAll(), { settled: [] })
})

// --- kill -------------------------------------------------------------------

test('kill terminates the process group and settles as killed', async () => {
  const { remote, manager, settles, id } = await setup()
  const result = await manager.kill(id, 'test')
  assert.deepEqual(result, { ok: true, status: 'killed' })
  assert.equal(remote.termCount, 1)
  assert.equal(remote.killCount, 0)
  assert.ok(remote.commands.some((entry) => entry.command === `kill -TERM -- -${PID}`))
  assert.equal(settles.length, 1)
  assert.equal(settles[0].status, 'killed')
  assert.equal((await manager.refresh(id)).status, 'killed')
  assert.equal(settles.length, 1)
  assert.deepEqual(remote.removedDirs, [])
})

test('kill targets the bare pid when setsid was unavailable', async () => {
  const { remote, manager, id } = await setup({ withSetsid: false })
  const result = await manager.kill(id, 'test')
  assert.deepEqual(result, { ok: true, status: 'killed' })
  assert.ok(remote.commands.some((entry) => entry.command === `kill -TERM ${PID}`))
  assert.equal(remote.commands.some((entry) => entry.command.includes('-- -')), false)
})

test('kill escalates to SIGKILL when the process ignores SIGTERM', async () => {
  const { remote, manager, id } = await setup({ ignoresTerm: true })
  const started = Date.now()
  const result = await manager.kill(id, 'stubborn')
  const elapsed = Date.now() - started
  assert.deepEqual(result, { ok: true, status: 'killed' })
  assert.equal(remote.termCount, 1)
  assert.equal(remote.killCount, 1)
  assert.ok(remote.commands.some((entry) => entry.command === `kill -KILL -- -${PID}`))
  assert.ok(elapsed >= 1900, `expected the SIGTERM grace period, got ${elapsed}ms`)
})

test('kill reports a finished job without signalling it', async () => {
  const { remote, manager, settles, id } = await setup()
  remote.finish(0)
  await manager.refresh(id)
  const before = remote.killCommands().length
  assert.deepEqual(await manager.kill(id, 'late'), { ok: false, status: 'exited' })
  assert.equal(remote.killCommands().length, before)
  assert.equal(settles.length, 1)
})

test('kill tolerates a job that exited on its own just before the signal', async () => {
  const { remote, manager, id } = await setup()
  remote.finish(0)
  const result = await manager.kill(id, 'race')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'killed')
  assert.equal(remote.termCount, 1)
})

test('kill rejects for an unknown job', async () => {
  const { manager } = await setup()
  await assert.rejects(manager.kill('nope'), /no background job with id "nope"/)
})

// --- forget / closeAll ------------------------------------------------------

test('forget of a finished job removes it and its remote directory', async () => {
  const { remote, manager, id, view } = await setup()
  remote.finish(0)
  await manager.refresh(id)
  assert.equal(await manager.forget(id), true)
  assert.equal(manager.get(id), undefined)
  assert.deepEqual(manager.list(), [])
  assert.deepEqual(remote.removedDirs, [view.dir])
  assert.equal(remote.sftp.dirs.has(view.dir), false)
  assert.equal(remote.sftp.files.has(`${view.dir}/exit`), false)
})

test('forget of a running job only stops tracking it', async () => {
  const { remote, manager, id, view } = await setup()
  assert.equal(await manager.forget(id), true)
  assert.equal(manager.get(id), undefined)
  assert.equal(remote.alive, true)
  assert.deepEqual(remote.removedDirs, [])
  assert.equal(remote.killCommands().length, 0)
  assert.equal(remote.sftp.dirs.has(view.dir), true)
  assert.equal(await manager.forget(id), false)
})

test('closeAll drops every job without killing or settling anything', async () => {
  const remote = new FakeRemote()
  const settles = []
  const manager = new RemoteJobManager({
    hostFor: (id) => (id === CONNECTION ? remote : undefined),
    secrets: {},
    onSettle: (view) => settles.push(view),
  })
  const first = await manager.start(CONNECTION, { command: 'one' })
  const second = await manager.start(CONNECTION, { command: 'two' })
  manager.closeAll()
  assert.deepEqual(manager.list(), [])
  assert.equal(remote.killCommands().length, 0)
  assert.equal(remote.alive, true)
  assert.equal(settles.length, 0)
  await assert.rejects(manager.refresh(first.id), /no background job/)
  await assert.rejects(manager.refresh(second.id), /no background job/)
  assert.equal(settles.length, 0)
})

test('a job view is a snapshot, not the live record', async () => {
  const { manager, id } = await setup()
  const snapshot = manager.get(id)
  snapshot.status = 'exited'
  snapshot.command = 'tampered'
  assert.equal(manager.get(id).status, 'running')
  assert.equal(manager.get(id).command, 'sleep 30')
})

// --- tool -------------------------------------------------------------------

test('remote_job declares the frozen schema and output contract', () => {
  const spec = toolFor(new RemoteJobManager({ hostFor: () => undefined, secrets: {} }))
  assert.equal(spec.name, 'remote_job')
  assert.deepEqual(Object.keys(spec.parameters.properties), ['action', 'id', 'offset', 'wait', 'timeoutMs'])
  assert.deepEqual(spec.parameters.properties.action.enum, ['list', 'output', 'kill', 'forget'])
  assert.deepEqual(spec.parameters.required, ['action'])
  assert.equal(spec.parameters.additionalProperties, false)
  assert.deepEqual(spec.output.schema, {
    type: 'object',
    properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
    required: ['text', 'exitCode'],
    additionalProperties: false,
  })
  assert.deepEqual(spec.output.render({}, { text: 'hello' }), [{ type: 'text', text: 'hello' }])
  assert.match(spec.description, /run_in_background: true/)
})

test('list formats the frozen line and hints at output/kill', async () => {
  const { manager, id } = await setup({ start: { command: 'sleep 30 && echo done', cwd: '/srv/app' } })
  const spec = toolFor(manager, remoteSession)
  const result = await spec.execute({ action: 'list' }, {})
  assert.equal(result.exitCode, 0)
  const [line, hint] = result.text.split('\n')
  assert.match(line, new RegExp(`^${id} \\[running\\] pid ${PID} \\d+s — sleep 30 && echo done$`))
  assert.match(hint, /run_in_background: true/)
  assert.match(hint, /"output"/)
  assert.match(hint, /"kill"/)

  const empty = toolFor(new RemoteJobManager({ hostFor: () => undefined, secrets: {} }), remoteSession)
  const none = await empty.execute({ action: 'list' }, {})
  assert.equal(none.exitCode, 0)
  assert.match(none.text, /^no background jobs\n/)
})

test('output reads incrementally, reports status, offset and missing output', async () => {
  const { remote, manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)
  remote.writeLog('hello\n')

  const first = await spec.execute({ action: 'output', id }, {})
  assert.equal(first.exitCode, 0)
  assert.equal(first.text, 'hello\n[status: running]\nnext offset: 6')

  const none = await spec.execute({ action: 'output', id, offset: 6 }, {})
  assert.equal(none.text, '(no new output)\n[status: running]\nnext offset: 6')

  remote.writeLog('bye\n')
  remote.finish(7)
  const last = await spec.execute({ action: 'output', id, offset: 6 }, {})
  assert.equal(last.text, 'bye\n[status: failed] [exit code: 7]\nnext offset: 10; the job has finished, use action "forget" to remove its remote directory')
})

test('output wait returns as soon as the job settles', async () => {
  const { remote, manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)
  remote.writeLog('done\n')
  remote.finish(0)
  const result = await spec.execute({ action: 'output', id, wait: true, timeoutMs: 30000 }, {})
  assert.match(result.text, /^done\n\[status: exited\] \[exit code: 0\]/)
})

test('output wait gives up after timeoutMs and still returns what it has', async () => {
  const { manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)
  const started = Date.now()
  const result = await spec.execute({ action: 'output', id, wait: true, timeoutMs: 200 }, {})
  const elapsed = Date.now() - started
  assert.equal(result.exitCode, 0)
  assert.match(result.text, /^\(no new output\)\n\[status: running\]/)
  assert.ok(elapsed >= 150, `expected to wait for the timeout, got ${elapsed}ms`)
  assert.ok(elapsed < 5000, `wait overshot: ${elapsed}ms`)
})

test('kill and forget report the new state', async () => {
  const { remote, manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)
  const killed = await spec.execute({ action: 'kill', id }, {})
  assert.equal(killed.exitCode, 0)
  assert.equal(killed.text, `killed job ${id} (status: killed).`)

  const again = await spec.execute({ action: 'kill', id }, {})
  assert.equal(again.text, `job ${id} already finished with status killed; nothing was killed.`)

  const forgotten = await spec.execute({ action: 'forget', id }, {})
  assert.equal(forgotten.text, `forgot job ${id} and removed its remote directory.`)
  assert.deepEqual(remote.removedDirs.length, 1)
})

test('forget of a running job says the process keeps running', async () => {
  const { remote, manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)
  const result = await spec.execute({ action: 'forget', id }, {})
  assert.equal(result.exitCode, 0)
  assert.equal(result.text, `stopped tracking job ${id}; it is still running on the remote host, use action "kill" to stop the process.`)
  assert.equal(remote.alive, true)
})

test('errors come back as remote_job failed with exitCode 1', async () => {
  const { manager, id } = await setup()
  const spec = toolFor(manager, remoteSession)

  const noId = await spec.execute({ action: 'output' }, {})
  assert.equal(noId.exitCode, 1)
  assert.match(noId.text, /^remote_job failed: this action needs an "id"/)

  const unknownAction = await spec.execute({ action: 'dance' }, {})
  assert.equal(unknownAction.exitCode, 1)
  assert.match(unknownAction.text, /^remote_job failed: unknown action "dance"/)

  const unknownJob = await spec.execute({ action: 'output', id: 'nope' }, {})
  assert.equal(unknownJob.exitCode, 1)
  assert.match(unknownJob.text, /^remote_job failed: no background job with id "nope"/)

  const firing = new RemoteJobManager({
    hostFor: () => {
      throw new Error('boom')
    },
    secrets: {},
  })
  await firing.start(CONNECTION, { command: 'ls' }).catch(() => {})
  const noArgs = await spec.execute(undefined, {})
  assert.equal(noArgs.exitCode, 1)
  assert.match(noArgs.text, /^remote_job failed: /)
  assert.equal(typeof id, 'string')
})

test('a session outside a remote workspace still lists jobs, with a note', async () => {
  const { remote, manager, id } = await setup()
  remote.writeLog('ok\n')
  const spec = toolFor(manager, () => null)
  const result = await spec.execute({ action: 'list' }, {})
  assert.equal(result.exitCode, 0)
  assert.match(result.text, new RegExp(`^${id} \\[running\\]`))
  assert.match(result.text, /no remote workspace in this session/)
  assert.equal((await spec.execute({ action: 'output', id }, {})).exitCode, 0)
})

test('a missing or throwing resolveSession still serves the tool', async () => {
  const { remote, manager, id } = await setup()
  remote.writeLog('ok\n')
  const bare = toolFor(manager)
  assert.equal((await bare.execute({ action: 'list' }, {})).exitCode, 0)
  assert.equal((await bare.execute({ action: 'output', id }, {})).exitCode, 0)

  const throwing = toolFor(manager, () => {
    throw new Error('no session')
  })
  assert.equal((await throwing.execute({ action: 'list' }, {})).exitCode, 0)
})
