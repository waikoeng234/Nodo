import {
  h, useState, useEffect, call, Menu, Button, StateDot, MarkdownText, MARKDOWN_LABELS, workDot, workLabel,
  IconBrowseOutlineRegular, IconChevronDownOutlineRegular, IconFlatListOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { transcriptRows, toolRow, MessageTime } from './feed.js'
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
// the lead's message and the executor's own message after it, filled in by the
// later ended or report marker; the lead's next words get a fresh speaker row.
export function roundLines(lines) {
  const out = [], steps = new Map()
  let due = true
  for (const line of lines) {
    const mark = line.delegation
    if (mark && !mark.ended) {
      const step = { session: mark.session, profile: mark.profile, type: mark.type, hard: mark.hard, reused: mark.reused, at: line.at }
      steps.set(mark.session, step)
      out.push({ who: 'system', kind: 'delegate', step }, { who: 'system', kind: 'member', step })
      due = true
      continue
    }
    const step = steps.get(mark?.session ?? line.origin?.session)
    if (mark?.ended && step) { Object.assign(step, { ended: mark.ended }, mark.unconfirmed ? { unconfirmed: true } : {}); continue }
    if (line.origin?.kind === 'report' && step) Object.assign(step, { report: line.references?.[0]?.messages?.[0]?.text ?? line.text, at: line.at })
    if (line.origin) continue
    const text = line.who === 'agent' && line.kind === 'text' ? stripNodo(line.text) : null
    if (text === '') continue
    if (line.who === 'user') due = true
    else if (due && line.kind !== 'usage') { out.push({ who: 'system', kind: 'speaker' }); due = false }
    out.push(text === null ? line : { ...line, text })
  }
  return out
}

const plainLine = line => line.replace(/^\s*(?:[#>*-]+\s*)+/, '').replaceAll('**', '').trim()
const reportParts = text => {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex(line => plainLine(line))
  return { summary: at < 0 ? '' : plainLine(lines[at]), rest: lines.slice(at + 1).join('\n').trim() }
}
const roleOf = (round, id) => round.profiles.find(role => role.id === id) ?? { id, name: id }

// The executor's latest tool calls of its current turn; older ones scroll out.
function RoundTools({ step, work }) {
  const [lines, setLines] = useState([])
  useEffect(() => {
    let live = true
    void call('transcript', { profile: step.profile, session: step.session }).then(next => { if (live) setLines(next) }).catch(() => {})
    return () => { live = false }
  }, [step.session, work?.active === true ? work : null])
  const rows = transcriptRows(lines.slice(lines.findLastIndex(line => line.who === 'user') + 1)).filter(row => row.item.kind === 'tool').slice(-5)
  return rows.length > 0 && h('div', { className: 'nodo-round-tools' },
    rows.map(row => toolRow(row, { profile: { id: step.profile }, session: { id: step.session }, work, timeline: true })))
}

export function RoundSpeaker({ role, running }) {
  return h('div', { className: 'nodo-round-speaker' },
    h(RoleAvatar, { profile: role, size: 28, running }), h('span', { className: 'nodo-round-role' }, role.name))
}

export function RoundChip({ step, round }) {
  const role = roleOf(round, step.profile)
  return h('span', { className: 'nodo-round-chip' },
    h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M5 12h14M13 6l6 6-6 6' })),
    h(RoleAvatar, { profile: role, size: 16 }), `${step.reused ? '继续派给' : '派给'} ${role.name}`)
}

export function RoundMember({ step, round }) {
  const role = roleOf(round, step.profile)
  const work = round.work?.[step.session]
  const live = !step.report && !step.ended && work?.active === true
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const { summary, rest } = reportParts(step.report)
  const tag = (text, tone) => h('span', { className: 'nodo-round-tag', 'data-tone': tone }, text)
  return h('article', { className: 'nodo-round-member', 'aria-label': role.name },
    h(RoleAvatar, { profile: role, size: 28, running: live }),
    h('div', { className: 'nodo-round-body' },
      h('div', { className: 'nodo-round-head' },
        h('span', { className: 'nodo-round-role' }, role.name),
        tag(round.taskTypes?.find(item => item.id === step.type)?.name ?? step.type),
        step.hard && tag('难题', 'hard'), step.reused && tag('续用', 'reused'),
        live ? h('span', { className: 'nodo-round-status', 'data-state': 'live' }, h(StateDot, { state: 'ongoing', size: 7 }), runDuration(now - (work.since ?? now)))
          : step.ended ? h('span', { className: 'nodo-round-status', 'data-state': 'ended' }, '未完成')
            : step.report ? h(MessageTime, { at: step.at }) : h('span', { className: 'nodo-round-status' }, '未回报'),
        h('button', { type: 'button', className: 'nodo-round-open', onClick: () => round.onOpen(step.session) },
          h(IconBrowseOutlineRegular, { size: 14 }), '查看会话')),
      step.report ? rest
        ? h('button', { type: 'button', className: 'nodo-round-summary', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
          h('span', null, summary), h(IconChevronDownOutlineRegular, { size: 14 }))
        : h('p', { className: 'nodo-round-summary' }, summary)
        : live ? h(RoundTools, { step, work })
          : step.ended && h('p', { className: 'nodo-round-quiet' }, step.ended === 'interrupted' ? '已中断，没有回报主控。' : '没有回报主控。'),
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
    items: [{ id: 'raw', label: '完整记录', icon: h(IconFlatListOutlineRegular) },
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
