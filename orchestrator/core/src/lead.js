import { TRANSCRIPT_TEXT_MAX, RESULT_TEXT_MAX, RESULTS_TEXT_MAX, RUN_LIMITS, INPUT_CONTEXT_MAX, SCOPE_NOTE_MAX, REVIEW_QUESTIONS_MAX, REVIEW_QUESTION_MAX, TRIGGER_TEXT_TOTAL_MAX } from './constants.js'
import { clip } from './text.js'
import { route } from '../shared/route.js'
import { leadModeOf } from '../shared/lead.js'
import { invalid, failure } from './errors.js'
import { randomUUID } from 'node:crypto'
import { executionResultOf, executionResultView } from './tasks.js'
import { leadRules } from './lead-rules.js'
import { createLeadView } from './lead-view.js'
import { createLeadRecovery } from './lead-recovery.js'

const UNREPORTED_GONE = '未回报主控：主控会话不存在。'
const MAX_ACTIVE_FLIGHTS = 5
const LEAD_DISPATCH_BUDGET = 24

export function install(rt) {
  const states = new Map()
  const recovering = new Set()
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
    if (!execution) return session.source?.dispatch
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
  const unreported = (session, error) => note(session, `未回报主控：${causeOf(error).slice(0, 200)}。`)
  const busy = id => {
    const work = rt.workView()[id]
    return work?.active || work?.queued > 0
  }
  const recipient = (profile, session) => {
    const found = rt.conversation(profile, session)
    rt.assertSessionWritable(found.profile, found.session)
    return found
  }
  const reportSummary = item => String(rt.redactDeepSecrets(item.summary ?? item.result?.final ?? item.result?.text
    ?? `${item.status ?? 'done'}: ${item.taskSummary ?? item.reason ?? 'Report'}`)).trim().replace(/\s+/g, ' ').slice(0, 200) || 'Report'
  const freezeReport = async item => {
    const execution = item.executionId ? rt.state.executions[item.executionId] : latestExecution(item.session)
    if (execution) {
      Object.assign(item, executionIds(execution))
      if (execution.result === undefined) {
        if (item.referenceId && !execution.references.includes(item.referenceId)) execution.references.push(item.referenceId)
        const legacy = await executionResultOf(execution, rt)
        const original = rt.redactDeepSecrets(item.result?.final ?? item.result?.text ?? (legacy.text || item.text || ''))
        const remaining = RESULTS_TEXT_MAX - Object.values(rt.state.executions).reduce((sum, entry) => sum + (entry.result?.text?.length ?? 0), 0)
        const body = original.slice(0, Math.max(0, Math.min(RESULT_TEXT_MAX, remaining)))
        execution.result = { text: body, completeness: body ? 'partial' : 'unavailable',
          reason: body && (item.result || !legacy.text) ? 'legacy-report' : legacy.reason, preview: body ? reportSummary({ summary: body }) : '', length: body.length, originalLength: original.length }
      }
      const result = await executionResultView(execution, rt)
      item.status = execution.status
      item.reason = execution.reason
      item.summary = result.preview || `${result.completeness}: ${result.reason}`
      const source = rt.conversationOf(item.session)
      const title = item.taskSummary ?? source?.session.name
      const completeness = result.completeness === 'complete' ? `complete, ${result.length.toLocaleString('en-US')} characters`
        : result.completeness === 'partial' ? `partial${result.reason ? ` (${result.reason})` : ''}, ${result.length.toLocaleString('en-US')} of ${(result.originalLength ?? result.length).toLocaleString('en-US')} characters`
        : `unavailable${result.reason ? ` (${result.reason})` : ''}`
      item.text = rt.redactDeepSecrets([
        `Report from ${source?.profile.name ?? 'executor'}${title ? ` · ${title}` : ''}${execution.files?.total ? ` · 改动 ${execution.files.total} 个文件${execution.files.source === 'workspace-snapshot' ? '（工作区快照，可能含其他改动）' : ''}` : ''}`,
        `Status: ${item.status}${item.reason && item.reason !== item.status ? ` · ${item.reason}` : ''}`,
        ...(result.preview ? [`Result preview: ${result.preview}`] : []),
        `Completeness: ${completeness}`,
        `Full result: nodo_context read executionId ${execution.id}`,
        ...(execution.supplementUnconfirmed ? ['补充未确认送达'] : []),
        ...(item.resumed ? ['Supplemental report after the user manually resumed this session in Nodo.'] : []),
      ].join('\n'))
      await rt.recordExecutionResult(execution.id, { report: item.summary })
    } else {
      item.summary ??= reportSummary(item)
      if (item.result) item.text = `Result: ${item.status}. Reason: ${item.reason}. Legacy report (no execution result handle available; reference data):\n${clip(rt.redactDeepSecrets(String(item.result.final ?? item.result.text ?? '(no reply)')), TRANSCRIPT_TEXT_MAX, 'legacy report')}`
      else item.text ??= `Result: ${item.status}. Reason: ${item.reason}. Legacy report preview (no execution result available): ${item.summary}`
    }
    delete item.result
    if (execution) delete item.referenceId
    await rt.saveStrict()
  }
  const finishReport = async (leadSession, item) => {
    const source = rt.conversationOf(item.session)?.session.source
    if (source?.pendingReport?.id === item.id) delete source.pendingReport
    leadSession.reportQueue = (leadSession.reportQueue ?? []).filter(report => report.id !== item.id)
    if (!leadSession.reportQueue.length) delete leadSession.reportQueue
    await rt.save()
  }
  const deliverReport = async (profileId, leadSession, item) => {
    if (rt.sessionBlockReason?.(leadSession.id)) return
    let found
    try { found = recipient(profileId, leadSession.id) }
    catch (error) {
      await unreported(item.session, error)
      await finishReport(leadSession, item)
      return
    }
    try {
      const { profile: lead, session } = found
      const delivered = rt.transcriptOf(session.id).find(line => line.origin?.reportId === item.id)
      if (delivered) {
        if (delivered.origin.reviewRequired && item.executionId) await rt.registerDeliveredReport(item, delivered.at)
        await finishReport(session, item)
        return
      }
      if (busy(session.id) || rt.awaitingAnswer?.(session.id) || rt.isCompacting?.(session.id)) return
      const placed = await rt.send(lead.id, item.text, session.id, [], item.referenceId ? [{ id: item.referenceId }] : [],
        { exclusive: true, brief: leadBrief(lead, session), origin: { kind: 'report', session: item.session, reportId: item.id, reviewRequired: true,
          ...(item.executionId ? { taskId: item.taskId, executionId: item.executionId, preview: rt.redactDeepSecrets(item.summary) } : {}) } })
      if (item.executionId) await rt.registerDeliveredReport(item, rt.transcriptOf(session.id).find(line => line.origin?.reportId === item.id)?.at)
      await finishReport(session, item)
      return placed
    } catch (error) {
      if (error.code === 'orch/busy') return
      // A lead saved outside the lead rules keeps the result queued until fixed;
      // say so once per result on the executor session instead of failing silently.
      if (error.code === 'orch/lead-invalid' && item.unreported !== true) {
        item.unreported = true
        await unreported(item.session, error)
      }
      rt.warn('nodo: report send failed (%s): %s', item.id, causeOf(error))
    }
  }
  const freezing = new Set()
  const queueReport = async (profileId, leadSession, session, result, pending, execution) => {
    if (pending && (leadSession.reportQueue?.some(item => item.id === pending.id)
      || rt.transcriptOf(leadSession.id).some(line => line.origin?.reportId === pending.id))) return
    const status = execution?.status ?? (result.unconfirmed ? 'unconfirmed' : result.reason === 'done' ? 'done' : 'failed')
    const item = { id: pending?.id ?? randomUUID(), profile: rt.conversationOf(session.id).profile.id, session: session.id, ...executionIds(execution),
      ...(execution ? { taskSummary: delegationSummary(session).task } : {}),
      status, reason: rt.redactDeepSecrets(result.reason), ...(result.resumed ? { resumed: true } : {}),
      ...(status === 'done' && !execution ? { result: rt.redactDeepSecrets({ replyId: result.replyId, final: result.final, text: result.text }) }
        : { text: rt.redactDeepSecrets(`Report from ${rt.conversationOf(session.id)?.profile.name ?? 'executor'} · ${delegationSummary(session)?.task ?? session.name}\nStatus: ${status}${result.reason && result.reason !== status ? ` · ${result.reason}` : ''}\nReference data; verify against files and evidence.`) }) }
    if (pending) pending.ready = true
    leadSession.reportQueue ??= []
    leadSession.reportQueue.push(item)
    freezing.add(item.id)
    try {
      if (status !== 'done') await note(leadSession.id, '',
        { delegation: { session: session.id, ...executionIds(execution), ended: result.reason, ...(result.unconfirmed ? { unconfirmed: true } : {}) } })
      await rt.save()
      await freezeReport(item)
    } finally { freezing.delete(item.id) }
    const state = stateOf(leadSession.id)
    if (leadSession.reportQueue?.[0] === item && !state.delivering) {
      return deliverReport(profileId, leadSession, item)
    }
  }
  const flushLeadReports = async id => {
    if (rt.readOnly?.()) return
    const found = rt.conversationOf(id)
    if (!found) return
    const sessionId = found.session.source?.kind === 'lead' ? found.session.source.leadSessionId : id
    const owner = rt.conversationOf(sessionId)
    const state = stateOf(sessionId)
    if (!owner) return
    // A request during a pass may follow a change that pass already read past: it
    // runs one more pass, and every caller settles with the last one.
    if (state.delivering) { state.again = true; return state.delivering }
    state.delivering = (async () => {
      do {
        state.again = false
        try {
          for (let item; (item = owner.session.reportQueue?.[0]) && !freezing.has(item.id);) {
            await freezeReport(item)
            const placed = await deliverReport(owner.profile.id, owner.session, item)
            if (placed) void rt.followLead(sessionId, placed)
            else if (owner.session.reportQueue?.[0] === item) break
          }
        } catch (error) {
          rt.warn('nodo: lead report failed (%s): %s', sessionId, error.message ?? error)
        }
      } while (state.again)
    })().finally(() => { state.delivering = undefined })
    return state.delivering
  }
  const headerOf = lead => rt.redactDeepSecrets(`Task from lead ${lead.name}. Start your report with a one-line outcome summary, actual verification results and unresolved issues.
Carry out the task as written. If something the task leaves open blocks you, list it in the report with the possible approaches.
Write the body as conclusions, marking file:line only after claims that need checking, such as defect root causes or review findings.

`)
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
  const begin = (state, session, details, execution) => {
    let settle
    const flight = { profile: rt.conversationOf(session.id).profile.id, session: session.id, ...executionIds(execution), inputs: new Map(),
      settled: new Promise(resolve => { settle = resolve }) }
    flight.settle = settle
    state.flights.set(session.id, flight)
    const { type, hard, task } = details
    const firstLine = task.trim().split(/\r?\n/, 1)[0]
    if (!execution) session.source.dispatch = { type, hard, task: firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine, status: 'running', acceptedAt: Date.now() }
    return flight
  }
  const release = (state, flight, result) => {
    if (state.flights.get(flight.session) === flight) state.flights.delete(flight.session)
    flight.settle(result)
  }
  const end = async (state, session, flight, result) => {
    const status = result.unconfirmed ? 'unconfirmed' : result.reason === 'done' ? 'done'
      : result.reason === 'interrupted' ? (flight.stoppedBy === 'lead' ? 'interrupted-lead' : 'interrupted-user') : 'failed'
    // A store adopt during execution replaces the session objects; the summary and
    // the caller's later writes must land on the current one.
    session = rt.conversationOf(session?.id ?? flight.session)?.session ?? session
    try {
      if (flight.executionId) {
        const execution = rt.state.executions[flight.executionId]
        if (['queued', 'running', 'unconfirmed'].includes(execution.status)) {
          const method = result.code === 'orch/decision-pending' ? 'cancelUnsentExecution' : result.unconfirmed ? 'unconfirmExecution' : result.reason === 'done' ? 'finishExecution'
            : result.reason === 'cancelled' ? 'cancelExecution' : result.reason === 'interrupted' ? 'interruptExecution' : 'failExecution'
          if (!(result.unconfirmed && execution.status === 'unconfirmed')) await rt[method](execution.id, { final: result.final, finalCapture: result.finalCapture,
            reason: result.code ?? (result.reason === 'interrupted' && flight.stoppedBy ? `interrupted-${flight.stoppedBy}` : result.reason) })
        }
      } else if (session) Object.assign(session.source.dispatch, { status, reason: result.reason, endedAt: Date.now(),
        ...(flight.stoppedBy ? { stoppedBy: flight.stoppedBy } : {}) })
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
  const stop = async (state, flight) => {
    // A user stop recorded first keeps its initiator.
    flight.stoppedBy ??= 'lead'
    if (flight.dispatch) {
      await cancelDispatch(state, flight)
      return { reason: flight.executionId ? 'cancelled' : 'interrupted' }
    }
    flight.stopping = true
    if (flight.executionId && rt.state.executions[flight.executionId].status === 'running') await rt.requestExecutionStop(flight.executionId)
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
      const found = rt.conversationOf(flight.session), session = found?.session
      await end(state, session, flight, result)
      if (!found) return result
      session.source.pendingReport ??= { id: randomUUID() }
      const owner = rt.conversationOf(session.source.leadSessionId)
      if (owner) {
        const placed = await queueReport(owner.profile.id, owner.session, session, result, session.source.pendingReport, flightExecution(flight))
        if (placed) void rt.followLead(owner.session.id, placed)
      }
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
    return { session, ...(flight.executionId ? { taskId: flight.taskId, executionId: flight.executionId } : {}), ended: result.reason, ...(result.unconfirmed ? { unconfirmed: true } : {}),
      lastOutput: clip(rt.redactDeepSecrets(String(result.final ?? result.text ?? rt.workView()[session]?.buffer ?? '')), 4000, 'last output') }
  }
  const track = async (lead, leadSession, session, flight, sent, header, manual = false) => {
    const state = stateOf(leadSession.id), target = rt.conversationOf(session.id).profile
    let result
    try {
      result = await completedWork(flight, sent)
      if (result.code === 'orch/decision-pending') return await cancelDispatch(state, flight, result)
      let retries = 0
      while (result.reason === 'error' && result.retryable && !result.unconfirmed && !flight.stopping && !flight.takenOver && !manual && !rt.sessionBlockReason?.(leadSession.id)) {
        session.source.pendingReport ??= { id: randomUUID() }
        flight.retrying = true
        await rt.save()
        if (flight.stopping || rt.sessionBlockReason?.(leadSession.id)) break
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
      session = await end(state, session, flight, result)
      const ok = result.reason === 'done' && !result.unconfirmed
      if (!ok || flight.stopping) {
        session.source.pendingReport ??= { id: randomUUID() }
        if (result.unconfirmed || !ok && result.reason !== 'interrupted') {
          return await queueReport(lead.id, leadSession, session, { ...result, resumed: manual }, session.source.pendingReport, flightExecution(flight))
        }
        await note(leadSession.id, '',
          { delegation: { session: session.id, ...(flight.executionId ? { taskId: flight.taskId, executionId: flight.executionId } : {}), ended: result.reason,
            ...(result.unconfirmed ? { unconfirmed: true } : {}), ...(flight.stoppedBy ? { stoppedBy: flight.stoppedBy } : {}) } })
        return
      }
      const pending = manual ? session.source.pendingReport : undefined
      if (!manual) delete session.source.pendingReport
      return await queueReport(lead.id, leadSession, session, { ...result, resumed: manual }, pending, flightExecution(flight))
    } catch (error) {
      if (state.flights.get(flight.session) === flight) {
        session = await end(state, session, flight, { reason: 'error', unconfirmed: true })
        session.source.pendingReport ??= { id: randomUUID() }
        return await queueReport(lead.id, leadSession, session, { reason: 'error', unconfirmed: true }, session.source.pendingReport, flightExecution(flight))
      }
      if (flight.executionId && !leadSession.reportQueue?.some(item => item.executionId === flight.executionId)) {
        session.source.pendingReport ??= { id: randomUUID() }
        await queueReport(lead.id, leadSession, session, result ?? { reason: 'error', unconfirmed: true }, session.source.pendingReport, flightExecution(flight))
      }
      await rt.save()
      rt.warn('nodo: delegation tracking failed (%s): %s', session.id, error.message ?? error)
    } finally { void flushLeadReports(leadSession.id) }
  }
  const dispatchTask = async (leadValue, command, taskRecord, details) => {
    const { profile: lead, session: leadSession } = ownerOf(leadValue)
    const state = stateOf(leadSession.id), header = headerOf(lead)
    const { trigger, stage = 'implement', sourceExecutionId, sourceReportId, questions, supplements = [] } = details
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
    const team = rt.teamOf(lead.id)
    const found = team && rt.findTeamType(team, command.type)
    if (!found) throw failure('type 必须是本团队任务类型清单中的 id', 'orch/unknown-type')
    const hard = command.hard, task = trigger.text
    const title = taskRecord?.title ?? rt.redactDeepSecrets(command.title ?? command.scope.quote ?? command.scope.note).trim().split(/\r?\n/, 1)[0].slice(0, 80)
    if (!title) throw failure('任务标题为空', 'orch/title-empty')
    const picked = route(team.assign, found.id, hard)
    const holder = rosterOf(lead).find(item => item.id === (stage === 'answer' ? rt.state.executions[sourceExecutionId].profileId : picked.profile) && item.id !== lead.id)
    if (!holder) throw failure(`没有承接「${found.name}」的角色`, 'orch/no-holder')
    picked.profile = holder
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
    if (stage !== 'answer') state.count = (state.count ?? 0) + 1
    let reserved = true
    let session, flight, execution, continued, createdWorkspace
    try {
      rt.persistTrigger(trigger)
      if (!sourceRecord && command.worktree) {
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
        stage, triggerId: trigger.id, scope: taskRecord.scope, supplements, sourceExecutionId, sourceReportId, questions })
      state.reserved--
      reserved = false
      flight = begin(state, session, { type: found.id, hard, task }, execution)
      flight.createdWorkspace = createdWorkspace?.id
      flight.tracking = true
      flight.dispatch = async () => {
        if (rt.sessionBlockReason?.(leadSession.id)) return cancelDispatch(state, flight)
        flight.dispatchStarted = true
        delete flight.dispatch
        let following
        try {
          const input = await rt.composeWorkerInput({ executionId: execution.id })
          if (flight.stopping || rt.sessionBlockReason?.(leadSession.id)) return await cancelDispatch(state, flight)
          await rt.startExecution(execution.id, input.inputContext)
          const sent = await rt.send(target.id, input.text, session.id, input.images, [], { exclusive: true, files: { paths: input.files }, limit: INPUT_CONTEXT_MAX, origin: { kind: 'delegation', ...executionIds(execution) } })
          following = track(lead, leadSession, session, flight, sent, header)
        } catch (error) {
          try { session = await end(state, session, flight, { reason: causeOf(error) }) }
          finally { await removeUnsentWorktree(createdWorkspace?.id) }
          following = queueReport(lead.id, leadSession, session, { reason: rt.redactDeepSecrets(String(error.message ?? error)) }, undefined, flightExecution(flight))
        }
        void following.then(next => next ? rt.followLead(leadSession.id, next) : flushLeadReports(leadSession.id))
          .catch(error => rt.warn('nodo: dispatch failed (%s): %s', flight.session, causeOf(error)))
      }
      session = rt.conversationOf(session.id)?.session ?? session
      delete session.source.pendingReport
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
        if (stage !== 'answer') state.count--
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
      if ([...tasks.values()].some(task => rt.taskFlowOf(task).status === 'frozen')) throw failure('旧任务只读', 'orch/frozen')
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
      await rt.decisionDeliveryReady?.(id)
      rt.assertDecisionDispatch?.(id)
      const unreviewed = rt.reportReviewBlockReason?.(id)
      if (unreviewed) throw Object.assign(invalid(unreviewed.message), unreviewed)
      if (typeof command.hard !== 'boolean') throw invalid('hard 必须是 true 或 false')
      if (command.worktree !== undefined && typeof command.worktree !== 'boolean') throw invalid('worktree 必须是 true 或 false')
      if (command.title !== undefined && (typeof command.title !== 'string' || command.title.length > 80)) throw failure('title 必须是最多 80 字的文本', 'orch/title-empty')
      if (command.continues && (command.parentId !== undefined || command.dependsOn !== undefined)) throw invalid('continues 与 parentId/dependsOn 互斥')
      if (command.parentId && (await ownedTask(owner, command.parentId)).status === 'done') throw invalid('父任务已验收')
      for (const value of command.dependsOn ?? []) {
        const dependency = await ownedTask(owner, value)
        if (dependency.status !== 'done') throw invalid(`依赖任务 ${dependency.title} 尚未验收，先完成它再派活`)
      }
      assertFlightCapacity(state, `此主控会话最多同时派活 ${MAX_ACTIVE_FLIGHTS} 个任务，请等一个结束后再派`)
      const storedScope = rt.redactDeepSecrets(scope)
      if (storedScope.note?.length > SCOPE_NOTE_MAX) throw failure('范围说明脱敏后超过 100 字', 'orch/scope-note-too-long')
      return dispatchTask(id, { ...command, scope: storedScope }, undefined, { trigger })
    }
    const task = await ownedTask(owner, command.taskId), flow = rt.taskFlowOf(task)
    if (flow.status === 'stalled') throw failure('任务已停滞，请另建任务', 'orch/task-stalled')
    if (!['running', 'reviewing', 'accepting'].includes(flow.status) || ['done', 'stopped'].includes(task.status)) throw failure('已结束、停止或旧任务只读', 'orch/frozen')
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
    const previousFlow = structuredClone(flow)
    Object.assign(rt.state.tasks[task.id].flow, { status: 'running', stage: 'rework', round: (flow.round ?? 1) + 1, supplementReworks: (flow.supplementReworks ?? 0) + 1 })
    let receipt
    try {
      receipt = await dispatchTask(id, { type: latest.type, hard: latest.hard }, task, { trigger, stage: 'rework',
        supplements: (execution.supplements ?? []).filter(value => value !== trigger.id), sourceExecutionId: latest.id })
    } catch (error) { rt.state.tasks[task.id].flow = previousFlow; throw error }
    const mode = flow.status === 'accepting' ? 'withdrew-card' : 'rework'
    if (flow.status === 'accepting') for (const card of Object.values(rt.state.cards)) if (card.taskId === task.id && card.status === 'open') Object.assign(card, { status: 'resolved', answer: 'supplement', answeredAt: Date.now() })
    await rt.saveStrict()
    return { ...receipt, delivery: { mode } }
  }
  const leadReview = async (id, command) => {
    const owner = ownerOf(id), execution = rt.state.executions[command.executionId]
    if (!execution) throw invalid('没有该 Execution')
    const task = await ownedTask(owner, execution.taskId)
    const { questions } = command
    if (questions !== undefined && (!Array.isArray(questions) || !questions.length || questions.length > REVIEW_QUESTIONS_MAX
      || questions.some(value => typeof value !== 'string' || !value.trim() || value.length > REVIEW_QUESTION_MAX))) throw invalid('questions 必须为 1–5 个非空问题，每题最多 200 字')
    if (command.disposition === 'investigate') {
      if (!questions) throw invalid('investigate 必须提供 questions')
      const flow = rt.taskFlowOf(task)
      if (flow.status === 'stalled') throw failure('任务已停滞', 'orch/task-stalled')
      if (!['running', 'reviewing'].includes(flow.status) || ['done', 'stopped'].includes(task.status)) throw failure('已结束、停止或旧任务只读，不能新增补答执行', 'orch/frozen')
      if (task.executions.some(item => ['queued', 'running', 'unconfirmed'].includes(item.status))) throw failure('任务已有未结束执行', 'orch/busy')
      assertFlightCapacity(stateOf(owner.session.id), `此主控会话最多同时派活 ${MAX_ACTIVE_FLIGHTS} 个任务`)
      rt.deliveredReports(task.id, execution.id)
      if (!execution.reports.some(report => !report.review || report.review.awaitingAnswer)) throw invalid('回报已复核')
      const trigger = rt.state.triggers[execution.triggerId]
      if (!trigger) throw invalid('执行的触发消息不存在')
      const previous = structuredClone(execution.reports)
      await rt.reviewReports(task.id, command)
      try {
        return await dispatchTask(id, { type: execution.type, hard: execution.hard }, task, { trigger, stage: 'answer', questions,
          sourceExecutionId: execution.id, sourceReportId: execution.reports.at(-1).id })
      } catch (error) { execution.reports = previous; await rt.saveStrict(); throw error }
    }
    const reviewed = await rt.reviewReports(task.id, command)
    return { ok: true, taskId: task.id, executionId: execution.id, review: reviewed.reports.at(-1).review }
  }
  const prepareLeadInput = async session => {
    const source = session.source
    if (source?.kind !== 'lead') return
    const state = stateOf(source.leadSessionId)
    let flight = state.flights.get(session.id)
    if (flight && (!flight.retrying || busy(session.id) && !flight.waiting)) {
      if (flight.retrying) flight.takenOver = true
      return flight
    }
    if ((!source.pendingReport || source.pendingReport.ready) && !['failed', 'unconfirmed', 'interrupted', 'interrupted-user', 'interrupted-lead'].includes(delegationSummary(session)?.status)) return
    if (!rt.conversationOf(source.leadSessionId)) return
    if (flight) {
      cancelLeadRetry(session.id, true)
      state.flights.delete(session.id)
    } else assertFlightCapacity(state, `此主控会话已有 ${MAX_ACTIVE_FLIGHTS} 个任务在执行，请等一个结束后再发送`)
    state.reserved++
    try {
      if (!source.pendingReport || source.pendingReport.ready) source.pendingReport = { id: randomUUID() }
      let execution = latestExecution(session.id)
      if (execution && !['queued', 'running', 'unconfirmed'].includes(execution.status)) {
        if ((await rt.taskView(execution.taskId)).status === 'stopped') await rt.reopenTask(execution.taskId)
        execution = await rt.acceptExecution(execution.taskId, { profileId: execution.profileId, sessionId: session.id,
          workspaceRef: execution.workspaceRef, type: source.type, hard: source.hard, model: session.model || undefined, thinking: session.thinking || undefined })
        await rt.startExecution(execution.id)
      }
      return begin(state, session, delegationSummary(session) ?? { type: source.type, hard: source.hard, task: session.name }, execution)
    } finally { state.reserved-- }
  }
  const followLeadReport = async (sessionId, placed, flight) => {
    if (!flight) {
      const source = rt.conversationOf(sessionId)?.session.source
      if ((source?.pendingReport || ['failed', 'unconfirmed', 'interrupted-user', 'interrupted-lead'].includes(delegationSummary(rt.conversationOf(sessionId)?.session ?? { id: sessionId })?.status))
        && !rt.conversationOf(source.leadSessionId)) {
        await placed.completion
        delete source.pendingReport
        await note(sessionId, UNREPORTED_GONE)
      }
      return
    }
    flight.inputs.set(placed.seq, placed.completion)
    if (flight.tracking) return
    flight.tracking = true
    const session = rt.conversationOf(sessionId).session, source = session.source
    const owner = rt.conversationOf(source.leadSessionId)
    if (!owner) {
      const result = await completedWork(flight, placed)
      await end(stateOf(source.leadSessionId), session, flight, result)
      delete source.pendingReport
      await note(sessionId, UNREPORTED_GONE)
      return
    }
    const next = await track(owner.profile, owner.session, session, flight, placed, headerOf(owner.profile), true)
    if (next) await rt.followLead(owner.session.id, next)
    void flushLeadReports(sessionId)
  }
  const followLead = async (sessionId, placed) => {
    let result
    try {
      if (placed.mode !== 'turn' && placed.mode !== 'queued') { void flushLeadReports(sessionId); return }
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
    void flushLeadReports(sessionId)
  }
  const cancelDispatch = async (state, flight, result = { reason: 'cancelled' }) => {
    delete flight.dispatch
    let session
    try { session = await end(state, rt.conversationOf(flight.session)?.session, flight, result) }
    finally { await removeUnsentWorktree(flight.createdWorkspace) }
    if (session) {
      if (!flight.executionId) session.source.dispatch.status = 'cancelled'
      delete session.source.pendingReport
      await note(session.source.leadSessionId, '', { delegation: { session: session.id,
        ...(flight.executionId ? { taskId: flight.taskId, executionId: flight.executionId } : {}), ended: 'cancelled',
        ...(flight.stoppedBy ? { stoppedBy: flight.stoppedBy } : {}) } })
    }
  }
  rt.ctx.effect(() => () => {
    for (const state of states.values()) for (const flight of state.flights.values()) {
      if (flight.dispatch) void cancelDispatch(state, flight).catch(error => rt.warn('nodo: queued cancellation failed: %s', causeOf(error)))
      else if (flight.waiting) flight.cancel()
    }
  }, 'nodo: lead retry timers')

  const recoverLeadDelegations = createLeadRecovery(rt, { stateOf, flightOf, latestExecutions, recovering, removeUnsentWorktree,
    causeOf, queueReport, cancelDispatch, note, flushLeadReports, unreportedGone: UNREPORTED_GONE })

  Object.assign(rt, {
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
    leadRoute, leadReview,
    leadDispatch: { interrupt: interruptDelegation },
    prepareLeadInput,
    resetLeadBudget: id => { stateOf(id).count = 0 },
    leadInputStarted: (id, attached, line) => {
      rt.clearPendingTrigger(id)
      if (rt.isUserTriggerLine(line)) rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: id, line }))
      rt.resetLeadBudget(id)
    },
    leadEnded: async (id, result) => {
      const session = rt.conversationOf(id)?.session
      const execution = latestExecution(id)
      if (execution?.status === 'unconfirmed' && !flightOf(id)) {
        await end(stateOf(session?.source?.leadSessionId), session, { ...executionIds(execution),
          stoppedBy: execution.reason?.startsWith('interrupted-') ? execution.reason.slice(12) : undefined, settle() {} }, result)
        const owner = rt.conversationOf(rt.state.tasks[execution.taskId].coordinatorSessionId)
        if (result.reason === 'done' && !result.unconfirmed && result.replyId && owner && session) {
          await freezeReport({ ...executionIds(execution), profile: execution.profileId, session: id,
            result: { replyId: result.replyId, text: result.text }, status: 'done', reason: result.reason, taskSummary: delegationSummary(session).task })
        }
        return
      }
      if (session?.source?.dispatch?.status === 'unconfirmed' && !flightOf(id)) {
        const state = stateOf(session.source.leadSessionId)
        await end(state, session, { stoppedBy: session.source.dispatch.stoppedBy, settle() {} }, result)
      }
    },
    recoverLeadDelegations,
    leadBrief, followLead, followLeadReport, flushLeadReports, cancelLeadRetry,
    leadRetryWaiting: id => flightOf(id)?.waiting === true })
}
