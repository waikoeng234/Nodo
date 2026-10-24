// Dispatch: how a message reaches a profile's engine, and how engine events come
// back. A message that arrives mid-turn tries to steer the running turn and then
// settles with it; when the engine refuses, the message queues and becomes a turn
// of its own once the current one ends. A steer the engine did not confirm in time
// joins the turn too: it may already be inside, and sending it again could do the
// work twice.
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX, TURN_IDLE_TIMEOUT_MS, UNCONFIRMED_STEER } from './constants.js'
import { clip } from './text.js'
import { projectContent } from './resources.js'
import { changesTool, normalizeProgress, planObservation, previewRecord } from './stream-records.js'

const readable = (value, imageOutput = false) => projectContent(value, imageOutput).text

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {starting:boolean, active:boolean, turnId:?string, seq:number, buffer:string, toolOpen:string|null, queued:{text:string, images:object[], seq:number, resolve:Function}[], waiters:{seq:number, resolve:Function}[], binds:{seq:number, resolve:Function}[], idleTimer:?Object}>} */
  const turns = new Map()
  const stateOf = (profileId) => {
    let entry = turns.get(profileId)
    if (entry === undefined) {
      entry = { starting: false, active: false, finishing: false, turnId: null, endedTurn: null, startedAt: null, task: null, seq: 0, nextSeq: 0, joined: [], buffer: '', think: '', thinkLine: null, planLine: null, planTurn: null, toolOpen: null, tools: new Map(), closedTools: new Set(), queued: [], waiters: [], binds: [], idleTimer: null, watched: true }
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

  // Drivers emit new reasoning text; the next output or tool closes its row.
  const openThink = (profileId, st, text) => {
    if (st.think.length <= TRANSCRIPT_TEXT_MAX) st.think += text
    const body = clip(rt.redactDeepSecrets(st.think), TRANSCRIPT_TEXT_MAX, 'long reasoning')
    if (st.thinkLine !== null) {
      st.thinkLine.text = body
      st.thinkLine.at = Date.now()
    } else {
      st.thinkLine = rt.appendLine(profileId, { who: 'agent', kind: 'thinking', text: body, open: true })
    }
    void rt.save().catch(() => {})
  }
  const closeThink = (st) => {
    if (st.thinkLine === null) return
    st.thinkLine.open = false
    st.thinkLine = null
    st.think = ''
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
        st.think = ''
        st.thinkLine = null
        // A plan that raced in before this turn's start owns the row already;
        // anything else is the previous turn's history, not this row.
        if (st.planTurn === null || String(st.planTurn) !== String(event.turnId ?? '')) st.planLine = null
        st.planTurn = null
        st.tools = new Map()
        st.closedTools = new Set()
        st.records ??= rt.newStreamRun?.(profileId)
        st.recordWrites = Promise.resolve()
        armIdle(profileId, st)
        return
      case 'thinking':
        if (foreign(st, event) || st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        if (typeof event.text === 'string' && event.text !== '') {
          rt.statsOutput(profileId)
          openThink(profileId, st, event.text)
          armIdle(profileId, st)
        }
        return
      case 'delta':
      case 'text':
        if (foreign(st, event)) return
        if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        closeThink(st)
        if (typeof event.text === 'string' && event.text !== '') {
          rt.statsOutput(profileId)
          st.buffer = event.type === 'delta' ? st.buffer + event.text : st.buffer === '' ? event.text : `${st.buffer}\n${event.text}`
          armIdle(profileId, st)
        }
        return
      case 'changes': {
        const tool = changesTool(event)
        st.records ??= rt.newStreamRun?.(profileId)
        const record = tool && st.records?.accept(tool)
        if (!record) { say(profileId, { who: 'agent', kind: 'note', text: tool.output }); return }
        const line = say(profileId, { who: 'agent', kind: 'changes', text: tool.output, presentation: previewRecord(record) })
        if (line) saveRecord(profileId, st, line, record)
        return
      }
      case 'plan': {
        // A plan update is the whole plan: it replaces the turn's one plan row
        // instead of appending another transcript line, so restore never
        // duplicates and a replaced plan leaves no stale steps behind.
        if (foreign(st, event)) return
        if (st.finishing || (!st.active && !st.starting && event.turnId !== undefined)) return
        closeThink(st)
        const steps = (Array.isArray(event.steps) ? event.steps : []).slice(0, 50)
          .map(step => ({ text: clip(rt.redactDeepSecrets(String(step?.text ?? '')), 500, 'long plan step'), status: ['pending', 'in_progress', 'completed'].includes(step?.status) ? step.status : 'pending' }))
          .filter(step => step.text !== '')
        const removed = event.removed === true || (Array.isArray(event.steps) && steps.length === 0)
        const text = clip(rt.redactDeepSecrets(String(event.explanation ?? event.text ?? event.title ?? '')), TRANSCRIPT_TEXT_MAX, 'long plan')
        if (st.planLine) {
          Object.assign(st.planLine, removed ? { steps: [], text: '', removed: true } : { steps, text, removed: false, at: Date.now() })
        } else if (!removed) {
          st.planLine = rt.appendLine(profileId, { who: 'agent', kind: 'plan', text, steps })
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
        closeThink(st)
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
        // Retry waits and compaction ride the running animation, not transcript
        // lines; they still count as engine liveness for the idle watchdog.
        if (event.turnId === undefined || st.turnId === null || String(event.turnId) === String(st.turnId)) armIdle(profileId, st)
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
        closeThink(st)
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
          who: 'agent', kind: 'tool', name: String(event.name ?? 'tool'), phase,
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
      case 'request/opened':
        closeThink(st)
        rt.openApproval(profileId, event)
        armIdle(profileId, st)
        return
      case 'request/closed':
        rt.closeApproval(event.id)
        armIdle(profileId, st)
        return
      case 'note':
        if (typeof event.text === 'string' && event.text) say(profileId, { who: 'system', kind: 'note', text: event.text })
        armIdle(profileId, st)
        return
      case 'turn/end': {
        if (st.finishing || foreign(st, event)) return
        st.finishing = true
        const ended = st.turnId ?? event.turnId
        if (ended !== undefined && ended !== null) st.endedTurn = String(ended)
        for (const record of st.records?.close(event.reason === 'interrupted' ? 'interrupted' : 'unknown') ?? []) {
          const line = say(profileId, { who: 'agent', kind: 'tool', name: record.title, callId: record.entityId, phase: 'end',
            isError: true, brief: 'Agent 未确认执行结果', presentation: previewRecord(record) })
          if (line) saveRecord(profileId, st, line, record)
        }
        const seq = st.seq
        const flushed = st.buffer
        rt.recordTaskOutcome(profileId, st.task, event.reason, flushed || event.text)
        st.task = null
        if (flushed !== '') {
          const final = typeof event.text === 'string' && event.text.trim() !== '' && event.text !== flushed ? event.text : undefined
          const line = say(profileId, { who: 'agent', kind: 'text', text: clip(rt.redactDeepSecrets(flushed), TRANSCRIPT_TEXT_MAX, 'long reply'), reason: event.reason,
            ...(final !== undefined ? { final: clip(rt.redactDeepSecrets(final), TRANSCRIPT_TEXT_MAX, 'long reply') } : {}) })
          if (line && rt.saveReplyImages) st.recordWrites = Promise.resolve(st.recordWrites).then(async () => {
            const images = await rt.saveReplyImages(profileId, line.text)
            if (images.length) line.images = images
          }).catch(() => rt.warn?.('nodo: reply images could not be persisted'))
          st.buffer = ''
        }
        if (event.reason === 'error' && typeof event.error === 'string') {
          say(profileId, { who: 'agent', kind: 'error', text: rt.redactDeepSecrets(String(event.error)).slice(0, 2000) })
        }
        if (event.usage !== undefined) {
          say(profileId, { who: 'system', kind: 'usage', usage: event.usage })
        }
        rt.statsEnd(profileId, event.usage, event.timing)
        closeThink(st)
        disarmIdle(st)
        const finish = reason => {
          st.active = false
          st.starting = false
          st.finishing = false
          st.records = null
          st.planLine = null
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
  const armIdle = (profileId, st) => {
    disarmIdle(st)
    if (st.finishing || (!st.active && !st.starting) || !st.watched || rt.awaitingAnswer?.(profileId)) return
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null
      driverSink(profileId, { type: 'turn/end', reason: 'error', error: `no engine activity for ${TURN_IDLE_TIMEOUT_MS / 1000}s; the turn was failed`, unconfirmed: true })
      void rt.interruptDriver?.(profileId)
    }, TURN_IDLE_TIMEOUT_MS)
    st.idleTimer.unref?.()
  }
  const disarmIdle = (st) => {
    if (st.idleTimer !== null) {
      clearTimeout(st.idleTimer)
      st.idleTimer = null
    }
  }

  const drain = (profileId, st) => {
    if (st.active || st.starting || st.finishing || rt.isCompacting(profileId) || st.queued.length === 0) return
    const next = st.queued.shift()
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
        if (instructionMode === 'none' && session.instructionMode !== 'none') say(profileId, { who: 'system', kind: 'note', text: '当前 Agent 没有原生角色身份通道，本会话不带角色身份运行。' })
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
  const send = async (profileId, rawText, sessionId, rawImages, references = [], handoff, { exclusive = false, files } = {}) => {
    const { session } = rt.conversation(profileId, sessionId)
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
      ? await rt.readReference({ id: ref.id, target: session.nativeSessionId ?? (session.engine === 'dsh' ? session.driverSessionId : session.id) })
      : await rt.sessionReference(ref))
    if (handoff) sources.push(...rt.redactDeepSecrets(handoff.artifacts))
    const input = handoff ? rt.renderHandoff({ ...handoff, task: text, artifacts: sources })
      : [rt.renderTask(text, sources), ...(files?.paths?.length ? rt.fileLines(files.paths) : [])].join('\n')
    if (!session.briefSent) {
      const named = rt.turnTitle(session.name, text, images)
      if (named !== session.name) {
        session.name = named
        delete session.draftedAt
        const twin = session.nativeSessionId ?? (session.engine === 'dsh' ? session.driverSessionId : null)
        if (twin && session.profileName) rt.renameHostSession?.(twin, `${session.profileName} · ${named}`)
      }
    }
    const refs = await rt.saveImages(images)
    refuseBusy()
    const st = stateOf(profileId)
    const seq = ++st.nextSeq
    const completion = new Promise(resolve => st.waiters.push({ seq, resolve }))
    const turn = new Promise(resolve => st.binds.push({ seq, resolve }))
    say(profileId, { who: 'user', kind: 'text', text, ...(sources.length ? { references: sources } : {}), ...(refs.length > 0 ? { images: refs } : {}),
      ...(files?.refs?.length > 0 ? { files: files.refs } : {}) })
    if (occupied(profileId, st)) {
      // SPI STEER values, as strings: the drivers package may be absent.
      const host = st.seq
      const outcome = images.length === 0 && !rt.isCompacting(profileId)
        ? await Promise.resolve().then(() => rt.driverOf(profileId)?.steer(input)).catch(() => undefined) : undefined
      if (outcome === 'steered' || outcome === 'indeterminate') {
        say(profileId, { who: 'system', kind: 'note', text: outcome === 'steered' ? 'steered into the running turn' : UNCONFIRMED_STEER })
        if (st.seq === host && occupied(profileId, st)) {
          st.task = [st.task, text].filter(Boolean).join('\n')
          st.joined.push(seq)
          bindTurn(st, seq, st.turnId)
        } else settle(st, seq, st.ended?.seq === host ? st.ended.outcome : { reason: 'done' })
        return { mode: outcome, seq, completion, turn }
      }
      st.queued.push({ text: input, task: text, images, seq, resolve: outcome => settle(st, seq, outcome) })
      // The turn may have ended while the engine answered; nothing else would start this one.
      drain(profileId, st)
      return { mode: 'queued', seq, completion, turn }
    }
    startTurn(profileId, st, input, seq, images, text)
    return { mode: 'turn', seq, completion, turn }
  }

  const interrupt = async (profileId, sessionId) => {
    profileId = rt.conversation(profileId, sessionId).session.id
    const st = stateOf(profileId)
    for (const queued of st.queued) queued.resolve({ reason: 'interrupted' })
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
    const view = Object.fromEntries([...turns.entries()].map(([profileId, st]) => [profileId, {
    active: st.active || st.starting || st.finishing || rt.isCompacting(profileId),
    tool: st.toolOpen,
    since: st.startedAt,
    buffer: st.buffer === '' ? null : clip(rt.redactDeepSecrets(st.buffer), 4000, 'live reply'),
    queued: st.queued.length,
    }]))
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

  Object.assign(rt, { driverSink, send, interrupt, workView, drainQueue: id => drain(id, stateOf(id)), rearmIdle: id => armIdle(id, stateOf(id)) })
}
