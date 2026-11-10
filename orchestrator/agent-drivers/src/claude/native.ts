// Claude Code stream-json transport: typed JSONL frames over stdio, not JSON-RPC.
// The CLI emits system/assistant/user/result frames and control_requests; the host
// side writes user frames, control_requests and control_responses.
import { connectStreamJson } from '../stream-json.js'
import type { PermissionMode } from '../spi.js'
import type { McpMount } from '../role-mcp.js'
import { LEAD_TOOLS } from '../lead-mcp.js'
import { WORKER_TOOLS } from '../worker-mcp.js'

export type ClaudeArgsOptions = { model?: string; thinking?: string; instructions?: string; driverSessionId?: string; permission?: PermissionMode; leadMcpServers?: McpMount[] }
export type ClaudeConnectOptions<Frame = unknown, Request = unknown> = Omit<import('../stream-json.js').StreamJsonOptions<Frame, Request>, 'name'>
export type ClaudeConnection = import('../stream-json.js').StreamJsonConnection

// The flags every driver session needs: streaming both ways, partial chunks,
// replayed user frames (they carry tool results), and prompts routed to us over
// the control channel (--permission-prompt-tool=stdio is the value the Agent SDK
// itself passes; the space-separated spelling does not arm the dispatcher).

// The CLI environment passes socket and token file paths to the MCP child, or
// the HTTP token that the config's header expands; the token value stays out
// of argv and config JSON.
export function leadMcpEnv(servers?: McpMount[]) {
  return Object.fromEntries((servers ?? []).flatMap(server => 'url' in server ? [['NODO_LEAD_TOKEN', server.token]]
    : server.env.filter(({ name }) => /^NODO_(LEAD|WORKER)_/.test(name)).map(({ name, value }) => [name, value])))
}

const leadMcpConfig = (servers: McpMount[]) => JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, 'url' in server
  ? { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${NODO_LEAD_TOKEN}' } }
  : { command: server.command, args: server.args, env: Object.fromEntries(server.env.filter(({ name }) => !/^NODO_(LEAD|WORKER)_/.test(name)).map(({ name, value }) => [name, value])) },
])) })

export function claudeArgs({ model, thinking, instructions, driverSessionId, permission, leadMcpServers }: ClaudeArgsOptions = {}) {
  const lead = !!leadMcpServers?.some(({ name }) => name !== 'nodo_worker')
  const tools = leadMcpServers?.length ? leadMcpServers.flatMap(({ name }) => (name === 'nodo_worker' ? WORKER_TOOLS : LEAD_TOOLS).map(tool => `mcp__${name}__${tool}`)) : []
  return [
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool=stdio',
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--effort', thinking] : []),
    // `auto` is the engine's classifier tier — ordinary actions run and
    // recognized-dangerous ones ask — matching the workspace tier zcode calls
    // guarded; acceptEdits would still ask for every ordinary command.
    ...(permission === 'plan' ? ['--permission-mode', 'plan'] : permission === 'full' ? ['--permission-mode', 'bypassPermissions'] : permission === 'workspace' ? ['--permission-mode', 'auto'] : []),
    // A leader runs on empty built-ins and only the per-process mount
    // (--strict-mcp-config drops the user's own MCP servers); personal
    // CLAUDE.md, skills, hooks and plugins stay. The CLI does not validate
    // --tools names, so the arg-snapshot test is the drift guard.
    ...(lead ? ['--tools', '', '--strict-mcp-config'] : []),
    ...(tools.length ? ['--allowedTools', ...tools] : []),
    ...(leadMcpServers?.length ? ['--mcp-config', leadMcpConfig(leadMcpServers)] : []),
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(driverSessionId ? ['--resume', driverSessionId] : []),
  ]
}

export function connectClaude<Frame = unknown, Request = unknown>(options: ClaudeConnectOptions<Frame, Request>): ClaudeConnection {
  return connectStreamJson<Frame, Request>({ ...options, name: 'Claude' })
}
