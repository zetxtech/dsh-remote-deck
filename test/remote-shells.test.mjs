/**
 * The remote shell menu: probe, parser, the `terminalController.shells` patch
 * and the shell the sidebar terminal then starts.
 *
 * Everything here is hermetic. The probe command is additionally *run* on this
 * machine (POSIX tools permitting) so the shell string and the parser are
 * checked against real `command -v` output, not only against each other.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SHELL_CACHE_MS,
  DEFAULT_SHELL_FAILURE_CACHE_MS,
  REMOTE_SHELL_ARGS,
  REMOTE_SHELL_NAMES,
  SHELL_PROBE_TIMEOUT_SECONDS,
  installRemoteShells,
  isRemoteShellPath,
  parseShellProbeOutput,
  shellName,
  shellProbeCommand,
} from '../lib/remote-shells.js'
import { planRemoteTerminal, remoteTerminalCommand, SIDEBAR_TERMINAL_TYPE } from '../lib/remote-terminal.js'

const POSIX_TOOLS = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v sh >/dev/null']).status === 0

// ------------------------------------------------------------ probe command

/** The probe body is single-quoted as a whole, so an inner quoted word escapes twice. */
const escapedOnce = (text) => text.replace(/'/g, `'\\''`)

test('the probe asks for every candidate once and bounds itself', () => {
  const command = shellProbeCommand()
  assert.ok(command.includes(escapedOnce(`for name in 'bash' 'zsh' 'fish' 'dash' 'ksh' 'sh'; do`)), command)
  assert.match(command, /p=\$\(command -v "\$name" 2>\/dev\/null\) \|\| p=""/)
  // Only absolute, executable paths are printed: a builtin, alias, or a BusyBox
  // applet name must never reach the menu.
  assert.ok(command.includes(escapedOnce(`case "$p" in /*) ;; *) p="" ;; esac`)), command)
  assert.match(command, /for dir in \/bin \/usr\/bin \/usr\/local\/bin; do/)
  assert.ok(command.includes(escapedOnce(`if [ -n "$p" ] && [ -x "$p" ]; then printf '%s\\n' "$p"; fi`)), command)
  assert.match(command, /command -v timeout >\/dev\/null 2>&1/)
  assert.match(command, new RegExp(`timeout ${SHELL_PROBE_TIMEOUT_SECONDS} sh -c `))
  // A host without `timeout` still runs the probe.
  assert.match(command, /\nelse\n  sh -c /)
  // Candidate names are quoted, so a custom name cannot add a command.
  assert.ok(shellProbeCommand(['weird name']).includes(escapedOnce(`for name in 'weird name'; do`)))
  assert.match(shellProbeCommand(REMOTE_SHELL_NAMES, 3), /timeout 3 sh -c /)
})

test('the probe command runs on a POSIX host and parses into real shells', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const run = spawnSync('sh', ['-c', shellProbeCommand()], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const found = parseShellProbeOutput(run.stdout)
  assert.ok(found.length > 0, `no shells found in ${JSON.stringify(run.stdout)}`)
  for (const shell of found) {
    assert.match(shell.path, /^\//)
    assert.ok(existsSync(shell.path), `${shell.path} does not exist`)
    assert.deepEqual(shell.args, ['-l'])
  }
  assert.ok(found.some((shell) => shell.name === 'sh'), run.stdout)
  // Preference order: bash (when present) before sh.
  const names = found.map((shell) => shell.name)
  assert.deepEqual(names, [...names].sort((a, b) => REMOTE_SHELL_NAMES.indexOf(a) - REMOTE_SHELL_NAMES.indexOf(b)))
})

// ------------------------------------------------------------------ parser

test('the probe still finds shells when PATH cannot resolve them', { skip: !POSIX_TOOLS || !existsSync('/bin/sh') }, () => {
  // BusyBox answers `command -v sh` with a bare applet name; the absolute-path
  // fallback is what keeps a BusyBox-only host from offering an empty menu.
  // Only `sh` is reachable here, so every hit below comes from that fallback.
  const bin = mkdtempSync(join(tmpdir(), 'rd-shells-'))
  try {
    symlinkSync('/bin/sh', join(bin, 'sh'))
    const run = spawnSync('/bin/sh', ['-c', shellProbeCommand()], { encoding: 'utf8', env: { PATH: bin } })
    assert.equal(run.status, 0, run.stderr)
    const found = parseShellProbeOutput(run.stdout)
    assert.ok(found.some((shell) => shell.name === 'sh'), `sh missing from ${JSON.stringify(run.stdout)}`)
    for (const shell of found) assert.ok(existsSync(shell.path), shell.path)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('the parser keeps known shells in preference order with the login argument', () => {
  assert.deepEqual(parseShellProbeOutput('/usr/bin/zsh\n/bin/bash\n/usr/bin/sh\n'), [
    { path: '/bin/bash', name: 'bash', args: ['-l'] },
    { path: '/usr/bin/zsh', name: 'zsh', args: ['-l'] },
    { path: '/usr/bin/sh', name: 'sh', args: ['-l'] },
  ])
  assert.deepEqual(REMOTE_SHELL_ARGS, ['-l'])
  assert.equal(shellName('/usr/local/bin/fish'), 'fish')
})

test('the parser drops noise, duplicates and unknown programs', () => {
  const text = [
    '',
    'bash',
    'C:\\Windows\\System32\\cmd.exe',
    '/bin/bash5',
    '/bin/../bin/bash',
    '//bin/bash',
    '/bin/bash',
    '/bin/bash',
    '/opt/fish/bin/fish',
    'find: warning: no such file',
    '/usr/bin/z',
    '/bin/sh\r',
  ].join('\n')
  assert.deepEqual(parseShellProbeOutput(text).map((shell) => shell.path), ['/bin/bash', '/opt/fish/bin/fish', '/bin/sh'])
  // A truncated or absent answer is an empty list, never an exception.
  assert.deepEqual(parseShellProbeOutput(''), [])
  assert.deepEqual(parseShellProbeOutput(undefined), [])
  assert.deepEqual(parseShellProbeOutput(42), [])
})

test('only absolute POSIX paths to offered shells may be started', () => {
  for (const good of ['/bin/bash', '/usr/local/bin/zsh', '/opt/ksh/bin/ksh', '/bin/sh']) {
    assert.equal(isRemoteShellPath(good), true, good)
  }
  const bad = [
    'bash',
    'C:\\Windows\\System32\\cmd.exe',
    'pwsh',
    '/bin/bash.exe',
    '/bin/bash5',
    '/bin/../bin/bash',
    '//bin/bash',
    '/bin/',
    '/bin/bash\nrm -rf /',
    '/bin/bash\u0000',
    '/bin/sh; rm -rf /',
    '',
    null,
    undefined,
    42,
    {},
    `/${'x'.repeat(2000)}/bash`,
  ]
  for (const value of bad) assert.equal(isRemoteShellPath(value), false, String(value))
})

// --------------------------------------------------------------- installer

/** A controller-shaped service: the method lives on the prototype, like the real one. */
function makeController(local = [{ path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] }]) {
  const calls = []
  class Controller {
    shells(agent, signal) {
      calls.push({ agent, signal })
      return Promise.resolve(local.map((shell) => ({ ...shell })))
    }
  }
  return { service: new Controller(), calls }
}

function remoteDeps(overrides = {}) {
  const probes = []
  return {
    probes,
    deps: {
      cwdFor: () => '/data/ws',
      resolveTarget: (cwd) => (cwd.startsWith('/data/') ? { connectionId: 'conn1', path: cwd } : null),
      probe: async (connectionId) => {
        probes.push(connectionId)
        return '/usr/bin/zsh\n/bin/bash\n'
      },
      ...overrides,
    },
  }
}

test('a remote Session is answered with the shells found on the host', async () => {
  const { service, calls } = makeController()
  const { deps, probes } = remoteDeps()
  const installed = installRemoteShells(service, deps)
  try {
    assert.equal(installed.installed, true)
    const shells = await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells, [
      { path: '/bin/bash', name: 'bash', args: ['-l'] },
      { path: '/usr/bin/zsh', name: 'zsh', args: ['-l'] },
    ])
    assert.deepEqual(probes, ['conn1'])
    // The stock discovery must not run for a remote Session: it would describe
    // the local machine.
    assert.equal(calls.length, 0)
  } finally {
    installed.restore()
  }
})

test('a local Session keeps the stock answer and never probes', async () => {
  const { service, calls } = makeController()
  const { deps, probes } = remoteDeps({ cwdFor: () => 'C:\\Users\\Jack\\proj', resolveTarget: () => null })
  const installed = installRemoteShells(service, deps)
  try {
    const shells = await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells, [{ path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] }])
    assert.deepEqual(probes, [])
    assert.equal(calls.length, 1)
  } finally {
    installed.restore()
  }
})

test('an unprovable Session, or a failing probe, falls back to the stock answer', async () => {
  const { service } = makeController()
  const cases = [
    // Not a remote target at all.
    remoteDeps({ resolveTarget: () => null }),
    remoteDeps({ resolveTarget: () => { throw new Error('boom') } }),
    remoteDeps({ cwdFor: () => { throw new Error('boom') } }),
    remoteDeps({ cwdFor: () => undefined }),
    remoteDeps({ cwdFor: () => '' }),
    // A probe that fails, is aborted, or answers with nothing usable.
    remoteDeps({ probe: async () => { throw new Error('offline') } }),
    remoteDeps({ probe: async () => '' }),
    remoteDeps({ probe: async () => 'no shells here\n' }),
    remoteDeps({ probe: async () => undefined }),
  ]
  for (const { deps } of cases) {
    const installed = installRemoteShells(service, deps)
    try {
      const shells = await service.shells({ session: 's1' }, undefined)
      assert.deepEqual(shells, [{ path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] }])
    } finally {
      installed.restore()
    }
  }
})

test('the discovered list is cached per connection and refreshed once stale', async () => {
  const { service } = makeController()
  let now = 1000
  const { deps, probes } = remoteDeps({ now: () => now })
  const installed = installRemoteShells(service, deps)
  try {
    assert.equal(DEFAULT_SHELL_CACHE_MS, 60000)
    await service.shells({ session: 's1' }, undefined)
    await service.shells({ session: 's2' }, undefined)
    assert.deepEqual(probes, ['conn1'])
    now += DEFAULT_SHELL_CACHE_MS - 1
    await service.shells({ session: 's1' }, undefined)
    assert.equal(probes.length, 1)
    now += 2
    await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(probes, ['conn1', 'conn1'])
  } finally {
    installed.restore()
  }
})

test('two connections keep separate cache entries', async () => {
  const { service } = makeController()
  let cwd = '/data/ws'
  const { deps, probes } = remoteDeps({
    cwdFor: () => cwd,
    resolveTarget: (value) => ({ connectionId: value.includes('other') ? 'conn2' : 'conn1', path: value }),
  })
  const installed = installRemoteShells(service, deps)
  try {
    await service.shells({ session: 's1' }, undefined)
    cwd = '/data/other'
    await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(probes, ['conn1', 'conn2'])
    // Both are served from their own cache afterwards.
    cwd = '/data/ws'
    await service.shells({ session: 's1' }, undefined)
    cwd = '/data/other'
    await service.shells({ session: 's1' }, undefined)
    assert.equal(probes.length, 2)
  } finally {
    installed.restore()
  }
})

test('a failed probe is remembered briefly instead of re-probing every menu open', async () => {
  const { service } = makeController()
  let now = 0
  let attempts = 0
  const { deps } = remoteDeps({
    now: () => now,
    probe: async () => {
      attempts += 1
      throw new Error('offline')
    },
  })
  const installed = installRemoteShells(service, deps)
  try {
    assert.equal(DEFAULT_SHELL_FAILURE_CACHE_MS, 15000)
    await service.shells({ session: 's1' }, undefined)
    await service.shells({ session: 's1' }, undefined)
    assert.equal(attempts, 1)
    now += DEFAULT_SHELL_FAILURE_CACHE_MS + 1
    await service.shells({ session: 's1' }, undefined)
    assert.equal(attempts, 2)
  } finally {
    installed.restore()
  }
})

test('a probe that never settles still answers the stock list', async () => {
  const { service } = makeController()
  let attempts = 0
  const { deps } = remoteDeps({
    probe: () => {
      attempts += 1
      return new Promise(() => {})
    },
    probeTimeoutMs: 20,
  })
  const installed = installRemoteShells(service, deps)
  try {
    const shells = await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells, [{ path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] }])
    assert.equal(attempts, 1)
    // The timeout is a failed probe like any other: remembered, then retried.
    const cached = installRemoteShells(service, { ...deps, probeTimeoutMs: 20 })
    cached.restore()
    await service.shells({ session: 's1' }, undefined)
    assert.equal(attempts, 1)
  } finally {
    installed.restore()
  }
})

test('concurrent menu opens share one probe', async () => {
  const { service } = makeController()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let attempts = 0
  const { deps } = remoteDeps({
    probe: async () => {
      attempts += 1
      await gate
      return '/bin/bash\n'
    },
  })
  const installed = installRemoteShells(service, deps)
  try {
    const first = service.shells({ session: 's1' }, undefined)
    const second = service.shells({ session: 's2' }, undefined)
    release()
    const [one, two] = await Promise.all([first, second])
    assert.equal(attempts, 1)
    assert.deepEqual(one, two)
  } finally {
    installed.restore()
  }
})

test('an already cancelled request is rejected before any probe starts', async () => {
  const { service } = makeController()
  const { deps, probes } = remoteDeps()
  const installed = installRemoteShells(service, deps)
  try {
    const signal = {
      aborted: true,
      throwIfAborted() {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      },
    }
    // Like the stock method, the cancellation check is synchronous.
    assert.throws(() => service.shells({ session: 's1' }, signal), /cancelled/)
    assert.deepEqual(probes, [])
  } finally {
    installed.restore()
  }
})

test('install replaces the prototype method and restore puts the original back', async () => {
  const { service } = makeController()
  const original = service.shells
  const originalOwner = Object.getPrototypeOf(service)
  const installed = installRemoteShells(service, remoteDeps().deps)
  try {
    assert.equal(installed.installed, true)
    assert.equal(Object.hasOwn(service, 'shells'), false)
    assert.notEqual(service.shells, original)
    assert.equal(Object.getOwnPropertyDescriptor(originalOwner, 'shells').value, service.shells)
    // The gateway can fall back to reading parameter names off the source.
    assert.match(Function.prototype.toString.call(service.shells), /^function shells\(agent, signal\)/)
    installed.restore()
    assert.equal(service.shells, original)
    const shells = await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells, [{ path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] }])
  } finally {
    installed.restore()
  }
})

test('restore leaves a later patch alone and a missing method is not patched', () => {
  const { service } = makeController()
  const installed = installRemoteShells(service, remoteDeps().deps)
  const replacement = () => Promise.resolve([])
  Object.getPrototypeOf(service).shells = replacement
  installed.restore()
  assert.equal(service.shells, replacement)

  const deps = remoteDeps().deps
  for (const service2 of [undefined, null, {}, { shells: 'not a function' }, 42]) {
    const result = installRemoteShells(service2, deps)
    assert.equal(result.installed, false)
    assert.equal(typeof result.restore, 'function')
    result.restore()
  }
  class Frozen {}
  Object.defineProperty(Frozen.prototype, 'shells', { value: () => {}, writable: false, configurable: false })
  const frozen = new Frozen()
  assert.equal(installRemoteShells(frozen, deps).installed, false)
})

test('a traceable service proxy reaches the patched prototype method', async () => {
  const { service } = makeController()
  // `ctx.get()` hands out a fresh proxy; install and call both go through one.
  const proxy = new Proxy(service, {
    get: (target, prop, receiver) => Reflect.get(target, prop, receiver),
    set: (target, prop, value, receiver) => Reflect.set(target, prop, value, receiver),
  })
  const installed = installRemoteShells(proxy, remoteDeps().deps)
  try {
    assert.equal(installed.installed, true)
    const shells = await proxy.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells.map((shell) => shell.name), ['bash', 'zsh'])
  } finally {
    installed.restore()
  }
})

test('the stock method keeps its receiver when it is reached through the patch', async () => {
  class Controller {
    constructor() {
      this.prefix = 'stock'
    }

    shells() {
      return Promise.resolve([{ path: `${this.prefix}/cmd.exe`, name: 'cmd.exe', args: [] }])
    }
  }
  const service = new Controller()
  const installed = installRemoteShells(service, remoteDeps({ cwdFor: () => 'C:\\Users\\Jack', resolveTarget: () => null }).deps)
  try {
    const shells = await service.shells({ session: 's1' }, undefined)
    assert.deepEqual(shells, [{ path: 'stock/cmd.exe', name: 'cmd.exe', args: [] }])
  } finally {
    installed.restore()
  }
})

// ------------------------------------------------- the terminal command

const RECORD = { id: 'conn1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k' }

function sidebarSpec(argv, cwd = '/data/ws') {
  return {
    argv,
    cwd,
    cols: 120,
    rows: 30,
    terminalType: SIDEBAR_TERMINAL_TYPE,
    env: { DSH_SESSION_ID: 'agent-1' },
    shellActivity: true,
    graceMs: 3000,
  }
}

test('a chosen remote shell is exec\u2019d, with the stock chain kept behind it', () => {
  const command = remoteTerminalCommand('/data/ws', '/bin/zsh')
  assert.match(command, /^cd -- '\/data\/ws' 2>\/dev\/null; if \[ -x '\/bin\/zsh' \]; then exec '\/bin\/zsh' -l; fi; /)
  assert.match(command, /if command -v bash >\/dev\/null 2>&1; then exec bash -l; else exec sh -l; fi$/)
  // A quote in the path or in the shell cannot end the quoted word.
  assert.match(remoteTerminalCommand("/data/it's", '/bin/zsh'), /cd -- '\/data\/it'\\''s' 2>\/dev\/null/)
  // Everything that is not a remote shell path keeps the command byte-for-byte.
  for (const value of ['zsh', 'C:\\Windows\\System32\\cmd.exe', '/bin/evil', '/bin/zsh5', '/bin/../bin/zsh', '/bin/sh -c id', undefined, null, 42]) {
    assert.equal(remoteTerminalCommand('/data/ws', value), remoteTerminalCommand('/data/ws'), String(value))
  }
})

test('a sidebar spawn for a remote Session plans the chosen shell', () => {
  const deps = {
    resolveTarget: () => ({ connectionId: 'conn1', path: '/data/ws' }),
    connectionFor: () => RECORD,
  }
  const chosen = planRemoteTerminal(sidebarSpec(['/bin/zsh', '-l']), deps)
  assert.notEqual(chosen, null)
  assert.match(chosen.remoteCommand, /exec '\/bin\/zsh' -l/)
  assert.equal(chosen.remotePath, '/data/ws')

  // The default entry of a remote Session still arrives as the *local* profile
  // (cmd.exe here), which is not a remote program: the stock chain stays.
  const fallback = planRemoteTerminal(sidebarSpec(['C:\\Windows\\System32\\cmd.exe']), deps)
  assert.equal(fallback.remoteCommand, remoteTerminalCommand('/data/ws'))

  // A hostile argv never reaches the remote command.
  const hostile = planRemoteTerminal(sidebarSpec(['/bin/sh; rm -rf /']), deps)
  assert.equal(hostile.remoteCommand, remoteTerminalCommand('/data/ws'))
})
