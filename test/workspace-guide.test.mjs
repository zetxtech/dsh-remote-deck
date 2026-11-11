/**
 * Remote workspaces inform the model through the system prompt, never by
 * writing into the user's project directory.
 *
 * Two contracts are pinned here:
 * 1. creating a workspace performs reads only: no SFTP write of any kind, and
 *    specifically no `AGENTS.md`;
 * 2. the registered prompt callbacks contribute text for a remote Session and
 *    an empty string (dropped by the prompt pipeline) for a local one.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)
const {
  WORKSPACE_GUIDE_CONTEXT,
  WORKSPACE_GUIDE_CONTEXT_ORDER,
  WORKSPACE_GUIDE_SECTION,
  WORKSPACE_GUIDE_SECTION_ORDER,
  createWorkspacePromptGuide,
  installWorkspacePromptGuide,
  workspaceContextText,
  workspaceGuideText,
} = await import(pathToFileURL(`${root}/lib/guide.js`).href)

function directoryAttrs() {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    size: 0,
    mtime: 0,
  }
}

/** An SFTP session that records every method name it is asked to perform. */
function recordingSftp(calls) {
  const record = (method) => (...args) => {
    const callback = args.at(-1)
    calls.push([method, ...args.slice(0, -1)])
    if (typeof callback === 'function') callback(null, method === 'stat' ? directoryAttrs() : undefined)
  }
  return {
    stat: record('stat'),
    mkdir: record('mkdir'),
    writeFile: record('writeFile'),
    createWriteStream: record('createWriteStream'),
    rename: record('rename'),
    unlink: record('unlink'),
    ext_openssh_rename: record('ext_openssh_rename'),
  }
}

/** A workspace root holding one marker: conn1 -> /data/ws on host "dev-box". */
function remoteWorkspaceRoot() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-guide-'))
  const stub = join(workspaceRoot, 'conn1', 'ws-slug')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({
    version: 1,
    connectionId: 'conn1',
    path: '/data/ws',
    host: 'dev-box',
    color: 'blue',
  }))
  return workspaceRoot
}

test('creating a workspace writes no file to the remote host', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-guide-create-'))
  try {
    const calls = []
    const sftp = recordingSftp(calls)
    const host = { record: { name: 'dev-box' }, requireSftp: () => sftp }
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => host })

    // `writeGuide` is a retired option: the caller may still pass it, and it
    // must neither throw nor change the outcome.
    const created = await routing.createWorkspace('conn1', '/data/ws', { name: 'dev-box' }, {
      title: 'named workspace',
      writeGuide: true,
    })

    assert.equal(created.path, '/data/ws')
    assert.equal(created.connectionId, 'conn1')
    assert.equal(created.title, 'named workspace')

    // The only remote operations are probes: the directory chain and the target.
    assert.deepEqual([...new Set(calls.map((call) => call[0]))], ['stat'])
    const touched = calls.flatMap((call) => call.slice(1).map(String))
    assert.equal(touched.some((value) => value.includes('AGENTS')), false)
    assert.equal(touched.every((value) => value === '/data' || value === '/data/ws'), true)

    // Everything else the plugin records lives in its own stub directory.
    assert.equal(existsSync(join(created.stub, '.dsh-remote.json')), true)
    assert.equal(existsSync(join(created.stub, 'AGENTS.md')), false)
    assert.deepEqual(JSON.parse(readFileSync(join(created.stub, '.dsh-remote.json'), 'utf8')), {
      version: 1,
      connectionId: 'conn1',
      path: '/data/ws',
      host: 'dev-box',
      color: '',
    })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the prompt guide is registered once per scope with finite orders', () => {
  const sections = []
  const contexts = []
  const scope = {
    systemPrompt: {
      section: (entry) => sections.push(entry),
      context: (entry) => contexts.push(entry),
    },
  }
  const guide = installWorkspacePromptGuide(scope, {
    directoryOf: () => undefined,
    resolveTarget: () => null,
    hostNameFor: () => undefined,
  })

  assert.equal(sections.length, 1)
  assert.equal(contexts.length, 1)
  // `systemPrompt.section()`/`context()` throw a TypeError on a non-finite
  // order, and a named placement lookup returns undefined for a name this
  // plugin does not own, so both numbers must stand on their own.
  assert.equal(Number.isFinite(WORKSPACE_GUIDE_SECTION_ORDER), true)
  assert.equal(Number.isFinite(WORKSPACE_GUIDE_CONTEXT_ORDER), true)
  assert.equal(sections[0].name, WORKSPACE_GUIDE_SECTION)
  assert.equal(sections[0].order, WORKSPACE_GUIDE_SECTION_ORDER)
  assert.equal(contexts[0].name, WORKSPACE_GUIDE_CONTEXT)
  assert.equal(contexts[0].order, WORKSPACE_GUIDE_CONTEXT_ORDER)
  // A remote path is data, so the text must never be read as a template.
  assert.equal(sections[0].interpolate, false)
  assert.equal(contexts[0].interpolate, false)
  assert.equal(typeof sections[0].text, 'function')
  assert.equal(typeof contexts[0].text, 'function')
  assert.equal(sections[0].text, guide.section)
  assert.equal(contexts[0].text, guide.context)
})

test('the guide text is empty for a Session outside a remote workspace', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
    const guide = createWorkspacePromptGuide({
      directoryOf: (agent) => agent.session.cwd,
      resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
      hostNameFor: (connectionId) => (connectionId === 'conn1' ? 'dev-box' : undefined),
    })

    const localAgent = { session: { cwd: '/tmp/local-project' } }
    const local = { agent: localAgent, scope: localAgent }
    assert.equal(guide.section(local), '')
    assert.equal(guide.context(local), '')

    // No Agent at all, an Agent without a committed directory, and a broken
    // service must all stay silent instead of failing prompt assembly.
    assert.equal(guide.section(undefined), '')
    assert.equal(guide.section({}), '')
    assert.equal(guide.section({ agent: null }), '')
    assert.equal(guide.context(undefined), '')
    assert.equal(guide.context({ agent: {} }), '')

    const throwing = createWorkspacePromptGuide({
      directoryOf: () => { throw new Error('no session') },
      resolveTarget: () => null,
      hostNameFor: () => undefined,
    })
    assert.equal(throwing.section(local), '')
    assert.equal(throwing.context(local), '')
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the guide text names the host and the remote path for a remote Session', () => {
  const workspaceRoot = remoteWorkspaceRoot()
  try {
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
    const guide = createWorkspacePromptGuide({
      directoryOf: (agent) => agent.session.cwd,
      // The real Session directory is the remote POSIX path, which
      // `resolveTarget` maps back to its connection through the marker.
      resolveTarget: (cwd) => routing.resolveTarget(cwd, undefined),
      hostNameFor: (connectionId) => (connectionId === 'conn1' ? 'dev-box' : undefined),
    })

    const agent = { session: { cwd: '/data/ws' } }
    const context = { agent, scope: agent }
    const section = guide.section(context)
    const runtime = guide.context(context)

    assert.notEqual(section, '')
    assert.match(section, /dev-box/)
    assert.match(section, /\/data\/ws/)
    assert.match(section, /`bash`/)
    assert.match(section, /POSIX/)
    assert.match(section, /`grep`/)
    assert.match(section, /`glob`/)
    assert.match(section, /preview/)

    assert.notEqual(runtime, '')
    assert.match(runtime, /dev-box/)
    assert.match(runtime, /\/data\/ws/)

    // Remote paths and host names are interpolated literally by the section
    // and context helpers, so a brace in either must not look like a variable.
    assert.equal(section.includes('{{'), false)
    assert.equal(runtime.includes('{{'), false)

    // A renamed or deleted connection still yields usable text.
    const anonymous = createWorkspacePromptGuide({
      directoryOf: () => '/data/ws',
      resolveTarget: () => ({ connectionId: 'gone', path: '/data/ws' }),
      hostNameFor: () => undefined,
    })
    const anonymousContext = { agent: { session: {} } }
    assert.match(anonymous.section(anonymousContext), /remote host/)
    assert.match(anonymous.context(anonymousContext), /SSH host/)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('the guide text is built from the resolved target', () => {
  const section = workspaceGuideText({ host: 'dev-box', path: '/srv/app' })
  const runtime = workspaceContextText({ host: 'dev-box', path: '/srv/app' })
  assert.match(section, /^## Remote workspace/)
  assert.match(section, /dev-box/)
  assert.match(section, /\/srv\/app/)
  assert.match(runtime, /dev-box/)
  assert.match(runtime, /\/srv\/app/)
})
