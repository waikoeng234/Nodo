import { STEER, addUsage, usageOf } from '../spi.js';
import { validateWorkspace } from '../cli.js';
import { createCoverage, DECLARED } from '../coverage.js';
import { createFileChanges } from '../file-changes.js';
const MEDIA_BLOCKS = new Set(['image', 'audio', 'resource_link', 'resource']);
const blockValue = (block) => block?.type === 'content' ? block.content : block;
const objectOf = (value) => (value !== null && typeof value === 'object' ? value : {});
const hasMedia = (content) => Array.isArray(content) && content.some((block) => MEDIA_BLOCKS.has(blockValue(block)?.type));
const hasContentBlock = (content) => Array.isArray(content) && content.some((block) => block?.type === 'content');
const hasText = (content) => Array.isArray(content) && content.some((block) => {
    const inner = blockValue(block);
    return inner?.type === 'text' && typeof inner.text === 'string' && inner.text !== '';
});
const rawText = (value) => {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map(rawText).filter(Boolean).join('\n');
    if (value === null || typeof value !== 'object')
        return '';
    if (typeof value.text === 'string')
        return value.text;
    if (typeof value.output === 'string')
        return value.output;
    return Array.isArray(value.content) ? rawText(value.content) : '';
};
// Media content is selected for its image/audio/resource evidence, but a
// simultaneous plain rawOutput may still be the only readable output.
const withRawText = (content, rawOutput) => {
    if (hasText(content) || rawOutput === undefined)
        return content;
    const text = rawText(rawOutput);
    return [...content, text ? { type: 'text', text } : rawOutput];
};
// The end-turn ACP `Usage` object is an open RFD, and real agents report the
// buckets disjoint: `inputTokens` is already the uncached prompt side.
const acpUsage = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    return usageOf({
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cachedReadTokens,
        cacheWriteTokens: raw.cachedWriteTokens,
    });
};
export async function initializeAcp(peer, clientCapabilities = {}, clientInfo) {
    const result = await peer.request('initialize', { protocolVersion: 1, clientCapabilities, ...(clientInfo ? { clientInfo } : {}) }, 30_000);
    if (result?.protocolVersion !== 1)
        throw new Error('Unsupported ACP protocol version');
    return result.agentCapabilities ?? {};
}
export function createAcpDriver({ onEvent, cwd, driverSessionId, permission } = {}, support) {
    const { id, label } = support;
    const emit = (event) => { try {
        onEvent?.(event);
    }
    catch { } };
    // ACP plan entries carry status pending/in_progress/completed and a content
    // string; anything else cannot be placed and is left out rather than guessed.
    const planSteps = (entries) => entries.filter(entry => typeof entry?.content === 'string' && entry.content !== '')
        .map(entry => ({ text: entry.content, status: entry.status === 'in_progress' ? 'in_progress' : entry.status === 'completed' ? 'completed' : 'pending' }));
    const errorText = (error) => typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : undefined;
    const translateError = (error) => (support.error?.(error) ?? error);
    let peer = null;
    let ready = null;
    let sessionId = driverSessionId;
    let connected = false;
    let promptImages = false;
    let disposed = false;
    let sequence = 0;
    let running = null;
    const requests = new Map();
    const coverage = createCoverage(id, 'acp');
    const closeRequests = () => {
        for (const [cardId, entry] of requests) {
            // A permission-gated question still closes as the permission request it
            // is on the wire; only plain elicitation speaks the cancel action. A
            // request the card already answered takes no second result.
            if (!entry.replied) {
                try {
                    peer?.reply(entry.id, entry.kind === 'permission' || entry.gated ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' });
                }
                catch { }
            }
            emit({ type: 'request/closed', id: cardId });
        }
        requests.clear();
    };
    const end = (turn, reason, error, usage) => {
        if (running !== turn)
            return;
        running = null;
        turn.settle?.();
        closeRequests();
        // A session's `usage_update` reports the context occupancy of the newest
        // request; a prompt result reports the turn's token buckets. Both describe
        // the same turn, so they merge rather than the later one replacing the other.
        const merged = addUsage(turn.context, acpUsage(usage));
        if (support.fileChanges && turn.started)
            emit(turn.changes.snapshot(turn.id));
        // Only the source's messageId bounds a message; without it the last one is unknown.
        const last = turn.unbounded ? undefined : [...turn.messages.values()].at(-1);
        emit({ type: 'turn/end', turnId: turn.id, reason, ...(last ? { text: last } : {}), ...(error ? { error } : {}), ...(merged ? { usage: merged } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) });
    };
    const disconnect = () => {
        const connection = peer;
        peer = null;
        ready = null;
        connected = false;
        connection?.dispose();
        if (connection)
            emit({ type: 'session', state: 'closed' });
    };
    const receive = ({ method, params: raw }) => {
        const params = objectOf(raw);
        // A notification outside the declared set counts by category only; its raw
        // name and payload go nowhere. Declared-but-unmapped methods stay silent.
        if (method !== undefined && method !== 'session/update') {
            if (!params?._meta?.isReplay && !DECLARED.acp.notifications[method])
                coverage.count('unknown-notification');
            return;
        }
        if (params.sessionId !== sessionId || !running?.started || params._meta?.isReplay || params.update?._meta?.isReplay)
            return;
        const turn = running;
        const update = objectOf(params.update);
        const meta = objectOf(update._meta);
        if (update.sessionUpdate !== undefined && !DECLARED.acp.variants[update.sessionUpdate])
            coverage.count('unknown-variant');
        // Child-session ownership rides `_meta` when the dedicated child channel is
        // not negotiated (OpenCode): child-owned updates are activity of that child,
        // never the main turn's reply. The child id/parent stay the source's own.
        const child = meta['opencode/child-session'];
        if (child && typeof child.id === 'string' && child.id !== '') {
            if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
                const entry = turn.children.get(child.id) ?? { text: '' };
                entry.text = `${entry.text}${update.content.text}`.slice(0, 4000);
                if (typeof child.title === 'string' && child.title)
                    entry.title = child.title;
                turn.children.set(child.id, entry);
                emit({ type: 'activity', turnId: turn.id, phase: entry.started ? 'update' : 'start', entityId: child.id, name: 'subagent',
                    ...(entry.title ? { title: entry.title } : {}), detail: entry.text, ...(child.parentID ? { parentId: child.parentID } : {}) });
                entry.started = true;
            }
            if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
                const status = update.status;
                emit({ type: 'activity', turnId: turn.id, phase: ['completed', 'failed'].includes(status) ? 'end' : update.sessionUpdate === 'tool_call' ? 'start' : 'update',
                    entityId: `${child.id}/${update.toolCallId}`, name: 'subagent',
                    ...(update.title || update.name ? { title: update.title ?? update.name } : {}),
                    ...(child.parentID ? { parentId: child.parentID } : {}), isError: status === 'failed' });
            }
            return;
        }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            if (update.messageId && !turn.messages.has(update.messageId)) {
                turn.messages.set(update.messageId, '');
            }
            if (update.content.text) {
                if (update.messageId)
                    turn.messages.set(update.messageId, turn.messages.get(update.messageId) + update.content.text);
                else
                    turn.unbounded = true;
                emit({ type: 'delta', turnId: turn.id, text: update.content.text, ...(update.messageId ? { messageId: update.messageId } : {}) });
            }
        }
        if (support.thoughts !== false && update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text')
            emit({ type: 'thinking', turnId: turn.id, text: update.content.text, ...(update.messageId ? { messageId: update.messageId } : {}) });
        if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
            const key = update.toolCallId;
            if (!key || turn.completedTools.has(key))
                return;
            const previous = turn.tools.get(key);
            const name = previous?.name ?? update.name ?? update.title ?? 'tool';
            const input = update.rawInput !== undefined ? update.rawInput : previous?.input;
            const rawOutput = update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput;
            const content = update.content !== undefined ? update.content : previous?.content;
            // Content blocks carry the only image/audio/resource evidence; a plain
            // rawOutput that accompanies them must not hide it, and its readable
            // text still has to survive when the content blocks are media-only. A
            // non-media content-block list still wins over rawOutput metadata, and a
            // status-only update keeps the previous output.
            const output = content !== undefined && hasMedia(content) ? withRawText(content, rawOutput)
                : hasContentBlock(content) ? content
                    : rawOutput !== undefined ? rawOutput
                        : content !== undefined ? content
                            : previous?.output;
            const kind = update.kind === undefined ? previous?.kind : update.kind;
            const locations = update.locations === undefined ? previous?.locations : update.locations;
            turn.tools.set(key, { name, input, output, rawOutput, content, kind, locations });
            if (previous === undefined) {
                emit({ type: 'tool', turnId: turn.id, callId: key, name, phase: 'start', input, brief: update.title ?? update.rawInput?.command ?? update.rawInput?.description });
            }
            else if (!['completed', 'failed'].includes(update.status)) {
                // ACP tool_call_update is a partial patch: an included field replaces
                // the previous value, an omitted one stays. Only changed fields are
                // forwarded so a status-only update does not churn the host row.
                const changed = (value, before) => JSON.stringify(value) !== JSON.stringify(before);
                const fields = {};
                if (typeof update.name === 'string' && update.name !== '' && update.name !== previous.name)
                    fields.name = update.name;
                if (update.rawInput !== undefined && changed(input, previous.input))
                    fields.input = input;
                if ((update.rawOutput !== undefined || update.content !== undefined) && changed(output, previous.output))
                    fields.output = output;
                if (Object.keys(fields).length) {
                    emit({ type: 'tool', turnId: turn.id, callId: key, name: fields.name ?? name, phase: 'update',
                        ...(fields.input !== undefined ? { input: fields.input } : {}), ...(fields.output !== undefined ? { output: fields.output } : {}) });
                }
            }
            if (['completed', 'failed'].includes(update.status)) {
                if (support.fileChanges) {
                    const files = (Array.isArray(content) ? content : []).filter(block => block?.type === 'diff').map(block => ({ path: block.path,
                        edit: { operation: block.oldText === null ? 'add' : 'update',
                            ...(typeof block.oldText === 'string' || block.oldText === null ? { oldText: block.oldText } : {}), newText: block.newText } }));
                    if (['edit', 'delete', 'move'].includes(kind))
                        for (const location of Array.isArray(locations) ? locations : []) {
                            if (!files.some(file => file.path === location?.path))
                                files.push({ path: location?.path, edit: { operation: kind === 'edit' ? 'unknown' : kind } });
                        }
                    turn.changes.add(key, files, update.status === 'completed');
                }
                turn.tools.delete(key);
                turn.completedTools.add(key);
                emit({ type: 'tool', turnId: turn.id, callId: key, name, phase: 'end', input, output, isError: update.status === 'failed' });
            }
        }
        if (update.sessionUpdate === 'usage_update')
            turn.context = usageOf({ contextUsed: update.used, contextSize: update.size });
        // Plan updates are whole-plan snapshots; a removed plan clears the row
        // instead of leaving stale steps behind.
        if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
            emit({ type: 'plan', turnId: turn.id, steps: planSteps(update.entries) });
        }
        if (update.sessionUpdate === 'plan_update' && update.plan?.type === 'items' && Array.isArray(update.plan.entries)) {
            emit({ type: 'plan', turnId: turn.id, ...(typeof update.plan.planId === 'string' ? { entityId: update.plan.planId } : {}), steps: planSteps(update.plan.entries) });
        }
        if (update.sessionUpdate === 'plan_update' && update.plan?.type === 'markdown' && typeof update.plan.content === 'string' && update.plan.content !== '') {
            emit({ type: 'plan', turnId: turn.id, text: update.plan.content, ...(typeof update.plan.planId === 'string' ? { entityId: update.plan.planId } : {}) });
        }
        if (update.sessionUpdate === 'plan_removed') {
            emit({ type: 'plan', turnId: turn.id, ...(typeof update.planId === 'string' ? { entityId: update.planId } : {}), steps: [], removed: true });
        }
        if (update.sessionUpdate === 'compaction_update' && typeof update.status === 'string') {
            emit({ type: 'lifecycle', turnId: turn.id, kind: 'compaction', phase: update.status === 'in_progress' ? 'start' : 'end',
                ...(update.compactionId ? { entityId: String(update.compactionId) } : {}),
                ...(update.status === 'failed' && errorText(update.error) ? { detail: errorText(update.error) } : {}),
                isError: update.status === 'failed', cancelled: update.status === 'cancelled' });
        }
        // OpenCode announces retries and (un-negotiated) compaction through
        // `session_info_update` `_meta`; both key shapes are the reducer's own.
        if (update.sessionUpdate === 'session_info_update' && 'opencode/retry' in meta) {
            const retry = meta['opencode/retry'];
            if (retry && typeof retry === 'object') {
                emit({ type: 'lifecycle', turnId: turn.id, kind: 'retry', phase: 'start',
                    ...(Number.isFinite(retry.attempt) ? { entityId: `retry:${turn.id}:${retry.attempt}` } : {}),
                    ...(errorText(retry.error) ? { detail: errorText(retry.error) } : {}) });
            }
            else
                emit({ type: 'lifecycle', turnId: turn.id, kind: 'retry', phase: 'end' });
        }
        if (update.sessionUpdate === 'session_info_update' && meta['opencode/compaction'] && typeof meta['opencode/compaction'] === 'object') {
            // The degraded channel reports started/completed/failed; the reducer
            // folds a cancellation into failed with an aborted error type, the same
            // types its negotiated path classifies as cancelled.
            const compaction = meta['opencode/compaction'];
            const cancelled = typeof compaction.error === 'object' && compaction.error !== null
                && ['aborted', 'compaction.interrupted'].includes(compaction.error.type);
            emit({ type: 'lifecycle', turnId: turn.id, kind: 'compaction', phase: compaction.status === 'started' ? 'start' : 'end',
                ...(compaction.status === 'failed' && !cancelled && errorText(compaction.error) ? { detail: errorText(compaction.error) } : {}),
                isError: compaction.status === 'failed' && !cancelled, cancelled });
        }
    };
    const ask = ({ id: requestId, method, params: raw }) => {
        const params = objectOf(raw);
        if (!peer)
            return;
        if (!DECLARED.acp.requests[method])
            coverage.count('unknown-request');
        if (!running?.started || (params.sessionId !== undefined && params.sessionId !== sessionId))
            return peer.refuse(requestId, 'No matching active turn');
        const cardId = `${id}:${sessionId}:${typeof requestId}:${requestId}`;
        if (method === 'session/request_permission') {
            if (!Array.isArray(params.options) || !params.options.length)
                return peer.refuse(requestId, 'No permission choices supplied');
            const tool = params.toolCall?.name ?? params.toolCall?.title ?? running.tools.get(params.toolCall?.toolCallId)?.name;
            // An engine may promote a permission into a question: CodeBuddy gates its
            // AskUserQuestion tool with one, the questions riding in the tool call's
            // raw input, and the answers travel back outside the ACP reply. The hook
            // sees the resolved tool name so an ordinary tool that merely takes a
            // `questions` input stays a permission.
            const promoted = support.question?.({ method, params, tool });
            if (promoted) {
                requests.set(cardId, { kind: 'question', id: requestId, params, question: promoted, gated: true });
                emit({ type: 'request/opened', id: cardId, kind: 'question', ...promoted.card });
                return;
            }
            requests.set(cardId, { kind: 'permission', id: requestId, params });
            emit({ type: 'request/opened', id: cardId, kind: 'permission', tool: tool ?? 'tool',
                reason: params.toolCall?.title ?? `${label} requests permission`, detail: { options: params.options, toolCall: params.toolCall } });
        }
        else {
            const question = support.question?.({ method, params });
            if (!question)
                return peer.refuse(requestId);
            requests.set(cardId, { kind: 'question', id: requestId, params, question });
            emit({ type: 'request/opened', id: cardId, kind: 'question', ...question.card });
        }
    };
    const boot = () => {
        if (ready)
            return ready;
        let connection;
        const startup = (async () => {
            if (disposed)
                throw new Error(`${label} driver disposed`);
            validateWorkspace(cwd, true);
            emit({ type: 'session', state: 'starting' });
            connection = support.connect({ onNotification: receive, onRequest: ask, onClose(error) {
                    if (peer !== connection)
                        return;
                    peer = null;
                    ready = null;
                    connected = false;
                    if (running?.started)
                        end(running, running.cancelled ? 'interrupted' : 'error', running.cancelled ? undefined : translateError(error).message);
                    else
                        closeRequests();
                    emit({ type: 'session', state: 'closed' });
                } });
            peer = connection;
            const capabilities = await (support.initialize ?? initializeAcp)(connection);
            coverage.setIdentity({ transport: 'acp', ...(support.initialize ? {} : { protocolVersion: 1 }) });
            promptImages = capabilities.promptCapabilities?.image === true;
            let method = 'session/new';
            if (sessionId) {
                if (support.resumeMethod !== 'load' && capabilities.sessionCapabilities?.resume)
                    method = 'session/resume';
                else if (capabilities.loadSession)
                    method = 'session/load';
                else
                    throw new Error(`${label} ACP cannot restore the saved session`);
            }
            const attached = await connection.request(method, { ...(sessionId ? { sessionId } : {}), cwd, mcpServers: [] }, 30_000);
            if (!sessionId)
                sessionId = attached?.sessionId;
            else if (attached?.sessionId && attached.sessionId !== sessionId)
                throw new Error(`${label} restored a different session`);
            if (typeof sessionId !== 'string' || !sessionId)
                throw new Error(`${label} returned no session id`);
            // The id persists before configure: a rejected option fails this boot and
            // the next one reloads this session instead of creating another one.
            emit({ type: 'session', state: 'ready', sessionId: support.savedId?.(sessionId) ?? sessionId });
            await support.configure?.({ peer: connection, sessionId, attached, permission });
            if (disposed || peer !== connection)
                throw new Error(`${label} startup was cancelled`);
            connected = true;
        })();
        const pending = startup.catch(error => {
            if (peer === connection)
                disconnect();
            if (ready === pending)
                ready = null;
            throw translateError(error);
        });
        ready = pending;
        return pending;
    };
    return {
        get instructionMode() { return connected ? support.instructionMode ?? 'none' : 'none'; },
        get coverage() { return coverage; },
        openSession: boot,
        async sendTurn(text, images = []) {
            if (disposed)
                throw new Error(`${label} driver disposed`);
            if (running)
                throw new Error(`${label} already has a running turn`);
            const turn = running = { id: `${id}-${++sequence}`, started: false, messages: new Map(), tools: new Map(), completedTools: new Set(), children: new Map(), changes: createFileChanges(cwd) };
            try {
                await boot();
                if (disposed || running !== turn)
                    return turn.id;
                if (images.length > 0 && !promptImages)
                    throw new Error(`${label} does not accept images`);
                // An engine whose channel delivers prompt text verbatim may expand a
                // slash line itself, the job its CLI's TUI does on its own surface.
                if (support.expandPrompt)
                    text = await support.expandPrompt(text);
                if (disposed || running !== turn)
                    return turn.id;
                turn.started = true;
                turn.done = new Promise(resolve => { turn.settle = resolve; });
                emit({ type: 'turn/start', turnId: turn.id });
                // A prompt's response ends the turn; it has no handshake deadline.
                const prompt = [...(text === '' ? [] : [{ type: 'text', text: String(text) }]), ...images.map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data }))];
                peer.request('session/prompt', { sessionId, prompt }, null).then(result => {
                    const stop = result?.stopReason;
                    // Only an explicit end_turn is a normal finish; a support override
                    // still wins so engine-specific reason maps stay authoritative.
                    const reason = turn.cancelled || stop === 'cancelled' ? 'interrupted' : support.stopReason?.(stop) ?? (stop === 'end_turn' ? 'done' : 'error');
                    end(turn, reason, reason === 'error' ? `${label} stopped: ${stop ?? 'unknown reason'}` : undefined, result?.usage);
                }, error => end(turn, turn.cancelled ? 'interrupted' : 'error', turn.cancelled ? undefined : translateError(error).message));
                return turn.id;
            }
            catch (error) {
                if (running !== turn)
                    return turn.id;
                running = null;
                throw error;
            }
        },
        async steer() { return STEER.REFUSED; },
        async interruptTurn() {
            const turn = running;
            if (!turn)
                return;
            turn.cancelled = true;
            closeRequests();
            const drop = () => { turn.unconfirmed = true; disconnect(); end(turn, 'interrupted'); };
            if (!turn.started) {
                drop();
                return;
            }
            try {
                peer.notify('session/cancel', { sessionId });
            }
            catch {
                drop();
                return;
            }
            let timer;
            await Promise.race([turn.done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
            clearTimeout(timer);
            if (running === turn)
                drop();
        },
        async respondToRequest(cardId, { decision, value, always = false } = {}) {
            const entry = requests.get(cardId);
            if (!entry || !peer || entry.busy)
                return false;
            if (entry.kind === 'permission') {
                if (!['allow', 'deny'].includes(decision))
                    return false;
                const kinds = decision === 'allow' ? (always ? ['allow_always', 'allow_once'] : ['allow_once']) : ['reject_once', 'reject_always'];
                const option = kinds.map(kind => entry.params.options.find(item => item.kind === kind)).find(Boolean);
                if (option)
                    peer.reply(entry.id, { outcome: { outcome: 'selected', optionId: option.optionId } });
                else if (decision === 'deny')
                    peer.reply(entry.id, { outcome: { outcome: 'cancelled' } });
                else
                    throw new Error(`${label} did not offer this permission decision`);
            }
            else {
                if (decision !== 'answer')
                    return false;
                entry.busy = true;
                try {
                    // A gated question opens its own gate here, before the hook's
                    // follow-up: the ACP request id then carries its one result even if
                    // the follow-up fails, and a later close stays silent on the wire.
                    if (entry.gated && !entry.replied) {
                        const options = Array.isArray(entry.params.options) ? entry.params.options : [];
                        const option = options.find(item => item.kind === 'allow_once') ?? options.find(item => item.kind === 'allow_always');
                        peer.reply(entry.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
                        entry.replied = true;
                    }
                    // A respond that sends its own follow-up request (the gated
                    // question's interruption) awaits it: a failure keeps the card open
                    // for a retry instead of closing the UI onto a turn that can no
                    // longer settle.
                    if (entry.question.respond)
                        await entry.question.respond({ peer, sessionId: sessionId, id: entry.id, value });
                    else
                        peer.reply(entry.id, entry.question.answer(value));
                }
                catch (error) {
                    entry.busy = false;
                    throw error;
                }
                // The turn may have ended while the follow-up was in flight; that
                // close already reported the card.
                if (requests.get(cardId) !== entry)
                    return true;
            }
            requests.delete(cardId);
            emit({ type: 'request/closed', id: cardId });
            return true;
        },
        onEvent() { throw new Error('Pass onEvent to createAcpDriver'); },
        hasSession() { return connected; },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            if (running)
                end(running, 'interrupted');
            disconnect();
            support.dispose?.();
        },
    };
}
