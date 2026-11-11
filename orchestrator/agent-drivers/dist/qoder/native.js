// Qoder CLI stream-json transport: the same typed JSONL frames over stdio as
// Claude's, minus the streaming deltas — the CLI has no --include-partial-messages,
// so assistant frames arrive whole and text is snapshot-only.
import { connectStreamJson } from '../stream-json.js';
// `--permission-mode` has no plan tier (plan mode is the EnterPlanMode tool), so
// the host's plan tier falls back to `default`, where every action asks.
// `auto` is the engine's classifier tier — ordinary actions run and recognized-
// dangerous ones ask — matching the workspace tier.
export function qoderArgs({ model, thinking, instructions, driverSessionId, permission, leadMcpServers } = {}) {
    return [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
        ...(model ? ['--model', model] : []),
        ...(thinking ? ['--reasoning-effort', thinking] : []),
        ...(permission === 'full' ? ['--permission-mode', 'bypass_permissions'] : permission === 'workspace' ? ['--permission-mode', 'auto'] : permission === 'plan' ? ['--permission-mode', 'default'] : []),
        ...(instructions ? ['--append-system-prompt', instructions] : []),
        ...(driverSessionId ? ['--resume', driverSessionId] : []),
        ...(leadMcpServers?.length ? ['--mcp-config', JSON.stringify({ mcpServers: Object.fromEntries(leadMcpServers.map(server => [server.name, 'url' in server
                        ? { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${NODO_LEAD_TOKEN}' } }
                        : { command: server.command, args: server.args, env: Object.fromEntries(server.env.filter(({ name }) => !/^NODO_(LEAD|WORKER)_/.test(name)).map(({ name, value }) => [name, value])) },
                ])) })] : []),
    ];
}
export function connectQoder(options) {
    return connectStreamJson({ ...options, name: 'Qoder' });
}
