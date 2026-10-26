import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { STEER, addUsage, usageOf } from '../spi.js';
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js';
import { createCoverage, DECLARED } from '../coverage.js';
import { createFileChanges, replacementEdit } from '../file-changes.js';
import { piArgs, connectPi } from './native.js';
export { findExecutable } from '../cli.js';
export const piInfo = {
    id: 'pi', label: 'Pi', command: 'pi', requiresCwd: true,
    description: 'Uses the local pi CLI with its configured model providers; sessions live in the shared pi store.',
    fields: [
        { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect pi; or enter an absolute path' },
        { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'Model such as provider/id or a pattern; blank uses pi settings' },
    ],
    capabilities: { resume: true, steer: true, permissions: false, questions: true, commands: true, compact: true },
};
export function validatePiOptions(raw = {}) {
    for (const key of Object.keys(raw))
        if (key !== 'bin')
            throw invalidConfig(`Unsupported pi option: ${key}`);
    const bin = validateBin(raw.bin);
    return bin ? { bin } : {};
}
// One short-lived RPC process for the read-only peeks: send the commands,
// resolve when every response arrived. get_state answers before any model
// work, so these cost no tokens; model/credential truth stays with the first
// real turn, same honesty as the other adapters.
function rpcPeek(executable, { cwd, env = {}, commands }) {
    return new Promise((resolvePeek, reject) => {
        let peer;
        const timer = setTimeout(() => { peer?.dispose(); reject(new Error('pi RPC peek timed out')); }, 20_000);
        const answers = {};
        let answered = 0;
        const settle = () => { clearTimeout(timer); const done = peer; peer = null; done?.dispose(); resolvePeek(answers); };
        try {
            peer = connectPi({ executable, args: piArgs({}), cwd, env, onFrame: record => {
                    if (record.type !== 'response' || !commands.some(command => command.id === record.id))
                        return;
                    answers[record.id] = record.success === true ? record.data ?? {} : { error: record.error };
                    if (++answered === commands.length)
                        settle();
                } });
            for (const command of commands)
                peer.write(command);
        }
        catch (error) {
            clearTimeout(timer);
            peer?.dispose();
            return reject(error);
        }
    });
}
// get_state answers before any model work and names the session, so this
// round-trip is the protocol check.
export async function handshakePi({ executable, cwd, env } = {}) {
    const answers = await rpcPeek(executable, { cwd, env, commands: [{ id: 'orch-check', type: 'get_state' }] });
    const answer = answers['orch-check'] ?? {};
    if (answer.error !== undefined)
        throw new Error(String(answer.error));
    return answer;
}
export async function checkPi({ cwd, engineOptions = {} } = {}) {
    const checks = [];
    try {
        validateWorkspace(cwd, true);
        checks.push({ label: 'Working directory', ok: true, message: cwd });
    }
    catch (error) {
        checks.push({ label: 'Working directory', ok: false, message: error.message });
    }
    const options = validatePiOptions(engineOptions);
    const executable = findExecutable(options.bin ?? 'pi');
    if (!executable)
        return { engine: 'pi', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'pi CLI executable not found. Install pi or enter its absolute path.' }] };
    let version;
    try {
        version = await cliVersion(executable);
        checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` });
    }
    catch {
        return { engine: 'pi', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] };
    }
    try {
        const state = await handshakePi({ executable, cwd });
        const model = state.model;
        checks.push({ label: 'Protocol', ok: true, message: `pi RPC connected${typeof state.sessionId === 'string' ? ` (session ${state.sessionId.slice(0, 8)})` : ''}` });
        checks.push({ label: 'Model', ok: model ? true : null, message: model
                ? `Configured default: ${[model.provider, model.id].filter(Boolean).join('/')}${typeof model.contextWindow === 'number' ? ` · ${model.contextWindow} token window` : ''}`
                : 'No default model is configured; set one with pi or the profile model field before the first turn.' });
    }
    catch (error) {
        checks.push({ label: 'Protocol', ok: false, message: `Could not reach the pi RPC protocol (${error.message}). Verify the installation; the first start may take a moment.` });
    }
    return { engine: 'pi', ok: checks.every(check => check.ok !== false), executable, version, checks };
}
// The RPC model table is the protocol's own catalog. Entries key as provider/id
// — the one spelling both --model and set_model accept — and thinkingLevelMap
// values name the level each key maps to; null marks a level the model does
// not support.
const catalogId = (model) => typeof model?.id === 'string' && model.id !== '' && typeof model.provider === 'string' && model.provider !== ''
    ? `${model.provider}/${model.id}` : typeof model?.id === 'string' && model.id !== '' ? model.id : undefined;
// pi's own support rule: a reasoning model takes the whole ladder except levels
// the map marks null, with xhigh/max only when the map names them; a model that
// cannot reason only takes off, which the host menu's follow-the-agent entry
// already covers.
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const piLevels = (model) => {
    if (model.reasoning !== true)
        return [];
    const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : {};
    const levels = PI_LEVELS.filter(level => map[level] !== null && !((level === 'xhigh' || level === 'max') && map[level] === undefined));
    return levels.length === 1 && levels[0] === 'off' ? [] : levels;
};
const piCatalog = (models) => (Array.isArray(models) ? models : []).flatMap(model => {
    const id = catalogId(model);
    if (!id)
        return [];
    const levels = piLevels(model);
    return [{ id,
            ...(typeof model.name === 'string' && model.name !== '' ? { label: model.name } : {}),
            ...(levels.length ? { thinking: levels.map(level => ({ id: level })) } : {}) }];
});
export async function scanPi({ engineOptions = {}, cwd } = {}) {
    const options = validatePiOptions(engineOptions);
    const executable = findExecutable(options.bin ?? 'pi');
    if (!executable)
        return { source: 'pi CLI not found', models: [] };
    try {
        const answers = await rpcPeek(executable, { cwd, commands: [
                { id: 'scan-state', type: 'get_state' }, { id: 'scan-models', type: 'get_available_models' },
            ] });
        const current = catalogId(answers['scan-state']?.model);
        return { source: 'pi get_available_models',
            ...(current ? { defaultModel: current } : {}),
            models: piCatalog(answers['scan-models']?.models) };
    }
    catch {
        return { source: 'pi scan failed', models: [] };
    }
}
// The RPC command catalog merges extension commands, prompt templates and
// skills; each runs through the prompt channel as /name.
export async function scanPiCommands({ engineOptions = {}, cwd } = {}) {
    const options = validatePiOptions(engineOptions);
    const executable = findExecutable(options.bin ?? 'pi');
    if (!executable)
        return { source: 'pi CLI', commands: [] };
    try {
        const answers = await rpcPeek(executable, { cwd, commands: [{ id: 'scan-commands', type: 'get_commands' }] });
        const commands = (Array.isArray(answers['scan-commands']?.commands) ? answers['scan-commands'].commands : []).flatMap(command => typeof command?.name === 'string' && command.name !== '' && command.name.length <= 200
            ? [{ id: command.name, ...(typeof command.description === 'string' && command.description !== '' ? { description: command.description.slice(0, 200) } : {}) }]
            : []);
        return { source: 'pi get_commands', commands };
    }
    catch {
        return { source: 'pi CLI', commands: [] };
    }
}
// write creates or overwrites with the same confirmation text either way, so
// the add/update split comes from the driver's own existence check taken when
// the tool starts; edit names its replacements itself. Anything else drops out
// of the snapshot rather than being guessed.
function piFileChanges(name, input, existedBefore, details) {
    if (name === 'write' && typeof input?.path === 'string' && typeof input?.content === 'string')
        return [{ path: input.path, edit: existedBefore
                    ? { operation: 'update', newText: input.content }
                    : { operation: 'add', oldText: null, newText: input.content } }];
    if (name === 'edit' && typeof input?.path === 'string') {
        const path = input.path;
        const diffText = typeof details?.patch === 'string' ? details.patch : details?.diff;
        if (typeof diffText === 'string')
            return [{ path, edit: { operation: 'update', diffText } }];
        const edits = Array.isArray(input.edits) && input.edits.length
            ? input.edits
            : typeof input?.oldText === 'string' && typeof input?.newText === 'string' ? [input] : [];
        return edits.flatMap(edit => typeof edit?.oldText === 'string' && typeof edit?.newText === 'string'
            ? [{ path, edit: replacementEdit(path, edit.oldText, edit.newText) }]
            : []);
    }
    return [];
}
const promptTokens = (raw) => {
    const parts = [raw?.input, raw?.cacheRead, raw?.cacheWrite];
    return parts.some(value => typeof value === 'number' && Number.isFinite(value))
        ? parts.reduce((total, value) => total + (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0), 0)
        : undefined;
};
const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('');
export function createPiDriver({ onEvent, bin, cwd, env = {}, model, thinking, permission, driverSessionId, instructions } = {}) {
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
    let rpcSeq = 0;
    let running = null;
    let contextSize;
    const controls = new Map();
    const requests = new Map();
    const coverage = createCoverage('pi');
    const closeRequests = () => {
        for (const id of requests.keys())
            emit({ type: 'request/closed', id });
        requests.clear();
    };
    const dropCommands = (error) => {
        const pending = [...controls.values()];
        controls.clear();
        for (const settle of pending)
            settle({ success: false, error });
    };
    const end = (reason, error, usage, text) => {
        if (!running)
            return;
        const turn = running;
        running = null;
        usage ??= turn.usage;
        turn.settle?.();
        closeRequests();
        if (turn.changes)
            emit(turn.changes.snapshot(turn.id));
        emit({ type: 'turn/end', turnId: turn.id, reason, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) });
    };
    // The engine answers a command after it takes effect: abort replies at idle,
    // compact after the summary exists — those two outlive the 5 s default.
    const command = (type, extra = {}, timeoutMs = 5000) => new Promise((resolvePromise, reject) => {
        const id = `orch-${++rpcSeq}`;
        const timer = timeoutMs ? setTimeout(() => { if (controls.delete(id))
            reject(new Error(`pi ${type} command timed out`)); }, timeoutMs) : null;
        controls.set(id, record => {
            if (timer)
                clearTimeout(timer);
            controls.delete(id);
            record.success === true ? resolvePromise(record.data ?? {}) : reject(new Error(record.error ?? `pi rejected ${type}`));
        });
        try {
            peer.write({ id, type, ...extra });
        }
        catch (error) {
            controls.delete(id);
            if (timer)
                clearTimeout(timer);
            reject(error);
        }
    });
    const startTool = (callId, name, input) => {
        const turn = running;
        if (!turn || !callId || turn.completedTools.has(callId))
            return;
        const previous = turn.tools.get(callId);
        turn.tools.set(callId, { name: name ?? previous?.name ?? 'tool', input: input ?? previous?.input, existedBefore: previous?.existedBefore });
        if (!previous)
            emit({ type: 'tool', turnId: turn.id, callId, name: name ?? 'tool', phase: 'start', ...(input ? { input } : {}) });
    };
    const existedBefore = (path) => {
        try {
            return statSync(resolve(cwd, path)).isFile();
        }
        catch {
            return false;
        }
    };
    const receive = (record) => {
        if (record.type === 'response')
            return controls.get(record.id)?.(record);
        if (record.type === 'extension_ui_request')
            return ask(record);
        if (!DECLARED.pi.notifications[record.type])
            coverage.count('unknown-notification');
        if (!running)
            return;
        const turn = running;
        if (record.type === 'agent_settled') {
            const reason = record.aborted === true || turn.interrupting ? 'interrupted' : turn.failed ? 'error' : 'done';
            end(reason, reason === 'error' ? turn.failed : undefined, turn.usage, turn.lastText);
            return;
        }
        if (record.type === 'message_start') {
            if (record.message?.role === 'assistant') {
                turn.openMessage = { sawDelta: false };
                emit({ type: 'delta', turnId: turn.id, text: '', boundary: 'start' });
            }
            turn.blocks.clear(); // contentIndex restarts per message
            return;
        }
        if (record.type === 'message_update') {
            if (record.usage && turn.openMessage)
                turn.openMessage.usage = record.usage;
            const update = record.assistantMessageEvent ?? {};
            const blockIndex = 'contentIndex' in update ? update.contentIndex : undefined;
            if (!DECLARED.pi.variants[update.type] && !['start', 'done', 'error'].includes(update.type))
                coverage.count('unknown-variant');
            if (update.type === 'text_delta' && typeof update.delta === 'string' && update.delta !== '') {
                if (turn.openMessage)
                    turn.openMessage.sawDelta = true;
                emit({ type: 'delta', turnId: turn.id, text: update.delta, blockIndex: update.contentIndex });
            }
            if (update.type === 'thinking_delta' && typeof update.delta === 'string' && update.delta !== '')
                emit({ type: 'thinking', turnId: turn.id, text: update.delta, blockIndex: update.contentIndex });
            if (['text_start', 'text_end', 'thinking_start', 'thinking_end'].includes(update.type)) {
                emit({ type: update.type.startsWith('thinking') ? 'thinking' : 'delta', turnId: turn.id, text: '',
                    boundary: update.type.endsWith('start') ? 'start' : 'end', blockIndex });
            }
            if (update.type === 'toolcall_start' && typeof update.id === 'string') {
                startTool(update.id, update.toolName);
                if (update.contentIndex !== undefined)
                    turn.blocks.set(update.contentIndex, update.id);
            }
            if (update.type === 'toolcall_delta' && typeof update.delta === 'string' && update.delta !== '') {
                const callId = turn.blocks.get(update.contentIndex);
                if (callId && turn.tools.has(callId))
                    emit({ type: 'tool', turnId: turn.id, callId, phase: 'update', inputDelta: update.delta });
            }
            if (update.type === 'toolcall_end' && typeof update.toolCall?.id === 'string')
                startTool(update.toolCall.id, update.toolCall.name, update.toolCall.arguments);
            return;
        }
        if (record.type === 'message_end') {
            const message = record.message;
            if (message?.role !== 'assistant')
                return;
            const usage = message.usage ?? turn.openMessage?.usage;
            const used = promptTokens(usage);
            if (used !== undefined)
                turn.contextUsed = used;
            turn.usage = addUsage(turn.usage, usageOf({
                inputTokens: usage?.input, outputTokens: usage?.output,
                cacheReadTokens: usage?.cacheRead, cacheWriteTokens: usage?.cacheWrite,
                contextUsed: used, contextSize,
            }));
            const text = textOf(message);
            if (text !== '') {
                turn.lastText = text;
                if (!turn.openMessage?.sawDelta)
                    emit({ type: 'text', turnId: turn.id, text });
            }
            emit({ type: 'delta', turnId: turn.id, text: '', boundary: 'end' });
            turn.openMessage = null;
            return;
        }
        if (record.type === 'tool_execution_start') {
            startTool(record.toolCallId, record.toolName, record.args);
            const tool = turn.tools.get(record.toolCallId);
            if (tool && record.args?.path !== undefined && (tool.name === 'write' || tool.name === 'edit'))
                tool.existedBefore = existedBefore(record.args.path);
            return;
        }
        if (record.type === 'tool_execution_update') {
            const text = (Array.isArray(record.partialResult?.content) ? record.partialResult.content : [])
                .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
            if (turn.tools.has(record.toolCallId) && text !== '')
                emit({ type: 'tool', turnId: turn.id, callId: record.toolCallId, phase: 'update', outputText: text });
            return;
        }
        if (record.type === 'tool_execution_end') {
            const tool = turn.tools.get(record.toolCallId);
            if (!tool)
                return;
            turn.tools.delete(record.toolCallId);
            turn.completedTools.add(record.toolCallId);
            const outputText = (Array.isArray(record.result?.content) ? record.result.content : [])
                .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
            turn.changes?.add(record.toolCallId, piFileChanges(tool.name, tool.input, tool.existedBefore, record.result?.details), record.isError !== true);
            emit({ type: 'tool', turnId: turn.id, callId: record.toolCallId, name: tool.name, phase: 'end', input: tool.input,
                ...(record.result !== undefined ? { output: record.result } : outputText !== '' ? { output: outputText } : {}),
                ...(outputText !== '' ? { outputText } : {}), isError: record.isError === true });
            return;
        }
        if (record.type === 'compaction_start') {
            turn.compacting = true;
            emit({ type: 'lifecycle', turnId: turn.id, kind: 'compaction', phase: 'start', ...(record.reason ? { detail: record.reason } : {}) });
            return;
        }
        if (record.type === 'compaction_end') {
            turn.compacting = false;
            emit({ type: 'lifecycle', turnId: turn.id, kind: 'compaction', phase: 'end',
                ...(typeof record.errorMessage === 'string' ? { isError: true, detail: record.errorMessage } : {}),
                ...(record.aborted === true ? { cancelled: true } : {}) });
            return;
        }
        if (record.type === 'auto_retry_start')
            return void emit({ type: 'lifecycle', turnId: turn.id, kind: 'retry', phase: 'start', entityId: `retry-${record.attempt ?? 1}`,
                ...(typeof record.errorMessage === 'string' ? { detail: record.errorMessage } : {}) });
        if (record.type === 'auto_retry_end') {
            if (record.success === false && typeof record.finalError === 'string')
                turn.failed = record.finalError;
            return void emit({ type: 'lifecycle', turnId: turn.id, kind: 'retry', phase: 'end', entityId: `retry-${record.attempt ?? 1}`,
                ...(record.success === false ? { isError: true, ...(typeof record.finalError === 'string' ? { detail: record.finalError } : {}) } : {}) });
        }
        // agent_start/agent_end/turn_start/turn_end and the queue/entry/session
        // notices stay out of the stream: the driver settles on agent_settled.
    };
    // Extension dialogs are the only server→client question channel; leaving one
    // unanswered stalls the engine, so each surfaces as a question card even
    // though pi has no native ask tool.
    const ask = (record) => {
        if (!peer)
            return;
        const cardId = `pi:${sessionId}:${record.id}`;
        requests.set(cardId, record);
        emit({
            type: 'request/opened', id: cardId, kind: 'question',
            ...(typeof record.title === 'string' ? { reason: record.title } : {}),
            detail: { method: record.method,
                ...(Array.isArray(record.options) ? { options: record.options } : {}),
                ...(typeof record.message === 'string' ? { message: record.message } : {}),
                ...(typeof record.placeholder === 'string' ? { placeholder: record.placeholder } : {}) },
        });
    };
    const boot = () => {
        if (ready)
            return ready;
        let connection;
        const pending = (async () => {
            if (disposed)
                throw new Error('pi driver disposed');
            validateWorkspace(cwd, true);
            const executable = findExecutable(bin ?? 'pi');
            if (!executable)
                throw new Error('pi CLI executable not found. Install pi or edit the profile CLI path.');
            emit({ type: 'session', state: 'starting' });
            connection = connectPi({ executable, args: piArgs({ model, thinking, instructions, driverSessionId: sessionId }), cwd, env,
                onFrame: receive,
                onClose(error) {
                    if (peer !== connection)
                        return;
                    peer = null;
                    ready = null;
                    connected = false;
                    dropCommands(error.message);
                    closeRequests();
                    if (running?.started)
                        end('error', error.message);
                    emit({ type: 'session', state: 'closed' });
                } });
            if (disposed) {
                connection.dispose();
                throw new Error('pi driver disposed');
            }
            peer = connection;
            await connection.running;
            if (disposed)
                throw new Error('pi driver disposed');
            // get_state carries no CLI version, so the identity probe is its own
            // --version call; unverified versions still stream, the label just says so.
            const version = await cliVersion(executable).catch(() => undefined);
            if (disposed)
                throw new Error('pi driver disposed');
            coverage.setIdentity({ transport: 'rpc', ...(version ? { cliVersion: version } : {}) });
            const state = await command('get_state', {}, 20_000);
            if (typeof state.sessionId === 'string' && state.sessionId !== '')
                sessionId = state.sessionId;
            if (typeof state.model?.contextWindow === 'number')
                contextSize = state.model.contextWindow;
            connected = true;
            emit({ type: 'session', state: 'ready', sessionId });
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
                throw new Error('pi driver disposed');
            if (running)
                throw new Error('pi already has a running turn');
            const turn = running = { id: `pi-${++sequence}`, started: false, tools: new Map(), completedTools: new Set(), blocks: new Map(), interrupting: false, failed: undefined, lastText: undefined, openMessage: null, usage: undefined, contextUsed: undefined, changes: createFileChanges(cwd), settle: null };
            try {
                await boot();
                if (disposed || running !== turn)
                    return turn.id;
                const payload = { message: String(text), ...(images.length ? { images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mediaType })) } : {}) };
                const { disposition } = await command('prompt', payload, 30_000);
                if (disposed || running !== turn)
                    return turn.id;
                // A handled prompt never starts a run: the engine consumed it, so the
                // turn closes at once instead of waiting for agent_settled.
                if (disposition === 'handled') {
                    end('done');
                    return turn.id;
                }
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
        // The engine queues the message between tool calls and answers with a
        // disposition, so an answered steer is a steered one; a timeout leaves
        // delivery unknown.
        async steer(text, images = []) {
            if (!running?.started || running.interrupting || disposed || !peer)
                return STEER.REFUSED;
            try {
                await command('steer', { message: String(text), ...(images.length ? { images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mediaType })) } : {}) });
                return STEER.STEERED;
            }
            catch (error) {
                return String(error?.message).includes('timed out') ? STEER.INDETERMINATE : STEER.REFUSED;
            }
        },
        // The native compaction channel; its lifetime arrives as compaction events.
        async compact() {
            if (disposed)
                throw new Error('pi driver disposed');
            if (running)
                throw new Error('pi already has a running turn');
            const turn = running = { id: `pi-${++sequence}`, started: true, tools: new Map(), completedTools: new Set(), blocks: new Map(), interrupting: false, changes: null, settle: null };
            turn.done = new Promise(resolve => { turn.settle = resolve; });
            emit({ type: 'turn/start', turnId: turn.id });
            try {
                await boot();
                if (running !== turn)
                    return turn.id;
                await command('compact', {}, 600_000);
                end('done');
            }
            catch (error) {
                if (running === turn)
                    end('error', error.message);
            }
            return turn.id;
        },
        async interruptTurn() {
            const turn = running;
            if (!turn)
                return;
            const drop = () => { turn.unconfirmed = true; peer?.dispose(); end('interrupted'); };
            if (!turn.started) {
                drop();
                return;
            }
            turn.interrupting = true;
            try {
                await command('abort', {}, 120_000);
            }
            catch {
                drop();
                return;
            }
            await Promise.race([turn.done, new Promise(resolve => { setTimeout(resolve, 5000); })]);
            if (running === turn)
                drop();
        },
        respondToRequest(id, { decision, value } = {}) {
            const record = requests.get(id);
            if (!record || !peer)
                return Promise.resolve(false);
            const answer = record.method === 'confirm'
                ? decision === 'deny' ? { confirmed: false } : { confirmed: true }
                : decision === 'deny' ? { cancelled: true } : { value: String(value ?? '') };
            peer.write({ type: 'extension_ui_response', id: record.id, ...answer });
            requests.delete(id);
            emit({ type: 'request/closed', id });
            return Promise.resolve(true);
        },
        onEvent() { throw new Error('Pass onEvent to createPiDriver'); },
        hasSession() { return connected; },
        dispose() { disposed = true; dropCommands('pi driver disposed'); end('interrupted'); peer?.dispose(); },
    };
}
