// Only the session-bound DSH MCP executor may run tools in host mode.
// This hook does not execute commands or grant DSH permissions.
let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk
try {
  const { toolCall } = JSON.parse(raw)
  const allowed = toolCall?.name === 'call_mcp_tool'
    && typeof process.env.DSH_HOST_MCP_SERVER === 'string'
    && process.env.DSH_HOST_MCP_SERVER !== ''
    && toolCall.args?.ServerName === process.env.DSH_HOST_MCP_SERVER
  process.stdout.write(JSON.stringify({
    decision: allowed ? 'allow' : 'deny',
    reason: allowed ? 'Execute through the session-bound DSH host tools and its permission checks.'
      : 'Host execution mode only permits the configured DSH host tools. Native tools, subagents and other MCP servers are unavailable in this mode.',
  }))
} catch {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Invalid host tool request.' }))
}
