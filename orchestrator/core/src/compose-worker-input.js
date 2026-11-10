// Worker input: everything a lead-routed execution receives, composed from
// saved records alone — the composer takes only an execution id, so what a
// worker was sent can always be replayed from the record. User originals and
// attachment lists never drop silently: a missing record is refused and a
// lost attachment byte is marked unavailable. Under budget pressure the drop
// order is fixed: history window, then handover summaries (handles stay),
// then prior-round details.
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { INPUT_CONTEXT_MAX, TRANSCRIPT_MAX, RESULT_PREVIEW_MAX, REWORK_MAX_DEFAULT, HISTORY_USER_MAX, HISTORY_REPLY_MAX, HISTORY_TEXT_MAX } from './constants.js'
import { clip } from './text.js'
import { failure, invalid } from './errors.js'

const HISTORY_ITEM_MAX = 2_000
const PRIOR_LADDER = [4_000, 800]
const scopeTextOf = scope => typeof scope === 'string' ? scope : scope?.quote ?? scope?.note ?? ''

export function install(rt) {
  // Stage round: how many executions of this task have run the same stage,
  // this one included.
  const roundOf = execution => {
    const stage = execution.stage ?? 'implement'
    const same = Object.values(rt.state.executions).filter(item => item.taskId === execution.taskId && (item.stage ?? 'implement') === stage)
      .sort((a, b) => a.createdAt - b.createdAt)
    return Math.max(1, same.indexOf(execution) + 1)
  }
  // Review-driven reworks count toward the type's rework limit; a supplement
  // or acceptance return starts its own counter (§3.4).
  const reworkRoundOf = (execution, task) => {
    const reviewDriven = item => task.triggerId !== undefined && item.triggerId === task.triggerId
    const same = Object.values(rt.state.executions)
      .filter(item => item.taskId === execution.taskId && (item.stage ?? 'implement') === 'rework' && reviewDriven(item) === reviewDriven(execution))
      .sort((a, b) => a.createdAt - b.createdAt)
    return Math.max(1, same.indexOf(execution) + 1)
  }
  const maxReworkOf = execution => {
    const task = rt.state.tasks[execution.taskId]
    const team = rt.teams().find(team => team.id === task.teamId)
    return team?.types?.find(type => type.id === execution.type)?.flow?.maxRework ?? REWORK_MAX_DEFAULT
  }
  // A session no delegation has ever touched reads as new and needs the
  // coordinator's recent content; a reused one already carries it in-engine.
  const isNewWorkerSession = sessionId => !rt.transcriptOf(sessionId)
    .some(line => line.who === 'agent' || ['delegation', 'supplement', 'retry'].includes(line.origin?.kind))

  const historyWindow = leadSessionId => {
    const lines = rt.transcriptOf(leadSessionId)
    const originalText = line => line.origin?.kind === 'decision-answer'
      ? rt.decisionText(rt.state.decisions[line.origin.decisionId] ?? { questions: [] }) : line.text
    const users = lines.filter(line => rt.isUserTriggerLine(line)).slice(-HISTORY_USER_MAX)
    const replies = lines.filter(line => line.who === 'agent' && line.kind === 'text').slice(-HISTORY_REPLY_MAX)
    const selected = new Set([...users, ...replies])
    const merged = lines.filter(line => selected.has(line)).map(line => {
      const handle = rt.messageSourceId(leadSessionId, line)
      return { handle, text: `[${line.who === 'user' ? '用户' : '主控'}] ${originalText(line).slice(0, HISTORY_ITEM_MAX)}\n句柄：nodo_context read sourceId ${handle}` }
    })
    let total = merged.map(item => item.text).join('\n\n').length
    while (total > HISTORY_TEXT_MAX && merged.length) total -= merged.shift().text.length + 2
    return { items: merged.map(item => item.text), handles: merged.map(item => item.handle),
      trimmed: lines.length >= TRANSCRIPT_MAX }
  }

  // A review execution reviews the execution its sourceExecutionId names; a
  // dangling source is refused rather than rendered as prose about nothing.
  const reviewedOf = execution => {
    const source = rt.state.executions[execution.sourceExecutionId]
    if (!source) throw invalid('审查执行的 sourceExecutionId 不存在，无法拼装被审查执行')
    const workspace = rt.state.workspaces[source.workspaceRef ?? rt.state.tasks[source.taskId]?.workspaceRef]
    const worktree = workspace?.worktree
    const report = source.reportData
    return rt.reviewedExecution({ outcome: report?.outcome ?? source.status,
      summary: report?.summary ?? source.result?.preview ?? '',
      files: report?.changed?.length ?? source.files?.total ?? 0,
      branch: worktree?.branch && worktree?.baseCommit ? `branch ${worktree.branch} @ ${String(worktree.baseCommit).slice(0, 7)}` : undefined,
      verified: report?.verified ?? [], flags: report?.reviewFlags,
      reportHandle: report?.id ? `report:${report.id}` : 'report:unavailable',
      evidenceHandle: source.evidence ? `evidence:${source.id}` : 'evidence:unavailable' })
  }
  // A review-fail rework takes its findings from the review execution named by
  // sourceExecutionId; any other rework summarizes the previous implementation,
  // never a review execution.
  const priorLinesOf = execution => {
    const task = rt.state.tasks[execution.taskId]
    if (task.triggerId !== undefined && execution.triggerId === task.triggerId) {
      const source = rt.state.executions[execution.sourceExecutionId]
      if (!source) throw invalid('返工执行的 sourceExecutionId 不存在，无法拼装前序结论')
      const lines = (source.reportData?.findings ?? []).map(item => `- [${item.severity ?? 'medium'}] ${item.category ?? 'other'}：${item.text}`)
      if (lines.length) return lines
    }
    const previous = Object.values(rt.state.executions)
      .filter(item => item.taskId === execution.taskId && item.id !== execution.id && item.endedAt != null
        && ['implement', 'rework'].includes(item.stage ?? 'implement'))
      .sort((a, b) => a.endedAt - b.endedAt).at(-1)
    const summary = previous?.reportData?.summary ?? previous?.result?.preview ?? ''
    return [summary ? `上一执行：${summary}` : '上一执行没有可用摘要。']
  }
  const continuesOf = task => {
    const sourceTask = rt.state.tasks[task.source?.continuesTaskId]
    const [previous] = Object.values(rt.state.executions)
      .filter(item => item.taskId === sourceTask?.id && item.endedAt != null)
      .sort((a, b) => b.endedAt - a.endedAt)
    return sourceTask && previous ? { label: sourceTask.id,
      summary: previous.reportData?.summary ?? previous.result?.preview ?? '',
      sourceId: `execution:${previous.id}:result` } : undefined
  }

  // A session that ran this coordinator's tasks before learns which later tasks
  // touched the files it changed, so it rereads before overwriting their work.
  const changesOf = execution => {
    const own = Object.values(rt.state.executions).filter(item => item.sessionId === execution.sessionId)
    const paths = new Set(own.flatMap(item => item.files?.items.map(file => file.path) ?? []))
    const lastEnded = Math.max(0, ...own.filter(item => item.endedAt != null).map(item => item.endedAt))
    if (!paths.size || !lastEnded) return undefined
    const owner = rt.state.tasks[execution.taskId]?.coordinatorSessionId
    const workspaceRef = execution.workspaceRef ?? rt.state.tasks[execution.taskId]?.workspaceRef
    const hits = Object.values(rt.state.executions)
      .filter(item => item.endedAt != null && item.endedAt > lastEnded && item.sessionId !== execution.sessionId && item.files
        && rt.state.tasks[item.taskId]?.coordinatorSessionId === owner
        && (item.workspaceRef ?? rt.state.tasks[item.taskId]?.workspaceRef) === workspaceRef)
      .sort((a, b) => a.endedAt - b.endedAt)
      .map(item => {
        const inter = item.files.items.filter(file => paths.has(file.path)).map(file => file.path)
        return inter.length ? { id: item.id, status: item.status,
          snapshot: item.files.source === 'workspace-snapshot', inter } : null
      })
      .filter(Boolean)
    if (!hits.length) return undefined
    const rest = hits.length - 5
    return `自你上次执行结束后，以下任务改动了你改过的文件，修改前重新读取：\n${hits.slice(0, 5)
      .map(item => `- ${item.id} · ${item.status} · ${item.inter.slice(0, 10).join('、')}${item.snapshot ? '（工作区快照，可能含其他改动）' : ''}`).join('\n')}${rest > 0 ? `\n另有 ${rest} 个执行也改动了这些文件` : ''}`
  }

  // Attachment bytes live outside state; a lost byte is marked unavailable in
  // the list instead of dropping the reference silently.
  const attachmentsOf = async (records, cwd) => {
    const images = []
    let missingImages = 0
    const refs = []
    for (const record of records) {
      for (const ref of record.images ?? []) {
        try { images.push(await rt.imageOf(ref)) } catch { missingImages += 1 }
      }
      refs.push(...(record.files ?? []))
    }
    const available = [], missingFiles = []
    for (const ref of refs) {
      try { available.push({ name: ref.name, bytes: await rt.fileOf(ref) }) } catch { missingFiles.push(ref.name) }
    }
    const placed = available.length ? await rt.place(available, cwd) : []
    const root = placed.length ? realpathSync(cwd) : cwd
    return { images, missingImages, files: placed.map(path => relative(root, path)), missingFiles,
      total: images.length + missingImages + available.length + missingFiles.length }
  }

  // upToTriggerId cuts the supplements at a queued message's own trigger, so a
  // restore recomposition does not swallow later supplements that still travel
  // as their own messages.
  const composeWorkerInput = async ({ executionId, upToTriggerId }) => {
    const execution = rt.state.executions[executionId]
    if (!execution) throw failure('No such execution', 'orch/not-found')
    const task = rt.state.tasks[execution.taskId]
    if (!task) throw failure('No such task', 'orch/not-found')
    const trigger = rt.state.triggers[execution.triggerId]
    if (!trigger) throw invalid('执行缺少触发消息记录，无法拼装 worker 输入')
    const workspace = rt.state.workspaces[execution.workspaceRef ?? task.workspaceRef]
    if (!workspace?.cwd) throw invalid('执行目录已不可用，无法拼装 worker 输入')
    const stage = execution.stage ?? 'implement'
    let supplements = (execution.supplements ?? []).map(id => {
      const record = rt.state.triggers[id]
      if (!record) throw invalid(`补充原话不存在或已回收：${id}`)
      return record
    }).sort((a, b) => a.at - b.at)
    if (upToTriggerId !== undefined) {
      const at = supplements.findIndex(record => record.id === upToTriggerId)
      if (at >= 0) supplements = supplements.slice(0, at + 1)
    }

    const taskTrigger = task.triggerId !== execution.triggerId ? rt.state.triggers[task.triggerId] : undefined
    if (task.triggerId !== execution.triggerId && !taskTrigger) throw invalid('任务原始触发消息不存在或已回收')
    const attachments = await attachmentsOf([...(taskTrigger ? [taskTrigger] : []), trigger, ...supplements], workspace.cwd)
    const parts = { requirement: rt.workerRequirement(trigger.text) }
    if (workspace.worktree) parts.workspace = `# 执行目录\n执行目录：${workspace.cwd}\n分支：${workspace.worktree.branch}\n基准 commit：${workspace.worktree.baseCommit}\n主检出的未提交改动和依赖不在此目录。Nodo 不会自动合并。报告须回传分支、执行目录、改动文件，以及是否已提交；已提交的给出 sha。`
    if (supplements.length) parts.supplements = rt.workerSupplements(supplements.map(record => record.text))
    if (attachments.total) parts.attachments = rt.workerAttachments(attachments)
    if (taskTrigger) parts.original = rt.workerOriginal({ text: taskTrigger.text, scope: scopeTextOf(task.scope) })
    parts.scope = rt.workerScope(scopeTextOf(execution.scope ?? task.scope))
    const changes = changesOf(execution)
    if (changes) parts.changes = rt.workerChanges(changes)
    const reviewFail = task.triggerId !== undefined && execution.triggerId === task.triggerId
    parts.stage = rt.workerStage({ stage, round: stage === 'rework' ? reworkRoundOf(execution, task) : roundOf(execution),
      maxRework: maxReworkOf(execution), reviewFail })
    if (stage === 'review') parts.reviewed = rt.workerReviewed(reviewedOf(execution))
    if (stage === 'answer' && Array.isArray(execution.questions) && execution.questions.length) parts.questions = rt.workerQuestions(execution.questions)
    if (stage === 'rework') parts.prior = rt.workerPrior(priorLinesOf(execution))

    let required = [], catalog = [], omitted = [], continues, contextHandles = []
    // Cross-task material only reaches implementation and rework workers;
    // reviewers and answerers work off the reviewed execution alone.
    if (stage === 'implement' || stage === 'rework') {
      const defaults = await rt.selectDispatchContext({ leadSessionId: task.coordinatorSessionId, taskId: task.id,
        parentId: task.parentId, dependsOn: task.dependsOn })
      required = defaults.required
      continues = task.source?.continuesTaskId ? continuesOf(task) : undefined
      const writable = defaults.background.filter(entry => entry.text.trim())
      const bodies = writable.map(entry => rt.redactDeepSecrets(entry.text))
      const placed = writable.length ? await rt.place(writable.map((entry, index) => ({ name: `background-${index + 1}.md`, bytes: Buffer.from(bodies[index], 'utf8') })), workspace.cwd) : []
      catalog = writable.map((entry, index) => ({ sourceId: entry.sourceId, kind: entry.kind, description: entry.description,
        completeness: entry.completeness, ...(entry.reason ? { reason: entry.reason } : {}), path: relative(realpathSync(workspace.cwd), placed[index]),
        bytes: Buffer.byteLength(bodies[index], 'utf8') }))
      omitted = defaults.background.filter(entry => !entry.text.trim()).map(entry => ({ sourceId: entry.sourceId, kind: entry.kind,
        description: entry.description, reason: entry.reason ?? 'unavailable' }))
      if (defaults.required.length || catalog.length || omitted.length || continues) parts.handover = rt.workerHandover({
        required: defaults.required.map(({ sourceId, description, text }) => ({ sourceId, description, summary: clip(text, 2000, '前置结论') })),
        background: catalog.map(({ path }) => ({ description: '依赖任务结果', path })),
        omitted: omitted.map(({ reason }) => ({ description: '依赖任务结果', reason })),
        continues: continues ? [continues] : [] })
      contextHandles = [...defaults.required.map(item => item.sourceId), ...(continues ? [continues.sourceId] : [])]
    }

    let history, historyHandles = []
    if (isNewWorkerSession(execution.sessionId)) {
      history = historyWindow(task.coordinatorSessionId)
      historyHandles = history.handles
      parts.history = rt.workerHistory(history)
    }
    parts.report = rt.workerReportMethod({ degraded: rt.conversationOf(execution.sessionId)?.profile.engine === 'dsh', answers: stage === 'answer' })

    const order = ['requirement', 'supplements', 'attachments', 'original', 'scope', 'workspace', 'changes', 'stage', 'reviewed', 'questions', 'prior', 'handover', 'history', 'report']
    const join = () => order.map(key => parts[key]).filter(Boolean).join('\n\n')
    let text = join()
    if (text.length > INPUT_CONTEXT_MAX && parts.history !== undefined) {
      delete parts.history
      history = undefined
      historyHandles = []
      text = join()
    }
    if (text.length > INPUT_CONTEXT_MAX && parts.handover !== undefined) {
      parts.handover = rt.workerHandover({ required: required.map(({ sourceId }) => ({ sourceId })),
        background: catalog.map(({ path }) => ({ path })), omitted: omitted.map(({ reason }) => ({ description: '依赖任务结果', reason })),
        continues: continues ? [{ ...continues, summary: '' }] : [] })
      text = join()
    }
    for (const max of PRIOR_LADDER) {
      if (text.length <= INPUT_CONTEXT_MAX || parts.prior === undefined) break
      parts.prior = clip(parts.prior, max, '前序结论')
      text = join()
    }
    if (text.length > INPUT_CONTEXT_MAX) throw invalid(`派活输入 ${text.length} 字符超过预算 ${INPUT_CONTEXT_MAX}，本轮未发送`)

    execution.historyHandles = historyHandles
    if (stage === 'implement' || stage === 'rework') execution.contextHandles = contextHandles
    const inputContext = { at: Date.now(), length: text.length, preview: text.slice(0, RESULT_PREVIEW_MAX),
      required: required.map(({ text: entryText, ...descriptor }) => descriptor), background: catalog, ...(omitted.length ? { omitted } : {}) }
    return { text, inputContext, images: attachments.images, files: attachments.files }
  }

  // A steered or queued supplement travels as its own short message, carrying
  // the supplement's own attachments like any user original.
  const composeSupplementInput = async ({ executionId, triggerId }) => {
    const execution = rt.state.executions[executionId]
    if (!execution) throw failure('No such execution', 'orch/not-found')
    const task = rt.state.tasks[execution.taskId]
    if (!task) throw failure('No such task', 'orch/not-found')
    const trigger = rt.state.triggers[triggerId]
    if (!trigger) throw invalid('补充原话不存在或已回收')
    const workspace = rt.state.workspaces[execution.workspaceRef ?? task.workspaceRef]
    if (!workspace?.cwd) throw invalid('执行目录已不可用，无法拼装补充消息')
    const attachments = await attachmentsOf([trigger], workspace.cwd)
    const text = rt.supplementShort({ supplement: trigger.text, scope: scopeTextOf(execution.scope ?? task.scope),
      ...(attachments.total ? { attachments } : {}) })
    return { text, images: attachments.images, files: attachments.files }
  }

  Object.assign(rt, { composeWorkerInput, composeSupplementInput })
}
