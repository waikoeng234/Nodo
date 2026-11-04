import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const plain = value => JSON.parse(JSON.stringify(value))

// Feed reads its lines from the shared store; tests seed it with this stub.
const liveStub = feed => ({
  transcriptOf: key => feed.lines, transcriptError: () => feed.error ?? '',
  pullTranscript: async () => {}, watchTranscript: () => () => {}, subscribeStore: () => () => {}, getStoreVersion: () => 0,
})
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) || !('props' in node) ? []
  : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
const menuItems = tree => nodes(tree).filter(node => node.props?.className === 'nodo-team-row').map(node => ({ id: node.props['data-session'], label: node.children[1] }))
const openPanel = async ({ render }) => { render().find(node => node.props?.['aria-label'] === '摘要面板').props.onClick(); await tick() }
const text = node => nodes(node).flatMap(item => item.children ?? []).filter(child => typeof child === 'string').join('|')
const tick = () => new Promise(resolve => setImmediate(resolve))
// What the host's transcript endpoint answers a first, position-less pull.
const fullAnswer = lines => ({ full: true, token: 't', base: 1, dirty: 0, lines: lines.map((line, index) => ({ n: index + 1, line })) })

test('execution cards show the parent title from existing task data', async () => {
  const calls = []
  const { RoundMember, host } = await loadClient('round.js', { call: (...args) => { calls.push(args) } })
  const step = { session: 's', profile: 'worker', type: 'feature', taskId: 'child', report: 'Done' }
  const parent = { id: 'parent', title: 'Ship the goal', status: 'open' }
  const child = { id: 'child', title: 'Build a part', status: 'review', parentId: parent.id }
  const round = { profiles: [{ id: 'worker', name: 'Worker' }], tasks: [parent, child], onOpen() {} }
  const tags = () => {
    host.reset()
    return nodes(RoundMember({ step, round })).filter(node => node.props.className === 'nodo-tag').map(text)
  }
  assert.ok(tags().includes('Ship the goal'))
  child.parentId = undefined
  assert.ok(!tags().includes('Ship the goal'))
  child.parentId = 'missing'
  assert.ok(!tags().includes('missing'))
  assert.deepEqual(calls, [], 'the chip requires no new requests')
})

test('round menu indents a child one level only when its parent is in the menu', async () => {
  const tasks = [
    { id: 'parent', title: 'Goal', executions: [{ sessionId: 'p', createdAt: 1 }] },
    { id: 'child', title: 'Part', parentId: 'parent', executions: [{ sessionId: 'c', createdAt: 2 }] },
    { id: 'orphan', title: 'Another part', parentId: 'absent', executions: [{ sessionId: 'o', createdAt: 3 }] },
  ]
  const { RoundTeam, host } = await loadClient('round.js', { uiShared: {
    call: async () => tasks, sessionTime: () => '', workLabel: () => '', workDot: () => 'idle',
  } })
  let members = ['p', 'c', 'o'].map(id => ({ role: { id: 'worker', name: 'Worker' }, session: { id, name: id } }))
  const items = () => {
    host.reset()
    return menuItems(RoundTeam({ members, work: {}, struct: 1, workspace: 'w', onOpen() {} }))
  }
  items()
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(plain(items().map(item => item.label.props.style ?? null)), [null, { paddingInlineStart: 16 }, null])
  members = members.filter(item => item.session.id !== 'p')
  assert.ok(items().every(item => item.label.props.style === undefined), 'a parent outside the menu causes no indent')
})

test('roundLines turns the lead transcript into a chat of speaker rows, delegation chips and one message per executor', async () => {
  const { roundLines } = await loadClient('round.js')
  const coder = { session: 'e1', profile: 'coder', type: 'bug-fix', hard: true, reused: false, deferred: true }
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
    'Fix the login', 'speaker', 'Plan', 'Delegating', 'delegate', 'member', 'speaker', 'boom', 'delegate', 'member', 'speaker', '执行未完成：gone',
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

test('accepted delegations keep chips in order and executors follow the completed lead turn', async () => {
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
  assert.deepEqual(shape(plain(roundLines(turn))), ['Ship it', 'speaker', 'Delegating now', 'delegate', 'Meanwhile, here is the plan', 'member'],
    'the chip stays at acceptance and the executor follows the completed lead text')
  const reported = plain(roundLines([...turn,
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 9,
      references: [{ messages: [{ text: 'Done' }] }] }]))
  assert.deepEqual(shape(reported), ['Ship it', 'speaker', 'Delegating now', 'delegate', 'Meanwhile, here is the plan', 'member'],
    'a report updates the executor after the completed lead text')
  const followup = plain(roundLines([...turn,
    { who: 'user', kind: 'text', text: 'Report from Coder', origin: { kind: 'report', session: 'e1' }, at: 9,
      references: [{ messages: [{ text: 'Done' }] }] },
    { who: 'agent', kind: 'text', text: 'Great, shipping next', at: 10 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: tester, at: 11 }]))
  assert.deepEqual(shape(followup),
    ['Ship it', 'speaker', 'Delegating now', 'delegate', 'Meanwhile, here is the plan', 'member', 'speaker', 'Great, shipping next', 'delegate', 'member'],
    'the lead\'s next turn opens below the reported member while the second executor keeps the bottom')
  const ended = plain(roundLines([...turn,
    { who: 'system', kind: 'note', text: '执行未完成', delegation: { session: 'e1', ended: 'interrupted', unconfirmed: true } },
    { who: 'agent', kind: 'text', text: 'Wrapping up anyway', at: 8 }]))
  assert.deepEqual(shape(ended), ['Ship it', 'speaker', 'Delegating now', 'delegate', 'Meanwhile, here is the plan', 'member', 'speaker', 'Wrapping up anyway'],
    'an ended member stays before the next lead words')
  assert.equal(ended.find(line => line.kind === 'member').step.ended, 'interrupted')
})

test('executor messages follow acceptance order', async () => {
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
    ['go', 'speaker', 'a', 'delegate', 'delegate', 'done', 'member', 'member'], 'chips retain their acceptance positions')
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
    { delegation: { session: 'executor', ended: 'interrupted', stoppedBy: 'user', unconfirmed: true } },
    { origin: { kind: 'report', session: 'executor' }, references: [{ messages: [{ text: 'Recovered successfully' }] }] },
  ]
  const step = roundLines(lines).find(line => line.kind === 'member').step
  assert.equal(step.ended, undefined)
  assert.equal(step.unconfirmed, undefined)
  assert.equal(step.stoppedBy, undefined)
  assert.equal(step.report, 'Recovered successfully')
  host.reset()
  const shown = nodes(RoundMember({ step, round: { profiles: [{ id: 'worker', name: 'Worker' }], teams: [], work: {} } }))
  assert.doesNotMatch(text(shown), /已中断|已停止|结果未确认/)
})

test('an executor message shows its role, tags and state, expands the rest of its report and opens its session', async () => {
  const { RoundMember, MessageTime, host } = await loadClient(['round.js', 'feed.js'])
  const opened = []
  // The lead's own team names its types first; an unknown id names itself.
  const round = { profiles: [{ id: 'coder', name: 'Coder' }, { id: 'tester', name: 'Tester' }], leadId: 'lead',
    teams: [{ id: 't1', name: '', lead: 'lead', types: [{ id: 'bug-fix', name: '修复' }, { id: 'test', name: '测试' }] },
      { id: 't2', name: '', lead: 'other', types: [{ id: 'bug-fix', name: '缺陷' }] }],
    work: { e2: { active: true, since: Date.now() - 5000 } }, onOpen: id => opened.push(id) }
  const view = step => { host.reset(); return nodes(RoundMember({ step, round })) }
  const done = { session: 'e1', profile: 'coder', type: 'bug-fix', hard: true, reused: true, at: 9, report: '## Fixed the refresh race\n- Changed auth.js' }
  const head = tree => text(tree.find(node => node.props.className === 'nodo-round-head'))
  assert.equal(head(view(done)), 'Coder|修复|难题|续用|查看会话')
  const isolated = view({ ...done, branch: 'nodo/task-isolated' })
  assert.equal(text(isolated.find(node => node.props.className === 'nodo-tag' && text(node) === '隔离')), '隔离')
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
  assert.equal(head(view({ session: 'e6', profile: 'tester', type: 'test', ended: 'cancelled' })), 'Tester|测试|已取消|查看会话')
  assert.equal(head(view({ session: 'e7', profile: 'tester', type: 'test', ended: 'interrupted', stoppedBy: 'user' })), 'Tester|测试|已停止|查看会话')
  assert.equal(head(view({ session: 'e8', profile: 'tester', type: 'test', ended: 'cancelled', stoppedBy: 'lead' })), 'Tester|测试|已停止|查看会话')
  assert.equal(head(view({ session: 'e9', profile: 'tester', type: 'test', ended: 'error' })), 'Tester|测试|已结束|查看会话')
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
  delete round.work.e2.retryWaiting
  round.work.e2.stopping = true
  const holding = view({ session: 'e2', profile: 'tester', type: 'test' })
  const hold = holding.find(node => node.props['aria-label'] === '停止 Tester')
  assert.equal(hold.props.disabled, true, 'a stop signalled by the snapshot disables the button after a reload')
  assert.equal(text(hold), '停止中…')
  delete round.work.e2.stopping
  assert.equal(view({ ...done }).find(node => node.props['aria-label'] === '停止 Coder'), undefined, 'a reported member has nothing to stop')
  delete round.onStop
  assert.equal(head(view({ session: 'e4', profile: 'tester', type: 'test', hard: false, reused: false })), 'Tester|测试|未回报|查看会话')
})

test('delegation marks carry the task identity into member steps, old marks stay bare', async () => {
  const { roundLines } = await loadClient('round.js')
  const lines = [
    { who: 'system', kind: 'note', text: '已派给 Coder',
      delegation: { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false, taskId: 't1', executionId: 'x1', branch: 'nodo/task-isolated' }, at: 1 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }, at: 2 },
  ]
  const steps = plain(roundLines(lines)).filter(line => line.kind === 'member').map(line => line.step)
  assert.deepEqual(steps, [
    { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false, taskId: 't1', executionId: 'x1', branch: 'nodo/task-isolated', at: 1 },
    { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false, at: 2 },
  ])
})

test('a stop mark carries its initiator into the step and keeps engine endings on the old wording', async () => {
  const { roundLines, RoundMember, host } = await loadClient('round.js')
  const stepOf = mark => plain(roundLines([
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: { session: 'e1', profile: 'coder', type: 'bug-fix' }, at: 1 },
    { who: 'system', kind: 'note', text: '执行未完成', delegation: { session: 'e1', ...mark }, at: 2 },
  ])).find(line => line.kind === 'member').step
  const step = stepOf({ ended: 'interrupted', stoppedBy: 'user' })
  assert.equal(step.stoppedBy, 'user')
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], teams: [], work: {} }
  const word = () => { host.reset(); return text(nodes(RoundMember({ step, round }))) }
  assert.match(word(), /已停止/)
  step.ended = 'cancelled'
  assert.match(word(), /已停止/, 'a cancelled stop reads the same way')
  step.ended = 'error'
  delete step.stoppedBy
  assert.match(word(), /已结束/, 'an engine error keeps its own wording')
  step.ended = 'interrupted'
  assert.match(word(), /已中断/, 'an interruption without a stop initiator stays 已中断')
})

test('an ended member card drops the task word so the ending text stands alone', async () => {
  const { RoundMember, host } = await loadClient('round.js')
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], teams: [], tasks: [{ id: 't1', status: 'stopped' }], work: {}, onOpen: () => {} }
  const render = step => { host.reset(); return nodes(RoundMember({ step, round })) }
  const head = step => render(step).find(node => node.props.className === 'nodo-round-head')
  const tags = step => nodes(head(step)).filter(node => node.props.className === 'nodo-tag').map(node => node.children[0])
  const stopped = { session: 'e1', profile: 'coder', type: 'bug-fix', taskId: 't1', ended: 'interrupted', stoppedBy: 'user' }
  assert.deepEqual(tags(stopped), ['bug-fix'], 'the stopped task word yields to the ending text')
  assert.equal(text(head(stopped)).split('已停止').length - 1, 1, '已停止 appears once')
  const cancelled = { ...stopped, ended: 'cancelled', stoppedBy: undefined }
  assert.match(text(head(cancelled)), /已取消/, 'a cancelled stop without an initiator says 已取消')
  assert.ok(!text(head(cancelled)).includes('已停止'), 'the task-level word never contradicts the ending')
  assert.deepEqual(tags({ session: 'e1', profile: 'coder', type: 'bug-fix', taskId: 't1', hard: true }), ['bug-fix', '难题', '已停止'],
    'a card without an ending keeps the task-level word')
})

test('a member card tags its task with the status word derived from task, execution and approval', async () => {
  const { RoundMember, host } = await loadClient('round.js')
  const tasks = {
    open: { id: 't-open', status: 'open' }, review: { id: 't-review', status: 'review' },
    blocked: { id: 't-blocked', status: 'blocked' }, done: { id: 't-done', status: 'done' }, stopped: { id: 't-stopped', status: 'stopped' },
  }
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], teams: [], tasks: Object.values(tasks), work: {}, onOpen: () => {} }
  const card = (task, extra = {}) => {
    round.work = extra.work ?? {}
    host.reset()
    return nodes(RoundMember({ step: { session: 'e1', profile: 'coder', type: 'bug-fix', taskId: task.id, ...extra.step }, round }))
  }
  const tags = tree => nodes(tree.find(node => node.props.className === 'nodo-round-head'))
    .filter(node => node.props.className === 'nodo-tag').map(node => [node.children[0], node.props['data-tone']])
  assert.deepEqual(tags(card({ ...tasks.open, id: 'missing' })), [['bug-fix', undefined]], 'a step outside the task view keeps its old head')
  assert.deepEqual(tags(card(tasks.open, { work: { e1: { active: true, since: Date.now() } } })), [['bug-fix', undefined], ['进行中', 'accent']])
  assert.deepEqual(tags(card(tasks.open, { work: { e1: { active: true, status: 'waiting-approval' } } })), [['bug-fix', undefined], ['等待用户', 'caution']])
  assert.deepEqual(tags(card(tasks.open)), [['bug-fix', undefined], ['待执行', undefined]])
  assert.deepEqual(tags(card(tasks.review)), [['bug-fix', undefined], ['待验收', 'accent']])
  assert.deepEqual(tags(card(tasks.blocked)), [['bug-fix', undefined], ['受阻', 'caution']])
  assert.deepEqual(tags(card(tasks.blocked, { step: { unconfirmed: true } })), [['bug-fix', undefined], ['未确认', 'caution']])
  // RoundMember reads the task from the round view, so the field-bearing object goes into round.tasks directly.
  const withViewTask = (task, extra = {}) => {
    round.work = extra.work ?? {}
    host.reset()
    return tags(nodes(RoundMember({ step: { session: 'e1', profile: 'coder', type: 'bug-fix', taskId: task.id, ...extra.step }, round: { ...round, tasks: [task] } })))
  }
  assert.deepEqual(withViewTask({ ...tasks.blocked, latestExecutionStatus: 'unconfirmed' }), [['bug-fix', undefined], ['未确认', 'caution']],
    'a blocked task whose newest execution is unconfirmed says 未确认 without reading executions')
  assert.deepEqual(withViewTask({ ...tasks.open, latestExecutionStatus: 'running' }), [['bug-fix', undefined], ['进行中', 'accent']],
    'an idle task whose newest execution is running says 进行中')
  assert.deepEqual(tags(card(tasks.done)), [['bug-fix', undefined], ['已完成', undefined]])
  assert.deepEqual(tags(card(tasks.stopped)), [['bug-fix', undefined], ['已停止', undefined]])
  assert.equal(tags(card({ status: 'open' }))[1], undefined, 'a card without taskId shows no task tag')
})

test('a member card with a task offers to supplement it, gated by the writable conversation', async () => {
  const { RoundMember, host } = await loadClient('round.js')
  const steps = []
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], teams: [], tasks: [{ id: 't1', title: 'Fix login', status: 'open' }], work: {}, onOpen: () => {},
    onSupplement: step => steps.push(step) }
  const words = step => { host.reset(); return nodes(RoundMember({ step, round })).filter(node => node.type === 'button')
    .map(node => node.children.filter(child => typeof child === 'string').join('')) }
  const step = { session: 'e1', profile: 'coder', type: 'bug-fix', taskId: 't1' }
  assert.deepEqual(words(step), ['补充', '查看会话'])
  const supplement = nodes(RoundMember({ step, round })).find(node => node.type === 'button' && node.children.includes('补充'))
  supplement.props.onClick()
  assert.deepEqual(steps, [step])
  assert.deepEqual(words({ session: 'e2', profile: 'coder', type: 'bug-fix' }), ['查看会话'], 'a card without a task offers no supplement')
  delete round.onSupplement
  assert.deepEqual(words(step), ['查看会话'], 'a read-only conversation offers no supplement')
})

test('an expanded member loads its task on demand and retries a failed task-get', async () => {
  const calls = []
  let fail = true
  const task = { id: 't1', title: 'T', status: 'review', brief: 'Fix the login race\nwith care',
    acceptances: [{ reason: '验证通过', references: ['r1', 'r2'], executionIds: ['x1'], createdAt: 1 }],
    executions: [{ id: 'x1', taskId: 't1', profileId: 'coder', sessionId: 'e1', type: 'bug-fix', hard: false, status: 'done',
      reason: 'done', report: 'r', references: [], startedAt: 1, endedAt: 2, createdAt: 1 }] }
  const { RoundMember, host } = await loadClient('round.js', { uiShared: {
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); if (fail) throw new Error('boom')
      return endpoint === 'task-get' ? task : undefined } } })
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], teams: [], work: {}, onOpen: () => {} }
  const step = { session: 'e1', profile: 'coder', type: 'bug-fix', taskId: 't1', executionId: 'x1', report: 'All green', at: 9 }
  const member = () => { host.reset(); return nodes(RoundMember({ step, round })) }
  const detail = () => {
    const node = member().find(item => item.props.step === step && item.type !== RoundMember && item.type.name === 'RoundTask')
    return node.type(node.props)
  }
  member()
  assert.deepEqual(calls, [], 'a collapsed card asks for nothing')
  const summary = () => member().find(node => node.props.className === 'nodo-round-summary')
  assert.equal(summary().type, 'button', 'a task card expands even a one-line report')
  summary().props.onClick()
  detail()
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(plain(calls), [{ endpoint: 'task-get', payload: { taskId: 't1' } }])
  const errorRow = detail()
  assert.equal(text(errorRow), 'boom|重试')
  errorRow.children[1].props.onClick()
  fail = false
  detail()
  host.effects.at(-1)()
  await tick()
  assert.equal(calls.length, 2, 'retry asks again for the task')
  const shown = nodes(detail())
  const reports = shown.filter(node => node.props.className === 'nodo-round-report')
  assert.equal(reports.at(-1).children[0].props.text, task.brief, 'the brief renders as markdown')
  assert.ok(text(shown).includes('验证通过 · 依据 2 项'), 'the acceptance conclusion carries its reference count')
})

test('the session menu shows the idle task word and keeps a running session\'s state', async () => {
  const tasks = [
    { id: 't1', title: 'Review', status: 'review', executions: [{ sessionId: 'e1', createdAt: 10 }] },
    { id: 't2', title: 'Unconfirmed', status: 'blocked', latestExecutionStatus: 'unconfirmed', executions: [{ sessionId: 'e2', createdAt: 10, status: 'unconfirmed' }] },
    { id: 't3', title: 'Failed', status: 'blocked', executions: [{ sessionId: 'e3', createdAt: 10, status: 'failed' }] },
    { id: 't4', title: 'Done', status: 'done', executions: [{ sessionId: 'e4', createdAt: 10 }] },
    { id: 't5', title: 'Stopped', status: 'stopped', executions: [{ sessionId: 'e5', createdAt: 10 }] },
    { id: 't6', title: 'Running', status: 'open', latestExecutionStatus: 'running', executions: [{ sessionId: 'e6', createdAt: 10, status: 'running' }] },
    { id: 't7', title: 'Queued', status: 'open', executions: [{ sessionId: 'e7', createdAt: 10, status: 'queued' }] },
  ]
  const { RoundTeam, host } = await loadClient('round.js', { uiShared: {
    call: async endpoint => endpoint === 'task-list' ? tasks : undefined,
    sessionTime: () => '', workLabel: work => work?.active ? '运行中' : '', workDot: () => 'ongoing',
  } })
  const members = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ role: { id: 'coder', name: 'Coder' }, session: { id: `e${n}`, name: `S${n}`, updatedAt: 7 } }))
  const label = id => {
    host.reset()
    const items = menuItems(RoundTeam({ members, work: { e8: { active: true } }, struct: 1, workspace: 'w1', onOpen() {} }))
    return text(items.find(item => item.id === id).label)
  }
  label('e1')
  host.effects.at(-1)()
  await tick()
  assert.equal(label('e1'), 'Review|Coder|待验收')
  assert.equal(label('e2'), 'Unconfirmed|Coder|未确认', 'a blocked task with an unconfirmed execution says 未确认')
  assert.equal(label('e3'), 'Failed|Coder|受阻')
  assert.equal(label('e4'), 'Done|Coder|已完成')
  assert.equal(label('e5'), 'Stopped|Coder|已停止')
  assert.equal(label('e6'), 'Running|Coder|进行中')
  assert.equal(label('e7'), 'Queued|Coder|待执行')
  assert.equal(label('e8'), 'S8|Coder|运行中', 'a running session keeps its running state')
  assert.equal(label('e9'), 'S9|Coder', 'a session without a task stays blank')
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

test('a live executor message keeps its latest four entries — text, thinking and tools — with the streaming reply as the newest', async () => {
  const calls = []
  const tool = (id, phase) => ({ who: 'agent', kind: 'tool', name: 'Bash', phase, callId: id, brief: id })
  const lines = [{ who: 'user', kind: 'text', text: 'Task' }, tool('c0', 'start'), tool('c0', 'end'),
    { who: 'agent', kind: 'text', text: 'Reading the module first', at: 1 },
    { who: 'agent', kind: 'thinking', text: 'Plan the fix', at: 2 },
    tool('c1', 'start'), tool('c1', 'end'),
    { who: 'user', kind: 'text', text: '上一轮因临时故障中断。请检查已完成的工作，从中断处继续完成原任务。', origin: { kind: 'retry' } },
    { who: 'agent', kind: 'text', text: 'Now editing', at: 3 },
    tool('c7', 'start')]
  const { RoundMember, ProcessRow, host } = await loadClient(['round.js', 'feed.js'], { call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return fullAnswer(lines) } })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], teams: [], work: { e2: { active: true, since: Date.now() } }, onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const tools = () => {
    host.reset()
    const node = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  assert.equal(tools(), false, 'nothing shows before the transcript arrives')
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  assert.deepEqual(plain(calls), [{ endpoint: 'transcript', payload: { profile: 'tester', session: 'e2', since: {} } }])
  round.work.e2.buffer = 'Writing the patch now'
  const rows = tools().children
  assert.equal(rows.length, 5, 'six committed entries keep only the latest four, plus the streaming reply')
  assert.equal(nodes(tools()).some(node => typeof node.props.text === 'string' && node.props.text.includes('临时故障')), false,
    'the automatic continuation note never shows as the executor\'s words')
  assert.deepEqual(rows.map(row => row.type === ProcessRow ? row.props.kind : 'text'), ['thinking', 'tool', 'text', 'tool', 'text'])
  assert.equal(rows[0].props.summary, 'Plan the fix')
  assert.equal(rows[1].props.summary, 'c1')
  assert.equal(rows[3].props.running, true, 'a running tool call stays live')
  assert.equal(rows[2].children[0].props.text, 'Now editing')
  assert.equal(rows[2].children[0].props.streaming, false)
  assert.equal(rows[4].children[0].props.text, 'Writing the patch now', 'the executor\'s streaming text is the newest entry')
  assert.equal(rows[4].children[0].props.streaming, true)
})

test('an executor message shows its own file-changes card and skips legacy or empty summaries', async () => {
  const base = { version: 1, mode: 'snapshot', runId: 'r', entityId: 'c', revision: 1, status: 'done', capture: 'complete' }
  const changes = fileCount => ({ who: 'agent', kind: 'changes', at: 3,
    presentation: { ...base, kind: 'changes', body: { scope: 'edit-tools', coverage: 'partial', fileCount, files: fileCount ? [{ path: '/ws/f.ts', edits: [] }] : [] } } })
  const lines = [{ who: 'user', kind: 'text', text: 'Task' },
    { who: 'agent', kind: 'tool', name: 'Write', callId: 'w', phase: 'end', brief: 'w' },
    changes(2),
    { who: 'agent', kind: 'changes', text: 'legacy summary stays hidden' },
    { who: 'agent', kind: 'text', text: 'Done', at: 4 }]
  const { RoundMember, StreamRecordCard, host } = await loadClient(['round.js', 'stream-records.js'], { call: async () => fullAnswer(lines) })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], teams: [], work: { e2: { active: true, since: Date.now() } }, onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const tools = () => {
    host.reset()
    const node = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  tools()
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  const cards = nodes(tools()).filter(node => node.type === StreamRecordCard && node.props.record.kind === 'changes')
  assert.equal(cards.length, 1, 'the executor\'s own changes summary renders inside its message')
  assert.equal(cards[0].props.record.body.fileCount, 2)
  assert.deepEqual(plain(cards[0].props.request), { profile: 'tester', session: 'e2' }, 'details load from the executor\'s session')
  assert.ok(!JSON.stringify(tools()).includes('legacy summary'), 'a summary without a saved presentation never renders as a tool row')
})

test('a reported executor message keeps its own file-changes card under the report', async () => {
  const base = { version: 1, mode: 'snapshot', runId: 'r', entityId: 'c', revision: 1, status: 'done', capture: 'complete' }
  const presentation = { ...base, kind: 'changes', body: { scope: 'edit-tools', coverage: 'partial', fileCount: 1, files: [{ path: '/ws/f.ts', edits: [] }] } }
  const lines = [{ who: 'user', kind: 'text', text: 'Task', at: 1 },
    { who: 'agent', kind: 'text', text: 'Fixed it', at: 2 },
    { who: 'agent', kind: 'changes', at: 3, presentation }]
  const { RoundMember, StreamRecordCard, host } = await loadClient(['round.js', 'stream-records.js'], { call: async () => fullAnswer(lines) })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], teams: [], onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false, report: 'Fixed the login bug\nDetails', at: 9 }
  const body = () => nodes(RoundMember({ step, round })).find(node => node.props.className === 'nodo-round-body')
  const changesNode = () => {
    host.reset()
    const node = nodes(body()).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  assert.ok(!changesNode(), 'nothing shows before the transcript arrives')
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  const report = body().children[1]
  assert.equal(report.children[0].props.className, 'nodo-round-summary', 'the report text comes first')
  assert.equal(report.children[1].props.step, step, 'the card slots directly under the report')
  const cards = nodes(changesNode()).filter(node => node.type === StreamRecordCard && node.props.record.kind === 'changes')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props.record.body.fileCount, 1)
  assert.deepEqual(plain(cards[0].props.request), { profile: 'tester', session: 'e2' }, 'details load from the executor\'s session')
})

test('a reported executor message without saved changes shows no card', async () => {
  const lines = [{ who: 'user', kind: 'text', text: 'Task', at: 1 },
    { who: 'agent', kind: 'text', text: 'Fixed it', at: 2 }]
  const { RoundMember, StreamRecordCard, host } = await loadClient(['round.js', 'stream-records.js'], { call: async () => fullAnswer(lines) })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], teams: [], onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false, report: 'Fixed the login bug', at: 9 }
  const changesNode = () => {
    host.reset()
    const node = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  changesNode()
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  assert.equal(nodes(changesNode()).some(node => node.type === StreamRecordCard), false,
    'a report without saved changes shows no card')
})

test('the changes card keeps its slot when continuation rows crowd the delegation window', async () => {
  const base = { version: 1, mode: 'snapshot', runId: 'r', entityId: 'c', revision: 1, status: 'done', capture: 'complete' }
  const presentation = { ...base, kind: 'changes', body: { scope: 'edit-tools', coverage: 'partial', fileCount: 2, files: [{ path: '/ws/a.ts', edits: [] }, { path: '/ws/b.ts', edits: [] }] } }
  const tool = (id, phase) => ({ who: 'agent', kind: 'tool', name: 'Bash', phase, callId: id, brief: id })
  const lines = [{ who: 'user', kind: 'text', text: 'Task', at: 1 }, tool('c0', 'end'),
    { who: 'agent', kind: 'text', text: 'Edited the files', at: 2 },
    { who: 'agent', kind: 'changes', at: 3, presentation },
    { who: 'user', kind: 'text', text: '继续', origin: { kind: 'retry' }, at: 4 },
    { who: 'agent', kind: 'text', text: 'Verifying', at: 5 }, tool('c1', 'end'), tool('c2', 'end'), tool('c3', 'end'), tool('c4', 'end')]
  const { RoundMember, StreamRecordCard, host } = await loadClient(['round.js', 'stream-records.js'], { call: async () => fullAnswer(lines) })
  const round = { profiles: [{ id: 'tester', name: 'Tester' }], teams: [], work: { e2: { active: true, since: Date.now() } }, onOpen: () => {} }
  const step = { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }
  const tools = () => {
    host.reset()
    const node = nodes(RoundMember({ step, round })).find(item => item.props.step === step && item.type !== RoundMember)
    return node.type(node.props)
  }
  tools()
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  const rows = tools().children
  assert.deepEqual(rows.map(row => row.type === StreamRecordCard ? 'changes' : row.props.className === 'nodo-round-text' ? 'text' : 'tool'),
    ['changes', 'tool', 'tool', 'tool', 'tool'], 'the card survives and precedes the four newest other rows in original order')
  assert.equal(rows[0].type, StreamRecordCard)
  assert.equal(rows[0].props.record.body.fileCount, 2)
})

test('an open executor transcript message streams until its message or turn settles', async () => {
  const lines = [{ who: 'user', kind: 'text', text: 'Task' },
    { who: 'agent', kind: 'text', text: 'Implementing the filter', open: true, timeline: true }]
  const { RoundMember, host } = await loadClient('round.js', { call: async () => fullAnswer(lines) })
  const step = { session: 'e1', profile: 'coder', type: 'feature' }
  const round = { profiles: [{ id: 'coder', name: 'Coder' }], work: { e1: { active: true } }, onOpen() {} }
  const render = () => {
    host.reset()
    const tools = nodes(RoundMember({ step, round })).find(node => node.props.step === step && node.type !== RoundMember)
    return tools.type(tools.props)
  }
  render()
  host.effects.at(-1)()
  for (let at = 0; at < 5; at += 1) await tick()
  assert.equal(render().children[0].children[0].props.streaming, true)
  lines[1].open = false
  assert.equal(render().children[0].children[0].props.streaming, false)
  lines[1].open = true
  round.work.e1.active = false
  assert.equal(render().children[0].children[0].props.streaming, false)
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
  const { RoundMember, host } = await loadClient('round.js', { call: async () => fullAnswer(lines) })
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
  step.deferred = true
  step.at = 9
  assert.deepEqual(tools().children.map(row => row.props.summary), ['Reused task', 'Continued reused task'])
  step.at = 22
  assert.equal(tools(), false, 'accepted work shows no output from the previous task before it is sent')
})

test('executor tool records remain visible after interruption and stay within their delegation', async () => {
  const lines = [
    { who: 'user', at: 1 }, { who: 'agent', kind: 'tool', name: 'Bash', callId: 'old', phase: 'end', brief: 'Saved progress', at: 3 },
    { who: 'user', at: 10 }, { who: 'agent', kind: 'tool', name: 'Bash', callId: 'new', phase: 'end', brief: 'Revised task', at: 11 },
  ]
  const { RoundMember, host } = await loadClient('round.js', { call: async () => fullAnswer(lines) })
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
  const { Feed, RoundSpeaker, RoundChip, RoundMember, MessageTime } = await loadClient(['feed.js', 'round.js'], { stubs: { 'live.js': liveStub(feed) } })
  const profile = { id: 'lead', name: 'Lead', lead: true }
  const round = { profiles: [profile, { id: 'coder', name: 'Coder' }], teams: [], work: {}, onOpen() {} }
  const tree = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: true, since: 7, buffer: 'Next step' }, round }))
  assert.equal(tree.find(node => node.props.className === 'nodo-feed-inner').props['data-round'], '')
  assert.deepEqual(tree.filter(node => node.type === RoundSpeaker).map(node => [node.props.role, node.props.running]),
    [[profile, true]], 'the streaming reply continues the lead\'s segment, whose speaker shows the run')
  assert.equal(tree.filter(node => node.type === RoundChip).length, 1)
  assert.equal(tree.find(node => node.type === RoundMember), undefined, 'accepted work has no executor card during the lead turn')
  assert.equal(tree.find(node => node.props.className === 'nodo-reply').children[0].props.text, 'On it')
  const reply = tree.filter(node => node.props.className === 'nodo-reply').at(-1)
  assert.ok(tree.indexOf(tree.find(node => node.type === RoundChip)) < tree.indexOf(reply), 'acceptance stays before the remaining lead output')
  const idle = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false }, round }))
  assert.equal(idle.find(node => node.type === RoundMember).props.step.session, 'e1')
  assert.equal(idle.filter(node => node.type === MessageTime).length, 2, 'the user bubble and the finished lead reply carry the only times')
  assert.equal(idle.find(node => node.type === RoundSpeaker).props.running, false)
  const plainFeed = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false } }))
  assert.equal(plainFeed.find(node => node.props.className === 'nodo-feed-inner').props['data-round'], undefined)
  assert.equal(plainFeed.filter(node => node.type === RoundSpeaker).length, 0)
})

test('the sessions rail keeps executor rows, state, highlight, role filter and search independent', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow, SearchDialog } = await loadClient(['session-rail.tsx', 'search-dialog.tsx', 'avatar.tsx', 'ui-shared.js'], {
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
  const finder = render().find(node => node.type === SearchDialog)
  assert.deepEqual(finder.props.items.map(item => item.id), ['e1', 'own', 'orphan', 'o1', 'l1'], 'the finder lists every session newest first, executors included')
  assert.equal(rows().length, 5, 'the open finder leaves the rail list alone')
})

test('the session finder opens from the dock button, closes itself and picks into the rail', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SearchDialog } = await loadClient(['session-rail.tsx', 'search-dialog.tsx', 'avatar.tsx', 'ui-shared.js'], {
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
  const selected = []
  const render = () => { cursor = 0; return nodes(Rail({ view, workspace, sessionId: 's1', onSelect() {}, onSelectSession: (role, id, project) => selected.push([role.id, id, project.id]) })) }
  const button = () => render().find(node => node.type === 'button' && node.props['aria-label'] === '搜索')
  const toggle = () => button().props.onClick()
  const finder = () => render().find(node => node.type === SearchDialog)
  assert.equal(finder(), undefined, 'the finder waits behind the dock button')
  toggle()
  assert.deepEqual(finder().props.items.map(item => item.id), ['s1'])
  assert.equal(button().props['aria-pressed'], true)
  toggle()
  assert.equal(finder(), undefined, 'the dock button closes an open finder')
  toggle()
  finder().props.onClose()
  assert.equal(finder(), undefined, 'the finder closes itself')
  toggle()
  finder().props.items[0].pick()
  assert.deepEqual(selected, [['coder', 's1', 'w']], 'a result opens its session in its project')
})

test('the roster puts roles with a state first by latest change, then leads, then the stored order', async () => {
  const slots = []
  let cursor = 0
  const { Rail } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
    react: { useState: initial => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    } } })
  const view = { workspaces: [], work: { l1: { active: true, since: 10 }, o1: { active: true, since: 30 }, c1: { status: 'stopped', finishedAt: 20 } }, profiles: [
    { id: 'coder', name: 'Coder', sessions: [{ id: 'c1', name: 'Own work' }] },
    { id: 'alpha', name: 'Alpha', lead: true, sessions: [{ id: 'l1', name: 'Lead work' }] },
    { id: 'other', name: 'Other', sessions: [{ id: 'o1', name: 'Other work' }] },
    { id: 'beta', name: 'Beta', lead: true, sessions: [] },
  ] }
  const render = () => { cursor = 0; return nodes(Rail({ view, onSelect() {}, onSelectSession() {} })) }
  const roster = () => render().filter(node => node.props.className === 'nodo-roster-item' && node.props.title)
  assert.deepEqual(roster().map(node => node.props.title), ['Other', 'Coder', 'Alpha', 'Beta'])
  assert.equal(render().some(node => node.props?.['data-lead'] === ''), false)
  const calls = []
  view.teams = [{ id: 't1', name: '前端组', lead: 'alpha' }, { id: 't2', name: '', lead: 'beta' }, { id: 't3', name: '空组', lead: null }]
  cursor = 0
  const teamTree = nodes(Rail({ view, navigation: { view: 'team' }, onSelect() {}, onSelectSession() {}, onNewTeam: () => calls.push('new'), onEditTeam: id => calls.push(id) }))
  assert.deepEqual(teamTree.filter(node => node.props.className === 'nodo-roster-item' && node.props.title).map(node => node.props.title), ['前端组', '未命名团队', '空组'])
  const add = teamTree.find(node => node.props.className === 'nodo-roster-item nodo-roster-new')
  assert.deepEqual(nodes(add).filter(node => node.props?.className === 'nodo-roster-name').map(node => node.children[0]), ['新建团队'])
  add.props.onClick()
  teamTree.find(node => node.props['aria-label'] === '配置团队 前端组').props.onClick()
  assert.equal(teamTree.find(node => node.props['aria-label'] === '配置团队 空组').props.disabled, false, 'a team without a lead is editable at once')
  teamTree.find(node => node.props['aria-label'] === '配置团队 空组').props.onClick()
  teamTree.find(node => node.props.className === 'nodo-roster-item' && node.props.title === '空组').props.onClick()
  assert.deepEqual(calls, ['new', 't1', 't3', 't3'], 'a lead-less team row opens its config like its edit button')
})

async function mount(viewName = 'team', restored, feed = null) {
  const slots = [], calls = [], storage = {}
  let cursor = 0
  let navigation = restored ?? { view: viewName, profile: 'lead', workspace: 'w', sessions: { 'w:lead': 'l1' } }
  const lead = { id: 'lead', name: 'Lead', lead: true, engine: 'codex', workspaceId: 'w', sessions: [{ id: 'l1', name: 'Fix login', workspaceRef: 'w' }] }
  const coder = { id: 'coder', name: 'Coder', engine: 'codex', workspaceId: 'w', sessions: [
    { id: 'e2', name: 'Second', workspaceRef: 'w', createdAt: 2, source: { kind: 'lead', leadSessionId: 'l1' } },
    { id: 'e1', name: 'First', workspaceRef: 'w', createdAt: 1, source: { kind: 'lead', leadSessionId: 'l1' } },
  ] }
  const view = { profiles: [lead, coder], workspaces: [{ id: 'w', name: 'Project' }], work: { e1: { active: true, since: 100 } },
    stats: { l1: { turns: 2, steps: 4, inputTokens: 100, outputTokens: 50 }, e1: { turns: 1, steps: 2, inputTokens: 20, outputTokens: 10 } },
    teams: [], prefs: { onboardedAt: 1 }, approvals: [{ id: 'a1', profileId: 'e1' }, { id: 'a2', profileId: 'elsewhere' }] }
  const space = { active: true, legacy: true }
  const loaded = await loadClient(['page.js', 'round.js', 'session-panel.js', 'composer.js', 'feed.js', 'running.js', 'run-cards.js', 'role-seat.js'], {
    ...(feed ? { stubs: { 'live.js': liveStub(feed) } } : {}),
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      readNavigation: () => navigation, subscribeNavigation() {}, setNavigation: update => { navigation = update(navigation) },
      nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy() {} },
      readNativeSession: () => null, subscribeNativeSession() {}, completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      workLabel: work => work?.active ? '运行中' : '', workDot: () => 'ongoing', workKind: () => 'run', WorkDot: 'WorkDot', sessionTime: () => '',
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
      getItem: key => key === 'nodo.navigation' ? JSON.stringify(navigation) : storage[key] ?? null,
      setItem: (key, value) => { if (key === 'nodo.navigation') navigation = JSON.parse(value); else storage[key] = value },
    } },
  })
  const render = () => { cursor = 0; return nodes(loaded.NodoPage({ contentOnly: true })) }
  return { loaded, view, calls, render, navigation: () => plain(navigation), find: type => render().find(node => node.type === type)?.props }
}

test('a lead session opens as its round: chat feed, faces, session menu and round approvals', async () => {
  const { loaded, view, render, find } = await mount()
  assert.equal(typeof find(loaded.Feed).round.onOpen, 'function')
  assert.equal(find(loaded.Feed).round.work, view.work)
  await openPanel({ render })
  const menu = find(loaded.SessionPanel).team
  assert.deepEqual(plain(menu.members.map(item => item.session.id)), ['e1', 'e2'])
  assert.deepEqual(plain(render().filter(node => node.type === loaded.ApprovalCard).map(node => node.props.card.id)), ['a1'])
  assert.equal(find(loaded.RunningLine), undefined, 'the running line belongs to the lead\'s own run')
  assert.deepEqual(plain(find(loaded.RoundFaces).roles.map(role => role.id)), ['lead', 'coder'])
  const items = menuItems(loaded.RoundTeam({ ...menu }))
  assert.deepEqual(plain(items.map(item => item.id)), ['l1', 'e1', 'e2'], 'the lead heads the list')
  assert.equal(text(items[1].label), 'First|Coder|运行中')
  assert.equal(text(items[2].label), 'Second|Coder')
})

test('the round menu scopes its task list to the lead session workspace, not the display anchor', async () => {
  const h = await mount()
  h.view.workspaces.push({ id: 'tw', name: 'nodo/task-x', worktree: { branch: 'nodo/task-x', project: 'w' } })
  h.view.profiles[0].sessions[0].workspaceRef = 'tw'
  await openPanel(h)
  assert.equal(h.find(h.loaded.SessionPanel).workspace, 'tw', 'the menu asks for tasks where the lead session lives')
})

test('the session menu titles each executor with its latest task and keeps the role, time and state on the second line', async () => {
  const calls = []
  const tasks = [
    { id: 't1', title: 'First task', executions: [{ sessionId: 'e1', createdAt: 10, startedAt: 20, endedAt: 30 }] },
    { id: 't2', title: 'Reused task', executions: [{ sessionId: 'e1', createdAt: 100, startedAt: 140, endedAt: 300 }] },
    { id: 't3', title: 'Newest task', executions: [{ sessionId: 'e1', createdAt: 200, startedAt: 250, endedAt: null }] },
    { id: 't4', title: 'Queued task', executions: [{ sessionId: 'e3', createdAt: 500, startedAt: null, endedAt: null }] },
  ]
  const { RoundTeam, host } = await loadClient('round.js', { uiShared: {
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return endpoint === 'task-list' ? tasks : undefined },
    sessionTime: at => ({ 7: '5分钟前', 250: '刚刚', 500: '3秒前' })[at] ?? '',
    workLabel: work => work?.active ? '运行中' : '', workDot: () => 'ongoing',
  } })
  const members = [
    { role: { id: 'coder', name: 'Coder' }, session: { id: 'e1', name: 'First', updatedAt: 7 } },
    { role: { id: 'coder', name: 'Coder' }, session: { id: 'e2', name: 'Legacy', updatedAt: 7 } },
    { role: { id: 'coder', name: 'Coder' }, session: { id: 'e3', name: 'Fresh', updatedAt: 7 } },
  ]
  const label = id => {
    host.reset()
    const items = menuItems(RoundTeam({ members, work: { e1: { active: true } }, struct: 1, workspace: 'w1', onOpen() {} }))
    return text(items.find(item => item.id === id).label)
  }
  assert.equal(label('e1'), 'First|Coder · 5分钟前|运行中', 'a session keeps its own row until the task list answers')
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(plain(calls), [{ endpoint: 'task-list', payload: { workspace: 'w1' } }])
  assert.equal(label('e1'), 'Newest task|Coder · 刚刚|运行中', 'a reused session takes its newest execution, and the time comes from that execution alone')
  assert.equal(label('e2'), 'Legacy|Coder · 5分钟前', 'a session without executions keeps its name and its own time')
  assert.equal(label('e3'), 'Queued task|Coder · 3秒前', 'a queued execution dates itself from creation')
})

test('the team list asks for tasks scoped to its workspace and titles each session with its task', async () => {
  const calls = []
  const tasks = [{ id: 't1', title: 'First task', executions: [{ sessionId: 'e1', createdAt: 10, startedAt: null, endedAt: null }] }]
  const { RoundTeam, host } = await loadClient('round.js', { uiShared: {
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return endpoint === 'task-list' ? tasks : undefined },
    sessionTime: at => ({ 10: '刚刚' })[at] ?? '',
    workLabel: () => '', workDot: () => 'ongoing',
  } })
  const members = [{ role: { id: 'coder', name: 'Coder' }, session: { id: 'e1', name: 'First', updatedAt: 7 } }]
  const items = () => {
    host.reset()
    return menuItems(RoundTeam({ members, work: {}, struct: 1, workspace: 'w1', onOpen() {} }))
  }
  items()
  host.effects.at(-1)()
  await tick()
  assert.deepEqual(plain(calls), [{ endpoint: 'task-list', payload: { workspace: 'w1' } }])
  assert.equal(text(items().find(item => item.id === 'e1').label), 'First task|Coder · 刚刚', 'the list titles each session with its task')
})

test('the team list folds to its header and keeps the list scrollable inside a bounded card', async () => {
  const { RoundTeam, host } = await loadClient('round.js', { uiShared: { call: async () => [], sessionTime: () => '', workLabel: () => '', workDot: () => 'idle' } })
  const members = [1, 2, 3].map(n => ({ role: { id: 'coder', name: 'Coder' }, session: { id: `e${n}`, name: `S${n}` } }))
  const render = () => { host.reset(); return RoundTeam({ members, work: {}, struct: 1, workspace: 'w', onOpen() {} }) }
  assert.equal(menuItems(render()).length, 3)
  assert.ok(nodes(render()).some(node => node.props?.className === 'nodo-team-list'))
  const fold = nodes(render()).find(node => node.props?.['aria-expanded'] === true)
  host.cells[1] = true
  assert.equal(menuItems(render()).length, 0)
  assert.equal(nodes(render()).find(node => node.props?.['aria-expanded'] !== undefined).props['aria-expanded'], false)
  assert.equal(typeof fold.props.onClick, 'function')
})

test('artifacts collect workspace files its write/edit tools touched, reply links and attached images', async () => {
  const { artifactsOf } = await loadClient('artifacts.js', { uiShared: { toolVariant: name => ({ Write: 'write', Edit: 'edit', Read: 'read' })[name] } })
  const lines = [
    { kind: 'tool', name: 'Write', phase: 'start', input: { file_path: '/ws/a.txt', content: 'x' } },
    { kind: 'tool', name: 'Edit', phase: 'start', callId: 'c1', input: { file_path: '/ws/src/b.js', old_string: 'a', new_string: 'b' } },
    { kind: 'tool', name: 'Edit', phase: 'end', callId: 'c1', input: { file_path: '/ws/src/b.js', old_string: 'a', new_string: 'b' } },
    { kind: 'tool', name: 'Edit', phase: 'end', callId: 'c2', input: { file_path: '/ws/src/b.js', old_string: 'b', new_string: 'c' } },
    { kind: 'tool', name: 'Read', input: { file_path: '/ws/c.js' } },
    { kind: 'tool', name: 'Write', input: { file_path: '/elsewhere/x.txt', content: 'x' } },
    { who: 'agent', kind: 'text', text: 'See https://example.com/docs. and (https://a.dev/x) again https://a.dev/x', images: [{ id: 'i1', mediaType: 'image/png', name: 'p.png' }] },
    { who: 'user', kind: 'text', text: 'https://user.example/ignored', images: [{ id: 'u1', mediaType: 'image/png' }] },
  ]
  const found = artifactsOf(lines, '/ws')
  assert.deepEqual(plain(found.files.map(file => file.display)), ['a.txt', 'src/b.js'], 'one entry per file; reads and files outside the workspace are left out')
  assert.deepEqual(plain(found.files.map(file => file.diffs.length)), [1, 2], 'every edit call of a file is kept once, not once per start and end line')
  assert.deepEqual(plain(found.links), ['https://example.com/docs', 'https://a.dev/x'])
  assert.deepEqual(plain(found.images.map(image => image.id)), ['i1'], 'only the model\'s images')
})

test('the team stop interrupts only the lead and a draft still sends to the lead', async () => {
  const { loaded, calls, find, view } = await mount()
  view.work.l1 = { active: true }
  const composer = find(loaded.Composer)
  assert.equal(composer.running, true)
  composer.onStop()
  await tick()
  assert.deepEqual(plain(calls.filter(call => call.endpoint === 'interrupt')), [{ endpoint: 'interrupt', payload: { profile: 'lead', session: 'l1' } }],
    'the running member keeps running; the stop names the lead session alone')
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
  const idle = all(Composer({ value: '', images: [], running: false, onSend() {}, onStop: () => stops++ }))
  assert.equal(idle.some(node => node.props.className === 'nodo-pending-stop'), false, 'a not-stoppable composer draws no stop button')
  assert.equal(idle.find(node => node.props.className === 'nodo-send').props['aria-label'], '发送消息')
  assert.equal(stops, 2)
})

test('an idle lead with running members shows the task count and no composer stop', async () => {
  const { loaded, find, render, view } = await mount()
  assert.equal(find(loaded.Composer).running, false)
  assert.equal(find(loaded.Composer).stoppable, undefined, 'the composer falls back to the idle lead: no stop')
  const count = () => { const dock = render().find(node => node.props?.className === 'nodo-running-dock')
    return dock && nodes(dock).find(node => node.type === loaded.TaskCountLine) }
  assert.equal(find(loaded.RunningLine), undefined, 'the idle lead draws no running line')
  assert.equal(count().props.count, 1, 'the running member counts while the lead idles')
  assert.equal(text(count().type(count().props)), '1 个任务执行中')
  view.work.e2 = { active: true }
  assert.equal(count().props.count, 2, 'parallel members each count')
  delete view.work.e2
  assert.equal(count().props.count, 1)
  view.work.e1 = { active: false }
  assert.equal(count(), undefined, 'no dock once no member is active')
})

test('two parallel member cards stop and end independently', async () => {
  const feed = { lines: [
    { who: 'user', kind: 'text', text: 'Ship both', at: 1 },
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false }, at: 2 },
    { who: 'system', kind: 'note', text: '已派给 Tester', delegation: { session: 'e2', profile: 'tester', type: 'test', hard: false, reused: false }, at: 3 },
  ] }
  const stopped = []
  const { Feed, RoundMember, host } = await loadClient(['feed.js', 'round.js'], { stubs: { 'live.js': liveStub(feed) } })
  const lead = { id: 'lead', name: 'Lead', lead: true }
  const round = { profiles: [lead, { id: 'coder', name: 'Coder' }, { id: 'tester', name: 'Tester' }], teams: [],
    work: { e1: { active: true, since: 1000 }, e2: { active: true, since: 2000 } }, onOpen() {}, onStop: async step => { stopped.push(step.session) } }
  const cards = () => { host.reset(); return nodes(Feed({ profile: lead, session: { id: 'l1' }, work: { active: false }, round }))
    .filter(node => node.type === RoundMember) }
  assert.deepEqual(cards().map(node => node.props.step.session), ['e1', 'e2'])
  const rendered = index => nodes(cards()[index].type(cards()[index].props))
  rendered(0).find(node => node.props['aria-label'] === '停止 Coder').props.onClick()
  await tick()
  assert.deepEqual(stopped, ['e1'], 'one card stops its own session')
  feed.lines.push({ who: 'system', kind: 'note', text: '执行未完成', delegation: { session: 'e1', ended: 'interrupted', stoppedBy: 'user' }, at: 4 })
  const after = cards()
  assert.equal(after[0].props.step.ended, 'interrupted')
  const other = rendered(1)
  assert.equal(after[1].props.step.ended, undefined)
  assert.equal(other.some(node => node.props['data-state'] === 'live'), true, 'the parallel member still reads live')
  assert.equal(other.some(node => node.props['aria-label'] === '停止 Tester'), true, 'the parallel member keeps its own stop')
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
  assert.equal(back.children[1].children[0], 'Fix login')
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
  assert.equal(find(loaded.SessionPanel), undefined)
  assert.equal(find(loaded.RoundFaces), undefined)
  assert.equal(find(loaded.ApprovalCard), undefined, 'executor approvals belong in Team or the executor page')
  assert.equal(find(loaded.Composer).stoppable, undefined)
  find(loaded.Composer).onStop()
  await tick()
  assert.deepEqual(plain(calls.filter(call => call.endpoint === 'interrupt')), [{ endpoint: 'interrupt', payload: { profile: 'lead', session: 'l1' } }])
})

test('Team renders a round before dispatch and its menu opens members in home', async () => {
  const harness = await mount()
  const { loaded, find, navigation } = harness
  await openPanel(harness)
  find(loaded.SessionPanel).team.onOpen('e1')
  await tick()
  assert.equal(navigation().view, 'sessions')
  assert.equal(find(loaded.Feed).session.id, 'e1')
  assert.equal(find(loaded.Feed).round, undefined)
  const fresh = await mount()
  fresh.view.profiles[1].sessions = []
  assert.ok(fresh.find(fresh.loaded.Feed).round)
  await openPanel(fresh)
  assert.equal(fresh.find(fresh.loaded.SessionPanel).team, undefined)
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

test('Team rail lists only non-dsh lead sessions, aggregates member state and feeds the finder', async () => {
  const { Rail, SessionRow, SearchDialog, host } = await loadClient(['session-rail.tsx', 'search-dialog.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
  })
  const workspace = { id: 'w', name: 'Project' }
  const lead = { id: 'lead', name: 'Lead', lead: true, engine: 'codex', sessions: [
    { id: 'l1', name: 'Task', workspaceRef: 'w', updatedAt: 1 },
    { id: 'l2', name: 'New round', workspaceRef: 'w', updatedAt: 2 },
    { id: 'old', name: 'Archived', workspaceRef: 'w', archivedAt: 1 },
  ] }
  const view = { workspaces: [workspace], work: { e1: { active: true, status: 'waiting-approval' } }, teams: [{ id: 't1', name: 'Lead', lead: 'lead' }], profiles: [lead,
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
  assert.deepEqual(['主页', '新建会话', '搜索', '角色'].map(dockButton).map(node => node.props['aria-pressed']),
    [true, undefined, false, false], 'the team view is a tab of 主页')
  const tab = label => render().find(node => node.props?.role === 'tab' && node.children[0] === label)
  assert.deepEqual([tab('角色').props['aria-selected'], tab('团队').props['aria-selected']], [false, true])
  assert.equal(dockButton('新建会话').props.disabled, false, 'the Team dock keeps the new-session button clickable')
  dockButton('新建会话').props.onClick()
  assert.deepEqual(created, ['lead', 'lead'], 'the dock drafts for the lead role like the project row does')
  assert.equal(dockButton('主页').props.onClick, undefined, '主页 keeps the current tab')
  tab('角色').props.onClick()
  dockButton('搜索').props.onClick()
  assert.deepEqual(switched, ['sessions'], 'only the 角色 tab leaves Team; 搜索 opens the finder in place')
  const finder = render().find(node => node.type === SearchDialog)
  assert.deepEqual(finder.props.items.map(item => item.id), ['l1', 'l2'], 'the Team finder lists the same lead sessions as the rail')
  assert.equal(finder.props.items[0].updatedAt, 5, 'a lead session carries its executors\' latest time')
  assert.ok(finder.props.items[0].terms.includes('Refresh race'), 'a lead session is found by its executors')
})

test('the dock new-session button locks only on the roles page or a Team without usable leads', async () => {
  const { Rail, host } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
  })
  const workspace = { id: 'w', name: 'Project' }
  const view = { workspaces: [workspace], work: {}, profiles: [
    { id: 'lead', name: 'Lead', lead: true, engine: 'codex', sessions: [] },
    { id: 'coder', name: 'Coder', sessions: [] },
  ] }
  const dock = navigation => {
    host.reset()
    return nodes(Rail({ view, workspace, navigation, onNewSession: () => {}, onSessions: () => {} }))
      .find(node => node.type === 'button' && node.props['aria-label'] === '新建会话')
  }
  assert.equal(dock(null).props.disabled, false, 'the home dock stays clickable')
  assert.equal(dock({ view: 'team' }).props.disabled, false, 'the Team dock stays clickable')
  assert.equal(dock({ view: 'roles', content: null }).props.disabled, true, 'the roles page keeps the dock locked')
  view.profiles[0].lead = false
  assert.equal(dock({ view: 'team' }).props.disabled, true, 'a Team without usable lead roles keeps the dock locked')
})

test('supplementing scopes the conversation to a task: chip, taskId on send, queue title and approval title', async () => {
  const feed = { error: '', lines: [
    { who: 'system', kind: 'note', text: '已派给 Coder', delegation: { session: 'e1', profile: 'coder', type: 'bug-fix', hard: false, reused: false, taskId: 't1', executionId: 'x1' }, at: 3 } ] }
  const { loaded, view, calls, find, render } = await mount('team', null, feed)
  view.tasks = [{ id: 't1', title: 'Fix login', status: 'open' }, { id: 't2', title: 'Other task', status: 'open' }]
  view.approvals = [{ id: 'a1', profileId: 'e1', taskId: 't1' }]
  view.work.l1 = { active: false, pending: [{ seq: 5, text: 'Queued', images: [], sending: false, taskId: 't1' }] }
  const composer = () => find(loaded.Composer)
  assert.equal(composer().taskScope, undefined, 'no scope before supplementing')
  find(loaded.Feed).round.onSupplement({ taskId: 't1' })
  assert.equal(composer().taskScope, 'Fix login')
  assert.deepEqual(plain(composer().pending), [{ seq: 5, text: 'Queued', images: [], sending: false, taskId: 't1', taskTitle: 'Fix login' }],
    'a queued supplement names its task')
  assert.equal(find(loaded.ApprovalCard).card.taskTitle, 'Fix login', 'the approval card carries its task title')
  find(loaded.Feed).round.onOpen('e1')
  await tick()
  assert.equal(composer().taskScope, undefined, 'another session carries no scope')
  render().find(node => node.props.className === 'nodo-crumb nodo-crumb-link').props.onClick()
  await tick()
  assert.equal(composer().taskScope, 'Fix login', 'returning restores the session scope')
  composer().onChange('Plus one')
  composer().onSend()
  await tick(); await tick()
  assert.deepEqual(plain(calls.find(call => call.endpoint === 'send').payload),
    { profile: 'lead', session: 'l1', text: 'Plus one', images: [], mode: 'queue', taskId: 't1' })
  composer().onRemoveTaskScope()
  assert.equal(composer().taskScope, undefined, 'the chip removes the scope')
  composer().onChange('Plain')
  composer().onSend()
  await tick(); await tick()
  assert.deepEqual(plain(calls.filter(call => call.endpoint === 'send').at(-1).payload),
    { profile: 'lead', session: 'l1', text: 'Plain', images: [], mode: 'queue' })
})
