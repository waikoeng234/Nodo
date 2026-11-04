import {
  h, Fragment, useState, useEffect, useSyncExternalStore, call, Menu, Button, StateDot, MarkdownText, MARKDOWN_LABELS, workDot, workLabel, sessionTime,
  IconRightUpOutlineRegular, IconChevronDownOutlineRegular, IconThinkOutlineRegular, IconEditOutlineRegular,
} from './ui-shared.js'
import { transcriptOf, watchTranscript, subscribeStore, getStoreVersion } from './live.js'
import { RoleAvatar } from './avatar.tsx'
import { transcriptRows, toolRow, ProcessRow, MessageTime } from './feed.js'
import { supportedStreamRecord } from './stream-records.js'
import { StreamingText } from './streaming-text.tsx'
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
    const owner = source?.kind === 'lead' && entry.session.engine !== 'dsh' ? byId.get(source.leadSessionId) : undefined
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
      Object.assign(step, { ended: mark.ended }, mark.unconfirmed ? { unconfirmed: true } : {}, mark.stoppedBy ? { stoppedBy: mark.stoppedBy } : {})
      flush()
      continue
    }
    if (line.origin?.kind === 'report' && step) {
      delete step.ended
      delete step.unconfirmed
      delete step.stoppedBy
      Object.assign(step, { report: line.references?.[0]?.messages?.[0]?.text ?? line.text, at: line.at })
      flush()
    }
    if (line.origin && !(line.who === 'user' && line.origin.kind === 'task')) continue
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
// retry continuations stay inside.
const delegationRows = (lines, step) => {
  const boundary = line => line.who === 'user' && line.origin?.kind !== 'retry'
  const start = step.deferred ? lines.findIndex(line => boundary(line) && line.at >= step.at) + 1
    : lines.findLastIndex(line => boundary(line) && (step.at === undefined || line.at <= step.at)) + 1
  const end = lines.findIndex((line, index) => index >= start && boundary(line))
  return transcriptRows(step.deferred && start === 0 ? [] : lines.slice(start, end < 0 ? undefined : end))
}
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
      ? h('div', { key: row.index, className: 'nodo-round-text' }, h(StreamingText, { text: row.item.text, streaming: row.item.open === true && work?.active === true, labels: MARKDOWN_LABELS }))
      : row.item.kind === 'thinking'
        ? h(ProcessRow, { key: row.index, kind: 'thinking', variant: { icon: IconThinkOutlineRegular }, timeline: true, title: '思考',
          summary: (row.item.text ?? '').split('\n')[0].replaceAll('**', '') || null, body: row.item.text ?? '' })
        : toolRow(row, { profile: { id: step.profile }, session: { id: step.session }, work: step.ended ? undefined : work, timeline: true })),
    buffer !== null && h('div', { key: 'live', className: 'nodo-round-text' },
      h(StreamingText, { text: buffer, streaming: true, labels: MARKDOWN_LABELS })))
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
    reason && h('p', { className: 'nodo-round-quiet' }, acceptance ? `${reason} · 依据 ${acceptance.references.length} 项` : reason))
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
  const task = round.tasks?.find(item => item.id === step.taskId)
  const word = taskWord(task, work, step.unconfirmed === true)
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
        step.hard && tag('难题', 'caution'), step.reused && tag('续用', 'accent'),
        step.branch && tag('隔离'),
        // An ended card says it once: the ending text replaces the task-level word.
        !step.ended && word ? tag(word, TASK_TONES[word]) : null,
        live ? h('span', { className: 'nodo-round-status', 'data-state': 'live' }, h(StateDot, { state: workDot(work), size: 7 }), label ? `${label} · ` : null, runDuration(now - (work.since ?? now)))
          : step.ended ? h('span', { className: 'nodo-round-status', 'data-state': 'ended' }, h(StateDot, { state: 'warning', size: 7 }),
              step.unconfirmed ? '结果未确认'
                : step.stoppedBy && (step.ended === 'cancelled' || step.ended === 'interrupted') ? '已停止'
                : step.ended === 'cancelled' ? '已取消' : step.ended === 'interrupted' ? '已中断' : '已结束')
            : step.report ? h(MessageTime, { at: step.at }) : h('span', { className: 'nodo-round-status' }, '未回报'),
        live && round.onStop && h('button', { type: 'button', className: 'nodo-round-open', disabled: stopping, 'aria-label': `停止 ${role.name}`,
          onClick: () => { setConfirming(true); void round.onStop(step).finally(() => setConfirming(false)) } },
          h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true }, h('rect', { width: 10, height: 10, rx: 2 })), stopping ? '停止中…' : '停止'),
        step.taskId && round.onSupplement && h('button', { type: 'button', className: 'nodo-round-open', 'aria-label': `补充 ${task?.title ?? role.name}`,
          onClick: () => round.onSupplement(step) }, h(IconEditOutlineRegular, { size: 14 }), '补充'),
        h('button', { type: 'button', className: 'nodo-round-open', onClick: () => round.onOpen(step.session) },
          h(IconRightUpOutlineRegular, { size: 14 }), '查看会话')),
      step.report ? h(Fragment, null,
        rest || step.taskId
          ? h('button', { type: 'button', className: 'nodo-round-summary', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
            h('span', null, summary), h(IconChevronDownOutlineRegular, { size: 14 }))
          : h('p', { className: 'nodo-round-summary' }, summary),
        h(RoundChanges, { step }))
        : h(RoundTools, { step, work }),
      !step.report && step.ended && h('p', { className: 'nodo-round-quiet' }, '没有回报主控，可查看会话了解进度。'),
      open && rest && h('div', { className: 'nodo-round-report' }, h(MarkdownText, { text: rest, labels: MARKDOWN_LABELS })),
      open && step.taskId && h(RoundTask, { step })))
}

export function RoundFaces({ roles }) {
  return h('span', { className: 'nodo-round-faces', role: 'img', 'aria-label': roles.map(role => role.name).join('、') },
    roles.map(role => h(RoleAvatar, { key: role.id, profile: role, size: 20 })))
}

export function RoundMenu({ members, work, struct, workspace, onOpen }) {
  const [open, setOpen] = useState(false)
  const [latest, setLatest] = useState(new Map())
  useEffect(() => {
    if (!open) return
    let live = true
    call('task-list', { workspace }).then(list => {
      if (!live) return
      const newest = new Map()
      for (const task of list ?? []) for (const execution of task.executions ?? []) {
        const held = newest.get(execution.sessionId)
        if (held && held.createdAt >= execution.createdAt) continue
        newest.set(execution.sessionId, { title: task.title, task, createdAt: execution.createdAt,
          at: Math.max(execution.endedAt ?? 0, execution.startedAt ?? 0, execution.createdAt ?? 0) || undefined })
      }
      setLatest(newest)
    }).catch(() => {})
    return () => { live = false }
  }, [open, struct])
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, align: 'end',
    items: members.map(({ role, session }) => {
        const status = workLabel(work?.[session.id])
        const hit = latest.get(session.id)
        const idle = taskWord(hit?.task, work?.[session.id])
        return { id: session.id, icon: h(RoleAvatar, { profile: role, size: 18, running: work?.[session.id]?.active === true }),
          label: h('span', { className: 'nodo-round-menu-item' },
            h('span', { className: 'nodo-round-title' }, hit?.title ?? session.name),
            h('span', { className: 'nodo-round-menu-meta' },
              [role.name, sessionTime(hit?.at ?? session.updatedAt)].filter(Boolean).join(' · '),
              status ? h('span', { className: 'nodo-row-running' }, h(StateDot, { state: workDot(work[session.id]), size: 8 }), status)
                : idle ? h('span', null, idle) : null)) }
      }),
    onSelect: id => {
      setOpen(false)
      onOpen(id)
    },
    anchor: h(Button, { variant: 'ghost', size: 'sm', 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: () => setOpen(value => !value) }, '查看会话', h(IconChevronDownOutlineRegular, { size: 14 })),
  })
}
