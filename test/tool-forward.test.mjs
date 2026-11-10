/**
 * Tests for the remote_forward agent tool.
 *
 * Fully hermetic: the ForwardManager, the session lookup and the host-name
 * lookup are fakes that record their calls and return canned data, so nothing
 * here touches SSH, the network or the disk.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { portForwardToolSpec } from '../lib/tool-forward.js'

const exec = { agent: { id: 'agent-1' }, signal: undefined }

const FORWARD_A = { id: 'fwd-a', connectionId: 'conn-1', remotePort: 8000, localPort: 41234, createdAt: 1, url: 'http://127.0.0.1:41234' }
const FORWARD_B = { id: 'fwd-b', connectionId: 'conn-2', remotePort: 5432, localPort: 41235, createdAt: 2, url: 'http://127.0.0.1:41235' }

function harness(options = {}) {
  const calls = { list: 0, detect: [], start: [], stop: [] }
  const forwards = {
    list() {
      calls.list += 1
      return options.forwards ?? []
    },
    async detect(connectionId) {
      calls.detect.push(connectionId)
      if (options.detectError !== undefined) throw options.detectError
      return options.ports ?? []
    },
    async start(connectionId, remotePort, localPort) {
      calls.start.push({ connectionId, remotePort, localPort })
      if (options.startError !== undefined) throw options.startError
      const actual = localPort > 0 ? localPort : 41234
      return {
        id: options.id ?? 'fwd-1',
        connectionId,
        remotePort,
        localPort: actual,
        createdAt: 1700000000000,
        url: `http://127.0.0.1:${actual}`,
      }
    },
    stop(id) {
      calls.stop.push(id)
      return options.stopResult ?? true
    },
  }
  const resolveCalls = []
  const spec = portForwardToolSpec({
    resolveSession: async (given) => {
      resolveCalls.push(given)
      if (options.resolveError !== undefined) throw options.resolveError
      return options.session === undefined ? { connectionId: 'conn-1', path: '/home/dev/app' } : options.session
    },
    forwards,
    hostNameFor: (connectionId) => (options.hostNames ?? { 'conn-1': 'devbox' })[connectionId],
  })
  return { spec, calls, resolveCalls }
}

const run = (spec, args) => spec.execute(args, exec)

test('exposes the frozen tool contract', () => {
  const { spec } = harness()
  assert.equal(spec.name, 'remote_forward')
  assert.equal(typeof spec.description, 'string')
  assert.match(spec.description, /127\.0\.0\.1/)
  assert.match(spec.description, /loopback/i)
  assert.match(spec.description, /rebuilt automatically/i)
  assert.match(spec.description, /port-forwarding tab/i)
  assert.match(spec.description, /action:"stop"/)
  assert.match(spec.description, /need no host context/i)

  assert.equal(spec.parameters.type, 'object')
  assert.deepEqual(spec.parameters.required, ['action'])
  assert.equal(spec.parameters.additionalProperties, false)
  assert.deepEqual(spec.parameters.properties.action.enum, ['list', 'detect', 'start', 'stop'])
  assert.equal(spec.parameters.properties.remotePort.type, 'number')
  assert.equal(spec.parameters.properties.localPort.type, 'number')
  assert.equal(spec.parameters.properties.id.type, 'string')
  assert.equal(spec.parameters.properties.connectionId.type, 'string')
  assert.deepEqual(Object.keys(spec.parameters.properties), ['action', 'remotePort', 'localPort', 'id', 'connectionId'])

  assert.deepEqual(spec.output.schema, {
    type: 'object',
    properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
    required: ['text', 'exitCode'],
    additionalProperties: false,
  })
  assert.deepEqual(spec.output.render({ action: 'list' }, { text: 'hello', exitCode: 0 }), [{ type: 'text', text: 'hello' }])
})

test('detect and start fail clearly when there is no remote workspace and no connectionId', async () => {
  for (const [action, extra] of [
    ['detect', {}],
    ['start', { remotePort: 8000 }],
  ]) {
    const { spec, calls } = harness({ session: null })
    const result = await run(spec, { action, ...extra })
    assert.equal(result.exitCode, 1, action)
    assert.match(result.text, /needs a remote workspace or an explicit connectionId/, action)
    assert.deepEqual(calls, { list: 0, detect: [], start: [], stop: [] }, action)
  }
})

test('detect does not run when the explicit connectionId is empty and the session is local', async () => {
  const { spec, calls } = harness({ session: null })
  const result = await run(spec, { action: 'detect', connectionId: '   ' })
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /needs a remote workspace or an explicit connectionId/)
  assert.deepEqual(calls.detect, [])
})

test('resolveSession receives the exec object and is skipped for an explicit connectionId', async () => {
  const { spec, resolveCalls, calls } = harness()
  await run(spec, { action: 'detect', connectionId: 'conn-7' })
  assert.deepEqual(resolveCalls, [])
  assert.deepEqual(calls.detect, ['conn-7'])

  const second = harness()
  await run(second.spec, { action: 'detect' })
  assert.deepEqual(second.resolveCalls, [exec])
  assert.deepEqual(second.calls.detect, ['conn-1'])
})

test('list reports no active forwards', async () => {
  const { spec } = harness()
  const result = await run(spec, { action: 'list' })
  assert.deepEqual(result, { text: 'no active forwards', exitCode: 0 })
})

test('list prints host, ports, url and id for every forward', async () => {
  const { spec, calls } = harness({ forwards: [FORWARD_A, FORWARD_B] })
  const result = await run(spec, { action: 'list' })
  assert.equal(result.exitCode, 0)
  assert.equal(calls.list, 1)
  assert.deepEqual(result.text.split('\n'), [
    'devbox 8000 -> 127.0.0.1:41234 [http://127.0.0.1:41234] id=fwd-a',
    'conn-2 5432 -> 127.0.0.1:41235 [http://127.0.0.1:41235] id=fwd-b',
  ])
})

test('list still lists every forward outside a remote workspace', async () => {
  const { spec, calls } = harness({ session: null, forwards: [FORWARD_A, FORWARD_B] })
  const result = await run(spec, { action: 'list' })
  assert.equal(result.exitCode, 0)
  const lines = result.text.split('\n')
  assert.equal(lines[0], 'devbox 8000 -> 127.0.0.1:41234 [http://127.0.0.1:41234] id=fwd-a')
  assert.equal(lines[1], 'conn-2 5432 -> 127.0.0.1:41235 [http://127.0.0.1:41235] id=fwd-b')
  assert.match(lines[2], /no remote workspace in this session/)
  assert.match(lines[2], /connectionId/)
  assert.equal(calls.list, 1)

  const empty = harness({ session: null })
  const emptyResult = await run(empty.spec, { action: 'list' })
  assert.equal(emptyResult.exitCode, 0)
  assert.match(emptyResult.text, /^no active forwards\n/)
  assert.match(emptyResult.text, /no remote workspace in this session/)
})

test('list survives a session lookup that throws', async () => {
  const { spec, calls } = harness({ resolveError: new Error('no session'), forwards: [FORWARD_A] })
  const result = await run(spec, { action: 'list' })
  assert.equal(result.exitCode, 0)
  assert.match(result.text, /^devbox 8000 -> 127\.0\.0\.1:41234/)
  assert.match(result.text, /no remote workspace in this session/)
  assert.equal(calls.list, 1)
})

test('detect marks forwarded ports, leaves the rest and hints at action:"start"', async () => {
  const { spec, calls } = harness({
    ports: [
      { port: 22, localPort: null },
      { port: 8000, localPort: 41234 },
      { port: 9000, localPort: null },
    ],
  })
  const result = await run(spec, { action: 'detect' })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls.detect, ['conn-1'])
  assert.equal(result.text.split('\n')[0], 'Listening ports on devbox:')
  assert.match(result.text, /^22 \(not forwarded\)$/m)
  assert.match(result.text, /^8000 \(forwarded -> 41234\)$/m)
  assert.match(result.text, /^9000 \(not forwarded\)$/m)
  assert.match(result.text, /action:"start"/)
  assert.match(result.text, /localPort/)
})

test('detect truncates long port lists and says how many were omitted', async () => {
  const ports = Array.from({ length: 57 }, (_, index) => ({ port: index + 1, localPort: null }))
  const { spec } = harness({ ports })
  const result = await run(spec, { action: 'detect' })
  assert.equal(result.exitCode, 0)
  assert.match(result.text, /^40 \(not forwarded\)$/m)
  assert.doesNotMatch(result.text, /^41 \(not forwarded\)$/m)
  assert.match(result.text, /17 more ports omitted/)
  assert.match(result.text, /first 40 of 57/)
  assert.equal(result.text.split('\n').length, 43)
})

test('detect reports an empty host', async () => {
  const { spec } = harness({ ports: [] })
  const result = await run(spec, { action: 'detect' })
  assert.deepEqual(result, { text: 'no listening ports detected on devbox', exitCode: 0 })
})

test('start forwards the port and reports id, url, persistence and how to stop', async () => {
  const { spec, calls } = harness()
  const result = await run(spec, { action: 'start', remotePort: 8000 })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls.start, [{ connectionId: 'conn-1', remotePort: 8000, localPort: 0 }])
  assert.match(result.text, /port 8000 -> 127\.0\.0\.1:41234/)
  assert.match(result.text, /URL: http:\/\/127\.0\.0\.1:41234/)
  assert.match(result.text, /id: fwd-1/)
  assert.match(result.text, /rebuilt automatically/i)
  assert.match(result.text, /console/i)
  assert.match(result.text, /action:"stop" id:"fwd-1"/)
})

test('start passes localPort through and treats 0/omitted/null as random', async () => {
  const explicit = harness()
  await run(explicit.spec, { action: 'start', remotePort: 8000, localPort: 18080 })
  assert.deepEqual(explicit.calls.start, [{ connectionId: 'conn-1', remotePort: 8000, localPort: 18080 }])

  for (const localPort of [undefined, 0, null]) {
    const { spec, calls } = harness()
    const args = { action: 'start', remotePort: 5432 }
    if (localPort !== undefined) args.localPort = localPort
    const result = await run(spec, args)
    assert.equal(result.exitCode, 0, String(localPort))
    assert.deepEqual(calls.start, [{ connectionId: 'conn-1', remotePort: 5432, localPort: 0 }], String(localPort))
  }
})

test('start rejects an invalid remotePort before touching the manager', async () => {
  for (const remotePort of [0, -1, 65536, 1.5, '8080', null, undefined, Number.NaN]) {
    const { spec, calls } = harness()
    const result = await run(spec, { action: 'start', remotePort })
    assert.equal(result.exitCode, 1, String(remotePort))
    assert.match(result.text, /remotePort must be an integer between 1 and 65535/, String(remotePort))
    assert.deepEqual(calls.start, [], String(remotePort))
  }
})

test('start rejects an invalid localPort before touching the manager', async () => {
  for (const localPort of [70000, -1, 1.5, '18080']) {
    const { spec, calls } = harness()
    const result = await run(spec, { action: 'start', remotePort: 8000, localPort })
    assert.equal(result.exitCode, 1, String(localPort))
    assert.match(result.text, /localPort must be an integer between 0 and 65535/, String(localPort))
    assert.deepEqual(calls.start, [], String(localPort))
  }
})

test('start surfaces a connection not found failure from the manager', async () => {
  const { spec } = harness({ startError: new Error('connection not found') })
  const result = await run(spec, { action: 'start', remotePort: 8000 })
  assert.deepEqual(result, { text: 'remote_forward failed: connection not found', exitCode: 1 })
})

test('start uses an explicit connectionId', async () => {
  const { spec, calls, resolveCalls } = harness()
  const result = await run(spec, { action: 'start', remotePort: 8000, connectionId: 'conn-9' })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(resolveCalls, [])
  assert.deepEqual(calls.start, [{ connectionId: 'conn-9', remotePort: 8000, localPort: 0 }])
})

test('stop closes a forward by id', async () => {
  const { spec, calls } = harness()
  const result = await run(spec, { action: 'stop', id: 'fwd-a' })
  assert.deepEqual(result, { text: 'Stopped forward fwd-a.', exitCode: 0 })
  assert.deepEqual(calls.stop, ['fwd-a'])
})

test('stop works without a remote workspace and without a connectionId', async () => {
  const { spec, calls, resolveCalls } = harness({ session: null })
  const result = await run(spec, { action: 'stop', id: 'fwd-a' })
  assert.deepEqual(result, { text: 'Stopped forward fwd-a.', exitCode: 0 })
  assert.deepEqual(calls.stop, ['fwd-a'])
  assert.deepEqual(resolveCalls, [])
})

test('stop names an explicit connectionId when one is given', async () => {
  const { spec, calls, resolveCalls } = harness()
  const result = await run(spec, { action: 'stop', id: 'fwd-a', connectionId: 'conn-1' })
  assert.deepEqual(result, { text: 'Stopped forward fwd-a on devbox.', exitCode: 0 })
  assert.deepEqual(calls.stop, ['fwd-a'])
  assert.deepEqual(resolveCalls, [])
})

test('stop needs an id', async () => {
  for (const id of [undefined, '', '   ']) {
    const { spec, calls } = harness()
    const result = await run(spec, { action: 'stop', id })
    assert.equal(result.exitCode, 1, String(id))
    assert.match(result.text, /needs the id/)
    assert.deepEqual(calls.stop, [])
  }
})

test('stop reports an unknown id', async () => {
  const { spec, calls } = harness({ stopResult: false })
  const result = await run(spec, { action: 'stop', id: 'ghost' })
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /no forward with id "ghost"/)
  assert.deepEqual(calls.stop, ['ghost'])
})

test('manager failures are reported as remote_forward failed', async () => {
  const detect = harness({ detectError: new Error('ssh is down') })
  assert.deepEqual(await run(detect.spec, { action: 'detect' }), { text: 'remote_forward failed: ssh is down', exitCode: 1 })

  const session = harness({ resolveError: new Error('no session') })
  assert.deepEqual(await run(session.spec, { action: 'start', remotePort: 8000 }), {
    text: 'remote_forward failed: no session',
    exitCode: 1,
  })
})

test('rejects an action outside the enum without touching the manager', async () => {
  for (const action of ['restart', '', undefined]) {
    const { spec, calls, resolveCalls } = harness()
    const result = await run(spec, { action })
    assert.equal(result.exitCode, 1, String(action))
    assert.match(result.text, /unknown action/)
    assert.deepEqual(calls, { list: 0, detect: [], start: [], stop: [] })
    assert.deepEqual(resolveCalls, [])
  }
})
