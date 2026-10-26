import { readdirSync, statSync, constants, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STEER, addUsage, usageOf } from '../spi.js';
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js';
import { createCoverage, DECLARED } from '../coverage.js';
import { createFileChanges, replacementEdit } from '../file-changes.js';
import { qoderArgs, connectQoder } from './native.js';
export { findExecutable } from '../cli.js';
export const qoderInfo = {
    id: 'qoder', label: 'Qoder CLI', command: 'qodercli', requiresCwd: true,
    description: 'Uses the local Qoder CLI and its existing login; sessions live in the shared Qoder store.',
    fields: [
        { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect qodercli; or enter an absolute path' },
        { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'Model name such as Qwen3.8-Flash; blank uses Qoder settings' },
    ],
    capabilities: { resume: true, steer: false, permissions: true, questions: true, commands: true, compact: true, permissionModes: ['workspace', 'full'] },
};
// PATH rarely carries qodercli; the desktop installs a versioned binary under
// ~/.qoder/bin/qodercli. An explicitly configured path is used strictly; the
// bare command name (unconfigured, or the catalog's own lookup) falls back to
// discovery, highest version first.
export function findQoderExecutable(bin = 'qodercli') {
    const direct = findExecutable(bin);
    if (direct || bin !== 'qodercli')
        return direct;
    const dir = join(homedir(), '.qoder/bin/qodercli');
    let names;
    try {
        names = readdirSync(dir).filter(name => name.startsWith('qodercli'));
    }
    catch {
        return undefined;
    }
    const ordered = names.filter(name => /^qodercli-\d[\w.-]*$/.test(name))
        .sort(new Intl.Collator(undefined, { numeric: true }).compare).reverse()
        .concat(names.filter(name => !name.includes('-')));
    for (const name of ordered) {
        const candidate = join(dir, name);
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile())
                return candidate;
        }
        catch { }
    }
    return undefined;
}
export function validateQoderOptions(raw = {}) {
    for (const key of Object.keys(raw))
        if (key !== 'bin')
            throw invalidConfig(`Unsupported Qoder option: ${key}`);
    const bin = validateBin(raw.bin);
    return bin ? { bin } : {};
}
// The initialize control round-trip is the protocol check; it answers before
// the session starts and at no model cost. Model/credential truth stays with
// the first real turn, same honesty as the other adapters.
export function handshakeQoder({ executable, cwd, env }) {
    return new Promise((resolve, reject) => {
        let peer;
        const timer = setTimeout(() => settle(reject, new Error('handshake timed out')), 20_000);
        const settle = (fn, value) => { clearTimeout(timer); const connection = peer; peer = null; if (fn === reject)
            connection?.dispose(); fn(value); };
        try {
            peer = connectQoder({ executable, args: qoderArgs({}), cwd, env,
                onClose: error => settle(reject, error),
                onRequest: frame => { if (peer)
                    peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'No active turn' } } }); },
                onFrame: frame => {
                    if (frame.type !== 'control_response' || frame.response?.request_id !== 'orch-check')
                        return;
                    const response = frame.response.response;
                    if (frame.response.subtype !== 'success')
                        return settle(reject, new Error('Qoder rejected initialization'));
                    if (!response || typeof response !== 'object' || Array.isArray(response))
                        return settle(reject, new Error('Invalid Qoder initialize response'));
                    settle(resolve, { peer: peer, response: response });
                } });
            peer.write({ type: 'control_request', request_id: 'orch-check', request: { subtype: 'initialize' } });
        }
        catch (error) {
            settle(reject, error);
        }
    });
}
export async function checkQoder({ cwd, engineOptions = {} } = {}) {
    const checks = [];
    try {
        validateWorkspace(cwd, true);
        checks.push({ label: 'Working directory', ok: true, message: cwd });
    }
    catch (error) {
        checks.push({ label: 'Working directory', ok: false, message: error.message });
    }
    const options = validateQoderOptions(engineOptions);
    const executable = findQoderExecutable(options.bin);
    if (!executable)
        return { engine: 'qoder', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'Qoder CLI executable not found. Install Qoder or enter its absolute path.' }] };
    let version;
    try {
        version = await cliVersion(executable);
        checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` });
    }
    catch {
        return { engine: 'qoder', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] };
    }
    let peer;
    try {
        const peek = await handshakeQoder({ executable, cwd });
        peer = peek.peer;
        const protocol = typeof peek.response.protocol_version === 'string' ? peek.response.protocol_version : undefined;
        const login = peek.response.account?.userId !== undefined;
        checks.push({ label: 'Protocol', ok: true, message: `Qoder stream protocol connected${protocol ? ` (protocol ${protocol})` : ''}` });
        checks.push({ label: 'Login', ok: login ? true : null, message: login ? 'The CLI reports a signed-in account.' : 'The initialize response carries no account; the model route stays unverified until a turn runs.' });
    }
    catch (error) {
        checks.push({ label: 'Protocol', ok: false, message: `Could not reach the Qoder stream protocol (${error.message}). Verify the installation; the first start may take a moment.` });
    }
    finally {
        peer?.dispose();
    }
    return { engine: 'qoder', ok: checks.every(check => check.ok !== false), executable, version, checks };
}
// The initialize response's model table: `value` is what --model takes back,
// displayName names the row, `efforts` are the levels that model accepts and
// `defaultEffort` its preset. The `isDefault` entry is the configured default.
const qoderCatalog = (models) => (Array.isArray(models) ? models : []).flatMap(model => {
    if (typeof model?.value !== 'string' || model.value === '')
        return [];
    const levels = Array.isArray(model.efforts) ? model.efforts.filter((level) => typeof level === 'string' && level !== '') : [];
    return [{ id: model.value,
            ...(typeof model.displayName === 'string' && model.displayName !== '' ? { label: model.displayName } : {}),
            ...(typeof model.defaultEffort === 'string' && model.defaultEffort !== '' ? { defaultThinking: model.defaultEffort } : {}),
            ...(levels.length ? { thinking: levels.map(id => ({ id })) } : {}) }];
});
export async function scanQoder({ engineOptions = {}, cwd } = {}) {
    const options = validateQoderOptions(engineOptions);
    const executable = findQoderExecutable(options.bin);
    if (!executable)
        return { source: 'Qoder CLI not found', models: [] };
    try {
        const peek = await handshakeQoder({ executable, cwd });
        peek.peer.dispose();
        const models = qoderCatalog(peek.response.models);
        const fallback = Array.isArray(peek.response.models) ? peek.response.models.find(model => model?.isDefault === true) : undefined;
        return { source: 'Qoder initialize response',
            ...(typeof fallback?.value === 'string' && fallback.value !== '' ? { defaultModel: fallback.value } : {}), models };
    }
    catch {
        return { source: 'Qoder scan failed', models: [] };
    }
}
// The initialize response's command table is the protocol's own /-menu listing.
export async function scanQoderCommands({ engineOptions = {}, cwd } = {}) {
    const options = validateQoderOptions(engineOptions);
    const executable = findQoderExecutable(options.bin);
    if (!executable)
        return { source: 'Qoder CLI', commands: [] };
    try {
        const peek = await handshakeQoder({ executable, cwd });
        peek.peer.dispose();
        const commands = (Array.isArray(peek.response.commands) ? peek.response.commands : []).flatMap(command => typeof command?.name === 'string' && command.name !== '' && command.name.length <= 200
            ? [{ id: command.name, ...(typeof command.description === 'string' && command.description !== '' ? { description: command.description.slice(0, 200) } : {}) }]
            : []);
        return { source: 'Qoder initialize response', commands };
    }
    catch {
        return { source: 'Qoder CLI', commands: [] };
    }
}
// The CLI confirms a Write in its own words ("File created successfully …") and
// an Edit by completing without error; the inputs themselves name the content.
// There is no structured tool_use_result to check the path against, so a
// changed response shape simply drops out of the snapshot.
function qoderFileChanges(name, input, resultText) {
    if (name === 'Write' && typeof input?.file_path === 'string' && typeof input?.content === 'string') {
        const created = typeof resultText === 'string' && /created successfully/i.test(resultText);
        return [{ path: input.file_path, edit: { operation: created ? 'add' : 'update', newText: input.content, ...(created ? { oldText: null } : {}) } }];
    }
    if (name === 'Edit' && typeof input?.file_path === 'string' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string')
        return [{ path: input.file_path, edit: replacementEdit(input.file_path, input.old_string, input.new_string) }];
    return [];
}
// One assistant frame is one request, so its prompt-side token sum is the
// context occupancy; the routed model's context window rides the result frame.
const qoderPromptTokens = (raw) => {
    const parts = [raw?.input_tokens, raw?.cache_read_input_tokens, raw?.cache_creation_input_tokens];
    return parts.some(value => typeof value === 'number' && Number.isFinite(value))
        ? parts.reduce((total, value) => total + (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0), 0)
        : undefined;
};
// A free route bills nothing, so its Anthropic counters all read 0 while the CLI still
// reports the request's context occupancy as a ratio of the routed model's window.
const qoderRatioTokens = (raw, contextWindow) => typeof raw?.context_usage_ratio === 'number' && raw.context_usage_ratio > 0
    && typeof contextWindow === 'number' && contextWindow > 0
    ? Math.round(raw.context_usage_ratio * contextWindow) : undefined;
export function createQoderDriver({ onEvent, bin, cwd, env = {}, model, thinking, permission, driverSessionId, instructions } = {}) {
    const emit = (event) => { try {
        onEvent?.(event);
    }
    catch { } };
    let peer = null;
    let ready = null;
    let sessionId = driverSessionId;
    let connected = false;
    let disposed = false;
    let sequence = 0;
    let controlSeq = 0;
    let running = null;
    const controls = new Map();
    const requests = new Map();
    const coverage = createCoverage('qoder');
    const closeRequests = () => {
        for (const id of requests.keys())
            emit({ type: 'request/closed', id });
        requests.clear();
    };
    const disconnect = () => {
        const connection = peer;
        peer = null;
        ready = null;
        connected = false;
        for (const pending of controls.values())
            pending.reject(new Error('Qoder connection closed'));
        controls.clear();
        connection?.dispose();
    };
    const end = (reason, error, usage, text) => {
        if (!running)
            return;
        const turn = running;
        running = null;
        for (const [id, pending] of controls)
            if (pending.turn === turn) {
                controls.delete(id);
                pending.reject(new Error('Qoder turn ended'));
            }
        usage ??= turn.usage;
        turn.settle?.();
        closeRequests();
        if (turn.changes)
            emit(turn.changes.snapshot(turn.id));
        emit({ type: 'turn/end', turnId: turn.id, reason, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) });
    };
    const control = (request) => new Promise((resolve, reject) => {
        const request_id = `orch-${++controlSeq}`;
        const timer = setTimeout(() => { if (controls.delete(request_id))
            reject(new Error('Qoder control request timed out')); }, 5000);
        controls.set(request_id, { turn: running, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        try {
            peer.write({ type: 'control_request', request_id, request });
        }
        catch (error) {
            controls.delete(request_id);
            clearTimeout(timer);
            reject(error);
        }
    });
    const startTool = (block, parentCallId) => {
        const turn = running;
        if (turn.completedTools.has(block.id))
            return;
        const previous = turn.tools.get(block.id);
        turn.tools.set(block.id, { name: block.name ?? previous?.name ?? 'tool', input: block.input ?? previous?.input,
            parentCallId: parentCallId ?? previous?.parentCallId });
        if (!previous)
            emit({ type: 'tool', turnId: turn.id, callId: block.id, name: block.name ?? 'tool', phase: 'start', input: block.input,
                ...(parentCallId ? { parentCallId } : {}) });
    };
    const receive = (frame) => {
        if (frame.type === 'control_response') {
            const pending = controls.get(frame.response?.request_id);
            if (!pending)
                return;
            controls.delete(frame.response.request_id);
            frame.response.subtype === 'success' ? pending.resolve(frame.response.response) : pending.reject(new Error(frame.response.error ?? 'Qoder rejected the control request'));
            return;
        }
        if (frame.session_id && sessionId && frame.session_id !== sessionId)
            return;
        if (frame.type === 'system') {
            if (frame.subtype !== 'init' && !DECLARED.qoder.variants[frame.subtype])
                coverage.count('unknown-variant');
            if (frame.subtype === 'init') {
                coverage.setIdentity({ transport: 'stream-json', protocolVersion: frame.protocol_version, cliVersion: frame.qodercli_version });
                if (typeof frame.session_id === 'string' && frame.session_id !== '') {
                    sessionId = frame.session_id;
                    connected = true;
                    emit({ type: 'session', state: 'ready', sessionId });
                }
            }
            if (running && frame.subtype === 'status' && frame.status === 'compacting' && !running.compacting) {
                running.compacting = true;
                emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'start' });
            }
            if (running && frame.subtype === 'compact_boundary') {
                running.compacting = false;
                emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' });
            }
            if (running && frame.subtype === 'task_started' && typeof frame.task_id === 'string' && frame.task_id !== '') {
                if (running.tasks.has(frame.task_id))
                    return;
                running.tasks.set(frame.task_id, true);
                emit({ type: 'activity', turnId: running.id, phase: 'start', entityId: frame.task_id, name: 'task',
                    ...(typeof frame.description === 'string' && frame.description ? { title: frame.description, detail: frame.description } : {}),
                    ...(frame.parent_task_id ? { parentId: frame.parent_task_id } : {}),
                    ...(frame.tool_use_id ? { toolCallId: frame.tool_use_id } : {}) });
            }
            if (running && frame.subtype === 'task_progress' && running.tasks.get(frame.task_id) === true) {
                emit({ type: 'activity', turnId: running.id, phase: 'update', entityId: frame.task_id, name: 'task',
                    ...(typeof frame.summary === 'string' && frame.summary ? { detail: frame.summary }
                        : typeof frame.last_tool_name === 'string' && frame.last_tool_name ? { detail: `最近工具：${frame.last_tool_name}` } : {}) });
            }
            if (running && frame.subtype === 'task_notification' && running.tasks.get(frame.task_id) === true) {
                running.tasks.set(frame.task_id, false);
                emit({ type: 'activity', turnId: running.id, phase: 'end', entityId: frame.task_id, name: 'task',
                    ...(typeof frame.summary === 'string' && frame.summary ? { detail: frame.summary } : {}),
                    isError: frame.status === 'failed' });
            }
            return;
        }
        if (!running)
            return;
        const turn = running;
        if (frame.type === 'user') {
            if (frame.isReplay === true)
                return;
            for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
                if (block.type !== 'tool_result' || !turn.tools.has(block.tool_use_id))
                    continue;
                const tool = turn.tools.get(block.tool_use_id);
                turn.tools.delete(block.tool_use_id);
                turn.completedTools.add(block.tool_use_id);
                turn.changes?.add(block.tool_use_id, qoderFileChanges(tool.name, tool.input, typeof block.content === 'string' ? block.content : undefined), block.is_error !== true);
                emit({ type: 'tool', turnId: turn.id, callId: block.tool_use_id, name: tool.name, phase: 'end', input: tool.input, output: block.content,
                    isError: block.is_error === true, ...(tool.parentCallId ? { parentCallId: tool.parentCallId } : {}) });
            }
            return;
        }
        if (frame.type === 'assistant') {
            const used = qoderPromptTokens(frame.message?.usage);
            if (used !== undefined)
                turn.contextUsed = used;
            const messageId = frame.message?.id;
            const seen = messageId && turn.messages.has(messageId);
            for (const [index, block] of (Array.isArray(frame.message?.content) ? frame.message.content : []).entries()) {
                if (block.type === 'text' && block.text && !seen) {
                    turn.textEmitted = true;
                    emit({ type: 'text', turnId: turn.id, text: block.text, messageId, blockIndex: index,
                        ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) });
                }
                if (block.type === 'tool_use')
                    startTool(block, frame.parent_tool_use_id ?? undefined);
                if (block.type === 'thinking' && block.thinking && !seen)
                    emit({ type: 'thinking', turnId: turn.id, text: block.thinking, messageId, blockIndex: index, boundary: 'end',
                        ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) });
            }
            if (messageId)
                turn.messages.add(messageId);
            return;
        }
        if (frame.type === 'result') {
            // An interrupt receipt maps the generic execution failure to the stop the
            // host asked for; everything else that is not a clean success is an error.
            const reason = frame.subtype === 'success' && frame.is_error !== true ? 'done'
                : turn.interrupting ? 'interrupted' : 'error';
            const error = reason === 'error'
                ? (Array.isArray(frame.errors) && frame.errors.length ? frame.errors.map(item => typeof item === 'string' ? item : item?.message).filter(Boolean).join('; ') : '')
                    || frame.error?.message
                    || `Qoder turn failed (${frame.subtype ?? 'unknown result'})`
                : undefined;
            if (!turn.textEmitted && typeof frame.result === 'string' && frame.result !== '') {
                turn.textEmitted = true;
                emit({ type: 'text', turnId: turn.id, text: frame.result });
            }
            const contextWindow = Object.values(frame.modelUsage ?? {})[0]?.contextWindow;
            const prompt = qoderPromptTokens(frame.usage);
            const occupied = prompt || qoderRatioTokens(frame.usage, contextWindow);
            const usage = addUsage(turn.usage, usageOf({
                inputTokens: frame.usage?.input_tokens,
                outputTokens: frame.usage?.output_tokens,
                cacheReadTokens: frame.usage?.cache_read_input_tokens,
                cacheWriteTokens: frame.usage?.cache_creation_input_tokens,
                contextUsed: turn.contextUsed || occupied,
                contextSize: contextWindow,
            }));
            end(reason, error, usage, typeof frame.result === 'string' ? frame.result : undefined);
        }
        // Frame types outside the declared union count by category only; the raw
        // type name and payload never reach a log or storage.
        if (!['system', 'user', 'assistant', 'result', 'control_response'].includes(frame.type) && !DECLARED.qoder.notifications[frame.type])
            coverage.count('unknown-notification');
    };
    const ask = (frame) => {
        const request = frame.request ?? {};
        if (!peer)
            return;
        if (request.subtype !== 'can_use_tool' || !running) {
            if (request.subtype !== 'can_use_tool' && !DECLARED.qoder.requests[request.subtype])
                coverage.count('unknown-request');
            return peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'No matching active turn' } } });
        }
        const question = request.tool_name === 'AskUserQuestion';
        const cardId = `qoder:${sessionId}:${frame.request_id}`;
        requests.set(cardId, frame);
        emit({
            type: 'request/opened', id: cardId, kind: question ? 'question' : 'permission',
            tool: request.tool_name,
            reason: question
                ? (request.input?.questions ?? []).map(item => item.question).join('\n')
                : request.description ?? request.input?.description ?? request.input?.command ?? `${request.display_name ?? request.tool_name} requests permission`,
            ...(question ? { detail: { questions: (request.input?.questions ?? []).map((item, index) => ({ id: `q${index}`, question: item.question, header: item.header,
                        ...(item.options ? { options: item.options } : {}), ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }) })) } }
                : { detail: { input: request.input } }),
        });
    };
    const boot = () => {
        if (ready)
            return ready;
        let connection;
        const pending = (async () => {
            if (disposed)
                throw new Error('Qoder driver disposed');
            validateWorkspace(cwd, true);
            const executable = findQoderExecutable(bin);
            if (!executable)
                throw new Error('Qoder CLI executable not found. Install Qoder or edit the profile CLI path.');
            emit({ type: 'session', state: 'starting' });
            connection = connectQoder({ executable, args: qoderArgs({ model, thinking, permission, instructions, driverSessionId: sessionId }), cwd, env,
                onFrame: frame => { if (peer === connection)
                    receive(frame); },
                onRequest: frame => { if (peer === connection)
                    ask(frame); },
                onClose(error) {
                    if (peer !== connection)
                        return;
                    disconnect();
                    closeRequests();
                    if (running?.started)
                        end('error', error.message);
                    emit({ type: 'session', state: 'closed' });
                } });
            if (disposed) {
                connection.dispose();
                throw new Error('Qoder driver disposed');
            }
            peer = connection;
            // The CLI emits its session init only after the first user frame, so a
            // boot can only confirm the process came up; the session id arrives with
            // the init frame and is persisted through the session event.
            await connection.running;
            if (disposed)
                throw new Error('Qoder driver disposed');
            if (peer !== connection)
                throw new Error('Qoder connection closed during startup');
            connected = true;
        })().catch(error => {
            if (peer === connection) {
                peer = null;
                connected = false;
                connection?.dispose();
            }
            if (ready === pending)
                ready = null;
            throw error;
        });
        ready = pending;
        return pending;
    };
    return {
        get instructionMode() { return connected && instructions ? 'native' : 'none'; },
        get coverage() { return coverage; },
        openSession: boot,
        async sendTurn(text, images = []) {
            if (disposed)
                throw new Error('Qoder driver disposed');
            if (running)
                throw new Error('Qoder already has a running turn');
            const turn = running = { id: `qoder-${++sequence}`, started: false, tools: new Map(), completedTools: new Set(), messages: new Set(), tasks: new Map(), interrupting: false, settle: null };
            if (text !== '/compact')
                turn.changes = createFileChanges(cwd);
            try {
                await boot();
                if (disposed || running !== turn)
                    return turn.id;
                const content = [...(text === '' ? [] : [{ type: 'text', text: String(text) }]), ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }))];
                peer.write({ type: 'user', message: { role: 'user', content } });
                if (running !== turn)
                    return turn.id;
                turn.started = true;
                turn.done = new Promise(resolve => { turn.settle = resolve; });
                emit({ type: 'turn/start', turnId: turn.id });
                return turn.id;
            }
            catch (error) {
                if (running === turn)
                    running = null;
                throw error;
            }
        },
        // The engine queues mid-turn user frames as the next turn instead of
        // steering the running one, and confirms no marker list — so the only
        // honest answer is a refusal and the host queues instead.
        async steer() { return STEER.REFUSED; },
        // The slash line is qoder's own native channel; print mode executes it.
        compact() { return this.sendTurn('/compact'); },
        async interruptTurn() {
            const turn = running;
            if (!turn)
                return;
            if (turn.interruption)
                return turn.interruption;
            return turn.interruption = (async () => {
                const drop = () => { if (running !== turn)
                    return; turn.unconfirmed = true; disconnect(); end('interrupted'); };
                if (!turn.started) {
                    drop();
                    return;
                }
                turn.interrupting = true;
                try {
                    await control({ subtype: 'interrupt' });
                }
                catch {
                    drop();
                    return;
                }
                let timer;
                try {
                    await Promise.race([turn.done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
                }
                finally {
                    clearTimeout(timer);
                }
                drop();
            })();
        },
        respondToRequest(id, { decision, value } = {}) {
            const frame = requests.get(id);
            if (!frame || !peer)
                return Promise.resolve(false);
            const request = frame.request ?? {};
            if (request.tool_name === 'AskUserQuestion') {
                const questions = request.input?.questions ?? [];
                let answers;
                if (questions.length === 1)
                    answers = { [questions[0].question]: String(value ?? '').trim() };
                else {
                    try {
                        answers = JSON.parse(value);
                    }
                    catch {
                        return Promise.reject(new Error('Answer each question using the form'));
                    }
                    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
                        return Promise.reject(new Error('Answer each question using the form'));
                }
                const answerOf = (item, index) => String(answers?.[`q${index}`] ?? answers?.[item.question] ?? '').trim();
                if (questions.some((item, index) => answerOf(item, index) === ''))
                    return Promise.reject(new Error('Answer every question first'));
                const mapped = Object.fromEntries(questions.map((item, index) => [item.question, answerOf(item, index)]));
                peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: { ...request.input, answers: mapped } } } });
            }
            else {
                if (!['allow', 'deny'].includes(decision))
                    return Promise.resolve(false);
                peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: decision === 'allow'
                            ? { behavior: 'allow', updatedInput: request.input ?? {} }
                            : { behavior: 'deny', message: 'Denied by the user' } } });
            }
            requests.delete(id);
            emit({ type: 'request/closed', id });
            return Promise.resolve(true);
        },
        onEvent() { throw new Error('Pass onEvent to createQoderDriver'); },
        hasSession() { return connected; },
        dispose() { disposed = true; end('interrupted'); disconnect(); },
    };
}
