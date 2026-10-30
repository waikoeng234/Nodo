import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) || !('props' in node) ? []
  : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
const text = node => nodes(node).flatMap(item => item.children ?? []).filter(child => typeof child === 'string').join('|')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('roundLines turns the lead transcript into a chat of speaker rows, delegation chips and one message per executor', async () => {
  const { roundLines } = await loadClient('round.js')
  const coder = { session: 'e1', profile: 'coder', type: 'bug-fix', hard: true, reused: false }
  const tester = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const lines = [
    { who: 'user', kind: 'text', text: 'Fix the login', at: 1 },
    { who: 'agent', kind: 'thinking', text: 'Plan', at: 2 },
    { who: 'agent', kind: 'text', text: 'Delegating\n```nodo\n{"action":"delegate"}\n```', at: 3 },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: coder, at: 4 },
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 9,
      references: [{ messages: [{ text: '## Fixed the refresh race\nDetails' }] }] },
    { who: 'agent', kind: 'text', text: '```nodo\n{}\n```', at: 10 },
    { who: 'system', kind: 'error', text: 'boom', at: 11 },
    { who: 'user', kind: 'text', text: 'Nodo 没有执行你的派活指令', origin: { kind: 'reject' } },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: tester, at: 12 },
    { who: 'system', kind: 'note', text: '执行未完成', delegation: { session: 'e2', ended: 'interrupted', unconfirmed: true } },
    { who: 'system', kind: 'note', text: '执行未完成：gone', delegation: { session: 'gone', ended: 'failed' }, at: 13 },
    { who: 'user', kind: 'text', text: '进度如何？', at: 14 },
    { who: 'agent', kind: 'text', text: 'Resuming the tester.', at: 15 },
    { who: 'system', kind: 'usage', usage: {} },
    { who: 'system', kind: 'note', text: '继续派给 Tester', delegation: { ...tester, reused: true }, at: 16 },
  ]
  const shown = plain(roundLines(lines))
  assert.deepEqual(shown.map(line => ['speaker', 'delegate', 'member', 'usage'].includes(line.kind) ? line.kind : line.text), [
    'Fix the login', 'speaker', 'Plan', 'Delegating', 'delegate', 'member', 'speaker', 'boom', '执行未完成：gone', 'delegate', 'member',
    '进度如何？', 'speaker', 'Resuming the tester.', 'usage', 'delegate', 'member'])
  assert.deepEqual(shown.filter(line => line.kind === 'member').map(line => line.step), [
    { ...coder, at: 9, report: '## Fixed the refresh race\nDetails' },
    { ...tester, at: 12, ended: 'interrupted', unconfirmed: true },
    { ...tester, reused: true, at: 16 },
  ])
  assert.deepEqual(shown.filter(line => line.kind === 'delegate').map(line => line.step.session), ['e1', 'e2', 'e2'])
  assert.deepEqual(shown.filter(line => line.who === 'user').map(line => line.text), ['Fix the login', '进度如何？'], 'only the user\'s own messages start turns')
  const unmarked = lines.filter(line => !line.delegation && !line.origin && !line.text?.includes('```nodo'))
  assert.deepEqual(plain(roundLines(unmarked)).filter(line => line.kind !== 'speaker'), plain(unmarked))
})

test('a running executor message parks at the bottom and the lead\'s turn stays one speaker segment', async () => {
  const { roundLines } = await loadClient('round.js')
  const coder = { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false }
  const tester = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const turn = [
    { who: 'user', kind: 'text', text: 'Ship it', at: 1 },
    { who: 'agent', kind: 'text', text: 'Delegating now', at: 2 },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: coder, at: 3 },
    { who: 'agent', kind: 'text', text: 'Meanwhile, here is the plan', at: 4, reply: true },
  ]
  const shape = shown => shown.map(line => ['speaker', 'delegate', 'member'].includes(line.kind) ? line.kind : line.text)
  assert.deepEqual(shape(plain(roundLines(turn))), ['Ship it', 'speaker', 'Delegating now', 'Meanwhile, here is the plan', 'delegate', 'member'],
    'the chip closes the lead\'s turn above the parked executor')
  const reported = plain(roundLines([...turn,
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 9,
      references: [{ messages: [{ text: 'Done' }] }] }]))
  assert.deepEqual(shape(reported), ['Ship it', 'speaker', 'Delegating now', 'Meanwhile, here is the plan', 'delegate', 'member'],
    'a report keeps the two-segment shape and the member lands below the chip at its marker')
  const followup = plain(roundLines([...turn,
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 9,
      references: [{ messages: [{ text: 'Done' }] }] },
    { who: 'agent', kind: 'text', text: 'Great, shipping next', at: 10 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: tester, at: 11 }]))
  assert.deepEqual(shape(followup),
    ['Ship it', 'speaker', 'Delegating now', 'Meanwhile, here is the plan', 'delegate', 'member', 'speaker', 'Great, shipping next', 'delegate', 'member'],
    'the lead\'s next turn opens below the reported member while the second executor keeps the bottom')
  const ended = plain(roundLines([...turn,
    { who: 'system', kind: 'note', text: '执行未完成', delegation: { session: 'e1', ended: 'interrupted', unconfirmed: true } },
    { who: 'agent', kind: 'text', text: 'Wrapping up anyway', at: 8 }]))
  assert.deepEqual(shape(ended), ['Ship it', 'speaker', 'Delegating now', 'Meanwhile, here is the plan', 'Wrapping up anyway', 'delegate', 'member'],
    'an ended member waits for the turn to close and lands below its chip')
  assert.equal(ended.find(line => line.kind === 'member').step.ended, 'interrupted')
})

test('members sharing an insertion point keep their dispatch or report order', async () => {
  const { roundLines } = await loadClient('round.js')
  const mark = (session, profile) => ({ session, profile, type: 'bug-fix', hard: false, reused: false })
  const running = plain(roundLines([
    { who: 'user', kind: 'text', text: 'go', at: 1 },
    { who: 'agent', kind: 'text', text: 'a', at: 2 },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: mark('e1', 'coder'), at: 3 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: mark('e2', 'tester'), at: 4 },
    { who: 'agent', kind: 'text', text: 'done', at: 5 },
  ]))
  assert.deepEqual(running.map(line => ['speaker', 'delegate', 'member'].includes(line.kind) ? line.kind : line.text),
    ['go', 'speaker', 'a', 'done', 'delegate', 'delegate', 'member', 'member'], 'both chips close the lead segment above the parked executors')
  assert.deepEqual(running.filter(line => line.kind === 'member').map(line => line.step.session), ['e1', 'e2'],
    'the bottom executors follow the dispatch order')
  const reported = plain(roundLines([
    { who: 'user', kind: 'text', text: 'go', at: 1 },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: mark('e1', 'coder'), at: 2 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: mark('e2', 'tester'), at: 3 },
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 4,
      references: [{ messages: [{ text: 'One' }] }] },
    { who: 'user', kind: 'text', text: 'Report from Tester', origin: { kind: 'report', session: 'e2' }, at: 5,
      references: [{ messages: [{ text: 'Two' }] }] },
  ]))
  assert.deepEqual(reported.filter(line => line.kind === 'member').map(line => line.step.session), ['e1', 'e2'],
    'reported executors stack in report order at the same spot')
})

test('a supplemental report clears interrupted and unconfirmed round status', async () => {
  const { roundLines, RoundMember, host } = await loadClient('round.js')
  const lines = [
    { delegation: { session: 'executor', profile: 'worker', type: 'feature' } },
    { delegation: { session: 'executor', ended: 'interrupted', unconfirmed: true } },
    { origin: { kind: 'report', session: 'executor' }, references: [{ messages: [{ text: 'Recovered successfully' }] }] },
  ]
  const step = roundLines(lines).find(line => line.kind === 'member').step
  assert.equal(step.ended, undefined)
  assert.equal(step.unconfirmed, undefined)
  assert.equal(step.report, 'Recovered successfully')
  host.reset()
  const shown = nodes(RoundMember({ step, round: { profiles: [{ id: 'worker', name: 'Worker' }], taskTypes: [], work: {} } }))
  assert.doesNotMatch(text(shown), /已中断|结果未确认/)
})

test('an executor message shows its role, tags and state, expands the rest of its report and opens its session', async () => {
  const { RoundMember, MessageTime, host } = await loadClient(['round.js', 'feed.js'])
  const opened = []
  const round = { profiles: [{ id: 'coder', name: 'Coder' }, { id: 'tester', name: 'Tester' }],
    taskTypes: [{ id: 'bug-fix', name: '修复' }, { id: 'test', name: '测试' }],
    work: { e2: { active: true, since: Date.now() - 5000 } }, onOpen: id => opened.push(id) }
  const view = step => { host.reset(); return nodes(RoundMember({ step, round })) }
  const done = { session: 'e1', profile: 'coder', type: 'bug-fix', hard: true, reused: true, at: 9, report: '## Fixed the refresh race\n- Changed auth.js' }
  const head = tree => text(tree.find(node => node.props.className === 'nodo-round-head'))
  assert.equal(head(view(done)), 'Coder|修复|难题|续用|查看会话')
  assert.equal(view(done).find(node => node.type === MessageTime).props.at, 9)
  const summary = () => view(done).find(node => node.props.className === 'nodo-round-summary')
  assert.equal(summary().type, 'button')
  assert.equal(text(summary()), 'Fixed the refresh race')
  assert.equal(view(done).find(node => node.props.className === 'nodo-round-report'), undefined)
  summary().props.onClick()
  assert.equal(summary().props['aria-expanded'], true)
  assert.equal(view(done).find(node => node.props.className === 'nodo-round-report').children[0].props.text, '- Changed auth.js')
  view(done).find(node => node.props.className === 'nodo-round-open').props.onClick()
  assert.deepEqual(opened, ['e1'])
  host.cells.length = 0
  assert.equal(view({ ...done, report: 'All green' }).find(node => node.props.className === 'nodo-round-summary').type, 'p', 'a one-line report has nothing to expand')
  const live = view({ session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false })
  assert.equal(live.find(node => node.props.size === 28).props.running, true)
  assert.equal(text(live.find(node => node.props['data-state'] === 'live')), '5s')
  assert.equal(live.find(node => node.props.step?.session === 'e2' && node.type !== RoundMember).props.work, round.work.e2)
  const ended = view({ session: 'e3', profile: 'tester', type: 'test', hard: false, reused: false, ended: 'interrupted' })
  assert.equal(head(ended), 'Tester|测试|已中断|查看会话')
  assert.equal(text(ended.find(node => node.props.className === 'nodo-round-quiet')), '没有回报主控，可查看会话了解进度。')
  assert.equal(head(view({ session: 'e5', profile: 'tester', type: 'test', ended: 'done' })), 'Tester|测试|已结束|查看会话')
  const stopped = []
  round.onStop = async step => { stopped.push(step.session) }
  round.work.e2.suspect = true
  const suspect = view({ session: 'e2', profile: 'tester', type: 'test' })
  const status = suspect.find(node => node.props['data-state'] === 'live')
  assert.equal(text(status), '疑似卡住 · |5s', 'suspicion keeps the elapsed task duration visible')
  assert.equal(status.children[0].props.state, 'warning')
  round.work.e2.seen = true
  assert.equal(text(view({ session: 'e2', profile: 'tester', type: 'test' }).find(node => node.props['data-state'] === 'live')), '5s', 'an empty label has no leading separator')
  delete round.work.e2.seen
  const stop = suspect.find(node => node.props['aria-label'] === '停止 Tester')
  assert.equal(stop.props.disabled, false, 'a suspected turn remains stoppable')
  stop.props.onClick()
  assert.deepEqual(stopped, ['e2'], 'a live member stops on its own')
  await tick()
  round.work.e2.retryWaiting = true
  const waiting = view({ session: 'e2', profile: 'tester', type: 'test' })
  assert.equal(text(waiting.find(node => node.props['data-state'] === 'live')), '等待自动继续 · |5s')
  const cancel = waiting.find(node => node.props['aria-label'] === '停止 Tester')
  assert.equal(cancel.props.disabled, false)
  cancel.props.onClick()
  await tick()
  assert.deepEqual(stopped, ['e2', 'e2'], 'a waiting member cancels on its own')
  assert.equal(view({ ...done }).find(node => node.props['aria-label'] === '停止 Coder'), undefined, 'a reported member has nothing to stop')
  delete round.onStop
  assert.equal(head(view({ session: 'e4', profile: 'tester', type: 'test', hard: false, reused: false })), 'Tester|测试|未回报|查看会话')
})

test('a delegation chip names its executor, and the faces stack lists every role of the round', async () => {
  const { RoundChip, RoundFaces, RoundSpeaker } = await loadClient('round.js')
  const round = { profiles: [{ id: 'coder', name: 'Coder' }] }
  assert.equal(text(RoundChip({ step: { profile: 'coder', reused: false }, round })), '派给 Coder')
  assert.equal(text(RoundChip({ step: { profile: 'coder', reused: true }, round })), '继续派给 Coder')
  assert.equal(nodes(RoundChip({ step: { profile: 'coder' }, round })).some(node => node.type === 'svg'), false, 'delegation needs no redundant arrow')
  assert.equal(nodes(RoundChip({ step: { profile: 'coder' }, round })).find(node => node.props.size === 16).props.profile.name, 'Coder')
  const faces = RoundFaces({ roles: [{ id: 'lead', name: 'Lead' }, { id: 'coder', name: 'Coder' }] })
  assert.equal(faces.props['aria-label'], 'Lead、Coder')
  assert.deepEqual(faces.children.map(node => node.props.size), [20, 20])
  const speaker = RoundSpeaker({ role: { id: 'lead', name: 'Lead' }, running: true })
  assert.equal(speaker.children[0].props.running, true)
  assert.equal(text(speaker), 'Lead')
})

test('a live executor message shows its turn\'s latest five entries — text, thinking and tools — with the streaming reply as the newest', async () => {
  const calls = []
  const tool = (id, phase) => ({ who: 'agent', kind: 'tool', name: 'Bash', phase, callId: id, brief: id })
  const lines = [{ who: 'user', kind: 'text', text: 'Task' }, tool('c0', 'start'), tool('c0', 'end'),
    { who: 'agent', kind: 'text', text: 'Reading the module first', at: 1 },
    { who: 'agent', kind: 'thinking', text: 'Plan the fix', at: 2 },
    tool('c1', 'start'), tool('c1', 'end'),
    { who: 'user', kind: 'text', text: '上一轮因临时故障中断。请检查已完成的工作，从中断处继续完成原任务。', origin: { kind: 'retry' } },
    { who: 'agent', kind: 'text', text: 'Now editing', at: 3 },
    tool('c7', 'start')]
  const { RoundMember, ProcessRow, host } = await loadClient(['round.js', 'feed.js'], { call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return lines } })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], taskTypes: [], work: { e2: { active: true, since: Date.now() } }, onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const tools = () => {
    host.reset()
    const node = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  assert.equal(tools(), false, 'nothing shows before the transcript arrives')
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  assert.deepEqual(plain(calls), [{ endpoint: 'transcript', payload: { profile: 'tester', session: 'e2' } }])
  round.work.e2.buffer = 'Writing the patch now'
  const rows = tools().children
  assert.equal(rows.length, 6, 'six committed entries keep only the latest five, plus the streaming reply')
  assert.equal(nodes(tools()).some(node => typeof node.props.text === 'string' && node.props.text.includes('临时故障')), false,
    'the automatic continuation note never shows as the executor\'s words')
  assert.deepEqual(rows.map(row => row.type === ProcessRow ? row.props.kind : 'text'), ['text', 'thinking', 'tool', 'text', 'tool', 'text'])
  assert.equal(rows[1].props.summary, 'Plan the fix')
  assert.equal(rows[2].props.summary, 'c1')
  assert.equal(rows[4].props.running, true, 'a running tool call stays live')
  assert.equal(rows[0].children[0].props.text, 'Reading the module first')
  assert.equal(rows[0].children[0].props.streaming, undefined)
  assert.equal(rows[5].children[0].props.text, 'Writing the patch now', 'the executor\'s streaming text is the newest entry')
  assert.equal(rows[5].children[0].props.streaming, true)
})

test('automatic continuation tools stay in their delegation window', async () => {
  const tool = (callId, at) => ({ who: 'agent', kind: 'tool', name: 'Bash', callId, phase: 'end', brief: callId, at })
  const lines = [
    { who: 'user', at: 1 }, tool('Original work', 3),
    { who: 'user', origin: { kind: 'retry' }, at: 5 }, tool('Continued work', 6),
    { who: 'user', at: 10 }, tool('Reused task', 11),
    { who: 'user', origin: { kind: 'retry' }, at: 12 }, tool('Continued reused task', 13),
    { who: 'user', at: 20 }, tool('Later task', 21),
  ]
  const { RoundMember, host } = await loadClient('round.js', { call: async () => lines })
  const step = { session: 'e1', profile: 'coder', type: 'feature', at: 2 }
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], work: { e1: { active: true } }, onOpen() {} }
  const tools = () => {
    host.reset()
    const member = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return member.type(member.props)
  }
  tools()
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(tools().children.map(row => row.props.summary), ['Original work', 'Continued work'])
  step.at = 13
  assert.deepEqual(tools().children.map(row => row.props.summary), ['Reused task', 'Continued reused task'])
})

test('executor tool records remain visible after interruption and stay within their delegation', async () => {
  const lines = [
    { who: 'user', at: 1 }, { who: 'agent', kind: 'tool', name: 'Bash', callId: 'old', phase: 'end', brief: 'Saved progress', at: 3 },
    { who: 'user', at: 10 }, { who: 'agent', kind: 'tool', name: 'Bash', callId: 'new', phase: 'end', brief: 'Revised task', at: 11 },
  ]
  const { RoundMember, host } = await loadClient('round.js', { call: async () => lines })
  const step = { session: 'e1', profile: 'coder', type: 'feature', at: 2, ended: 'interrupted' }
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], work: { e1: { active: false } }, onOpen() {} }
  const tools = () => {
    host.reset()
    const member = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    assert.ok(member, 'stopping a task must retain its tool history')
    return member.type(member.props)
  }
  tools()
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(tools().children.map(row => row.props.summary), ['Saved progress'])
  step.unconfirmed = true
  host.reset()
  assert.ok(text(RoundMember({ step, round })).includes('结果未确认'))
})

test('the round feed draws the lead\'s speaker rows and executor messages, and the reply foot keeps the only lead time', async () => {
  const feed = { key: 'lead:l1', error: '', lines: [
    { who: 'user', kind: 'text', text: 'Fix it', at: 1 },
    { who: 'agent', kind: 'text', text: 'On it\n```nodo\n{}\n```', at: 2, reply: true },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false }, at: 3 },
  ] }
  const { Feed, RoundSpeaker, RoundChip, RoundMember, MessageTime } = await loadClient(['feed.js', 'round.js'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  const profile = { id: 'lead', name: 'Lead', lead: true }
  const round = { profiles: [profile, { id: 'coder', name: 'Coder' }], taskTypes: [], work: {}, onOpen() {} }
  const tree = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: true, since: 7, buffer: 'Next step' }, round }))
  assert.equal(tree.find(node => node.props.className === 'nodo-feed-inner').props['data-round'], '')
  assert.deepEqual(tree.filter(node => node.type === RoundSpeaker).map(node => [node.props.role, node.props.running]),
    [[profile, true]], 'the streaming reply continues the lead\'s segment, whose speaker shows the run')
  assert.equal(tree.filter(node => node.type === RoundChip).length, 1)
  assert.equal(tree.find(node => node.type === RoundMember).props.step.session, 'e1')
  assert.equal(tree.find(node => node.props.className === 'nodo-reply').children[0].props.text, 'On it')
  const reply = tree.filter(node => node.props.className === 'nodo-reply').at(-1)
  assert.ok(tree.indexOf(reply) < tree.indexOf(tree.find(node => node.type === RoundChip)),
    'the delegation chip follows the streaming lead reply')
  assert.ok(tree.indexOf(tree.find(node => node.type === RoundChip)) < tree.indexOf(tree.find(node => node.type === RoundMember)),
    'the chip sits between the streaming turn and the parked executor')
  assert.ok(tree.indexOf(reply) < tree.indexOf(tree.find(node => node.type === RoundMember)),
    'the streaming lead reply renders above the parked executor')
  const idle = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false }, round }))
  assert.equal(idle.filter(node => node.type === MessageTime).length, 2, 'the user bubble and the finished lead reply carry the only times')
  assert.equal(idle.find(node => node.type === RoundSpeaker).props.running, false)
  const plainFeed = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false } }))
  assert.equal(plainFeed.find(node => node.props.className === 'nodo-feed-inner').props['data-round'], undefined)
  assert.equal(plainFeed.filter(node => node.type === RoundSpeaker).length, 0)
})

test('the sessions rail keeps executor rows, state, highlight, role filter and search independent', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
    react: { useState: initial => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    } } })
  const workspace = { id: 'w', name: 'Project', cwd: '/p', createdAt: 1 }
  const view = { workspaces: [workspace], work: { e1: { active: true } }, profiles: [
    { id: 'lead', name: 'Lead', sessions: [{ id: 'l1', name: 'Fix login', workspaceRef: 'w', updatedAt: 1 }] },
    { id: 'coder', name: 'Coder', sessions: [
      { id: 'e1', name: 'Refresh race', workspaceRef: 'w', updatedAt: 5, source: { kind: 'lead', leadSessionId: 'l1' } },
      { id: 'orphan', name: 'Orphan work', workspaceRef: 'w', updatedAt: 3, source: { kind: 'lead', leadSessionId: 'gone' } },
      { id: 'own', name: 'Own work', workspaceRef: 'w', updatedAt: 4 },
    ] },
    { id: 'other', name: 'Other', sessions: [{ id: 'o1', name: 'Unrelated', workspaceRef: 'w', updatedAt: 2 }] },
  ] }
  const render = () => { cursor = 0; return nodes(Rail({ view, workspace, sessionId: 'e1', onSelect() {}, onSelectSession() {} })) }
  const rows = () => render().filter(node => node.type === SessionRow)
  assert.deepEqual(rows().map(row => row.props.session.id), ['e1', 'own', 'orphan', 'o1', 'l1'])
  const executor = rows()[0].props
  assert.equal(executor.work.active, true)
  assert.equal(executor.session.updatedAt, 5)
  assert.equal(executor.current, true)
  const lead = rows().find(row => row.props.session.id === 'l1').props
  assert.equal(lead.work, undefined)
  assert.equal(lead.session.updatedAt, 1)
  assert.equal(lead.current, false)
  assert.deepEqual(rows().filter(row => row.props.current).map(row => row.props.session.id), ['e1'])
  const press = name => render().find(node => node.props.className === 'nodo-roster-item' && node.props.title === name).props.onClick()
  press('Lead')
  assert.deepEqual(rows().map(row => row.props.session.id), ['l1'])
  press('Lead')
  press('Coder')
  assert.deepEqual(rows().map(row => row.props.session.id), ['e1', 'own', 'orphan'])
  press('Coder')
  press('Other')
  assert.deepEqual(rows().map(row => row.props.session.id), ['o1'])
  press('Other')
  render().find(node => node.type === 'button' && node.props['aria-label'] === '搜索').props.onClick()
  render().find(node => node.type === 'Input').props.onChange({ target: { value: 'refresh' } })
  assert.deepEqual(rows().map(row => row.props.session.id), ['e1'])
})

test('the rail search opens and closes from the dock button and on Escape', async () => {
  const slots = []
  let cursor = 0
  const { Rail } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
    react: { useState: initial => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    } } })
  const workspace = { id: 'w', name: 'Project', cwd: '/p', createdAt: 1 }
  const view = { workspaces: [workspace], work: {}, profiles: [
    { id: 'coder', name: 'Coder', sessions: [{ id: 's1', name: 'Refresh race', workspaceRef: 'w', updatedAt: 1 }] },
  ] }
  const render = () => { cursor = 0; return nodes(Rail({ view, workspace, sessionId: 's1', onSelect() {}, onSelectSession() {} })) }
  const button = () => render().find(node => node.type === 'button' && node.props['aria-label'] === '搜索')
  const toggle = () => button().props.onClick()
  const search = () => render().find(node => node.type === 'Input')
  assert.equal(search(), undefined, 'search waits behind the dock button')
  toggle()
  assert.equal(search().props.placeholder, '搜索会话')
  assert.equal(button().props['aria-pressed'], true)
  search().props.onChange({ target: { value: 'refresh' } })
  assert.equal(search().props.value, 'refresh')
  toggle()
  assert.equal(search(), undefined, 'the dock button closes an open search')
  toggle()
  assert.equal(search().props.value, '', 'reopening starts from a cleared query')
  search().props.onKeyDown({ key: 'Escape' })
  assert.equal(search(), undefined, 'Escape still closes the search')
})

test('the roster lists leads first with a lead ring and keeps the stored order in each group', async () => {
  const slots = []
  let cursor = 0
  const { Rail } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
    react: { useState: initial => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    } } })
  const view = { workspaces: [], work: { l1: { active: true } }, profiles: [
    { id: 'coder', name: 'Coder', sessions: [{ id: 'c1', name: 'Own work' }] },
    { id: 'alpha', name: 'Alpha', lead: true, sessions: [{ id: 'l1', name: 'Lead work' }] },
    { id: 'other', name: 'Other', sessions: [] },
    { id: 'beta', name: 'Beta', lead: true, sessions: [] },
  ] }
  const render = () => { cursor = 0; return nodes(Rail({ view, onSelect() {}, onSelectSession() {} })) }
  const roster = () => render().filter(node => node.props.className === 'nodo-roster-item' && node.props.title)
  const ring = item => nodes(item).some(node => node.props?.className === 'nodo-roster-avatar' && node.props['data-lead'] === '')
  assert.deepEqual(roster().map(node => node.props.title), ['Alpha', 'Beta', 'Coder', 'Other'])
  assert.deepEqual(roster().map(ring), [true, true, false, false])
  assert.deepEqual(roster().map(node => node.props['aria-label']),
    ['Alpha，运行中，主控', 'Beta，主控', 'Coder', 'Other'])
})

async function mount(viewName = 'team', restored) {
  const slots = [], calls = []
  let cursor = 0
  let navigation = restored ?? { view: viewName, profile: 'lead', workspace: 'w', sessions: { 'w:lead': 'l1' } }
  const lead = { id: 'lead', name: 'Lead', lead: true, engine: 'codex', workspaceId: 'w', sessions: [{ id: 'l1', name: 'Fix login', workspaceRef: 'w' }] }
  const coder = { id: 'coder', name: 'Coder', engine: 'codex', workspaceId: 'w', sessions: [
    { id: 'e2', name: 'Second', workspaceRef: 'w', createdAt: 2, source: { kind: 'lead', leadSessionId: 'l1' } },
    { id: 'e1', name: 'First', workspaceRef: 'w', createdAt: 1, source: { kind: 'lead', leadSessionId: 'l1' } },
  ] }
  const view = { profiles: [lead, coder], workspaces: [{ id: 'w', name: 'Project' }], work: { e1: { active: true, since: 100 } },
    stats: { l1: { turns: 2, steps: 4, inputTokens: 100, outputTokens: 50 }, e1: { turns: 1, steps: 2, inputTokens: 20, outputTokens: 10 } },
    taskTypes: [], prefs: { onboardedAt: 1 }, approvals: [{ id: 'a1', profileId: 'e1' }, { id: 'a2', profileId: 'elsewhere' }] }
  const space = { active: true, legacy: true }
  const loaded = await loadClient(['page.js', 'round.js', 'composer.js', 'feed.js', 'running.js', 'run-cards.js', 'role-seat.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      readNavigation: () => navigation, subscribeNavigation() {}, setNavigation: update => { navigation = update(navigation) },
      nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy() {} },
      readNativeSession: () => null, subscribeNativeSession() {}, completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      workLabel: work => work?.active ? '运行中' : '', workDot: () => 'ongoing',
      call: async (endpoint, payload) => { calls.push({ endpoint, payload }) },
    },
    react: {
      useState(initial) {
        const slot = cursor++
        if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
        return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
      },
      useRef(initial) { const slot = cursor++; return slots[slot] ??= { current: initial } },
      useEffect() {},
    },
    globals: { document: { visibilityState: 'visible', hasFocus: () => true }, localStorage: {
      getItem: key => key === 'nodo.navigation' ? JSON.stringify(navigation) : null,
      setItem: (key, value) => { if (key === 'nodo.navigation') navigation = JSON.parse(value) },
    } },
  })
  const render = () => { cursor = 0; return nodes(loaded.NodoPage({ contentOnly: true })) }
  return { loaded, view, calls, render, navigation: () => plain(navigation), find: type => render().find(node => node.type === type)?.props }
}

test('a lead session opens as its round: chat feed, faces, session menu and round approvals', async () => {
  const { loaded, view, render, find } = await mount()
  assert.equal(typeof find(loaded.Feed).round.onOpen, 'function')
  assert.equal(find(loaded.Feed).round.work, view.work)
  const menu = find(loaded.RoundMenu)
  assert.deepEqual(plain(menu.members.map(item => item.session.id)), ['e1', 'e2'])
  assert.deepEqual(plain(render().filter(node => node.type === loaded.ApprovalCard).map(node => node.props.card.id)), ['a1'])
  assert.equal(find(loaded.RunningLine), undefined, 'the running line belongs to the lead\'s own run')
  assert.deepEqual(plain(find(loaded.RoundFaces).roles.map(role => role.id)), ['lead', 'coder'])
  assert.equal(menu.onRaw, undefined)
  const items = nodes(loaded.RoundMenu({ ...find(loaded.RoundMenu) })).find(node => node.type === 'Menu').props.items
  assert.deepEqual(plain(items.map(item => item.id)), ['e1', 'e2'])
  assert.equal(text(items[0].label), 'Coder|First|运行中')
  assert.equal(text(items[1].label), 'Coder|Second')
})

test('the round stop interrupts the running executor and a draft still sends to the lead', async () => {
  const { loaded, calls, find } = await mount()
  const composer = find(loaded.Composer)
  assert.equal(composer.running, false)
  assert.equal(composer.stoppable, true)
  composer.onStop()
  await tick()
  assert.deepEqual(plain(calls.filter(call => call.endpoint === 'interrupt')), [{ endpoint: 'interrupt', payload: { profile: 'coder', session: 'e1' } }])
  const { Composer } = await loadClient('composer.js')
  const all = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[...(tree.children ?? []), tree.props?.children].flat(Infinity).flatMap(all)]
  let stops = 0
  const drafted = all(Composer({ value: 'Next', images: [], running: false, stoppable: true, onSend() {}, onStop: () => stops++ }))
  assert.equal(drafted.find(node => node.props.className === 'nodo-send').props['aria-label'], '发送消息')
  drafted.find(node => node.props.className === 'nodo-pending-stop').props.onClick()
  const empty = all(Composer({ value: '', images: [], running: false, stoppable: true, onSend() {}, onStop: () => stops++ }))
  const stop = empty.find(node => node.props.className === 'nodo-send')
  assert.equal(stop.props['aria-label'], '停止生成')
  stop.props.onClick()
  assert.equal(stops, 2)
})

test('an executor session opened from the round links back to its lead session', async () => {
  const { loaded, calls, render, find, navigation } = await mount()
  find(loaded.Feed).round.onOpen('e2')
  await tick()
  assert.deepEqual(plain(calls.at(-1)), { endpoint: 'session-select', payload: { profile: 'coder', session: 'e2' } })
  assert.equal(find(loaded.Feed).session.id, 'e2')
  assert.equal(find(loaded.Feed).round, undefined)
  assert.equal(navigation().view, 'sessions')
  const back = render().find(node => node.props.className === 'nodo-crumb nodo-crumb-link')
  assert.equal(back.children[0], 'Fix login')
  back.props.onClick()
  await tick()
  assert.deepEqual(plain(calls.at(-1)), { endpoint: 'session-select', payload: { profile: 'lead', session: 'l1' } })
  assert.equal(find(loaded.Feed).session.id, 'l1')
  assert.equal(navigation().view, 'team')
  assert.ok(find(loaded.Feed).round)
})

test('a lead session draws no statistics and the dialog cannot follow onto it; an executor session keeps both', async () => {
  const { loaded, view, find, render } = await mount()
  assert.equal(find(loaded.SessionStats).stats, undefined, 'the lead session shows no figures')
  find(loaded.Feed).round.onOpen('e1')
  await tick()
  assert.equal(find(loaded.SessionStats).stats, view.stats.e1)
  find(loaded.SessionStats).onOpen()
  assert.equal(find(loaded.StatsDialog).stats, view.stats.e1)
  render().find(node => node.props.className === 'nodo-crumb nodo-crumb-link').props.onClick()
  await tick()
  assert.equal(find(loaded.SessionStats).stats, undefined)
  assert.equal(find(loaded.StatsDialog), undefined, 'the dialog cannot open on a lead session')
})

test('home opens the lead raw transcript and stops only that session', async () => {
  const { loaded, calls, find, view } = await mount('sessions')
  view.work.l1 = { active: true }
  assert.equal(find(loaded.Feed).round, undefined)
  assert.equal(find(loaded.RoundMenu), undefined)
  assert.equal(find(loaded.RoundFaces), undefined)
  assert.equal(find(loaded.ApprovalCard), undefined, 'executor approvals belong in Team or the executor page')
  assert.equal(find(loaded.Composer).stoppable, undefined)
  find(loaded.Composer).onStop()
  await tick()
  assert.deepEqual(plain(calls.filter(call => call.endpoint === 'interrupt')), [{ endpoint: 'interrupt', payload: { profile: 'lead', session: 'l1' } }])
})

test('Team renders a round before dispatch and its menu opens members in home', async () => {
  const { loaded, find, navigation } = await mount()
  const menu = nodes(loaded.RoundMenu(find(loaded.RoundMenu))).find(node => node.type === 'Menu')
  menu.props.onSelect('e1')
  await tick()
  assert.equal(navigation().view, 'sessions')
  assert.equal(find(loaded.Feed).session.id, 'e1')
  assert.equal(find(loaded.Feed).round, undefined)
  const fresh = await mount()
  fresh.view.profiles[1].sessions = []
  assert.ok(fresh.find(fresh.loaded.Feed).round)
  assert.equal(fresh.find(fresh.loaded.RoundMenu), undefined)
})

test('persisted navigation restores the selected home or Team conversation and accepts old navigation', async () => {
  const team = await mount()
  team.find(team.loaded.Feed).round.onOpen('e1')
  await tick()
  const home = await mount('sessions', team.navigation())
  assert.equal(home.find(home.loaded.Feed).session.id, 'e1')
  assert.equal(home.find(home.loaded.Feed).round, undefined)
  home.render().find(node => node.props.className === 'nodo-crumb nodo-crumb-link').props.onClick()
  await tick()
  const restored = await mount('team', home.navigation())
  assert.equal(restored.find(restored.loaded.Feed).session.id, 'l1')
  assert.ok(restored.find(restored.loaded.Feed).round)
  const legacy = await mount('sessions', { profile: 'lead', workspace: 'w', sessions: { 'w:lead': 'l1' } })
  assert.equal(legacy.find(legacy.loaded.Feed).session.id, 'l1')
  assert.equal(legacy.find(legacy.loaded.Feed).round, undefined)
})

test('Team rail lists only non-dsh lead sessions and aggregates member state and search', async () => {
  const { Rail, SessionRow, host } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
  })
  const workspace = { id: 'w', name: 'Project' }
  const lead = { id: 'lead', name: 'Lead', lead: true, engine: 'codex', sessions: [
    { id: 'l1', name: 'Task', workspaceRef: 'w', updatedAt: 1 },
    { id: 'l2', name: 'New round', workspaceRef: 'w', updatedAt: 2 },
    { id: 'old', name: 'Archived', workspaceRef: 'w', archivedAt: 1 },
  ] }
  const view = { workspaces: [workspace], work: { e1: { active: true, status: 'waiting-approval' } }, profiles: [lead,
    { id: 'coder', name: 'Coder', sessions: [{ id: 'e1', name: 'Refresh race', workspaceRef: 'w', updatedAt: 5, source: { kind: 'lead', leadSessionId: 'l1' } }] },
    { id: 'native', name: 'Native', lead: true, engine: 'dsh', sessions: [{ id: 'n1', workspaceRef: 'w', engine: 'dsh' }] },
  ] }
  const created = [], switched = []
  const render = () => { host.reset(); return nodes(Rail({ view, workspace, sessionId: 'l1', navigation: { view: 'team' },
    onNewSession: id => created.push(id), onSessions: () => switched.push('sessions') })) }
  const rows = () => render().filter(node => node.type === SessionRow).map(node => node.props)
  assert.deepEqual(rows().map(row => row.session.id), ['l1', 'l2'])
  assert.equal(rows()[0].work.status, 'waiting-approval')
  assert.equal(rows()[0].session.updatedAt, 5)
  assert.equal(rows()[0].current, true)
  assert.deepEqual(render().filter(node => node.props.className === 'nodo-roster-item' && node.props.title).map(node => node.props.title), ['Lead'])
  render().find(node => node.props['aria-label'] === '在“Project”中新建会话').props.onClick({ stopPropagation() {} })
  assert.deepEqual(created, ['lead'])
  const dockButton = label => render().find(node => node.type === 'button' && node.props['aria-label'] === label)
  assert.deepEqual(['主页', 'Team', '新建会话', '搜索', '角色'].map(dockButton).map(node => node.props['aria-pressed']),
    [false, true, undefined, false, false], 'the dock marks Team pressed inside the team view')
  dockButton('主页').props.onClick()
  dockButton('搜索').props.onClick()
  assert.deepEqual(switched, ['sessions', 'sessions'], 'leaving Team and searching from it both return to the sessions view')
  render().find(node => node.type === 'Input').props.onChange({ target: { value: 'refresh' } })
  assert.deepEqual(rows().map(row => row.session.id), ['l1'])
})
