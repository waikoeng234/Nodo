import { randomUUID } from 'node:crypto'
import { FLOW_EXECUTIONS_MAX, STAGE_ROUNDS_MAX, REWORK_MAX_DEFAULT, REPORT_DELIVERY_FAILURES_MAX, ANSWER_TEXT_MAX } from './constants.js'
import { route } from '../shared/route.js'
import { leadModeOf } from '../shared/lead.js'
import { invalid, failure } from './errors.js'

export const flowOf = type => type?.flow ?? { reviewType: 'review', maxRework: REWORK_MAX_DEFAULT }
const statusOf = { running: 'open', reviewing: 'review', accepting: 'blocked', stalled: 'blocked', accepted: 'done', stopped: 'stopped' }
const counted = new Set(['rework-limit', 'hard-cap', 'stage-rounds'])
const retryOf = { 'execution-failed': 'restart-stage', 'verdict-unreadable': 'rerun-review', 'review-unavailable': 'check-review-type',
  'delivery-failed': 'redeliver-report', 'lead-error': 'redeliver-report', 'accept-blocked': 'check-acceptance' }

export function install(rt) {
  const { state } = rt
  const executionsOf = task => Object.values(state.executions).filter(item => item.taskId === task.id)
  const implementationOf = task => executionsOf(task).findLast(item => ['implement', 'rework'].includes(item.stage))
  const stageOf = execution => execution.stage === 'answer' ? stageOf(state.executions[execution.sourceExecutionId]) : execution.stage
  const phaseOf = execution => execution.stage === 'answer' ? phaseOf(state.executions[execution.sourceExecutionId]) : execution.id
  const ownerOf = id => {
    const owner = rt.conversationOf(id)
    if (!owner || !leadModeOf(owner.profile, owner.session)) throw invalid('请选择有效的主控会话')
    return owner
  }
  const syncTaskFlow = task => { if (statusOf[task.flow?.status]) task.status = statusOf[task.flow.status] }
  const resolveCards = (task, answer) => {
    for (const card of Object.values(state.cards)) if (card.taskId === task.id && card.status === 'open') {
      Object.assign(card, { status: 'resolved', answer, answeredAt: Date.now() })
    }
  }
  const payloadOf = task => {
    const executions = executionsOf(task)
    const source = implementationOf(task), review = executions.findLast(item => item.stage === 'review')
    const missedFlags = [...new Set(executions.flatMap(item => item.reportData?.missedFlags ?? []))]
    return { scope: structuredClone(task.scope), trigger: { id: task.triggerId, summary: state.triggers[task.triggerId]?.text.slice(0, 300) ?? '' },
      stages: executions.map(item => ({ executionId: item.id, stage: item.stage, status: item.status,
        summary: item.reportData?.summary ?? item.result?.preview ?? '', outcome: item.reportData?.outcome ?? item.status,
        ...(item.reportData?.verdict ? { verdict: item.reportData.verdict } : {}),
        structured: item.reportData?.structured === true, questions: item.questions ?? [],
        supplementUnconfirmed: item.supplementUnconfirmed === true })),
      evidence: executions.map(item => ({ executionId: item.id, sourceId: `evidence:${item.id}`, evidence: item.evidence ?? null })),
      missedFlags, missedFlagsCount: missedFlags.length,
      recommendAccept: !!source && !(source.reportData?.verified ?? []).some(item => item.result === 'fail')
        && (!rt.needsFlowReview(source) || review?.sourceExecutionId === source.id && review.reportData?.verdict === 'pass') }
  }
  const putCard = (task, kind) => {
    let card = Object.values(state.cards).find(item => item.taskId === task.id && item.status === 'open')
    if (card && card.kind !== kind) { resolveCards(task, kind); card = undefined }
    const stalled = task.flow.stalled
    const options = kind === 'acceptance' ? ['accept', 'return'] : [...(counted.has(stalled.reason) ? [] : ['retry']), 'stop', 'change-scope']
    const question = { id: kind, question: kind === 'acceptance' ? '接受此任务的结果？' : `任务停滞：${stalled.reason}`,
      whyUser: kind === 'acceptance' ? '请验收任务结果' : '请选择下一步', options }
    const payload = payloadOf(task)
    if (kind === 'acceptance' && payload.recommendAccept) question.recommendation = 'accept'
    if (kind === 'stall') Object.assign(payload, { reason: stalled.reason, retryAction: retryOf[stalled.reason] ?? null, gaps: stalled.gaps ?? [] })
    if (!card) {
      card = { id: randomUUID(), coordinatorSessionId: task.coordinatorSessionId, taskId: task.id, kind, status: 'open', createdAt: Date.now() }
      state.cards[card.id] = card
    }
    Object.assign(card, { question, payload })
    return card
  }
  const stallFlow = (task, reason, execution, gaps) => {
    if (!task.flow || ['accepted', 'stopped'].includes(task.flow.status)) return
    Object.assign(task.flow, { status: 'stalled', stalled: { reason, ...(execution ? { executionId: execution.id } : {}), ...(gaps ? { gaps } : {}) } })
    syncTaskFlow(task)
    return putCard(task, 'stall')
  }
  const needsFlowReview = execution => {
    if (!['implement', 'rework'].includes(execution.stage)) return false
    const report = execution.reportData
    const previous = state.executions[execution.sourceExecutionId]
    return previous?.stage === 'review' && previous.reportData?.verdict === 'fail'
      || !report?.reviewFlags || Object.values(report.reviewFlags).some(value => value === true)
      || !report.verified?.length || report.verified.some(item => item.result !== 'pass')
  }
  const reviewTypeOf = task => {
    const source = implementationOf(task), team = rt.teams().find(item => item.id === task.teamId)
    const type = team?.types.find(item => item.id === flowOf(team.types.find(item => item.id === source?.type)).reviewType)
    const pick = type && route(team.assign, type.id, source.hard)
    return type?.independent && team.members.includes(pick.profile) && state.profiles[pick.profile] && !state.profiles[pick.profile].deletedAt ? type : undefined
  }
  const checkFlowCapacity = (task, stage, source) => {
    const executions = executionsOf(task)
    const reason = executions.length >= FLOW_EXECUTIONS_MAX ? 'hard-cap'
      : stage === 'answer' && executions.filter(item => phaseOf(item) === phaseOf(source)).length >= STAGE_ROUNDS_MAX ? 'stage-rounds' : undefined
    if (reason) { stallFlow(task, reason, source); return false }
    return true
  }
  const dispatch = async (task, { stage, source, trigger = state.triggers[task.triggerId], supplements = [], immediate = false, resumed = false, supplement = false }) => {
    if (!checkFlowCapacity(task, stage, source)) { await rt.saveStrict(); return }
    const implement = implementationOf(task), reviewType = stage === 'review' ? reviewTypeOf(task) : undefined
    if (stage === 'review' && !reviewType) { stallFlow(task, 'review-unavailable', source); await rt.saveStrict(); return }
    const previous = structuredClone(task.flow)
    if (supplement) task.flow.supplementReworks = (task.flow.supplementReworks ?? 0) + 1
    const reviewed = stage === 'review' && source.stage === 'review' ? state.executions[source.sourceExecutionId] : source
    const flowStage = stage === 'answer' ? stageOf(source) : stage
    Object.assign(task.flow, { status: flowStage === 'review' ? 'reviewing' : 'running', stage: flowStage, round: (task.flow.round ?? 1) + 1 })
    delete task.flow.stalled
    syncTaskFlow(task)
    let receipt
    try {
      receipt = await rt.dispatchFlowExecution(task, { type: stage === 'answer' ? source.type : reviewType?.id ?? implement.type, hard: stage === 'answer' ? source.hard : implement.hard,
        profileId: stage === 'answer' ? source.profileId : stage === 'review' ? undefined : implement.profileId, stage,
        sourceExecutionId: stage === 'answer' ? source.sourceExecutionId : reviewed.id, trigger, supplements,
        resumed, ...(stage === 'answer' ? { sourceReportId: source.sourceReportId, questions: source.questions } : {}) })
    } catch (error) {
      task.flow = previous
      syncTaskFlow(task)
      if (['orch/busy', 'orch/decision-pending'].includes(error.code)) throw error
      stallFlow(task, 'execution-failed', source, [error.message])
      await rt.saveStrict()
      return
    }
    resolveCards(task, stage === 'rework' && trigger.id !== task.triggerId ? 'supplement' : 'retry')
    await rt.saveStrict()
    if (immediate) await rt.startFlowExecution(receipt.executionId)
    return receipt
  }
  const openAcceptance = task => {
    task.flow.status = 'accepting'
    delete task.flow.stalled
    syncTaskFlow(task)
    putCard(task, 'acceptance')
  }
  const reworkFlow = (task, { trigger, supplements = [], source = implementationOf(task), immediate = false, supplement = false } = {}) =>
    dispatch(task, { stage: 'rework', source, trigger, supplements, immediate, supplement })
  const advanceFlow = async execution => {
    const task = state.tasks[execution.taskId]
    if (!task.flow || !['running', 'reviewing'].includes(task.flow.status) || execution.flowContinued) return
    execution.flowContinued = true
    let source = execution
    while (source.stage === 'answer') source = state.executions[source.sourceExecutionId]
    if (execution.status !== 'done' || ['blocked', 'failed'].includes(execution.reportData?.outcome)
      || source.status !== 'done' || ['blocked', 'failed'].includes(source.reportData?.outcome)) stallFlow(task, 'execution-failed', execution)
    else if (executionsOf(task).length >= FLOW_EXECUTIONS_MAX) stallFlow(task, 'hard-cap', execution)
    else if (source.stage === 'review') {
      if (source.supplements?.length) {
        const trigger = state.triggers[source.supplements.at(-1)]
        return reworkFlow(task, { trigger, supplements: source.supplements.slice(0, -1), supplement: true,
          source: source.reportData?.verdict === 'fail' ? source : implementationOf(task) })
      }
      const verdict = source.reportData?.verdict
      if (verdict === 'pass') openAcceptance(task)
      else if (verdict !== 'fail') stallFlow(task, 'verdict-unreadable', source)
      else {
        const implement = implementationOf(task), team = rt.teams().find(item => item.id === task.teamId)
        if ((task.flow.rework ?? 0) >= flowOf(team?.types.find(item => item.id === implement.type)).maxRework) stallFlow(task, 'rework-limit', source)
        else { task.flow.rework = (task.flow.rework ?? 0) + 1; return dispatch(task, { stage: 'rework', source }) }
      }
    } else if (needsFlowReview(source)) return dispatch(task, { stage: 'review', source })
    else openAcceptance(task)
    await rt.saveStrict()
  }
  const flowExecutionEnded = execution => {
    const task = state.tasks[execution.taskId]
    if (!task.flow) return
    if (['interrupted-user', 'interrupted-lead'].includes(execution.reason)) {
      task.flow.status = 'stopped'; resolveCards(task, 'stop'); syncTaskFlow(task); rt.releaseTaskTriggers(task.id)
    } else if (execution.status !== 'done' && !['accepted', 'stopped'].includes(task.flow.status)) stallFlow(task, 'execution-failed', execution)
    syncTaskFlow(task)
  }
  const cardOf = (id, cardId) => {
    ownerOf(id)
    const card = state.cards[cardId]
    if (!card || card.coordinatorSessionId !== id || state.tasks[card.taskId]?.coordinatorSessionId !== id) throw invalid('卡片不存在或不属于本主控会话')
    return card
  }
  const accept = async (task, card, answer) => {
    const executionIds = executionsOf(task).map(item => item.id)
    const reason = answer.reason || '用户接受任务结果', basis = card.payload.evidence.map(item => item.sourceId)
    try { await rt.completeTask(task.id, { reason, basis, executionIds, cardId: card.id, answer }) }
    catch (error) {
      if (!['orch/invalid', 'orch/decision-pending'].includes(error.code)) throw error
      stallFlow(task, 'accept-blocked', executionsOf(task).at(-1), [error.message])
      await rt.saveStrict()
      return
    }
  }
  const answerFlowCard = async (id, { cardId, action, reason }) => {
    await rt.load()
    const owner = ownerOf(id)
    if (rt.readOnly() !== undefined) throw failure(rt.readOnly(), 'orch/read-only')
    rt.assertSessionWritable(owner.profile, owner.session)
    const card = cardOf(id, cardId), task = state.tasks[card.taskId]
    if (card.status !== 'open') throw invalid('卡片已作答')
    if (!card.question.options.includes(action)) throw invalid('卡片不支持此选项')
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > ANSWER_TEXT_MAX)) throw invalid('reason 必须是上限内的文本')
    if (['return', 'change-scope'].includes(action) && !reason?.trim()) throw invalid('请填写退回理由或新的范围')
    if (action === 'change-scope') throw failure('改变范围待后续实现，请先终止或另建任务', 'orch/not-supported')
    const answer = rt.redactDeepSecrets({ action, ...(reason !== undefined ? { reason } : {}) })
    if (action === 'accept') await accept(task, card, answer)
    else if (action === 'return') {
      const trigger = rt.triggerFromReturn({ coordinatorSessionId: id, text: reason, cardId })
      rt.persistTrigger(trigger)
      Object.assign(card, { status: 'rejected', answer, answeredAt: Date.now() })
      await reworkFlow(task, { trigger, immediate: true })
    } else if (action === 'stop') {
      await rt.leadRoute(id, { action: 'stop', taskIds: [task.id] })
      Object.assign(card, { status: 'resolved', answer, answeredAt: Date.now() })
      await rt.saveStrict()
    } else {
      const { reason: stalledReason, executionId } = task.flow.stalled
      const source = state.executions[executionId] ?? executionsOf(task).at(-1)
      if (stalledReason === 'accept-blocked') await accept(task, card, answer)
      else if (['delivery-failed', 'lead-error'].includes(stalledReason)) {
        const resumedStatus = stageOf(source) === 'review' ? 'reviewing' : 'running'
        task.flow.status = resumedStatus; delete task.flow.stalled; syncTaskFlow(task)
        Object.assign(card, { status: 'resolved', answer, answeredAt: Date.now() })
        await rt.saveStrict()
        await rt.redeliverFlowReport(source)
      } else {
        if (source.status === 'unconfirmed') await rt.interruptExecution(source.id, { reason: 'retry' })
        await dispatch(task, { stage: stalledReason === 'review-unavailable' || stalledReason === 'verdict-unreadable' ? 'review' : source.stage,
          source, trigger: state.triggers[source.triggerId], immediate: true, resumed: true })
        if (card.status === 'resolved') {
          Object.assign(card, { answer, answeredAt: Date.now() })
          await rt.saveStrict()
        }
      }
    }
    return structuredClone(card)
  }
  const flowReportStalled = (execution, report, reason) => {
    const task = state.tasks[execution.taskId]
    if (!task.flow || !['running', 'reviewing'].includes(task.flow.status) || report.flowStalled) return
    report.flowStalled = true
    stallFlow(task, reason, execution)
    return true
  }
  Object.assign(rt, { flowOf, syncTaskFlow, stallFlow, needsFlowReview, checkFlowCapacity, advanceFlow, reworkFlow, flowExecutionEnded, answerFlowCard,
    listFlowCards: id => { ownerOf(id); return structuredClone(Object.values(state.cards).filter(card => card.coordinatorSessionId === id)) },
    getFlowCard: (id, cardId) => structuredClone(cardOf(id, cardId)),
    flowReportDeliveryFailed: async (execution, report) => {
      if (!state.tasks[execution.taskId].flow) return
      report.deliveryFailures = (report.deliveryFailures ?? 0) + 1
      if (report.deliveryFailures >= REPORT_DELIVERY_FAILURES_MAX) flowReportStalled(execution, report, 'delivery-failed')
      await rt.saveStrict()
    },
    flowLeadFailed: async id => {
      let changed = false
      for (const execution of Object.values(state.executions)) if (state.tasks[execution.taskId].coordinatorSessionId === id) {
        for (const report of execution.reports ?? []) if (!report.review || report.review.awaitingAnswer) changed = flowReportStalled(execution, report, 'lead-error') || changed
      }
      if (changed) await rt.saveStrict()
    },
    recoverFlowCards: () => {
      if (rt.readOnly() !== undefined) return
      for (const task of Object.values(state.tasks)) {
        syncTaskFlow(task)
        if (['accepting', 'stalled'].includes(task.flow?.status)) putCard(task, task.flow.status === 'accepting' ? 'acceptance' : 'stall')
        else resolveCards(task, 'recovered')
      }
    } })
}
