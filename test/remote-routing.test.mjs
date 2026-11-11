import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { replaceRemoteFile, Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)

function fakeSftp(overrides) {
  const calls = []
  const base = {
    writeFile(...args) { calls.push(['writeFile', ...args.slice(0, -1)]); args.at(-1)(null) },
    rename(...args) { calls.push(['rename', ...args.slice(0, -1)]); args.at(-1)(new Error('Failure')) },
    unlink(...args) { calls.push(['unlink', ...args.slice(0, -1)]); args.at(-1)(null) },
  }
  const sftp = Object.assign(base, overrides ?? {})
  sftp.calls = calls
  return sftp
}

test('replaceRemoteFile prefers the posix-rename extension', async () => {
  const sftp = fakeSftp({
    ext_openssh_rename(...args) { sftp.calls.push(['ext', ...args.slice(0, -1)]); args.at(-1)(null) },
  })
  const strategy = await replaceRemoteFile(sftp, '/d/.tmp', '/d/f.txt', Buffer.from('x'))
  assert.equal(strategy, 'posix-rename')
  assert.equal(sftp.calls[0][0], 'ext')
  assert.equal(sftp.calls.length, 1)
})

test('replaceRemoteFile falls back to a plain rename', async () => {
  const sftp = fakeSftp({
    ext_openssh_rename(...args) { sftp.calls.push(['ext', ...args.slice(0, -1)]); args.at(-1)(new Error('unsupported')) },
    rename(...args) { sftp.calls.push(['rename', ...args.slice(0, -1)]); args.at(-1)(null) },
  })
  const strategy = await replaceRemoteFile(sftp, '/d/.tmp', '/d/f.txt', Buffer.from('x'))
  assert.equal(strategy, 'rename')
  assert.deepEqual(sftp.calls.map((call) => call[0]), ['ext', 'rename'])
})

test('replaceRemoteFile writes in place when both renames fail (OpenSSH overwrite)', async () => {
  const sftp = fakeSftp({
    ext_openssh_rename(...args) { sftp.calls.push(['ext', ...args.slice(0, -1)]); args.at(-1)(new Error('unsupported')) },
  })
  const buffer = Buffer.from('new content')
  const strategy = await replaceRemoteFile(sftp, '/d/.tmp', '/d/f.txt', buffer)
  assert.equal(strategy, 'direct-write')
  const last = sftp.calls.at(-1)
  assert.equal(last[0], 'writeFile')
  assert.equal(last[1], '/d/f.txt')
  assert.deepEqual(last[2], buffer)
})

test('replaceRemoteFile rejects when the in-place write also fails', async () => {
  const sftp = fakeSftp({
    ext_openssh_rename(...args) { args.at(-1)(new Error('unsupported')) },
    writeFile(...args) { args.at(-1)(new Error('disk failed')) },
  })
  await assert.rejects(replaceRemoteFile(sftp, '/d/.tmp', '/d/f.txt', Buffer.from('x')), /disk failed/)
})

test('resolveTarget maps /tmp absolute paths to the remote Session host', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-routing-'))
  try {
    const stub = join(workspaceRoot, 'conn1', 'ws-slug')
    mkdirSync(stub, { recursive: true })
    writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({ version: 1, connectionId: 'conn1', path: '/data/ws', host: 'dev-box' }))
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: () => undefined })

    assert.deepEqual(routing.resolveTarget('/tmp/x', '/data/ws/sub'), { connectionId: 'conn1', path: '/tmp/x' })
    assert.deepEqual(routing.resolveTarget('/var/log/app.log', '/data/ws'), { connectionId: 'conn1', path: '/var/log/app.log' })
    assert.deepEqual(routing.resolveTarget('/data/ws/a.txt', undefined), { connectionId: 'conn1', path: '/data/ws/a.txt' })
    assert.deepEqual(routing.resolveTarget('sub/a.txt', '/data/ws'), { connectionId: 'conn1', path: '/data/ws/sub/a.txt' })
    assert.equal(routing.resolveTarget('/tmp/x', 'E:\\local'), null)
    assert.equal(routing.resolveTarget('/tmp/x', undefined), null)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
