import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { TASK_TEXT_MAX, ANSWER_TEXT_MAX } from './constants.js'
import { failure, invalid } from './errors.js'
import { leadModeOf } from '../shared/lead.js'

const unfinished = decision => decision.status === 'pending' || decision.status === 'answered'
const text = (value, name, max = TASK_TEXT_MAX) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${name} 必须是非空文本，最多 ${max} 字符`)
  return value
}
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('包含不支持的决策参数')
}
const ids = (value, name) => {
  if (!Array.isArray(value)) throw invalid(`${name} 必须是字符串数组`)
  return [...new Set(value.map(id => text(id, name)))]
}

export function install(rt) {
  const { state } = rt
  const deliveries = new Map(), handoffs = new Map()
  const ownerOf = id => {
    const owner = rt.conversationOf(id)
    if (!owner || !leadModeOf(owner.profile, owner.session)) throw invalid('请选择有效的主控会话')
    return owner
  }
  const writable = id => {
    const owner = ownerOf(id)
    if (rt.readOnly()) throw failure(rt.readOnly(), 'orch/read-only')
    rt.assertSessionWritable(owner.profile, owner.session)
    return owner
  }
  const decisionOf = (id, decisionId) => {
    ownerOf(id)
    const decision = state.decisions[decisionId]
    if (!decision || decision.coordinatorSessionId !== id) throw invalid('决策不存在或不属于本会话')
    return decision
  }
  const sessionBlockReason = id => {
    const decision = Object.values(state.decisions).find(item => item.coordinatorSessionId === id && unfinished(item))
    if (decision) return { code: 'orch/decision-pending', decisionId: decision.id, message: '当前会话正在等待用户决定，不能继续派活。' }
  }
  const assertDecisionDispatch = id => {
    const reason = sessionBlockReason(id)
    if (reason) throw Object.assign(failure(reason.message, reason.code), { decisionId: reason.decisionId })
  }
  const decisionView = ({ request, acceptanceTaskIds, ...decision }) => rt.redactDeepSecrets(structuredClone({ ...decision,
    dispatchBlocked: unfinished(decision), ...(unfinished(decision) ? { runningExecutions: rt.leadDecisionExecutions(decision.coordinatorSessionId) } : {}) }))
  const listDecisions = id => { ownerOf(id); return Object.values(state.decisions).filter(item => item.coordinatorSessionId === id).map(decisionView) }
  const getDecision = (id, decisionId) => decisionView(decisionOf(id, decisionId))
  const response = (decision, message) => ({ decisionId: decision.id, status: decision.status, dispatchBlocked: unfinished(decision),
    cancelledQueuedExecutionIds: decision.cancelledQueuedExecutionIds ?? [], runningExecutions: rt.leadDecisionExecutions(decision.coordinatorSessionId),
    decision: decisionView(decision), message })
  const ancestors = taskIds => {
    const result = new Set(taskIds)
    for (const id of result) { const parent = state.tasks[id]?.parentId; if (parent) result.add(parent) }
    return [...result]
  }
  const createDecision = async (id, raw) => {
    await rt.load()
    const { session } = writable(id)
    keys(raw, ['taskIds', 'executionIds', 'questions', 'references', 'stopExecutionIds'])
    const taskIds = ids(raw.taskIds ?? [], 'taskIds'), executionIds = ids(raw.executionIds ?? [], 'executionIds')
    const stopExecutionIds = ids(raw.stopExecutionIds, 'stopExecutionIds'), references = ids(raw.references ?? [], 'references')
    if (!Array.isArray(raw.questions) || !raw.questions.length) throw invalid('questions 不能为空')
    const questions = raw.questions.map(question => {
      keys(question, ['id', 'question', 'whyUser', 'options', 'recommendation'])
      const result = { id: text(question.id, '问题 id'), question: text(question.question, 'question'), whyUser: text(question.whyUser, 'whyUser') }
      if (question.options !== undefined) {
        if (!Array.isArray(question.options) || !question.options.length) throw invalid('options 不能为空')
        result.options = question.options.map(option => {
          keys(option, ['id', 'label', 'consequence'])
          return { id: text(option.id, '选项 id'), label: text(option.label, 'label'), consequence: text(option.consequence, 'consequence') }
        })
        if (new Set(result.options.map(option => option.id)).size !== result.options.length) throw invalid('选项 id 不能重复')
      }
      if (question.recommendation !== undefined) {
        keys(question.recommendation, ['optionId', 'reason'])
        const { optionId, reason } = question.recommendation
        if (!result.options?.some(option => option.id === optionId)) throw invalid('推荐必须指向已有选项')
        result.recommendation = { optionId, reason: text(reason, '推荐原因') }
      }
      return result
    })
    if (new Set(questions.map(question => question.id)).size !== questions.length) throw invalid('问题 id 不能重复')
    const request = rt.redactDeepSecrets({ taskIds, sourceExecutionIds: executionIds, questions, references, stopExecutionIds })
    if (JSON.stringify(request).length > TASK_TEXT_MAX) throw invalid(`决策请求最多 ${TASK_TEXT_MAX} 字符`)
    for (const taskId of taskIds) await rt.ownedTask({ session }, taskId)
    for (const executionId of executionIds) {
      const execution = state.executions[executionId]
      if (!execution) throw invalid('来源执行不存在')
      await rt.ownedTask({ session }, execution.taskId)
      rt.deliveredReports(execution.taskId, executionId)
    }
    for (const reference of references) {
      try { await rt.readReference({ id: reference, target: session.engine === 'dsh' ? session.driverSessionId : id }) }
      catch (error) {
        if (error.code !== 'orch/invalid') throw error
        throw invalid(`references 中的 ${JSON.stringify(reference)} 无效：${error.message} 只接受本会话已有的引用 id（来自附件/board），不是文件路径；没有可用引用就省略 references。`)
      }
    }
    const existing = Object.values(state.decisions).find(item => item.coordinatorSessionId === id && unfinished(item))
    if (existing) return response(existing, isDeepStrictEqual(existing.request, request) ? '该决策已保存，请等待用户回答。' : '本会话已有待处理决策，不能覆盖原问题。')
    const active = new Set(rt.leadDecisionExecutions(id).filter(item => item.active).map(item => item.executionId))
    if (stopExecutionIds.some(executionId => !active.has(executionId))) throw invalid('只能停止本主控当前活跃的执行')
    const decision = { id: randomUUID(), coordinatorSessionId: id, ...structuredClone(request), request: structuredClone(request),
      acceptanceTaskIds: ancestors([...taskIds, ...executionIds.map(executionId => state.executions[executionId].taskId)]),
      status: 'pending', createdAt: Date.now(),
      ...(session.lastTurn?.reason === 'interrupted' && !rt.workView()[id]?.active ? { handoffStopped: true } : {}) }
    state.decisions[decision.id] = decision
    const reports = executionIds.flatMap(executionId => {
      const reports = state.executions[executionId].reports, pending = reports.filter(report => !report.review)
      return pending.length ? pending : reports.slice(-1)
    })
    const previous = reports.map(report => report.review)
    for (const report of reports) report.review = { ...report.review, disposition: 'ask', decisionId: decision.id, reviewedAt: decision.createdAt }
    try { await rt.saveStrict() } catch (error) {
      delete state.decisions[decision.id]
      reports.forEach((report, index) => { if (previous[index]) report.review = previous[index]; else delete report.review })
      throw error
    }
    Object.assign(decision, await rt.pauseLeadForDecision(id, stopExecutionIds))
    await rt.saveStrict()
    return response(decision, '待决事项已保存，已暂停新的派活和排队发送。请结束本轮，等待用户回答。')
  }
  const assertDecisionAcceptance = task => {
    const reason = sessionBlockReason(task.coordinatorSessionId)
    if (!reason) return
    const decision = state.decisions[reason.decisionId]
    const related = ancestors([...decision.taskIds, ...decision.sourceExecutionIds.map(id => state.executions[id].taskId)])
    if (!decision.acceptanceTaskIds.length || [...decision.acceptanceTaskIds, ...related].includes(task.id)) {
      throw Object.assign(failure('该任务仍有待处理的用户决策，不能验收。', reason.code), { decisionId: decision.id })
    }
  }
  const deliverDecision = async id => {
    if (deliveries.has(id) || rt.readOnly()) return
    const owner = rt.conversationOf(id)
    const decision = Object.values(state.decisions).find(item => item.coordinatorSessionId === id && item.status === 'answered')
    if (!decision || !owner || owner.session.archivedAt || owner.profile.deletedAt || decision.handoffStopped) return
    const delivery = (async () => {
      const evidence = rt.transcriptOf(id).find(line => line.kind === 'decision-delivery' && line.origin?.decisionId === decision.id)
      if (evidence) {
        decision.status = 'delivered'
        decision.delivery = { inputId: evidence.origin.inputId, startedAt: evidence.at, turnId: evidence.turnId }
        try { await rt.saveStrict() } catch (error) { decision.status = 'answered'; delete decision.delivery; throw error }
        return
      }
      const inputId = randomUUID()
      const text = `用户已回答决策 ${decision.id}。请按用户原话及附加约束修订计划，再重新派活；核对取消结果，不要恢复旧排队执行。`
      const brief = JSON.stringify({ questions: decision.questions, answer: decision.answer, cancelledQueuedExecutionIds: decision.cancelledQueuedExecutionIds ?? [],
        cancellationErrors: decision.cancellationErrors ?? [], runningExecutions: rt.leadDecisionExecutions(id) })
      const placed = await rt.send(owner.profile.id, text, id, [], [], { brief, queue: true, origin: { kind: 'decision', decisionId: decision.id, inputId },
        cancelled: () => decision.handoffStopped === true || decision.status !== 'answered' })
      void rt.followLead(id, placed)
      await placed.completion
    })().catch(error => rt.warn('nodo: decision delivery failed (%s): %s', decision.id, error.message))
      .finally(() => deliveries.delete(id))
    deliveries.set(id, delivery)
  }
  const decisionInputStarted = (id, origin, turnId, accepted) => {
    if (origin?.kind !== 'decision') return
    const handoff = (async () => {
      await accepted
      const decision = decisionOf(id, origin.decisionId)
      if (decision.status !== 'answered' || decision.handoffStopped || rt.readOnly()) return
      const delivery = { inputId: origin.inputId, startedAt: Date.now(), turnId }
      const line = rt.appendLine(id, { who: 'system', kind: 'decision-delivery', origin, turnId, at: delivery.startedAt })
      decision.delivery = delivery
      decision.status = 'delivered'
      try { await rt.saveStrict() } catch (error) {
        decision.status = 'answered'
        delete decision.delivery
        line.kind = 'decision-delivery-failed'
        rt.touchLine(id, line)
        throw error
      }
      rt.resetLeadBudget(id)
    })()
    handoffs.set(id, handoff)
    void handoff.catch(error => rt.warn('nodo: decision handoff failed (%s): %s', origin.decisionId, error.message))
    return handoff
  }
  const answerDecision = async (id, { decisionId, answers }) => {
    await rt.load()
    writable(id)
    const decision = decisionOf(id, decisionId)
    if (decision.status !== 'pending') return response(decision, '该决策已回答或已结束，不能重复提交或覆盖答案。')
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.keys(answers).length !== decision.questions.length || Object.keys(answers).some(key => !decision.questions.some(question => question.id === key))) return response(decision, '请完整回答全部问题，不能包含未知问题。')
    for (const question of decision.questions) {
      const value = answers[question.id]
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 1
        || !(typeof value.text === 'string' && value.text.trim() && value.text.length <= ANSWER_TEXT_MAX
          || typeof value.optionId === 'string' && question.options?.some(option => option.id === value.optionId))) return response(decision, '答案无效：请选择有效选项或填写非空自定义回答。')
    }
    const answer = rt.redactDeepSecrets({ values: structuredClone(answers), userMessageId: randomUUID(), submittedAt: Date.now() })
    decision.answer = answer
    decision.status = 'answered'
    const line = rt.appendLine(id, { id: answer.userMessageId, who: 'user', kind: 'text', text: `决策回答：${JSON.stringify(answer.values)}`, origin: { kind: 'decision-answer', decisionId } })
    try { await rt.saveStrict() } catch (error) {
      decision.status = 'pending'
      delete decision.answer
      line.kind = 'decision-answer-failed'
      line.origin.kind = 'decision-answer-failed'
      rt.touchLine(id, line)
      throw error
    }
    void deliverDecision(id)
    return response(decision, '答案已保存，等待交给主控的新轮次。')
  }
  const cancelDecision = async (id, { decisionId }) => {
    await rt.load()
    writable(id)
    const decision = decisionOf(id, decisionId)
    if (decision.status !== 'pending') return response(decision, '该决策已回答或已结束，不能撤销；已提交答案保留。')
    decision.status = 'cancelled'
    try { await rt.saveStrict() } catch (error) { decision.status = 'pending'; throw error }
    const question = decision.questions[0]?.question
    rt.appendLine(id, { who: 'system', kind: 'note',
      text: `已撤销决策${question ? `「${question.slice(0, 80)}」` : ''}：未批准推荐方案，也不会恢复旧派活。`,
      origin: { kind: 'decision-cancel', decisionId } })
    await rt.save()
    void rt.flushLeadReports(id)
    return response(decision, '决策已撤销；这不表示批准推荐方案，也不会恢复旧派活。')
  }
  Object.assign(rt, { createDecision, answerDecision, cancelDecision, listDecisions, getDecision, sessionBlockReason, assertDecisionDispatch, assertDecisionAcceptance,
    decisionsView: () => {
      const recent = new Map()
      for (const decision of Object.values(state.decisions).reverse()) {
        if (unfinished(decision)) continue
        const kept = recent.get(decision.coordinatorSessionId) ?? []
        if (kept.length < 10) kept.push(decision.id)
        recent.set(decision.coordinatorSessionId, kept)
      }
      return Object.values(state.decisions).filter(decision => unfinished(decision) || recent.get(decision.coordinatorSessionId).includes(decision.id)).map(decisionView)
    },
    deliverDecision, decisionInputStarted, decisionDeliveryReady: id => handoffs.get(id)?.catch(() => {}),
    stopDecisionDelivery: async id => {
      const decision = Object.values(state.decisions).find(item => item.coordinatorSessionId === id && unfinished(item))
      if (decision) { decision.handoffStopped = true; await rt.saveStrict() }
    },
    resumeDecisionDelivery: async id => {
      const decision = Object.values(state.decisions).find(item => item.coordinatorSessionId === id && unfinished(item))
      if (decision) { delete decision.handoffStopped; await rt.saveStrict(); void deliverDecision(id) }
    },
    recoverDecisions: () => { for (const decision of Object.values(state.decisions)) if (decision.status === 'answered') void deliverDecision(decision.coordinatorSessionId) } })
}
