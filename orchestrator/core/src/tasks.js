import { randomUUID } from 'node:crypto'
import { failure, invalid } from './errors.js'

const pending = execution => ['queued', 'running', 'unconfirmed'].includes(execution.status)
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} must be a non-empty string`)
  return value
}
const referencesOf = references => {
  if (!Array.isArray(references) || references.some(ref => typeof ref !== 'string' || !ref.trim())) throw invalid('references must be a list of reference ids')
  return [...references]
}
const resultOf = ({ report, references } = {}, execution) => {
  const result = {}
  if (report !== undefined) {
    text(report, 'report')
    if (!execution.report) result.report = report
  }
  if (references !== undefined) {
    const merged = [...new Set([...execution.references, ...referencesOf(references)])]
    if (merged.length !== execution.references.length || merged.some((ref, index) => ref !== execution.references[index])) result.references = merged
  }
  return result
}

export function install(rt) {
  const { state } = rt
  // executionId → sessionId; a stop request is runtime-only and dies with the execution.
  const stopping = new Map()
  const taskOf = id => {
    const task = state.tasks[id]
    if (!task) throw failure('No such task', 'orch/not-found')
    return task
  }
  const executionOf = id => {
    const execution = state.executions[id]
    if (!execution) throw failure('No such execution', 'orch/not-found')
    taskOf(execution.taskId)
    return execution
  }
  const executionsOf = id => Object.values(state.executions).filter(execution => execution.taskId === id)
  const executionView = execution => structuredClone({ ...execution, ...(stopping.has(execution.id) ? { stopping: true } : {}) })
  const view = task => ({ ...structuredClone(task), latestExecutionStatus: executionsOf(task.id).at(-1)?.status ?? null, executions: executionsOf(task.id).map(executionView) })
  const writable = async () => {
    await rt.load()
    const reason = rt.readOnly()
    if (reason !== undefined) throw failure(reason, 'orch/read-only')
  }
  const saveTask = async task => { await rt.saveStrict(); return view(task) }
  const saveExecution = async execution => { await rt.saveStrict(); return executionView(execution) }
  const taskStatus = (task, allowed) => {
    if (!allowed.includes(task.status)) throw invalid(`Task cannot transition from ${task.status}`)
  }
  const liveScope = task => {
    if (!state.workspaces[task.workspaceRef] || state.workspaces[task.workspaceRef].deletedAt) throw invalid('Task workspace is unavailable')
    const team = rt.teams().find(team => team.id === task.teamId)
    if (!team) throw invalid('Task team is unavailable')
    return team
  }
  const createTask = async ({ workspaceRef, teamId, coordinatorSessionId, title, brief, source }) => {
    await writable()
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('source must be an object')
    let origin
    try { origin = structuredClone(source) } catch { throw invalid('source must be cloneable') }
    const task = { id: randomUUID(), workspaceRef: text(workspaceRef, 'workspaceRef'), teamId: text(teamId, 'teamId'),
      coordinatorSessionId: text(coordinatorSessionId, 'coordinatorSessionId'), title: text(title, 'title'), brief: text(brief, 'brief'),
      source: origin, status: 'open', createdAt: Date.now(), updatedAt: Date.now(), acceptances: [] }
    const team = liveScope(task)
    const owner = rt.conversationOf(coordinatorSessionId)
    if (!owner || owner.profile.id !== team.lead || rt.sessionWorkspace(owner.profile, owner.session)?.id !== workspaceRef) throw invalid('Coordinator must belong to the task workspace and team lead')
    rt.assertSessionWritable(owner.profile, owner.session)
    state.tasks[task.id] = task
    return saveTask(task)
  }
  const taskView = async id => { await rt.load(); return view(taskOf(id)) }
  const reviseTask = async (id, changes) => {
    await writable()
    const task = taskOf(id)
    liveScope(task)
    taskStatus(task, ['open', 'review', 'blocked'])
    if (Object.keys(changes).some(key => !['title', 'brief'].includes(key))) throw invalid('Only title and brief may be revised')
    const next = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, text(value, key)]))
    Object.assign(task, next, { updatedAt: Date.now() })
    return saveTask(task)
  }
  const acceptExecution = async (taskId, { profileId, sessionId, type, hard, model, thinking, workspaceRef: executionRef }) => {
    await writable()
    const task = taskOf(taskId)
    taskStatus(task, ['open', 'review', 'blocked'])
    const team = liveScope(task)
    text(profileId, 'profileId'); text(sessionId, 'sessionId'); text(type, 'type')
    if (typeof hard !== 'boolean') throw invalid('hard must be a boolean')
    if (model !== undefined) text(model, 'model')
    if (thinking !== undefined) text(thinking, 'thinking')
    const workspaceRef = executionRef === undefined ? task.workspaceRef : text(executionRef, 'workspaceRef')
    const owner = rt.conversationOf(sessionId)
    if (!owner || owner.profile.id !== profileId || !Array.isArray(team.members) || !team.members.includes(profileId)
      || rt.sessionWorkspace(owner.profile, owner.session)?.id !== workspaceRef) throw invalid('Executor must belong to the task workspace and team')
    rt.assertSessionWritable(owner.profile, owner.session)
    if (Object.values(state.executions).some(execution => pending(execution) && (execution.taskId === taskId || execution.sessionId === sessionId))) throw failure('Task or session already has a pending execution', 'orch/busy')
    const now = Date.now()
    const execution = { id: randomUUID(), taskId, profileId, sessionId, type, hard, model: model ?? null, thinking: thinking ?? null,
      status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, reason: null, report: null, references: [],
      // The execution workspace only earns a field when it diverges from the task's own.
      ...(workspaceRef === task.workspaceRef ? {} : { workspaceRef }) }
    state.executions[execution.id] = execution
    Object.assign(task, { status: 'open', updatedAt: now })
    return saveExecution(execution)
  }
  const startExecution = async id => {
    await writable()
    const execution = executionOf(id)
    if (execution.status !== 'queued') throw invalid(`Execution cannot start from ${execution.status}`)
    const now = Date.now()
    Object.assign(execution, { status: 'running', startedAt: now, updatedAt: now })
    Object.assign(taskOf(execution.taskId), { status: 'open', updatedAt: now })
    return saveExecution(execution)
  }
  const endExecution = async (id, status, allowed, taskState, input = {}, unsent = false) => {
    if (!unsent) await writable()
    const execution = executionOf(id)
    if (!allowed.includes(execution.status)) throw invalid(`Execution cannot become ${status} from ${execution.status}`)
    const reason = text(input.reason ?? status, 'reason')
    const result = resultOf(input, execution)
    const late = execution.status === 'unconfirmed'
    const now = Date.now()
    Object.assign(execution, result, { status, reason, updatedAt: now, endedAt: now })
    stopping.delete(id)
    const task = taskOf(execution.taskId)
    if (!late && (status !== 'cancelled' || executionsOf(task.id).length === 1)) Object.assign(task, { status: taskState, updatedAt: now })
    return saveExecution(execution)
  }
  const requestExecutionStop = async id => {
    await writable()
    const execution = executionOf(id)
    if (execution.status !== 'running') throw invalid('Only a running execution can be stopping')
    stopping.set(id, execution.sessionId)
    rt.notifyLive()
    return executionView(execution)
  }
  const recordExecutionResult = async (id, input) => {
    await writable()
    const execution = executionOf(id)
    if (['queued', 'running'].includes(execution.status)) throw invalid('Execution has not ended')
    const result = resultOf(input, execution)
    if (!Object.keys(result).length) return executionView(execution)
    Object.assign(execution, result, { updatedAt: Date.now() })
    return saveExecution(execution)
  }
  const completeTask = async (id, { reason, references }) => {
    await writable()
    const task = taskOf(id)
    liveScope(task)
    taskStatus(task, ['open', 'review', 'blocked'])
    const executions = executionsOf(id)
    const evidence = referencesOf(references)
    text(reason, 'reason')
    if (executions.some(pending)) throw invalid('Task still has a pending or unconfirmed execution')
    const results = executions.filter(execution => execution.report || execution.references.length)
    const known = new Set(results.flatMap(execution => execution.references))
    if (!results.length || !evidence.length || evidence.some(ref => !known.has(ref))) throw invalid('Acceptance evidence must reference task execution results')
    const now = Date.now()
    task.acceptances.push({ reason, references: evidence, executionIds: results.filter(execution => execution.references.some(ref => evidence.includes(ref))).map(execution => execution.id), createdAt: now })
    Object.assign(task, { status: 'done', updatedAt: now })
    return saveTask(task)
  }
  const reopenTask = async id => {
    await writable()
    const task = taskOf(id)
    liveScope(task)
    taskStatus(task, ['done', 'stopped'])
    Object.assign(task, { status: 'open', updatedAt: Date.now() })
    return saveTask(task)
  }

  Object.assign(rt, { createTask, taskView, reviseTask, acceptExecution, startExecution, requestExecutionStop, recordExecutionResult, completeTask, reopenTask,
    executionStopping: id => { for (const session of stopping.values()) if (session === id) return true; return false },
    finishExecution: (id, result) => endExecution(id, 'done', ['running', 'unconfirmed'], 'review', result),
    failExecution: (id, result) => endExecution(id, 'failed', ['queued', 'running', 'unconfirmed'], 'blocked', result),
    interruptExecution: (id, result) => endExecution(id, 'interrupted', ['running', 'unconfirmed'], 'stopped', result),
    cancelExecution: (id, result) => endExecution(id, 'cancelled', ['queued'], 'stopped', result),
    // An unsent command can release its reservation even after losing the write lock.
    cancelUnsentExecution: (id, result) => endExecution(id, 'cancelled', ['queued'], 'stopped', result, true),
    unconfirmExecution: (id, result) => endExecution(id, 'unconfirmed', ['queued', 'running'], 'blocked', result) })
}
