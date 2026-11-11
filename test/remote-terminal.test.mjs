/**
 * The Web sidebar terminal, served from the plugin's own ssh2 session.
 *
 * The intercepted request and the handle contract below are copied from the
 * installed build: `dsh-api-terminal-controller/lib/index.js:986-1009` (the
 * sidebar call and `new BrowserTerminal(handle, ...)`) and the `handle.*` uses in
 * `BrowserTerminal` (lines 360, 434, 438, 509, 534, 539). The reference producer
 * is `LocalTerminalHandle` (`dsh-subprocess-local/lib/index.js:918-1090`).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)
const remoteTerminal = await import(pathToFileURL(`${root}/lib/remote-terminal.js`).href)
const {
  SIDEBAR_TERMINAL_TYPE,
  SshTerminalHandle,
  createSshTerminalHandle,
  installTerminalRedirect,
  isSidebarTerminalSpec,
  planRemoteTerminal,
  remoteTerminalCommand,
} = remoteTerminal

const RECORD = {
  id: 'conn1',
  name: 'ws',
  host: 'chml-ssh.zetx.tech',
  port: 10680,
  username: 'zzs',
  authType: 'key',
  privateKeyPath: 'C:\\Users\\Jack\\.ssh\\id_rsa',
}

/** The sidebar's request verbatim (controller `spawn`, lines 986-996). */
function sidebarSpec(cwd) {
  return {
    argv: ['C:\\Windows\\System32\\cmd.exe'],
    cwd,
    cols: 120,
    rows: 30,
    terminalType: SIDEBAR_TERMINAL_TYPE,
    env: { DSH_SESSION_ID: 'agent-1' },
    shellActivity: true,
    graceMs: 3000,
  }
}

/** The model-facing terminal backend's request (terminal-bash, lines 1051-1060). */
function modelTerminalSpec(cwd) {
  return {
    argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo', '-NoProfile'],
    cwd,
    cols: 160,
    rows: 40,
    terminalType: 'dumb',
    env: { DSH_SHELL: '1', DSH_SESSION_ID: 'agent-1', DSH_PTY_SESSION_ID: 'pty-1', TERM: 'dumb' },
    graceMs: 3000,
  }
}

/** An ssh2 session channel stand-in. */
class FakeChannel extends EventEmitter {
  constructor() {
    super()
    this.writes = []
    this.windows = []
    this.calls = []
    this.paused = 0
    this.resumed = 0
    this.stderr = new EventEmitter()
  }

  write(data) {
    this.writes.push(data)
    return true
  }

  setWindow(rows, cols, height, width) {
    this.windows.push([rows, cols, height, width])
  }

  signal(name) {
    this.calls.push(['signal', name])
  }

  end() {
    this.calls.push(['end'])
  }

  close() {
    this.calls.push(['close'])
  }

  pause() {
    this.paused += 1
  }

  resume() {
    this.resumed += 1
  }
}

function fakeHost({ channel = new FakeChannel(), fail = null } = {}) {
  return {
    state: 'connected',
    connects: 0,
    shells: [],
    async connect() {
      this.connects += 1
      if (fail === 'connect') throw new Error('authentication failed')
    },
    async shellCommand(command, options) {
      this.shells.push([command, options])
      if (fail === 'shell') throw new Error('the server refused the shell request')
      return channel
    },
  }
}

/** A workspace root holding one marker: conn1 -> /data/ws. */
function remoteWorkspaceRoot() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-term-'))
  const stub = join(workspaceRoot, 'conn1', 'ws-slug')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({
    version: 1,
    connectionId: 'conn1',
    path: '/data/ws',
    host: 'ws',
  }))
  return workspaceRoot
}

function depsFor(workspaceRoot, overrides) {
  const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
  return {
    resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
    connectionFor: () => RECORD,
    ...overrides,
  }
}

/** Plan for the one remote workspace, through the real Routing. */
function planFor(workspaceRoot) {
  const plan = planRemoteTerminal(sidebarSpec('/data/ws'), depsFor(workspaceRoot))
  assert.notEqual(plan, null)
  return plan
}

test('the system-ssh surface is gone', () => {
  // The previous revision shelled out to `ssh.exe`; nothing may quietly depend on
  // a host OpenSSH installation any more.
  assert.equal(remoteTerminal.resolveSshPath, undefined)
  assert.equal(remoteTerminal.sshCandidates, undefined)
  assert.equal(remoteTerminal.buildSshTerminalArgv, undefined)
  assert.equal(remoteTerminal.isSshProgram, undefined)
})

test('the sidebar request is recognised and the model terminal request is not', () => {
  assert.equal(isSidebarTerminalSpec(sidebarSpec('/data/ws')), true)
  assert.equal(isSidebarTerminalSpec(modelTerminalSpec('/data/ws')), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), shellActivity: undefined }), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), terminalType: 'dumb' }), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), argv: [] }), false)
  assert.equal(isSidebarTerminalSpec(null), false)
  assert.equal(isSidebarTerminalSpec('spec'), false)
})

test('the remote command changes into the workspace and starts bash', () => {
  assert.equal(
    remoteTerminalCommand('/data/ws'),
    "cd -- '/data/ws' 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
  )
  // A quote in the path must not be able to end the quoted word.
  assert.match(remoteTerminalCommand("/data/it's"), /cd -- '\/data\/it'\\''s' /)
})

test('a sidebar terminal in a remote workspace plans a remote PTY', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    assert.equal(plan.connectionId, 'conn1')
    assert.equal(plan.remotePath, '/data/ws')
    assert.equal(plan.remoteCommand, remoteTerminalCommand('/data/ws'))
    assert.equal(plan.term, SIDEBAR_TERMINAL_TYPE)
    assert.deepEqual([plan.cols, plan.rows, plan.graceMs], [120, 30, 3000])
    // Malformed dimensions fall back instead of reaching ssh2.
    const loose = planRemoteTerminal({ ...sidebarSpec('/data/ws'), cols: 0, rows: '30', graceMs: -1 }, depsFor(workspaceRoot))
    assert.deepEqual([loose.cols, loose.rows, loose.graceMs], [80, 24, 3000])
    // ssh2 authenticates with the stored credentials, so a password connection
    // qualifies too (the old ssh.exe path could not offer one non-interactively).
    const password = planRemoteTerminal(sidebarSpec('/data/ws'), {
      ...depsFor(workspaceRoot),
      connectionFor: () => ({ ...RECORD, authType: 'password', privateKeyPath: '' }),
    })
    assert.notEqual(password, null)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('every unprovable request is left to the local provider', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const deps = depsFor(workspaceRoot)
    // A local Session: the cwd is outside every marked workspace root.
    assert.equal(planRemoteTerminal(sidebarSpec('/tmp/local-project'), deps), null)
    // The model terminal backend, even inside the remote workspace.
    assert.equal(planRemoteTerminal(modelTerminalSpec('/data/ws'), deps), null)
    // No cwd, an unknown connection, a record that cannot address a host.
    assert.equal(planRemoteTerminal({ ...sidebarSpec('/data/ws'), cwd: '' }, deps), null)
    assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, connectionFor: () => undefined }), null)
    for (const patch of [{ host: '' }, { username: '  ' }, undefined, null]) {
      const record = patch === undefined || patch === null ? patch : { ...RECORD, ...patch }
      assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, connectionFor: () => record }), null)
    }
    // A throwing resolver is a miss, not a failed terminal.
    assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, resolveTarget: () => { throw new Error('boom') } }), null)
    assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, connectionFor: () => { throw new Error('boom') } }), null)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the handle offers exactly the consumed surface and drives the channel', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    const channel = new FakeChannel()
    const host = fakeHost({ channel })
    const handle = await createSshTerminalHandle({ host, secrets: {}, plan })

    assert.equal(handle instanceof SshTerminalHandle, true)
    assert.equal(typeof handle.write, 'function')
    assert.equal(typeof handle.resize, 'function')
    assert.equal(typeof handle.inspectActivity, 'function')
    assert.equal(typeof handle.terminate, 'function')
    assert.equal(typeof handle.done.then, 'function')
    assert.equal(typeof handle.output[Symbol.asyncIterator], 'function')

    // The PTY is opened with the workspace command and the requested window.
    assert.equal(host.connects, 1)
    assert.deepEqual(host.shells, [[plan.remoteCommand, { cols: 120, rows: 30, term: SIDEBAR_TERMINAL_TYPE }]])

    await handle.write('echo hi\n')
    assert.deepEqual(channel.writes, ['echo hi\n'])
    // ssh2 takes rows before cols, plus an unused height/width pair.
    await handle.resize(100, 40)
    assert.deepEqual(channel.windows, [[40, 100, 0, 0]])
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('output drains and the exit status is published', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    const channel = new FakeChannel()
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan })

    const chunks = []
    const drained = (async () => {
      for await (const chunk of handle.output) chunks.push(Buffer.from(chunk))
    })()

    channel.emit('data', Buffer.from('hello '))
    channel.emit('data', Buffer.from('world'))
    channel.emit('exit', 0)
    channel.emit('close')
    await drained

    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello world')
    assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
    // A settled handle refuses further input, exactly like the local provider.
    await assert.rejects(handle.write('x'), /terminal process has exited/)
    await assert.rejects(handle.resize(80, 24), /terminal process has exited/)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('a signalled exit keeps the signal and drops the exit code', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    const channel = new FakeChannel()
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan })
    channel.emit('exit', null, 'SIGTERM')
    channel.emit('close')
    assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGTERM' })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('a dropped connection fails the terminal instead of pretending it exited', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    const channel = new FakeChannel()
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan })
    channel.emit('close')
    await assert.rejects(handle.done, /closed without an exit status/)
    assert.equal(handle.exited, true)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('terminate is idempotent and cannot hang on a dead socket', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = { ...planFor(workspaceRoot), graceMs: 20 }
    const channel = new FakeChannel()
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan })

    const first = handle.terminate()
    assert.equal(handle.terminate(), first)
    // The channel never answers; settlement is forced after the grace.
    assert.deepEqual(await first, undefined)
    assert.equal(handle.exited, true)
    assert.deepEqual(await handle.done, { exitCode: null, signal: null })
    assert.deepEqual(channel.calls, [['signal', 'HUP'], ['end'], ['close']])
    assert.equal((await channel.writes).length, 0)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('terminate before the server closes still publishes a normal exit', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = { ...planFor(workspaceRoot), graceMs: 20 }
    const channel = new FakeChannel()
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan })
    const closing = handle.terminate()
    channel.emit('close')
    await closing
    // A user-initiated close resolves; an unexpected drop rejects (previous test).
    assert.deepEqual(await handle.done, { exitCode: null, signal: null })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('activity never claims idle while the shell is alive', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    const channel = new FakeChannel()
    let clock = 0
    const handle = await createSshTerminalHandle({ host: fakeHost({ channel }), secrets: {}, plan, now: () => clock })

    assert.deepEqual(await handle.inspectActivity(), { state: 'unknown', revision: 0 })
    clock = 100
    channel.emit('data', Buffer.from('x'))
    clock = 200
    assert.deepEqual(await handle.inspectActivity(), { state: 'busy', revision: 1 })
    // Silence is not proof the remote foreground waits on stdin.
    clock = 4000
    assert.deepEqual(await handle.inspectActivity(), { state: 'unknown', revision: 2 })
    clock = 4100
    channel.emit('exit', 0)
    channel.emit('close')
    assert.deepEqual(await handle.inspectActivity(), { state: 'idle', revision: 3 })
    assert.deepEqual(await handle.inspectActivity(), { state: 'idle', revision: 3 })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('opening failures surface instead of returning a dead handle', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planFor(workspaceRoot)
    await assert.rejects(
      createSshTerminalHandle({ host: fakeHost({ fail: 'connect' }), secrets: {}, plan }),
      /authentication failed/,
    )
    await assert.rejects(
      createSshTerminalHandle({ host: fakeHost({ fail: 'shell' }), secrets: {}, plan }),
      /refused the shell request/,
    )
    await assert.rejects(createSshTerminalHandle({ host: undefined, secrets: {}, plan }), /no longer configured/)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      createSshTerminalHandle({ host: fakeHost(), secrets: {}, plan, signal: aborted.signal }),
      /abort/i,
    )
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the redirect takes over planned requests and leaves the rest alone', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const seen = []
    const provider = { spawnTerminal: async (spec) => { seen.push(spec); return { local: true } } }
    const original = provider.spawnTerminal
    const opened = []
    const redirect = installTerminalRedirect(provider, {
      ...depsFor(workspaceRoot),
      onRemote: (plan) => opened.push(plan),
      open: async (plan, spec) => ({ plan, spec }),
    })

    // Planned: answered here, and the local provider is NOT called at all.
    const sidebar = sidebarSpec('/data/ws')
    const result = await provider.spawnTerminal(sidebar)
    assert.equal(seen.length, 0)
    assert.equal(result.spec, sidebar)
    assert.equal(result.plan.remotePath, '/data/ws')
    assert.equal(opened.length, 1)

    // Unplanned: the original provider receives the identical request object.
    const local = sidebarSpec('/tmp/local-project')
    assert.deepEqual(await provider.spawnTerminal(local), { local: true })
    assert.equal(seen[0], local)
    const model = modelTerminalSpec('/data/ws')
    await provider.spawnTerminal(model)
    assert.equal(seen[1], model)

    redirect.restore()
    assert.equal(provider.spawnTerminal, original)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('a failed remote open is never retried as a local shell', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    let local = 0
    const provider = { spawnTerminal: async () => { local += 1; return {} } }
    installTerminalRedirect(provider, {
      ...depsFor(workspaceRoot),
      open: async () => { throw new Error('host unreachable') },
    })
    await assert.rejects(provider.spawnTerminal(sidebarSpec('/data/ws')), /host unreachable/)
    assert.equal(local, 0)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('installing on a provider without spawnTerminal is a no-op', () => {
  const redirect = installTerminalRedirect({}, { open: async () => ({}) })
  assert.equal(typeof redirect.restore, 'function')
  redirect.restore()
  assert.equal(typeof installTerminalRedirect(undefined, {}).restore, 'function')
})
