import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startMcpBridge } from '../src/host/mcp-bridge.ts'
import { createHostToolPlugin, createHostToolProfile } from '../src/host/host-tools.ts'

const exec = promisify(execFile)
const agy = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'agy')).find(existsSync)
// This contract test uses a real CLI and a local fake endpoint, never a real
// credential/model. Missing or unverified CLI versions skip it on other hosts.
test('real agy routes host tools and rejects native/foreign execution', { timeout: 45000, skip: process.platform !== 'darwin' || !agy }, async t => {
  const version = (await exec(agy!, ['--version'], { timeout: 5000 })).stdout.trim()
  if (version !== '1.4.8') { t.skip('runtime contract verified for agy 1.4.8 only'); return }
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-contract-'))
  const home = join(root, 'account'); const work = join(root, 'workspace'); const hostHome = join(root, 'system')
  for (const dir of [join(home, '.gemini/antigravity-cli'), work, hostHome]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ modelProvider: 'gemini' }))
  const controller = new AbortController(); const agent = { id: 'session-contract' }
  let hostCalls = 0; let step = 0; const modelRequests: any[] = []
  const tools = { schemas(scope?: unknown) { assert.equal(scope, agent); return [{ name: 'bash', description: 'Execute a host command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] },
    async execute(input: any) {
      assert.equal(input.agent, agent); assert.equal(input.signal.aborted, false); assert.equal(input.name, 'bash')
      hostCalls++
      const output = await exec(process.execPath, ['-p', 'JSON.stringify({home:require("node:os").homedir(),cwd:process.cwd()})'], { cwd: work, env: { ...process.env, HOME: hostHome }, signal: input.signal })
      return { content: [{ type: 'text', text: output.stdout }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }
    } }
  const bridge = await startMcpBridge({ bridgeScript: join(import.meta.dirname, '../src/host/bridge.mjs'), tools: () => tools, allowlist: () => 'bash', requireRun: () => true, resolveAgent: id => id === agent.id ? agent : undefined })
  const lease = bridge.registerRun({ sessionId: agent.id, signal: controller.signal, allowedTools: ['bash'] })
  // An actual ambient server catches accidental inheritance; a nonexistent
  // server would fail even if the profile allowed every MCP server.
  const ambientMarker = join(root, 'ambient-calls')
  const ambientScript = join(root, 'ambient.mjs')
  writeFileSync(ambientScript, `import readline from 'node:readline'; import {appendFileSync} from 'node:fs';
for await (const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(!('id' in q))continue; let result={};
 if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'ambient',version:'1'}};
 if(q.method==='tools/list')result={tools:[{name:'bash',description:'ambient command',inputSchema:{type:'object'}}]};
 if(q.method==='tools/call'){appendFileSync(process.env.MARKER,'EXECUTED');result={content:[{type:'text',text:'FOREIGN_MUST_NOT_RUN'}]}};
 console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
}`)
  mkdirSync(join(home, '.gemini/config'), { recursive: true })
  const ambientRegistry = JSON.stringify({mcpServers:{'foreign-server':{command:process.execPath,args:[ambientScript],env:{MARKER:ambientMarker}}}})
  const registryPath = join(home, '.gemini/config/mcp_config.json')
  writeFileSync(registryPath, ambientRegistry)
  const plugin = createHostToolPlugin({ accountHome: home, namespace: 'web-123', bridge })
  const profile = createHostToolProfile({ accountHome: home, plugin, hookScript: join(import.meta.dirname, '../src/host/host-tools-hook.mjs'), schemas: tools.schemas(agent) })
  let name = profile.serverName
  const server = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}; const main = (req.url ?? '').includes('gemini-3.8-flash:')
    let part: any = { text: 'HOST_CONTRACT_COMPLETE' }
    if (main) {
      modelRequests.push(body); step++
      if (step === 1 || step === 5) part = { functionCall: { name: 'call_mcp_tool', args: { ServerName: name, ToolName: 'bash', Arguments: { command: 'fixed-test-marker' } } } }
      if (step === 2) part = { functionCall: { name: 'run_command', args: { CommandLine: 'printf NATIVE_MUST_NOT_RUN', Cwd: work, WaitMsBeforeAsync: 1000 } } }
      if (step === 3) part = { functionCall: { name: 'call_mcp_tool', args: { ServerName: 'foreign-server', ToolName: 'bash', Arguments: {} } } }
    }
    const reply = { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify(reply) + '\n\n')
  })().catch(error => { res.writeHead(500); res.end(String(error)) }) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const result = await exec(agy!, ['--agent', profile.name, '--model', 'gemini-3.8-flash', '--dangerously-skip-permissions', '-p', 'Run the local host contract test.', '--output-format', 'stream-json', '--print-timeout', '25s'], {
      cwd: work, env: { PATH: process.env.PATH, HOME: home, GEMINI_API_KEY: 'FAKE_LOCAL_ONLY', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:' + port,
        NO_PROXY: '127.0.0.1,localhost', AGY_CLI_DISABLE_AUTO_UPDATE: '1', DSH_MCP_SESSION: agent.id, DSH_MCP_RUN_TOKEN: lease.token, DSH_HOST_MCP_SERVER: name }, timeout: 35000, maxBuffer: 1000000,
    })
    assert.equal(hostCalls, 1)
    assert.equal(existsSync(ambientMarker), false, 'ambient MCP tool must never execute')
    assert.equal(readFileSync(registryPath, 'utf8'), ambientRegistry, 'host mode must not mutate global MCP registrations')
    const history = JSON.stringify(modelRequests)
    assert.ok(history.includes(hostHome), 'host process must observe system HOME')
    assert.match(history, /inlineData|inline_data/, 'authorized host tool images must reach the model')
    assert.ok(history.includes(work), 'host process must observe the selected workspace')
    const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    const errors = events.filter(e => e.step_update?.state === 'ERROR').map(e => e.step_update.tool_info?.error?.message ?? '').join('\n')
    assert.match(errors, /unknown tool.*run_command|denied by pre-tool hook/)
    assert.match(errors, /configured DSH host tools/)
    assert.match(result.stdout, /HOST_CONTRACT_COMPLETE/)
    const cid = events.find(e => e.event === 'init')?.conversation_id
    assert.ok(cid)
    profile.dispose()
    const nextProfile = createHostToolProfile({ accountHome: home, plugin, hookScript: join(import.meta.dirname, '../src/host/host-tools-hook.mjs'), schemas: tools.schemas(agent) })
    name = nextProfile.serverName
    try {
      const next = await exec(agy!, ['--agent', nextProfile.name, '--conversation', cid, '--model', 'gemini-3.8-flash', '--dangerously-skip-permissions', '-p', 'Continue the same host contract.', '--output-format', 'stream-json', '--print-timeout', '15s'], {
        cwd: work, env: { PATH: process.env.PATH, HOME: home, GEMINI_API_KEY: 'FAKE_LOCAL_ONLY', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:' + port,
          NO_PROXY: '127.0.0.1,localhost', AGY_CLI_DISABLE_AUTO_UPDATE: '1', DSH_MCP_SESSION: agent.id, DSH_MCP_RUN_TOKEN: lease.token, DSH_HOST_MCP_SERVER: name }, timeout: 20000, maxBuffer: 1000000,
      })
      assert.equal(hostCalls, 2, 'a resumed conversation must use the new guarded profile')
      assert.match(next.stdout, /HOST_CONTRACT_COMPLETE/)
    } finally { nextProfile.dispose() }

  } finally {
    controller.abort(); await lease.dispose(); profile.dispose(); plugin.dispose(); await bridge.close()
    await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true })
  }
})
