import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMcpBridge, type ToolsServiceLike, type BridgeToolExecutionInput } from '../src/host/mcp-bridge.ts'

const agent = { id: 'agent-a' }
const schemas = [
  { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
]
const fixture = (tools: ToolsServiceLike, allowlist = '', overrides: { requireRun?: () => boolean; executeTool?: (input: BridgeToolExecutionInput) => Promise<unknown> } = {}) => startMcpBridge({
  bridgeScript: fileURLToPath(new URL('../src/host/bridge.mjs', import.meta.url)),
  tools: () => tools,
  allowlist: () => allowlist,
  resolveAgent: (id) => id === 'session-a' ? agent : undefined,
  ...overrides,
})
const request = async (bridge: Awaited<ReturnType<typeof fixture>>, path: string, run = '', session = 'session-a', dshName = 'bash') => {
  const response = await fetch(bridge.url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bridge.token, 'X-DSH-Run': run, 'X-DSH-Session': session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dshName, arguments: {} }),
  })
  return { status: response.status, body: await response.json() as { ok?: boolean; tools?: Array<{ dshName: string }>; text?: string } }
}

test('MCP run capabilities bind the session and enforce scoped tool visibility at execution', { timeout: 5000 }, async () => {
  let dispatched = 0
  const bridge = await fixture({
    schemas: (scope) => scope === agent ? schemas : [],
    execute: async () => { assert.fail('the configured host transport must dispatch this call') },
  }, '', { requireRun: () => true, executeTool: async input => {
    assert.equal(input.agent, agent)
    assert.equal(input.signal.aborted, false)
    dispatched++
    return { isError: false, content: [{ type: 'text', text: 'ok' }] }
  } })
  try {
    const run = bridge.registerRun({ sessionId: 'session-a', signal: new AbortController().signal, allowedTools: ['bash'] })
    assert.deepEqual((await request(bridge, '/tools', run.token)).body.tools?.map(t => t.dshName), ['bash'])
    assert.equal((await request(bridge, '/call', run.token, 'session-a', 'read')).status, 403)
    assert.equal((await request(bridge, '/call', run.token, 'other')).status, 403)
    assert.equal((await request(bridge, '/call', 'unknown')).status, 403)
    assert.equal((await request(bridge, '/call')).status, 403, 'cannot downgrade to a legacy call')
    assert.equal(dispatched, 0)
    assert.equal((await request(bridge, '/call', run.token)).body.ok, true)
    assert.equal(dispatched, 1)
    await run.dispose()
    assert.equal((await request(bridge, '/call', run.token)).status, 403)
    assert.equal(dispatched, 1)
    assert.equal((await request(bridge, '/tools')).status, 403, 'strict mode survives lease disposal')
  } finally { await bridge.close() }
})

test('legacy MCP calls cannot bypass the allowlist or execute without a known session', { timeout: 5000 }, async () => {
  let dispatched = 0
  const bridge = await fixture({ schemas: () => schemas, execute: async () => { dispatched++; return {} } }, 'read')
  try {
    assert.equal((await request(bridge, '/call', '', 'session-a', 'bash')).status, 403)
    assert.equal((await request(bridge, '/call', '', 'unknown', 'read')).status, 403)
    assert.equal((await request(bridge, '/call', '', '', 'read')).status, 403)
    assert.equal(dispatched, 0)
  } finally { await bridge.close() }
})

test('disposing an MCP run cancels and drains its in-flight tool, then rejects further calls', { timeout: 5000 }, async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let settled = false
  const bridge = await fixture({ schemas: () => schemas, execute: async (input) => {
    started()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }))
    settled = true
    return { isError: true, content: [{ type: 'text', text: 'cancelled' }] }
  } })
  try {
    const run = bridge.registerRun({ sessionId: 'session-a', signal: new AbortController().signal, allowedTools: ['bash'] })
    const call = request(bridge, '/call', run.token)
    await entered
    await run.dispose()
    assert.equal(settled, true, 'dispose waits for cooperative tool cleanup')
    assert.equal((await call).body.ok, false)
    assert.equal((await request(bridge, '/call', run.token)).status, 403)
  } finally { await bridge.close() }
})

test('stdio MCP forwards run identity, images and errors, and cancels a disconnected tool call', { timeout: 5000 }, async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let cancelled!: () => void
  const stopped = new Promise<void>(resolve => { cancelled = resolve })
  const bridge = await fixture({ schemas: () => schemas, execute: async (input) => {
    if ((input.arguments as { image?: boolean }).image) return { content: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }] }
    if ((input.arguments as { wait?: boolean }).wait) {
      entered()
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    }
    return { isError: true, content: [{ type: 'text', text: 'user denied this tool' }] }
  } })
  const run = bridge.registerRun({ sessionId: 'session-a', signal: new AbortController().signal, allowedTools: ['bash'] })
  const child = spawn(process.execPath, [bridge.bridgeScript], {
    env: { ...process.env, DSH_MCP_URL: bridge.url, DSH_MCP_TOKEN: bridge.token, DSH_MCP_SESSION: 'session-a', DSH_MCP_RUN_TOKEN: run.token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const replies = new Map<number, (msg: any) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1)
      replies.get(msg.id)?.(msg)
    }
  })
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n')
  const reply = (id: number) => new Promise<any>(resolve => replies.set(id, resolve))
  try {
    const first = reply(1)
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: {} } })
    const message = await first
    assert.equal(message.result.isError, true)
    assert.match(message.result.content[0].text, /user denied/)
    const imageReply = reply(3)
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { image: true } } })
    assert.deepEqual((await imageReply).result.content, [{ type: 'image', mimeType: 'image/png', data: 'AQID' }])
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: { wait: true } } })
    await started
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })
    await stopped
  } finally {
    child.kill()
    await run.dispose()
    await bridge.close()
  }
})


test('bridge shutdown revokes capabilities and drains cancelled tool execution', { timeout: 5000 }, async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let settled = false
  const controller = new AbortController()
  const bridge = await fixture({ schemas: () => schemas, execute: async input => {
    entered()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }))
    settled = true
    return { isError: true, content: [] }
  } })
  const run = bridge.registerRun({ sessionId: 'session-a', signal: controller.signal, allowedTools: ['bash'] })
  const call = request(bridge, '/call', run.token).catch(() => undefined)
  await started
  // Exercise the input-signal subscription rather than only explicit dispose.
  controller.abort()
  await run.dispose()
  assert.equal(settled, true)
  settled = false
  let closeEntered!: () => void
  const closeStarted = new Promise<void>(resolve => { closeEntered = resolve })
  entered = closeEntered
  const second = bridge.registerRun({ sessionId: 'session-a', signal: new AbortController().signal, allowedTools: ['bash'] })
  const closingCall = request(bridge, '/call', second.token).catch(() => undefined)
  await closeStarted
  await bridge.close()
  assert.equal(settled, true, 'shutdown waits for the tool to stop')
  await Promise.all([call, closingCall])
  await bridge.close()
  assert.throws(() => bridge.registerRun({ sessionId: 'session-a', signal: new AbortController().signal }), /inactive/)
})
