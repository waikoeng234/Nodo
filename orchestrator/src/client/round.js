import {
  h, Fragment, useState, useEffect, useRef, useSyncExternalStore, call, Button, StateDot, WorkDot, MarkdownText, MARKDOWN_LABELS, workDot, workLabel,
  HoverCard, contextPercent, cacheHitPercent, exactTokens, turnTokens, IconDatabaseOutlineRegular, IconRightUpOutlineRegular, IconChevronDownOutlineRegular, IconThinkOutlineRegular, IconEditOutlineRegular,
} from './ui-shared.js'
import { EngineMark } from './engine-logos.js'
import { modelName } from './model-options.js'
import { transcriptOf, watchTranscript, subscribeStore, getStoreVersion } from './live.js'
import { RoleAvatar } from './avatar.tsx'
import { transcriptRows, toolRow, ProcessRow, MessageTime } from './transcript-rows.js'
import { supportedStreamRecord } from './stream-records.js'
import { StreamingText } from './streaming-text.tsx'
import { PlanDock } from './todo-dock.js'
import { runDuration } from './running.js'

const NODO_BLOCK = /^```nodo[ \t]*\r?\n[\s\S]*?(?:^```[ \t]*$|(?![\s\S]))/gm
export const stripNodo = text => String(text ?? '').replace(NODO_BLOCK, '').trim()

// Executor sessions a non-dsh lead session dispatched, keyed both ways.
export function roundIndex(view) {
  const all = view.profiles.flatMap(role => role.sessions.map(session => ({ role, session })))
  const byId = new Map(all.map(entry => [entry.session.id, entry]))
  const lead = new Map(), members = new Map()
  for (const entry of all) {
    const source = entry.session.source
    const owner = source?.kind === 'lead' ? byId.get(source.leadSessionId) : undefined
    if (!owner || owner.session.engine === 'dsh') continue
    lead.set(entry.session.id, owner)
    members.set(owner.session.id, [...members.get(owner.session.id) ?? [], entry])
  }
  for (const list of members.values()) list.sort((a, b) => (a.session.createdAt ?? 0) - (b.session.createdAt ?? 0))
  return { lead, members }
}

export function roundLines(lines, leadRunning = false) {
  const out = [], members = []
  const steps = new Map()
  const flush = () => out.push(...members.splice(0).map(step => ({ who: 'system', kind: 'member', step })))
  for (const line of lines) {
    if (line.who === 'user') flush()
    const mark = line.delegation
    if (mark && !mark.ended) {
      const step = { session: mark.session, profile: mark.profile, type: mark.type, hard: mark.hard, reused: mark.reused, at: line.at,
        ...(mark.branch ? { branch: mark.branch } : {}),
        ...(mark.taskId ? { taskId: mark.taskId, executionId: mark.executionId } : {}) }
      if (mark.deferred) step.deferred = true
      steps.set(mark.session, step)
      members.push(step)
      out.push({ who: 'system', kind: 'delegate', step })
      continue
    }
    const step = steps.get(mark?.session ?? line.origin?.session)
    if (mark?.ended && step) {
      Object.assign(step, { ended: mark.ended }, mark.ended === 'done' ? { at: line.at } : {}, mark.unconfirmed ? { unconfirmed: true } : {}, mark.stoppedBy ? { stoppedBy: mark.stoppedBy } : {})
      flush()
      continue
    }
    if (line.origin?.kind === 'report' && step) {
      delete step.ended
      delete step.unconfirmed
      delete step.stoppedBy
      Object.assign(step, { report: line.references?.[0]?.messages?.[0]?.text ?? line.origin?.preview ?? line.text, at: line.at })
      flush()
    }
    if (line.origin && !(line.who === 'user' && (line.origin.kind === 'task' || line.origin.kind === 'decision-answer'))
      && !(line.who === 'system' && line.origin.kind === 'decision-cancel')) continue
    const text = line.who === 'agent' && line.kind === 'text' ? stripNodo(line.text) : null
    if (text === '') continue
    out.push(text === null ? line : { ...line, text })
  }
  if (!leadRunning) flush()
  const shown = []
  let due = true
  for (const line of out) {
    if (line.who === 'user' || line.kind === 'member') due = true
    else if (due && line.kind !== 'usage' && line.kind !== 'delegate') { shown.push({ who: 'system', kind: 'speaker' }); due = false }
    shown.push(line)
  }
  return shown
}

const plainLine = line => line.replace(/^\s*(?:[#>*-]+\s*)+/, '').replaceAll('**', '').trim()
const reportParts = text => {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex(line => plainLine(line))
  return { summary: at < 0 ? '' : plainLine(lines[at]), rest: lines.slice(at + 1).join('\n').trim() }
}
const roleOf = (round, id) => round.profiles.find(role => role.id === id) ?? { id, name: id }

const TASK_TONES = { 进行中: 'accent', 待验收: 'accent', 等待用户: 'caution', 受阻: 'caution', 未确认: 'caution' }
// Task views carry no executions; the newest execution's status travels as
// latestExecutionStatus instead.
const taskWord = (task, work, unconfirmed = false) => {
  if (!task) return ''
  if (task.status === 'done') return '已完成'
  if (task.status === 'review') return '待验收'
  if (task.status === 'stopped') return '已停止'
  if (task.status === 'blocked') return unconfirmed || task.latestExecutionStatus === 'unconfirmed' ? '未确认' : '受阻'
  if (work?.status === 'waiting-approval' || work?.status === 'waiting-question') return '等待用户'
  return work?.active || task.latestExecutionStatus === 'running' ? '进行中' : task.status === 'open' ? '待执行' : ''
}

// A type name comes from the round lead's team first — the same id may carry
// different names per team — then any team that knows it; an unknown id names
// itself.
const typeName = (round, id) => (round.teams?.find(team => team.lead === round.leadId)?.types ?? []).find(item => item.id === id)?.name
  ?? (round.teams ?? []).flatMap(team => team.types ?? []).find(item => item.id === id)?.name ?? id

// One delegation's transcript window: from its task line to the next one;
// retry continuations and the user's own input stay inside. Saves without
// execution ids treat every non-retry user line as a task line.
const delegationLines = (lines, step) => {
  if (step.executionId) {
    const start = lines.findIndex(line => line.origin?.kind === 'delegation' && line.origin.executionId === step.executionId) + 1
    const end = lines.findIndex((line, index) => index >= start && line.origin?.kind === 'delegation')
    return start === 0 ? [] : lines.slice(start, end < 0 ? undefined : end)
  }
  const boundary = line => line.who === 'user' && line.origin?.kind !== 'retry'
  const start = step.deferred ? lines.findIndex(line => boundary(line) && line.at >= step.at) + 1
    : lines.findLastIndex(line => boundary(line) && (step.at === undefined || line.at <= step.at)) + 1
  const end = lines.findIndex((line, index) => index >= start && boundary(line))
  return step.deferred && start === 0 ? [] : lines.slice(start, end < 0 ? undefined : end)
}
const delegationRows = (lines, step) => transcriptRows(delegationLines(lines, step))
const shownChanges = row => row.item.kind === 'changes' && supportedStreamRecord(row.item.presentation)
  && row.item.presentation.body.fileCount > 0

// A reused session has several tasks; keep each delegation's recent output in
// its own row, the live reply as the newest entry.
function RoundTools({ step, work }) {
  useSyncExternalStore(subscribeStore, getStoreVersion)
  const lines = transcriptOf(`${step.profile}:${step.session}`)
  useEffect(() => watchTranscript(step.profile, step.session), [step.profile, step.session])
  const shown = delegationRows(lines, step).filter(row => row.item.who !== 'user'
    && (['text', 'thinking', 'tool'].includes(row.item.kind) || shownChanges(row)))
  const changes = shown.findLast(shownChanges)
  const rows = [...shown.filter(row => row.item.kind !== 'changes').slice(-4), ...(changes ? [changes] : [])]
    .sort((a, b) => a.index - b.index)
  const buffer = work?.active === true && work.timeline !== true && (work.buffer ?? '').trim() !== '' ? work.buffer : null
  return (rows.length > 0 || buffer !== null) && h('div', { className: 'nodo-round-tools' },
    rows.map(row => row.item.kind === 'text'
      ? h('div', { key: row.index, className: 'nodo-round-text' }, h(StreamingText, { text: row.item.text, streaming: row.item.open === true && work?.active === true, labels: MARKDOWN_LABELS, fileLinks: false }))
      : row.item.kind === 'thinking'
        ? h(ProcessRow, { key: row.index, kind: 'thinking', variant: { icon: IconThinkOutlineRegular }, timeline: true, fileLinks: false, title: '思考',
          summary: (row.item.text ?? '').split('\n')[0].replaceAll('**', '') || null, body: row.item.text ?? '' })
        : toolRow(row, { profile: { id: step.profile }, session: { id: step.session }, work: step.ended ? undefined : work, timeline: true })),
    buffer !== null && h('div', { key: 'live', className: 'nodo-round-text' },
      h(StreamingText, { text: buffer, streaming: true, labels: MARKDOWN_LABELS, fileLinks: false })))
}

// A reported delegation keeps its own saved file changes under its report.
function RoundChanges({ step }) {
  useSyncExternalStore(subscribeStore, getStoreVersion)
  const lines = transcriptOf(`${step.profile}:${step.session}`)
  useEffect(() => watchTranscript(step.profile, step.session), [step.profile, step.session])
  const row = delegationRows(lines, step).findLast(shownChanges)
  return row && h('div', { className: 'nodo-round-tools' },
    toolRow(row, { profile: { id: step.profile }, session: { id: step.session }, timeline: true }))
}

function RoundTask({ step }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    call('task-get', { taskId: step.taskId }).then(task => { if (live) setDetail(task) })
      .catch(failure => { if (live) setError(failure.message || '任务详情读取失败') })
    return () => { live = false }
  }, [step.taskId, attempt])
  const acceptance = detail?.acceptances?.at(-1)
  const execution = detail?.executions?.find(item => item.id === step.executionId) ?? detail?.executions?.at(-1)
  const reason = acceptance?.reason ?? (detail?.status === 'blocked' || ['failed', 'unconfirmed'].includes(execution?.status ?? '') ? execution?.reason : null)
  if (error) return h('div', { className: 'nodo-round-task-error' },
    h('p', { className: 'nodo-round-quiet', role: 'status' }, error),
    h(Button, { variant: 'outline', size: 'sm', onClick: () => setAttempt(value => value + 1) }, '重试'))
  if (!detail) return h('p', { className: 'nodo-round-quiet', role: 'status' }, '加载中…')
  return h(Fragment, null,
    h('div', { className: 'nodo-round-report' }, h(MarkdownText, { text: detail.brief, labels: MARKDOWN_LABELS })),
    reason && h('p', { className: 'nodo-round-quiet' }, acceptance ? `${reason} · 依据 ${(acceptance.basis ?? acceptance.references).length} 项` : reason))
}

export function RoundSpeaker({ role, running }) {
  return h('div', { className: 'nodo-round-speaker' },
    h(RoleAvatar, { profile: role, size: 28, running }), h('span', { className: 'nodo-round-role' }, role.name))
}

export function RoundChip({ step, round }) {
  const role = roleOf(round, step.profile)
  return h('span', { className: 'nodo-round-chip' },
    h(RoleAvatar, { profile: role, size: 16 }), `${step.reused ? '继续派给' : '派给'} ${role.name}`)
}

export function RoundMember({ step, round }) {
  const role = roleOf(round, step.profile)
  const work = round.work?.[step.session]
  const live = !step.report && !step.ended && work?.active === true
  const failed = step.ended && step.ended !== 'done'
  const task = round.tasks?.find(item => item.id === step.taskId)
  const parent = task?.parentId && round.tasks?.find(item => item.id === task.parentId)
  const waiting = round.decisions?.some(decision => (decision.status === 'pending' || decision.status === 'answered') && decision.taskIds.includes(step.taskId))
  const word = waiting ? '等待用户' : taskWord(task, work, step.unconfirmed === true)
  const label = work?.retryWaiting ? '等待自动继续' : work?.suspect ? workLabel(work) : ''
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const stopping = work?.stopping === true || confirming
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const { summary, rest } = reportParts(step.report)
  const tag = (text, tone) => h('span', { className: 'nodo-tag', 'data-tone': tone }, text)
  return h('article', { className: 'nodo-round-member', 'aria-label': role.name },
    h(RoleAvatar, { profile: role, size: 28, running: live }),
    h('div', { className: 'nodo-round-body' },
      h('div', { className: 'nodo-round-head' },
        h('span', { className: 'nodo-round-role' }, role.name),
        tag(typeName(round, step.type)),
        parent && tag(parent.title),
        step.hard && tag('难题', 'caution'), step.reused && tag('续用', 'accent'),
        step.branch && tag('隔离'),
        // An ended card says it once: the ending text replaces the task-level word.
        !failed && word ? tag(word, TASK_TONES[word]) : null,
        live ? h('span', { className: 'nodo-round-status', 'data-state': 'live' }, h(StateDot, { state: workDot(work), size: 7 }), label ? `${label} · ` : null, runDuration(now - (work.since ?? now)))
          : failed ? h('span', { className: 'nodo-round-status', 'data-state': 'ended' }, h(StateDot, { state: 'warning', size: 7 }),
              step.unconfirmed ? '结果未确认'
                : step.stoppedBy && (step.ended === 'cancelled' || step.ended === 'interrupted') ? '已停止'
                : step.ended === 'cancelled' ? '已取消' : step.ended === 'interrupted' ? '已中断' : '已结束')
            : step.report || step.ended ? h(MessageTime, { at: step.at }) : null,
        h('span', { className: 'nodo-round-actions' },
          live && round.onStop && h('button', { type: 'button', className: 'nodo-round-open', disabled: stopping, 'aria-label': `停止 ${role.name}`,
            onClick: () => { setConfirming(true); void round.onStop(step).finally(() => setConfirming(false)) } },
            h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true }, h('rect', { width: 10, height: 10, rx: 2 })), stopping ? '停止中…' : '停止'),
          step.taskId && round.onSupplement && h('button', { type: 'button', className: 'nodo-round-open', 'aria-label': `补充 ${task?.title ?? role.name}`,
            onClick: () => round.onSupplement(step) }, h(IconEditOutlineRegular, { size: 14 }), '补充'),
          h('button', { type: 'button', className: 'nodo-round-open', onClick: () => round.onOpen(step.session) },
            h(IconRightUpOutlineRegular, { size: 14 }), '查看会话'))),
      // The live task list sits between the header and the event stream; a
      // reported member's card is its report and changes instead.
      step.report ? h(Fragment, null,
        rest || step.taskId
          ? h('button', { type: 'button', className: 'nodo-round-summary', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
            h('span', null, summary), h(IconChevronDownOutlineRegular, { size: 14 }))
          : h('p', { className: 'nodo-round-summary' }, summary),
        h(RoundChanges, { step }))
        : h(Fragment, null, h(PlanDock, { profileId: step.profile, sessionId: step.session, compact: true,
          selectLines: lines => delegationLines(lines, step) }),
          h(RoundTools, { step, work })),
      open && rest && h('div', { className: 'nodo-round-report' }, h(MarkdownText, { text: rest, labels: MARKDOWN_LABELS })),
      open && step.taskId && h(RoundTask, { step })))
}

export function RoundFaces({ roles }) {
  return h('span', { className: 'nodo-round-faces', role: 'img', 'aria-label': roles.map(role => role.name).join('、') },
    roles.map(role => h(RoleAvatar, { key: role.id, profile: role, size: 20 })))
}

// A member's state reads its newest execution, that execution's task, its live
// work and the round's open decisions; finished members fold away.
function memberState(task, execution, work, asked, handedOff) {
  if (handedOff) return { kind: 'stopped', word: '已转新会话', dot: 'stop', finished: true }
  if (task?.status === 'done') return { kind: 'done', word: '已完成', dot: 'done', finished: true }
  if (task?.status === 'stopped') return { kind: 'stopped', word: '已停止', dot: 'stop', finished: true }
  if (asked) return { kind: 'waiting', word: '等待用户', dot: 'wait', tone: 'caution' }
  if (task?.status === 'review') return { kind: 'review', word: '待验收', dot: 'done' }
  if (execution?.status === 'failed') return { kind: 'failed', word: '执行失败', dot: 'err', tone: 'fault' }
  if (task?.status === 'blocked') return { kind: 'blocked', word: execution?.status === 'unconfirmed' || task.latestExecutionStatus === 'unconfirmed' ? '未确认' : '受阻', dot: 'wait', tone: 'caution' }
  if (work?.active && (work.status?.startsWith('waiting-') || work.suspect)) return { kind: 'waiting', word: workLabel(work), dot: 'wait', tone: 'caution' }
  if (execution?.status === 'queued') return { kind: 'queued', word: '排队中', dot: 'stop' }
  if (work?.active || execution?.status === 'running') return { kind: 'running', word: '运行中', dot: 'run', tone: 'accent' }
  if (execution?.status === 'cancelled' || execution?.status === 'interrupted') return { kind: 'stopped', word: execution.status === 'cancelled' ? '已取消' : '已中断', dot: 'stop' }
  if (execution) return { kind: 'review', word: '待验收', dot: 'done' }
  return { kind: 'idle', word: workLabel(work) }
}

function ContextRing({ stats }) {
  const percent = stats ? contextPercent(stats) : null
  if (percent === null) return null
  const label = `上下文 ${exactTokens(stats.contextUsed)} / ${exactTokens(stats.contextSize)}（${percent}%）`
  return h('span', { className: 'nodo-tree-ctx', role: 'img', 'aria-label': label, title: label, 'data-level': percent >= 95 ? 'high' : percent >= 80 ? 'warn' : undefined },
    h('svg', { viewBox: '0 0 14 14', 'aria-hidden': true }, h('circle', { cx: 7, cy: 7, r: 5 }),
      h('circle', { cx: 7, cy: 7, r: 5, pathLength: 100, style: { strokeDashoffset: 100 - Math.min(100, percent) } })))
}

// The session's token buckets behind a database mark: the total, the cache hit,
// then every bucket the session has used. Inline mode keeps the card inside the
// window next to the mark and sizes it to its content.
function TokenUsage({ stats }) {
  const total = stats ? turnTokens(stats) : 0
  if (total === 0) return null
  const hit = cacheHitPercent(stats)
  const rows = [hit !== '' && ['缓存命中', `${hit}%`], ...[['未缓存输入', stats.inputTokens], ['缓存读取', stats.cacheReadTokens],
    ['缓存写入', stats.cacheWriteTokens], ['输出', stats.outputTokens]].filter(([, value]) => value > 0).map(([label, value]) => [label, exactTokens(value)])].filter(Boolean)
  return h('span', { className: 'nodo-tree-tokens', role: 'img', 'aria-label': `Token 用量 ${exactTokens(total)} tok` },
    h(HoverCard, { inline: true, fitContent: true, anchor: h(IconDatabaseOutlineRegular, { size: 14 }),
      content: h('div', { className: 'nodo-tree-usage' },
        h('div', { className: 'nodo-tree-usage-title' }, h('span', null, 'Token 用量'), h('span', null, `${exactTokens(total)} tok`)),
        h('dl', null, ...rows.flatMap(([label, value]) => [h('dt', { key: `t:${label}` }, label), h('dd', { key: `d:${label}` }, value)]))) }))
}

// The trunk runs 24px in, under the lead avatar; a member row starts 32px in
// and its avatar centre sits 17px below the row top (see .nodo-tree-row).
const TREE_TRUNK = 24, TREE_AVATAR = { x: 40, y: 17 }
const PACKET_COLORS = { down: '--dsw-alias-state-business-primary', done: '--dsw-alias-state-success-primary', review: '--dsw-alias-state-success-primary',
  waiting: '--dsw-alias-state-warn-primary', blocked: '--dsw-alias-state-warn-primary', failed: '--dsw-alias-state-error-primary', stopped: '--dsw-alias-label-tertiary' }
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// A dispatch or report travels the one route between the lead and that member;
// only that route lights up, behind the packet, and fades once it arrives.
function emitPacket(list, svg, sessionId, dir, color) {
  const row = list.querySelector(`[data-session="${sessionId}"]`)
  if (!row || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const ns = 'http://www.w3.org/2000/svg'
  const make = (tag, className) => { const el = document.createElementNS(ns, tag); if (className) el.setAttribute('class', className); return el }
  const group = make('g'), lit = make('path', 'nodo-tree-lit'), tail = make('path', 'nodo-tree-tail'), head = make('circle', 'nodo-tree-head-dot')
  const d = `M ${TREE_TRUNK} 0 V ${row.offsetTop + TREE_AVATAR.y} H ${TREE_AVATAR.x}`
  for (const path of [lit, tail]) path.setAttribute('d', d)
  group.style.setProperty('--nodo-packet', `var(${color})`)
  head.setAttribute('r', '3.6')
  group.append(lit, tail, head)
  svg.appendChild(group)
  const length = lit.getTotalLength()
  const span = (path, from, to) => { path.style.strokeDasharray = `${Math.max(0, to - from)} ${length}`; path.style.strokeDashoffset = String(-from) }
  const place = at => {
    if (dir === 'down') { span(lit, 0, at); span(tail, at - 16, at) } else { span(lit, at, length); span(tail, at, at + 16) }
    const point = lit.getPointAtLength(at)
    head.setAttribute('cx', point.x)
    head.setAttribute('cy', point.y)
  }
  place(dir === 'down' ? 0 : length)
  const duration = Math.min(720, 320 + length * 1.4), start = performance.now()
  const frame = now => {
    if (!group.isConnected) return
    const progress = Math.min(1, (now - start) / duration)
    place((dir === 'down' ? easeInOut(progress) : 1 - easeInOut(progress)) * length)
    if (progress < 1) return requestAnimationFrame(frame)
    tail.remove()
    head.setAttribute('class', 'nodo-tree-ripple')
    lit.style.opacity = '0'
    setTimeout(() => group.remove(), 520)
  }
  requestAnimationFrame(frame)
}

// The summary panel's team: the lead on its own tile, every executor session it
// dispatched hanging off one trunk, planned tasks no session holds yet, and the
// finished sessions folded into one row.
export function RoundTeam({ lead, members, work, tasks, decisions, stats, workspace, onOpen }) {
  const [latest, setLatest] = useState(null)
  const [folded, setFolded] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef(null), linksRef = useRef(null), seen = useRef(null), visits = useRef({})
  const leadId = lead?.session.id
  const rows = members.map(({ role, session }) => {
    const hit = latest?.get(session.id)
    const asked = hit && (decisions ?? []).find(decision => (decision.status === 'pending' || decision.status === 'answered')
      && (decision.taskIds.includes(hit.task.id) || decision.sourceExecutionIds?.includes(hit.execution.id)))
    const state = memberState(hit?.task, hit?.execution, work?.[session.id], asked, hit?.handedOff)
    const note = ['waiting', 'blocked', 'failed'].includes(state.kind) ? asked?.questions?.[0]?.question || hit?.execution.reason : undefined
    return { id: session.id, role, session, title: hit?.task.title ?? session.name, attempts: hit?.count ?? 0, note, ...state }
  })
  const pending = (tasks ?? []).filter(task => task.coordinatorSessionId === leadId && task.status === 'open' && task.latestExecutionStatus == null
    && !tasks.some(child => child.parentId === task.id))
  const done = rows.filter(row => row.finished)
  const active = rows.filter(row => !row.finished)
  const leadWork = leadId ? work?.[leadId] : undefined
  const leadState = leadWork?.active ? memberState(undefined, undefined, leadWork)
    : active.length + pending.length > 0 ? { kind: 'idle' } : rows.length ? { kind: 'done', word: '已完成', dot: 'done' } : { kind: 'idle' }
  const count = kind => rows.filter(row => row.kind === kind).length
  const live = leadWork?.active === true || members.some(({ session }) => work?.[session.id]?.active === true)
  // Task statuses and which members run decide whether the list is stale;
  // unrelated structure changes do not refetch, and a folded card never does.
  const stale = [(tasks ?? []).map(task => `${task.id}:${task.status}:${task.latestExecutionStatus}`).join(), members.map(({ session }) => work?.[session.id]?.active === true).join()].join('|')

  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  // A new or continued session (more executions) sends a dispatch packet; a
  // changed outcome reports back. The first answer only records what is there.
  useEffect(() => {
    if (!latest || folded) return
    const marks = new Map(rows.map(row => [row.id, `${row.kind}:${row.attempts}`]))
    const before = seen.current
    seen.current = marks
    if (!before || !listRef.current) return
    for (const row of rows) {
      const was = before.get(row.id) ?? 'idle:0', [kind, attempts] = was.split(':')
      if (was === marks.get(row.id) || (row.finished && !showDone)) continue
      if ((row.kind === 'running' || row.kind === 'queued') && +attempts < row.attempts) emitPacket(listRef.current, linksRef.current, row.id, 'down', PACKET_COLORS.down)
      else if (PACKET_COLORS[row.kind] && kind !== row.kind && !(kind === 'review' && row.kind === 'done')) emitPacket(listRef.current, linksRef.current, row.id, 'up', PACKET_COLORS[row.kind])
    }
  })
  useEffect(() => {
    if (folded) return
    let current = true
    call('task-list', { workspace }).then(list => {
      if (!current) return
      const newest = new Map(), owner = new Map()
      for (const task of list ?? []) for (const execution of task.executions ?? []) {
        const held = newest.get(execution.sessionId)
        const count = (held?.count ?? 0) + 1
        if (!(held && held.execution.createdAt >= execution.createdAt)) newest.set(execution.sessionId, { task, execution, count })
        else held.count = count
        if (!(owner.get(task.id)?.createdAt >= execution.createdAt)) owner.set(task.id, execution)
      }
      for (const [sessionId, hit] of newest) hit.handedOff = owner.get(hit.task.id).sessionId !== sessionId
      setLatest(newest)
    }).catch(() => {})
    return () => { current = false }
  }, [stale, workspace, folded])

  // Working time over every turn of the session: finished turns from stats, plus the one in flight.
  const elapsed = id => {
    const ms = (stats?.[id] ? stats[id].llmMs + stats[id].toolMs : 0) + (work?.[id]?.active && work[id].since ? now - work[id].since : 0)
    return ms > 0 ? h('span', { className: 'nodo-tree-time' }, runDuration(ms)) : null
  }
  const state = row => row.word ? h('span', { className: 'nodo-round-tree-state', 'data-tone': row.tone }, row.dot && h(WorkDot, { kind: row.dot }), row.word) : null
  const model = (role, session) => {
    const route = session.model ?? role.model
    return h('span', { className: 'nodo-tree-model', title: route },
      h(EngineMark, { engine: session.engine ?? role.engine, size: 12 }), h('span', null, route && modelName(route)))
  }
  const member = row => h('button', { key: row.id, type: 'button', className: 'nodo-tree-row', 'data-session': row.id, 'data-kind': row.kind, 'data-tone': row.tone,
    'data-pending': row.kind === 'queued' ? '' : undefined, title: (row.session.engine ?? row.role.engine) === 'dsh' ? '在 dsh 中打开' : '查看会话', onClick: () => onOpen(row.id) },
    h(RoleAvatar, { profile: row.role, size: 20, running: row.kind === 'running' }),
    h('span', { className: 'nodo-tree-line' }, h('span', { className: 'nodo-tree-name' }, row.role.name), model(row.role, row.session), state(row)),
    h('span', { className: 'nodo-tree-line nodo-tree-sub' },
      h('span', { className: 'nodo-tree-title', title: row.title }, row.title),
      row.attempts > 1 && h('span', { className: 'nodo-tag', title: '同一会话续用' }, `第 ${row.attempts} 次`),
      h(TokenUsage, { stats: stats?.[row.id] }), h(ContextRing, { stats: stats?.[row.id] }), elapsed(row.id)),
    row.note ? h('span', { className: 'nodo-tree-note', title: row.note }, row.note) : null)
  const visit = kind => () => {
    const hits = active.filter(row => row.kind === kind)
    if (!hits.length) return
    visits.current[kind] = ((visits.current[kind] ?? -1) + 1) % hits.length
    const el = listRef.current?.querySelector(`[data-session="${hits[visits.current[kind]].id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    el.focus({ preventScroll: true })
    el.classList.remove('nodo-tree-locate')
    void el.offsetWidth
    el.classList.add('nodo-tree-locate')
  }
  const alert = (kind, tone, word) => count(kind) > 0 && h('button', { type: 'button', className: 'nodo-tree-alert', 'data-tone': tone, onClick: visit(kind) },
    h('i', { className: 'nodo-tree-alert-dot' }), `${count(kind)} ${word}`)
  // Arrow keys step through the lead and every focusable row.
  const step = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...event.currentTarget.querySelectorAll('.nodo-tree-lead, button.nodo-tree-row')]
    const at = items.indexOf(event.target)
    if (at < 0) return
    event.preventDefault()
    items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus()
  }

  return h('div', { className: 'nodo-team nodo-team-tree' },
    h('div', { className: 'nodo-panel-head nodo-tree-head' },
      h('span', null, '团队'),
      alert('waiting', 'caution', '等待用户'), alert('failed', 'fault', '失败'),
      h('button', { type: 'button', className: 'nodo-tree-toggle', 'aria-expanded': !folded, title: folded ? '展开团队' : '收起团队', onClick: () => setFolded(value => !value) },
        `${count('running')} 运行中 · ${count('done')}/${rows.length} 已完成`, h(IconChevronDownOutlineRegular, { size: 14 }))),
    !folded && h('div', { className: 'nodo-round-tree', role: 'tree', 'aria-label': '团队', onKeyDown: step },
      lead && h('button', { type: 'button', className: 'nodo-tree-lead', 'data-session': leadId, title: '查看主控会话', onClick: () => onOpen(leadId) },
        h(RoleAvatar, { profile: lead.role, size: 28, running: leadState.kind === 'running' }),
        h('span', { className: 'nodo-tree-line' }, h('span', { className: 'nodo-tree-name' }, lead.role.name), state(leadState)),
        h('span', { className: 'nodo-tree-line nodo-tree-sub' }, model(lead.role, lead.session), h(TokenUsage, { stats: stats?.[leadId] }), h(ContextRing, { stats: stats?.[leadId] }), elapsed(leadId))),
      (rows.length > 0 || pending.length > 0) && h('div', { className: 'nodo-tree-list', ref: listRef },
        h('svg', { className: 'nodo-tree-links', ref: linksRef, 'aria-hidden': true }),
        ...active.map(member),
        ...pending.map(task => h('div', { key: `task:${task.id}`, className: 'nodo-tree-row', 'data-kind': 'open', 'data-pending': '' },
          h('i', { className: 'nodo-tree-hole' }),
          h('span', { className: 'nodo-tree-line' }, h('span', { className: 'nodo-tree-name' }, '待派发')),
          h('span', { className: 'nodo-tree-line nodo-tree-sub' }, h('span', { className: 'nodo-tree-title', title: task.title }, task.title)))),
        done.length > 0 && h('button', { key: 'finished', type: 'button', className: 'nodo-tree-row nodo-tree-fold', 'aria-expanded': showDone, onClick: () => setShowDone(value => !value) },
          h(RoundFaces, { roles: done.slice(-4).map(row => row.role) }), h('span', null, `已完成 ${done.length}`), h(IconChevronDownOutlineRegular, { size: 14 })),
        ...(showDone ? done.map(member) : []))))
}
