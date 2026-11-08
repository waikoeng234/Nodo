import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { failure, invalid } from './errors.js'
import { TASK_TEXT_MAX, RESULT_PREVIEW_MAX, RESULT_TEXT_MAX, RESULTS_TEXT_MAX } from './constants.js'

const CHANGES_RECORDS_MAX = 50
const previewOf = value => value.trim().replace(/\s+/g, ' ').slice(0, RESULT_PREVIEW_MAX)
export const executionResultOf = async (execution, rt) => {
  if (execution.result) return execution.result
  if (execution.result === null) return { text: '', completeness: 'unavailable', reason: 'not-archived', preview: '', length: 0 }
  const coordinator = rt.state.tasks[execution.taskId].coordinatorSessionId
  const owner = rt.conversationOf(coordinator)?.session
  let body
  for (const reference of execution.references) {
    const snapshot = await rt.readReference({ id: reference, target: owner?.engine === 'dsh' ? owner.driverSessionId : coordinator }).catch(() => null)
    if (snapshot) { body = snapshot.messages.map(message => message.text).join('\n'); break }
  }
  const reason = body !== undefined ? 'legacy-reference' : execution.report ? 'legacy-report' : 'legacy-unavailable'
  body ??= execution.report ?? ''
  return { text: body, completeness: body ? 'partial' : 'unavailable', reason, preview: previewOf(body), length: body.length }
}
export const executionResultView = async (execution, rt) => {
  const { text, ...metadata } = await executionResultOf(execution, rt)
  return { ...metadata, sourceId: `execution:${execution.id}:result` }
}

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
  const executionView = async execution => structuredClone({ ...execution, result: await executionResultView(execution, rt), ...(stopping.has(execution.id) ? { stopping: true } : {}) })
  const view = async task => ({ ...structuredClone(task), latestExecutionStatus: executionsOf(task.id).at(-1)?.status ?? null, executions: await Promise.all(executionsOf(task.id).map(executionView)) })
  const writable = async () => {
    await rt.load()
    const reason = rt.readOnly()
    if (reason !== undefined) throw failure(reason, 'orch/read-only')
  }
  const saveTask = async task => { await rt.saveStrict(); return view(task) }
  const saveExecution = async execution => { await rt.saveStrict(); return executionView(execution) }
  const archiveResult = (execution, input, status) => {
    if (execution.result && !(execution.status === 'unconfirmed' && execution.result.completeness === 'unavailable'
      && execution.result.reason === 'missing-final' && input.final?.trim())) return
    const final = rt.redactDeepSecrets(input.final ?? '')
    const remaining = RESULTS_TEXT_MAX - Object.values(state.executions).reduce((sum, item) => sum + (item.result?.text?.length ?? 0), 0)
    const body = final.slice(0, Math.max(0, Math.min(RESULT_TEXT_MAX, remaining)))
    const reason = !final.trim() ? 'missing-final' : body.length < final.length ? 'storage-limit'
      : input.finalCapture === 'partial' || status !== 'done' ? 'capture-incomplete' : null
    execution.result = { text: final.trim() ? body : '', completeness: !final.trim() || !body.length ? 'unavailable' : reason ? 'partial' : 'complete',
      reason, preview: previewOf(body), length: final.trim() ? body.length : 0, originalLength: final.length }
  }
  const taskStatus = (task, allowed) => {
    if (!allowed.includes(task.status)) throw invalid(`Task cannot transition from ${task.status}`)
  }
  const liveScope = task => {
    if (!state.workspaces[task.workspaceRef] || state.workspaces[task.workspaceRef].deletedAt) throw invalid('Task workspace is unavailable')
    const team = rt.teams().find(team => team.id === task.teamId)
    if (!team) throw invalid('Task team is unavailable')
    return team
  }
  const checkRelations = (task, changes) => {
    for (const id of [...(changes.parentId ? [changes.parentId] : []), ...(changes.dependsOn ?? [])]) {
      if (id === task.id) throw invalid('任务不能以自己为父任务或依赖任务')
      const related = state.tasks[id]
      if (!related || related.coordinatorSessionId !== task.coordinatorSessionId) throw invalid('关联任务不存在或不属于本主控会话')
    }
    if (changes.parentId && state.tasks[changes.parentId].status === 'done') throw invalid('父任务已验收，请先 reopen 父任务')
    const parentId = changes.parentId ?? task.parentId
    for (const id of [parentId, ...(changes.dependsOn ?? task.dependsOn ?? [])]) {
      const visited = new Set([task.id])
      for (let ancestor = id; ancestor; ancestor = state.tasks[ancestor]?.parentId) {
        if (visited.has(ancestor)) throw invalid(ancestor === task.id && id !== parentId ? '任务不能依赖自己的子孙任务' : '父子关系成环')
        visited.add(ancestor)
      }
    }
  }
  const createTask = async ({ workspaceRef, teamId, coordinatorSessionId, title, brief, source, parentId, dependsOn }) => {
    await writable()
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('source must be an object')
    let origin
    try { origin = structuredClone(source) } catch { throw invalid('source must be cloneable') }
    const task = { id: randomUUID(), workspaceRef: text(workspaceRef, 'workspaceRef'), teamId: text(teamId, 'teamId'),
      coordinatorSessionId: text(coordinatorSessionId, 'coordinatorSessionId'), title: text(title, 'title'), brief: text(brief, 'brief'),
      source: origin, status: 'open', createdAt: Date.now(), updatedAt: Date.now(), acceptances: [],
      ...(parentId ? { parentId } : {}), ...(dependsOn?.length ? { dependsOn: [...dependsOn] } : {}) }
    const team = liveScope(task)
    const owner = rt.conversationOf(coordinatorSessionId)
    if (!owner || owner.profile.id !== team.lead || rt.sessionWorkspace(owner.profile, owner.session)?.id !== workspaceRef) throw invalid('Coordinator must belong to the task workspace and team lead')
    rt.assertSessionWritable(owner.profile, owner.session)
    checkRelations(task, task)
    state.tasks[task.id] = task
    return saveTask(task)
  }
  const taskView = async id => { await rt.load(); return view(taskOf(id)) }
  const reviseTask = async (id, changes) => {
    await writable()
    const task = taskOf(id)
    liveScope(task)
    taskStatus(task, ['open', 'review', 'blocked'])
    if (Object.keys(changes).some(key => !['title', 'brief', 'parentId', 'dependsOn'].includes(key))) throw invalid('Only title, brief, parentId and dependsOn may be revised')
    checkRelations(task, changes)
    const next = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key,
      key === 'dependsOn' ? [...value] : key === 'parentId' ? value : text(value, key)]))
    Object.assign(task, next, { updatedAt: Date.now() })
    if (!task.parentId) delete task.parentId
    if (!task.dependsOn?.length) delete task.dependsOn
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
      status: 'queued', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, reason: null, report: null, references: [], result: null,
      // The execution workspace only earns a field when it diverges from the task's own.
      ...(workspaceRef === task.workspaceRef ? {} : { workspaceRef }) }
    state.executions[execution.id] = execution
    Object.assign(task, { status: 'open', updatedAt: now })
    return saveExecution(execution)
  }
  const startExecution = async (id, input) => {
    await writable()
    const execution = executionOf(id)
    if (execution.status !== 'queued') throw invalid(`Execution cannot start from ${execution.status}`)
    const now = Date.now()
    if (input !== undefined) {
      if (execution.inputContext !== undefined) throw invalid('Execution input context is already recorded')
      execution.inputContext = rt.redactDeepSecrets(structuredClone(input))
    }
    Object.assign(execution, { status: 'running', startedAt: now, updatedAt: now })
    Object.assign(taskOf(execution.taskId), { status: 'open', updatedAt: now })
    return saveExecution(execution)
  }
  // Merges the session's change records inside the execution window into one
  // per-path summary. Shell writes are not covered, workspace snapshots may
  // include changes Nodo cannot attribute to this execution, and unreadable or
  // partial records only degrade capture. Collection never blocks ending.
  const collectFiles = async execution => {
    try {
      if (execution.startedAt == null) return undefined
      const found = rt.conversationOf(execution.sessionId)
      if (!found) return undefined
      const allLines = rt.transcriptOf(execution.sessionId).filter(line => line.kind === 'changes' && line.at >= execution.startedAt)
      if (!allLines.length) return undefined
      const lines = allLines.slice(-CHANGES_RECORDS_MAX)
      const workspaceCwd = rt.state.workspaces[execution.workspaceRef ?? rt.state.tasks[execution.taskId]?.workspaceRef]?.cwd
      const relPath = (value, cwd) => {
        if (!isAbsolute(value)) return value
        const base = cwd ?? workspaceCwd
        return base ? relative(base, value) : value
      }
      const merged = new Map()
      let partial = lines.length < allLines.length, snapshot = false
      for (const line of lines) {
        const ref = line.presentation?.details?.ref
        if (!ref) { partial = true; continue }
        let record
        try { record = await rt.readStreamDetail({ profile: found.profile.id, session: execution.sessionId, ref }) } catch { partial = true; continue }
        if (record.kind !== 'changes') continue
        if (record.capture !== 'complete') partial = true
        if (record.body?.scope === 'workspace-snapshot') snapshot = true
        for (const file of record.body?.files ?? []) {
          if (!file.edits?.length) continue
          const path = relPath(file.path, record.body?.cwd)
          if (!path) continue
          const ops = merged.get(path) ?? []
          for (const edit of file.edits) ops.push({ operation: edit.operation, fromPath: edit.fromPath, cwd: record.body?.cwd })
          merged.set(path, ops)
        }
      }
      const source = snapshot ? 'workspace-snapshot' : 'edit-tools'
      if (!merged.size) return partial ? { items: [], total: 0, capture: 'partial', source } : undefined
      const items = [...merged.entries()].map(([path, ops]) => {
        const last = ops.at(-1)
        const op = last.operation === 'delete' ? 'delete'
          : ops.some(item => item.operation === 'add') ? 'add'
          : ops.some(item => item.operation === 'move') ? 'move'
          : last.operation === 'unknown' ? 'unknown' : 'update'
        const move = op === 'move' ? ops.findLast(item => item.operation === 'move') : undefined
        const from = move ? relPath(move.fromPath ?? '', move.cwd) : undefined
        return { path, op, ...(from ? { from } : {}) }
      }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const total = items.length
      return { items: items.slice(0, 200), total, capture: partial || total > 200 ? 'partial' : 'complete', source }
    } catch { return undefined }
  }
  const endExecution = async (id, status, allowed, taskState, input = {}, unsent = false) => {
    if (!unsent) await writable()
    const execution = executionOf(id)
    if (!allowed.includes(execution.status)) throw invalid(`Execution cannot become ${status} from ${execution.status}`)
    const reason = text(input.reason ?? status, 'reason')
    const result = resultOf(input, execution)
    const late = execution.status === 'unconfirmed'
    const now = Date.now()
    archiveResult(execution, input, status)
    const files = await collectFiles(execution)
    Object.assign(execution, result, { status, reason, updatedAt: now, endedAt: now })
    if (files) execution.files = files
    if (unsent) execution.startedAt = null
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
  const deliveredReports = (taskId, executionId) => {
    const execution = executionOf(executionId)
    if (execution.taskId !== taskId || !execution.reports?.length) throw invalid('只能审阅该任务已投递的执行回报')
    return execution.reports
  }
  const reviewReports = async (taskId, { executionId, disposition, reason, basis }) => {
    await writable()
    if (!['continue', 'investigate'].includes(disposition)) throw invalid('disposition 必须是 continue 或 investigate')
    text(reason, 'reason')
    if (reason.length > TASK_TEXT_MAX || !Array.isArray(basis) || !basis.length
      || basis.some(value => typeof value !== 'string' || !value.trim() || value.length > TASK_TEXT_MAX)) throw invalid('reason 不得超长，basis 必须是非空文本数组且每项不超过文本上限')
    const reports = deliveredReports(taskId, executionId)
    for (const report of reports) if (!report.review) report.review = rt.redactDeepSecrets({ disposition, reason, basis: [...basis], reviewedAt: Date.now() })
    return saveExecution(executionOf(executionId))
  }
  // The returned restore must run when the caller's save fails, so ask marks never land without their decision.
  const askReports = (executionIds, decision) => {
    const reports = executionIds.flatMap(executionId => {
      const reports = executionOf(executionId).reports, pending = reports.filter(report => !report.review)
      return pending.length ? pending : reports.slice(-1)
    })
    const previous = reports.map(report => report.review)
    for (const report of reports) report.review = { ...report.review, disposition: 'ask', decisionId: decision.id, reviewedAt: decision.createdAt }
    return () => reports.forEach((report, index) => { if (previous[index]) report.review = previous[index]; else delete report.review })
  }
  const completeTask = async (id, { reason, references, executionIds, basis }) => {
    await writable()
    const task = taskOf(id)
    await rt.decisionDeliveryReady?.(task.coordinatorSessionId)
    rt.assertDecisionAcceptance?.(task)
    liveScope(task)
    taskStatus(task, ['open', 'review', 'blocked'])
    const unfinished = Object.values(state.tasks).filter(child => child.coordinatorSessionId === task.coordinatorSessionId && child.parentId === id && child.status !== 'done').length
    if (unfinished) throw invalid(`还有 ${unfinished} 个子任务未验收，先完成它们再验收本任务`)
    const executions = executionsOf(id)
    text(reason, 'reason')
    if (executions.some(pending)) throw invalid('Task still has a pending or unconfirmed execution')
    let evidence
    if (references !== undefined) {
      if (executionIds !== undefined || basis !== undefined) throw invalid('references cannot be mixed with executionIds or basis')
      if (executions.some(execution => execution.result !== undefined && !execution.result?.reason?.startsWith('legacy-'))) throw invalid('New execution results require executionIds, reason and basis')
      const refs = referencesOf(references)
      const known = new Set(executions.flatMap(execution => execution.references))
      if (!refs.length || refs.some(ref => !known.has(ref))) throw invalid('Acceptance evidence must reference task execution results')
      evidence = { references: refs, executionIds: executions.filter(execution => execution.references.some(ref => refs.includes(ref))).map(execution => execution.id) }
    } else {
      if (!Array.isArray(executionIds) || !executionIds.length || executionIds.some(value => typeof value !== 'string' || !value.trim())) throw invalid('executionIds must be a non-empty list of execution ids')
      if (reason.length > TASK_TEXT_MAX || !Array.isArray(basis) || !basis.length
        || basis.some(value => typeof value !== 'string' || !value.trim() || value.length > TASK_TEXT_MAX)) throw invalid('reason 不得超长，basis 必须是非空文本数组且每项不超过文本上限')
      if (executionIds.some(executionId => !executions.some(execution => execution.id === executionId && execution.result))) throw invalid('Acceptance executions must belong to this task and have archived results')
      evidence = { executionIds: [...new Set(executionIds)], basis: [...basis] }
    }
    const now = Date.now()
    task.acceptances.push(rt.redactDeepSecrets({ reason, ...evidence, createdAt: now }))
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

  Object.assign(rt, { createTask, taskView, reviseTask, acceptExecution, startExecution, requestExecutionStop, recordExecutionResult, completeTask, reopenTask, reviewReports, askReports,
    deliveredReports,
    registerDeliveredReport: async (item, deliveredAt) => {
      const execution = executionOf(item.executionId)
      execution.reports ??= []
      if (execution.reports.some(report => report.id === item.id)) return
      execution.reports.push({ id: item.id, deliveredAt, sessionId: item.session, summary: item.summary, status: item.status,
        references: item.referenceId ? [item.referenceId] : [] })
      await rt.saveStrict()
    },
    reportReviewBlockReason: id => {
      const reports = Object.values(state.executions).filter(execution => state.tasks[execution.taskId]?.coordinatorSessionId === id)
        .flatMap(execution => (execution.reports ?? []).filter(report => !report.review).map(report => ({ reportId: report.id, executionId: execution.id, taskId: execution.taskId })))
      if (reports.length) return { code: 'orch/report-unreviewed', message: '有已投递的回报尚未审阅，请先用 nodo_task review 或 nodo_decision 处置。', reports }
    },
    executionStopping: id => { for (const session of stopping.values()) if (session === id) return true; return false },
    finishExecution: (id, result) => endExecution(id, 'done', ['running', 'unconfirmed'], 'review', result),
    failExecution: (id, result) => endExecution(id, 'failed', ['queued', 'running', 'unconfirmed'], 'blocked', result),
    interruptExecution: (id, result) => endExecution(id, 'interrupted', ['running', 'unconfirmed'], 'stopped', result),
    cancelExecution: (id, result) => endExecution(id, 'cancelled', ['queued'], 'stopped', result),
    // Caller confirms nothing was sent; cancellation can release the reservation even after lock loss.
    cancelUnsentExecution: (id, result) => endExecution(id, 'cancelled', ['queued', 'running'], 'stopped', result, true),
    unconfirmExecution: (id, result) => endExecution(id, 'unconfirmed', ['queued', 'running'], 'blocked', result) })
}
