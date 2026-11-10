import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { STEER, addUsage, steerFailed, usageOf } from '../spi.js';
import { checkCliBase, invalidConfig, validateBin, validateWorkspace } from '../cli.js';
import { collector, listDirs, newestPluginVersions } from '../skills.js';
import { createCoverage, DECLARED } from '../coverage.js';
import { connectCodex, ensureCodexWorkspace, findCodexExecutable } from './native.js';
import { leadUnavailable, writeLeaderCatalog } from './catalog.js';
import { createFileChanges } from '../file-changes.js';
import { LEAD_TOOLS } from '../lead-mcp.js';
import { WORKER_TOOLS } from '../worker-mcp.js';
export { findCodexExecutable } from './native.js';
export const codexInfo = {
    id: 'codex', label: 'Codex CLI', command: 'codex', requiresCwd: true,
    description: 'Uses the local Codex CLI and its existing login and settings.',
    fields: [
        { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect codex; or enter an absolute path' },
        { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'Leave blank to use Codex settings' },
        { name: 'socket', target: 'engineOptions', label: 'Shared Codex socket (optional)', type: 'text', placeholder: 'Default shared daemon; or its absolute control socket path' },
    ],
    capabilities: { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, goals: true, permissionModes: ['plan', 'workspace', 'full'] },
};
export function validateCodexOptions(raw = {}) {
    for (const key of Object.keys(raw))
        if (!['bin', 'socket'].includes(key))
            throw invalidConfig(`Unsupported Codex option: ${key}`);
    const bin = validateBin(raw.bin);
    if (raw.socket !== undefined && (typeof raw.socket !== 'string' || !raw.socket.startsWith('/') || raw.socket.includes('\0')))
        throw invalidConfig('Codex socket must be an absolute path');
    return { ...(bin ? { bin } : {}), ...(raw.socket ? { socket: raw.socket } : {}) };
}
async function initialize(peer) {
    const result = await peer.request('initialize', {
        clientInfo: { name: 'dsh_nodo', title: 'DSH Nodo', version: '0.1.0' },
        capabilities: { experimentalApi: true },
    });
    peer.notify('initialized');
    return result;
}
export async function checkCodex({ cwd, engineOptions = {} } = {}) {
    const options = validateCodexOptions(engineOptions);
    const base = await checkCliBase('codex', cwd, findCodexExecutable(options.bin ?? 'codex'), 'Codex executable not found. Enter its absolute path.');
    if (base.failed)
        return base.failed;
    const { checks, executable, version } = base;
    const peer = await connectCodex({ executable: executable, socket: options.socket, start: false });
    try {
        await initialize(peer);
        checks.push({ label: 'Protocol', ok: true, message: 'Shared Codex app-server connected' });
        const account = await peer.request('account/read', { refreshToken: false });
        const ready = account.account != null || account.requiresOpenaiAuth === false;
        checks.push({ label: 'Authentication', ok: ready, message: ready ? 'Using existing Codex authentication/provider settings' : 'Sign in with codex login in your terminal, then check again.' });
    }
    catch {
        checks.push({ label: 'Protocol / authentication', ok: false, message: 'Could not check app-server. Verify the CLI version and existing settings in your terminal.' });
    }
    finally {
        peer.dispose();
    }
    return { engine: 'codex', ok: checks.every(check => check.ok), executable, version, checks };
}
// Targeted key scan of config.toml (not a TOML parser): the model and reasoning
// effort of the top-level table and of every [profiles.*] table.
const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
function codexConfigModels(path) {
    let lines;
    try {
        lines = readFileSync(path, 'utf8').split('\n');
    }
    catch {
        return [];
    }
    const entries = [];
    let table = '';
    let current;
    const flush = () => { if (current?.id)
        entries.push(current); current = undefined; };
    for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trim();
        const section = /^\[([^\]]+)\]$/.exec(line);
        if (section) {
            flush();
            table = section[1].trim();
            continue;
        }
        const pair = /^(model|model_reasoning_effort)\s*=\s*(.+)$/.exec(line);
        if (!pair)
            continue;
        const profile = /^profiles\.([^.]+)$/.exec(table)?.[1];
        if (table !== '' && profile === undefined)
            continue;
        const value = (/^"(.*)"$/.exec(pair[2].trim())?.[1] ?? pair[2].trim());
        if (!/^[\w.:/-]{1,200}$/.test(value))
            continue;
        current ??= { id: undefined, ...(profile ? { label: profile } : {}) };
        if (pair[1] === 'model')
            current.id = value;
        if (pair[1] === 'model_reasoning_effort')
            current.defaultThinking = value;
    }
    flush();
    return entries.map(entry => ({ id: entry.id, ...(entry.label ? { label: entry.label } : {}),
        ...(entry.defaultThinking ? { defaultThinking: entry.defaultThinking } : {}) }));
}
// Targeted key scan of config.toml (not a TOML parser): the names of the
// [mcp_servers.*] tables, the entries that carry a transport.
function codexConfigMcpServers(path) {
    let lines;
    try {
        lines = readFileSync(path, 'utf8').split('\n');
    }
    catch {
        return [];
    }
    const names = [];
    for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trim();
        const section = /^\[mcp_servers\.([^.\]]+)\]$/.exec(line);
        if (section)
            names.push(/^"([A-Za-z0-9_-]+)"$/.exec(section[1])?.[1] ?? section[1]);
    }
    return names;
}
export async function scanCodex({ engineOptions = {} } = {}) {
    const options = validateCodexOptions(engineOptions);
    const configModels = () => {
        const models = codexConfigModels(join(codexHome(), 'config.toml'));
        return { source: 'Codex config.toml', ...(models[0] ? { defaultModel: models[0].id } : {}), models };
    };
    const executable = findCodexExecutable(options.bin ?? 'codex');
    if (!executable)
        return configModels();
    const peer = await connectCodex({ executable, socket: options.socket, start: true }).catch(() => null);
    if (!peer)
        return configModels();
    try {
        await initialize(peer);
        const data = [];
        let cursor;
        do {
            const page = await peer.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
            data.push(...(page.data ?? []));
            cursor = page.nextCursor ?? undefined;
        } while (cursor && data.length < 300);
        const models = data.filter(model => !model.hidden && typeof model.model === 'string' && model.model !== '').map(model => ({
            id: model.model,
            ...(typeof model.displayName === 'string' && model.displayName !== '' ? { label: model.displayName } : {}),
            ...(typeof model.defaultReasoningEffort === 'string' && model.defaultReasoningEffort !== '' ? { defaultThinking: model.defaultReasoningEffort } : {}),
            thinking: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
                .filter(option => typeof option?.reasoningEffort === 'string' && option.reasoningEffort !== '')
                .map(option => ({ id: option.reasoningEffort })),
        }));
        if (models.length === 0)
            return configModels();
        return { source: 'Codex app-server model/list', ...(data.find(model => model.isDefault)?.model ? { defaultModel: data.find(model => model.isDefault).model } : {}), models };
    }
    catch {
        return configModels();
    }
    finally {
        peer.dispose();
    }
}
// Models drift between the blocking question tool, its async variant and plain
// text, and older sessions carry failed attempts that teach the wrong habit.
// Only the blocking request_user_input reaches this client as a card.
const QUESTION_ROUTING = 'Asking the user questions: always use the request_user_input tool. Never use request_user_input_async — its questions never surface here — and never ask a question in plain text while request_user_input is available.';
// A leader only routes: the sandbox is read-only and the built-in capabilities
// that a config key can turn off are turned off here. The collaboration tools
// and code-mode `exec` are not among them — they follow the model catalog entry
// of the leader's own process (catalog.ts), and no config key turns code-mode
// `exec` off: `features.unified_exec` gates only the shell tool. Unknown keys
// are accepted silently and feature names move between versions, so the
// config-freeze test is the drift guard.
const LEAD_CONFIG = {
    'features.shell_tool': false, 'features.unified_exec': false, 'features.view_image': false,
    'features.computer_use': false, 'features.browser_use': false, 'features.sleep_tool': false,
    'features.goals': false, 'features.apps': false, 'features.plugins': false,
    'features.skill_search': false, 'features.multi_agent_v2': false, 'features.image_generation': false,
    'features.hooks': false, 'features.memories': false,
    'tools.web_search': false, 'tools.update_plan': { enabled: false },
};
// The catalog override keeps the leader in code mode, where the exec sandbox is
// the only dispatcher for MCP tools: a Nodo call is a JS property of `tools`
// keyed by its ALL_TOOLS name, not a bare function call the engine would route.
const LEAD_TOOL_SEARCH = 'Your Nodo tools run through the exec tool, not as plain function calls: execute `await tools.mcp__nodo_lead__nodo_board({ "table": "tasks" })` inside exec — the identifier is always tools.mcp__<server>__<tool> from ALL_TOOLS. If a call fails, run `text(JSON.stringify(ALL_TOOLS.map(t => t.name)))` first and retry with the exact name.';
// Every MCP server the leader's process would expose, plugin-provided ones
// included; the thread config deep-merges, so each name has to be disabled on
// its own rather than by replacing the table.
async function listMcpServers(peer) {
    const names = [];
    let cursor;
    do {
        const page = await peer.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, 60_000);
        for (const item of page.data ?? [])
            if (typeof item?.name === 'string' && item.name !== '' && item.name !== 'nodo_lead')
                names.push(item.name);
        cursor = page.nextCursor ?? undefined;
    } while (cursor && names.length < 500);
    return names;
}
export function createCodexDriver({ onEvent, bin = 'codex', socket, cwd, env = {}, model, thinking, permission, driverSessionId, name, sessionName, workspaceId, instructions, instructionDir, lead, leadMcpServers } = {}) {
    const emit = (event) => { try {
        onEvent?.(event);
    }
    catch { } };
    let peer = null;
    let ready = null;
    let threadId = driverSessionId;
    let connected = false;
    let disposed = false;
    let sequence = 0;
    let instructionMode = 'none';
    let running = null;
    const requests = new Map();
    const coverage = createCoverage('codex');
    const closeRequests = () => {
        for (const id of requests.keys())
            emit({ type: 'request/closed', id });
        requests.clear();
    };
    const end = (reason, error, retryable = false) => {
        if (!running)
            return;
        const turn = running;
        running = null;
        closeRequests();
        if (!turn.compacting && turn.started)
            emit(turn.changes.snapshot(turn.id));
        turn.settle?.();
        emit({ type: 'turn/end', turnId: turn.id, reason, ...(turn.final !== undefined ? { text: turn.final } : {}), ...(error ? { error } : {}), ...(turn.usage ? { usage: turn.usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}), ...(reason === 'error' && !turn.cancelled && retryable ? { retryable: true } : {}) });
    };
    const start = (id) => {
        if (!running || running.started)
            return;
        const turn = running;
        turn.id = id;
        turn.started = true;
        emit({ type: 'turn/start', turnId: id });
        const pending = turn.pending ?? [];
        turn.pending = [];
        for (const event of pending) {
            if (running !== turn)
                break;
            if (event.kind === 'notification')
                receive(event.message);
            else
                ask(event.message);
        }
    };
    const thought = (itemId, channel, index, text, delta = false) => {
        if (typeof text !== 'string' || !text)
            return;
        let item = running.thoughts.get(itemId);
        if (!item)
            running.thoughts.set(itemId, item = { channel, parts: new Map() });
        if (item.channel !== channel)
            return;
        const previous = item.parts.get(index) ?? '';
        const suffix = delta ? text : text.startsWith(previous) ? text.slice(previous.length) : '';
        if (!suffix)
            return;
        item.parts.set(index, previous + suffix);
        emit({ type: 'thinking', turnId: running.id, messageId: itemId, blockIndex: index, channel, text: suffix });
    };
    const receive = ({ method, params = {} }) => {
        // Notifications outside the declared schema count by category only; the
        // raw method name and payload go nowhere.
        if (method !== undefined && !DECLARED.codex.notifications[method]) {
            coverage.count('unknown-notification');
            return;
        }
        if (method === 'serverRequest/resolved') {
            if (running && !running.started) {
                (running.pending ??= []).push({ kind: 'notification', message: { method, params } });
                return;
            }
            for (const [id, request] of requests)
                if (request.id === params.requestId) {
                    requests.delete(id);
                    emit({ type: 'request/closed', id });
                }
            return;
        }
        if (params.threadId === threadId && (method === 'thread/goal/updated' || method === 'thread/goal/cleared')) {
            emit({ type: 'goal', ...(params.goal ?? {}), ...(method === 'thread/goal/cleared' ? { cleared: true } : {}) });
            return;
        }
        if (!running || params.threadId !== threadId)
            return;
        if (!running.started) {
            (running.pending ??= []).push({ kind: 'notification', message: { method, params } });
            return;
        }
        if (running.started && params.turnId && params.turnId !== running.id)
            return;
        // turn ids come only from the driver's own turn/start result: a notification
        // can be a stale turn left over on the shared daemon, and adopting it here
        // would mis-attribute the turn the driver just sent.
        if (method === 'turn/diff/updated')
            running.changes?.diff(params.diff);
        // The structured plan notification is a whole-plan snapshot: every update
        // replaces the previous steps instead of appending to the transcript.
        if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
            emit({ type: 'plan', turnId: running.id, ...(typeof params.explanation === 'string' && params.explanation !== '' ? { explanation: params.explanation } : {}),
                steps: params.plan.filter(step => typeof step?.step === 'string' && step.step !== '').map(step => ({
                    text: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status === 'completed' ? 'completed' : 'pending'
                })) });
        }
        // A retry the engine itself announces; only willRetry=true maps here, a
        // final error stays with turn/completed. The wait has no end signal, so the
        // host shows it as a status line rather than an ongoing spinner.
        if (method === 'error' && params.willRetry === true) {
            emit({ type: 'lifecycle', turnId: running.id, kind: 'retry', phase: 'start', ...(typeof params.error?.message === 'string' && params.error.message ? { detail: params.error.message } : {}) });
        }
        if (method === 'thread/compacted') {
            emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' });
            if (running.compacting)
                end('done');
        }
        if (method === 'item/reasoning/summaryTextDelta')
            thought(params.itemId, 'summary', params.summaryIndex ?? 0, params.delta, true);
        if (method === 'item/reasoning/textDelta')
            thought(params.itemId, 'content', params.contentIndex ?? 0, params.delta, true);
        // Command output and MCP progress are declared deltas/messages of a tool
        // item that already started; a repeated delta has no source identity, so it
        // appends again rather than being guessed away. An item that ended is gone
        // from the map and cannot be revived by a late notification.
        if (method === 'item/commandExecution/outputDelta' && running.tools.has(params.itemId) && typeof params.delta === 'string' && params.delta !== '') {
            emit({ type: 'tool', turnId: running.id, callId: params.itemId, name: running.tools.get(params.itemId), phase: 'update', outputDelta: params.delta });
        }
        if (method === 'item/mcpToolCall/progress' && running.tools.has(params.itemId) && typeof params.message === 'string' && params.message !== '') {
            emit({ type: 'tool', turnId: running.id, callId: params.itemId, name: running.tools.get(params.itemId), phase: 'update', progress: { message: params.message } });
        }
        if (method === 'item/agentMessage/delta') {
            const previous = running.texts.get(params.itemId) ?? '';
            running.texts.set(params.itemId, previous + params.delta);
            emit({ type: 'delta', turnId: running.id, messageId: params.itemId, text: params.delta });
        }
        if (method === 'item/started' || method === 'item/completed') {
            const item = params.item ?? {};
            if (item.type === 'agentMessage') {
                const previous = running.texts.get(item.id);
                const snapshot = method === 'item/completed' && (previous === undefined || !item.text?.startsWith(previous));
                if (item.phase === 'final_answer' && typeof item.text === 'string' && item.text !== '')
                    running.final = item.text;
                if (method === 'item/completed' && typeof item.text === 'string')
                    running.texts.set(item.id, item.text);
                emit({ type: snapshot ? 'text' : 'delta', turnId: running.id, messageId: item.id,
                    text: method === 'item/started' ? '' : snapshot ? item.text ?? '' : item.text?.slice(previous?.length ?? 0) ?? '', boundary: method === 'item/started' ? 'start' : 'end',
                    ...(item.phase ? { channel: item.phase } : {}) });
            }
            else if (item.type === 'subAgentActivity') {
                // An engine-declared subagent record, not a tool call: its source ids
                // (id, agentThreadId) stay on the activity, and no parent is invented.
                const kind = item.kind;
                emit({ type: 'activity', turnId: running.id, phase: method === 'item/started' ? 'start' : ['completed', 'interrupted'].includes(kind) ? 'end' : 'update',
                    entityId: item.id, name: 'subagent',
                    ...(typeof item.agentPath === 'string' && item.agentPath !== '' ? { title: item.agentPath } : {}),
                    ...(item.agentThreadId !== undefined && item.agentThreadId !== null ? { detail: `agentThreadId: ${item.agentThreadId}` } : {}),
                    isError: kind === 'interrupted' });
            }
            else if (item.type === 'contextCompaction' && method === 'item/completed') {
                emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' });
                if (running.compacting)
                    end('done');
            }
            else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageView', 'imageGeneration'].includes(item.type)) {
                if (method === 'item/started')
                    running.tools.set(item.id, item.type);
                else
                    running.tools.delete(item.id);
                if (item.type === 'fileChange' && method === 'item/completed')
                    running.changes?.add(item.id, Array.isArray(item.changes) ? item.changes.map(change => {
                        const moved = change?.kind?.type === 'update' && change.kind.move_path;
                        return { path: moved || change?.path, edit: { operation: moved ? 'move' : change?.kind?.type ?? 'unknown',
                                ...(moved ? { fromPath: change.path } : {}), diffText: change?.diff } };
                    }) : undefined, item.status === 'completed');
                // Viewed and generated images carry only a local path. Present it as a
                // bounded resource reference without dropping the item's own output.
                const path = item.type === 'imageView' ? item.path : item.type === 'imageGeneration' ? item.savedPath : undefined;
                const picture = typeof path === 'string' && path !== ''
                    ? [{ type: 'resource_link', name: path.split(/[\\/]/).filter(Boolean).pop() ?? 'image', uri: path }] : undefined;
                const result = item.aggregatedOutput ?? item.result ?? item.error ?? item.contentItems ?? item.agentsStates ?? item.changes;
                const output = picture ? result === undefined ? picture : [...Array.isArray(result) ? result : [result], ...picture] : result;
                emit({ type: 'tool', turnId: running.id, callId: item.id, name: item.type, phase: method === 'item/started' ? 'start' : 'end',
                    brief: item.command ?? item.query ?? item.tool ?? item.path,
                    input: item.arguments ?? item.command ?? item.query ?? item.prompt ?? item.path ?? item.changes,
                    ...(method === 'item/completed' ? { output,
                        isError: item.type === 'fileChange' && item.status !== 'completed' || ['failed', 'declined'].includes(item.status) || item.success === false || Boolean(item.error) } : {}) });
            }
            else if (item.type === 'reasoning' && method === 'item/completed') {
                const channel = running.thoughts.get(item.id)?.channel ?? (item.summary?.some(text => text) ? 'summary' : 'content');
                const parts = item[channel]?.length ? item[channel] : typeof item.text === 'string' ? [item.text] : [];
                parts.forEach((text, index) => thought(item.id, channel, index, text));
                parts.forEach((_text, index) => emit({ type: 'thinking', turnId: running.id, messageId: item.id, blockIndex: index, channel, text: '', boundary: 'end' }));
            }
            else if (!DECLARED.codex.variants[item.type])
                coverage.count('unknown-variant');
        }
        if (method === 'thread/tokenUsage/updated') {
            // The notification carries the request that just finished, so a turn that
            // ran several requests folds them one by one. Codex's inputTokens is the
            // whole prompt with the cached part included (Responses API semantics), so
            // the uncached bucket is what remains after both cache buckets.
            const last = params.tokenUsage?.last ?? {};
            const cacheReadTokens = last.cachedInputTokens ?? 0;
            const cacheWriteTokens = last.cacheWriteInputTokens ?? 0;
            const inputTokens = Math.max(0, (last.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
            running.usage = addUsage(running.usage, usageOf({
                inputTokens, outputTokens: last.outputTokens, cacheReadTokens, cacheWriteTokens,
                contextUsed: inputTokens + cacheReadTokens + cacheWriteTokens,
                contextSize: params.tokenUsage?.modelContextWindow ?? undefined,
            }));
            if (running.usage)
                emit({ type: 'usage', turnId: running.id, usage: running.usage });
            return;
        }
        if (method === 'turn/completed' && running.started && params.turn?.id === running.id) {
            const status = params.turn?.status;
            const info = params.turn.error?.codexErrorInfo;
            const connection = typeof info === 'object' && info !== null
                ? ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].find(key => Object.hasOwn(info, key)) : undefined;
            const http = connection && typeof info === 'object' ? info[connection]?.httpStatusCode : undefined;
            const retryable = typeof info === 'string' ? ['serverOverloaded', 'rateLimitExceeded', 'internalServerError'].includes(info)
                : !!connection && (http == null || http === 408 || http >= 500 && http < 600);
            end(status === 'completed' ? 'done' : status === 'interrupted' ? 'interrupted' : 'error', params.turn.error?.message, retryable);
        }
    };
    const ask = (message) => {
        const { id, method, params = {} } = message;
        if (running && !running.started && params.threadId === threadId) {
            (running.pending ??= []).push({ kind: 'request', message });
            return;
        }
        const declared = DECLARED.codex.requests[method];
        if (!declared)
            coverage.count('unknown-request');
        if (!running || params.threadId !== threadId || params.turnId !== undefined && params.turnId !== running.id)
            return peer.refuse(id, 'No matching active turn');
        const isPermission = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method);
        const isQuestion = method === 'item/tool/requestUserInput';
        if (!isPermission && !isQuestion) {
            // A refusal reads as a decline, so a declared request this client cannot
            // surface still leaves a line instead of vanishing.
            if (declared)
                emit({ type: 'note', text: `Codex requested ${method}, which this client does not support; the request was declined.` });
            return peer.refuse(id);
        }
        if (isQuestion && (!Array.isArray(params.questions) || params.questions.length === 0))
            return peer.refuse(id, 'No questions supplied');
        const cardId = `codex:${threadId}:${typeof id}:${id}`;
        requests.set(cardId, message);
        emit({
            type: 'request/opened', id: cardId, kind: isQuestion ? 'question' : 'permission',
            tool: isPermission ? method.split('/')[1] : undefined,
            reason: isQuestion ? params.questions.map(item => item.question).join('\n') : params.reason ?? params.command ?? 'Codex requests permission',
            detail: isQuestion ? { questions: params.questions } : { command: params.command, cwd: params.cwd },
        });
    };
    // The catalog entry must be the model the thread itself runs: the profile's
    // model, or else the top-level model of the user's config.toml. A model set
    // only in a `[profiles.*]` table never reaches the thread, and switching a
    // different entry would leave the running model's tools intact.
    const leaderModel = () => model || codexConfigModels(join(codexHome(), 'config.toml')).find(entry => entry.label === undefined)?.id;
    const leaderCatalog = async (executable) => {
        const target = leaderModel();
        if (!target)
            throw leadUnavailable('Codex leaders need a model: set one in the profile so its catalog entry can be switched to the routing-only tool mode.');
        if (!instructionDir)
            throw leadUnavailable('Codex leaders need the Nodo data directory to store their model catalog.');
        return writeLeaderCatalog({ executable, model: target, dir: instructionDir, env });
    };
    const boot = () => {
        if (ready)
            return ready;
        let connection;
        let resuming = false;
        const pending = (async () => {
            if (disposed)
                throw new Error('Codex driver disposed');
            // Fail closed: a leader without its mount has no working channel and must
            // not degrade into an unprivileged plain session.
            if (lead && !leadMcpServers?.length)
                throw leadUnavailable('The lead channel is unavailable; the leader session cannot start without its nodo_lead mount.');
            validateWorkspace(cwd, true);
            const executable = findCodexExecutable(bin);
            if (!executable)
                throw new Error('Codex executable not found. Edit the profile CLI path or install the CLI separately.');
            emit({ type: 'session', state: 'starting' });
            // A leader gets its own app-server: the catalog that drops the built-in
            // execution tools is read only by a process this driver starts.
            const catalog = lead ? await leaderCatalog(executable) : undefined;
            connection = await connectCodex({ executable, cwd, env, socket, ...(catalog ? { catalog } : {}),
                onNotification: receive, onRequest: ask,
                onClose(error) {
                    if (peer !== connection)
                        return;
                    connected = false;
                    ready = null;
                    closeRequests();
                    if (running?.started) {
                        running.unconfirmed = true;
                        end('error', error.message);
                    }
                    emit({ type: 'session', state: 'closed' });
                },
            });
            if (disposed) {
                connection.dispose();
                throw new Error('Codex driver disposed');
            }
            peer = connection;
            const hello = await initialize(peer);
            // The daemon is shared, so the handshake's own agent string is the only
            // version the driver sees without a second process.
            const version = /(\d[\w.-]*)/.exec(typeof hello?.userAgent === 'string' ? hello.userAgent : '')?.[1];
            coverage.setIdentity({ transport: catalog ? 'app-server stdio' : 'app-server proxy', ...(version ? { cliVersion: version } : {}) });
            // Fail closed: a leader that cannot see the user's servers would start with
            // all of them exposed, and the thread config cannot be revisited later.
            let disabledMcp = {};
            if (lead) {
                let servers;
                try {
                    servers = await listMcpServers(peer);
                }
                catch (error) {
                    throw leadUnavailable(`Codex MCP servers could not be enumerated (${error.message}). Leaders need this list to keep the user's servers out.`);
                }
                // Config keys are dotted paths, so a name with a dot, quote or space
                // would disable another server or nothing at all.
                const unsupported = servers.find(name => !/^[A-Za-z0-9_-]+$/.test(name));
                if (unsupported !== undefined)
                    throw leadUnavailable(`The MCP server ${JSON.stringify(unsupported.slice(0, 80))} cannot be disabled by configuration key. Rename it to letters, digits, "-" and "_" only, or remove it, to use a Codex leader.`);
                // A config.toml entry has a transport, so the bare `enabled=false` merges
                // onto it; an injected source (an app or plugin server) has none, and
                // `enabled=false` alone fails thread/start with `invalid transport` — it
                // gets a dead placeholder transport instead. The placeholder must never
                // land on a config-defined server: the deep merge would keep both.
                const configured = codexConfigMcpServers(join(codexHome(), 'config.toml'));
                disabledMcp = Object.fromEntries(servers.map(name => configured.includes(name)
                    ? [`mcp_servers.${name}.enabled`, false]
                    : [`mcp_servers.${name}`, { enabled: false, url: 'http://127.0.0.1:1/mcp' }]));
            }
            workspaceId = await ensureCodexWorkspace(peer, { cwd: cwd, name, workspaceId });
            const method = threadId ? 'thread/resume' : 'thread/start';
            const params = { ...(threadId ? { threadId } : { projectId: workspaceId, historyMode: 'paginated' }), cwd, ...(model ? { model } : {}) };
            // The autonomy tier rides the thread params: the sandbox bounds what the
            // engine may touch at all, `never` approval is what makes the top tier full.
            // A leader asks through nodo_route, not through a native tool, so it does
            // not get the question routing that points at request_user_input.
            const developerInstructions = [instructions, lead ? LEAD_TOOL_SEARCH : '', instructions && !lead ? QUESTION_ROUTING : ''].filter(Boolean).join('\n\n');
            const extras = {
                // The shared daemon keeps the environment it started with, so the HTTP
                // token rides this thread's config instead of an env var. The user's own
                // servers are disabled by name: the thread config deep-merges.
                ...(leadMcpServers?.length || Object.keys(disabledMcp).length ? { config: {
                        ...disabledMcp,
                        ...Object.fromEntries((leadMcpServers ?? []).map(server => [`mcp_servers.${server.name}`, {
                                ...('url' in server ? { url: server.url, http_headers: { Authorization: `Bearer ${server.token}` } }
                                    : { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }),
                                enabled_tools: server.name === 'nodo_worker' ? WORKER_TOOLS : LEAD_TOOLS,
                                tools: Object.fromEntries((server.name === 'nodo_worker' ? WORKER_TOOLS : LEAD_TOOLS).map(tool => [tool, { approval_mode: 'approve' }])),
                            }])),
                        ...(lead ? LEAD_CONFIG : {}),
                    } } : {}),
                // A leader never shows an approval card: its only route is the read-only
                // sandbox, and a card the user accepts would grant execution.
                ...(lead || permission === 'full' ? { approvalPolicy: 'never' } : {}),
                // A leader keeps the read-only sandbox in every tier — routing only.
                ...(lead || permission === 'plan' ? { sandbox: 'read-only' } : permission === 'full' ? { sandbox: 'danger-full-access' }
                    : permission === 'workspace' ? { sandbox: 'workspace-write' } : {}),
                ...(developerInstructions ? { developerInstructions } : {}),
            };
            let result;
            resuming = !!threadId;
            try {
                try {
                    result = await peer.request(method, { ...params, ...extras });
                    instructionMode = developerInstructions ? 'native' : 'none';
                }
                catch (error) {
                    if (!developerInstructions || error.code !== -32602 || !/unknown field\s+[`'"]?developerInstructions\b/i.test(error.message))
                        throw error;
                    const fallback = { ...extras };
                    delete fallback.developerInstructions;
                    result = await peer.request(method, { ...params, ...fallback });
                    instructionMode = 'none';
                }
            }
            catch (error) {
                // A rejected thread start is the engine refusing the lockdown, a failure
                // the leader cannot recover from; report it in the lead-unavailable class.
                if (lead)
                    throw leadUnavailable(`Codex ${method} failed (${error.message})`);
                throw error;
            }
            resuming = false;
            threadId = result.thread.id;
            if (result.thread.projectId !== workspaceId)
                await peer.request('thread/metadata/update', { threadId, projectId: workspaceId });
            if (sessionName && !driverSessionId)
                await peer.request('thread/name/set', { threadId, name: `${name} · ${sessionName}` });
            if (disposed)
                throw new Error('Codex driver disposed');
            connected = true;
            emit({ type: 'session', state: 'ready', sessionId: threadId, workspaceId });
        })().catch(error => {
            if (resuming && [`no rollout found for thread id ${threadId}`, `no rollout found for thread with id ${threadId}`, `thread not found: ${threadId}`].some(phrase => error.message.includes(phrase)))
                Object.assign(error, { errorKind: 'resume-failed' });
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
        get instructionMode() { return connected ? instructionMode : 'none'; },
        get workerMcpMounted() { return connected && !disposed && Boolean(leadMcpServers?.some(server => server.name === 'nodo_worker')); },
        get coverage() { return coverage; },
        openSession: boot,
        async goals(objective) {
            await boot();
            const result = await peer.request(objective === undefined ? 'thread/goal/get' : objective === null ? 'thread/goal/clear' : 'thread/goal/set', { threadId, ...(objective == null ? {} : { objective, origin: 'user' }) });
            emit({ type: 'goal', ...(result.goal ?? {}), ...(objective === null || result.goal === null ? { cleared: true } : {}) });
            return result;
        },
        async sendTurn(text, images = []) {
            if (disposed)
                throw new Error('Codex driver disposed');
            if (running)
                throw new Error('Codex already has a running turn');
            const turn = running = { id: `starting-${++sequence}`, started: false, texts: new Map(), thoughts: new Map(), tools: new Map(), changes: createFileChanges(cwd) };
            try {
                await boot();
                if (disposed || running !== turn)
                    return turn.id;
                const input = [...(text === '' ? [] : [{ type: 'text', text: String(text), text_elements: [] }]), ...images.map(image => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` }))];
                const result = await peer.request('turn/start', { threadId, input, ...(thinking ? { effort: thinking } : {}) });
                if (running === turn)
                    start(result.turn.id);
                return result.turn.id;
            }
            catch (error) {
                if (running === turn)
                    running = null;
                throw error;
            }
        },
        async compact() {
            if (disposed)
                throw new Error('Codex driver disposed');
            if (running)
                throw new Error('Codex already has a running turn');
            const turn = running = { id: `compact-${++sequence}`, started: false, compacting: true, texts: new Map(), thoughts: new Map() };
            try {
                await boot();
                if (disposed || running !== turn)
                    return;
                start(turn.id);
                const result = await peer.request('thread/compact/start', { threadId });
                // thread/compacted settles the turn when the engine announces it; settle
                // here too so an engine that only resolves the request cannot wedge us.
                if (running === turn)
                    end('done');
                return result;
            }
            catch (error) {
                if (running === turn)
                    end('error', error.message);
                throw error;
            }
        },
        async steer(text) {
            if (!running?.started || running.compacting)
                return STEER.REFUSED;
            try {
                await peer.request('turn/steer', { threadId, expectedTurnId: running.id, input: [{ type: 'text', text: String(text), text_elements: [] }] });
                return STEER.STEERED;
            }
            catch (error) {
                return steerFailed(error);
            }
        },
        async interruptTurn() {
            const turn = running;
            if (!turn)
                return;
            turn.cancelled = true;
            if (!turn.started) {
                turn.unconfirmed = true;
                end('interrupted');
                return;
            }
            const done = new Promise(resolve => { turn.settle = resolve; });
            const drop = () => {
                turn.unconfirmed = true;
                const current = peer;
                peer = null;
                ready = null;
                connected = false;
                current?.dispose();
                end('interrupted');
                if (current)
                    emit({ type: 'session', state: 'closed' });
            };
            try {
                await peer.request('turn/interrupt', { threadId, turnId: turn.id }, 5000);
            }
            catch {
                if (running === turn)
                    drop();
                return;
            }
            let timer;
            await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
            clearTimeout(timer);
            if (running === turn)
                drop();
        },
        respondToRequest(id, { decision, value } = {}) {
            const request = requests.get(id);
            if (!request || !peer)
                return Promise.resolve(false);
            let result;
            if (request.method === 'item/tool/requestUserInput') {
                const questions = request.params.questions;
                let values;
                if (questions.length === 1)
                    values = { [questions[0].id]: [String(value ?? '')] };
                else {
                    try {
                        values = JSON.parse(value);
                    }
                    catch {
                        return Promise.reject(new Error('Answer each question using the form'));
                    }
                }
                if (!values || questions.some(question => {
                    const answer = values[question.id];
                    return answer == null || (Array.isArray(answer) ? answer.length === 0 || answer.some(text => !String(text).trim()) : !String(answer).trim());
                }))
                    return Promise.reject(new Error('Answer every question first'));
                result = { answers: Object.fromEntries(questions.map(question => [question.id, { answers: Array.isArray(values[question.id]) ? values[question.id].map(String) : [String(values[question.id] ?? '')] }])) };
            }
            else {
                if (!['allow', 'deny'].includes(decision))
                    return Promise.resolve(false);
                const chosen = decision === 'allow' ? 'accept' : 'decline';
                if (request.params.availableDecisions && !request.params.availableDecisions.includes(chosen))
                    return Promise.reject(new Error('This approval requires a decision not supported by this client'));
                result = { decision: chosen };
            }
            peer.reply(request.id, result);
            // The request is deleted above before the daemon's serverRequest/resolved
            // arrives, so the receive loop can no longer match it; the close must come
            // from here or the host keeps showing a settled card.
            requests.delete(id);
            emit({ type: 'request/closed', id });
            return Promise.resolve(true);
        },
        onEvent() { throw new Error('Pass onEvent to createCodexDriver'); },
        hasSession() { return connected; },
        dispose() { disposed = true; if (running)
            running.unconfirmed = true; end('interrupted'); const current = peer; peer = null; current?.dispose(); },
    };
}
// The composer's /-menu inventory: the custom prompts, plus the enabled skills
// app-server's skills/list reports for the workspace. A CLI that cannot be
// reached falls back to the installed plugin skills by their plain names from
// each plugin's newest cached version.
export async function scanCodexCommands({ engineOptions = {}, cwd } = {}) {
    const options = validateCodexOptions(engineOptions);
    const found = collector();
    const home = codexHome();
    let entries;
    try {
        entries = readdirSync(join(home, 'prompts'), { withFileTypes: true });
    }
    catch {
        entries = [];
    }
    for (const entry of entries)
        if (entry.isFile() && entry.name.endsWith('.md'))
            found.add(join(home, 'prompts', entry.name), entry.name.replace(/\.md$/, ''));
    const executable = findCodexExecutable(options.bin ?? 'codex');
    const peer = executable ? await connectCodex({ executable, socket: options.socket, start: true }).catch(() => null) : null;
    if (peer) {
        try {
            await initialize(peer);
            const listed = await peer.request('skills/list', cwd ? { cwds: [cwd] } : {});
            const skills = listed.data.flatMap(entry => entry.skills).filter(skill => skill.enabled).map(skill => ({ id: skill.name, description: skill.description.slice(0, 200), path: skill.path,
                scope: skill.pluginId ? 'plugin' : skill.scope === 'repo' ? 'project' : 'global', prefix: '$' }));
            if (skills.length)
                return { source: 'Codex app-server skills/list', commands: [...found.list().commands, ...skills] };
        }
        catch { }
        finally {
            peer.dispose();
        }
    }
    const scanSkills = (dir) => {
        for (const path of listDirs(dir))
            found.add(join(path, 'SKILL.md'), basename(path), undefined, 'plugin');
    };
    for (const { path } of newestPluginVersions(join(home, 'plugins', 'cache')))
        scanSkills(join(path, 'skills'));
    return found.list('Codex prompts and plugin skills');
}
