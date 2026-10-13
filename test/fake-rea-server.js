/**
 * A fake REA MCP server used by `bridge.test.mjs`.
 *
 * It answers the four methods the bridge uses, pages `tools/list` across two
 * responses, advertises one tool outside the curated `entry` tier, sends one
 * server-initiated request (to exercise the client's refusal path), and emits a
 * notification. It is a test double, not part of the plugin.
 */

const TOOLS = [
  {
    name: 'open_binary',
    description: 'Open a native binary',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'binary_overview',
    description: 'Summarize the open target',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_procedures',
    // Deliberately outside the `entry` tier.
    description: 'List procedures',
    inputSchema: { type: 'object', properties: {} },
  },
]

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line === '') continue
    handle(JSON.parse(line))
  }
})

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-rea', version: '0.0.0' },
      },
    })
    // One server-initiated request and one notification: the client must answer
    // the first with "method not found" and ignore the second.
    send({ jsonrpc: '2.0', id: 9001, method: 'ping', params: {} })
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    if (message.params?.cursor === undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.slice(0, 2), nextCursor: 'page-2' } })
    } else {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.slice(2) } })
    }
    return
  }
  if (message.method === 'tools/call') {
    const { name, arguments: toolArguments } = message.params
    if (name === 'open_binary' && typeof toolArguments?.path !== 'string') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'open_binary requires a path' }], isError: true },
      })
      return
    }
    if (name === 'slow') return // never answers: exercises the client timeout
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `fake:${name}:${JSON.stringify(toolArguments ?? {})}` }],
      },
    })
    return
  }
  // The response to the server-initiated `ping`, reported for the test to read.
  if (message.error !== undefined) {
    process.stderr.write(`client-refused:${String(message.error.message)}\n`)
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })
}

process.stderr.write('fake-rea: listening\n')