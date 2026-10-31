// Claude Code stream-json transport: typed JSONL frames over stdio, not JSON-RPC.
// The CLI emits system/assistant/user/result frames and control_requests; the host
// side writes user frames, control_requests and control_responses.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { launchCommand } from '../cli.js';
import { LEAD_TOOLS } from '../lead-mcp.js';
// The flags every driver session needs: streaming both ways, partial chunks,
// replayed user frames (they carry tool results), and prompts routed to us over
// the control channel (--permission-prompt-tool=stdio is the value the Agent SDK
// itself passes; the space-separated spelling does not arm the dispatcher).
// The CLI environment passes socket and token file paths to the MCP child.
// The token value stays out of the environment, argv and config JSON.
export function leadMcpEnv(servers) {
    return Object.fromEntries((servers ?? []).flatMap(({ env }) => env.filter(({ name }) => name.startsWith('NODO_LEAD_')).map(({ name, value }) => [name, value])));
}
const leadMcpConfig = (servers) => JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ name, command, args, env }) => [name, {
            command, args, env: Object.fromEntries(env.filter(({ name }) => !name.startsWith('NODO_LEAD_')).map(({ name, value }) => [name, value])),
        }])) });
export function claudeArgs({ model, thinking, instructions, driverSessionId, permission, leadMcpServers } = {}) {
    const tools = leadMcpServers?.length ? leadMcpServers.flatMap(({ name }) => LEAD_TOOLS.map(tool => `mcp__${name}__${tool}`)) : [];
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
    ];
}
export function connectClaude({ executable, args, cwd, env, onFrame = () => { }, onRequest = () => { }, onClose = () => { } }) {
    const launch = launchCommand(executable, args ?? []);
    const child = spawn(launch.bin, launch.args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) });
    let closed = false;
    let stderrTail = '';
    const write = (frame) => {
        if (closed || child.stdin.destroyed)
            throw new Error('Claude CLI connection is closed');
        child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const finish = (error) => {
        if (closed)
            return;
        closed = true;
        onClose(error);
        if (child.exitCode === null)
            child.kill('SIGTERM');
    };
    child.on('error', error => finish(new Error(`Cannot start Claude CLI (${error.code ?? 'spawn failed'})`)));
    child.stdin.on('error', () => finish(new Error('Cannot write to Claude CLI')));
    // stderr can carry configuration diagnostics; keep a short, secret-filtered tail.
    child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024); });
    child.on('close', (code, signal) => {
        const hint = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-300).trim();
        finish(new Error(`Claude CLI exited (${code ?? signal})${hint ? `: ${hint}` : ''}`));
    });
    // The CLI emits its session init only after the first user frame, so "the
    // process is up" is all a boot can wait for; the session id arrives later.
    const running = new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
        child.once('close', () => reject(new Error('Claude CLI exited during startup')));
    });
    createInterface({ input: child.stdout }).on('line', line => {
        if (closed)
            return;
        let frame;
        try {
            frame = JSON.parse(line);
        }
        catch {
            return;
        }
        try {
            if (frame.type === 'control_request')
                onRequest(frame);
            else
                onFrame(frame);
        }
        catch {
            finish(new Error('Invalid Claude protocol event'));
        }
    });
    return {
        write,
        running,
        dispose() {
            if (closed)
                return;
            closed = true;
            child.stdin.end();
            if (child.exitCode === null)
                child.kill('SIGTERM');
        },
    };
}
