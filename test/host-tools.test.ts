import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHostToolPlugin, createHostToolProfile, executeHostTool, hostToolSchemas } from '../src/host/host-tools.ts'
import { userEnvironmentStatus } from '../src/host/user-environment.ts'

// These regressions prevent native/foreign execution and retain the host's
// permission transport. They use private temporary files and finish in <2s.
test('host profile restricts native tools and its hook rejects foreign executors', { timeout: 5000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-host-profile-'))
  const hook = join(import.meta.dirname, '../src/host/host-tools-hook.mjs')
  const plugin = createHostToolPlugin({ accountHome: home, namespace: 'web-123', bridge: { url: 'http://127.0.0.1:123', token: 'private-token', bridgeScript: '/bridge.mjs' } })
  const profile = createHostToolProfile({ accountHome: home, plugin, hookScript: hook,
    schemas: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }] })
  try {
    const source = readFileSync(join(home, '.gemini/config/agents', profile.name + '.md'), 'utf8')
    assert.match(source, /inheritMcp: false/)
    assert.doesNotMatch(source, /inheritMcp: true/)
    const registry = JSON.parse(readFileSync(join(plugin.path, 'mcp_config.json'), 'utf8'))
    assert.equal(registry.mcpServers.bridge.env.DSH_MCP_TOKEN, 'private-token')
    assert.equal(profile.serverName, 'host-tools-web-123_bridge')
    assert.match(source, new RegExp(profile.serverName))
    const otherPlugin = createHostToolPlugin({ accountHome: home, namespace: 'web-456', bridge: { url: 'http://127.0.0.1:456', token: 'other-instance', bridgeScript: '/bridge.mjs' } })
    try {
      assert.notEqual(otherPlugin.serverName, plugin.serverName)
      assert.equal(JSON.parse(readFileSync(join(plugin.path, 'mcp_config.json'), 'utf8')).mcpServers.bridge.env.DSH_MCP_TOKEN, 'private-token')
      otherPlugin.dispose()
      assert.equal(JSON.parse(readFileSync(join(plugin.path, 'mcp_config.json'), 'utf8')).mcpServers.bridge.env.DSH_MCP_TOKEN, 'private-token', 'disposing another DSH instance must preserve this bridge')
    } finally { otherPlugin.dispose() }
    assert.match(source, /tools: \[\]/)
    assert.match(source, /inheritCustomizations: false/)
    assert.match(source, /excludeDefaultComponents: true/)
    const runHook = async (name: string, server?: string) => {
      const child = execFile(process.execPath, [hook], { env: { ...process.env, DSH_HOST_MCP_SERVER: profile.serverName } })
      child.stdin!.end(JSON.stringify({ toolCall: { name, args: { ServerName: server } } }))
      let stdout = ''; for await (const chunk of child.stdout!) stdout += chunk
      await new Promise<void>((resolve, reject) => { child.once('close', code => code === 0 ? resolve() : reject(new Error('hook failed'))); child.once('error', reject) })
      return JSON.parse(stdout).decision
    }
    assert.equal(await runHook('call_mcp_tool', profile.serverName), 'allow')
    assert.equal(await runHook('call_mcp_tool', 'other'), 'deny')
    assert.equal(await runHook('run_command'), 'deny')
    assert.equal(await runHook('invoke_subagent'), 'deny')
  } finally { profile.dispose(); plugin.dispose(); assert.deepEqual(readdirSync(join(home, '.gemini/config/agents')), []); rmSync(home, { recursive: true, force: true }) }
})

test('host tools retain agent scope, enforce plan read-only and use official code-mode transport', async () => {
  const agent = { id: 'scope' }; const controller = new AbortController()
  const calls: any[] = []
  const tools = { schemas(scope?: unknown) { assert.equal(scope, agent); return ['bash', 'read', 'write', 'job_kill', 'run_code', 'invoke_subagent'].map(name => ({ name, description: '', parameters: {} })) },
    async execute(input: any) { calls.push(input); return { isError: true, content: [{ type: 'text', text: 'permission denied' }] } } }
  assert.deepEqual(hostToolSchemas(tools, agent, 'plan').map(s => s.name), ['read'])
  assert.deepEqual(hostToolSchemas(tools, agent, 'accept-edits').map(s => s.name), ['bash', 'read', 'write', 'job_kill'])
  const result = await executeHostTool(tools, { callId: 'host-call', agent, signal: controller.signal, name: 'bash', arguments: { command: 'marker' } }, { language: 'typescript', programFormat: 'function-body' })
  assert.ok(result && typeof result === 'object' && 'isError' in result)
  assert.equal(result.isError, true)
  assert.equal(calls[0].name, 'run_code')
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].signal, controller.signal)
  assert.equal(calls[0].arguments.code, 'return await tools["bash"]({"command":"marker"})')
  await assert.rejects(() => executeHostTool(tools, { callId: 'unsupported', agent, signal: controller.signal, name: 'bash', arguments: {} }, { language: 'unsupported' }), /TypeScript/)
  assert.equal(calls.length, 1, 'unsupported runtimes must never fall back to direct execution')
  assert.equal(userEnvironmentStatus('shared', true).effectiveMode, 'shared')
  assert.equal(userEnvironmentStatus('shared', false).effectiveMode, 'isolated')
})
