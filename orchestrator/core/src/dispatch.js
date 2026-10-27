// Dispatch: how a message reaches a profile's engine, and how engine events come
// back. A message that arrives mid-turn tries to steer the running turn and then
// settles with it; when the engine refuses, the message queues and becomes a turn
// of its own once the current one ends. A steer the engine did not confirm in time
// joins the turn too: it may already be inside, and sending it again could do the
// work twice.
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX, TURN_IDLE_TIMEOUT_MS, RETRY_IDLE_TIMEOUT_MS, UNCONFIRMED_STEER } from './constants.js'
import { clip } from './text.js'
import { projectContent } from './resources.js'
import { changesTool, normalizeProgress, planObservation, previewRecord } from './stream-records.js'
import { createMessageStream } from './message-stream.js'

const readable = (value, imageOutput = false) => projectContent(value, imageOutput).text

// Reason codes the zcode driver reports on instructionFallback when the role
// identity channel stays 'none'.
const IDENTITY_FALLBACK = {
  'unverified-version': '版本未经验证',
  'catalog-not-discovered': '等待角色工具目录超时',
  'mcp-config-not-representable': '角色服务未挂载',
  'mcp-field-unsupported': '角色服务未挂载',
}

export function install(rt) {
  const { ctx } = rt
  const settingsOf = (profile, session = profile) => JSON.stringify([session.model, session.thinking, session.permission ?? profile.permission])
  /** @type {Map<string, {starting:boolean, active:boolean, turnId:?string, seq:number, buffer:string, toolOpen:string|null, queued:{text:string, images:object[], seq:number, resolve:Function}[], waiters:{seq:number, resolve:Function}[], binds:{seq:number, resolve:Function}[], idleTimer:?Object}>} */
  const turns = new Map()
  const stateOf = (profileId) => {
    let entry = turns.get(profileId)
    if (entry === undefined) {
      entry = { starting: false, active: false, finishing: false, turnId: null, endedTurn: null, startedAt: null, task: null, seq: 0, nextSeq: 0, joined: [], buffer: '', messages: null, planLine: null, planTurn: null, toolOpen: null, tools: new Map(), closedTools: new Set(), queued: [], waiters: [], binds: [], idleTimer: null, watched: true }
      turns.set(profileId, entry)
    }
    return entry
  }

  const say = (profileId, line) => {
    const redacted = rt.redactDeepSecrets(line)
    const saved = rt.appendLine(profileId, redacted)
    void rt.save().catch(() => {})
    return saved
  }

  const messagesOf = (profileId, st) => st.messages ??= createMessageStream({
    append: line => rt.appendLine(profileId, line), redact: rt.redactDeepSecrets, head: rt.redactHead,
    save: () => { void rt.save().catch(() => {}) },
  })
  const closeMessages = st => st.messages?.close()

  const settleRequest = (profileId, st, id, request, cancelled = false) => {
    if (request.closed) return
    request.closed = true
    closeMessages(st)
    request.line = say(profileId, { who: 'system', kind: 'request', requestId: id, requestKind: request.kind, phase: 'end',
      ...(cancelled ? { cancelled: true } : {}),
      ...(request.turnId !== null ? { turnId: request.turnId } : {}) })
  }

  // A message's turn id is known only once its turn starts; it resolves null if
  // the message ends without one.
  const bindTurn = (st, seq, turnId) => {
    st.binds = st.binds.filter(bind => {
      if (bind.seq !== seq) return true
      bind.resolve(turnId)
      return false
    })
  }
  // Between turns the engine can still report the turn that ended here (watchdog,
  // unconfirmed stop); those events belong to no later turn.
  const foreign = (st, event) => event.turnId !== undefined
    && (st.turnId === null ? String(event.turnId) === st.endedTurn : String(event.turnId) !== String(st.turnId))
  const settle = (st, seq, outcome) => {
    bindTurn(st, seq, null)
    st.waiters = st.waiters.filter(waiter => {
      if (waiter.seq !== seq) return true
      waiter.resolve(outcome)
      return false
    })
  }

  const saveRecord = (profileId, st, line, record) => {
    st.recordWrites = Promise.resolve(st.recordWrites).then(async () => {
      line.presentation = await rt.saveStreamRecord(profileId, record)
      await rt.save()
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
  const driverSink = (profileId, event) => {
    const st = stateOf(profileId)
    switch (event?.type) {
      case 'session':
        if (event.state === 'closed') { say(profileId, { who: 'system', kind: 'note', text: 'engine session closed' }) }
        return
      case 'turn/start':
        st.active = true
        st.starting = false
        st.turnId = event.turnId ?? null
        bindTurn(st, st.seq, st.turnId)
        st.buffer = ''
        st.messages = null
        st.lifecycles = new Map()
        // A plan that raced in before this turn's start owns the row already;
        // anything else is the previous turn's history, not this row.
        if (st.planTurn === null || String(st.planTurn) !== String(event.turnId ?? '')) { st.planLine = null; st.planLines = new Map() }
        st.planTurn = null
        st.tools = new Map()
        st.closedTools = new Set()
        st.records ??= rt.newStreamRun?.(profileId)
        st.recordWrites = Promise.resolve()
        armIdle(profileId, st)
        return
      case 'thinking':
      case 'delta':
      case 'text':
        if (foreign(st, event)) return
        if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        messagesOf(profileId, st).accept(event)
        if (typeof event.text === 'string' && event.text !== '') rt.statsOutput(profileId)
        armIdle(profileId, st)
        return
      case 'changes': {
        if (foreign(st, event) || st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        closeMessages(st)
        const tool = changesTool(event)
        st.records ??= rt.newStreamRun?.(profileId)
        const record = tool && st.records?.accept(tool)
        if (!record) { say(profileId, { who: 'agent', kind: 'note', text: tool.output }); return }
        const line = say(profileId, { who: 'agent', kind: 'changes', text: tool.output, presentation: previewRecord(record) })
        if (line) saveRecord(profileId, st, line, record)
        return
      }
      case 'plan': {
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
        } else if (!removed) {
          const line = rt.appendLine(profileId, { who: 'agent', kind: 'plan', text, steps,
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}), ...(entityId ? { entityId } : {}) })
          if (entityId) st.planLines.set(entityId, line)
          else st.planLine = line
          st.planTurn = event.turnId !== undefined ? String(event.turnId) : null
        }
        void rt.save().catch(() => {})
        armIdle(profileId, st)
        return
      }
      case 'activity': {
        // One subagent/member row reuses the tool-row machinery (callId pairing,
        // running merge) without becoming a tool record or a second execution.
        if (foreign(st, event)) return
        if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        if (event.entityId === undefined || event.entityId === null || event.entityId === '') return
        closeMessages(st)
        // A name rides only when the source sent one (or on the row-opening
        // start), so an update never renames the merged row. The source's own
        // ids (parent run, child session, tool call) stay on the row.
        return driverSink(profileId, { type: 'tool', turnId: event.turnId, callId: String(event.entityId),
          phase: ['start', 'update', 'end'].includes(event.phase) ? event.phase : 'update',
          ...(event.name !== undefined || event.phase === 'start' ? { name: String(event.name ?? 'subagent') } : {}),
          brief: event.title, output: event.detail,
          ...(event.parentId !== undefined ? { parentCallId: String(event.parentId) } : {}),
          ...(event.childId !== undefined ? { childId: String(event.childId) } : {}),
          ...(event.toolCallId !== undefined ? { toolCallId: String(event.toolCallId) } : {}),
          isError: event.isError === true, noRecord: true })
      }
      case 'lifecycle':
        if (!foreign(st, event) && !st.finishing && (st.active || st.starting || event.turnId === undefined)) {
          closeMessages(st)
          const line = say(profileId, { who: 'system', kind: 'lifecycle', event: event.kind, phase: event.phase,
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
            ...(event.detail ? { text: clip(rt.redactDeepSecrets(String(event.detail)), 2000, 'long lifecycle detail') } : {}), ...(event.isError ? { isError: true } : {}), ...(event.cancelled ? { cancelled: true } : {}) })
          if (event.turnId !== undefined || event.kind === 'retry') {
            st.lifecycles ??= new Map()
            const key = JSON.stringify([event.kind, event.entityId ?? null])
            if (event.phase === 'start') st.lifecycles.set(key, line)
            else st.lifecycles.delete(key)
          }
          armIdle(profileId, st, event.kind === 'retry' && event.phase === 'start' ? RETRY_IDLE_TIMEOUT_MS : TURN_IDLE_TIMEOUT_MS)
        }
        return
      case 'tool':
      {
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
        st.records ??= rt.newStreamRun?.(profileId)
        if (phase === 'update') {
          const line = key === null ? null : st.tools.get(key)
          // An update without a started identity is not attached to a guess.
          if (!line) return
          applyToolFields(line, event)
          const record = event.noRecord ? null : st.records?.accept(event)
          if (record) line.presentation = previewRecord(record)
          armIdle(profileId, st)
          return
        }
        const repeated = phase === 'start' && key !== null && st.tools.has(key)
        if (repeated) {
          // A repeated start is the same execution, not a second tool.
          const line = st.tools.get(key)
          applyToolFields(line, event)
          const record = event.noRecord ? null : st.records?.accept(event)
          if (record) line.presentation = previewRecord(record)
          return
        }
        // An activity row is a status, not an execution: it never counts as a
        // tool step nor opens a tool-time span.
        if (event.noRecord !== true) rt.statsTool(profileId, phase === 'end' ? 'end' : 'start')
        const record = event.noRecord ? null : st.records?.accept(event)
        const line = say(profileId, {
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
          saveRecord(profileId, st, line, record)
        }
        st.toolOpen = phase === 'end' ? null : String(event.name ?? 'tool')
        armIdle(profileId, st)
        return
      }
      case 'request/opened': {
        if (st.requests?.has(event.id)) return
        closeMessages(st)
        let request
        if (st.active || st.starting) {
          st.requests ??= new Map()
          request = { kind: event.kind, turnId: st.turnId }
          st.requests.set(event.id, request)
          say(profileId, { who: 'system', kind: 'request', requestId: event.id, requestKind: event.kind, phase: 'start',
            ...(st.turnId !== null ? { turnId: st.turnId } : {}), text: clip(rt.redactDeepSecrets(String(event.reason ?? event.tool ?? '')), 2000, 'long request') })
        }
        rt.openApproval(profileId, event, request ? async reply => {
          settleRequest(profileId, st, event.id, request)
          const questions = Array.isArray(event.detail?.questions) ? event.detail.questions.slice(0, 50)
            .filter(question => typeof question?.id === 'string')
            .map(question => ({ id: question.id.slice(0, 200), label: String(question.header ?? question.question ?? question.id).slice(0, 2000) })) : []
          if (request.line) {
            delete request.line.cancelled
            request.line.response = rt.redactDeepSecrets({ ...reply,
              ...(questions.length > 1 && JSON.stringify(questions).length <= 4000 ? { questions } : {}) })
          }
          if (st.requests.get(event.id) === request) st.requests.delete(event.id)
          await rt.save()
        } : undefined)
        armIdle(profileId, st)
        return
      }
      case 'request/closed':
        if (st.requests?.has(event.id)) {
          const request = st.requests.get(event.id)
          settleRequest(profileId, st, event.id, request, event.cancelled === true)
          st.requests.delete(event.id)
        }
        rt.closeApproval(event.id)
        armIdle(profileId, st)
        return
      case 'note':
        closeMessages(st)
        if (typeof event.text === 'string' && event.text) say(profileId, { who: 'system', kind: 'note', text: event.text })
        armIdle(profileId, st)
        return
      case 'turn/end': {
        if (st.finishing || foreign(st, event)) return
        st.finishing = true
        const ended = st.turnId ?? event.turnId
        if (ended !== undefined && ended !== null) st.endedTurn = String(ended)
        for (const [id, request] of st.requests ?? []) {
          settleRequest(profileId, st, id, request, event.reason === 'interrupted')
          rt.closeApproval(id)
        }
        st.requests?.clear()
        for (const line of st.lifecycles?.values() ?? []) {
          say(profileId, { who: 'system', kind: 'lifecycle', event: line.event, phase: 'end',
            ...(line.entityId !== undefined ? { entityId: line.entityId } : {}), ...(ended != null ? { turnId: ended } : {}),
            ...(event.reason === 'interrupted' ? { cancelled: true } : {}), ...(event.reason === 'error' ? { isError: true } : {}) })
        }
        st.lifecycles?.clear()
        for (const record of st.records?.close(event.reason === 'interrupted' ? 'interrupted' : 'unknown') ?? []) {
          const line = say(profileId, { who: 'agent', kind: 'tool', name: record.title, callId: record.entityId, phase: 'end',
            timeline: true, ...(ended != null ? { turnId: ended } : {}),
            isError: true, brief: 'Agent 未确认执行结果', presentation: previewRecord(record) })
          if (line) saveRecord(profileId, st, line, record)
        }
        const seq = st.seq
        const replyLines = messagesOf(profileId, st).finish(event.reason, event.text)
        const flushed = st.messages.text()
        rt.recordTaskOutcome(profileId, st.task, event.reason, event.text || flushed)
        st.task = null
        for (const line of replyLines) {
          if (rt.saveReplyImages) st.recordWrites = Promise.resolve(st.recordWrites).then(async () => {
            const images = await rt.saveReplyImages(profileId, line.text)
            if (images.length) line.images = images
          }).catch(() => rt.warn?.('nodo: reply images could not be persisted'))
        }
        st.buffer = ''
        if (event.reason === 'error' && typeof event.error === 'string') {
          say(profileId, { who: 'agent', kind: 'error', text: rt.redactDeepSecrets(String(event.error)).slice(0, 2000) })
        }
        if (event.usage !== undefined) {
          say(profileId, { who: 'system', kind: 'usage', usage: event.usage })
        }
        rt.statsEnd(profileId, event.usage, event.timing)
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
          const final = typeof event.text === 'string' && event.text.trim() !== '' ? { final: event.text } : {}
          settle(st, seq, { reason, text: flushed !== '' ? flushed : final.final, ...final, ...unconfirmed })
          st.ended = { seq, outcome: { reason, text: flushed, ...final, ...unconfirmed } }
          for (const joined of st.joined.splice(0)) settle(st, joined, st.ended.outcome)
          drain(profileId, st)
        }
        void Promise.resolve(st.recordWrites).then(() => rt.save()).then(() => finish(event.reason), () => {
          rt.appendLine(profileId, { who: 'agent', kind: 'error', text: 'Task finished, but its saved context could not be persisted.' })
          finish('error')
        })
        return
      }
      default:
        return
    }
  }

  // A safety net for engines that die silently: a turn that shows no life for
  // TURN_IDLE_TIMEOUT_MS is failed rather than left hanging open. A driver with
  // `watchdog: false` reports only whole messages and its host owns liveness. A
  // card waiting on the user is not silence; the engine is stopped with the turn.
  const armIdle = (profileId, st, ms = TURN_IDLE_TIMEOUT_MS) => {
    disarmIdle(st)
    if (st.finishing || (!st.active && !st.starting) || !st.watched || rt.awaitingAnswer?.(profileId)) return
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null
      driverSink(profileId, { type: 'turn/end', reason: 'error', error: `no engine activity for ${ms / 1000}s; the turn was failed`, unconfirmed: true })
      void rt.interruptDriver?.(profileId)
    }, ms)
    st.idleTimer.unref?.()
  }
  const disarmIdle = (st) => {
    if (st.idleTimer !== null) {
      clearTimeout(st.idleTimer)
      st.idleTimer = null
    }
  }

  const drain = (profileId, st) => {
    if (st.active || st.starting || st.finishing || rt.isCompacting(profileId) || st.queued.length === 0 || st.queued[0].sending) return
    const next = st.queued.shift()
    if (next.pendingLine) say(profileId, next.pendingLine)
    startTurn(profileId, st, next.text, next.seq, next.images, next.task)
  }

  const startTurn = (profileId, st, text, seq, images, task = text) => {
    st.seq = seq
    st.task = task
    st.starting = true
    st.startedAt = Date.now()
    st.watched = true
    rt.statsRound(profileId)
    armIdle(profileId, st)
    void (async () => {
      if (!rt.conversationOf(profileId)) {
        driverSink(profileId, { type: 'turn/end', reason: 'error', error: 'the profile is gone' })
        return
      }
      let driver
      let restoreContext
      try {
        const profile = await rt.prepareConversation(profileId)
        st.settings = settingsOf(profile)
        driver = await rt.ensureDriver(profile)
        st.watched = driver.watchdog !== false
        if (!st.watched) disarmIdle(st)
        restoreContext = !driver.hasSession()
        await driver.openSession()
      } catch (error) {
        driverSink(profileId, { type: 'turn/end', reason: 'error', error: String(error?.message ?? error) })
        return
      }
      // The turn may have been interrupted while the engine was still spawning.
      if (!st.starting || st.seq !== seq) return settle(st, seq, { reason: 'interrupted' })
      let sent = false
      try {
        const { session } = rt.conversationOf(profileId)
        const message = restoreContext || session.restoreContext ? rt.renderRecovery(session, text) : text
        const instructionMode = driver.instructionMode === 'native' ? 'native' : 'none'
        if (instructionMode === 'none' && session.instructionMode !== 'none') {
          const reason = IDENTITY_FALLBACK[driver.instructionFallback]
          say(profileId, { who: 'system', kind: 'note', text: `当前 Agent 没有原生角色身份通道${reason ? `（${reason}）` : ''}，本会话不带角色身份运行。` })
        }
        session.instructionMode = instructionMode
        session.instructionTarget = instructionMode === 'native' ? driver.instructionTarget ?? 'engine' : undefined
        const briefSent = session.briefSent
        session.briefSent = true
        st.records = rt.newStreamRun?.(profileId)
        sent = true
        try { await driver.sendTurn(message, images) }
        catch (error) { session.briefSent = briefSent; throw error }
        session.restoreContext = false
        await rt.save()
      } catch (error) {
        // Once sendTurn is called the engine may already be working, so this end is unconfirmed;
        // an end the engine already reported stands.
        if (sent && (st.seq !== seq || (!st.active && !st.starting))) return
        driverSink(profileId, { type: 'turn/end', reason: 'error', error: String(error?.message ?? error), ...(sent ? { unconfirmed: true } : {}) })
      }
    })()
  }

  // One message to one profile. Returns how it was placed ('turn' | 'steered' |
  // 'indeterminate' | 'queued'), a completion that settles when this message's turn ends, and a
  // `turn` promise for the engine's turn id. `exclusive` refuses a busy session
  // instead of steering or queueing: a workflow task must not absorb a message
  // meant for another step.
  const occupied = (profileId, st) => st.starting || st.active || st.finishing || rt.isCompacting(profileId)
  const steer = async (profileId, st, item) => {
    const { profile, session } = rt.conversationOf(profileId)
    const host = st.seq
    const outcome = item.images.length === 0 && !rt.isCompacting(profileId) && st.settings === settingsOf(profile, session)
      ? await Promise.resolve().then(() => rt.driverOf(profileId)?.steer(item.text)).catch(() => undefined) : undefined
    if (outcome !== 'steered' && outcome !== 'indeterminate') return null
    if (item.cancelled) return outcome
    if (item.pendingLine) say(profileId, item.pendingLine)
    say(profileId, { who: 'system', kind: 'note', text: outcome === 'steered' ? 'steered into the running turn' : UNCONFIRMED_STEER })
    if (st.seq === host && occupied(profileId, st)) {
      st.task = [st.task, item.task].filter(Boolean).join('\n')
      st.joined.push(item.seq)
      bindTurn(st, item.seq, st.turnId)
    } else settle(st, item.seq, st.ended?.seq === host ? st.ended.outcome : { reason: 'done' })
    return outcome
  }
  const send = async (profileId, rawText, sessionId, rawImages, references = [], handoff, { exclusive = false, files, brief, queue = false } = {}) => {
    const { profile, session } = rt.conversation(profileId, sessionId)
    profileId = session.id
    const refuseBusy = () => { if (exclusive && occupied(profileId, stateOf(profileId))) throw Object.assign(new Error('The session is busy'), { code: 'orch/busy' }) }
    refuseBusy()
    const text = String(rawText ?? '').trim()
    if (text.length > TASK_TEXT_MAX) throw Object.assign(new Error(`Task exceeds ${TASK_TEXT_MAX} characters`), { code: 'orch/invalid' })
    const images = rt.admitImages(rawImages)
    if (text === '' && images.length === 0 && !handoff?.files?.length && !files?.paths?.length) throw Object.assign(new Error('Nothing to send'), { code: 'orch/invalid' })
    if (!Array.isArray(references) || references.length > 4) throw Object.assign(new Error('Choose at most four reference sessions'), { code: 'orch/invalid' })
    const sources = []
    for (const ref of references) sources.push(ref?.id
      ? await rt.readReference({ id: ref.id, target: session.engine === 'dsh' ? session.driverSessionId : session.id })
      : await rt.sessionReference(ref))
    if (handoff) sources.push(...rt.redactDeepSecrets(handoff.artifacts))
    const input = (brief ? `${brief}\n\n` : '') + (handoff ? rt.renderHandoff({ ...handoff, task: text, artifacts: sources })
      : [rt.renderTask(text, sources), ...(files?.paths?.length ? rt.fileLines(files.paths) : [])].join('\n'))
    if (!session.briefSent) {
      const named = rt.turnTitle(session.name, text, images)
      if (named !== session.name) {
        session.name = named
        delete session.draftedAt
        const twin = session.engine === 'dsh' ? session.driverSessionId : null
        if (twin && session.profileName) rt.renameHostSession?.(twin, `${session.profileName} · ${named}`)
      }
    }
    const refs = await rt.saveImages(images)
    refuseBusy()
    const st = stateOf(profileId)
    const seq = ++st.nextSeq
    const completion = new Promise(resolve => st.waiters.push({ seq, resolve }))
    const turn = new Promise(resolve => st.binds.push({ seq, resolve }))
    const line = { who: 'user', kind: 'text', text, ...(sources.length ? { references: sources } : {}), ...(refs.length > 0 ? { images: refs } : {}),
      ...(files?.refs?.length > 0 ? { files: files.refs } : {}) }
    const pendingLine = queue && occupied(profileId, st) ? line : undefined
    if (!pendingLine) say(profileId, line)
    if (occupied(profileId, st)) {
      const item = { text: input, task: text, images, seq, pendingLine, resolve: outcome => settle(st, seq, outcome) }
      const outcome = queue ? null : await steer(profileId, st, item)
      if (outcome) return { mode: outcome, seq, completion, turn }
      st.queued.push(item)
      // The turn may have ended while the engine answered; nothing else would start this one.
      drain(profileId, st)
      return { mode: 'queued', seq, completion, turn }
    }
    startTurn(profileId, st, input, seq, images, text)
    return { mode: 'turn', seq, completion, turn }
  }

  const queuedMessage = async (profileId, sessionId, seq, action) => {
    profileId = rt.conversation(profileId, sessionId).session.id
    const st = stateOf(profileId)
    const item = st.queued.find(item => item.seq === seq && item.pendingLine)
    if (!item) throw new Error('待发消息已发送或已移除')
    if (item.sending) throw new Error('消息正在发送，请稍后再试')
    if (action === 'edit' || action === 'delete') {
      st.queued.splice(st.queued.indexOf(item), 1)
      item.resolve({ reason: 'interrupted' })
      drain(profileId, st)
      return action === 'edit' ? { text: rt.redactDeepSecrets(item.task), images: item.images } : { mode: 'deleted' }
    }
    if (action !== 'send') throw Object.assign(new Error('Unknown queue action'), { code: 'orch/invalid' })
    if (!occupied(profileId, st)) {
      st.queued.splice(st.queued.indexOf(item), 1)
      say(profileId, item.pendingLine)
      startTurn(profileId, st, item.text, item.seq, item.images, item.task)
      return { mode: 'turn' }
    }
    item.sending = true
    try {
      const mode = occupied(profileId, st) ? await steer(profileId, st, item) : null
      if (mode && !item.cancelled) st.queued.splice(st.queued.indexOf(item), 1)
      return { mode: item.cancelled ? 'cancelled' : mode ?? 'queued' }
    } finally {
      item.sending = false
      drain(profileId, st)
    }
  }

  const interrupt = async (profileId, sessionId) => {
    profileId = rt.conversation(profileId, sessionId).session.id
    const st = stateOf(profileId)
    for (const queued of st.queued) { queued.cancelled = true; queued.resolve({ reason: 'interrupted' }) }
    st.queued.length = 0
    const seq = st.seq
    await rt.interruptDriver(profileId)
    if (st.starting && !st.active && st.seq === seq) {
      st.task = null
      st.starting = false
      void rt.save().catch(() => {})
      disarmIdle(st)
      settle(st, seq, { reason: 'interrupted', unconfirmed: true })
    }
    return true
  }

  // The live slice the client polls: what runs now and what waits.
  const workView = () => {
    const view = Object.fromEntries([...turns.entries()].map(([profileId, st]) => {
      const buffer = st.active || st.starting ? st.messages?.text() ?? st.buffer : ''
      return [profileId, {
        active: st.active || st.starting || st.finishing || rt.isCompacting(profileId),
        tool: st.toolOpen,
        since: st.startedAt,
        buffer: buffer === '' ? null : clip(rt.redactDeepSecrets(buffer), 4000, 'live reply'),
        timeline: st.messages != null,
        queued: st.queued.length,
        pending: st.queued.filter(item => item.pendingLine).map(item => ({ seq: item.seq,
          text: rt.redactDeepSecrets(item.task), images: item.pendingLine.images ?? [], sending: item.sending === true })),
      }]
    }))
    for (const profile of Object.values(rt.state.profiles)) {
      view[profile.id] ??= { active: false, since: null, buffer: null, queued: 0 }
      for (const session of rt.sessionsOf(profile)) {
        const local = view[session.id] ??= { active: rt.isCompacting(session.id), since: null, buffer: null, queued: 0 }
        const native = rt.nativeWork?.(session)
        if (native) view[session.id] = { ...local, ...native, active: local.active || native.active,
          status: native.active ? native.status : local.active ? 'running' : native.status,
          since: native.since ?? local.since, tool: native.tool ?? local.tool ?? null, buffer: local.buffer ?? native.buffer,
          queued: local.queued + native.queued }
      }
    }
    return view
  }

  ctx.effect(() => () => {
    for (const st of turns.values()) disarmIdle(st)
  }, 'nodo: dispatch idle timers')

  Object.assign(rt, { driverSink, send, queuedMessage, interrupt, workView, drainQueue: id => drain(id, stateOf(id)), rearmIdle: id => armIdle(id, stateOf(id)) })
}
