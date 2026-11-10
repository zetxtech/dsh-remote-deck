/**
 * Agent tool: remote port forwarding.
 *
 * Exposes ForwardManager to the model: list the active forwards, detect which
 * ports listen on a remote host, open a new forward to the DSH machine's
 * loopback address, or close one by id. A forward binds 127.0.0.1 only, is
 * persisted to forwards.json, and is rebuilt when the SSH connection returns.
 *
 * detect and start need a host (explicit connectionId, else the current remote
 * workspace); list and stop work without any host context, because a forward
 * id is unique and list spans every host.
 */
import { errorText } from './util.js'

const ACTIONS = ['list', 'detect', 'start', 'stop']
const MAX_DETECT_PORTS = 40

/** Render a rejected argument value inside an error message. */
function show(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  return JSON.stringify(value)
}

function isRemotePort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

function ok(text) {
  return { text, exitCode: 0 }
}

function fail(text) {
  return { text, exitCode: 1 }
}

function explicitConnectionId(args) {
  return typeof args.connectionId === 'string' && args.connectionId.trim().length > 0 ? args.connectionId.trim() : null
}

export function portForwardToolSpec({ resolveSession, forwards, hostNameFor }) {
  const hostLabel = (connectionId) => {
    const name = typeof hostNameFor === 'function' ? hostNameFor(connectionId) : undefined
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : connectionId
  }

  const resolveConnectionId = async (args, exec) => {
    const explicit = explicitConnectionId(args)
    if (explicit !== null) return explicit
    const session = typeof resolveSession === 'function' ? await resolveSession(exec) : null
    const id = session === null || session === undefined ? undefined : session.connectionId
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
  }

  /** Best effort lookup for read-only actions: a local or broken session must not fail them. */
  const resolveQuietly = async (args, exec) => {
    try {
      return await resolveConnectionId(args, exec)
    } catch {
      return null
    }
  }

  const runList = (connectionId) => {
    const rows = forwards.list()
    const lines = rows.length === 0
      ? ['no active forwards']
      : rows.map(
        (row) => `${hostLabel(row.connectionId)} ${row.remotePort} -> 127.0.0.1:${row.localPort} [${row.url}] id=${row.id}`,
      )
    if (connectionId === null) {
      lines.push('(no remote workspace in this session: listing forwards for every host; pass connectionId to detect or start one)')
    }
    return ok(lines.join('\n'))
  }

  const runDetect = async (connectionId) => {
    const ports = await forwards.detect(connectionId)
    if (ports.length === 0) return ok(`no listening ports detected on ${hostLabel(connectionId)}`)
    const shown = ports.slice(0, MAX_DETECT_PORTS)
    const lines = shown.map((row) =>
      isRemotePort(row.localPort) ? `${row.port} (forwarded -> ${row.localPort})` : `${row.port} (not forwarded)`,
    )
    if (ports.length > shown.length) {
      lines.push(`... ${ports.length - shown.length} more ports omitted (showing the first ${shown.length} of ${ports.length})`)
    }
    lines.push('Forward one to 127.0.0.1 on this machine with remote_forward action:"start" and that remotePort (omit localPort for a random free port).')
    return ok(`Listening ports on ${hostLabel(connectionId)}:\n${lines.join('\n')}`)
  }

  const runStart = async (connectionId, args) => {
    if (!isRemotePort(args.remotePort)) {
      return fail(`remotePort must be an integer between 1 and 65535 (got ${show(args.remotePort)}).`)
    }
    let localPort = 0
    if (args.localPort !== undefined && args.localPort !== null) {
      if (!Number.isInteger(args.localPort) || args.localPort < 0 || args.localPort > 65535) {
        return fail(`localPort must be an integer between 0 and 65535, where 0 means a random free port (got ${show(args.localPort)}).`)
      }
      localPort = args.localPort
    }
    const view = await forwards.start(connectionId, args.remotePort, localPort)
    return ok(
      [
        `Forwarding ${hostLabel(connectionId)} port ${view.remotePort} -> 127.0.0.1:${view.localPort}`,
        `URL: ${view.url}`,
        `id: ${view.id}`,
        'The forward is saved and is rebuilt automatically when the SSH connection comes back; it also shows in the plugin SSH console on the port-forwarding tab.',
        `Stop it with remote_forward action:"stop" id:"${view.id}".`,
      ].join('\n'),
    )
  }

  const runStop = (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) return fail('remote_forward action:"stop" needs the id of the forward to close; get it from action:"list".')
    const named = explicitConnectionId(args)
    const where = named === null ? '' : ` on ${hostLabel(named)}`
    if (!forwards.stop(id)) {
      return fail(`no forward with id ${show(id)}${where} (it may already be stopped; run action:"list" to see what is active).`)
    }
    return ok(`Stopped forward ${id}${where}.`)
  }

  return {
    name: 'remote_forward',
    description:
      'Forward a TCP port on a remote SSH host to 127.0.0.1 on the machine running DSH, and manage existing forwards. ' +
      'A forward listens only on the loopback address (127.0.0.1:<localPort>), so it is reachable from DSH itself and never exposed to the network. ' +
      'Forwards are persisted and are rebuilt automatically after an SSH reconnect; they also appear in the plugin SSH console on the port-forwarding tab, and action:"stop" closes one. ' +
      'Actions: "list" shows the active forwards of every host; "detect" lists ports listening on a host and marks the ones already forwarded; ' +
      '"start" opens a forward for remotePort (localPort is optional: omit it or pass 0 for a random free port); "stop" closes one by id. ' +
      'detect and start need a host: they use the current remote workspace unless connectionId names another connected host. ' +
      'list and stop need no host context, because a forward id is unique and list covers every host. ' +
      'Use it to reach a remote dev server, notebook or database from the DSH machine.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'list active forwards, detect listening remote ports, start a forward, or stop one by id.',
        },
        remotePort: { type: 'number', description: 'Port on the remote host to forward; required for action:"start".' },
        localPort: {
          type: 'number',
          description: 'Loopback port on the DSH machine; optional, 0 or omitted picks a random free port.',
        },
        id: { type: 'string', description: 'Id of the forward to close; required for action:"stop".' },
        connectionId: {
          type: 'string',
          description: 'Optional SSH host id; defaults to the current remote workspace host for detect and start.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
        required: ['text', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      try {
        const action = typeof input.action === 'string' ? input.action : ''
        if (!ACTIONS.includes(action)) {
          return fail(`unknown action ${show(input.action)}; expected one of ${ACTIONS.map((name) => `"${name}"`).join(', ')}.`)
        }
        if (action === 'list') return runList(await resolveQuietly(input, exec))
        if (action === 'stop') return runStop(input)
        const connectionId = await resolveConnectionId(input, exec)
        if (connectionId === null) return fail('remote_forward needs a remote workspace or an explicit connectionId')
        if (action === 'detect') return await runDetect(connectionId)
        return await runStart(connectionId, input)
      } catch (error) {
        return fail('remote_forward failed: ' + errorText(error))
      }
    },
  }
}
