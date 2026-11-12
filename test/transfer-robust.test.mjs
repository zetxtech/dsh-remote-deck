/**
 * Host-side transfer robustness: the archive command, the scan command and its
 * parser, and the two API routes that use them.
 *
 * The builders are asserted as exact shell strings, and the promises that
 * matter — symlinks never enter the archive, an unreadable entry is counted
 * instead of failing the walk, a killed scan parses as incomplete — are checked
 * by running the generated shell against a temp tree on this machine. No
 * remote host is involved.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApi } from '../lib/api.js'
import { archiveCommand, parseScanOutput, scanCommand } from '../lib/transfer.js'

const POSIX_TOOLS =
  process.platform !== 'win32' &&
  spawnSync('sh', ['-c', 'command -v find >/dev/null && command -v tar >/dev/null && command -v du >/dev/null']).status === 0
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const GNU_TAR = POSIX_TOOLS && /GNU/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout)

// ------------------------------------------------------------- commands

test('archive command lists regular files and directories only, then tars that list', () => {
  const command = archiveCommand('app')
  assert.match(command, /find 'app' -xdev \\\( -type f -o -type d \\\) -print0 \| tar czf - --null --no-recursion \$extra -T -/)
  // `-print0` input must reach tar as NUL-delimited, and the directory entries
  // from `find` must not be re-walked by tar (that would re-add symlinks).
  assert.match(command, /--null/)
  assert.match(command, /--no-recursion/)
  assert.match(command, /-print0/)
  // No `-type l`, no `-L`: the walk never lists or follows a symlink.
  assert.doesNotMatch(command, /-type l\b/)
  assert.doesNotMatch(command, /find[^\n]*-L\b/)
  // GNU tar skips unreadable files; BSD tar needs no flag, so it is detected.
  assert.match(command, /case "\$\(tar --version 2>\/dev\/null \| head -1\)" in \*GNU\*\)/)
  assert.match(command, /extra="--ignore-failed-read"/)
  assert.match(command, /extra=""/)
  // A tar without --null (BusyBox) is probed first and falls back to recursion.
  assert.match(command, /if tar --null --no-recursion -cf \/dev\/null -T \/dev\/null 2>\/dev\/null; then/)
  assert.match(command, /else\n  tar czf - \$extra 'app'\nfi/)
})

test('archive command quotes the folder name', () => {
  assert.match(archiveCommand('my app'), /find 'my app' /)
  assert.match(archiveCommand("it's"), /find 'it'\\''s' /)
  // A leading dash must not become an option to find.
  assert.match(archiveCommand('-rf'), /find '\.\/-rf' /)
})

/** The scan body is single-quoted as a whole, so an inner quoted path escapes twice. */
const escapedOnce = (text) => text.replace(/'/g, `'\\''`)

test('scan command is one time-boxed, rate-limited traversal', () => {
  const command = scanCommand('/srv/app')
  assert.ok(command.includes(`find ${escapedOnce("'/srv/app'")} -xdev -mindepth 1 -exec sh -c `), command)
  assert.match(command, /sort \| uniq -c/)
  assert.match(command, /command -v timeout/)
  assert.match(command, /timeout 20 sh -c /)
  // Symlinks are classified before directories, so a link to a directory is
  // never mistaken for one (and never descended).
  assert.match(command, /if \[ -L "\$p" \]; then echo l/)
  assert.match(command, /elif \[ -d "\$p" \]; then if \[ -r "\$p" \] && \[ -x "\$p" \]; then echo d; else echo u; fi/)
  assert.match(command, /elif \[ -f "\$p" \]; then if \[ -r "\$p" \]; then echo f; else echo u; fi/)
  assert.ok(command.includes(`du -sb ${escapedOnce("'/srv/app'")}`), command)
  assert.ok(command.includes(`du -sk ${escapedOnce("'/srv/app'")}`), command)
  assert.match(command, /rdscan-bytes/)
  assert.match(command, /rdscan-done/)
  assert.match(command, /rdscan-timeout/)
  // find's own permission diagnostics must not be read as counts.
  assert.match(command, /2>\/dev\/null/)
})

// -------------------------------------------------------------- parser

test('parseScanOutput reads a complete answer', () => {
  const parsed = parseScanOutput('      1 o\n     12 f\n      3 d\nrdscan-bytes 4096\n      2 l\n      5 u\nrdscan-done\n')
  assert.deepEqual(parsed, {
    files: 12,
    dirs: 3,
    links: 2,
    unreadable: 5,
    others: 1,
    bytes: 4096,
    complete: true,
  })
})

test('parseScanOutput tolerates missing, reordered and unknown lines', () => {
  assert.deepEqual(parseScanOutput(''), {
    files: 0,
    dirs: 0,
    links: 0,
    unreadable: 0,
    others: 0,
    bytes: 0,
    complete: false,
  })
  assert.deepEqual(parseScanOutput(undefined), {
    files: 0,
    dirs: 0,
    links: 0,
    unreadable: 0,
    others: 0,
    bytes: 0,
    complete: false,
  })
  // Only a file count and the end marker: everything else stays at zero.
  const sparse = parseScanOutput('7 f\nrdscan-done\n')
  assert.equal(sparse.files, 7)
  assert.equal(sparse.dirs, 0)
  assert.equal(sparse.complete, true)
  // Out of order, CRLF endings and an unknown line are all fine.
  const shuffled = parseScanOutput('rdscan-bytes 12\nnot a count\nrdscan-done\n2 d\r\n9 files\r\n')
  assert.equal(shuffled.bytes, 12)
  assert.equal(shuffled.dirs, 2)
  assert.equal(shuffled.files, 9)
  assert.equal(shuffled.complete, true)
  // Bytes alone do not prove the walk finished.
  assert.equal(parseScanOutput('3 f\nrdscan-bytes 9\n').complete, false)
})

test('parseScanOutput marks a killed scan incomplete but keeps its counts', () => {
  // A cut mid-line: the trailing fragment is ignored.
  const truncated = parseScanOutput('      4 f\n      1 d\n    1')
  assert.deepEqual(truncated, {
    files: 4,
    dirs: 1,
    links: 0,
    unreadable: 0,
    others: 0,
    bytes: 0,
    complete: false,
  })
  // `timeout` killed the remote script after part of the answer was written.
  const timedOut = parseScanOutput('      4 f\nrdscan-bytes 100\nrdscan-timeout\n')
  assert.equal(timedOut.files, 4)
  assert.equal(timedOut.complete, false)
  // An explicit timeout marker wins even if a done marker also shows up.
  assert.equal(parseScanOutput('rdscan-done\nrdscan-timeout\n').complete, false)
})

// ------------------------------------------- the commands, actually run

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'rd-robust-'))
  const app = join(root, 'app')
  mkdirSync(join(app, 'sub'), { recursive: true })
  mkdirSync(join(app, 'sealed'), { recursive: true })
  writeFileSync(join(app, 'a.txt'), 'hello')
  writeFileSync(join(app, 'sub', 'b.txt'), 'abc')
  writeFileSync(join(app, 'sealed', 'hidden.txt'), 'z')
  writeFileSync(join(app, 'locked.txt'), 'x')
  symlinkSync('a.txt', join(app, 'link'))
  symlinkSync('.', join(app, 'loop'))
  symlinkSync('sub', join(app, 'dirlink'))
  chmodSync(join(app, 'locked.txt'), 0o000)
  chmodSync(join(app, 'sealed'), 0o000)
  return { root, app }
}

function dropTree(tree) {
  // Restore the modes first: rm cannot descend into a directory it may not read.
  try {
    chmodSync(join(tree.app, 'sealed'), 0o755)
    chmodSync(join(tree.app, 'locked.txt'), 0o644)
  } catch {
    /* already gone */
  }
  rmSync(tree.root, { recursive: true, force: true })
}

function runShell(command, options = {}) {
  return spawnSync('sh', ['-c', command], { encoding: 'utf8', ...options })
}

/** A folder name with a space and a quote must survive both builders. */
const QUOTED_NAME = "it's app"

test('the commands survive a folder name with a space and a quote', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-quote-'))
  const app = join(root, QUOTED_NAME)
  try {
    mkdirSync(join(app, 'deep'), { recursive: true })
    writeFileSync(join(app, 'deep', 'a b.txt'), 'hello')
    const scanned = parseScanOutput(runShell(scanCommand(app)).stdout)
    assert.equal(scanned.complete, true)
    assert.equal(scanned.files, 1)
    assert.equal(scanned.dirs, 1)

    const run = spawnSync('sh', ['-c', archiveCommand(QUOTED_NAME)], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    const archive = join(root, 'quoted.tgz')
    writeFileSync(archive, run.stdout)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    const names = listing.stdout.split('\n').filter((line) => line.length > 0).sort()
    assert.deepEqual(names, [`${QUOTED_NAME}/`, `${QUOTED_NAME}/deep/`, `${QUOTED_NAME}/deep/a b.txt`].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the archive command falls back to recursion on a tar without --null', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const tree = makeTree()
  const bin = mkdtempSync(join(tmpdir(), 'rd-bin-'))
  try {
    const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim()
    // BusyBox tar rejects --null, so the probe must fail and the fallback run.
    writeFileSync(
      join(bin, 'tar'),
      ['#!/bin/sh', 'case "$*" in', "  *--null*) echo \"tar: unrecognized option '--null'\" >&2; exit 1;;", 'esac', `exec ${realTar} "$@"`].join('\n'),
    )
    chmodSync(join(bin, 'tar'), 0o755)
    const run = spawnSync('sh', ['-c', archiveCommand('app')], {
      cwd: tree.root,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    const archive = join(tree.root, 'fallback.tgz')
    writeFileSync(archive, run.stdout)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
    const names = listing.stdout.split('\n').filter((line) => line.length > 0)
    assert.deepEqual(new Set(names).size, names.length, `duplicate entries: ${names.join(', ')}`)
    for (const name of ['app/', 'app/sub/', 'app/sub/b.txt', 'app/a.txt']) assert.ok(names.includes(name), `${name} missing from ${names.join(', ')}`)
    // The fallback recurses, so links are stored as links rather than skipped.
    assert.ok(names.includes('app/link'), names.join(', '))
    if (GNU_TAR) assert.equal(run.status, 0, String(run.stderr))
  } finally {
    rmSync(bin, { recursive: true, force: true })
    dropTree(tree)
  }
})

test('the scan command counts links, unreadable entries and bytes', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const tree = makeTree()
  try {
    const run = runShell(scanCommand(tree.app))
    assert.equal(run.status, 0, run.stderr)
    const parsed = parseScanOutput(run.stdout)
    assert.equal(parsed.complete, true, run.stdout)
    // a.txt and sub/b.txt; `sealed` is unreadable so hidden.txt is not seen.
    assert.equal(parsed.files, AS_ROOT ? 3 : 2, run.stdout)
    assert.equal(parsed.dirs, AS_ROOT ? 2 : 1, run.stdout)
    // link, loop and dirlink: counted, never followed (a followed loop would hang).
    assert.equal(parsed.links, 3, run.stdout)
    assert.equal(parsed.unreadable, AS_ROOT ? 0 : 2, run.stdout)
    assert.equal(parsed.others, 0, run.stdout)
    assert.ok(parsed.bytes > 0)
  } finally {
    dropTree(tree)
  }
})

test('the scan command falls back to du -sk when du -sb is missing', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const tree = makeTree()
  const bin = mkdtempSync(join(tmpdir(), 'rd-bin-'))
  try {
    const realDu = spawnSync('sh', ['-c', 'command -v du'], { encoding: 'utf8' }).stdout.trim()
    // BSD du has no -b: the fallback must still produce a byte total.
    writeFileSync(
      join(bin, 'du'),
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = "-sb" ]; then echo "du: illegal option -- b" >&2; exit 1; fi',
        'done',
        `exec ${realDu} "$@"`,
      ].join('\n'),
    )
    chmodSync(join(bin, 'du'), 0o755)
    const run = runShell(scanCommand(tree.app), { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    const parsed = parseScanOutput(run.stdout)
    assert.equal(parsed.complete, true, run.stdout)
    assert.ok(parsed.bytes >= 1024, run.stdout)
    assert.equal(parsed.bytes % 1024, 0, 'the -sk fallback counts 1024-byte blocks')
  } finally {
    rmSync(bin, { recursive: true, force: true })
    dropTree(tree)
  }
})

test('the scan command reports a timeout and stays incomplete', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const tree = makeTree()
  const bin = mkdtempSync(join(tmpdir(), 'rd-bin-'))
  try {
    // A `timeout` that runs the scan and then reports 124, as a real one would
    // after killing it; the answer must be marked incomplete either way.
    writeFileSync(join(bin, 'timeout'), ['#!/bin/sh', 'shift 1', '"$@"', 'exit 124'].join('\n'))
    chmodSync(join(bin, 'timeout'), 0o755)
    const run = runShell(scanCommand(tree.app), { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.match(run.stdout, /rdscan-timeout/)
    const parsed = parseScanOutput(run.stdout)
    assert.equal(parsed.complete, false)
    assert.ok(parsed.files > 0, run.stdout)
  } finally {
    rmSync(bin, { recursive: true, force: true })
    dropTree(tree)
  }
})

test('the archive command leaves symlinks and unreadable files out', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const tree = makeTree()
  try {
    const run = spawnSync('sh', ['-c', archiveCommand('app')], { cwd: tree.root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    const archive = join(tree.root, 'out.tgz')
    writeFileSync(archive, run.stdout)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    const names = listing.stdout.split('\n').filter((line) => line.length > 0)
    // Exactly the regular files and directories, each named once: `tar` must
    // not re-walk the directories in the list (that would add the symlinks).
    assert.deepEqual(new Set(names).size, names.length, `duplicate entries: ${names.join(', ')}`)
    for (const name of ['app/', 'app/sub/', 'app/sub/b.txt', 'app/a.txt']) assert.ok(names.includes(name), `${name} missing from ${names.join(', ')}`)
    for (const name of ['app/link', 'app/dirlink', 'app/loop']) assert.ok(!names.includes(name), `${name} must not be archived`)
    if (GNU_TAR && !AS_ROOT) {
      // --ignore-failed-read: the locked file is skipped, the download succeeds.
      assert.equal(run.status, 0, String(run.stderr))
      assert.ok(!names.includes('app/locked.txt'), 'an unreadable file is skipped')
      assert.ok(!names.includes('app/sealed/hidden.txt'), 'an unreadable directory is not followed')
    }
  } finally {
    dropTree(tree)
  }
})

// ------------------------------------------------------------- the API

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = {
  id: 'c1',
  name: 'ws',
  host: 'example.test',
  port: 22,
  username: 'demo',
  authType: 'key',
  privateKeyPath: '/k',
  color: 'blue',
}

const SCAN_STDOUT = '      1 o\n     12 f\n      3 d\n      2 l\n      5 u\nrdscan-bytes 4096\nrdscan-done\n'

async function startApi({ scanOutput = SCAN_STDOUT, isDirectory = () => true, runCommand } = {}) {
  const calls = { run: [], stream: [] }
  const sftp = {
    stat(path, callback) {
      const directory = isDirectory(path)
      callback(null, { isDirectory: () => directory, isFile: () => !directory, size: 0, mtime: 0 })
    },
  }
  const host = {
    ensure: async () => {},
    requireSftp: () => sftp,
    runCommand: async (command, cwd, options) => {
      calls.run.push({ command, cwd, options })
      if (typeof runCommand === 'function') return await runCommand(command, cwd, options)
      return { code: 0, signal: null, stdout: scanOutput, stderr: '' }
    },
    streamCommand: async (command, cwd) => {
      calls.stream.push({ command, cwd })
      const stream = Readable.from([Buffer.from('TARGZ')])
      stream.stderr = new EventEmitter()
      return stream
    },
  }
  const server = createApi({
    token: TOKEN,
    store: { get: (id) => (id === RECORD.id ? RECORD : undefined), list: () => [RECORD] },
    secrets: { describe: async () => ({}) },
    hostFor: (id) => (id === RECORD.id ? host : undefined),
    listHosts: () => [],
    routing: { listWorkspaces: () => [], invalidate: () => {} },
    getRegistry: () => undefined,
    build: 'test',
    dataDir: mkdtempSync(join(tmpdir(), 'rd-robust-api-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('scan answers with parsed totals, path and duration', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/scan?path=/srv/app`, { headers: { [TOKEN_HEADER]: TOKEN } })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(
      { files: body.files, dirs: body.dirs, links: body.links, unreadable: body.unreadable, others: body.others, bytes: body.bytes, complete: body.complete },
      { files: 12, dirs: 3, links: 2, unreadable: 5, others: 1, bytes: 4096, complete: true },
    )
    assert.equal(body.path, '/srv/app')
    assert.equal(typeof body.durationMs, 'number')
    assert.ok(body.durationMs >= 0)
    const [call] = api.calls.run
    assert.equal(call.command, scanCommand('/srv/app'))
    assert.equal(call.cwd, null)
    assert.equal(call.options.maxBytes, 256 * 1024)
    assert.ok(call.options.signal instanceof AbortSignal)
    assert.equal(call.options.signal.aborted, false)
  } finally {
    await api.close()
  }
})

test('scan rejects a relative path, an unknown connection and a file target', async () => {
  const api = await startApi({ isDirectory: (path) => path !== '/srv/app/a.txt' })
  try {
    const relative = await fetch(`${api.base}/connections/c1/scan?path=srv/app`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(relative.status, 400)
    assert.equal((await relative.json()).code, 'NOT_REMOTE_PATH')

    const missing = await fetch(`${api.base}/connections/nope/scan?path=/srv/app`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(missing.status, 404)

    const file = await fetch(`${api.base}/connections/c1/scan?path=/srv/app/a.txt`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert.equal(file.status, 400)

    // A JSON route stays header-token only.
    const query = await fetch(`${api.base}/connections/c1/scan?path=/srv/app&token=${TOKEN}`)
    assert.equal(query.status, 403)
    assert.equal(api.calls.run.length, 0)
  } finally {
    await api.close()
  }
})

test('scan still answers when the read was cut short', async () => {
  // What runCommand hands back after an abort: partial stdout, no done marker.
  const api = await startApi({ runCommand: async () => ({ code: -1, signal: null, stdout: '      7 f\n      2 d\n', stderr: 'aborted' }) })
  try {
    const response = await fetch(`${api.base}/connections/c1/scan?path=/srv/app`, { headers: { [TOKEN_HEADER]: TOKEN } })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.files, 7)
    assert.equal(body.dirs, 2)
    assert.equal(body.complete, false)
  } finally {
    await api.close()
  }
})

const CAN_MOCK_TIMERS = typeof mock.timers?.enable === 'function'

/** undici registers timers of its own, which a mocked clock would clear out from under it. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: { [TOKEN_HEADER]: TOKEN, connection: 'close' }, agent: false }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        text += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    })
    request.on('error', reject)
    request.end()
  })
}

test(
  'scan aborts its remote read after the timeout and answers incomplete',
  { skip: CAN_MOCK_TIMERS ? false : 'node:test mock timers unavailable' },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let started
    const startedReading = new Promise((resolve) => {
      started = resolve
    })
    const api = await startApi({
      runCommand: (_command, _cwd, options) =>
        new Promise((resolve) => {
          started()
          options.signal.addEventListener(
            'abort',
            () => resolve({ code: -1, signal: null, stdout: '      4 f\n', stderr: 'aborted' }),
            { once: true },
          )
        }),
    })
    try {
      const pending = getJson(`${api.base}/connections/c1/scan?path=/srv/app`)
      await startedReading
      t.mock.timers.tick(20000)
      const { status, body } = await pending
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.files, 4)
      assert.equal(body.complete, false)
    } finally {
      await api.close()
    }
  },
)

test('archive streams the new command with the folder parent as cwd', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/archive?path=/srv/app&token=${TOKEN}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/gzip')
    assert.match(response.headers.get('content-disposition') || '', /app\.tar\.gz/)
    assert.equal(await response.text(), 'TARGZ')
    const [call] = api.calls.stream
    assert.equal(call.command, archiveCommand('app'))
    assert.equal(call.cwd, '/srv')
  } finally {
    await api.close()
  }
})
