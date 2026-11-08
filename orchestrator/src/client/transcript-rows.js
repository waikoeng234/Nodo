import { h, useState, MARKDOWN_LABELS, TOOL_VARIANTS, toolVariant, DisclosureRow, IconThinkOutlineRegular } from './ui-shared.js'
import { ToolCall, toolCallQuery } from './tool-call.tsx'
import { supportedStreamRecord, StreamRecordCard, streamProgress, toolFileCards } from './stream-records.js'
import { StreamingText } from './streaming-text.tsx'
import { useHoverPreview, useHoverPreviewPlacement } from './hover-preview.tsx'
import { toolFileChange } from './tool-file.ts'
import { ToolTimeline } from './tool-timeline.tsx'

export function ProcessRow({ kind, variant, title, summary, body, input, output, progress, running, error, status, timeline, file, scope, fileLinks }) {
  const [open, setOpen] = useState(false)
  const hover = useHoverPreview()
  const text = typeof body === 'string' ? body.trim() : ''
  const expandable = text !== '' || Boolean(input) || Boolean(output) || Boolean(progress)
  const streaming = running === true
  const progressNote = streamProgress(progress)
  const collapsed = summary ? [
    h('span', { key: 'sep', className: 'nodo-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
    kind === 'thinking'
      ? h('span', { key: 'summary', className: 'nodo-think-summary', 'data-streaming': streaming ? '' : undefined }, summary)
      : h('span', { key: 'summary', className: 'nodo-row-summary', 'data-error': error ? '' : undefined }, summary),
  ] : null
  const disclosure = kind === 'thinking' && !timeline ? {
    icon: (variant ?? TOOL_VARIANTS.generic).icon({ size: 14 }),
    title, open, expandable, running: streaming, expandOnRowClick: true, keepContentWhenOpen: true,
    contentClassName: 'nodo-row-content', contentLayoutClassName: 'nodo-row-content-layout',
    onToggle: () => setOpen(current => !current),
    collapsedContent: collapsed,
  } : {
    label: title || '工具调用', activeLabel: `${title || '工具调用'}中`, query: kind === 'thinking' ? summary ?? '' : toolCallQuery(input, summary ?? ''),
    compact: timeline, kind,
    status: error ? 'error' : streaming ? 'running' : status ?? 'done', open, onOpenChange: setOpen,
  }
  const cards = kind === 'tool' && file ? toolFileCards(file, hover, scope) : null
  useHoverPreviewPlacement(hover)
  // 只有成功或运行中的文件行收起输入输出；失败等状态保留原有展开能力。
  const settledFile = kind === 'tool' && file && ['done', 'running', 'started'].includes(disclosure.status)
  return h(kind === 'thinking' && !timeline ? DisclosureRow : ToolCall, {
    ...disclosure,
    ...(cards ? { queryNode: cards.chip } : {}),
    ...(settledFile ? { expandable: false, onOpenChange: () => {} } : {}),
    ...(cards ? { after: cards.preview } : {}),
    children: kind === 'thinking'
      ? h('div', { className: 'nodo-think-body' }, h(StreamingText, { text: body, streaming, labels: MARKDOWN_LABELS, variant: 'compact', fileLinks }))
      : settledFile ? null : h('div', { className: 'nodo-io-card' },
        ...(progressNote ? [h('p', { className: 'nodo-note' }, progressNote)] : []),
        ...(input || output ? [['输入', input], ['输出', output]] : [[streaming ? '输入' : '输出', body]])
          .filter(([, value]) => value).map(([label, value]) => h('div', { key: label, className: 'nodo-io-section' },
            h('span', { className: 'nodo-io-label' }, label),
            h('span', { className: 'nodo-io-text', 'data-error': error && label === '输出' ? '' : undefined }, value))),
        ...(progress?.outputPreview ? [h('div', { key: 'output-preview', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, '输出预览'), h('span', { className: 'nodo-io-text' }, progress.outputPreview))] : []),
        ...(progress?.stdoutTail ? [h('div', { key: 'stdout-tail', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stdout（尾部）'), h('span', { className: 'nodo-io-text' }, progress.stdoutTail))] : []),
        ...(progress?.stderrTail ? [h('div', { key: 'stderr-tail', className: 'nodo-io-section' },
          h('span', { className: 'nodo-io-label' }, 'stderr（尾部）'), h('span', { className: 'nodo-io-text' }, progress.stderrTail))] : [])),
  })
}

// The engine's plan: one replaceable row per turn showing the step list the
export function PlanRow({ plan, running, timeline }) {
  const [open, setOpen] = useState(false)
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  const active = steps.find(step => step.status === 'in_progress') ?? steps[0]
  const summary = active ? String(active.text).split('\n')[0] : plan.text ? String(plan.text).split('\n')[0] : null
  // A markdown-form plan has no steps but a real body: it still expands.
  const expandable = steps.length > 0 || Boolean(plan.text)
  const head = timeline ? {
    label: '计划', activeLabel: '计划中', query: summary ?? '', compact: true, kind: 'plan', status: running ? 'running' : 'done', onOpenChange: setOpen,
  } : {
    icon: TOOL_VARIANTS.plan.icon({ size: 14 }), title: '计划', open, expandable, running, expandOnRowClick: expandable, keepContentWhenOpen: true,
    contentClassName: 'nodo-row-content', contentLayoutClassName: 'nodo-row-content-layout',
    onToggle: () => setOpen(state => !state),
    collapsedContent: summary ? [
      h('span', { key: 'sep', className: 'nodo-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
      h('span', { key: 'summary', className: 'nodo-row-summary', 'data-streaming': running ? '' : undefined }, summary),
    ] : null,
  }
  return h(timeline ? ToolCall : DisclosureRow, {
    ...head,
    children: steps.length > 0
      ? h('div', { className: 'nodo-plan-list' }, steps.map((step, index) => h('div', { key: index, className: 'nodo-plan-step', 'data-status': step.status ?? 'pending' },
        h('span', { className: 'nodo-plan-mark', 'aria-hidden': true }, step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '•' : '○'),
        h('span', { className: 'nodo-plan-text' }, step.text))))
      : h('div', { className: 'nodo-plan-text' }, plan.text ?? ''),
  })
}
export function toolRow(row, { profile, session, work, timeline }) {
  const { item, index } = row
  if (supportedStreamRecord(item.presentation)) return h(StreamRecordCard, { key: index, record: item.presentation,
    timeline, eventPhase: row.invocation ? 'start' : row.result ? 'end' : undefined, request: { profile: profile.id, session: session.id }, cwd: session?.cwd })
  const action = toolVariant(item.name)
  const variant = TOOL_VARIANTS[action]
  const progress = streamProgress(item.progress)
  return h(ProcessRow, {
    key: index, kind: 'tool', variant, timeline, title: `${row.invocation ? '调用 · ' : row.result ? '结果 · ' : ''}${variant.title}`,
    summary: [item.brief ? item.brief.split('\n')[0] : null, progress].filter(Boolean).join(' · ') || null,
    body: item.brief ?? '',
    input: item.input, output: item.output, progress: item.progress,
    file: ['read', 'write', 'edit'].includes(action) ? toolFileChange(item.input, session?.cwd) : null,
    scope: { profile: profile.id, session: session.id },
    running: row.running && work?.active === true, error: row.error,
    status: row.invocation ? 'started' : row.running ? 'unknown' : 'done',
  })
}
export function transcriptRows(lines) {
  const rows = []
  const open = new Map()
  const callKey = item => item.callId ? JSON.stringify([item.turnId ?? null, item.callId]) : item.name
  for (const [index, item] of lines.entries()) {
    // A cleared plan leaves no row at all: its removal is the final state.
    if (item.kind === 'plan' && (item.removed === true
      || (( !Array.isArray(item.steps) || item.steps.length === 0) && !item.text))) continue
    if (item.kind !== 'tool') {
      const retry = item.kind === 'lifecycle' && item.event === 'retry'
      // One retry run reads as one row ticking in place: the newest
      // announcement replaces the row, and an end keeps the last count.
      // The turn end closes its retries after the turn's summary rows, so an
      // end reaches back to the run.
      const last = retry && item.phase === 'end'
        ? rows.findLast(row => row.item.who === 'user' || (row.item.kind === 'lifecycle' && row.item.event === 'retry'))
        : rows.at(-1)
      if (retry && last?.item.kind === 'lifecycle' && last.item.event === 'retry'
        && (last.item.turnId === undefined || item.turnId === undefined || last.item.turnId === item.turnId))
        last.item = item.text === undefined ? { ...item, text: last.item.text } : item
      else rows.push({ item, index, running: false, error: false })
      // Engines repeat the turn failure in the row just before it: a retry run
      // that never got through, or the failure echoed as reply text. The
      // error row keeps the reason once.
      const failure = item.kind === 'error' ? String(item.text ?? '').trim() : ''
      const prev = failure ? rows.findLast(row => row.item !== item && row.item.kind !== 'changes') : undefined
      if (prev?.item.kind === 'lifecycle') {
        const note = String(prev.item.text ?? '').trim()
        prev.item = { ...prev.item, ...(prev.item.event === 'retry' ? { phase: 'end', isError: true, cancelled: undefined } : {}),
          ...(note && (note.includes(failure) || failure.includes(note)) ? { text: undefined } : {}) }
      } else if (prev?.item.who === 'agent' && prev.item.kind === 'text' && String(prev.item.text ?? '').trim() === failure)
        rows.splice(rows.indexOf(prev), 1)
      continue
    }
    if (item.phase === 'start') {
      open.set(callKey(item), rows.length)
      rows.push({ item, index, running: true, error: false })
      continue
    }
    const at = item.callId ? open.get(callKey(item)) : open.get(item.name) ?? [...open.values()].pop()
    if (at === undefined) { rows.push({ item, index, running: false, error: item.isError === true }); continue }
    open.delete(callKey(rows[at].item))
    if (item.timeline === true && at !== rows.length - 1) {
      rows[at] = { ...rows[at], running: false, invocation: true }
      rows.push({ item: { ...item, input: item.input ?? rows[at].item.input }, index, running: false, error: item.isError === true, result: true })
      continue
    }
    rows[at] = { ...rows[at], running: false, error: item.isError === true,
      item: { ...rows[at].item, brief: rows[at].item.brief ?? item.brief,
        activity: item.activity ?? rows[at].item.activity,
        parentCallId: item.parentCallId ?? rows[at].item.parentCallId,
        childId: item.childId ?? rows[at].item.childId,
        toolCallId: item.toolCallId ?? rows[at].item.toolCallId,
        input: item.input ?? rows[at].item.input, output: item.output ?? rows[at].item.output,
        progress: item.progress ?? rows[at].item.progress,
        presentation: item.presentation ?? rows[at].item.presentation } }
  }
  const groups = [[]]
  for (const row of rows) {
    if (row.item.who === 'user') groups.push([])
    if (row.item.kind === 'tool') groups.at(-1).push(row)
  }
  for (const group of groups) {
    const entities = new Map(group.filter(row => row.item.callId).map(row => [callKey(row.item), row]))
    const parentOf = item => item.parentCallId ? entities.get(callKey({ ...item, callId: item.parentCallId })) : undefined
    for (const row of group) {
      const seen = new Set([row.item.callId])
      let parent = parentOf(row.item)
      row.depth = 0
      while (parent && !seen.has(parent.item.callId) && row.depth < 8) {
        seen.add(parent.item.callId)
        row.depth += 1
        parent = parentOf(parent.item)
      }
      if (parent && seen.has(parent.item.callId)) row.depth = 0
    }
  }
  return rows
}

// Only adjacent process events share a timeline; message boundaries stay intact.
const isProcess = row => ['tool', 'thinking', 'plan'].includes(row.item.kind)
export function processBlocks(rows) {
  const blocks = []
  rows.forEach((row, position) => {
    if (row.item.kind === 'changes') { blocks.push({ process: false, rows: [{ row, position }] }); return }
    const last = blocks.at(-1)
    if (isProcess(row) && last?.process) last.rows.push({ row, position })
    else blocks.push({ process: isProcess(row), rows: [{ row, position }] })
  })
  return blocks
}
export function ProcessGroup({ rows, running, depths = [], children = [] }) {
  const thinking = rows.filter(item => item.kind === 'thinking').length
  const plans = rows.filter(item => item.kind === 'plan').length
  const countCalls = items => new Set(items.map(item => item.callId ?? item)).size
  const activities = countCalls(rows.filter(item => item.activity === true))
  const tools = countCalls(rows.filter(item => item.kind === 'tool' && item.activity !== true))
  const summary = [thinking && `思考 ${thinking}`, tools && `工具 ${tools}`, activities && `子任务 ${activities}`, plans && `计划 ${plans}`].filter(Boolean).join(' · ')
  const steps = rows.map((item, index) => {
    const icon = item.kind === 'thinking' ? IconThinkOutlineRegular
      : TOOL_VARIANTS[item.kind === 'plan' ? 'plan' : toolVariant(item.name)].icon
    const child = children[index]
    return { id: String(child?.key ?? child?.props.key ?? index), icon: h(icon, { size: 14 }), content: child,
      active: child?.props.running === true || child?.props.record?.status === 'running' && !child.props.eventPhase && running === true,
      depth: depths[index], callId: item.callId, parentCallId: item.parentCallId }
  })
  return h(ToolTimeline, { steps, summary, streaming: running })
}

// A decision answer is saved as raw values; it reads as each question with the
// option or words the user chose.
export const decisionAnswerText = (item, decisions) => {
  const decision = item.origin?.kind === 'decision-answer' && decisions?.find(entry => entry.id === item.origin.decisionId)
  if (!decision?.answer) return
  return decision.questions.map(question => {
    const value = decision.answer.values[question.id]
    return `${question.question}\n${question.options?.find(option => option.id === value?.optionId)?.label ?? value?.text ?? ''}`
  }).join('\n\n')
}
const clockText = at => {
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

export function MessageTime({ at }) {
  const text = clockText(at)
  return text === '' ? null : h('time', { className: 'nodo-msg-time', dateTime: new Date(at).toISOString() }, text)
}

