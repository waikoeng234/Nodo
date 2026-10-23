// Reusable stdio JSON-RPC transport. Protocol methods and event translation
// belong to adapters, so another JSONL CLI need not duplicate process plumbing.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
export function jsonRpcProcess({ bin, args, cwd, env, jsonrpc, WebSocket, onNotification = () => { }, onRequest = () => { }, onClose = () => { } }) {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map();
    let sequence = 0;
    let closed = false;
    let killTimer;
    let exitTimer;
    let lines;
    const socket = WebSocket ? new WebSocket('ws://localhost/', { createConnection: () => Duplex.from({ readable: child.stdout, writable: child.stdin }) }) : null;
    const write = (message) => {
        if (closed || child.stdin.destroyed)
            throw new Error('CLI connection is closed');
        const encoded = JSON.stringify({ ...(jsonrpc ? { jsonrpc } : {}), ...message });
        if (!socket)
            child.stdin.write(`${encoded}\n`);
        else if (socket.readyState === WebSocket.OPEN)
            socket.send(encoded);
        else
            socket.once('open', () => { if (!closed)
                socket.send(encoded); });
    };
    const finish = (error) => {
        if (closed)
            return;
        closed = true;
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
        try {
            onClose(error);
        }
        finally {
            socket?.terminate();
            lines?.close();
            child.stdin.end();
            child.stdout.destroy();
            child.stderr.destroy();
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                killTimer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null)
                        child.kill('SIGKILL');
                }, 1000);
                killTimer.unref();
            }
        }
    };
    child.on('error', error => finish(new Error(`Cannot start CLI (${error.code ?? 'spawn failed'})`)));
    child.stdin.on('error', () => finish(new Error('Cannot write to CLI')));
    // CLI stderr can contain provider credentials or configuration diagnostics.
    // Keep only a short tail to explain exit failures, dropping lines that name
    // secrets, and never return raw output to the browser or transcripts.
    let stderrTail = '';
    child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024); });
    const stderrHint = () => {
        const text = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-400).trim();
        return text ? `: ${text}` : '';
    };
    const exited = (code, signal) => finish(new Error(`CLI exited (${code ?? signal})${stderrHint()}`));
    child.on('close', (code, signal) => { clearTimeout(killTimer); clearTimeout(exitTimer); exited(code, signal); });
    // A descendant that inherited stdout keeps `close` from firing after the CLI itself exits.
    child.on('exit', (code, signal) => {
        clearTimeout(killTimer);
        exitTimer = setTimeout(exited, 1000, code, signal);
        exitTimer.unref();
    });
    const receive = line => {
        if (closed)
            return;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (message === null || typeof message !== 'object')
            return;
        if (message.method) {
            try {
                if (message.id !== undefined)
                    onRequest(message);
                else
                    onNotification(message);
            }
            catch {
                finish(new Error('Invalid CLI protocol event'));
            }
            return;
        }
        const request = pending.get(message.id);
        if (!request)
            return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
            request.reject(Object.assign(new Error(message.error.message ?? 'CLI request failed'), { code: message.error.code, data: message.error.data, method: request.method }));
        else
            request.resolve(message.result);
    };
    if (socket) {
        socket.on('message', body => receive(body.toString()));
        socket.on('error', () => finish(new Error('Shared CLI WebSocket connection failed')));
        socket.on('close', () => finish(new Error('Shared CLI connection closed')));
    }
    else
        lines = createInterface({ input: child.stdout }).on('line', receive);
    return {
        request(method, params = {}, timeout = 15_000) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                // ACP session/prompt settles only at turn completion; null leaves its
                // lifetime to the driver's cancel/dispose and the host's idle watchdog.
                const timer = timeout === null ? null : setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`CLI request timed out: ${method}`), { name: 'TimeoutError' })); }, timeout);
                pending.set(id, { resolve, reject, timer, method });
                try {
                    write({ id, method, params });
                }
                catch (error) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        },
        notify(method, params = {}) { write({ method, params }); },
        reply(id, result) { write({ id, result }); },
        refuse(id, message = 'Unsupported client request') { write({ id, error: { code: -32601, message } }); },
        dispose() {
            finish(new Error('CLI connection disposed'));
        },
    };
}
