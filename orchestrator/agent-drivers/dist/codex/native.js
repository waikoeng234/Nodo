import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findExecutable, launchCommand } from '../cli.js';
import { jsonRpcProcess } from '../json-rpc-process.js';
import { hostWebSocket } from '../websocket.js';
const execute = promisify(execFile);
// The desktop app installs the CLI into the user's .codex package store with a
// junction under Programs, and neither location joins PATH on Windows.
export function findCodexExecutable(bin = 'codex', { home = homedir(), path, env = process.env, platform = process.platform } = {}) {
    const extra = platform === 'win32' ? [
        join(home, '.codex/packages/standalone/current/bin'),
        ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin')] : []),
    ] : [];
    return findExecutable(bin, { home, ...(path === undefined ? {} : { path }), platform, ...(extra.length ? { extra } : {}) });
}
export async function connectCodex({ executable, cwd, env, socket, start = true, ...callbacks }) {
    // The questions capability rides the engine's request_user_input tool, gated
    // behind its default_mode_request_user_input feature; the override only lands
    // when this call actually starts the daemon, and an existing shared daemon
    // keeps whatever config it was started with.
    if (start && !socket) {
        const launch = launchCommand(executable, ['app-server', 'daemon', 'start', '-c', 'features.default_mode_request_user_input=true']);
        await execute(launch.bin, launch.args, { env: { ...process.env, ...env }, timeout: 15000, maxBuffer: 16384, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) }).catch(() => { throw new Error('Cannot start the shared Codex runtime. Verify codex app-server daemon start in your terminal.'); });
    }
    return jsonRpcProcess({ bin: executable, args: ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])], cwd, env, WebSocket: hostWebSocket(), ...callbacks });
}
export async function ensureCodexWorkspace(peer, { cwd, name, workspaceId }) {
    let cursor;
    do {
        const page = await peer.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        const existing = page.data.find(project => (project.id === workspaceId || project.roots.some(root => root.path === cwd)));
        if (existing)
            return existing.id;
        cursor = page.nextCursor;
    } while (cursor);
    // Keep the existing key namespace to reuse projects created before the rename.
    const idempotencyKey = createHash('sha256').update(`orchestrator:${cwd}`).digest('hex');
    return (await peer.request('project/create', { idempotencyKey, name: name ?? cwd.split('/').at(-1), roots: [{ path: cwd }] })).project.id;
}
