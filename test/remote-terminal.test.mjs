/**
 * The Web sidebar terminal, redirected to the remote host.
 *
 * The intercepted request shapes below are copied from the installed build:
 * `dsh-api-terminal-controller/lib/index.js:986-996` (the sidebar) and
 * `dsh-terminal-bash/lib/index.js:1051-1060` (the model's terminal backend).
 * The tests pin the discriminator between them, the argv we build, and every
 * guard that must leave the local shell alone.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)
const {
  SIDEBAR_TERMINAL_TYPE,
  buildSshTerminalArgv,
  installTerminalRedirect,
  isSidebarTerminalSpec,
  isSshProgram,
  planRemoteTerminal,
  remoteTerminalCommand,
  resolveSshPath,
  sshCandidates,
} = await import(pathToFileURL(`${root}/lib/remote-terminal.js`).href)

const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
const KEY = 'C:\\Users\\Jack\\.ssh\\id_rsa'
const RECORD = {
  id: 'conn1',
  name: 'ws',
  host: 'chml-ssh.zetx.tech',
  port: 10680,
  username: 'zzs',
  authType: 'key',
  privateKeyPath: KEY,
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
    signal: undefined,
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
    env: { DSH_SHELL: '1', DSH_SESSION_ID: 'agent-1', DSH_PTY_SESSION_ID: 'pty-1', TERM: 'dumb', NO_COLOR: '1' },
    graceMs: 3000,
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
    color: 'blue',
  }))
  return workspaceRoot
}

function depsFor(workspaceRoot, overrides) {
  const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
  return {
    resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
    connectionFor: () => RECORD,
    sshPath: SSH,
    localCwd: 'C:\\Users\\Jack',
    keyExists: () => true,
    ...overrides,
  }
}

test('the sidebar request is recognised and the model terminal request is not', () => {
  assert.equal(isSidebarTerminalSpec(sidebarSpec('/data/ws')), true)
  assert.equal(isSidebarTerminalSpec(modelTerminalSpec('/data/ws')), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), shellActivity: undefined }), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), terminalType: 'dumb' }), false)
  assert.equal(isSidebarTerminalSpec({ ...sidebarSpec('/data/ws'), argv: [] }), false)
  assert.equal(isSidebarTerminalSpec(null), false)
  assert.equal(isSidebarTerminalSpec('spec'), false)
})

test('an ssh program is never redirected twice', () => {
  assert.equal(isSshProgram('C:\\Windows\\System32\\OpenSSH\\ssh.exe'), true)
  assert.equal(isSshProgram('/usr/bin/ssh'), true)
  assert.equal(isSshProgram('C:\\Windows\\System32\\cmd.exe'), false)
  assert.equal(isSshProgram('sshpass'), false)
  assert.equal(isSshProgram(undefined), false)
})

test('the remote command changes into the workspace and starts bash', () => {
  assert.equal(
    remoteTerminalCommand('/data/ws'),
    "cd -- '/data/ws' 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
  )
  // A quote in the path must not be able to end the quoted word.
  assert.match(remoteTerminalCommand("/data/it's"), /cd -- '\/data\/it'\\''s' /)
})

test('the ssh argv pins the configured host, port and key', () => {
  const argv = buildSshTerminalArgv({ sshPath: SSH, record: RECORD, remoteCommand: 'CMD' })
  assert.deepEqual(argv, [
    SSH,
    '-tt',
    '-p', '10680',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ServerAliveInterval=30',
    '-i', KEY,
    '-l', 'zzs',
    'chml-ssh.zetx.tech',
    'CMD',
  ])
  // `-tt` is what gives the remote command its own PTY.
  assert.equal(argv[1], '-tt')
})

test('a configured jump host is forwarded as ProxyJump', () => {
  const argv = buildSshTerminalArgv({
    sshPath: SSH,
    record: { ...RECORD, jump: 'bastion@jump.test:2222' },
    remoteCommand: 'CMD',
  })
  const at = argv.indexOf('-J')
  assert.equal(at > 0, true)
  assert.equal(argv[at + 1], 'bastion@jump.test:2222')
  // Options must precede the destination host.
  assert.equal(at < argv.indexOf('chml-ssh.zetx.tech'), true)
})

test('the ssh client is found by override, by SystemRoot, then by PATH', async () => {
  assert.deepEqual(sshCandidates({ DSH_REMOTE_DECK_SSH: 'D:\\tools\\ssh.exe', SystemRoot: 'C:\\Windows' }), [
    'D:\\tools\\ssh.exe',
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    '/usr/bin/ssh',
  ])
  assert.deepEqual(sshCandidates({ SystemRoot: 'D:\\Win\\' }), [
    'D:\\Win\\System32\\OpenSSH\\ssh.exe',
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    '/usr/bin/ssh',
  ])

  assert.equal(await resolveSshPath({ env: { DSH_REMOTE_DECK_SSH: 'X' }, exists: () => true }), 'X')
  assert.equal(await resolveSshPath({ env: {}, exists: (path) => path === '/usr/bin/ssh' }), '/usr/bin/ssh')
  // Nothing on disk: fall back to the provider's PATH lookup, which is how a
  // client outside the known locations is still found.
  assert.equal(
    await resolveSshPath({ env: {}, exists: () => false, resolveExecutable: async () => '/opt/ssh' }),
    '/opt/ssh',
  )
  // Neither: the caller keeps the local shell.
  assert.equal(await resolveSshPath({ env: {}, exists: () => false }), null)
  assert.equal(
    await resolveSshPath({ env: {}, exists: () => false, resolveExecutable: async () => { throw new Error('missing') } }),
    null,
  )
})

test('a sidebar terminal in a remote workspace becomes ssh plus a remote bash', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const plan = planRemoteTerminal(sidebarSpec('/data/ws'), depsFor(workspaceRoot))
    assert.notEqual(plan, null)
    assert.equal(plan.connectionId, 'conn1')
    assert.equal(plan.remotePath, '/data/ws')
    // The client must start in an existing *local* directory: the remote path
    // is not a valid Windows cwd, which is why the local shell never started.
    assert.equal(plan.cwd, 'C:\\Users\\Jack')
    assert.equal(plan.argv[0], SSH)
    assert.equal(plan.argv.at(-1), remoteTerminalCommand('/data/ws'))
    assert.equal(plan.argv.includes('C:\\Windows\\System32\\cmd.exe'), false)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the local shell spec is returned untouched for anything but a remote sidebar terminal', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const deps = depsFor(workspaceRoot)

    // 1. a local Session: the cwd is outside every marked workspace root.
    assert.equal(planRemoteTerminal(sidebarSpec('/tmp/local-project'), deps), null)
    // 2. the model terminal backend, even inside the remote workspace.
    assert.equal(planRemoteTerminal(modelTerminalSpec('/data/ws'), deps), null)
    // 3. already an ssh client.
    assert.equal(
      planRemoteTerminal({ ...sidebarSpec('/data/ws'), argv: ['/usr/bin/ssh', 'host'] }, deps),
      null,
    )
    // 4. no resolvable workspace, no cwd, no client.
    assert.equal(planRemoteTerminal({ ...sidebarSpec('/data/ws'), cwd: '' }, deps), null)
    assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, sshPath: null }), null)
    assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, localCwd: '' }), null)
    // 5. a throwing resolver is a miss, not a failed terminal.
    assert.equal(
      planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, resolveTarget: () => { throw new Error('boom') } }),
      null,
    )
    assert.equal(
      planRemoteTerminal(sidebarSpec('/data/ws'), { ...deps, connectionFor: () => { throw new Error('boom') } }),
      null,
    )

    // 6. a Windows stub path for the same workspace is a remote Session too.
    const stub = join(workspaceRoot, 'conn1', 'ws-slug')
    assert.equal(planRemoteTerminal(sidebarSpec(stub), deps), null)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('an unusable connection record keeps the local shell', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const base = depsFor(workspaceRoot)
    const cases = [
      // A password cannot be handed to an interactive ssh client here.
      { authType: 'password' },
      { privateKeyPath: '' },
      { privateKeyPath: undefined },
      { host: '' },
      { username: '   ' },
      { port: 0 },
      { port: 70000 },
      { port: '10680' },
      undefined,
      null,
    ]
    for (const patch of cases) {
      const record = patch === undefined || patch === null ? patch : { ...RECORD, ...patch }
      assert.equal(planRemoteTerminal(sidebarSpec('/data/ws'), { ...base, connectionFor: () => record }), null)
    }
    // A key file that is not on disk cannot authenticate either.
    assert.equal(
      planRemoteTerminal(sidebarSpec('/data/ws'), { ...base, keyExists: () => false }),
      null,
    )
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the installed redirect rewrites one request and restores the provider', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const seen = []
    const provider = {
      spawnTerminal: async function (spec) { seen.push(spec); return { spec } },
    }
    const original = provider.spawnTerminal
    const remote = []
    const redirect = installTerminalRedirect(provider, {
      ...depsFor(workspaceRoot),
      sshPath: async () => SSH,
      onRemote: (plan) => remote.push(plan),
    })

    // A remote sidebar terminal: rewritten, and observed once.
    const sidebar = sidebarSpec('/data/ws')
    await provider.spawnTerminal(sidebar)
    assert.equal(seen.length, 1)
    assert.notEqual(seen[0], sidebar)
    assert.equal(seen[0].cwd, 'C:\\Users\\Jack')
    assert.equal(seen[0].argv[0], SSH)
    assert.equal(seen[0].cols, 120)
    assert.equal(seen[0].terminalType, SIDEBAR_TERMINAL_TYPE)
    assert.equal(remote.length, 1)
    assert.equal(remote[0].remotePath, '/data/ws')

    // Anything else reaches the provider as the very same request object.
    const local = sidebarSpec('/tmp/local-project')
    await provider.spawnTerminal(local)
    assert.equal(seen[1], local)
    const model = modelTerminalSpec('/data/ws')
    await provider.spawnTerminal(model)
    assert.equal(seen[2], model)
    assert.equal(remote.length, 1)

    // No ssh client: the local shell request still goes through untouched.
    // (A fresh provider, so the check covers this redirect alone.)
    const blindSeen = []
    const blindProvider = { spawnTerminal: async (spec) => { blindSeen.push(spec); return { spec } } }
    const blind = installTerminalRedirect(blindProvider, { ...depsFor(workspaceRoot), sshPath: async () => null })
    const third = sidebarSpec('/data/ws')
    await blindProvider.spawnTerminal(third)
    assert.equal(blindSeen[0], third)
    blind.restore()

    redirect.restore()
    assert.equal(provider.spawnTerminal, original)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('a failing provider is called exactly once, never retried locally', async () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    let calls = 0
    const provider = {
      spawnTerminal: async () => {
        calls += 1
        throw new Error('conpty refused')
      },
    }
    installTerminalRedirect(provider, { ...depsFor(workspaceRoot), sshPath: async () => SSH })
    await assert.rejects(provider.spawnTerminal(sidebarSpec('/data/ws')), /conpty refused/)
    assert.equal(calls, 1)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('installing on a provider without spawnTerminal is a no-op', async () => {
  const redirect = installTerminalRedirect({}, { sshPath: async () => SSH })
  assert.equal(typeof redirect.restore, 'function')
  redirect.restore()
  assert.equal(installTerminalRedirect(undefined, {}).restore instanceof Function, true)
})
