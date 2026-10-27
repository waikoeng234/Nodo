import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) ? []
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
    'Fix the login', 'speaker', 'Plan', 'Delegating', 'delegate', 'member', 'speaker', 'boom', 'delegate', 'member',
    'speaker', '执行未完成：gone', '进度如何？', 'speaker', 'Resuming the tester.', 'usage', 'delegate', 'member'])
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
  assert.equal(head(ended), 'Tester|测试|未完成|查看会话')
  assert.equal(text(ended.find(node => node.props.className === 'nodo-round-quiet')), '已中断，没有回报主控。')
  assert.equal(head(view({ session: 'e4', profile: 'tester', type: 'test', hard: false, reused: false })), 'Tester|测试|未回报|查看会话')
})

test('a delegation chip names its executor, and the faces stack lists every role of the round', async () => {
  const { RoundChip, RoundFaces, RoundSpeaker } = await loadClient('round.js')
  const round = { profiles: [{ id: 'coder', name: 'Coder' }] }
  assert.equal(text(RoundChip({ step: { profile: 'coder', reused: false }, round })), '派给 Coder')
  assert.equal(text(RoundChip({ step: { profile: 'coder', reused: true }, round })), '继续派给 Coder')
  assert.equal(nodes(RoundChip({ step: { profile: 'coder' }, round })).find(node => node.props.size === 16).props.profile.name, 'Coder')
  const faces = RoundFaces({ roles: [{ id: 'lead', name: 'Lead' }, { id: 'coder', name: 'Coder' }] })
  assert.equal(faces.props['aria-label'], 'Lead、Coder')
  assert.deepEqual(faces.children.map(node => node.props.size), [20, 20])
  const speaker = RoundSpeaker({ role: { id: 'lead', name: 'Lead' }, running: true })
  assert.equal(speaker.children[0].props.running, true)
  assert.equal(text(speaker), 'Lead')
})

test('a live executor message shows that executor\'s latest five tool calls of the current turn', async () => {
  const calls = []
  const tool = (id, phase) => ({ who: 'agent', kind: 'tool', name: 'Bash', phase, callId: id, brief: id })
  const lines = [{ who: 'user', kind: 'text', text: 'Earlier' }, tool('c0', 'start'), tool('c0', 'end'), { who: 'user', kind: 'text', text: 'Task' },
    ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].flatMap(id => [tool(id, 'start'), tool(id, 'end')]), tool('c7', 'start')]
  const { RoundMember, host } = await loadClient('round.js', { call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return lines } })
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
  const rows = tools().children
  assert.deepEqual(rows.map(row => row.props.summary), ['c3', 'c4', 'c5', 'c6', 'c7'])
  assert.deepEqual(rows.map(row => row.props.running), [false, false, false, false, true])
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
    [[profile, false], [profile, true]], 'the streaming reply after an executor opens under a live speaker row')
  assert.equal(tree.filter(node => node.type === RoundChip).length, 1)
  assert.equal(tree.find(node => node.type === RoundMember).props.step.session, 'e1')
  assert.equal(tree.find(node => node.props.className === 'nodo-reply').children[0].props.text, 'On it')
  const idle = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false }, round }))
  assert.equal(idle.filter(node => node.type === MessageTime).length, 2, 'the user bubble and the finished lead reply carry the only times')
  assert.equal(idle.find(node => node.type === RoundSpeaker).props.running, false)
  const plainFeed = nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false } }))
  assert.equal(plainFeed.find(node => node.props.className === 'nodo-feed-inner').props['data-round'], undefined)
  assert.equal(plainFeed.filter(node => node.type === RoundSpeaker).length, 0)
})

test('the rail folds executor sessions into their lead row for state, highlight, role filter and search', async () => {
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
  assert.deepEqual(rows().map(row => row.props.session.id), ['l1', 'own', 'orphan', 'o1'])
  const lead = rows()[0].props
  assert.equal(lead.work.active, true)
  assert.equal(lead.session.updatedAt, 5)
  assert.equal(lead.current, true, 'an open executor session highlights its lead row')
  assert.deepEqual(rows().filter(row => row.props.current).map(row => row.props.session.id), ['l1'])
  const press = name => render().find(node => node.props.className === 'nodo-roster-item' && node.props.title === name).props.onClick()
  press('Lead')
  assert.deepEqual(rows().map(row => row.props.session.id), ['l1'])
  press('Lead')
  press('Coder')
  assert.deepEqual(rows().map(row => row.props.session.id), ['l1', 'own', 'orphan'])
  press('Coder')
  press('Other')
  assert.deepEqual(rows().map(row => row.props.session.id), ['o1'])
  press('Other')
  render().find(node => node.type === 'Menu' && node.props.items?.some(item => item.id === 'search')).props.onSelect('search')
  render().find(node => node.type === 'Input').props.onChange({ target: { value: 'refresh' } })
  assert.deepEqual(rows().map(row => row.props.session.id), ['l1'])
})

test('the rail search closes from the menu, on blur when empty and on Escape, and stays open on blur with a query', async () => {
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
  const menu = () => render().find(node => node.type === 'Menu' && node.props.items?.some(item => item.id === 'search'))
  const search = () => render().find(node => node.type === 'Input')
  assert.equal(search(), undefined, 'search waits in the project menu')
  menu().props.onSelect('search')
  assert.equal(search().props.placeholder, '搜索会话')
  search().props.onChange({ target: { value: 'refresh' } })
  search().props.onBlur?.()
  assert.equal(search().props.value, 'refresh', 'a non-empty query survives the blur')
  menu().props.onSelect('search')
  assert.equal(search(), undefined, 'the menu item closes an open search')
  menu().props.onSelect('search')
  assert.equal(search().props.value, '', 'reopening starts from a cleared query')
  search().props.onBlur?.()
  assert.equal(search(), undefined, 'an empty query closes on blur')
  menu().props.onSelect('search')
  search().props.onKeyDown({ key: 'Escape' })
  assert.equal(search(), undefined, 'Escape still closes the search')
})

test('the roster lists leads first with a badge and keeps the stored order in each group', async () => {
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
  const badge = item => nodes(item).find(node => node.props?.className === 'nodo-roster-badge')
  assert.deepEqual(roster().map(node => node.props.title), ['Alpha', 'Beta', 'Coder', 'Other'])
  assert.deepEqual(roster().map(node => !!badge(node)), [true, true, false, false])
  assert.equal(badge(roster()[0]).children[0].type, 'IconSparkleRegular')
  assert.deepEqual(roster().map(node => node.props['aria-label']),
    ['Alpha，运行中，主控', 'Beta，主控', 'Coder', 'Other'])
})

async function mount() {
  const slots = [], calls = []
  let cursor = 0
  let navigation = { profile: 'lead', workspace: 'w', sessions: { 'w:lead': 'l1' } }
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
    globals: { document: { visibilityState: 'visible', hasFocus: () => true }, localStorage: { getItem: () => null, setItem() {} } },
  })
  const render = () => { cursor = 0; return nodes(loaded.NodoPage({ contentOnly: true })) }
  return { loaded, view, calls, render, find: type => render().find(node => node.type === type)?.props }
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
  menu.onRaw()
  assert.equal(find(loaded.Feed).round, undefined, '完整记录 shows the raw lead transcript')
  assert.equal(find(loaded.RoundMenu).raw, true)
  find(loaded.RoundMenu).onRaw()
  assert.notEqual(find(loaded.Feed).round, undefined)
  const items = nodes(loaded.RoundMenu({ ...find(loaded.RoundMenu) })).find(node => node.type === 'Menu').props.items
  assert.deepEqual(plain(items.map(item => item.id)), ['raw', 'e1', 'e2'])
  assert.equal(text(items[1].label), 'Coder|First|运行中')
  assert.equal(text(items[2].label), 'Coder|Second')
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
  const { loaded, calls, render, find } = await mount()
  find(loaded.Feed).round.onOpen('e2')
  await tick()
  assert.deepEqual(plain(calls.at(-1)), { endpoint: 'session-select', payload: { profile: 'coder', session: 'e2' } })
  assert.equal(find(loaded.Feed).session.id, 'e2')
  assert.equal(find(loaded.Feed).round, undefined)
  const back = render().find(node => node.props.className === 'nodo-crumb nodo-crumb-link')
  assert.equal(back.children[0], 'Fix login')
  back.props.onClick()
  await tick()
  assert.deepEqual(plain(calls.at(-1)), { endpoint: 'session-select', payload: { profile: 'lead', session: 'l1' } })
  assert.equal(find(loaded.Feed).session.id, 'l1')
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
