import { randomUUID } from 'node:crypto'
import { TRANSCRIPT_TEXT_MAX, TURN_IDLE_TIMEOUT_MS, RETRY_IDLE_TIMEOUT_MS } from './constants.js'
import { clip } from './text.js'
import { projectContent } from './resources.js'
import { changesTool, normalizeProgress, previewRecord } from './stream-records.js'
import { failure } from './errors.js'

const readable = (value, imageOutput = false) => projectContent(value, imageOutput).text
const foreign = (st, event) => event.turnId !== undefined
  && (st.turnId === null ? String(event.turnId) === st.endedTurn : String(event.turnId) !== String(st.turnId))

// Event sinks: one handler per driver event type. Dispatch owns the turn state
// machine and passes its helpers in; these handlers only fold events into rows.
export function createDispatchSinks(rt, { stateOf, say, messagesOf, closeMessages, bindTurn, settle, armIdle, disarmIdle, drain }) {
  const settleRequest = (sessionId, st, id, request, cancelled = false) => {
    if (request.closed) return
    request.closed = true
    closeMessages(st)
    request.line = say(sessionId, { who: 'system', kind: 'request', requestId: id, requestKind: request.kind, phase: 'end',
      ...(cancelled ? { cancelled: true } : {}),
      ...(request.turnId !== null ? { turnId: request.turnId } : {}) })
  }
  const saveRecord = (sessionId, st, line, record) => {
    st.recordWrites = Promise.resolve(st.recordWrites).then(async () => {
      line.presentation = await rt.saveStreamRecord(sessionId, record)
      rt.touchLine?.(sessionId, line)
      await rt.save(true)
    }).catch(() => rt.warn?.('nodo: tool detail projection could not be persisted'))
  }
  // Fold one update into the running row. Deltas append because the driver
  // declared them as deltas; snapshots replace; the terminal end line stays the
  // authoritative value. This runs in memory only: the live view reads state,
  // and the final line is saved when the turn's writes are flushed.
  const applyToolFields = (line, event) => {
    if (typeof event.name === 'string' && event.name !== '') line.name = event.name
    if (event.parentCallId !== undefined) line.parentCallId = String(event.parentCallId)
    if (event.childId !== undefined) line.childId = String(event.childId)
    if (event.toolCallId !== undefined) line.toolCallId = String(event.toolCallId)
    if (event.noRecord === true) line.activity = true
    if (typeof event.brief === 'string' && event.brief !== '') line.brief = clip(rt.redactDeepSecrets(event.brief), 2000, 'long tool output')
    if (event.inputText !== undefined) line.input = clip(rt.redactDeepSecrets(String(event.inputText)), TRANSCRIPT_TEXT_MAX, 'long tool input')
    if (event.inputDelta !== undefined) line.input = clip(rt.redactDeepSecrets((line.input ?? '') + String(event.inputDelta)), TRANSCRIPT_TEXT_MAX, 'long tool input')
    if (event.input !== undefined) line.input = clip(readable(rt.redactDeepSecrets(event.input)), TRANSCRIPT_TEXT_MAX, 'long tool input')
    if (event.outputText !== undefined) line.output = clip(readable(rt.redactDeepSecrets(String(event.outputText)), event.name === 'imageGeneration'), TRANSCRIPT_TEXT_MAX, 'long tool output')
    if (event.outputDelta !== undefined) line.output = clip(rt.redactDeepSecrets((line.output ?? '') + String(event.outputDelta)), TRANSCRIPT_TEXT_MAX, 'long tool output')
    if (event.output !== undefined) line.output = clip(readable(rt.redactDeepSecrets(event.output), event.name === 'imageGeneration'), TRANSCRIPT_TEXT_MAX, 'long tool output')
    if (event.progress !== undefined) {
      const progress = normalizeProgress(rt.redactDeepSecrets(event.progress))
      if (progress) line.progress = progress
    }
  }
  // The one event sink every driver of this plugin reports through (drivers.js).
  // One handler per event type; dispatch only arms the idle watchdog and
  // forwards. Handlers drop events that cannot belong to the active turn.
  const sinkSession = (sessionId, st, event) => {
    if (event.state === 'closed') { say(sessionId, { who: 'system', kind: 'note', text: 'engine session closed' }) }
    else if (event.state === 'ready') void rt.flushLeadReports?.(sessionId)
  }

  const sinkTurnStart = (sessionId, st, event) => {
    if (!st.active && !st.starting && st.cancelledStart && !rt.isCompacting(sessionId)) {
      st.endedTurn = event.turnId == null ? null : String(event.turnId)
      return
    }
    st.cancelledStart = false
    st.active = true
    st.starting = false
    st.turnId = event.turnId ?? null
    if (st.decisionInput) rt.decisionInputStarted?.(sessionId, st.decisionInput.origin, st.turnId, st.decisionInput.accepted)
    bindTurn(st, st.seq, st.turnId)
    st.messages = null
    st.lifecycles = new Map()
    // A plan that raced in before this turn's start owns the row already;
    // anything else is the previous turn's history, not this row.
    if (st.planTurn === null || String(st.planTurn) !== String(event.turnId ?? '')) { st.planLine = null; st.planLines = new Map() }
    st.planTurn = null
    st.tools = new Map()
    st.closedTools = new Set()
    st.records ??= rt.newStreamRun?.(sessionId)
    st.recordWrites = Promise.resolve()
    armIdle(sessionId, st)
  }

  const sinkText = (sessionId, st, event) => {
    if (foreign(st, event)) return
    if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
    messagesOf(sessionId, st).accept(event)
    if (typeof event.text === 'string' && event.text !== '') rt.statsOutput(sessionId)
  }

  const sinkChanges = (sessionId, st, event) => {
    if (foreign(st, event) || st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
    closeMessages(st)
    const tool = changesTool(event)
    st.records ??= rt.newStreamRun?.(sessionId)
    const record = tool && st.records?.accept(tool)
    if (!record) { say(sessionId, { who: 'agent', kind: 'note', text: tool.output }); return }
    const line = say(sessionId, { who: 'agent', kind: 'changes', text: tool.output, presentation: previewRecord(record) })
    if (line) saveRecord(sessionId, st, line, record)
  }

  const sinkPlan = (sessionId, st, event) => {
    // Snapshots replace only the same source plan; unidentified plans use
    // the turn's default plan slot.
    if (foreign(st, event)) return
    if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
    closeMessages(st)
    const entityId = typeof event.entityId === 'string' && event.entityId !== '' ? event.entityId : undefined
    st.planLines ??= new Map()
    const prior = entityId ? st.planLines.get(entityId) : st.planLine
    const steps = (Array.isArray(event.steps) ? event.steps : []).slice(0, 50)
      .map(step => ({ text: clip(rt.redactDeepSecrets(String(step?.text ?? '')), 500, 'long plan step'), status: ['pending', 'in_progress', 'completed'].includes(step?.status) ? step.status : 'pending' }))
      .filter(step => step.text !== '')
    const removed = event.removed === true || (Array.isArray(event.steps) && steps.length === 0)
    const text = clip(rt.redactDeepSecrets(String(event.explanation ?? event.text ?? event.title ?? '')), TRANSCRIPT_TEXT_MAX, 'long plan')
    if (prior) {
      Object.assign(prior, removed ? { steps: [], text: '', removed: true } : { steps, text, removed: false })
      rt.touchLine?.(sessionId, prior)
    } else if (!removed) {
      const line = rt.appendLine(sessionId, { who: 'agent', kind: 'plan', text, steps,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}), ...(entityId ? { entityId } : {}) })
      if (entityId) st.planLines.set(entityId, line)
      else st.planLine = line
      st.planTurn = event.turnId !== undefined ? String(event.turnId) : null
    }
    void rt.save(true).catch(() => {})
  }

  const sinkActivity = (sessionId, st, event) => {
    // One subagent/member row reuses the tool-row machinery (callId pairing,
    // running merge) without becoming a tool record or a second execution.
    if (foreign(st, event)) return
    if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
    if (event.entityId === undefined || event.entityId === null || event.entityId === '') return
    closeMessages(st)
    // A name rides only when the source sent one (or on the row-opening
    // start), so an update never renames the merged row. The source's own
    // ids (parent run, child session, tool call) stay on the row.
    return driverSink(sessionId, { type: 'tool', turnId: event.turnId, callId: String(event.entityId),
      phase: ['start', 'update', 'end'].includes(event.phase) ? event.phase : 'update',
      ...(event.name !== undefined || event.phase === 'start' ? { name: String(event.name ?? 'subagent') } : {}),
      brief: event.title, output: event.detail,
      ...(event.parentId !== undefined ? { parentCallId: String(event.parentId) } : {}),
      ...(event.childId !== undefined ? { childId: String(event.childId) } : {}),
      ...(event.toolCallId !== undefined ? { toolCallId: String(event.toolCallId) } : {}),
      isError: event.isError === true, noRecord: true })
  }

  const sinkLifecycle = (sessionId, st, event) => {
    if (!foreign(st, event) && !st.finishing && (st.active || st.starting || event.turnId === undefined)) {
      closeMessages(st)
      const line = say(sessionId, { who: 'system', kind: 'lifecycle', event: event.kind, phase: event.phase,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
        ...(event.detail ? { text: clip(rt.redactDeepSecrets(String(event.detail)), 2000, 'long lifecycle detail') } : {}), ...(event.isError ? { isError: true } : {}), ...(event.cancelled ? { cancelled: true } : {}) })
      if (event.turnId !== undefined || event.kind === 'retry') {
        st.lifecycles ??= new Map()
        const key = JSON.stringify([event.kind, event.entityId ?? null])
        if (event.phase === 'start') st.lifecycles.set(key, line)
        else st.lifecycles.delete(key)
      }
    }
  }

  const sinkTool = (sessionId, st, event) => {
    // A missing or foreign turnId proves nothing about the active turn, so
    // it cannot be matched by name or by the single open pending tool.
    if (foreign(st, event)) return
    // Late events after turn/end must not revive a finished operation. A
    // driver event always names its turn; legacy fixtures without one keep
    // the old direct-sink behaviour.
    if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
    closeMessages(st)
    const phase = event.phase === 'end' ? 'end' : event.phase === 'update' ? 'update' : 'start'
    const key = event.callId === undefined ? null : String(event.callId)
    // A call id that already reached its end stays terminal until the next
    // turn starts, even if the source repeats a start or a second end.
    if (key !== null && phase !== 'update' && st.closedTools.has(key)) return
    st.records ??= rt.newStreamRun?.(sessionId)
    const foldTool = line => {
      applyToolFields(line, event)
      const record = event.noRecord ? null : st.records?.accept(event)
      if (record) line.presentation = previewRecord(record)
      rt.touchLine?.(sessionId, line)
    }
    if (phase === 'update') {
      const line = key === null ? null : st.tools.get(key)
      // An update without a started identity is not attached to a guess.
      if (!line) return
      foldTool(line)
      return
    }
    const repeated = phase === 'start' && key !== null && st.tools.has(key)
    if (repeated) {
      // A repeated start is the same execution, not a second tool.
      foldTool(st.tools.get(key))
      return
    }
    // An activity row is a status, not an execution: it never counts as a
    // tool step nor opens a tool-time span.
    if (event.noRecord !== true) rt.statsTool(sessionId, phase === 'end' ? 'end' : 'start')
    const record = event.noRecord ? null : st.records?.accept(event)
    const line = say(sessionId, {
      who: 'agent', kind: 'tool', name: String(event.name ?? 'tool'), phase, timeline: true,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.noRecord === true ? { activity: true } : {}),
      ...(key !== null ? { callId: key } : {}),
      ...(event.parentCallId !== undefined ? { parentCallId: String(event.parentCallId) } : {}),
      ...(event.childId !== undefined ? { childId: String(event.childId) } : {}),
      ...(event.toolCallId !== undefined ? { toolCallId: String(event.toolCallId) } : {}),
      ...(event.input !== undefined || event.inputText !== undefined ? { input: clip(readable(rt.redactDeepSecrets(event.input ?? event.inputText)), TRANSCRIPT_TEXT_MAX, 'long tool input') } : {}),
      ...(event.output !== undefined || event.outputText !== undefined ? { output: clip(readable(rt.redactDeepSecrets(event.output ?? event.outputText), event.name === 'imageGeneration'), TRANSCRIPT_TEXT_MAX, 'long tool output') } : {}),
      ...(event.progress !== undefined ? { progress: normalizeProgress(rt.redactDeepSecrets(event.progress)) } : {}),
      ...(typeof event.brief === 'string' && event.brief !== '' ? { brief: clip(rt.redactDeepSecrets(event.brief), 2000, 'long tool output') } : {}),
      isError: event.isError === true,
      ...(record ? { presentation: previewRecord(record) } : {}),
    })
    if (phase === 'start' && key !== null) st.tools.set(key, line)
    if (phase === 'end' && key !== null) { st.tools.delete(key); st.closedTools.add(key) }
    if (record && phase === 'end' && line) {
      saveRecord(sessionId, st, line, record)
    }
    st.toolOpen = phase === 'end' ? null : String(event.name ?? 'tool')
  }

  const sinkRequestOpened = (sessionId, st, event) => {
    if (st.requests?.has(event.id)) return
    closeMessages(st)
    let request
    if (st.active || st.starting) {
      st.requests ??= new Map()
      request = { kind: event.kind, turnId: st.turnId }
      st.requests.set(event.id, request)
      say(sessionId, { who: 'system', kind: 'request', requestId: event.id, requestKind: event.kind, phase: 'start',
        ...(st.turnId !== null ? { turnId: st.turnId } : {}), text: clip(rt.redactDeepSecrets(String(event.reason ?? event.tool ?? '')), 2000, 'long request') })
    }
    rt.openApproval(sessionId, event, request ? async reply => {
      settleRequest(sessionId, st, event.id, request)
      const questions = Array.isArray(event.detail?.questions) ? event.detail.questions.slice(0, 50)
        .filter(question => typeof question?.id === 'string')
        .map(question => ({ id: question.id.slice(0, 200), label: String(question.header ?? question.question ?? question.id).slice(0, 2000) })) : []
      if (request.line) {
        delete request.line.cancelled
        request.line.response = rt.redactDeepSecrets({ ...reply,
          ...(questions.length > 1 && JSON.stringify(questions).length <= 4000 ? { questions } : {}) })
        rt.touchLine?.(sessionId, request.line)
      }
      if (st.requests.get(event.id) === request) st.requests.delete(event.id)
      await rt.save(true)
    } : undefined)
    if (!foreign(st, event)) armIdle(sessionId, st)
  }

  const sinkRequestClosed = (sessionId, st, event) => {
    if (st.requests?.has(event.id)) {
      const request = st.requests.get(event.id)
      settleRequest(sessionId, st, event.id, request, event.cancelled === true)
      st.requests.delete(event.id)
    }
    rt.closeApproval(event.id)
    void rt.flushLeadReports?.(sessionId)
    if (!foreign(st, event)) armIdle(sessionId, st)
  }

  const sinkNote = (sessionId, st, event) => {
    closeMessages(st)
    if (typeof event.text === 'string' && event.text) say(sessionId, { who: 'system', kind: 'note', text: event.text })
  }

  const sinkTurnEnd = (sessionId, st, event) => {
    if ((!st.active && !st.starting) || st.finishing || foreign(st, event)) return
    if (event.reason === 'error' && event.errorKind === 'resume-failed' && st.resume && rt.conversationOf(sessionId)?.session.driverSessionId) {
      const resume = st.resume
      st.resume = null
      clearTimeout(st.cancelTimer)
      st.cancelTimer = null
      disarmIdle(st)
      resume()
      return
    }
    st.resume = null
    if (event.reason === 'error' || event.reason === 'interrupted') st.decisionInput?.reject(failure('答案轮次尚未确认发送就已结束', 'orch/cancelled'))
    clearTimeout(st.cancelTimer)
    st.cancelTimer = null
    st.finishing = true
    const ended = st.turnId ?? event.turnId
    if (ended !== undefined && ended !== null) st.endedTurn = String(ended)
    for (const [id, request] of st.requests ?? []) {
      settleRequest(sessionId, st, id, request, event.reason === 'interrupted')
      rt.closeApproval(id)
    }
    st.requests?.clear()
    for (const line of st.lifecycles?.values() ?? []) {
      say(sessionId, { who: 'system', kind: 'lifecycle', event: line.event, phase: 'end',
        ...(line.entityId !== undefined ? { entityId: line.entityId } : {}), ...(ended != null ? { turnId: ended } : {}),
        ...(event.reason === 'interrupted' ? { cancelled: true } : {}), ...(event.reason === 'error' ? { isError: true } : {}) })
    }
    st.lifecycles?.clear()
    for (const record of st.records?.close(event.reason === 'interrupted' ? 'interrupted' : 'unknown') ?? []) {
      const line = say(sessionId, { who: 'agent', kind: 'tool', name: record.title, callId: record.entityId, phase: 'end',
        timeline: true, ...(ended != null ? { turnId: ended } : {}),
        isError: true, brief: 'Agent 未确认执行结果', presentation: previewRecord(record) })
      if (line) saveRecord(sessionId, st, line, record)
    }
    const seq = st.seq
    const finalText = typeof event.text === 'string' && event.text.trim() ? event.text : undefined
    const final = finalText ? { final: finalText, ...(event.reason !== 'done' || event.unconfirmed ? { finalCapture: 'partial' } : {}) } : {}
    const replyLines = messagesOf(sessionId, st).finish(event.reason, event.text)
    const reply = replyLines.find(line => line.reply)
    const session = rt.conversationOf?.(sessionId)?.session
    const replyId = session?.engine === 'dsh' ? reply?.messageId : reply ? (reply.replyId ??= randomUUID()) : undefined
    rt.leadEnded?.(sessionId, { ...event, ...final, replyId })?.catch(error => rt.warn('nodo: late execution result failed (%s): %s', sessionId, error.message ?? error))
    const flushed = st.messages.text()
    rt.recordTaskOutcome(sessionId, st.task, event.reason, event.text || flushed)
    st.task = null
    for (const line of replyLines) {
      if (rt.saveReplyImages) st.recordWrites = Promise.resolve(st.recordWrites).then(async () => {
        const images = await rt.saveReplyImages(sessionId, line.text)
        if (images.length) { line.images = images; rt.touchLine?.(sessionId, line) }
      }).catch(() => rt.warn?.('nodo: reply images could not be persisted'))
    }
    if (event.reason === 'error' && typeof event.error === 'string') {
      say(sessionId, { who: 'agent', kind: 'error', text: rt.redactDeepSecrets(String(event.error)).slice(0, 2000) })
    }
    // An end without usage keeps the figures the turn reported live.
    const usage = event.usage ?? rt.statsLive(sessionId)
    if (usage !== undefined) {
      say(sessionId, { who: 'system', kind: 'usage', usage })
    }
    rt.statsEnd(sessionId, usage, event.timing)
    closeMessages(st)
    disarmIdle(st)
    const finish = reason => {
      st.active = false
      st.starting = false
      st.finishing = false
      st.records = null
      st.planLine = null
      st.planLines = new Map()
      st.planTurn = null
      st.tools = new Map()
      st.closedTools = new Set()
      st.turnId = null
      st.startedAt = null
      const unconfirmed = event.unconfirmed === true ? { unconfirmed: true } : {}
      // `final` is the engine's own last message of the turn; `text` stays the whole turn.
      const reply = replyId ? { replyId } : {}
      const retryable = reason === 'error' && event.retryable === true ? { retryable: true } : {}
      const refusal = event.code === 'orch/decision-pending' ? { code: event.code } : {}
      settle(st, seq, { reason, text: flushed !== '' ? flushed : final.final, ...final, ...unconfirmed, ...reply, ...retryable, ...refusal })
      st.ended = { seq, outcome: { reason, text: flushed, ...final, ...unconfirmed, ...reply, ...retryable, ...refusal } }
      for (const joined of st.joined.splice(0)) settle(st, joined, st.ended.outcome)
      drain(sessionId, st)
      void rt.flushLeadReports?.(sessionId)
      rt.notifyLive?.()
    }
    void Promise.resolve(st.recordWrites).then(() => rt.saveRuntime(sessionId)).then(() => finish(event.reason), () => {
      rt.appendLine(sessionId, { who: 'agent', kind: 'error', text: 'Task finished, but its saved context could not be persisted.' })
      finish('error')
    })
  }

  const SINKS = {
    session: sinkSession,
    'turn/start': sinkTurnStart,
    thinking: sinkText, delta: sinkText, text: sinkText,
    changes: sinkChanges, plan: sinkPlan, activity: sinkActivity, lifecycle: sinkLifecycle, tool: sinkTool,
    'request/opened': sinkRequestOpened, 'request/closed': sinkRequestClosed, note: sinkNote, 'turn/end': sinkTurnEnd,
    usage: (sessionId, st, event) => { if (!foreign(st, event) && rt.statsUsage(sessionId, event.usage)) rt.notifyLive?.() },
  }
  const driverSink = (sessionId, event) => {
    const st = stateOf(sessionId)
    if (event && event.type !== 'session' && event.type !== 'turn/start' && event.type !== 'turn/end' && !foreign(st, event) && (st.active || st.starting)) {
      armIdle(sessionId, st, event.kind === 'retry' && event.phase === 'start' ? RETRY_IDLE_TIMEOUT_MS : TURN_IDLE_TIMEOUT_MS)
    }
    if (event && Object.hasOwn(SINKS, event.type)) SINKS[event.type](sessionId, st, event)
  }
  return { driverSink }
}
