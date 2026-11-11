import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { readJsonFile, sftpCall } = await import(pathToFileURL(`${root}/lib/util.js`).href)
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)
const { renderBashResult } = await import(pathToFileURL(`${root}/lib/bash-result.js`).href)

test('readJsonFile tolerates a UTF-8 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-bom-'))
  try {
    const file = join(dir, 'marker.json')
    writeFileSync(file, '\uFEFF{"version":1,"connectionId":"c1","path":"/data/ws"}', 'utf8')
    assert.deepEqual(readJsonFile(file, null), { version: 1, connectionId: 'c1', path: '/data/ws' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sftpCall rejects when the SFTP layer stops responding', async () => {
  const previous = process.env.DSH_REMOTE_DECK_SFTP_TIMEOUT_MS
  process.env.DSH_REMOTE_DECK_SFTP_TIMEOUT_MS = '80'
  try {
    const stuck = { readFile: () => {} }
    await assert.rejects(sftpCall(stuck, 'readFile', '/data/x'), /did not finish within 80ms/)
  } finally {
    if (previous === undefined) delete process.env.DSH_REMOTE_DECK_SFTP_TIMEOUT_MS
    else process.env.DSH_REMOTE_DECK_SFTP_TIMEOUT_MS = previous
  }
})

test('renderBashResult does not fake an exit code beside a transport error', () => {
  const rendered = renderBashResult({ stdout: '', code: -1, transportError: 'socket closed' })
  assert.match(rendered.text, /\[transport error: socket closed\]/)
  assert.doesNotMatch(rendered.text, /\[exit code:/)
})

test('remote Sessions keep both remote POSIX and local Windows routing', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-guard-'))
  try {
    const stub = join(workspaceRoot, 'conn1', 'ws-slug')
    mkdirSync(stub, { recursive: true })
    writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({ version: 1, connectionId: 'conn1', path: '/data/ws', host: 'dev-box' }))
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })
    assert.equal(routing.resolveTarget('C:\\Users\\001\\.ssh\\id_rsa', '/data/ws'), null)
    assert.equal(routing.resolveTarget('..\\..\\secret.txt', '/data/ws'), null)
    assert.deepEqual(routing.resolveTarget('../../etc/passwd', '/data/ws'), { connectionId: 'conn1', path: '/etc/passwd' })
    assert.deepEqual(routing.resolveTarget('sub/file.txt', '/data/ws'), { connectionId: 'conn1', path: '/data/ws/sub/file.txt' })
    assert.deepEqual(routing.resolveTarget('/tmp/x', '/data/ws'), { connectionId: 'conn1', path: '/tmp/x' })
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
