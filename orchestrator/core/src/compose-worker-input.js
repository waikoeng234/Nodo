// Worker input: everything a lead-routed execution receives, composed from
// saved records alone — the composer takes only an execution id, so what a
// worker was sent can always be replayed from the record. Under budget
// pressure the drop order is fixed: history window, then handover summaries
// (handles stay), then prior-round details; the trigger and supplement texts
// and the attachment list are never dropped.
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { INPUT_CONTEXT_MAX, TRANSCRIPT_MAX, RESULT_PREVIEW_MAX, REWORK_MAX_DEFAULT, HISTORY_USER_MAX, HISTORY_REPLY_MAX, HISTORY_TEXT_MAX } from './constants.js'
import { clip } from './text.js'
import { failure, invalid } from './errors.js'
import { decisionAnswerText } from './triggers.js'

const HISTORY_ITEM_MAX = 2_000
const PRIOR_LADDER = [Infinity, 4_000, 800]
const messageHash = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8)
const messageHandle = (sessionId, line) => `message:${sessionId}:${line.at}:${messageHash(line.text)}`
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
      ? decisionAnswerText(rt.state.decisions[line.origin.decisionId] ?? { questions: [] }) : line.text
    const pick = (list, max) => list.slice(-max)
    const users = pick(lines.filter(line => rt.isUserTriggerLine(line)), HISTORY_USER_MAX)
      .map(line => ({ at: line.at, who: '用户', handle: messageHandle(leadSessionId, line), text: clip(originalText(line), HISTORY_ITEM_MAX, '历史消息') }))
    const replies = pick(lines.filter(line => line.who === 'agent' && line.kind === 'text'), HISTORY_REPLY_MAX)
      .map(line => ({ at: line.at, who: '主控', handle: messageHandle(leadSessionId, line), text: clip(line.text, HISTORY_ITEM_MAX, '历史消息') }))
    const merged = [...users, ...replies].sort((a, b) => a.at - b.at)
    let total = merged.reduce((sum, item) => sum + item.text.length, 0)
    while (total > HISTORY_TEXT_MAX && merged.length) total -= merged.shift().text.length
    return { items: merged.map(item => `[${item.who}] ${item.text}`), handles: merged.map(item => item.handle),
      trimmed: lines.length >= TRANSCRIPT_MAX }
  }

  const reviewedOf = execution => {
    const source = rt.state.executions[execution.sourceExecutionId]
    if (!source) return undefined
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
  const priorLinesOf = execution => {
    const task = rt.state.tasks[execution.taskId]
    if (execution.triggerId === task.triggerId) {
      const findings = rt.state.executions[execution.sourceExecutionId]?.reportData?.findings ?? []
      const lines = findings.map(item => `- [${item.severity ?? 'medium'}] ${item.category ?? 'other'}：${item.text}`)
      if (lines.length) return lines
    }
    const previous = Object.values(rt.state.executions)
      .filter(item => item.taskId === execution.taskId && item.id !== execution.id && item.endedAt != null)
      .sort((a, b) => a.endedAt - b.endedAt).at(-1)
    const summary = previous?.reportData?.summary ?? previous?.result?.preview ?? ''
    return [summary ? `上一执行：${summary}` : '上一执行没有可用摘要。']
  }
  // Four kinds of cross-task material: dependency acceptances and linked
  // decisions come from the default dispatch context as summaries plus
  // handles; a dependency's last result is archived into the task directory
  // like today and named only by path; a continues source's last result is a
  // summary plus handle.
  const continuesOf = task => {
    const sourceTask = rt.state.tasks[task.source?.continuesTaskId]
    const [previous] = Object.values(rt.state.executions)
      .filter(item => item.taskId === sourceTask?.id && item.endedAt != null)
      .sort((a, b) => b.endedAt - a.endedAt)
    return sourceTask && previous ? { title: sourceTask.title, summary: previous.reportData?.summary ?? previous.result?.preview ?? '',
      sourceId: `execution:${previous.id}:result` } : undefined
  }

  const composeWorkerInput = async executionId => {
    const execution = rt.state.executions[executionId]
    if (!execution) throw failure('No such execution', 'orch/not-found')
    const task = rt.state.tasks[execution.taskId]
    if (!task) throw failure('No such task', 'orch/not-found')
    const trigger = rt.state.triggers[execution.triggerId]
    if (!trigger) throw invalid('执行缺少触发消息记录，无法拼装 worker 输入')
    const workspace = rt.state.workspaces[execution.workspaceRef ?? task.workspaceRef]
    if (!workspace?.cwd) throw invalid('执行目录已不可用，无法拼装 worker 输入')
    const stage = execution.stage ?? 'implement'
    const supplements = (execution.supplements ?? []).map(id => rt.state.triggers[id]?.text).filter(Boolean)

    const images = []
    for (const ref of trigger.images ?? []) try { images.push(await rt.imageOf(ref)) } catch { /* a lost byte degrades to its absence */ }
    const files = (await rt.materializeFiles(trigger.files ?? [], workspace.cwd)).map(path => relative(realpathSync(workspace.cwd), path))

    const parts = { requirement: rt.workerRequirement(trigger.text) }
    if (supplements.length) parts.supplements = rt.workerSupplements(supplements)
    if (images.length || files.length) parts.attachments = rt.workerAttachments({ images, files })
    const taskTrigger = task.triggerId !== execution.triggerId ? rt.state.triggers[task.triggerId] : undefined
    if (taskTrigger) parts.original = rt.workerOriginal({ text: taskTrigger.text, scope: scopeTextOf(task.scope) })
    parts.scope = rt.workerScope(scopeTextOf(execution.scope ?? task.scope))
    parts.stage = rt.workerStage({ stage, round: roundOf(execution), maxRework: maxReworkOf(execution),
      reviewFail: task.triggerId !== undefined && execution.triggerId === task.triggerId })
    if (stage === 'review' && execution.sourceExecutionId) parts.reviewed = rt.workerReviewed(reviewedOf(execution))
    if (stage === 'answer' && Array.isArray(execution.questions) && execution.questions.length) parts.questions = rt.workerQuestions(execution.questions)
    if (stage === 'rework') parts.prior = rt.workerPrior(priorLinesOf(execution))

    const defaults = await rt.selectDispatchContext({ leadSessionId: task.coordinatorSessionId, taskId: task.id,
      parentId: task.parentId, dependsOn: task.dependsOn })
    const continues = task.source?.continuesTaskId ? continuesOf(task) : undefined
    const background = defaults.background
    const writable = background.filter(entry => entry.text.trim())
    const bodies = writable.map(entry => rt.redactDeepSecrets(entry.text))
    const placed = writable.length ? await rt.place(writable.map((entry, index) => ({ name: `background-${index + 1}.md`, bytes: Buffer.from(bodies[index], 'utf8') })), workspace.cwd) : []
    const catalog = writable.map((entry, index) => ({ sourceId: entry.sourceId, kind: entry.kind, description: entry.description,
      completeness: entry.completeness, ...(entry.reason ? { reason: entry.reason } : {}), path: relative(realpathSync(workspace.cwd), placed[index]),
      bytes: Buffer.byteLength(bodies[index], 'utf8') }))
    const omitted = background.filter(entry => !entry.text.trim()).map(entry => ({ sourceId: entry.sourceId, kind: entry.kind,
      description: entry.description, reason: entry.reason ?? 'unavailable' }))
    if (defaults.required.length || catalog.length || continues) parts.handover = rt.workerHandover({
      required: defaults.required.map(({ sourceId, description }) => ({ sourceId, description })),
      background: catalog.map(({ description, path }) => ({ description, path })),
      continues: continues ? [continues] : [] })

    let history, historyHandles = []
    if (isNewWorkerSession(execution.sessionId)) {
      history = historyWindow(task.coordinatorSessionId)
      historyHandles = history.handles
      parts.history = rt.workerHistory(history)
    }
    parts.report = rt.workerReportMethod({ degraded: rt.conversationOf(execution.sessionId)?.profile.engine === 'dsh', answers: stage === 'answer' })

    const order = ['requirement', 'supplements', 'attachments', 'original', 'scope', 'stage', 'reviewed', 'questions', 'prior', 'handover', 'history', 'report']
    const join = () => order.map(key => parts[key]).filter(Boolean).join('\n\n')
    let text = join()
    if (text.length > INPUT_CONTEXT_MAX && parts.history !== undefined) {
      delete parts.history
      history = undefined
      historyHandles = []
      text = join()
    }
    if (text.length > INPUT_CONTEXT_MAX && parts.handover !== undefined) {
      parts.handover = rt.workerHandover({ required: defaults.required.map(({ sourceId }) => ({ sourceId })),
        background: catalog.map(({ path }) => ({ path })), continues: continues ? [{ ...continues, summary: '' }] : [] })
      text = join()
    }
    for (const max of PRIOR_LADDER.slice(1)) {
      if (text.length <= INPUT_CONTEXT_MAX || parts.prior === undefined) break
      parts.prior = clip(parts.prior, max, '前序结论')
      text = join()
    }
    if (text.length > INPUT_CONTEXT_MAX) throw invalid(`派活输入 ${text.length} 字符超过预算 ${INPUT_CONTEXT_MAX}，本轮未发送`)

    execution.historyHandles = historyHandles
    execution.contextHandles = [...defaults.required.map(item => item.sourceId), ...(continues ? [continues.sourceId] : [])]
    const inputContext = { at: Date.now(), length: text.length, preview: text.slice(0, RESULT_PREVIEW_MAX),
      required: defaults.required.map(({ text: entryText, ...descriptor }) => descriptor), background: catalog,
      ...(omitted.length ? { omitted } : {}) }
    return { text, inputContext, images, files }
  }

  // A steered or queued supplement travels as its own short message.
  const composeSupplementInput = async ({ executionId, triggerId }) => {
    const execution = rt.state.executions[executionId]
    if (!execution) throw failure('No such execution', 'orch/not-found')
    const task = rt.state.tasks[execution.taskId]
    if (!task) throw failure('No such task', 'orch/not-found')
    const trigger = rt.state.triggers[triggerId]
    if (!trigger) throw invalid('补充原话不存在或已回收')
    const images = []
    for (const ref of trigger.images ?? []) try { images.push(await rt.imageOf(ref)) } catch { /* a lost byte degrades to its absence */ }
    return { text: rt.supplementShort({ supplement: trigger.text, scope: scopeTextOf(execution.scope ?? task.scope) }), images }
  }

  Object.assign(rt, { composeWorkerInput, composeSupplementInput })
}
