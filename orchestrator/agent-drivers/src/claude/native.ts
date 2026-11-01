// Claude Code stream-json transport: typed JSONL frames over stdio, not JSON-RPC.
// The CLI emits system/assistant/user/result frames and control_requests; the host
// side writes user frames, control_requests and control_responses.
import { connectStreamJson } from '../stream-json.js'
import type { PermissionMode } from '../spi.js'
import type { RoleMcpServer } from '../role-mcp.js'
import { LEAD_TOOLS } from '../lead-mcp.js'

export type ClaudeArgsOptions = { model?: string; thinking?: string; instructions?: string; driverSessionId?: string; permission?: PermissionMode; leadMcpServers?: RoleMcpServer[] }
export type ClaudeConnectOptions<Frame = unknown, Request = unknown> = Omit<import('../stream-json.js').StreamJsonOptions<Frame, Request>, 'name'>
export type ClaudeConnection = import('../stream-json.js').StreamJsonConnection

// The flags every driver session needs: streaming both ways, partial chunks,
// replayed user frames (they carry tool results), and prompts routed to us over
// the control channel (--permission-prompt-tool=stdio is the value the Agent SDK
// itself passes; the space-separated spelling does not arm the dispatcher).

// The CLI environment passes socket and token file paths to the MCP child.
// The token value stays out of the environment, argv and config JSON.
export function leadMcpEnv(servers?: RoleMcpServer[]) {
  return Object.fromEntries((servers ?? []).flatMap(({ env }) => env.filter(({ name }) => name.startsWith('NODO_LEAD_')).map(({ name, value }) => [name, value])))
}

const leadMcpConfig = (servers: RoleMcpServer[]) => JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ name, command, args, env }) => [name, {
  command, args, env: Object.fromEntries(env.filter(({ name }) => !name.startsWith('NODO_LEAD_')).map(({ name, value }) => [name, value])),
}])) })

export function claudeArgs({ model, thinking, instructions, driverSessionId, permission, leadMcpServers }: ClaudeArgsOptions = {}) {
  const tools = leadMcpServers?.length ? leadMcpServers.flatMap(({ name }) => LEAD_TOOLS.map(tool => `mcp__${name}__${tool}`)) : []
  return [
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool=stdio',
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--effort', thinking] : []),
    // `auto` is the engine's classifier tier — ordinary actions run and
    // recognized-dangerous ones ask — matching the workspace tier zcode calls
    // guarded; acceptEdits would still ask for every ordinary command.
    ...(permission === 'plan' ? ['--permission-mode', 'plan'] : permission === 'full' ? ['--permission-mode', 'bypassPermissions'] : permission === 'workspace' ? ['--permission-mode', 'auto'] : []),
    // The lead mount is per-process and per-resume; without --strict-mcp-config
    // the user's own MCP servers stay loaded.
    ...(tools.length ? ['--allowedTools', ...tools] : []),
    ...(leadMcpServers?.length ? ['--mcp-config', leadMcpConfig(leadMcpServers)] : []),
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(driverSessionId ? ['--resume', driverSessionId] : []),
  ]
}

export function connectClaude<Frame = unknown, Request = unknown>(options: ClaudeConnectOptions<Frame, Request>): ClaudeConnection {
  return connectStreamJson<Frame, Request>({ ...options, name: 'Claude' })
}
