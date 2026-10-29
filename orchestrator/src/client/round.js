import {
  h, useState, useEffect, call, Menu, Button, StateDot, MarkdownText, MARKDOWN_LABELS, workDot, workLabel,
  IconRightUpOutlineRegular, IconChevronDownOutlineRegular, IconBrowseOutlineRegular, IconThinkOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { transcriptRows, toolRow, ProcessRow, MessageTime } from './feed.js'
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

// The lead's transcript as a chat room: each delegation becomes a chip under
// the lead's message and one executor message that parks at the feed's bottom
// while it runs and lands at its ended or report marker once one arrives, never
// splitting the lead's turn; a speaker row opens wherever user text or an
// executor message precedes the lead's next words.
export function roundLines(lines) {
  const out = [], members = [], chips = []
  const steps = new Map()
  let at = 0
  const land = (member, slot) => { member.slot = slot; member.seq = ++at }
  for (const line of lines) {
    if (line.who === 'user') {
      out.push(...chips.splice(0))
      for (const member of members) if (member.hold) { land(member, out.length); member.hold = false }
    }
    const mark = line.delegation
    if (mark && !mark.ended) {
      const step = { session: mark.session, profile: mark.profile, type: mark.type, hard: mark.hard, reused: mark.reused, at: line.at }
      const member = { step }
      steps.set(mark.session, member)
      members.push(member)
      chips.push({ who: 'system', kind: 'delegate', step })
      continue
    }
    const member = steps.get(mark?.session ?? line.origin?.session)
    const step = member?.step
    if (mark?.ended && member) {
      Object.assign(step, { ended: mark.ended }, mark.unconfirmed ? { unconfirmed: true } : {})
      member.hold = true
      continue
    }
    if (line.origin?.kind === 'report' && member) {
      delete step.ended
      delete step.unconfirmed
      Object.assign(step, { report: line.references?.[0]?.messages?.[0]?.text ?? line.text, at: line.at })
      land(member, out.length)
      member.hold = false
    }
    if (line.origin) continue
    const text = line.who === 'agent' && line.kind === 'text' ? stripNodo(line.text) : null
    if (text === '') continue
    out.push(text === null ? line : { ...line, text })
  }
  out.push(...chips.splice(0))
  for (const member of members) if (!member.step.report && (member.hold || !member.step.ended)) land(member, out.length)
  for (const { step, slot } of [...members].sort((a, b) => b.slot - a.slot || b.seq - a.seq)) out.splice(slot, 0, { who: 'system', kind: 'member', step })
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

// A reused session has several tasks; keep each delegation's recent output in
// its own row, the live reply as the newest entry.
function RoundTools({ step, work }) {
  const [lines, setLines] = useState([])
  useEffect(() => {
    let live = true
    void call('transcript', { profile: step.profile, session: step.session }).then(next => { if (live) setLines(next) }).catch(() => {})
    return () => { live = false }
  }, [step.session, step.at, work?.active === true ? work : null])
  const boundary = line => line.who === 'user' && line.origin?.kind !== 'retry'
  const start = lines.findLastIndex(line => boundary(line) && (step.at === undefined || line.at <= step.at)) + 1
  const end = lines.findIndex((line, index) => index >= start && boundary(line))
  const rows = transcriptRows(lines.slice(start, end < 0 ? undefined : end))
    .filter(row => row.item.who !== 'user' && ['text', 'thinking', 'tool'].includes(row.item.kind)).slice(-5)
  const buffer = work?.active === true && work.timeline !== true && (work.buffer ?? '').trim() !== '' ? work.buffer : null
  return (rows.length > 0 || buffer !== null) && h('div', { className: 'nodo-round-tools' },
    rows.map(row => row.item.kind === 'text'
      ? h('div', { key: row.index, className: 'nodo-round-text' }, h(StreamingText, { text: row.item.text, labels: MARKDOWN_LABELS }))
      : row.item.kind === 'thinking'
        ? h(ProcessRow, { key: row.index, kind: 'thinking', variant: { icon: IconThinkOutlineRegular }, timeline: true, title: '思考',
          summary: (row.item.text ?? '').split('\n')[0].replaceAll('**', '') || null, body: row.item.text ?? '' })
        : toolRow(row, { profile: { id: step.profile }, session: { id: step.session }, work: step.ended ? undefined : work, timeline: true })),
    buffer !== null && h('div', { key: 'live', className: 'nodo-round-text' },
      h(StreamingText, { text: buffer, streaming: true, labels: MARKDOWN_LABELS })))
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
  const label = work?.retryWaiting ? '等待自动继续' : work?.suspect ? workLabel(work) : ''
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
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
        tag(round.taskTypes?.find(item => item.id === step.type)?.name ?? step.type),
        step.hard && tag('难题', 'caution'), step.reused && tag('续用', 'accent'),
        live ? h('span', { className: 'nodo-round-status', 'data-state': 'live' }, h(StateDot, { state: workDot(work), size: 7 }), label ? `${label} · ` : null, runDuration(now - (work.since ?? now)))
          : step.ended ? h('span', { className: 'nodo-round-status', 'data-state': 'ended' }, h(StateDot, { state: 'warning', size: 7 }), step.unconfirmed ? '结果未确认' : step.ended === 'interrupted' ? '已中断' : '已结束')
            : step.report ? h(MessageTime, { at: step.at }) : h('span', { className: 'nodo-round-status' }, '未回报'),
        live && round.onStop && h('button', { type: 'button', className: 'nodo-round-open', disabled: stopping, 'aria-label': `停止 ${role.name}`,
          onClick: () => { setStopping(true); void round.onStop(step).finally(() => setStopping(false)) } },
          h('svg', { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'currentColor', 'aria-hidden': true }, h('rect', { width: 10, height: 10, rx: 2 })), stopping ? '停止中…' : '停止'),
        h('button', { type: 'button', className: 'nodo-round-open', onClick: () => round.onOpen(step.session) },
          h(IconRightUpOutlineRegular, { size: 14 }), '查看会话')),
      step.report ? rest
        ? h('button', { type: 'button', className: 'nodo-round-summary', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
          h('span', null, summary), h(IconChevronDownOutlineRegular, { size: 14 }))
        : h('p', { className: 'nodo-round-summary' }, summary)
        : h(RoundTools, { step, work }),
      !step.report && step.ended && h('p', { className: 'nodo-round-quiet' }, '没有回报主控，可查看会话了解进度。'),
      open && rest && h('div', { className: 'nodo-round-report' }, h(MarkdownText, { text: rest, labels: MARKDOWN_LABELS }))))
}

export function RoundFaces({ roles }) {
  return h('span', { className: 'nodo-round-faces', role: 'img', 'aria-label': roles.map(role => role.name).join('、') },
    roles.map(role => h(RoleAvatar, { key: role.id, profile: role, size: 20 })))
}

// The header's session list: the lead's raw transcript first, then every
// executor session of the round in the order it was opened.
export function RoundMenu({ members, work, raw, onRaw, onOpen }) {
  const [open, setOpen] = useState(false)
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, align: 'end', selectedId: raw ? 'raw' : undefined,
    items: [{ id: 'raw', label: '完整记录', icon: h(IconBrowseOutlineRegular) },
      ...members.map(({ role, session }) => {
        const status = workLabel(work?.[session.id])
        return { id: session.id, icon: h(RoleAvatar, { profile: role, size: 18, running: work?.[session.id]?.active === true }),
          label: h('span', { className: 'nodo-round-menu-item' },
            h('span', { className: 'nodo-round-role' }, role.name),
            h('span', { className: 'nodo-round-title' }, session.name),
            status ? h('span', { className: 'nodo-row-running' }, h(StateDot, { state: workDot(work[session.id]), size: 8 }), status) : null) }
      })],
    onSelect: id => {
      setOpen(false)
      if (id === 'raw') onRaw()
      else onOpen(id)
    },
    anchor: h(Button, { variant: 'ghost', size: 'sm', 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: () => setOpen(value => !value) }, '查看会话', h(IconChevronDownOutlineRegular, { size: 14 })),
  })
}
