// Claude Code stream-json transport: typed JSONL frames over stdio, not JSON-RPC.
// The CLI emits system/assistant/user/result frames and control_requests; the host
// side writes user frames, control_requests and control_responses.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// The flags every driver session needs: streaming both ways, partial chunks,
// replayed user frames (they carry tool results), and prompts routed to us over
// the control channel (--permission-prompt-tool=stdio is the value the Agent SDK
// itself passes; the space-separated spelling does not arm the dispatcher).
export function claudeArgs({ model, thinking, instructions, driverSessionId, permission } = {}) {
    return [
        '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool=stdio',
        ...(model ? ['--model', model] : []),
        ...(thinking ? ['--effort', thinking] : []),
        // `auto` is the engine's classifier tier — ordinary actions run and
        // recognized-dangerous ones ask — matching the workspace tier zcode calls
        // guarded; acceptEdits would still ask for every ordinary command.
        ...(permission === 'plan' ? ['--permission-mode', 'plan'] : permission === 'full' ? ['--permission-mode', 'bypassPermissions'] : permission === 'workspace' ? ['--permission-mode', 'auto'] : []),
        ...(instructions ? ['--append-system-prompt', instructions] : []),
        ...(driverSessionId ? ['--resume', driverSessionId] : []),
    ];
}
export function connectClaude({ executable, args, cwd, env, onFrame = () => { }, onRequest = () => { }, onClose = () => { } }) {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let closed = false;
    let stderrTail = '';
    const write = frame => {
        if (closed || child.stdin.destroyed)
            throw new Error('Claude CLI connection is closed');
        child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const finish = error => {
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
