import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { INSTRUCTIONS_MAX, TRANSCRIPT_TEXT_MAX, CONTEXT_LIST_MAX, CONTEXT_PAGE_DEFAULT, CONTEXT_PAGE_MAX, INPUT_CONTEXT_MAX, RESULT_PREVIEW_MAX } from './constants.js'
import { clip, toolText } from './text.js'
import { transcriptReplies } from './session-references.js'
import { failure, invalid } from './errors.js'
import { leadModeOf, currentUserRequestOf } from '../shared/lead.js'
import { nativeIdOf } from '../shared/session.js'
import { executionResultOf, executionResultView } from './tasks.js'

const shorten = (value, max) => {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

export function install(rt) {
  const cleanTaskState = raw => {
    if (raw === null) return null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Task state must be an object or null')
    const state = {}
    if (raw.objective !== undefined) {
      if (typeof raw.objective !== 'string') throw invalid('Task objective must be text')
      state.objective = raw.objective
    }
    for (const key of ['completed', 'evidence', 'pending', 'next']) {
      if (raw[key] === undefined) continue
      if (!Array.isArray(raw[key]) || raw[key].length > 20 || raw[key].some(item => typeof item !== 'string')) throw invalid(`Task ${key} must be a list of at most 20 texts`)
      state[key] = [...raw[key]]
    }
    if (JSON.stringify(state).length > INSTRUCTIONS_MAX) throw invalid('Task state is too long')
    return rt.redactDeepSecrets(state)
  }

  const sessionReference = async (raw = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Reference must identify a source session')
    const { profile: ref, session: id, limit = 10 } = raw
    const profile = rt.findProfile(ref)
    if (!profile) throw invalid('Choose a valid source profile')
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid('Reference limit must be between 1 and 20')
    const { session } = rt.conversation(profile.id, id)
    await rt.loadSecrets()
    const nativeId = nativeIdOf(session)
    const reports = nativeId && typeof rt.ctx.sessionController?.inspect === 'function'
      ? (await rt.referenceReplies({ profile: profile.id, session: session.id })).messages.slice(0, limit).reverse()
      : transcriptReplies(rt.transcriptOf(session.id)).slice(-limit)
    const max = Math.floor(TRANSCRIPT_TEXT_MAX / Math.max(reports.length, 1))
    return rt.redactDeepSecrets({
      source: { kind: 'agent', profileId: profile.id, profileName: session.profileName ?? profile.name, sessionId: session.id, sessionName: session.name },
      messages: reports.map(line => ({ at: line.at, text: line.text.slice(0, max), ...(line.text.length > max ? { truncated: true } : {}) })),
    })
  }

  const recordTaskOutcome = (id, task, reason, report) => {
    const found = rt.conversationOf(id)
    if (!found || task === null) return
    found.session.lastTurn = rt.redactDeepSecrets({ task: clip(rt.redactDeepSecrets(task), INSTRUCTIONS_MAX, 'last task'), reason,
      report: clip(rt.redactDeepSecrets(report ?? ''), INSTRUCTIONS_MAX, 'last report'), at: Date.now() })
  }

  // sourceId handles project existing records: executions, decisions, transcript
  // messages (located by timestamp plus a content hash, so a display index is
  // never treated as a permanent address), tool detail snapshots and task
  // acceptances. No standalone Source store exists behind them.
  const messageSourceId = (sessionId, line) => `message:${sessionId}:${line.at}:${createHash('sha256').update(String(line.text ?? '')).digest('hex').slice(0, 8)}`
  const parseSourceId = raw => {
    if (typeof raw !== 'string') return null
    const parts = raw.split(':')
    if (parts[0] === 'execution' && parts.length === 3 && parts[2] === 'result') return { kind: 'execution', id: parts[1] }
    if (parts[0] === 'decision' && parts.length === 2) return { kind: 'decision', id: parts[1] }
    if (parts[0] === 'message' && parts.length === 4 && /^\d+$/.test(parts[2]) && /^[0-9a-f]{8}$/.test(parts[3])) return { kind: 'message', sessionId: parts[1], at: Number(parts[2]), hash: parts[3] }
    if (parts[0] === 'tool' && parts.length === 3) return { kind: 'tool', conversationId: parts[1], ref: parts[2] }
    if (parts[0] === 'task' && parts.length === 3 && parts[2] === 'acceptance') return { kind: 'acceptance', taskId: parts[1] }
    return null
  }
  const leadScope = async id => {
    await rt.load()
    const owner = rt.conversationOf(id)
    if (!owner || !leadModeOf(owner.profile, owner.session)) throw invalid('调用方必须是有效主控会话')
    rt.assertSessionWritable(owner.profile, owner.session)
    return owner
  }
  const ownedTaskOf = (id, taskId) => {
    const task = rt.state.tasks[taskId]
    if (!task) throw failure('No such task', 'orch/not-found')
    if (task.coordinatorSessionId !== id) throw invalid('任务不属于本主控会话')
    return task
  }
  const executorSessions = id => [...new Set(Object.values(rt.state.executions)
    .filter(execution => rt.state.tasks[execution.taskId]?.coordinatorSessionId === id).map(execution => execution.sessionId).filter(Boolean))]
  const sessionAllowed = (id, sessionId) => sessionId === id || executorSessions(id).includes(sessionId)
  const decisionAnswerText = (question, answer) => !answer ? '（未回答）'
    : answer.text ?? question.options?.find(option => option.id === answer.optionId)?.label ?? '（答案指向的选项不存在）'
  const decisionText = decision => decision.questions.map(question => `问题：${question.question}\n回答：${decisionAnswerText(question, decision.answer?.values?.[question.id])}`).join('\n\n')
  const acceptanceText = acceptance => ['验收结论：' + acceptance.reason,
    ...(Array.isArray(acceptance.basis) && acceptance.basis.length ? ['依据：', ...acceptance.basis.map(item => `- ${item}`)] : [])].join('\n')
  const toolBodyText = record => {
    const inputText = record.body.inputText ?? (record.body.input !== undefined ? toolText(record.body.input) : undefined)
    return ['工具：' + record.title,
      ...(record.body.command ? [`命令：${record.body.command}`] : []),
      ...(record.body.cwd ? [`目录：${record.body.cwd}`] : []),
      ...(inputText ? [`输入：\n${inputText}`] : []),
      ...(record.body.outputText ? [`输出：\n${record.body.outputText}`] : []),
      ...(record.body.exitCode !== undefined ? [`退出码：${record.body.exitCode}`] : [])].join('\n')
  }
  const executionEntry = (execution, result) => ({ ...result, taskId: execution.taskId, executionId: execution.id,
    description: shorten(rt.state.tasks[execution.taskId].title, RESULT_PREVIEW_MAX), source: 'execution-result', status: execution.status, executionReason: execution.reason })

  // Resolves one handle to a bounded view: metadata, completeness as fixed by the
  // record itself, and the full stored text for paging. Cleaned sources return
  // unavailable instead of reconstructed prose.
  const resolveContextSource = async (id, sourceId) => {
    const parsed = parseSourceId(sourceId)
    if (!parsed) throw invalid('无效的 sourceId')
    if (parsed.kind === 'execution') {
      const execution = rt.state.executions[parsed.id]
      if (!execution) throw failure('No such execution', 'orch/not-found')
      ownedTaskOf(id, execution.taskId)
      return { kind: 'execution', ...executionEntry(execution, { ...await executionResultOf(execution, rt), sourceId }) }
    }
    if (parsed.kind === 'decision') {
      const decision = rt.state.decisions[parsed.id]
      if (!decision || decision.coordinatorSessionId !== id) throw invalid('决策不存在或不属于本主控会话')
      return { sourceId, kind: 'decision', source: 'decision', decisionId: decision.id, status: decision.status, at: decision.createdAt,
        description: shorten(decision.questions[0]?.question, 120), completeness: decision.answer ? 'complete' : 'partial',
        ...(decision.answer ? {} : { reason: 'no-answer' }), text: decisionText(decision) }
    }
    if (parsed.kind === 'message') {
      if (!sessionAllowed(id, parsed.sessionId)) throw invalid('消息不属于本主控会话或其任务')
      const line = rt.transcriptOf(parsed.sessionId).find(line => line.at === parsed.at && createHash('sha256').update(String(line.text ?? '')).digest('hex').slice(0, 8) === parsed.hash)
      return line
        ? { sourceId, kind: 'message', source: 'message', sessionId: parsed.sessionId, who: line.who, at: line.at,
            description: shorten(line.text, 120), completeness: 'complete', text: String(line.text ?? '') }
        : { sourceId, kind: 'message', source: 'message', sessionId: parsed.sessionId, at: parsed.at,
            description: '已清理的会话消息', completeness: 'unavailable', reason: 'cleaned', text: '' }
    }
    if (parsed.kind === 'tool') {
      if (!sessionAllowed(id, parsed.conversationId)) throw invalid('工具记录不属于本主控会话或其任务')
      const entry = rt.state.streamDetails?.[parsed.ref]
      if (!entry || entry.conversationId !== parsed.conversationId) throw invalid('工具记录不存在或不属于本主控会话')
      try {
        const found = rt.conversationOf(parsed.conversationId)
        const record = await rt.readStreamDetail({ profile: found.profile.id, session: parsed.conversationId, ref: parsed.ref })
        return { sourceId, kind: 'tool', source: 'tool-record', sessionId: parsed.conversationId, entityId: record.entityId, status: record.status,
          description: shorten(record.title, 120), completeness: record.capture, ...(record.reason ? { reason: record.reason } : {}), text: toolBodyText(record) }
      } catch {
        return { sourceId, kind: 'tool', source: 'tool-record', sessionId: parsed.conversationId, entityId: entry.entityId,
          description: `工具记录 ${entry.entityId}`, completeness: 'unavailable', reason: 'cleaned', text: '' }
      }
    }
    const task = ownedTaskOf(id, parsed.taskId)
    const acceptance = task.acceptances?.at(-1)
    if (!acceptance) throw invalid('任务还没有验收记录')
    return { sourceId, kind: 'acceptance', source: 'task-acceptance', taskId: task.id, at: acceptance.createdAt,
      description: shorten(acceptance.reason, 120), completeness: 'complete', text: acceptanceText(acceptance) }
  }

  const contextList = async (id, args) => {
    await leadScope(id)
    const state = rt.state
    if (args.sourceId !== undefined || args.offset !== undefined || args.limit !== undefined) throw invalid('list 不接受 sourceId、offset 或 limit')
    if (args.taskId !== undefined) ownedTaskOf(id, args.taskId)
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > RESULT_PREVIEW_MAX)) throw invalid('query 最多 200 字符')
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(args.cursor) || !Number.isSafeInteger(Number(args.cursor)))) throw invalid('无效 cursor')
    const owned = Object.values(state.executions).filter(execution => state.tasks[execution.taskId]?.coordinatorSessionId === id
      && (args.taskId === undefined || execution.taskId === args.taskId))
    const executions = owned.filter(execution => !['queued', 'running'].includes(execution.status))
    const linked = decision => args.taskId === undefined || [decision.taskIds ?? [], decision.acceptanceTaskIds ?? [],
      (decision.sourceExecutionIds ?? []).map(value => state.executions[value]?.taskId)].some(list => list.includes(args.taskId))
    const decisions = Object.values(state.decisions).filter(decision => decision.coordinatorSessionId === id && linked(decision))
    const sessions = args.taskId === undefined ? [id, ...executorSessions(id)] : [...new Set(owned.map(execution => execution.sessionId).filter(Boolean))]
    const descriptors = [
      ...executions.map(execution => ({ kind: 'execution', execution, sourceId: `execution:${execution.id}:result`,
        search: shorten(`${rt.state.tasks[execution.taskId].title}\n${execution.result?.preview ?? execution.report ?? ''}`, 400).toLowerCase() })),
      ...decisions.map(decision => ({ kind: 'decision', decision, sourceId: `decision:${decision.id}`,
        search: shorten(decision.questions[0]?.question, 120).toLowerCase() })),
      ...Object.values(state.tasks).filter(task => task.coordinatorSessionId === id && task.acceptances?.length && (args.taskId === undefined || task.id === args.taskId))
        .map(task => ({ kind: 'acceptance', task, sourceId: `task:${task.id}:acceptance`, search: shorten(task.acceptances.at(-1).reason, 120).toLowerCase() })),
      ...sessions.flatMap(sessionId => rt.transcriptOf(sessionId)
        .filter(line => line.kind === 'text' && typeof line.text === 'string' && line.text.trim())
        .map(line => {
          const sourceId = messageSourceId(sessionId, line)
          return { kind: 'message', sourceId, search: shorten(line.text, 120).toLowerCase(),
            item: { sourceId, source: 'message', sessionId, who: line.who, at: line.at, description: shorten(line.text, 120), completeness: 'complete' } }
        })),
      ...Object.values(state.streamDetails ?? {}).filter(entry => sessions.includes(entry.conversationId))
        .map(entry => ({ kind: 'tool', entry, sourceId: `tool:${entry.conversationId}:${entry.ref}`, search: String(entry.entityId).toLowerCase() })),
    ]
    const offset = Number(args.cursor ?? 0), query = args.query?.toLowerCase()
    const matched = query ? descriptors.filter(item => item.search.includes(query)) : descriptors
    const page = matched.slice(offset, offset + CONTEXT_LIST_MAX)
    const items = await Promise.all(page.map(async item => {
      if (item.kind === 'execution') return executionEntry(item.execution, await executionResultView(item.execution, rt))
      if (item.kind === 'decision') return { sourceId: item.sourceId, source: 'decision', decisionId: item.decision.id, status: item.decision.status,
        at: item.decision.createdAt, description: shorten(item.decision.questions[0]?.question, 120),
        completeness: item.decision.answer ? 'complete' : 'partial', ...(item.decision.answer ? {} : { reason: 'no-answer' }) }
      if (item.kind === 'acceptance') return { sourceId: item.sourceId, source: 'task-acceptance', taskId: item.task.id,
        at: item.task.acceptances.at(-1).createdAt, description: shorten(item.task.acceptances.at(-1).reason, 120), completeness: 'complete' }
      if (item.kind === 'message') return item.item
      try {
        const found = rt.conversationOf(item.entry.conversationId)
        const record = await rt.readStreamDetail({ profile: found.profile.id, session: item.entry.conversationId, ref: item.entry.ref })
        return { sourceId: item.sourceId, source: 'tool-record', sessionId: item.entry.conversationId, entityId: record.entityId, status: record.status,
          description: shorten(record.title, 120), completeness: record.capture, ...(record.reason ? { reason: record.reason } : {}) }
      } catch {
        return { sourceId: item.sourceId, source: 'tool-record', sessionId: item.entry.conversationId, entityId: item.entry.entityId,
          description: `工具记录 ${item.entry.entityId}`, completeness: 'unavailable', reason: 'cleaned' }
      }
    }))
    return { items, nextCursor: offset + CONTEXT_LIST_MAX < matched.length ? String(offset + CONTEXT_LIST_MAX) : null }
  }

  const contextRead = async (id, args) => {
    await leadScope(id)
    if (args.taskId !== undefined || args.query !== undefined || args.cursor !== undefined) throw invalid('read 不接受 taskId、query 或 cursor')
    const offset = args.offset ?? 0, limit = args.limit ?? CONTEXT_PAGE_DEFAULT
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > CONTEXT_PAGE_MAX) throw invalid('offset 必须是非负整数，limit 必须为 1–16000')
    const found = await resolveContextSource(id, args.sourceId)
    const { text, ...metadata } = found
    const end = Math.min(offset + limit, text.length)
    return { ...metadata, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null }
  }

  const executionContext = async (id, args) => {
    if (args?.action === 'read') return contextRead(id, args)
    if (args?.action === 'list') return contextList(id, args)
    throw invalid('action 必须是 list 或 read')
  }

  // Dispatch context: selections are fixed once at acceptance, with their text
  // held in memory, so later source transcript cleanup cannot alter a queued
  // dispatch's input. Defaults follow explicit relations only; an explicit
  // context parameter replaces them entirely so the lead can always escape an
  // oversized default.
  const toSelection = (found, role) => ({ sourceId: found.sourceId, kind: found.kind, role, description: found.description,
    completeness: found.completeness, ...(found.reason ? { reason: found.reason } : {}), text: found.text ?? '', length: (found.text ?? '').length })
  const dedupe = entries => {
    const seen = new Set(), kept = []
    for (const entry of entries) {
      if (seen.has(entry.sourceId)) continue
      seen.add(entry.sourceId)
      kept.push(entry)
    }
    return kept
  }
  const linkedDecisions = (id, taskIds) => Object.values(rt.state.decisions).filter(decision => decision.coordinatorSessionId === id && decision.answer
    && [decision.taskIds ?? [], decision.acceptanceTaskIds ?? [], (decision.sourceExecutionIds ?? []).map(value => rt.state.executions[value]?.taskId)]
      .some(list => list.some(value => taskIds.includes(value))))
  const defaultDispatchContext = async (id, relations) => {
    const required = [], background = []
    const stored = relations.taskId ? rt.state.tasks[relations.taskId]?.source?.request : undefined
    if (stored && typeof stored.text === 'string' && stored.text.trim()) {
      required.push(toSelection({ sourceId: messageSourceId(id, stored), kind: 'message',
        description: shorten(stored.text, 120), completeness: 'complete', text: stored.text }, 'required'))
    } else {
      const request = currentUserRequestOf(rt.transcriptOf(id))
      if (request && typeof request.text === 'string' && request.text.trim()) required.push(toSelection(await resolveContextSource(id, messageSourceId(id, request)), 'required'))
    }
    const taskIds = [relations.taskId, relations.parentId, ...(relations.dependsOn ?? [])].filter(Boolean)
    for (const decision of linkedDecisions(id, taskIds)) required.push(toSelection(await resolveContextSource(id, `decision:${decision.id}`), 'required'))
    for (const taskId of relations.dependsOn ?? []) {
      const task = rt.state.tasks[taskId]
      const acceptance = task?.acceptances?.at(-1)
      if (!task || !acceptance) continue
      required.push(toSelection(await resolveContextSource(id, `task:${taskId}:acceptance`), 'required'))
      const ended = Object.values(rt.state.executions).filter(execution => execution.taskId === taskId && !['queued', 'running'].includes(execution.status))
      const ids = acceptance.executionIds?.length ? acceptance.executionIds : ended.slice(-1).map(execution => execution.id)
      for (const executionId of ids) {
        const execution = rt.state.executions[executionId]
        if (!execution || execution.taskId !== taskId) continue
        background.push(toSelection(await resolveContextSource(id, `execution:${executionId}:result`), 'background'))
        const view = await executionResultView(execution, rt)
        if (view.preview) required.push({ sourceId: view.sourceId, kind: 'execution', role: 'required',
          description: `依赖任务「${shorten(task.title, 60)}」结果预览`, completeness: view.completeness,
          ...(view.reason ? { reason: view.reason } : {}), text: view.preview, length: view.preview.length, previewOnly: true })
      }
    }
    // A preview-only required entry for one source must not drop the full
    // background copy of the same source.
    const full = new Set(required.filter(entry => !entry.previewOnly).map(entry => entry.sourceId))
    return { required: dedupe(required), background: dedupe(background.filter(entry => !full.has(entry.sourceId))) }
  }
  const explicitDispatchContext = async (id, context) => {
    const required = [], background = []
    for (const sourceId of context.required) {
      const found = await resolveContextSource(id, sourceId)
      if (found.completeness === 'unavailable') throw invalid(`必需来源不可用或已清理：${sourceId}（${found.reason ?? 'unavailable'}）`)
      required.push(toSelection(found, 'required'))
    }
    for (const sourceId of context.background) {
      if (context.required.includes(sourceId)) continue
      background.push(toSelection(await resolveContextSource(id, sourceId), 'background'))
    }
    return { required: dedupe(required), background: dedupe(background) }
  }
  const selectDispatchContext = async ({ leadSessionId, taskId, parentId, dependsOn, context }) => context
    ? explicitDispatchContext(leadSessionId, context)
    : defaultDispatchContext(leadSessionId, { taskId, parentId, dependsOn })

  const BACKGROUND_NOTE = 'Background material for this task is archived as files under .nodo/workflow-inputs/; paths are listed after the task. Read them with your file tools as needed.\n\n'
  const backgroundFileName = entry => `${entry.kind}-${entry.sourceId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)}.md`
  const composeDispatchInput = async ({ workspaceCwd, header, instruction, task, required, background }) => {
    const writable = background.filter(entry => entry.text.trim())
    const bodies = writable.map(entry => rt.redactDeepSecrets(entry.text))
    const paths = writable.length ? await rt.place(writable.map((entry, index) => ({ name: backgroundFileName(entry), bytes: Buffer.from(bodies[index], 'utf8') })), workspaceCwd) : []
    const catalog = writable.map((entry, index) => ({ sourceId: entry.sourceId, kind: entry.kind, description: entry.description,
      completeness: entry.completeness, ...(entry.reason ? { reason: entry.reason } : {}), fileName: basename(paths[index]), path: paths[index],
      bytes: Buffer.byteLength(bodies[index], 'utf8') }))
    const omitted = background.filter(entry => !entry.text.trim()).map(entry => ({ sourceId: entry.sourceId, kind: entry.kind,
      description: entry.description, reason: entry.reason ?? 'unavailable' }))
    const body = header + (catalog.length ? BACKGROUND_NOTE : '') + instruction + task + rt.renderRequired(required)
      + rt.renderBackground([...catalog, ...omitted.map(entry => ({ ...entry, completeness: 'unavailable', path: null }))])
    if (body.length > INPUT_CONTEXT_MAX) throw invalid(`派活最终输入 ${body.length} 字符超过预算 ${INPUT_CONTEXT_MAX}，请缩小任务或减少必需内容；本轮未发送`)
    const inputContext = { at: Date.now(), length: body.length, preview: shorten(body, RESULT_PREVIEW_MAX),
      required: required.map(({ text, ...descriptor }) => descriptor), background: catalog, ...(omitted.length ? { omitted } : {}) }
    return { text: body, inputContext }
  }

  Object.assign(rt, { cleanTaskState, sessionReference, recordTaskOutcome, executionContext, resolveContextSource, selectDispatchContext, composeDispatchInput })
}
