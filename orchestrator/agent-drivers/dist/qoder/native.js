// Qoder CLI stream-json transport: the same typed JSONL frames over stdio as
// Claude's, minus the streaming deltas — the CLI has no --include-partial-messages,
// so assistant frames arrive whole and text is snapshot-only.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// `--permission-mode` has no plan tier (plan mode is the EnterPlanMode tool), so
// the host's plan tier falls back to `default`, where every action asks.
// `auto` is the engine's classifier tier — ordinary actions run and recognized-
// dangerous ones ask — matching the workspace tier.
export function qoderArgs({ model, thinking, instructions, driverSessionId, permission } = {}) {
    return [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
        ...(model ? ['--model', model] : []),
        ...(thinking ? ['--reasoning-effort', thinking] : []),
        ...(permission === 'full' ? ['--permission-mode', 'bypass_permissions'] : permission === 'workspace' ? ['--permission-mode', 'auto'] : permission === 'plan' ? ['--permission-mode', 'default'] : []),
        ...(instructions ? ['--append-system-prompt', instructions] : []),
        ...(driverSessionId ? ['--resume', driverSessionId] : []),
    ];
}
export function connectQoder({ executable, args, cwd, env, onFrame = () => { }, onRequest = () => { }, onClose = () => { } }) {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let closed = false;
    let stderrTail = '';
    const write = frame => {
        if (closed || child.stdin.destroyed)
            throw new Error('Qoder CLI connection is closed');
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
    child.on('error', error => finish(new Error(`Cannot start Qoder CLI (${error.code ?? 'spawn failed'})`)));
    child.stdin.on('error', () => finish(new Error('Cannot write to Qoder CLI')));
    // stderr can carry configuration diagnostics; keep a short, secret-filtered tail.
    child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024); });
    child.on('close', (code, signal) => {
        const hint = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-300).trim();
        finish(new Error(`Qoder CLI exited (${code ?? signal})${hint ? `: ${hint}` : ''}`));
    });
    // The CLI emits its session init only after the first user frame, so "the
    // process is up" is all a boot can wait for; the session id arrives later.
    const running = new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
        child.once('close', () => reject(new Error('Qoder CLI exited during startup')));
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
            finish(new Error('Invalid Qoder protocol event'));
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
