// Dispatch: how a message reaches a profile's engine, and how engine events come
// back. A message that arrives mid-turn tries to steer the running turn and then
// settles with it; when the engine refuses, the message queues and becomes a turn
// of its own once the current one ends. A steer the engine did not confirm in time
// joins the turn too: it may already be inside, and sending it again could do the
// work twice.
import { TASK_TEXT_MAX, TURN_IDLE_TIMEOUT_MS, RETRY_IDLE_TIMEOUT_MS, RUN_LIMITS, UNCONFIRMED_STEER } from './constants.js'
import { clip } from './text.js'
import { LEAD_ENGINES, leadModeOf } from '../shared/lead.js'
import { createMessageStream } from './message-stream.js'
import { failure, invalid } from './errors.js'
import { nativeIdOf } from '../shared/session.js'
import { createDispatchSinks } from './dispatch-sinks.js'

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
  /** @type {Map<string, {starting:boolean, active:boolean, finishing:boolean, suspect:boolean, cancelledStart:boolean, turnId:?string, seq:number, toolOpen:string|null, queued:{text:string, images:object[], seq:number, resolve:Function}[], waiters:{seq:number, resolve:Function}[], binds:{seq:number, resolve:Function}[], idleTimer:?Object, cancelTimer:?Object}>} */
  const turns = new Map()
  const stateOf = (sessionId) => {
    let entry = turns.get(sessionId)
    if (entry === undefined) {
      entry = { starting: false, active: false, finishing: false, suspect: false, cancelledStart: false, turnId: null, endedTurn: null, startedAt: null, task: null, seq: 0, nextSeq: 0, joined: [], messages: null, planLine: null, planTurn: null, toolOpen: null, tools: new Map(), closedTools: new Set(), queued: [], waiters: [], binds: [], idleTimer: null, cancelTimer: null, watched: true }
      turns.set(sessionId, entry)
    }
    return entry
  }

  const say = (sessionId, line) => {
    const redacted = rt.redactDeepSecrets(line)
    const saved = rt.appendLine(sessionId, redacted)
    void rt.save(true).catch(() => {})
    return saved
  }

  const messagesOf = (sessionId, st) => st.messages ??= createMessageStream({
    append: line => rt.appendLine(sessionId, line), redact: rt.redactDeepSecrets, head: rt.redactHead,
    save: () => { void rt.save(true).catch(() => {}) },
    touch: (...lines) => rt.touchLine?.(sessionId, ...lines),
  })
  const closeMessages = st => st.messages?.close()


  // A message's turn id is known only once its turn starts; it resolves null if
  // the message ends without one.
  const bindTurn = (st, seq, turnId) => {
    st.binds = st.binds.filter(bind => {
      if (bind.seq !== seq) return true
      bind.resolve(turnId)
      return false
    })
  }
  // Between turns the engine can still report the turn that ended here;
  // those events belong to no later turn.
  const settle = (st, seq, outcome) => {
    bindTurn(st, seq, null)
    st.waiters = st.waiters.filter(waiter => {
      if (waiter.seq !== seq) return true
      waiter.resolve(outcome)
      return false
    })
  }


  // A driver with `watchdog: false` leaves liveness to its host. Waiting on
  // a user card is not silence; idle turns only warn until their engine ends them.
  const armIdle = (sessionId, st, ms = TURN_IDLE_TIMEOUT_MS) => {
    disarmIdle(st)
    if (st.finishing || (!st.active && !st.starting) || !st.watched || rt.awaitingAnswer?.(sessionId)) return
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null
      st.suspect = true
      say(sessionId, { who: 'system', kind: 'note', text: `${ms / 1000} 秒未收到引擎活动，疑似卡住；仍在等待，可手动停止。` })
    }, ms)
    st.idleTimer.unref?.()
  }
  const disarmIdle = (st) => {
    st.suspect = false
    if (st.idleTimer !== null) {
      clearTimeout(st.idleTimer)
      st.idleTimer = null
    }
  }

  const drain = (sessionId, st) => {
    if (st.active || st.starting || st.finishing || rt.isCompacting(sessionId) || st.queued.length === 0 || st.queued[0].sending) return
    const next = st.queued.shift()
    if (next.pendingLine) Object.assign(next.pendingLine, say(sessionId, next.pendingLine))
    startTurn(sessionId, st, next.text, next.seq, next.images, next.task, next.onInput, next.origin)
  }

  const { driverSink } = createDispatchSinks(rt, { stateOf, say, messagesOf, closeMessages, bindTurn, settle, armIdle, disarmIdle, drain })

  const startTurn = (sessionId, st, text, seq, images, task = text, onInput, origin) => {
    if (leadModeOf(rt.conversationOf(sessionId)?.profile, rt.conversationOf(sessionId)?.session)) rt.clearPendingTrigger?.(sessionId)
    onInput?.()
    const decisionInput = origin?.kind === 'decision' ? { origin } : undefined
    if (decisionInput) {
      decisionInput.accepted = new Promise((resolve, reject) => { decisionInput.resolve = resolve; decisionInput.reject = reject })
      void decisionInput.accepted.catch(() => {})
    }
    st.decisionInput = decisionInput
    st.seq = seq
    st.task = task
    st.starting = true
    st.cancelledStart = false
    st.messages = null
    st.startedAt = Date.now()
    st.watched = true
    rt.statsRound(sessionId)
    armIdle(sessionId, st)
    let recoverySession
    const run = async () => {
      if (!rt.conversationOf(sessionId)) {
        driverSink(sessionId, { type: 'turn/end', reason: 'error', error: 'the profile is gone' })
        return
      }
      let driver
      let restoreContext
      try {
        const profile = await rt.prepareConversation(sessionId)
        st.settings = settingsOf(profile)
        driver = await rt.ensureDriver(profile)
        st.watched = driver.watchdog !== false
        if (!st.watched) disarmIdle(st)
        restoreContext = !driver.hasSession()
        await driver.openSession()
        if (origin?.kind === 'supplement' && (restoreContext || rt.conversationOf(sessionId)?.session.restoreContext)) {
          const restored = await rt.composeWorkerInput({ executionId: origin.executionId, upToTriggerId: origin.triggerId })
          text = restored.text
          images = restored.images
        }
        if (profile.engine === 'zcode' && origin?.executionId
          && ['mcp-field-unsupported', 'mcp-config-not-representable'].includes(driver.instructionFallback)) {
          const stage = rt.state.executions[origin.executionId].stage
          const fallback = rt.workerReportMethod({ stage, degraded: true })
          const method = rt.workerReportMethod({ stage })
          if (text.endsWith(method)) text = text.slice(0, -method.length) + fallback
          else if (origin.kind === 'supplement') {
            const instruction = '完成后用 nodo_report 回报。'
            const offset = text.lastIndexOf(instruction)
            if (offset >= 0) text = text.slice(0, offset) + fallback.slice('# 回报方式\n'.length) + text.slice(offset + instruction.length)
          }
        }
      } catch (error) {
        decisionInput?.reject(error)
        driverSink(sessionId, { type: 'turn/end', reason: 'error', error: String(error?.message ?? error), errorKind: error?.errorKind })
        return
      }
      // The turn may have been interrupted while the engine was still spawning.
      if (!st.starting || st.seq !== seq) {
        if (recoverySession) { delete recoverySession.restoreContext; await rt.saveRuntime() }
        return settle(st, seq, { reason: 'interrupted' })
      }
      if (st.cancelTimer !== null || st.finishing) {
        if (recoverySession) delete recoverySession.restoreContext
        st.cancelledStart = st.turnId === null
        driverSink(sessionId, { type: 'turn/end', reason: 'interrupted' })
        return
      }
      let sent = false
      try {
        const { session } = rt.conversationOf(sessionId)
        const snapshot = rt.leadSnapshot?.(sessionId)
        const input = snapshot ? `${text}\n\n${snapshot}` : text
        const goalCommand = session.engine !== 'codex' && typeof driver.goals === 'function' && /^\/goal\s/.test(text)
        const workerInput = ['delegation', 'supplement', 'retry'].includes(origin?.kind)
        const message = goalCommand ? text : !workerInput && (restoreContext || session.restoreContext) ? rt.renderRecovery(session, input) : input
        const instructionMode = driver.instructionMode === 'native' ? 'native' : 'none'
        if (instructionMode === 'none' && session.instructionMode !== 'none') {
          const reason = IDENTITY_FALLBACK[driver.instructionFallback]
          say(sessionId, { who: 'system', kind: 'note', text: `当前 Agent 没有原生角色身份通道${reason ? `（${reason}）` : ''}，本会话不带角色身份运行。` })
        }
        session.instructionMode = instructionMode
        session.instructionTarget = instructionMode === 'native' ? driver.instructionTarget ?? 'engine' : undefined
        if (origin?.kind === 'delegation' || origin?.kind === 'retry') rt.assertDecisionDispatch?.(session.source?.leadSessionId)
        const briefSent = session.briefSent
        if (!goalCommand) session.briefSent = true
        st.records = rt.newStreamRun?.(sessionId)
        sent = true
        try { await (goalCommand ? driver.goals(text === '/goal clear' ? null : text.slice(6)) : driver.sendTurn(message, images)) }
        catch (error) { session.briefSent = briefSent; throw error }
        decisionInput?.resolve()
        if (!goalCommand) session.restoreContext = false
        await (session.draftedAt ? rt.save() : rt.saveRuntime())
      } catch (error) {
        decisionInput?.reject(error)
        // Once sendTurn is called the engine may already be working, so this end is unconfirmed;
        // an end the engine already reported stands.
        if (sent && (st.seq !== seq || (!st.active && !st.starting))) return
        const decisionBlocked = !sent && error.code === 'orch/decision-pending'
        driverSink(sessionId, { type: 'turn/end', reason: decisionBlocked ? 'cancelled' : 'error', error: String(error?.message ?? error),
          errorKind: error?.errorKind, ...(decisionBlocked ? { code: error.code } : {}), ...(sent ? { unconfirmed: true } : {}) })
      }
    }
    st.resume = () => {
      const { profile, session } = rt.conversationOf(sessionId)
      const previousId = session.driverSessionId
      delete session.driverSessionId
      if (session.id === profile.id) delete profile.driverSessionId
      if (!session.restoreContext) recoverySession = session
      session.restoreContext = true
      st.finishing = true
      rt.releaseDriver(sessionId)
      st.finishing = false
      st.active = false
      st.starting = true
      st.turnId = null
      const text = leadModeOf(profile, session) ? '已更换后台上下文：旧引擎历史不再带入，任务与结果经 nodo_board 接续。' : '已更换后台上下文：旧引擎历史不再带入。'
      void Promise.resolve(rt.sessionNote?.(sessionId, `${text}（原引擎会话：${previousId}）`)).then(run)
        .catch(error => driverSink(sessionId, { type: 'turn/end', reason: 'error', error: String(error?.message ?? error) }))
    }
    void run()
  }

  // One message to one profile. Returns how it was placed ('turn' | 'steered' |
  // 'indeterminate' | 'queued'), a completion that settles when this message's turn ends, and a
  // `turn` promise for the engine's turn id. `exclusive` refuses a busy session
  // instead of steering or queueing so separate assignments cannot mix.
  const occupied = (sessionId, st) => st.starting || st.active || st.finishing || rt.isCompacting(sessionId)
  const steer = async (sessionId, st, item) => {
    const { profile, session } = rt.conversationOf(sessionId)
    const host = st.seq
    const outcome = item.images.length === 0 && !rt.isCompacting(sessionId) && st.settings === settingsOf(profile, session)
      ? await Promise.resolve().then(() => {
        const snapshot = rt.leadSnapshot?.(sessionId)
        return rt.driverOf(sessionId)?.steer(snapshot ? `${item.text}\n\n${snapshot}` : item.text)
      }).catch(() => undefined) : undefined
    if (outcome !== 'steered' && outcome !== 'indeterminate') return null
    if (item.cancelled) return outcome
    item.onInput?.()
    if (item.pendingLine) say(sessionId, item.pendingLine)
    say(sessionId, { who: 'system', kind: 'note', text: outcome === 'steered' ? 'steered into the running turn' : UNCONFIRMED_STEER })
    if (st.seq === host && occupied(sessionId, st)) {
      st.task = [st.task, item.task].filter(Boolean).join('\n')
      st.joined.push(item.seq)
      bindTurn(st, item.seq, st.turnId)
    } else settle(st, item.seq, st.ended?.seq === host ? st.ended.outcome : { reason: 'done' })
    return outcome
  }
  const send = async (profileRef, rawText, sessionRef, rawImages, references = [], { exclusive = false, files, brief, queue = false, origin, cancelled, userInput = false, limit } = {}) => {
    const { profile, session } = rt.conversation(profileRef, sessionRef)
    let structureChanged = session.id === profile.id && !profile.driverSessionId && rt.transcriptInfo(session.id).lines === 0
    rt.assertSessionWritable?.(profile, session)
    // createProfile and updateProfile keep new leads compliant; this catches
    // cards saved before the rules, which never migrate in place. The dedicated
    // code lets result delivery tell the executor why its report cannot land.
    // A 1:1 chat session runs like any executor: no lead engine or plan rules.
    if (leadModeOf(profile, session)) {
      if (!LEAD_ENGINES.includes(profile.engine)) throw failure(`主控「${profile.name}」的引擎 ${profile.engine} 暂不支持主控，请新建 ${LEAD_ENGINES.join('、')} 的主控角色`, 'orch/lead-invalid')
      if ((session.permission ?? profile.permission) === 'plan') throw failure(`主控「${profile.name}」是计划模式权限，请改成其他权限后再发送`, 'orch/lead-invalid')
    }
    const sessionId = session.id
    const refuseBusy = () => { if (exclusive && occupied(sessionId, stateOf(sessionId))) throw failure('The session is busy', 'orch/busy') }
    refuseBusy()
    const text = String(rawText ?? '').trim()
    const textLimit = limit ?? TASK_TEXT_MAX
    if (text.length > textLimit) throw invalid(`Task exceeds ${textLimit} characters`)
    const images = rt.admitImages(rawImages)
    if (text === '' && images.length === 0 && !files?.paths?.length) throw invalid('Nothing to send')
    if (!Array.isArray(references) || references.length > 4) throw invalid('Choose at most four reference sessions')
    const sources = []
    for (const ref of references) sources.push(ref?.id
      ? await rt.readReference({ id: ref.id, target: session.engine === 'dsh' ? session.driverSessionId : session.id })
      : await rt.sessionReference(ref))
    const workerInput = ['delegation', 'supplement', 'retry'].includes(origin?.kind)
    let input = (brief ? `${brief}\n\n` : '') + [rt.renderTask(text, sources), ...(!workerInput && files?.paths?.length ? rt.fileLines(files.paths) : [])].join('\n')
    if (!session.briefSent && !(session.engine === 'claude' && /^\/goal\s/.test(text))) {
      const named = rt.turnTitle(session.name, text, images)
      if (named !== session.name) {
        session.name = named
        delete session.draftedAt
        const twin = nativeIdOf(session)
        if (twin && session.profileName) rt.renameHostSession?.(twin, `${session.profileName} · ${named}`)
        structureChanged = true
      }
    }
    const refs = await rt.saveImages(images)
    rt.assertSessionWritable?.(profile, session)
    if (cancelled?.()) throw failure('Send cancelled', 'orch/cancelled')
    refuseBusy()
    const st = stateOf(sessionId)
    const line = { at: Date.now(), who: 'user', kind: 'text', text, ...(sources.length ? { references: sources } : {}), ...(refs.length > 0 ? { images: refs } : {}),
      ...(files?.refs?.length > 0 ? { files: files.refs } : {}), ...(origin ? { origin } : {}) }
    if (userInput && session.source?.kind === 'lead') {
      const flowInput = await rt.flowWorkerInput?.(session, line)
      if (flowInput?.placed) return flowInput.placed
      if (flowInput?.input) {
        input = flowInput.input.text
        origin = { kind: 'supplement', triggerId: flowInput.triggerId }
        line.origin = origin
        queue ||= flowInput.queue
      }
    }
    const leadFlight = userInput ? await rt.prepareLeadInput?.(session) : undefined
    const seq = ++st.nextSeq
    const leadMode = leadModeOf(profile, session)
    const onInput = userInput && leadMode ? () => rt.leadInputStarted?.(session.id, line) : undefined
    const completion = new Promise(resolve => st.waiters.push({ seq, resolve }))
    if (leadFlight) leadFlight.inputs.set(seq, completion)
    const turn = new Promise(resolve => st.binds.push({ seq, resolve }))
    const pendingLine = queue && occupied(sessionId, st) ? line : undefined
    if (!pendingLine) Object.assign(line, say(sessionId, line))
    if (structureChanged) await rt.save()
    if (occupied(sessionId, st)) {
      const item = { text: input, task: text, images, seq, pendingLine, onInput, origin, resolve: outcome => settle(st, seq, outcome) }
      const outcome = queue ? null : await steer(sessionId, st, item)
      if (outcome) return { mode: outcome, seq, completion, turn, leadFlight }
      st.queued.push(item)
      // The turn may have ended while the engine answered; nothing else would start this one.
      drain(sessionId, st)
      return { mode: 'queued', seq, completion, turn, leadFlight }
    }
    startTurn(sessionId, st, input, seq, images, text, onInput, origin)
    return { mode: 'turn', seq, completion, turn, leadFlight }
  }

  const queuedMessage = async (profileRef, sessionRef, seq, action) => {
    const sessionId = rt.conversation(profileRef, sessionRef).session.id
    const st = stateOf(sessionId)
    const item = st.queued.find(item => item.seq === seq && item.pendingLine)
    if (!item) throw new Error('待发消息已发送或已移除')
    if (item.sending) throw new Error('消息正在发送，请稍后再试')
    if (action === 'edit' || action === 'delete') {
      st.queued.splice(st.queued.indexOf(item), 1)
      item.resolve({ reason: 'interrupted', discarded: true })
      drain(sessionId, st)
      return action === 'edit' ? { text: rt.redactDeepSecrets(item.task), images: item.images } : { mode: 'deleted' }
    }
    if (action !== 'send') throw invalid('Unknown queue action')
    if (!occupied(sessionId, st)) {
      st.queued.splice(st.queued.indexOf(item), 1)
      Object.assign(item.pendingLine, say(sessionId, item.pendingLine))
      startTurn(sessionId, st, item.text, item.seq, item.images, item.task, item.onInput, item.origin)
      return { mode: 'turn' }
    }
    if (item.origin?.kind === 'decision') return { mode: 'queued' }
    item.sending = true
    try {
      const mode = occupied(sessionId, st) ? await steer(sessionId, st, item) : null
      if (mode && !item.cancelled) st.queued.splice(st.queued.indexOf(item), 1)
      return { mode: item.cancelled ? 'cancelled' : mode ?? 'queued' }
    } finally {
      item.sending = false
      drain(sessionId, st)
    }
  }

  const interrupt = async (profileRef, sessionRef) => {
    const sessionId = rt.conversation(profileRef, sessionRef).session.id
    const decisionStopped = rt.stopDecisionDelivery?.(sessionId)
    if (rt.cancelLeadRetry?.(sessionId)) { await decisionStopped; return true }
    const st = stateOf(sessionId)
    for (const queued of st.queued) { queued.cancelled = true; queued.resolve({ reason: 'interrupted' }) }
    st.queued.length = 0
    const seq = st.seq
    const ended = st.active || st.starting ? new Promise(resolve => st.waiters.push({ seq, resolve })) : null
    if ((st.active || st.starting) && !st.finishing && st.cancelTimer === null) {
      st.cancelTimer = setTimeout(() => {
        st.cancelTimer = null
        if (st.seq === seq && (st.active || st.starting) && !st.finishing) {
          st.cancelledStart = st.turnId === null
          driverSink(sessionId, { type: 'turn/end', reason: 'interrupted', unconfirmed: true })
        }
      }, RUN_LIMITS.cancelConfirmMs)
      st.cancelTimer.unref?.()
    }
    const stopped = rt.interruptDriver(sessionId)
    await Promise.all([decisionStopped, ended ? Promise.race([stopped, ended]) : stopped])
    return true
  }

  // The live slice the client polls: what runs now and what waits.
  const workView = () => {
    const view = Object.fromEntries([...turns.entries()].map(([sessionId, st]) => {
      const buffer = st.active || st.starting ? st.messages?.text() ?? '' : ''
      return [sessionId, {
        active: st.active || st.starting || st.finishing || rt.isCompacting(sessionId),
        suspect: st.suspect,
        stopping: st.cancelTimer !== null || rt.executionStopping?.(sessionId) === true,
        tool: st.toolOpen,
        since: st.startedAt,
        buffer: buffer === '' ? null : clip(rt.redactDeepSecrets(buffer), 4000, 'live reply'),
        timeline: st.messages != null,
        queued: st.queued.length,
        pending: st.queued.filter(item => item.pendingLine).map(item => ({ seq: item.seq,
          text: rt.redactDeepSecrets(item.task), images: item.pendingLine.images ?? [], sending: item.sending === true,
          ...(item.pendingLine.origin?.taskId ? { taskId: item.pendingLine.origin.taskId } : {}) })),
      }]
    }))
    for (const profile of Object.values(rt.state.profiles)) {
      for (const session of rt.sessionsOf(profile)) {
        const local = view[session.id] ??= { active: rt.isCompacting(session.id), since: null, buffer: null, queued: 0 }
        const native = rt.nativeWork?.(session)
        if (native) view[session.id] = { ...local, ...native, active: local.active || native.active,
          status: native.active ? native.status : local.active ? 'running' : native.status,
          since: native.since ?? local.since, tool: native.tool ?? local.tool ?? null, buffer: local.buffer ?? native.buffer,
          queued: local.queued + native.queued }
      }
    }
    for (const [id, work] of Object.entries(view)) {
      if (rt.leadRetryWaiting?.(id)) Object.assign(work, { active: true, retryWaiting: true })
    }
    // A fully idle entry without native state carries no information, so it is
    // omitted; the client reads undefined through optional chaining.
    return Object.fromEntries(Object.entries(view).filter(([, work]) => work.active || work.suspect || work.queued
      || work.status !== undefined && work.status !== 'idle' || work.finishedAt !== undefined))
  }

  ctx.effect(() => () => {
    for (const st of turns.values()) { disarmIdle(st); clearTimeout(st.cancelTimer) }
  }, 'nodo: dispatch idle timers')

  const dispatchWork = id => {
    const st = turns.get(id)
    if (!st) return
    return { suspect: st.suspect, stopping: st.cancelTimer !== null,
      retry: [...st.lifecycles?.values() ?? []].some(line => line.event === 'retry') }
  }
  Object.assign(rt, { driverSink, send, queuedMessage, interrupt, workView, dispatchWork, drainQueue: id => drain(id, stateOf(id)), rearmIdle: id => armIdle(id, stateOf(id)) })
}
