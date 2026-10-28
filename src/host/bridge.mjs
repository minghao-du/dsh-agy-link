#!/usr/bin/env node
// dsh-agy-link MCP bridge script: a minimal stdio MCP server with zero
// dependencies. agy launches it from its MCP registry; it forwards
// tools/list and tools/call to the plugin loopback endpoint whose URL and
// token arrive via env. DSH_MCP_SESSION carries the spawning DSH session so
// the host can resolve the calling agent (issue #55).
// Protocol: newline-delimited JSON-RPC 2.0.
import { request as httpRequest } from 'node:http'
import process from 'node:process'
import { createInterface } from 'node:readline'

const URL_BASE = process.env.DSH_MCP_URL || ''
const TOKEN = process.env.DSH_MCP_TOKEN || ''
const SESSION = process.env.DSH_MCP_SESSION || ''
const RUN_TOKEN = process.env.DSH_MCP_RUN_TOKEN || ''
const PROTOCOL = '2024-11-05'

function post(path, body, signal) {
  return new Promise((resolve, reject) => {
    if (URL_BASE === '' || TOKEN === '') {
      reject(new Error('bridge not configured (missing DSH_MCP_URL/DSH_MCP_TOKEN)'))
      return;
    }
    const data = JSON.stringify(body)
    const u = new URL(URL_BASE)
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port || 80,
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + TOKEN,
        ...(SESSION === '' ? {} : { 'X-DSH-Session': SESSION }),
        ...(RUN_TOKEN === '' ? {} : { 'X-DSH-Run': RUN_TOKEN }),
      },
      timeout: 600000,
      signal,
    });
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (e) {
          reject(e)
        }
      })
    });
    req.on('timeout', () => req.destroy(new Error('bridge request timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

let toolCache = null;

async function listTools(signal) {
  if (toolCache) return toolCache;
  const res = await post('/tools', {}, signal)
  if (res.status !== 200) throw new Error('bridge /tools failed: ' + JSON.stringify(res.body))
  toolCache = (res.body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || t.dshName,
    inputSchema: t.inputSchema || { type: 'object' },
    _dshName: t.dshName,
  }))
  return toolCache;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(id, method, params, signal) {
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'dsh-agy-link-bridge', version: '0.2.0' } } })
    return;
  }
  if (method.startsWith('notifications/')) return;
  if (method === 'tools/list') {
    const tools = await listTools(signal)
    send({ jsonrpc: '2.0', id, result: { tools: tools.map(({ _dshName, ...t }) => t) } })
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const tools = await listTools(signal)
    const hit = tools.find((t) => t.name === name)
    if (!hit) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } })
      return;
    }
    try {
      const res = await post('/call', { dshName: hit._dshName, arguments: args }, signal)
      if (res.status !== 200 || res.body.ok !== true) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + (res.body.text || res.body.error || JSON.stringify(res.body)) }], isError: true } })
        return;
      }
      send({ jsonrpc: '2.0', id, result: { content: Array.isArray(res.body.content) && res.body.content.length ? res.body.content : [{ type: 'text', text: res.body.text || '' }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + String(e) }], isError: true } })
    }
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
}

const requests = new Map()
const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let msg;
  try {
    msg = JSON.parse(text)
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') {
      requests.get(msg.params?.requestId)?.abort(new Error('MCP request cancelled'))
    }
    return;
  }
  const controller = new AbortController()
  requests.set(msg.id, controller)
  void handle(msg.id, msg.method, msg.params, controller.signal).catch((e) => {
    if (!controller.signal.aborted) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } })
  }).finally(() => requests.delete(msg.id))
})
function stop() {
  for (const controller of requests.values()) controller.abort(new Error('MCP bridge stopped'))
  process.exit(0)
}
process.stdin.on('end', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
