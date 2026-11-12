/**
 * Multi-path archive download: one `tar.gz` for a multi-selection, and the
 * shipped single-folder behaviour left untouched.
 *
 * Hermetic. The generated shell is asserted as text and then *run* against a
 * real tree (POSIX tools permitting), so flatness, the excluded link/FIFO and
 * the skipped missing path are checked against tar itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApi } from '../lib/api.js'
import { archiveCommand, archivePathsCommand } from '../lib/transfer.js'

/** The command a single `path` has produced since 1.5.0 — this must not drift. */
const SINGLE_PATH_COMMAND = [
  'extra=""',
  'case "$(tar --version 2>/dev/null | head -1)" in *GNU*) extra="--ignore-failed-read";; esac',
  'if tar --null --no-recursion -cf /dev/null -T /dev/null 2>/dev/null; then',
  "  find 'app' -xdev \\( -type f -o -type d \\) -print0 | tar czf - --null --no-recursion $extra -T -",
  'else',
  "  tar czf - $extra 'app'",
  'fi',
].join('\n')

const POSIX_TOOLS = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'command -v sh >/dev/null && command -v tar >/dev/null && command -v mktemp >/dev/null']).status === 0

// ------------------------------------------------------------- the commands

test('the single-path command is byte for byte what it was', () => {
  assert.equal(archiveCommand('app'), SINGLE_PATH_COMMAND)
  assert.equal(archiveCommand("it's"), SINGLE_PATH_COMMAND.replaceAll("'app'", "'it'\\''s'"))
})

test('several paths become one tar call with one -C group per path', () => {
  const command = archivePathsCommand(['/srv/app', '/other/data', '/srv/notes.txt'])
  // One archive, one group per path, in the order the client sent them.
  assert.ok(
    command.includes(`-C '/srv' -T "$listdir/0" -C '/other' -T "$listdir/1" -C '/srv' -T "$listdir/2"`),
    command,
  )
  assert.equal(command.match(/tar czf - /g).length, 2, command) // the real one, and the fallback
  assert.ok(command.includes('tar czf - --null --no-recursion $extra '))
  // Each group lists its own tree relative to its own parent, so the members
  // come out flat: `app/...`, not `srv/app/...`.
  assert.ok(command.includes(`( cd '/srv' && find 'app' -xdev \\( -type f -o -type d \\) -print0 > "$listdir/0" ) || :`), command)
  assert.ok(command.includes(`( cd '/other' && find 'data' -xdev \\( -type f -o -type d \\) -print0 > "$listdir/1" ) || :`), command)
  assert.ok(command.includes(`( cd '/srv' && find 'notes.txt' -xdev \\( -type f -o -type d \\) -print0 > "$listdir/2" ) || :`), command)
  // The lists are private and removed whatever tar does.
  assert.ok(command.includes('&& listdir=$(mktemp -d 2>/dev/null); then'))
  assert.ok(command.includes(`trap 'rm -rf "$listdir"' EXIT HUP INT TERM`))
  // GNU still skips an unreadable entry, and the fallback stays available.
  assert.ok(command.includes('*GNU*) extra="--ignore-failed-read";; esac'))
  assert.ok(command.includes('tar --null --no-recursion -cf /dev/null -T /dev/null 2>/dev/null'))
})

test('a parent or a name that needs quoting is quoted', () => {
  const command = archivePathsCommand(["/srv/it's app/notes", '/srv/-rf'])
  assert.ok(command.includes(`( cd '/srv/it'\\''s app' && find 'notes' `), command)
  // A leading dash must stay a path for find, not an option.
  assert.ok(command.includes(`( cd '/srv' && find './-rf' `), command)
})

test('the fallback keeps every path in one tar call with relative names', () => {
  // A shared parent stays as flat as the selection was.
  const same = archivePathsCommand(['/srv/a', '/srv/b'])
  assert.ok(same.includes(`  ( cd '/srv' && tar czf - $extra 'a' 'b' ) || :`), same)
  // A spread selection is archived from the deepest common directory: still one
  // invocation (concatenated tars are unreadable to a normal extractor).
  const spread = archivePathsCommand(['/srv/app', '/other/data'])
  assert.ok(spread.includes(`  ( cd '/' && tar czf - $extra 'srv/app' 'other/data' ) || :`), spread)
  const nested = archivePathsCommand(['/a/b', '/a/b/c'])
  assert.ok(nested.includes(`  ( cd '/a' && tar czf - $extra 'b' 'b/c' ) || :`), nested)
})

test('the multi-path command archives a flat tree, skips a missing path and cleans up', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-archive-multi-'))
  const listTemp = join(root, 'tmp')
  mkdirSync(listTemp)
  try {
    mkdirSync(join(root, 'srv/app/sub'), { recursive: true })
    mkdirSync(join(root, 'other/data'), { recursive: true })
    writeFileSync(join(root, 'srv/app/f1.txt'), 'one')
    writeFileSync(join(root, 'srv/app/sub/f2.txt'), 'two')
    writeFileSync(join(root, 'other/data/f3.txt'), 'three')
    writeFileSync(join(root, 'srv/loose.txt'), 'loose')
    symlinkSync('/etc/passwd', join(root, 'srv/app/evil-link'))
    const madeFifo = spawnSync('mkfifo', [join(root, 'other/data/pipe')]).status === 0

    const command = archivePathsCommand([
      join(root, 'srv/app'),
      join(root, 'other/data'),
      join(root, 'srv/loose.txt'),
      join(root, 'srv/gone.txt'),
    ])
    const run = spawnSync('sh', ['-c', command], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TMPDIR: listTemp },
    })
    // A path that vanished since the listing is a line on stderr, not a failure.
    assert.match(run.stderr.toString(), /gone\.txt/)
    assert.equal(run.status, 0, run.stderr.toString())
    assert.deepEqual(readdirSync(listTemp), [], 'the private list directory must be removed')

    const archive = join(root, 'out.tgz')
    writeFileSync(archive, run.stdout)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    assert.deepEqual(listing.stdout.split('\n').filter(Boolean).sort(), [
      'app/',
      'app/f1.txt',
      'app/sub/',
      'app/sub/f2.txt',
      'data/',
      'data/f3.txt',
      'loose.txt',
    ])
    assert.ok(!listing.stdout.includes('evil-link'), 'a symlink is never archived')
    if (madeFifo) assert.ok(!listing.stdout.includes('pipe'), 'a FIFO is never archived')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a tar without --null still archives the whole selection in one call', { skip: !POSIX_TOOLS && 'POSIX tools unavailable' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-archive-fallback-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  try {
    const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(
      join(bin, 'tar'),
      ['#!/bin/sh', 'case "$*" in', '  *--null*) echo "tar: unrecognized option" >&2; exit 1;;', 'esac', `exec ${realTar} "$@"`].join('\n'),
    )
    chmodSync(join(bin, 'tar'), 0o755)

    mkdirSync(join(root, 'srv/app'), { recursive: true })
    mkdirSync(join(root, 'other/data'), { recursive: true })
    writeFileSync(join(root, 'srv/app/f1.txt'), 'one')
    writeFileSync(join(root, 'other/data/f2.txt'), 'two')

    const run = spawnSync('sh', ['-c', archivePathsCommand([join(root, 'srv/app'), join(root, 'other/data')])], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    const archive = join(root, 'fallback.tgz')
    writeFileSync(archive, run.stdout)
    const listing = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    const names = listing.stdout.split('\n').filter(Boolean).sort()
    // One readable archive: both trees are present, named relative to the
    // directory the selection shares.
    assert.deepEqual(names, ['other/data/', 'other/data/f2.txt', 'srv/app/', 'srv/app/f1.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the route

const TOKEN = 'test-token'
const TOKEN_HEADER = 'x-dsh-remote-token'
const RECORD = { id: 'c1', name: 'ws', host: 'example.test', port: 22, username: 'demo', authType: 'key', privateKeyPath: '/k', color: 'blue' }

async function startApi({ archiveBytes = 'FAKEGZIP', isDirectory = () => true } = {}) {
  const calls = { stream: [], stat: [] }
  const sftp = {
    stat(path, callback) {
      calls.stat.push(path)
      const directory = isDirectory(path)
      callback(null, { isDirectory: () => directory, isFile: () => !directory, size: 0, mtime: 0 })
    },
  }
  const host = {
    ensure: async () => {},
    requireSftp: () => sftp,
    streamCommand: async (command, cwd) => {
      calls.stream.push({ command, cwd })
      const stream = Readable.from([Buffer.from(archiveBytes)])
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
    dataDir: mkdtempSync(join(tmpdir(), 'rd-archive-api-')),
    readSshConfig: () => ({ path: '', exists: false, hosts: [], keys: [] }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

const archiveUrl = (base, query) => `${base}/connections/c1/archive?${query}&token=${TOKEN}`

test('one path keeps the shipped route behaviour', async () => {
  const api = await startApi()
  try {
    const response = await fetch(archiveUrl(api.base, 'path=/srv/app'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/gzip')
    assert.match(response.headers.get('content-disposition') || '', /app\.tar\.gz/)
    assert.equal(await response.text(), 'FAKEGZIP')
    assert.deepEqual(api.calls.stat, ['/srv/app'])
    assert.deepEqual(api.calls.stream, [{ command: archiveCommand('app'), cwd: '/srv' }])
  } finally {
    await api.close()
  }
})

test('one path is still refused when it is not a folder', async () => {
  const api = await startApi({ isDirectory: () => false })
  try {
    const response = await fetch(archiveUrl(api.base, 'path=/srv/app/a.txt'))
    assert.equal(response.status, 400)
    assert.equal(api.calls.stream.length, 0)
  } finally {
    await api.close()
  }
})

test('several paths stream one archive without stat-ing anything', async () => {
  const api = await startApi()
  try {
    const response = await fetch(archiveUrl(api.base, 'path=/srv/app&path=/other/data'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/gzip')
    // The name keeps the shipped rule: the first selection, plus .tar.gz.
    assert.match(response.headers.get('content-disposition') || '', /app\.tar\.gz/)
    assert.equal(await response.text(), 'FAKEGZIP')
    // A multi-selection may hold files, and a path that is already gone is
    // skipped by the remote command, so nothing is stat'ed up front.
    assert.deepEqual(api.calls.stat, [])
    assert.deepEqual(api.calls.stream, [{ command: archivePathsCommand(['/srv/app', '/other/data']), cwd: null }])
  } finally {
    await api.close()
  }
})

test('several paths keep the request order and may be files', async () => {
  const api = await startApi()
  try {
    const response = await fetch(archiveUrl(api.base, 'path=/b/notes.txt&path=/a/dir'))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') || '', /notes\.txt\.tar\.gz/)
    assert.deepEqual(api.calls.stream, [{ command: archivePathsCommand(['/b/notes.txt', '/a/dir']), cwd: null }])
    const command = api.calls.stream[0].command
    assert.ok(command.indexOf(`-C '/b' -T "$listdir/0"`) < command.indexOf(`-C '/a' -T "$listdir/1"`))
  } finally {
    await api.close()
  }
})

test('a repeated path is collapsed to one member group', async () => {
  const api = await startApi()
  try {
    const response = await fetch(archiveUrl(api.base, 'path=/srv/app&path=/srv/app/&path=/srv/app'))
    assert.equal(response.status, 200)
    const command = api.calls.stream[0].command
    assert.ok(command.includes('-T "$listdir/0"'), command)
    assert.ok(!command.includes('listdir/1'), command)
  } finally {
    await api.close()
  }
})

test('an invalid path in a multi-selection is refused before anything runs', async () => {
  const api = await startApi()
  try {
    for (const query of ['path=/srv/app&path=relative/x', 'path=/srv/app&path=/x/../etc', 'path=/srv/app&path=/', 'path=/srv/app&path=']) {
      const response = await fetch(archiveUrl(api.base, query))
      assert.equal(response.status, 400, query)
      assert.equal((await response.json()).code, 'NOT_REMOTE_PATH', query)
    }
    assert.equal(api.calls.stream.length, 0)
    assert.equal(api.calls.stat.length, 0)
  } finally {
    await api.close()
  }
})

test('more than two hundred paths is refused, two hundred is accepted', async () => {
  const api = await startApi()
  try {
    const tooMany = Array.from({ length: 201 }, (_, index) => `path=/d/p${index}`).join('&')
    const refused = await fetch(archiveUrl(api.base, tooMany))
    assert.equal(refused.status, 400)
    assert.equal((await refused.json()).code, 'TOO_MANY_PATHS')
    assert.equal(api.calls.stream.length, 0)

    const atCap = Array.from({ length: 200 }, (_, index) => `path=/d/p${index}`).join('&')
    const accepted = await fetch(archiveUrl(api.base, atCap))
    assert.equal(accepted.status, 200)
    assert.equal(await accepted.text(), 'FAKEGZIP')
    assert.equal(api.calls.stream.length, 1)
    assert.equal(api.calls.stream[0].cwd, null)
    assert.equal(api.calls.stream[0].command.match(/-C /g).length, 200)
  } finally {
    await api.close()
  }
})

test('the multi-path route needs the token', async () => {
  const api = await startApi()
  try {
    const response = await fetch(`${api.base}/connections/c1/archive?path=/srv/app&path=/other/data`)
    assert.equal(response.status, 403)
    assert.equal(api.calls.stream.length, 0)
  } finally {
    await api.close()
  }
})
