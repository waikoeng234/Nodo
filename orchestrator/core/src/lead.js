import { RUN_LIMITS, INPUT_CONTEXT_MAX, SCOPE_NOTE_MAX, TRIGGER_TEXT_TOTAL_MAX } from './constants.js'
import { clip } from './text.js'
import { route } from '../shared/route.js'
import { leadModeOf } from '../shared/lead.js'
import { invalid, failure } from './errors.js'
import { releasedFlow } from './flow.js'
import { leadRules } from './lead-rules.js'
import { createLeadView } from './lead-view.js'

const MAX_ACTIVE_FLIGHTS = 5
const LEAD_DISPATCH_BUDGET = 24

export function install(rt) {
  const states = new Map()
  const stateOf = id => {
    if (!states.has(id)) states.set(id, { flights: new Map(), reserved: 0 })
    return states.get(id)
  }
  const rosterOf = profile => (rt.teamOf(profile.id)?.members ?? []).map(id => rt.state.profiles[id]).filter(item => item && !item.deletedAt)
  const flightOf = id => {
    for (const state of states.values()) if (state.flights.has(id)) return state.flights.get(id)
  }
  const latestExecutions = () => new Map(Object.values(rt.state.executions).map(execution => [execution.sessionId, execution]))
  const latestExecution = (id, latest = latestExecutions()) => latest.get(id)
  const executionIds = execution => execution ? { taskId: execution.taskId, executionId: execution.id } : {}
  const flightExecution = flight => rt.state.executions[flight.executionId]
  const delegationSummary = (session, latest = latestExecutions()) => {
    const execution = latest.get(session.id)
    if (!execution) return
    const task = rt.state.tasks[execution.taskId]
    const firstLine = task.brief.trim().split(/\r?\n/, 1)[0]
    const workspace = rt.state.workspaces[execution.workspaceRef ?? task.workspaceRef]
    const branch = execution.workspaceRef && execution.workspaceRef !== task.workspaceRef ? workspace?.worktree?.branch : undefined
    return { type: execution.type, hard: execution.hard, ...(branch ? { branch } : {}), directory: workspace ? branch ?? '共享' : '已删除', task: firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine,
      acceptedAt: execution.createdAt, ...(execution.supplementUnconfirmed ? { supplementUnconfirmed: true } : {}), ...(execution.endedAt ? { endedAt: execution.endedAt, reason: execution.reason } : {}),
      status: execution.status === 'interrupted' && execution.reason.startsWith('interrupted-') ? execution.reason : execution.status,
      ...(execution.reason?.startsWith('interrupted-') ? { stoppedBy: execution.reason.slice(12) } : {}) }
  }
  const cancelLeadRetry = (id, takeover = false) => {
    const flight = flightOf(id)
    if (!flight || takeover && !flight.retrying) return false
    flight.stopping = true
    if (!takeover) flight.stoppedBy ??= 'user'
    const waiting = flight.waiting === true
    flight.cancel?.()
    return waiting
  }
  const leadBrief = (profile, session) => !leadModeOf(profile, session) || session?.instructionMode === 'native' ? '' : leadRules
  const note = async (id, text, extra) => {
    rt.appendLine(id, rt.redactDeepSecrets({ who: 'system', kind: 'note', text, ...extra }))
    await rt.save()
  }
  const causeOf = error => rt.redactDeepSecrets(String(error?.message ?? error))
  const removeUnsentWorktree = async workspaceRef => {
    if (!rt.state.workspaces[workspaceRef]?.worktree || Object.values(rt.state.executions)
      .some(item => item.workspaceRef === workspaceRef && item.startedAt != null)) return
    await rt.removeWorktree(workspaceRef).catch(error => rt.warn('nodo: worktree cleanup failed (%s): %s', workspaceRef, causeOf(error)))
  }
  const busy = id => {
    const work = rt.workView()[id]
    return work?.active || work?.queued > 0
  }
  const recipient = (profile, session) => {
    const found = rt.conversation(profile, session)
    rt.assertSessionWritable(found.profile, found.session)
    return found
  }
  const ownerOf = value => {
    const found = rt.conversationOf(typeof value === 'string' ? value : value?.id)
    if (!found || !leadModeOf(found.profile, found.session)) throw invalid('调用方必须是有效主控会话')
    rt.assertSessionWritable(found.profile, found.session)
    return found
  }
  const ownedTask = async (owner, id) => {
    if (typeof id !== 'string' || !id.trim()) throw invalid('taskId 必须是非空字符串')
    const task = await rt.taskView(id)
    if (task.coordinatorSessionId !== owner.session.id) throw invalid('任务不属于本主控会话')
    return task
  }
  const view = createLeadView(rt, { rosterOf, flightOf, delegationSummary, ownerOf, ownedTask })
  const assertFlightCapacity = (state, message) => {
    if (state.flights.size + state.reserved >= MAX_ACTIVE_FLIGHTS) throw failure(message, 'orch/busy')
  }
  const begin = (state, session, execution) => {
    let settle
    const flight = { profile: rt.conversationOf(session.id).profile.id, session: session.id, ...executionIds(execution), inputs: new Map(),
      settled: new Promise(resolve => { settle = resolve }) }
    flight.settle = settle
    state.flights.set(session.id, flight)
    return flight
  }
  const release = (state, flight, result) => {
    if (state.flights.get(flight.session) === flight) state.flights.delete(flight.session)
    flight.settle(result)
  }
  const end = async (state, session, flight, result) => {
    // A store adopt during execution replaces the session objects; the summary and
    // the caller's later writes must land on the current one.
    session = rt.conversationOf(session?.id ?? flight.session)?.session ?? session
    try {
      const execution = rt.state.executions[flight.executionId]
      if (['queued', 'running', 'unconfirmed'].includes(execution.status)) {
        const method = result.code === 'orch/decision-pending' ? 'cancelUnsentExecution' : result.unconfirmed ? 'unconfirmExecution' : result.reason === 'done' ? 'finishExecution'
          : result.reason === 'cancelled' ? 'cancelExecution' : result.reason === 'interrupted' ? 'interruptExecution' : 'failExecution'
        if (!(result.unconfirmed && execution.status === 'unconfirmed')) await rt[method](execution.id, { final: result.final, finalCapture: result.finalCapture,
          reason: result.code ?? (result.reason === 'interrupted' && flight.stoppedBy ? `interrupted-${flight.stoppedBy}` : result.reason) })
      }
      return session
    } finally { release(state, flight, result) }
  }
  const completedWork = async (flight, placed) => {
    let result = await placed.completion
    while (flight.inputs.size) {
      const inputs = [...flight.inputs.entries()]
      const results = await Promise.all(inputs.map(([, completion]) => completion))
      for (const [seq] of inputs) flight.inputs.delete(seq)
      result = results.findLast(item => !item.discarded) ?? result
    }
    return result
  }
  // The flow moves on from the saved execution; the lead only gets a note.
  const settled = async (id, flight, result) => {
    await note(id, '', { delegation: { session: flight.session, taskId: flight.taskId, executionId: flight.executionId, ended: result.reason,
      ...(result.unconfirmed ? { unconfirmed: true } : {}), ...(flight.stoppedBy ? { stoppedBy: flight.stoppedBy } : {}) } })
    await rt.scheduleFlow(id)
  }
  const stop = async (state, flight) => {
    // A user stop recorded first keeps its initiator.
    flight.stoppedBy ??= 'lead'
    if (flight.dispatch) {
      await cancelDispatch(state, flight)
      return { reason: 'cancelled' }
    }
    flight.stopping = true
    if (rt.state.executions[flight.executionId].status === 'running') await rt.requestExecutionStop(flight.executionId)
    flight.cancel?.()
    flight.stop ??= (async () => {
      let timer
      try {
        return await Promise.race([
          Promise.resolve().then(() => rt.interrupt(flight.profile, flight.session)).then(() => flight.settled),
          new Promise(resolve => { timer = setTimeout(() => resolve({ reason: 'interrupted', unconfirmed: true }), RUN_LIMITS.cancelConfirmMs); timer.unref?.() }),
        ])
      } catch { return { reason: 'interrupted', unconfirmed: true } }
      finally { clearTimeout(timer) }
    })()
    const result = await flight.stop
    if (result.unconfirmed && state.flights.get(flight.session) === flight) {
      await end(state, rt.conversationOf(flight.session)?.session, flight, result)
      await settled(rt.state.tasks[flight.taskId].coordinatorSessionId, flight, result)
    }
    return result
  }
  const interruptDelegation = async (leadSession, command) => {
    const owner = ownerOf(leadSession), state = stateOf(owner.session.id)
    const args = typeof command === 'string' ? { session: command } : command ?? {}
    if ((args.session !== undefined) === (args.executionId !== undefined)) throw invalid('session 和 executionId 必须且只能指定一个')
    let session = args.session, flight, execution
    if (args.executionId !== undefined) {
      execution = rt.state.executions[args.executionId]
      if (!execution) throw invalid('没有该 Execution')
      await ownedTask(owner, execution.taskId)
      flight = [...state.flights.values()].find(item => item.executionId === execution.id)
      session = execution.sessionId
    } else flight = state.flights.get(session)
    if (typeof session !== 'string' || !session.trim()) throw invalid('session 必须是非空字符串')
    if (!flight && execution?.status === 'unconfirmed') {
      await rt.interruptExecution(execution.id, { reason: 'interrupted-lead' })
      await note(owner.session.id, '', { delegation: { session, taskId: execution.taskId, executionId: execution.id, ended: 'interrupted', stoppedBy: 'lead' } })
      return { session, taskId: execution.taskId, executionId: execution.id, ended: 'interrupted',
        lastOutput: clip(rt.redactDeepSecrets(String(rt.workView()[session]?.buffer ?? '')), 4000, 'last output') }
    }
    if (!flight) throw invalid('只能中断本主控会话当前派出的执行任务；该任务不属于本会话或已结束')
    const result = await stop(state, flight)
    return { session, taskId: flight.taskId, executionId: flight.executionId, ended: result.reason, ...(result.unconfirmed ? { unconfirmed: true } : {}),
      lastOutput: clip(rt.redactDeepSecrets(String(result.final ?? result.text ?? rt.workView()[session]?.buffer ?? '')), 4000, 'last output') }
  }
  const track = async (leadSession, session, flight, sent, manual = false) => {
    const state = stateOf(leadSession.id), target = rt.conversationOf(session.id).profile
    let result
    try {
      result = await completedWork(flight, sent)
      if (result.code === 'orch/decision-pending') return await cancelDispatch(state, flight, result)
      let retries = 0
      while (result.reason === 'error' && result.retryable && !result.unconfirmed && !flight.stopping && !flight.takenOver && !manual && !rt.sessionBlockReason?.(leadSession.id)) {
        flight.retrying = true
        if (retries === 5) {
          await note(leadSession.id, '执行暂时失败，自动继续已用尽（5/5）。')
          break
        }
        flight.waiting = true
        const waiting = new Promise(resolve => {
          const timer = setTimeout(() => resolve(true), 30_000)
          timer.unref?.()
          flight.cancel = () => { clearTimeout(timer); flight.waiting = false; resolve(false) }
        })
        flight.retries = ++retries
        await note(leadSession.id, `执行暂时失败，30 秒后在原会话自动继续（${retries}/5）。`)
        const resume = await waiting
        flight.waiting = false
        flight.cancel = null
        if (!resume || flight.stopping || rt.sessionBlockReason?.(leadSession.id)) break
        try {
          const input = await rt.composeWorkerInput({ executionId: flight.executionId })
          const continued = await rt.send(target.id, input.text, session.id, input.images, [],
            { exclusive: true, files: { paths: input.files }, limit: INPUT_CONTEXT_MAX, cancelled: () => flight.stopping, origin: { kind: 'retry' } })
          const next = await completedWork(flight, continued)
          if (next.code === 'orch/decision-pending') break
          result = next
        } catch (cause) {
          if (flight.stopping || cause?.code === 'orch/busy') flight.stopping = true
          else {
            result = { reason: 'error' }
            await note(leadSession.id, `自动继续失败：${rt.redactDeepSecrets(String(cause.message ?? cause)).slice(0, 200)}。`)
          }
          break
        }
      }
      if (flight.retrying && flight.stopping) await note(leadSession.id, '已取消自动继续。')
      if (state.flights.get(flight.session) !== flight) return
      if (flight.stopping && flight.stoppedBy && result.reason === 'error' && !result.unconfirmed) result = { ...result, reason: 'interrupted' }
      await end(state, session, flight, result)
    } catch (error) {
      rt.warn('nodo: delegation tracking failed (%s): %s', session.id, error.message ?? error)
      if (state.flights.get(flight.session) !== flight) return
      result = { reason: 'error', unconfirmed: true }
      await end(state, session, flight, result)
    }
    await settled(leadSession.id, flight, result)
  }
  const routed = (lead, typeId, hard, profileId) => {
    const team = rt.teamOf(lead.id)
    const found = team && rt.findTeamType(team, typeId)
    if (!found) throw failure('type 必须是本团队任务类型清单中的 id', 'orch/unknown-type')
    const picked = route(team.assign, found.id, hard)
    const holder = rosterOf(lead).find(item => item.id === (profileId ?? picked.profile) && item.id !== lead.id)
    if (!holder) throw failure(`没有承接「${found.name}」的角色`, 'orch/no-holder')
    return { team, found, picked: { ...picked, profile: holder } }
  }
  const titleOf = command => {
    const title = rt.redactDeepSecrets(command.title ?? command.scope.quote ?? command.scope.note).trim().split(/\r?\n/, 1)[0].slice(0, 80)
    if (!title) throw failure('任务标题为空', 'orch/title-empty')
    return title
  }
  // A task whose dependencies are not released waits for the scheduler with its routing kept on the flow.
  const planTask = async (owner, command, trigger) => {
    const { profile: lead, session: leadSession } = owner, state = stateOf(leadSession.id)
    const { team, found } = routed(lead, command.type, command.hard)
    const title = titleOf(command)
    const newTrigger = !rt.state.triggers[trigger.id]
    rt.persistTrigger(trigger)
    let task
    try {
      task = await rt.createTask({ workspaceRef: leadSession.workspaceRef, teamId: team.id, coordinatorSessionId: leadSession.id,
        title, brief: trigger.text, parentId: command.parentId, dependsOn: command.dependsOn, triggerId: trigger.id, scope: command.scope,
        flow: { status: 'pending', route: { type: found.id, hard: command.hard, ...(command.worktree ? { worktree: true } : {}) } },
        source: { kind: 'lead', sessionId: leadSession.id } })
    } catch (error) {
      if (newTrigger) delete rt.state.triggers[trigger.id]
      throw error
    }
    state.count = (state.count ?? 0) + 1
    return { ok: true, taskId: task.id, type: found.id, hard: command.hard, flow: structuredClone(task.flow), status: 'pending', message: '依赖任务完成后自动派发' }
  }
  const dispatchTask = async (leadValue, command, taskRecord, details) => {
    const { profile: lead, session: leadSession } = ownerOf(leadValue)
    const state = stateOf(leadSession.id)
    const { trigger, stage = 'implement', sourceExecutionId, supplements = [], profileId, resumed = false } = details
    const continuesRecord = command.continues ? await ownedTask({ profile: lead, session: leadSession }, command.continues) : undefined
    const sourceRecord = taskRecord ?? continuesRecord
    if (continuesRecord && (!continuesRecord.executions.length || continuesRecord.executions.at(-1).endedAt == null
      || continuesRecord.executions.at(-1).status === 'unconfirmed')) throw failure('接续来源任务最近一次执行尚未结束，请等待。', 'orch/source-busy')
    const previous = sourceRecord?.executions.at(-1)
    let workspaceRef = previous?.workspaceRef ?? sourceRecord?.workspaceRef ?? leadSession.workspaceRef
    if (!rt.state.workspaces[workspaceRef] || rt.state.workspaces[workspaceRef].deletedAt) throw invalid('执行目录已不可用')
    if (continuesRecord && command.worktree !== undefined && command.worktree !== (workspaceRef !== sourceRecord.workspaceRef)) {
      throw failure('worktree 与接续来源任务的执行目录不一致，执行目录已锁定', 'orch/worktree-mismatch')
    }
    const { team, found, picked } = routed(lead, command.type, command.hard, profileId)
    const hard = command.hard, task = trigger.text
    const title = taskRecord?.title ?? titleOf(command)
    // Continuation candidate: the source task's last ended execution's session.
    // Every condition must hold; the first miss gives the receipt's reason.
    const lastEnded = sourceRecord?.executions.findLast(item => item.endedAt != null)
    let live, continueReason
    if (!sourceRecord) continueReason = '没有接续来源任务'
    else {
      const candidate = lastEnded && rt.conversationOf(lastEnded.sessionId)
      const candidateSource = candidate?.session.source
      if (!lastEnded) continueReason = '接续来源任务还没有已结束的执行'
      else if (!candidate || candidateSource?.kind !== 'lead' || candidateSource.leadSessionId !== leadSession.id) continueReason = '候选会话不是本主控派出的执行会话'
      else if (candidate.session.archivedAt) continueReason = '候选会话已归档'
      else if (flightOf(candidate.session.id) || busy(candidate.session.id)) continueReason = '候选会话正忙'
      else if (delegationSummary(candidate.session)?.status === 'unconfirmed') continueReason = '候选会话最近一次派活状态未确认'
      else if (candidate.profile.id !== picked.profile.id) continueReason = '候选会话的角色与本次路由不一致'
      else if (candidateSource.hard !== hard) continueReason = '候选会话的难度与本次不一致'
      else if (workspaceRef !== candidate.session.workspaceRef) continueReason = '候选会话的工作区与本次执行目录不一致'
      else if (command.worktree === true && !previous) continueReason = 'worktree 与接续来源任务的执行目录不一致'
      else if (found.independent && Object.values(rt.state.executions).some(item => item.sessionId === candidate.session.id
        && !team.types.find(type => type.id === item.type)?.independent)) continueReason = 'independent 类型不能沿用执行过其他类型的会话'
      else if (Object.values(rt.state.executions).filter(item => item.sessionId === candidate.session.id).length >= 5) continueReason = '候选会话承接的执行数已达上限'
      else {
        rt.assertSessionWritable(candidate.profile, candidate.session)
        live = candidate
      }
    }
    assertFlightCapacity(state, `此主控会话最多同时派活 ${MAX_ACTIVE_FLIGHTS} 个任务，请等一个结束后再派`)
    const target = picked.profile, reused = !!live
    const newTrigger = !rt.state.triggers[trigger.id]
    state.reserved++
    state.count = (state.count ?? 0) + 1
    let reserved = true
    let session, flight, execution, continued, createdWorkspace
    try {
      rt.persistTrigger(trigger)
      if (!previous && command.worktree) {
        createdWorkspace = (await rt.createTaskWorktree({ workspaceRef })).workspace
        workspaceRef = createdWorkspace.id
      }
      const workspace = rt.findWorkspace(workspaceRef)
      const worktree = workspaceRef !== (sourceRecord?.workspaceRef ?? leadSession.workspaceRef) ? workspace?.worktree : undefined
      session = live?.session ?? await rt.createSession(target.id, title, workspaceRef, true, false, picked.choices,
        { kind: 'lead', leadProfileId: lead.id, leadSessionId: leadSession.id, type: found.id, hard }, { activate: false })
      continued = session.source.continued
      if (!taskRecord) {
        taskRecord = await rt.createTask({ workspaceRef: leadSession.workspaceRef, teamId: team.id, coordinatorSessionId: leadSession.id,
          title, brief: task, parentId: command.parentId, dependsOn: command.dependsOn,
          triggerId: trigger.id, scope: command.scope, flow: { status: 'running', stage: 'implement', round: 1 },
          source: { kind: 'lead', sessionId: leadSession.id, ...(continuesRecord ? { continuesTaskId: continuesRecord.id } : {}) } })
      }
      if (reused) session.source.continued = (continued ?? 0) + 1
      execution = await rt.acceptExecution(taskRecord.id, { profileId: target.id, sessionId: session.id, type: found.id, hard,
        workspaceRef, model: session.model || undefined, thinking: session.thinking || undefined,
        stage, triggerId: trigger.id, scope: taskRecord.scope, supplements, sourceExecutionId })
      state.reserved--
      reserved = false
      flight = begin(state, session, execution)
      flight.createdWorkspace = createdWorkspace?.id
      flight.tracking = true
      flight.dispatch = async () => {
        flight.dispatchStarted = true
        delete flight.dispatch
        let following, sent
        try {
          const input = await rt.composeWorkerInput({ executionId: execution.id })
          if (flight.stopping) return await cancelDispatch(state, flight)
          await rt.startExecution(execution.id, input.inputContext)
          sent = await rt.send(target.id, input.text, session.id, input.images, [], { exclusive: true, files: { paths: input.files }, limit: INPUT_CONTEXT_MAX, origin: { kind: 'delegation', ...executionIds(execution) } })
          following = track(leadSession, session, flight, sent, resumed)
        } catch (error) {
          const result = { reason: causeOf(error) }
          try { await end(state, session, flight, result) }
          finally { await removeUnsentWorktree(createdWorkspace?.id) }
          following = settled(leadSession.id, flight, result)
        }
        void following.catch(error => rt.warn('nodo: dispatch failed (%s): %s', flight.session, causeOf(error)))
        return sent
      }
      session = rt.conversationOf(session.id)?.session ?? session
      await note(leadSession.id, `${reused ? '继续受理' : '已受理'} ${target.name} · ${session.name}（${found.name} · ${hard ? '难题' : '常规'}）`,
        { delegation: { session: session.id, ...executionIds(execution), profile: target.id, type: found.id, hard, reused, deferred: true,
          ...(worktree ? { branch: worktree.branch } : {}) } })
      return { ok: true, ...executionIds(execution), session: session.id, role: target.name, type: found.id, hard,
        flow: structuredClone(rt.state.tasks[taskRecord.id].flow), reused, continued: reused,
        ...(reused ? {} : { reason: continueReason }), status: 'queued', message: '已受理，本轮结束后发送' }

    } catch (error) {
      if (newTrigger && !Object.values(rt.state.tasks).some(item => item.triggerId === trigger.id)
        && !Object.values(rt.state.executions).some(item => item.triggerId === trigger.id || item.supplements?.includes(trigger.id))) delete rt.state.triggers[trigger.id]
      if (!flight?.dispatchStarted) {
        if (reused && session) {
          if (continued === undefined) delete session.source.continued
          else session.source.continued = continued
        }
        const queued = execution ?? Object.values(rt.state.executions).find(item => item.taskId === taskRecord?.id && item.sessionId === session?.id && item.status === 'queued')
        if (queued?.status === 'queued') try { await rt.cancelUnsentExecution(queued.id, { reason: `保存失败：${causeOf(error)}` }) } catch {}
        if (flight) { delete flight.dispatch; release(state, flight, { reason: 'cancelled' }) }
        // A session created by this call that was never sent to has no dispatch and
        // its id never reached the lead; removing it restores the role's session list.
        if (!reused && session) try {
          const created = rt.conversationOf(session.id)
          created.profile.sessions = created.profile.sessions.filter(item => item.id !== session.id)
          await rt.save()
        } catch (cause) { rt.warn('nodo: orphan session cleanup failed (%s): %s', session.id, causeOf(cause)) }
        state.count--
        await removeUnsentWorktree(createdWorkspace?.id)
      }
      throw error
    } finally { if (reserved) state.reserved-- }
  }
  const leadRoute = async (id, command = {}) => {
    const owner = ownerOf(id), state = stateOf(owner.session.id)
    id = owner.session.id
    const fields = {
      new: ['type', 'hard', 'scope', 'title', 'worktree', 'parentId', 'dependsOn', 'continues'],
      attach: ['taskId', 'scope'], stop: ['executionIds', 'taskIds'],
      ask: ['questions', 'stopExecutionIds', 'taskIds', 'executionIds', 'references'],
    }[command.action]
    if (!fields || Object.keys(command).some(key => key !== 'action' && !fields.includes(key))) throw invalid('路由动作或字段无效')
    for (const key of ['taskId', 'parentId', 'continues']) if (command[key] !== undefined && (typeof command[key] !== 'string' || !command[key].trim())) throw invalid(`${key} 必须是非空字符串`)
    for (const key of ['dependsOn', 'executionIds', 'taskIds']) if (command[key] !== undefined && (!Array.isArray(command[key]) || command[key].some(value => typeof value !== 'string' || !value.trim()))) throw invalid(`${key} 必须是非空字符串数组`)
    if (command.action === 'stop') {
      if ((command.executionIds !== undefined) === (command.taskIds !== undefined) || !(command.executionIds ?? command.taskIds).length) throw invalid('executionIds 和 taskIds 必须且只能指定一个非空数组')
      const tasks = new Map()
      const executions = command.executionIds ? command.executionIds.map(value => {
        const execution = rt.state.executions[value]
        if (!execution) throw invalid('没有该 Execution')
        return execution
      }) : (await Promise.all(command.taskIds.map(value => ownedTask(owner, value)))).flatMap(task => {
        tasks.set(task.id, task)
        return task.executions.filter(item => ['queued', 'running', 'unconfirmed'].includes(item.status))
      })
      for (const execution of executions) tasks.set(execution.taskId, await ownedTask(owner, execution.taskId))
      const stopped = []
      for (const execution of executions) if (['queued', 'running', 'unconfirmed'].includes(execution.status)) stopped.push(await interruptDelegation(id, { executionId: execution.id }))
      for (const task of tasks.values()) {
        const record = rt.state.tasks[task.id]
        if (record.flow) { record.flow.status = 'stopped'; record.status = 'stopped'; rt.releaseTaskTriggers(task.id) }
        for (const card of Object.values(rt.state.cards)) if (card.taskId === task.id && card.status === 'open') Object.assign(card, { status: 'resolved', answer: 'stop', answeredAt: Date.now() })
      }
      await rt.saveStrict()
      return { ok: true, stopped }
    }
    if ((state.count ?? 0) >= LEAD_DISPATCH_BUDGET) throw failure(`本轮已达到 ${LEAD_DISPATCH_BUDGET} 次派活上限`, 'orch/busy')
    if (command.action === 'ask') {
      const { action, ...args } = command
      const decision = await rt.createDecision(id, args)
      state.count = (state.count ?? 0) + 1
      return decision
    }
    const trigger = rt.requirePendingTrigger(id)
    const scope = command.scope
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['quote', 'note'].includes(key))
      || (scope.quote !== undefined) === (scope.note !== undefined)) throw failure('scope 必须且只能提供 quote 或 note', 'orch/scope-missing')
    if (scope.note !== undefined && (typeof scope.note !== 'string' || !scope.note.trim() || scope.note.length > SCOPE_NOTE_MAX || /[\r\n]/.test(scope.note))) throw failure('范围说明必须是单行且不超过 100 字', 'orch/scope-note-too-long')
    if (scope.quote !== undefined && (typeof scope.quote !== 'string' || !scope.quote || !trigger.text.includes(scope.quote))) throw failure('quote 必须是本轮用户原话的精确子串', 'orch/scope-not-quote')
    if (!rt.state.triggers[trigger.id] && rt.triggerUsageOf(id) + trigger.text.length > TRIGGER_TEXT_TOTAL_MAX) throw failure('触发消息存储已满。请清理停滞或已结束的任务，再派新活。', 'orch/trigger-full')
    if (command.action === 'new') {
      // The lead channel awaits this for tool calls; direct leadRoute callers
      // still need to park while an answered decision is mid-delivery.
      await rt.decisionDeliveryReady?.(id)
      rt.assertDecisionDispatch?.(id)
      if (typeof command.hard !== 'boolean') throw invalid('hard 必须是 true 或 false')
      if (command.worktree !== undefined && typeof command.worktree !== 'boolean') throw invalid('worktree 必须是 true 或 false')
      if (command.title !== undefined && (typeof command.title !== 'string' || command.title.length > 80)) throw failure('title 必须是最多 80 字的文本', 'orch/title-empty')
      if (command.continues && (command.parentId !== undefined || command.dependsOn !== undefined)) throw invalid('continues 与 parentId/dependsOn 互斥')
      if (command.parentId && (await ownedTask(owner, command.parentId)).status === 'done') throw invalid('父任务已验收')
      for (const value of command.dependsOn ?? []) {
        const dependency = await ownedTask(owner, value)
        if (!dependency.flow || dependency.flow.status === 'stopped') throw invalid(`依赖任务 ${dependency.title} 已停止，不能再依赖它`)
      }
      const storedScope = rt.redactDeepSecrets(scope)
      if (storedScope.note?.length > SCOPE_NOTE_MAX) throw failure('范围说明脱敏后超过 100 字', 'orch/scope-note-too-long')
      if ((command.dependsOn ?? []).some(value => !releasedFlow(rt.state.tasks[value]))) return planTask(owner, { ...command, scope: storedScope }, trigger)
      return dispatchTask(id, { ...command, scope: storedScope }, undefined, { trigger })
    }
    return attachTask(owner, await ownedTask(owner, command.taskId), trigger)
  }
  const attachTask = async (owner, task, trigger) => {
    const id = owner.session.id, state = stateOf(id), flow = task.flow ?? {}
    const workspaceRef = task.executions.at(-1)?.workspaceRef ?? task.workspaceRef
    if (!rt.state.workspaces[workspaceRef] || rt.state.workspaces[workspaceRef].deletedAt) throw failure('执行目录已不可用，请另建任务', 'orch/frozen')
    if (flow.status === 'stalled') throw failure('任务已停滞，请另建任务', 'orch/task-stalled')
    // A task still waiting on its dependencies takes the input as a later
    // requirement; its first execution carries the supplements.
    if (flow.status === 'pending') {
      rt.persistTrigger(trigger)
      const supplements = [...new Set([...(flow.supplements ?? []), trigger.id])]
      Object.assign(rt.state.tasks[task.id].flow, { supplements })
      state.count = (state.count ?? 0) + 1
      await rt.saveStrict()
      return { ok: true, taskId: task.id, type: flow.route?.type, hard: flow.route?.hard, flow: structuredClone(rt.state.tasks[task.id].flow),
        status: 'pending', delivery: { mode: 'pending' }, message: '已记入等待任务的补充要求，任务开始执行时一并交给执行者' }
    }
    if (!['running', 'reviewing', 'done'].includes(flow.status) || ['done', 'stopped'].includes(task.status)) throw failure('已结束、停止或旧任务只读', 'orch/frozen')
    const latest = task.executions.at(-1)
    if (!latest) throw invalid('任务没有执行记录')
    if (latest.status === 'unconfirmed') throw failure('Task or session already has a pending execution', 'orch/busy')
    const execution = rt.state.executions[latest.id]
    if (['queued', 'running'].includes(execution.status)) {
      rt.persistTrigger(trigger)
      execution.supplements ??= []
      if (!execution.supplements.includes(trigger.id) && execution.triggerId !== trigger.id) execution.supplements.push(trigger.id)
      await rt.saveStrict()
      let mode = execution.status === 'queued' ? 'merged' : 'queued'
      if (execution.status === 'running' && flow.status === 'running') {
        const input = await rt.composeSupplementInput({ executionId: execution.id, triggerId: trigger.id })
        const sent = await rt.send(execution.profileId, input.text, execution.sessionId, input.images, [], { files: { paths: input.files }, limit: INPUT_CONTEXT_MAX,
          origin: { kind: 'supplement', ...executionIds(execution), triggerId: trigger.id } })
        mode = sent.mode === 'steered' || sent.mode === 'indeterminate' ? 'steered' : 'queued'
        if (sent.mode === 'indeterminate') { execution.supplementUnconfirmed = true; await rt.saveStrict() }
        const flight = state.flights.get(execution.sessionId)
        if (flight) flight.inputs.set(sent.seq, sent.completion)
      }
      state.count = (state.count ?? 0) + 1
      const target = rt.state.profiles[execution.profileId]
      const receipt = { ok: true, ...executionIds(execution), role: target.name, type: execution.type, hard: execution.hard, flow, delivery: { mode } }
      await note(id, '已受理补充', { delegation: { ...receipt, session: execution.sessionId } })
      return receipt
    }
    // A rework follows the task's implementation: review executions only carry
    // verdicts and findings, so the routing type and holder come from the last
    // implement/rework execution.
    const implementLatest = task.executions.findLast(item => ['implement', 'rework'].includes(item.stage ?? 'implement'))
    if (!implementLatest) throw invalid('任务没有可返工的实现执行记录')
    rt.assertDecisionDispatch?.(id)
    const receipt = await rt.reworkFlow(rt.state.tasks[task.id], { trigger, supplement: true,
      supplements: (execution.supplements ?? []).filter(value => value !== trigger.id), source: rt.state.executions[implementLatest.id] })
    if (!receipt) throw failure('任务已停滞，请处理停滞卡', 'orch/task-stalled')
    const mode = flow.status === 'done' ? 'withdrew-card' : 'rework'
    if (flow.status === 'done') for (const card of Object.values(rt.state.cards)) if (card.taskId === task.id && card.status === 'open') Object.assign(card, { status: 'resolved', answer: 'supplement', answeredAt: Date.now() })
    await rt.saveStrict()
    return { ...receipt, delivery: { mode } }
  }
  // User input to an executor session joins its running execution; while an
  // automatic retry waits, the input takes the execution over from the retry.
  const prepareLeadInput = async session => {
    const source = session.source
    if (source?.kind !== 'lead') return
    const state = stateOf(source.leadSessionId)
    const flight = state.flights.get(session.id)
    if (!flight?.retrying) return flight
    if (busy(session.id) && !flight.waiting) {
      flight.takenOver = true
      return flight
    }
    cancelLeadRetry(session.id, true)
    state.flights.delete(session.id)
    return begin(state, session, rt.state.executions[flight.executionId])
  }
  const followLeadReport = async (sessionId, placed, flight) => {
    if (!flight) return
    flight.inputs.set(placed.seq, placed.completion)
    if (flight.tracking) return
    flight.tracking = true
    const session = rt.conversationOf(sessionId).session
    const owner = rt.conversationOf(session.source.leadSessionId)
    if (owner) return track(owner.session, session, flight, placed, true)
    await end(stateOf(session.source.leadSessionId), session, flight, await completedWork(flight, placed))
  }
  const followLead = async (sessionId, placed) => {
    let result
    try {
      if (placed.mode !== 'turn' && placed.mode !== 'queued') return
      result = await placed.completion
    } catch (error) {
      rt.warn('nodo: lead follow failed (%s): %s', sessionId, error.message ?? error)
    }
    const state = stateOf(sessionId)
    for (const flight of [...state.flights.values()]) {
      if (!flight.dispatch) continue
      try {
        if (result?.reason === 'done' && !result.unconfirmed && !rt.sessionBlockReason?.(sessionId)) await flight.dispatch()
        else await cancelDispatch(state, flight)
      } catch (error) { rt.warn('nodo: dispatch failed (%s): %s', flight.session, causeOf(error)) }
    }
  }
  const cancelDispatch = async (state, flight, result = { reason: 'cancelled' }) => {
    delete flight.dispatch
    let session
    try { session = await end(state, rt.conversationOf(flight.session)?.session, flight, result) }
    finally { await removeUnsentWorktree(flight.createdWorkspace) }
    if (session) await note(session.source.leadSessionId, '', { delegation: { session: session.id, taskId: flight.taskId, executionId: flight.executionId,
      ended: 'cancelled', ...(flight.stoppedBy ? { stoppedBy: flight.stoppedBy } : {}) } })
  }
  rt.ctx.effect(() => () => {
    for (const state of states.values()) for (const flight of state.flights.values()) {
      if (flight.dispatch) void cancelDispatch(state, flight).catch(error => rt.warn('nodo: queued cancellation failed: %s', causeOf(error)))
      else if (flight.waiting) flight.cancel()
    }
  }, 'nodo: lead retry timers')

  // Restart recovery: executions the previous host left queued or running end
  // and their tasks stall; then every lead's flow is scheduled again.
  const recoverLeadDelegations = async () => {
    if (rt.readOnly?.()) return
    try {
      for (const execution of Object.values(rt.state.executions)) {
        if (flightOf(execution.sessionId)) continue
        if (execution.status === 'queued') {
          await rt.cancelUnsentExecution(execution.id, { reason: 'restart-unsent' })
          await removeUnsentWorktree(execution.workspaceRef)
        } else if (execution.status === 'running') await rt.interruptExecution(execution.id, { reason: 'restart' })
      }
      for (const id of new Set(Object.values(rt.state.tasks).map(task => task.coordinatorSessionId))) await rt.scheduleFlow(id)
    } catch (error) { rt.warn('nodo: execution recovery failed: %s', causeOf(error)) }
  }

  Object.assign(rt, {
    dispatchFlowExecution: async (task, details) => dispatchTask(task.coordinatorSessionId, { type: details.type, hard: details.hard, worktree: details.worktree }, await rt.taskView(task.id), details),
    startFlowExecution: async executionId => {
      const execution = rt.state.executions[executionId]
      const flight = flightOf(execution.sessionId)
      if (flight?.dispatch) return flight.dispatch()
    },
    flowWorkerInput: async (session, line) => {
      const execution = latestExecution(session.id), task = rt.state.tasks[execution?.taskId]
      if (!task) return
      if (task.flow.status === 'stalled') throw failure('任务已停滞，请处理停滞卡', 'orch/task-stalled')
      if (['accepted', 'stopped'].includes(task.flow.status)) throw failure('已结束、停止或旧任务只读', 'orch/frozen')
      const trigger = rt.triggerFromLine({ coordinatorSessionId: task.coordinatorSessionId, lineSessionId: session.id, line })
      if (['queued', 'running'].includes(execution.status)) {
        rt.persistTrigger(trigger)
        execution.supplements ??= []
        execution.supplements.push(trigger.id)
        await rt.saveStrict()
        if (task.flow.status === 'reviewing' || execution.status === 'queued') {
          rt.appendLine(session.id, { ...line, origin: { kind: 'supplement', triggerId: trigger.id } })
          await rt.saveStrict()
          return { placed: { mode: 'queued', completion: Promise.resolve({ reason: 'done' }) } }
        }
        return { input: await rt.composeSupplementInput({ executionId: execution.id, triggerId: trigger.id }), ...executionIds(execution), triggerId: trigger.id,
          queue: false }
      }
      const owner = rt.conversationOf(task.coordinatorSessionId)
      if (!owner || owner.session.archivedAt || owner.profile.deletedAt) return
      if (execution.status === 'unconfirmed') throw failure('Task or session already has a pending execution', 'orch/busy')
      rt.assertDecisionDispatch?.(task.coordinatorSessionId)
      rt.persistTrigger(trigger)
      const saved = rt.appendLine(session.id, { ...line, origin: { kind: 'supplement', triggerId: trigger.id } })
      const receipt = await rt.reworkFlow(task, { trigger, supplement: true })
      if (!receipt) throw failure('任务已停滞，请处理停滞卡', 'orch/task-stalled')
      return { placed: await rt.startFlowExecution(receipt.executionId), line: saved }
    },
    sessionNote: note,
    leadDecisionExecutions: id => Object.values(rt.state.executions).filter(execution => ['queued', 'running', 'unconfirmed'].includes(execution.status)
      && rt.state.tasks[execution.taskId]?.coordinatorSessionId === id).map(execution => {
      const flight = stateOf(id).flights.get(execution.sessionId)
      return { executionId: execution.id, taskId: execution.taskId, sessionId: execution.sessionId, status: execution.status,
        active: flight?.executionId === execution.id, stopping: flight?.stopping === true || rt.executionStopping?.(execution.sessionId) === true }
    }),
    pauseLeadForDecision: async (id, stopExecutionIds) => {
      const state = stateOf(id), cancelled = [], cancellationErrors = []
      for (const flight of [...state.flights.values()]) {
        flight.cancel?.()
        if (flight.dispatch) {
          await cancelDispatch(state, flight).catch(error => {
            cancellationErrors.push({ executionId: flight.executionId, message: causeOf(error) })
            rt.warn('nodo: decision cancellation failed (%s): %s', flight.session, causeOf(error))
          })
          if (flightExecution(flight)?.status === 'cancelled') cancelled.push(flight.executionId)
        }
      }
      for (const executionId of stopExecutionIds) if ([...state.flights.values()].some(flight => flight.executionId === executionId)) {
        void interruptDelegation(id, { executionId }).catch(error => rt.warn('nodo: decision interrupt failed (%s): %s', executionId, causeOf(error)))
      }
      return { cancelledQueuedExecutionIds: cancelled, ...(cancellationErrors.length ? { cancellationErrors } : {}) }
    },
    ownedTask,
    delegationSummary, ...view,
    leadRoute,
    leadDispatch: { interrupt: interruptDelegation },
    prepareLeadInput,
    resetLeadBudget: id => { stateOf(id).count = 0 },
    leadInputStarted: (id, line) => {
      rt.clearPendingTrigger(id)
      if (rt.isUserTriggerLine(line)) rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: id, line }))
      rt.resetLeadBudget(id)
    },
    leadEnded: async (id, result) => {
      const session = rt.conversationOf(id)?.session
      const execution = latestExecution(id)
      if (execution?.status === 'unconfirmed' && !flightOf(id)) await end(stateOf(session?.source?.leadSessionId), session, { ...executionIds(execution),
        stoppedBy: execution.reason?.startsWith('interrupted-') ? execution.reason.slice(12) : undefined, settle() {} }, result)
    },
    recoverLeadDelegations,
    leadBrief, followLead, followLeadReport, cancelLeadRetry,
    leadRetryWaiting: id => flightOf(id)?.waiting === true })
}
