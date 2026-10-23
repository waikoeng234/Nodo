// The driver SPI: the eight primitives every engine adapter implements, plus the
// event and request shapes it emits. Model catalogs are an optional `scan` beside
// the SPI; login flows, billing and thread/room/memory concepts stay out of this
// package.
/** The eight primitives. `missingPrimitives` checks an adapter against this list. */
export const PRIMITIVES = [
    'openSession',
    'sendTurn',
    'steer',
    'interruptTurn',
    'respondToRequest',
    'onEvent',
    'hasSession',
    'dispose',
];
// Only driver-authored capability messages may cross the host's startup error boundary.
export class UnsupportedCapabilityError extends Error {
}
// Optional instructionMode is 'native' only after openSession has installed the
// supplied instructions. Missing or 'none' runs the session without role identity;
// the host never copies identity into task messages.
// Optional instructionTarget identifies the actual layer (e.g. tool-schema);
// native means engine-managed persistence, not necessarily a system message.
//
// `permission` ('plan' | 'workspace' | 'full', default 'workspace') is the
// host's three-tier autonomy axis, translated by each driver into its engine's
// own sandbox channel at openSession. It presets how much the engine may do
// before asking; it never bypasses the request/opened approval cards.
//
// `compact()` is optional: where the engine has a native channel (claude's
// slash line, zcode session/compact, codex thread/compact/start) it compacts
// the session's older history; drivers without one omit it and the host hides
// the composer's compact row (capabilities.compact).
// Engines with asynchronous compaction emit turn/start and turn/end for its lifetime.
/** steer() outcomes. `steered`: the running turn will take the text in; `refused`:
 *  the engine cannot steer mid-turn (queue or interrupt instead); `indeterminate`:
 *  the text was handed over but the engine gives no acknowledgement. */
export const STEER = Object.freeze({
    STEERED: 'steered',
    REFUSED: 'refused',
    INDETERMINATE: 'indeterminate',
});
/** The outcome of a hand-over that failed: a request that timed out may still have
 *  reached the engine, so it must not be sent again as a new turn. */
export const steerFailed = (error) => (error?.name === 'TimeoutError' ? STEER.INDETERMINATE : STEER.REFUSED);
/** respondToRequest decisions. `allow`/`deny` answer a permission request; `answer`
 *  replies to a question with free text. `always` may upgrade a once-allow into a
 *  session rule when the engine supports it. */
export const DECISION = Object.freeze({
    ALLOW: 'allow',
    DENY: 'deny',
    ANSWER: 'answer',
});
/**
 * Events every adapter emits through `onEvent`:
 *
 *   { type: 'session',    state: 'starting' | 'ready' | 'closed', sessionId?, workspaceId?, detail? }
 *   { type: 'turn/start', turnId }
 *   { type: 'delta',      turnId, text }                      // incremental assistant text
 *   { type: 'text',       turnId, text }                      // one whole assistant message
 *   { type: 'thinking',   turnId, text }                      // new reasoning text, snapshots deduplicated by the driver
 *   { type: 'tool',       turnId, name, phase: 'start' | 'update' | 'end', callId?, parentCallId?,
 *                         input?, inputText?, inputDelta?, output?, outputText?, outputDelta?,
 *                         progress?, brief?, isError?, presentation? }
 *   { type: 'changes',    turnId, presentation }             // final source-scoped file snapshot, see PROTOCOL.md
 *   { type: 'plan',       turnId, entityId?, title?, explanation?, text?,
 *                         steps?: [{ text, status }], removed? } // whole-plan snapshot, see below
 *   { type: 'activity',   turnId, phase: 'start' | 'update' | 'end', entityId,
 *                         name?, title?, detail?, parentId?, childId?, toolCallId?, isError? }
 *   { type: 'lifecycle',  turnId?, kind: 'compaction' | 'retry', phase: 'start' | 'end',
 *                         entityId?, detail?, isError?, cancelled? }
 *   { type: 'turn/end',   turnId, reason: 'done' | 'interrupted' | 'error',
 *                         text?, error?, usage?, timing?, unconfirmed? }
 *                         // unconfirmed: the driver, or the host on its behalf, ended the
 *                         // turn locally after a failed or unanswered stop; the engine may
 *                         // still be working.
 *   { type: 'request/opened', id, kind: 'permission' | 'question',
 *                         tool?, reason?, options?, detail? } // answered via respondToRequest
 *   { type: 'request/closed', id }                            // optional: already settled
 *
 * A server→client request that pauses the turn for human input must surface as
 * request/opened — never refuse it silently: the refusal reads as a rejection
 * and the turn continues without the user ever seeing the question.
 *
 * Adapters may skip `delta` and emit only `text`; hosts must handle both.
 * Optional tool presentation is {version:1, kind:'tool', mode:'snapshot', revision?,
 * body:{input?, inputText?, outputText?, command?, cwd?, exitCode?, signal?, diffs?},
 * capture?:'complete'|'partial'|'unavailable', reason?, resources?}. A null oldText
 * requires created:true on that diff. It carries no host ownership or detail
 * reference. A presentation may name confirmed media as bounded `resources`
 * (kind, mime, source URI, availability); inline image bytes belong to the
 * tool's structured output, never to this snapshot, and the host stores them as
 * attachment references before saving. Unknown versions and delta presentations
 * retain the existing text fallback.
 *
 * A tool `update` is the same turnId+callId, never a new call: hosts must not
 * count it as another tool execution. `inputDelta`/`outputDelta` append the
 * source's own delta text (only when the source states delta semantics; there
 * is no dedupe identity, so a replayed delta repeats); `inputText`/`outputText`
 * replace a readable snapshot; `input`/`output` carry the authoritative
 * structured value, and `end` is final. `progress` is a display-only latest
 * snapshot carrying only fields the source distinguishes (elapsedMs, message,
 * stdoutTail, stderrTail, stdoutBytes, stderrBytes, outputBytes). A driver must
 * not synthesize a delta from a snapshot, guess field meaning from an event
 * name, or turn an update into a new tool. A source without an update channel
 * omits it; an update after a terminal state is ignored.
 *
 * Three optional structural events (ES-06). Sources that do not expose them
 * omit them; hosts and older drivers ignore what they do not know. None of them
 * ever becomes model-visible text, and none of them changes turn state.
 *
 *   plan      every event is the WHOLE plan for its turn: `steps` (each
 *             `{text, status: 'pending'|'in_progress'|'completed'}`) replace the
 *             previous list, `text`/`explanation` replace the readable body.
 *             `removed: true` (or an accepted event with no steps left) clears
 *             the plan. Updates never append a new plan to the transcript; the
 *             host replaces its one plan row per turn, so restore stays
 *             duplicate-free. Sources without a plan channel omit the event.
 *
 *   activity  one subagent/task/workflow member. `entityId` is the source's own
 *             stable id and is required; `parentId`/`toolCallId`/`childId` ride
 *             along only when the source names them — the host never infers a
 *             hierarchy from names. `title`/`detail` are latest snapshots
 *             (replace, not append); `end` is terminal, and `isError` marks a
 *             failed member. A member's failure never ends the owning turn.
 *
 *   lifecycle compaction and retry waits. Only engine-declared signals map
 *             here; a driver must not synthesize a retry or a compaction state
 *             the source did not send, and none of it pretends to be thinking
 *             content. `end` with `isError` reports the failed state;
 *             `cancelled: true` on `end` marks a source-declared cancellation
 *             (never inferred from silence). A source that only announces the
 *             completion (Codex `thread/compacted`) emits `end` alone.
 *             `turnId` is optional: a host-side compaction can run outside any
 *             turn.
 *
 * `usage` is the one normalized shape every adapter reports, so the host can add
 * one engine's turn to another's session totals without knowing the protocol:
 *
 *   inputTokens       uncached prompt tokens of the turn
 *   outputTokens      generated tokens, reasoning included
 *   cacheReadTokens   prompt tokens served from the provider's prompt cache
 *   cacheWriteTokens  prompt tokens the provider wrote into that cache
 *   contextUsed       prompt-side occupancy of the newest request, the four-bucket
 *                     sum of that one request (not of the whole turn)
 *   contextSize       the context window of the model the request was routed to
 *
 * The four token buckets are disjoint, so turn and session totals are sums; the
 * two context fields are last-wins snapshots, not sums. Every field is optional
 * — an engine that cannot report a figure omits it, and the host then leaves
 * that part of its display out rather than showing a zero.
 *
 * `timing` carries the same idea for wall times, in milliseconds: an adapter
 * whose own host already times its turns reports them here, and the host then
 * uses these instead of the clock it keeps while events stream in.
 *
 *   ttftMs        turn start → first output token
 *   ttftSteps     turns that reported a ttftMs, the denominator of the average
 *   llmMs         model wall time of the turn
 *   toolMs        tool wall time of the turn
 *   decodeMs      time the turn spent producing output
 *   decodeTokens  output tokens produced over decodeMs, for the speed figure
 */
/** The normalized `usage` keys, in display order. */
export const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'contextUsed', 'contextSize']);
/**
 * Builds a normalized `usage` from raw protocol numbers: unknown keys, absent
 * fields, NaN, Infinity and negatives are dropped, so a half-reported turn
 * still adds what it does know. Returns undefined when nothing survives.
 */
export function usageOf(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const usage = {};
    for (const key of USAGE_KEYS) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
            usage[key] = Math.round(value);
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
}
/**
 * Folds one request's normalized usage into a running one, for the engines that
 * report per model call: the four token buckets add up, the two context fields
 * keep the newer snapshot. Undefined on either side is the identity, so a turn
 * whose requests each know different fields still ends with everything known.
 */
export function addUsage(base, next) {
    if (base === undefined || next === undefined)
        return base ?? next;
    const usage = {};
    for (const key of USAGE_KEYS) {
        if (key === 'contextUsed' || key === 'contextSize') {
            const value = next[key] ?? base[key];
            if (value !== undefined)
                usage[key] = value;
        }
        else if (base[key] !== undefined || next[key] !== undefined) {
            usage[key] = (base[key] ?? 0) + (next[key] ?? 0);
        }
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
}
/** The normalized `timing` keys. */
export const TIMING_KEYS = Object.freeze(['ttftMs', 'ttftSteps', 'llmMs', 'toolMs', 'decodeMs', 'decodeTokens']);
/** The clean-up `usageOf` does, for a `timing` object. */
export function timingOf(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const timing = {};
    for (const key of TIMING_KEYS) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
            timing[key] = Math.round(value);
    }
    return Object.keys(timing).length > 0 ? timing : undefined;
}
/** Returns the primitive names an adapter object does not provide as functions. */
export function missingPrimitives(candidate) {
    if (candidate === null || typeof candidate !== 'object')
        return [...PRIMITIVES];
    return PRIMITIVES.filter(name => typeof candidate[name] !== 'function');
}
/**
 * Optional primitives beyond the eight: a driver implements those its engine can
 * honor and declares exactly those in `info.capabilities` — declaration without
 * method, or method without declaration, is a registry error createDriver
 * refuses. New optional primitives join this list.
 */
export const OPTIONAL_METHODS = [
    'compact', // compact the session's older history; absent when the engine's channel has no such request
];
/** Whether a driver implements one optional primitive. */
export function hasOptionalMethod(driver, name) {
    return typeof driver?.[name] === 'function';
}
