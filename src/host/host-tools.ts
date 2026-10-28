import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { PermissionMode } from '../common/types.ts'
import type { ToolsServiceLike, BridgeToolExecutionInput, McpBridge } from './mcp-bridge.ts'

// No delegation, scheduling or transport tools: every supported operation stays
// inside the DSH caller's tool/approval/sandbox pipeline.
const HOST_TOOLS = new Set([
  'bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'str_replace_editor', 'working_directory', 'job_output', 'job_list', 'job_kill',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
])
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'job_output', 'job_list'])
export function hostToolSchemas(tools: ToolsServiceLike, agent: unknown, mode: PermissionMode) {
  return tools.schemas(agent).filter(s => HOST_TOOLS.has(s.name) && (mode !== 'plan' || READ_ONLY_TOOLS.has(s.name)))
}

/** One private plugin per account/bridge lifetime, reused by resumed profiles. */
export function createHostToolPlugin(opts: { accountHome: string; namespace: string; bridge: Pick<McpBridge, 'url' | 'token' | 'bridgeScript'> }) {
  if (!/^[a-zA-Z0-9-]+$/.test(opts.namespace)) throw new Error('Invalid host tool plugin namespace')
  const pluginName = 'host-tools-' + opts.namespace
  const dir = join(opts.accountHome || homedir(), '.gemini', 'config', 'dsh-agy-link', pluginName)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: pluginName, description: 'Session-bound DSH host tools' }), { mode: 0o600 })
    writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { bridge: {
      type: 'stdio', command: process.execPath, args: [opts.bridge.bridgeScript],
      env: { DSH_MCP_URL: opts.bridge.url, DSH_MCP_TOKEN: opts.bridge.token },
    } } }), { mode: 0o600 })
    return { path: dir, serverName: pluginName + '_bridge', dispose() { rmSync(dir, { recursive: true, force: true }) } }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}

/** Create a private CLI agent without changing the user's agents or hooks. */
export function createHostToolProfile(opts: {
  accountHome: string
  plugin?: { path: string; serverName: string }
  hookScript: string
  schemas: ReturnType<ToolsServiceLike['schemas']>
}) {
  const home = opts.accountHome || homedir()
  const dir = join(home, '.gemini', 'config', 'agents')
  mkdirSync(dir, { recursive: true })
  const name = 'dsh-host-' + randomBytes(10).toString('hex')
  const profile = join(dir, name + '.md')
  const assets = mkdtempSync(join(dir, name + '-'))
  const hooks = join(assets, 'hooks.json')
  const serverName = opts.plugin?.serverName ?? ''
  // JSON string quoting is also valid YAML string quoting. Hook commands run
  // through a shell, so use single-quote escaping rather than JSON quoting.
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
  try {
    writeFileSync(hooks, JSON.stringify({ 'dsh-host-only': {
      PreToolUse: [{ matcher: '.*', hooks: [{ command: quote(process.execPath) + ' ' + quote(opts.hookScript), timeout: 10 }] }],
    } }), { mode: 0o600 })
    writeFileSync(profile, [
      '---', 'name: ' + name, 'description: DSH host tools with isolated Antigravity authentication',
      'mainAgent: true', 'subagent: false', 'inheritCustomizations: false', 'inheritMcp: false',
      'excludeDefaultComponents: true', 'tools: []', ...(opts.plugin ? ['plugins:', '  - ' + JSON.stringify(opts.plugin.path)] : []), 'hooks:', '  - ' + JSON.stringify(hooks), '---',
      'Complete the user request using the DSH host tools below. Commands use the system user HOME and the DSH session workspace, while Antigravity authentication stays isolated.',
      'Call call_mcp_tool with ServerName=' + JSON.stringify(serverName) + ', ToolName=<tool name>, Arguments=<arguments object>.',
      'Tool schemas are included here; do not use native tools to read MCP schema files. Respect DSH denials; do not retry a denied operation another way.',
      'Use bash/pwsh for commands, DSH job_* tools for background jobs, and terminal_* for interactive terminals when available. Use the file tools for reading and editing.',
      'Native subagents, browser tools and other MCP servers are unavailable in this execution mode. Do not invent tools. If an operation is unavailable, explain it.',
      ...opts.schemas.map(s => JSON.stringify({ name: s.name, description: s.description, parameters: s.parameters })), '',
    ].join('\n'), { flag: 'wx', mode: 0o600 })
    let disposed = false
    return { name, serverName, dispose() { if (disposed) return; disposed = true; rmSync(profile, { force: true }); rmSync(assets, { recursive: true, force: true }) } }
  } catch (e) {
    rmSync(profile, { force: true }); rmSync(assets, { recursive: true, force: true }); throw e
  }
}

/** Use the registry's official PTC transport when direct tool calls collapse. */
export async function executeHostTool(tools: ToolsServiceLike, input: BridgeToolExecutionInput, runtime?: { language?: string; programFormat?: string }) {
  const schemas = tools.schemas(input.agent)
  if (!schemas.some(s => s.name === 'run_code')) return tools.execute(input)
  if (runtime?.language !== 'typescript') throw new Error('Host tools require a TypeScript DSH tool runtime in code mode')
  const call = 'await tools[' + JSON.stringify(input.name) + '](' + JSON.stringify(input.arguments) + ')'
  const code = runtime.programFormat === 'function-body' ? 'return ' + call : 'console.log(JSON.stringify(' + call + '))'
  return tools.execute({ ...input, name: 'run_code', arguments: { code, description: 'DSH host tool: ' + input.name } })
}
