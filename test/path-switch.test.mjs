import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)

test('a POSIX cwd outside every remote workspace keeps local path semantics', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-local-'))
  try {
    const stub = join(workspaceRoot, 'conn1', 'ws-slug')
    mkdirSync(stub, { recursive: true })
    writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({ version: 1, connectionId: 'conn1', path: '/data/ws', host: 'dev-box' }))
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
    // `/` is the local drive root produced by `cd /`; switching to a local
    // Windows path must not be rejected as a remote escape.
    assert.equal(routing.resolveTarget('E:\\ai-workspace\\Deepseek Harness', '/'), null)
    assert.equal(routing.resolveTarget('/tmp/x', '/'), null)
    assert.equal(routing.resolveTarget('E:\\x', '/'), null)
    // Inside a remote workspace, an explicit Windows path still means the
    // local machine (remote development needs local resources), while POSIX
    // paths stay on the remote host.
    assert.equal(routing.resolveTarget('C:\\Users\\001\\.ssh\\id_rsa', '/data/ws'), null)
    assert.deepEqual(routing.resolveTarget('/tmp/x', '/data/ws'), { connectionId: 'conn1', path: '/tmp/x' })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
