// MCP reverse bridge (v0.3): lets the spawned agy process call DSH-side
// tools. Design: the plugin runs a loopback-only HTTP endpoint
// (127.0.0.1, ephemeral port, bearer token) exposing tool schemas and
// execution; a tiny standalone stdio MCP server (dist/bridge.mjs, plain
// node, zero deps) is registered in the agy MCP registry and forwards MCP
// tool calls to that endpoint. Loopback + token keeps the surface private
// to this machine and this plugin.
//
// Two things matter for the bridge to be usable at all (issue #55):
//  1. `agy` 1.4+ reads MCP servers only from `~/.gemini/config/mcp_config.json`
//     (or a plugin's own `mcp_config.json`) — a workspace `.mcp.json` is
//     silently ignored, so that is where the entry has to go.
//  2. A bridged call must carry the identity of the session that spawned agy,
//     otherwise every tool that needs a caller (e.g. AgentTeams' coordination
//     tools) throws `exec.agent was undefined`. The session id travels from the
//     agy child env (DSH_MCP_SESSION) through bridge.mjs as a header, and the
//     host resolves it back to an agent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

const MCP_SERVER_KEY = 'dsh-tools'

export interface BridgeToolExecutionInput {
  callId: string
  name: string
  arguments: unknown
  agent?: unknown
  signal: AbortSignal
}

/** Minimal structural view of the DSH tool registry we need. */
export interface ToolsServiceLike {
  schemas(agent?: unknown): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  execute(input: BridgeToolExecutionInput): Promise<unknown>
}

/** MCP tool names are [a-zA-Z0-9_-]; DSH names may contain dots. */
export function toMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface McpBridge {
  /** Absolute path of the bridge script (dist/bridge.mjs). */
  bridgeScript: string
  /** Bearer token the bridge script must present. */
  token: string
  /** Base URL of the loopback endpoint. */
  url: string
  port: number
  registerRun(input: {
    sessionId: string
    signal: AbortSignal
    allowedTools?: readonly string[]
  }): { token: string; dispose(): Promise<void> }
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** Best-effort extraction of readable text from an execution result. */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { content?: unknown; output?: unknown; text?: unknown }
  if (Array.isArray(r.content)) {
    const parts: string[] = []
    for (const b of r.content) {
      const blk = b as { type?: string; text?: unknown }
      if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/**
 * Start the loopback endpoint. Resolves once listening. The tools service
 * may arrive later (optional service): pass a thunk.
 */
export function startMcpBridge(opts: {
  bridgeScript: string
  tools: () => ToolsServiceLike | undefined
  allowlist: () => string
  /** Map the spawning DSH session id to the agent the call runs on behalf of. */
  resolveAgent?: (sessionId: string) => unknown | Promise<unknown>
  /** Hosted execution must not silently downgrade to the legacy session header. */
  requireRun?: () => boolean
  /** Use the host's supported transport (for example PTC) without bypassing policy. */
  executeTool?: (input: BridgeToolExecutionInput) => Promise<unknown>
  log?: (msg: string) => void
}): Promise<McpBridge> {
  const token = randomBytes(24).toString('hex')
  let callSeq = 0
  let closing = false
  let closePromise: Promise<void> | undefined
  const shutdown = new AbortController()
  const activeCalls = new Set<Promise<unknown>>()
  interface Run {
    sessionId: string
    allowedTools?: ReadonlySet<string>
    controller: AbortController
    active: Set<Promise<unknown>>
    dispose(): Promise<void>
  }
  const runs = new Map<string, Run>()
  const registerRun: McpBridge['registerRun'] = (input) => {
    if (closing || input.signal.aborted || input.sessionId.trim() === '') {
      throw new Error('cannot register an inactive MCP run')
    }
    const runToken = randomBytes(24).toString('hex')
    const controller = new AbortController()
    let disposal: Promise<void> | undefined
    const onAbort = () => { void run.dispose() }
    const run: Run = {
      sessionId: input.sessionId,
      ...(input.allowedTools === undefined ? {} : { allowedTools: new Set(input.allowedTools) }),
      controller,
      active: new Set(),
      dispose() {
        if (disposal) return disposal
        // Revoke before waiting, so no further call can enter this run.
        runs.delete(runToken)
        input.signal.removeEventListener('abort', onAbort)
        controller.abort(new Error('MCP run ended'))
        disposal = Promise.allSettled([...run.active]).then(() => undefined)
        return disposal
      },
    }
    runs.set(runToken, run)
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) void run.dispose()
    return { token: runToken, dispose: () => run.dispose() }
  }
  const visibleTools = (svc: ToolsServiceLike, agent: unknown, run?: Run) => {
    const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
    const allowSet = new Set(allow)
    const seen = new Set<string>()
    return svc.schemas(agent).filter((tool) => {
      if (tool.name === 'run_code' || tool.name === 'agy_ask') return false
      if (allow.length > 0 && !allowSet.has(tool.name)) return false
      if (run?.allowedTools && !run.allowedTools.has(tool.name)) return false
      const mapped = toMcpName(tool.name)
      if (seen.has(mapped)) return false
      seen.add(mapped)
      return true
    })
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const auth = String(req.headers['authorization'] ?? '')
      if (auth !== 'Bearer ' + token) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      if (closing) {
        sendJson(res, 503, { error: 'bridge closing' })
        return
      }
      const listing = (req.method === 'GET' || req.method === 'POST') && (url === '/tools' || url === '/mcp/tools')
      const calling = req.method === 'POST' && (url === '/call' || url === '/mcp/call')
      if (!listing && !calling) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const sessionId = String(req.headers['x-dsh-session'] ?? '')
      const runToken = String(req.headers['x-dsh-run'] ?? '')
      const run = runToken === '' ? undefined : runs.get(runToken)
      if (runToken === '' && (runs.size > 0 || opts.requireRun?.())) {
        sendJson(res, 403, { error: 'run capability required' })
        return
      }
      if (runToken !== '' && (!run || run.sessionId !== sessionId || run.controller.signal.aborted)) {
        sendJson(res, 403, { error: 'invalid or expired run capability' })
        return
      }
      const agent = sessionId === '' ? undefined : await Promise.resolve(opts.resolveAgent?.(sessionId))
      if (req.aborted || res.destroyed) return
      // Legacy listing without a caller is retained for existing MCP discovery.
      // Execution, and all run-capability discovery, require a live caller.
      if ((calling || run || sessionId !== '') && (agent === undefined || agent === null)) {
        sendJson(res, 403, { error: 'unknown calling session' })
        return
      }
      if (closing || run?.controller.signal.aborted) {
        sendJson(res, 403, { error: 'MCP run ended' })
        return
      }
      const svc = opts.tools()
      if (!svc) {
        sendJson(res, 503, { error: 'tools service unavailable' })
        return
      }
      if (listing) {
        const tools = visibleTools(svc, agent, run).map((tool) => ({
          name: toMcpName(tool.name),
          dshName: tool.name,
          description: tool.description,
          inputSchema: { type: 'object', ...tool.parameters },
        }))
        sendJson(res, 200, { tools })
        return
      }
      const body = await readBody(req)
      let parsed: { dshName?: unknown; arguments?: unknown } = {}
      try {
        const value: unknown = JSON.parse(body)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        parsed = value as typeof parsed
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }
      const dshName = typeof parsed.dshName === 'string' ? parsed.dshName : ''
      // Recompute at dispatch: cached tool discovery or a direct /call request
      // must not bypass current allowlists or the caller's scoped visibility.
      if (!visibleTools(svc, agent, run).some(tool => tool.name === dshName)) {
        sendJson(res, 403, { error: 'tool is not available to this run' })
        return
      }
      const disconnected = new AbortController()
      const onDisconnect = () => {
        if (!res.writableEnded) disconnected.abort(new Error('MCP caller disconnected'))
      }
      req.once('aborted', onDisconnect)
      res.once('close', onDisconnect)
      // Resolution/body parsing may have yielded after the socket closed.
      if (req.aborted || res.destroyed) onDisconnect()
      const signal = AbortSignal.any([shutdown.signal, disconnected.signal, ...(run ? [run.controller.signal] : [])])
      if (signal.aborted) {
        sendJson(res, 403, { error: 'MCP run ended' })
        return
      }
      const execution = Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason
        const input = { callId: 'agy-mcp-' + (++callSeq), name: dshName, arguments: parsed.arguments ?? {}, agent, signal }
        return opts.executeTool ? opts.executeTool(input) : svc.execute(input)
      })
      activeCalls.add(execution)
      run?.active.add(execution)
      try {
        const result = await execution
        const failed = signal.aborted || (result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true)
        const content = result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)
          ? result.content.filter((block: unknown) => block && typeof block === 'object' && (
            ('type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') ||
            ('type' in block && block.type === 'image' && 'data' in block && typeof block.data === 'string' && 'mimeType' in block && typeof block.mimeType === 'string')
          )) : undefined
        if (!res.destroyed) sendJson(res, 200, { ok: !failed, text: resultText(result), ...(content?.length ? { content } : {}) })
      } catch (error) {
        if (!res.destroyed) sendJson(res, 200, { ok: false, error: String(error) })
      } finally {
        req.removeListener('aborted', onDisconnect)
        res.removeListener('close', onDisconnect)
        activeCalls.delete(execution)
        run?.active.delete(execution)
      }
    })().catch(() => {
      try { if (!res.destroyed) sendJson(res, 500, { error: 'internal' }) } catch { /* closed */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      opts.log?.('mcp bridge listening on 127.0.0.1:' + port)
      resolve({
        bridgeScript: opts.bridgeScript,
        token,
        url: 'http://127.0.0.1:' + port,
        port,
        registerRun,
        close() {
          if (closePromise) return closePromise
          closing = true
          shutdown.abort(new Error('MCP bridge closed'))
          const disposals = [...runs.values()].map(run => run.dispose())
          const closed = new Promise<void>(done => server.close(() => done()))
          server.closeAllConnections()
          closePromise = Promise.all([closed, ...disposals, Promise.allSettled([...activeCalls])]).then(() => undefined)
          return closePromise
        },
      })
    })
  })
}

/** `agy` home the CLI reads its configs from (mirrors the runner's isolated-home rule). */
export function agyConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GEMINI_CLI_HOME
  if (typeof home === 'string' && home !== '') return home
  const plain = env.HOME
  if (typeof plain === 'string' && plain !== '') return plain
  return homedir()
}

/**
 * Absolute path of the MCP server registry `agy` 1.4+ actually loads.
 * `override` wins so callers can target a specific file.
 * Correctly distinguishes between a home dir (`/path/to/home`) and a
 * direct .gemini dir (`/path/to/home/.gemini`).
 */
export function agyMcpConfigPath(override = '', env: NodeJS.ProcessEnv = process.env): string {
  if (override !== '') return override
  const gch = env.GEMINI_CLI_HOME
  if (typeof gch === 'string' && gch !== '') {
    return basename(gch) === '.gemini'
      ? join(gch, 'config', 'mcp_config.json')
      : join(gch, '.gemini', 'config', 'mcp_config.json')
  }
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
  return join(home, '.gemini', 'config', 'mcp_config.json')
}

/** Registry key for one bridge instance: unique per port so two DSH hosts sharing a global file never clobber each other. */
export function mcpServerKey(port: number): string {
  return MCP_SERVER_KEY + '-' + String(port)
}

/**
 * Merge our server entry into the MCP registry file at `file` (`agy` 1.4+
 * reads the global one; a workspace `.mcp.json` is ignored, see issue #55).
 * Returns a restore function that puts the previous content back (or deletes
 * the file we created). Never throws.
 */
export function writeMcpConfig(file: string, bridge: Omit<McpBridge, 'registerRun'>): () => void {
  const key = mcpServerKey(bridge.port)
  let previous: string | null = null
  try {
    if (existsSync(file)) previous = readFileSync(file, 'utf8')
  } catch {
    previous = null
  }
  let root: Record<string, unknown> = {}
  if (previous !== null) {
    try {
      const v = JSON.parse(previous)
      if (v && typeof v === 'object') root = v as Record<string, unknown>
    } catch {
      root = {}
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}) as Record<string, unknown>
  if (MCP_SERVER_KEY in servers) {
    delete servers[MCP_SERVER_KEY]
  }
  servers[key] = {
    type: 'stdio',
    command: process.execPath,
    args: [bridge.bridgeScript],
    env: {
      DSH_MCP_URL: bridge.url,
      DSH_MCP_TOKEN: bridge.token,
    },
  }
  root.mcpServers = servers
  let written = false
  let writtenBytes = ''
  try {
    mkdirSync(dirname(file), { recursive: true })
    writtenBytes = JSON.stringify(root, null, 2) + '\n'
    writeFileSync(file, writtenBytes, 'utf8')
    written = true
  } catch {
    return () => {}
  }
  return () => {
    try {
      // Restore only what WE wrote: after a crash + manual edit (or another
      // process rewriting the file), blindly restoring `previous` clobbered
      // foreign changes. When the current content no longer contains our
      // entry, leave the file alone.
      if (!written) return
      let current: string | null = null
      try {
        if (existsSync(file)) current = readFileSync(file, 'utf8')
      } catch {
        current = null
      }
      if (current === null) return // file vanished: nothing of ours remains
      // Another host (or the user) rewrote the shared registry since we
      // published. Restoring our old bytes would delete their entry, so only
      // drop the key we own and leave everything else untouched.
      if (current !== writtenBytes) {
        let live: Record<string, unknown> = {}
        try {
          const v = JSON.parse(current)
          if (v && typeof v === 'object') live = v as Record<string, unknown>
        } catch {
          return // unparseable: don't touch the file
        }
        const liveServers = (live.mcpServers && typeof live.mcpServers === 'object' ? live.mcpServers : {}) as Record<string, unknown>
        if (!(key in liveServers)) return
        delete liveServers[key]
        const emptyRegistry = Object.keys(liveServers).length === 0
        const nothingElse = Object.keys(live).every((k) => k === 'mcpServers')
        if (emptyRegistry && nothingElse) {
          // Nothing but empty bookkeeping is left: don't keep a file behind.
          try {
            unlinkSync(file)
          } catch {
            /* best effort */
          }
          return
        }
        writeFileSync(file, JSON.stringify({ ...live, mcpServers: liveServers }, null, 2) + '\n', 'utf8')
        return
      }
      let parsed: Record<string, unknown> = {}
      try {
        const v = JSON.parse(current)
        if (v && typeof v === 'object') parsed = v as Record<string, unknown>
      } catch {
        return // unparseable: assume our entry is gone, don't touch the file
      }
      const curServers = (parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}) as Record<string, unknown>
      if (!(key in curServers)) return
      if (previous === null) {
        delete curServers[key]
        if (Object.keys(curServers).length === 0) {
          // We created the file and no other servers remain: remove it.
          unlinkSync(file)
        } else {
          writeFileSync(file, JSON.stringify({ ...parsed, mcpServers: curServers }, null, 2) + '\n', 'utf8')
        }
      } else {
        writeFileSync(file, previous, 'utf8')
      }
    } catch {
      /* best effort */
    }
  }
}
