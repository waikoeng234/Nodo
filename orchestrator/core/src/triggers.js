// Trigger messages: the verbatim user originals a lead round routes with. A
// round's trigger lives in memory until a route binds it to a task, only then
// it lands in state.triggers and counts against the per-session quota. The
// user original is told by the line's origin alone — the userInput send flag
// is runtime-only and must not become a criterion.
import { createHash, randomUUID } from 'node:crypto'
import { TASK_TEXT_MAX, TRIGGER_TEXT_TOTAL_MAX } from './constants.js'
import { failure, invalid } from './errors.js'

export const TRIGGER_FULL_MESSAGE = '触发消息存储已满。请清理停滞或已结束的任务，再派新活。'
// Answered decision cards rebuild their text from decision.answer.values; the
// handle still points at the transcript line that echoed the raw values.
export const decisionAnswerText = decision => decision.questions.map(question => {
  const answer = decision.answer?.values?.[question.id]
  const text = !answer ? '（未回答）'
    : answer.text ?? question.options?.find(option => option.id === answer.optionId)?.label ?? '（答案指向的选项不存在）'
  return `问题：${question.question}\n回答：${text}`
}).join('\n\n')

export function install(rt) {
  // Coordinator session id → pending trigger record. Never saved: after a
  // restart no round is open, so every route reads orch/no-trigger.
  const pending = new Map()
  const messageHash = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8)

  const isUserTriggerLine = line => line?.who === 'user' && line.kind === 'text'
    && (line.origin === undefined || ['user', 'task', 'decision-answer'].includes(line.origin.kind))

  const recordOf = ({ coordinatorSessionId, origin, text, at, eventId, handle, images = [], files = [], decisionId, cardId }) => ({
    id: randomUUID(), coordinatorSessionId, origin, at, text: rt.redactDeepSecrets(String(text ?? '')).slice(0, TASK_TEXT_MAX),
    images: images.map(({ id, mediaType }) => ({ id, mediaType })).filter(item => item.id && item.mediaType),
    files: files.map(({ id, name }) => ({ id, name })).filter(item => item.id && item.name),
    createdAt: Date.now(), ...(eventId !== undefined ? { eventId } : {}), ...(handle ? { handle } : {}),
    ...(decisionId !== undefined ? { decisionId } : {}), ...(cardId !== undefined ? { cardId } : {}),
  })
  const handleOf = (sessionId, line) => `message:${sessionId}:${line.at}:${messageHash(line.text)}`

  // A trigger from the transcript line that opened the round. The text rides
  // the line verbatim (it is stored redacted); decision answers rebuild it.
  const triggerFromLine = ({ coordinatorSessionId, line }) => {
    if (!isUserTriggerLine(line)) throw invalid('只有用户原话的会话行可以作为触发消息')
    if (line.origin?.kind === 'decision-answer') {
      const decision = rt.state.decisions[line.origin.decisionId]
      if (!decision?.answer) throw invalid('决策回答不存在，无法重建触发消息')
      return recordOf({ coordinatorSessionId, origin: { kind: 'decision-answer', decisionId: line.origin.decisionId },
        text: decisionAnswerText(decision), at: line.at, eventId: line.id, handle: handleOf(coordinatorSessionId, line), decisionId: line.origin.decisionId })
    }
    return recordOf({ coordinatorSessionId, origin: line.origin ?? { kind: 'user' }, text: line.text, at: line.at,
      eventId: line.id, handle: handleOf(coordinatorSessionId, line), images: line.images ?? [], files: line.files ?? [] })
  }
  // An acceptance card returned by the user: the reason is the trigger text;
  // it never had a transcript line, so it generates no message handle.
  const triggerFromReturn = ({ coordinatorSessionId, text, cardId }) =>
    recordOf({ coordinatorSessionId, origin: { kind: 'return' }, text, at: Date.now(), cardId })

  const pendingTriggerOf = id => pending.get(id)
  const setPendingTrigger = record => { pending.set(record.coordinatorSessionId, record); return record }
  const clearPendingTrigger = id => pending.delete(id)
  const requirePendingTrigger = id => {
    const record = pending.get(id)
    if (!record) throw failure('本轮不是由用户输入开启，没有可用的触发消息；请用户重新说明需求。', 'orch/no-trigger')
    return record
  }

  const triggerUsageOf = coordinatorSessionId => Object.values(rt.state.triggers)
    .filter(record => record.coordinatorSessionId === coordinatorSessionId)
    .reduce((sum, record) => sum + record.text.length, 0)
  const persistTrigger = record => {
    if (rt.state.triggers[record.id]) return rt.state.triggers[record.id]
    if (triggerUsageOf(record.coordinatorSessionId) + record.text.length > TRIGGER_TEXT_TOTAL_MAX) {
      throw failure(TRIGGER_FULL_MESSAGE, 'orch/trigger-full')
    }
    const stored = structuredClone(record)
    rt.state.triggers[record.id] = stored
    return stored
  }
  const triggerOf = id => rt.state.triggers[id]

  // A task reaching accepted/stopped releases the trigger records it bound;
  // records still referenced by a live task or its executions stay, so running
  // or stalled tasks never lose their originals.
  const releaseTaskTriggers = taskId => {
    const task = rt.state.tasks[taskId]
    if (!task) return
    const settled = record => record && ['done', 'stopped'].includes(record.status)
    const kept = new Set()
    for (const other of Object.values(rt.state.tasks)) {
      if (other.id !== taskId && !settled(other) && other.triggerId) kept.add(other.triggerId)
    }
    for (const execution of Object.values(rt.state.executions)) {
      if (execution.taskId !== taskId && !settled(rt.state.tasks[execution.taskId])) {
        if (execution.triggerId) kept.add(execution.triggerId)
        for (const id of execution.supplements ?? []) kept.add(id)
      }
    }
    const owned = Object.values(rt.state.executions).filter(execution => execution.taskId === taskId)
      .flatMap(execution => [execution.triggerId, ...(execution.supplements ?? [])])
    for (const id of [task.triggerId, ...owned]) if (id && !kept.has(id)) delete rt.state.triggers[id]
  }

  Object.assign(rt, { isUserTriggerLine, triggerFromLine, triggerFromReturn, pendingTriggerOf, setPendingTrigger, clearPendingTrigger,
    requirePendingTrigger, triggerUsageOf, persistTrigger, triggerOf, releaseTaskTriggers })
}
