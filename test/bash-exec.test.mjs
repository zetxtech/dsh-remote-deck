import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { after, before, describe, test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromPlugin = createRequire(pathToFileURL(`${root}/lib/connection.js`))
const ssh2 = requireFromPlugin('../vendor/node_modules/ssh2/lib/index.js')
const { RemoteHost, buildCommandScript, buildSupervisedScript } = await import(pathToFileURL(`${root}/lib/connection.js`).href)
const { resolveWorkdir, renderBashResult, renderPromoted } = await import(pathToFileURL(`${root}/lib/bash-result.js`).href)

const CAP = 4096
const calls = []
let server
let host
let port

function handleExec(stream, command) {
  const entry = { command, at: Date.now(), stdinEndedAt: null }
  calls.push(entry)
  if (command.includes('__mock_stdin_wait__')) {
    stream.on('data', () => {})
    stream.on('end', () => {
      entry.stdinEndedAt = Date.now()
      stream.write('EOF-received\n')
      stream.exit(1)
      stream.end()
    })
    return
  }
  if (command.includes('__mock_output__:')) {
    const size = Number(/__mock_output__:(\d+)/.exec(command)[1]) || 0
    stream.write(Buffer.alloc(size, 'a'))
    stream.exit(0)
    stream.end()
    return
  }
  if (command.includes('__mock_exit__:')) {
    const code = Number(/__mock_exit__:(\d+)/.exec(command)[1]) || 0
    stream.write('exit-case\n')
    stream.exit(code)
    stream.end()
    return
  }
  if (command.includes('__mock_noexit__')) {
    stream.write('no-exit-status\n')
    stream.end()
    return
  }
  if (command.includes('__mock_utf8_split__')) {
    stream.write(Buffer.from([0xc3]))
    setTimeout(() => {
      stream.write(Buffer.from([0xa9]))
      stream.exit(0)
      stream.end()
    }, 30)
    return
  }
  if (command.includes('kill -TERM')) {
    entry.killCommand = command
    stream.write('killed\n')
    stream.exit(0)
    stream.end()
    return
  }
  if (command.includes('__mock_kill_echo__')) {
    stream.write(`exec: ${command}\n`)
    stream.exit(0)
    stream.end()
    return
  }
  stream.write('ok\n')
  stream.exit(0)
  stream.end()
}

describe('remote bash execution (mock ssh2 server)', () => {
before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (context) => context.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          handleExec(stream, String(info?.command ?? ''))
        })
        session.on('sftp', (acceptSftp) => {
          try {
            acceptSftp()
          } catch {
            /* test never uses sftp calls */
          }
        })
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  host = new RemoteHost(
    { id: 'mock', name: 'mock', host: '127.0.0.1', port, username: 'test', authType: 'password' },
    {},
  )
  await host.connect({ get: async () => 'secret' })
})

after(async () => {
  host?.dispose()
  await new Promise((resolve) => server.close(resolve))
})

test('U1 buildCommandScript is strict about the working directory', () => {
  const script = buildCommandScript('ls -la', "/data/a b'c")
  assert.match(script, /^cd '/)
  assert.match(script, /exit 1/)
  assert.doesNotMatch(script, /cd ~/)
  assert.equal(buildCommandScript('echo hi', null), 'echo hi')
})

test('U12 resolveWorkdir handles absolute/relative/invalid workdirs', () => {
  assert.deepEqual(resolveWorkdir(undefined, '/data/ws'), { cwd: '/data/ws' })
  assert.deepEqual(resolveWorkdir('/tmp', '/data/ws'), { cwd: '/tmp' })
  assert.deepEqual(resolveWorkdir('sub/dir', '/data/ws/'), { cwd: '/data/ws/sub/dir' })
  assert.ok(resolveWorkdir('C:\\x', '/data/ws').error)
  assert.ok(resolveWorkdir('..\\x', '/data/ws').error)
})

test('U2 stdin-waiting command receives EOF instead of hanging', async () => {
  calls.length = 0
  const started = Date.now()
  const result = await Promise.race([
    host.runCommand('__mock_stdin_wait__', '/data/ws', { maxBytes: CAP }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000)),
  ])
  const elapsed = Date.now() - started
  assert.equal(result.timeout, undefined, 'command must not hang')
  assert.ok(elapsed < 3000, `resolved in ${elapsed}ms`)
  assert.match(result.stdout, /EOF-received/)
  assert.equal(result.code, 1)
  assert.equal(result.transportError, null)
  const call = calls.find((item) => item.command.includes('__mock_stdin_wait__'))
  assert.ok(call?.stdinEndedAt, 'client sent stdin EOF')
})

test('U3 oversized output is flagged and capped', async () => {
  const result = await host.runCommand('__mock_output__:100', null, { maxBytes: 10 })
  assert.equal(result.truncatedOut, true)
  assert.ok(result.stdout.length <= 10)
  const rendered = renderBashResult(result, { maxBytes: 10 })
  assert.match(rendered.text, /\[output truncated; first 10 bytes captured\]/)
})

test('U4 exit code and missing exit status are distinguished', async () => {
  const exit = await host.runCommand('__mock_exit__:3', null, {})
  assert.equal(exit.code, 3)
  const noExit = await host.runCommand('__mock_noexit__', null, {})
  assert.equal(noExit.code, -1)
  assert.equal(noExit.transportError, null)
  assert.match(noExit.stdout, /no-exit-status/)
})

test('U5 normal command keeps the 1.2.7 result shape', async () => {
  const result = await host.runCommand('echo hello', null, { maxBytes: CAP })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /ok/)
  assert.equal(result.signal, null)
  assert.equal(result.truncatedOut, false)
  const rendered = renderBashResult(result)
  assert.equal(rendered.exitCode, 0)
  assert.equal(rendered.text, 'ok')
})

test('U6 renderBashResult marks transport errors and signals', () => {
  const transport = renderBashResult({ stdout: '', code: -1, transportError: 'socket closed' })
  assert.match(transport.text, /\[transport error: socket closed\]/)
  const killed = renderBashResult({ stdout: 'partial', code: -1, signal: 'SIGKILL' })
  assert.match(killed.text, /\[killed by signal: SIGKILL\]/)
})


test('U7 buildSupervisedScript records and cleans the remote pid', () => {
  const script = buildSupervisedScript('sleep 1', '/data/ws', '/tmp/.dsh-remote-deck/abc.pid')
  assert.match(script, /printf '%s' "\$\$" > '\/tmp\/.dsh-remote-deck\/abc.pid'/)
  assert.match(script, /rm -f '\/tmp\/.dsh-remote-deck\/abc.pid'/)
  assert.match(script, /exit \$__rc/)
  assert.doesNotMatch(script, /cd ~/)
})

test('U8 startCommand streams output and settles done', async () => {
  const chunks = []
  const handle = await host.startCommand('__mock_output__:5', null, {
    onChunk: (channel, text) => chunks.push({ channel, text }),
  })
  const result = await handle.done
  assert.equal(result.code, 0)
  assert.equal(result.truncatedOut, false)
  assert.equal(chunks.length > 0, true)
  assert.equal(chunks[0].channel, 'stdout')
})

test('U9 startCommand sends stdin EOF for prompting commands', async () => {
  const started = Date.now()
  const handle = await host.startCommand('__mock_stdin_wait__', null, {})
  const result = await Promise.race([
    handle.done,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000)),
  ])
  assert.equal(result.timeout, undefined)
  assert.ok(Date.now() - started < 3000)
  assert.match(result.stdout, /EOF-received/)
})

test('U10 killPid sends TERM and KILL for the recorded pid', async () => {
  calls.length = 0
  const result = await host.killPid('/tmp/.dsh-remote-deck/abc.pid', 200)
  assert.equal(result.code, 0)
  const killCall = calls.find((item) => item.command.includes('kill -TERM'))
  assert.ok(killCall, 'mock received the kill script')
  assert.match(killCall.command, /kill -KILL/)
})

test('U11 renderPromoted reports live output and the job pointer', () => {
  const rendered = renderPromoted(
    { chunks: [{ text: 'out-1\n' }, { text: 'err-1\n', channel: 'stderr' }], lossy: true },
    'bash-abc123',
    600000,
  )
  assert.equal(rendered.exitCode, null)
  assert.equal(rendered.jobId, 'bash-abc123')
  assert.match(rendered.text, /out-1/)
  assert.match(rendered.text, /\[stderr\]/)
  assert.match(rendered.text, /dropped from memory/)
  assert.match(rendered.text, /still running after 600000ms/)
})


test('U13 supervised script keeps trailing separators out of the user command', () => {
  const script = buildSupervisedScript('sleep 30 &', null, '/tmp/.dsh-remote-deck/abc.pid')
  assert.ok(script.includes('sleep 30 &\n__rc=$?'), 'background command is newline-terminated')
  assert.doesNotMatch(script, /&;/)
  const commented = buildSupervisedScript('echo hi # comment', null, '/tmp/.dsh-remote-deck/abc.pid')
  assert.ok(commented.includes('# comment\n__rc=$?'), 'cleanup survives a trailing comment')
  const empty = buildSupervisedScript('', null, '/tmp/.dsh-remote-deck/abc.pid')
  assert.ok(empty.includes('\n__rc=$?\n'), 'empty command still has a valid tail')
  const trailing = buildSupervisedScript('echo hi\n', null, '/tmp/.dsh-remote-deck/abc.pid')
  assert.ok(trailing.includes('echo hi\n\n__rc=$?'), 'trailing newline does not create an empty statement')
})

test('U16 supervised script keeps the pid file while background children remain', () => {
  const script = buildSupervisedScript('sleep 30 &', null, '/tmp/.dsh-remote-deck/abc.pid')
  assert.match(script, /jobs -p/)
  assert.match(script, /if \[ -z "\$\(jobs -p 2>\/dev\/null\)" \]; then/)
  assert.match(script, /find \/tmp\/\.dsh-remote-deck -maxdepth 1 -name '\*\.pid' -mmin \+180 -delete/)
})

test('U14 startCommand decodes a multibyte character split across chunks', async () => {
  const chunks = []
  const handle = await host.startCommand('__mock_utf8_split__', null, {
    onChunk: (channel, text) => chunks.push(text),
  })
  const result = await handle.done
  assert.equal(result.code, 0)
  assert.equal(chunks.join(''), 'é')
})

test('U15 resolveWorkdir rejects home-relative workdirs', () => {
  assert.ok(resolveWorkdir('~/src', '/data/ws').error)
  assert.ok(resolveWorkdir('~', '/data/ws').error)
})
})
