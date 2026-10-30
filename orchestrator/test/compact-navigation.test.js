import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes), ...nodes(node.props?.anchor)]
const tick = () => new Promise(resolve => setImmediate(resolve))

async function mount(pendingEndpoint = 'session-compact', engine = 'zcode', sidebarOnly = false) {
  const slots = [], calls = [], requests = new Map(), opened = []
  let cursor = 0
  let navigation = { profile: 'role', workspace: 'workspace', sessions: { 'workspace:role': 'a' } }
  const role = { id: 'role', name: 'Role', engine, workspaceId: 'workspace', activeSessionId: 'a',
    sessions: ['a', 'b'].map(id => ({ id, name: id, workspaceRef: 'workspace' })) }
  const view = { profiles: [role], workspaces: [{ id: 'workspace', name: 'Project' }], work: {}, stats: {}, approvals: [] }
  // selectSession compares snapshots by identity to detect navigation away.
  let space = { active: true, legacy: false }
  const loaded = await loadClient(['page.js', 'session-rail.tsx', 'composer.js', 'feed.js', 'running.js', 'run-cards.js', 'role-seat.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      readNavigation: () => navigation, subscribeNavigation() {},
      setNavigation: update => { navigation = update(navigation) },
      nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy: () => { space = { ...space, legacy: true, drafting: false } },
        startDraft: draft => { space = { ...space, drafting: true, draft } } },
      readNativeSession: () => null, subscribeNativeSession() {},
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      openNativeSession: engine === 'dsh' ? id => { opened.push(id); space = { ...space, legacy: false, drafting: false, nodoSession: id } } : null,
      runningOf: () => ({ active: false }),
      workLabel: () => '', workKind: () => 'stop', WorkDot: 'WorkDot', sessionTime: () => '',
      workspaceIdOf: (_view, role, session) => session.workspaceRef ?? role.workspaceId,
      roleStateOf: (role, view) => ({ active: role.sessions.some(session => view.work[session.id]?.active) }),
      sectionHead: (_title, action) => action,
      ARCHIVED_VIEWS: { hide: '隐藏已归档', all: '全部对话（显示已归档）', only: '仅显示已归档' }, SESSION_FOLD: 10,
      call: async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        if (endpoint !== pendingEndpoint) return undefined
        const request = Promise.withResolvers()
        requests.set(payload.session, request)
        return request.promise
      },
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
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: () => null, setItem() {} },
    },
  })
  const render = () => { cursor = 0; return nodes(loaded.NodoPage({ sidebarOnly })) }
  return { loaded, view, role, calls, requests, opened, render, space: () => space,
    composer: () => render().find(node => node.type === loaded.Composer).props,
    rail: () => render().find(node => node.type === loaded.Rail).props,
    // Rail state lives past the page's own slots so repeated rail renders keep it.
    railTree: props => { cursor = 1000; return nodes(loaded.Rail(props)) } }
}

test('a pending compact leaves session navigation available and locks only that session composer', async () => {
  const h = await mount()
  h.composer().onCompact()
  assert.equal(h.requests.has('a'), true)
  assert.equal(h.composer().busy, true)
  h.composer().onCompact()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-compact').length, 1)
  const rail = h.rail()
  assert.equal(rail.busy, false)
  for (const session of h.role.sessions) {
    const row = h.loaded.SessionRow({ role: h.role, session, busy: rail.busy, work: { active: session.id === 'a' } })
    assert.equal(nodes(row).find(node => node.props.className === 'nodo-row nodo-session').props.disabled, false)
  }
  rail.onSelectSession(h.role, 'b')
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.equal(h.composer().busy, false)
  h.composer().onChange('work in b')
  h.composer().onSend()
  await tick()
  assert.equal(h.calls.find(call => call.endpoint === 'send').payload.session, 'b')
  h.requests.get('a').resolve()
  await tick()
  assert.equal(h.rail().sessionId, 'b', 'completion must not navigate back to the compacted session')
})

test('concurrent compacts release their own session locks on success and failure', async () => {
  const h = await mount()
  h.composer().onCompact()
  h.rail().onSelectSession(h.role, 'b')
  await tick()
  h.composer().onCompact()
  assert.equal(h.composer().busy, true)
  h.requests.get('a').resolve()
  await tick()
  assert.equal(h.composer().busy, true, 'finishing a must leave b locked')
  h.rail().onSelectSession(h.role, 'a')
  await tick()
  assert.equal(h.composer().busy, false)
  h.rail().onSelectSession(h.role, 'b')
  await tick()
  assert.equal(h.composer().busy, true)
  h.requests.get('b').reject(new Error('compact failed'))
  await tick()
  assert.equal(h.composer().busy, false)
  assert.ok(h.render().some(node => node.props.role === 'alert' && node.children.includes('compact failed')))
})

test('a pending send keeps sidebar actions and other session composers available', async () => {
  const h = await mount('send')
  h.view.profiles.push({ id: 'idle', name: 'Idle', sessions: [] })
  h.composer().onChange('work in a')
  h.composer().onSend()
  await tick()
  h.view.work.a = { active: true }
  assert.equal(h.requests.has('a'), true)
  assert.equal(h.composer().busy, true)
  const rail = h.rail()
  assert.equal(rail.busy, false)
  const props = { ...rail, onSelect() {} }
  const tree = h.railTree(props)
  for (const label of ['添加角色', '添加项目', '在“Project”中新建会话', '项目“Project”的操作']) {
    assert.equal(!!tree.find(node => node.props['aria-label'] === label).props.disabled, false, label)
  }
  assert.equal(tree.find(node => node.type === 'Menu' && node.props.items?.some(item => item.id === 'worktree')).props.items
    .some(item => item.disabled), false, 'the project menu stays available')
  const config = name => {
    h.railTree(props).find(node => node.props.className === 'nodo-roster-item' && node.props.title === name).props.onClick()
    return h.railTree(props).find(node => node.props['aria-label'] === `配置角色 ${name}`)
  }
  assert.equal(!!config('Idle').props.disabled, false)
  assert.equal(config('Role').props.disabled, true)
  for (const session of h.role.sessions) {
    const row = nodes(h.loaded.SessionRow({ role: h.role, session, busy: rail.busy, work: h.view.work[session.id] }))
    assert.equal(row.find(node => node.props.className === 'nodo-row nodo-session').props.disabled, false)
    assert.equal(!!row.find(node => node.props['aria-label'] === `归档会话“${session.name}”`).props.disabled, session.id === 'a')
  }
  rail.onSelectSession(h.role, 'b')
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.equal(h.composer().busy, false)
  h.composer().onChange('work in b')
  h.composer().onSend()
  await tick()
  assert.equal(h.requests.has('b'), true)
  h.requests.get('a').resolve()
  await tick()
  assert.equal(h.rail().sessionId, 'b', 'a delayed send response must not switch back to its session')
  assert.equal(h.composer().busy, true, 'finishing a must leave b pending')
  h.requests.get('b').reject(new Error('send failed'))
  await tick()
  assert.equal(h.composer().busy, false)
  assert.equal(h.composer().value, 'work in b', 'a failed send retains its draft')
  assert.ok(h.render().some(node => node.props.role === 'alert' && node.children.includes('send failed')))
})

for (const endpoint of ['session-select', 'session-open']) test(`a pending ${endpoint} keeps the sidebar available and cannot replace a later selection`, async () => {
  const h = await mount(endpoint, endpoint === 'session-open' ? 'dsh' : 'zcode')
  h.view.work.a = { active: true }
  h.rail().onSelectSession(h.role, 'a')
  assert.equal(h.requests.has('a'), true)
  assert.equal(h.rail().busy, false)
  h.rail().onSelectSession(h.role, 'b')
  assert.equal(h.requests.has('b'), true)
  h.requests.get('b').resolve({ sessionId: 'native-b', conversationId: 'b' })
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  h.requests.get('a').resolve({ sessionId: 'native-a', conversationId: 'a' })
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.deepEqual(h.opened, endpoint === 'session-open' ? ['native-b'] : [])
})

for (const endpoint of ['interrupt', 'session-update']) test(`a pending ${endpoint} only locks its own session`, async () => {
  const h = await mount(endpoint)
  const act = () => endpoint === 'interrupt' ? h.composer().onStop() : h.composer().onModelChange({ model: 'next' })
  act()
  assert.equal(h.requests.has('a'), true)
  assert.equal(h.composer().busy, true)
  assert.equal(h.rail().busy, false)
  h.rail().onSelectSession(h.role, 'b')
  await tick()
  assert.equal(h.composer().busy, false)
  act()
  h.requests.get('a').resolve()
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.equal(h.composer().busy, true)
  h.requests.get('b').reject(new Error(`${endpoint} failed`))
  await tick()
  assert.equal(h.composer().busy, false)
})

for (const endpoint of ['send', 'session-update', 'interrupt', 'session-compact']) test(`a delayed ${endpoint} failure stays out of a later conversation`, async () => {
  const h = await mount(endpoint)
  if (endpoint === 'send') {
    h.composer().onChange('work in a')
    h.composer().onSend()
  } else if (endpoint === 'session-update') h.composer().onModelChange({ model: 'next' })
  else if (endpoint === 'interrupt') h.composer().onStop()
  else h.composer().onCompact()
  await tick()
  assert.equal(h.requests.has('a'), true)
  h.rail().onSelectSession(h.role, 'b')
  await tick()
  h.requests.get('a').reject(new Error('old conversation failed'))
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.ok(!h.render().some(node => node.props.role === 'alert' && node.children.includes('old conversation failed')))
  assert.equal(h.composer().busy, false)
})

test('a delayed successful send does not resume scrolling in another conversation', async () => {
  const h = await mount('send')
  h.composer().onChange('work in a')
  h.composer().onSend()
  await tick()
  h.rail().onSelectSession(h.role, 'b')
  await tick()
  const sentTick = () => h.render().find(node => node.type === h.loaded.Feed).props.sentTick
  const before = sentTick()
  h.requests.get('a').resolve()
  await tick()
  assert.equal(sentTick(), before)
  assert.equal(h.rail().sessionId, 'b')
})

test('a new conversation remains available during a pending selection', async () => {
  const h = await mount('session-select')
  h.rail().onSelectSession(h.role, 'b')
  h.rail().onNewSession(h.role.id)
  assert.equal(h.rail().draft.profile, h.role.id)
  h.requests.get('b').reject(new Error('old selection failed'))
  await tick()
  assert.equal(h.rail().sessionId, 'a')
  assert.ok(!h.render().some(node => node.props.role === 'alert' && node.children.includes('old selection failed')))
})

for (const action of ['onNewRole', 'onSettings', 'onNewWorkspace']) test(`${action} is not interrupted by a pending session selection`, async () => {
  const h = await mount('session-open', 'dsh')
  h.rail().onSelectSession(h.role, 'b')
  h.rail()[action]()
  const editing = h.rail().editing
  h.requests.get('b').resolve({ sessionId: 'native-b', conversationId: 'b' })
  await tick()
  assert.equal(h.rail().editing, editing)
  assert.equal(h.rail().sessionId, 'a')
  assert.deepEqual(h.opened, [])
})

test('opening a running conversation displays it before selection persistence returns', async () => {
  const h = await mount('session-select', 'zcode', true)
  h.view.work.b = { active: true }
  h.rail().onSelectSession(h.role, 'b')
  assert.equal(h.requests.has('b'), true)
  assert.equal(h.rail().sessionId, 'b', 'viewing a running session must not wait for a write')
  assert.equal(h.space().legacy, true, 'the blank native page must yield to the running conversation')
  h.rail().onNewSession(h.role.id)
  h.requests.get('b').resolve()
  await tick()
  assert.equal(h.space().drafting, true, 'background persistence must not replace a newer draft')
})

test('opening a bound running native conversation uses its existing window immediately', async () => {
  const h = await mount('session-select', 'dsh', true)
  h.role.sessions[1].driverSessionId = 'native-b'
  h.view.work.b = { active: true }
  h.rail().onSelectSession(h.role, 'b')
  assert.deepEqual(h.opened, ['native-b'])
  assert.equal(h.space().nodoSession, 'native-b')
  assert.equal(h.rail().sessionId, 'b')
  assert.equal(h.calls.some(call => call.endpoint === 'session-open'), false, 'viewing must not reopen a running engine')
  assert.equal(h.rail().busy, false)
  h.requests.get('b').resolve()
  await tick()
  assert.deepEqual(h.opened, ['native-b'])
})

test('a failed selection write does not hide the running conversation', async () => {
  const h = await mount('session-select', 'zcode', true)
  h.view.work.b = { active: true }
  h.rail().onSelectSession(h.role, 'b')
  h.requests.get('b').reject(new Error('selection write failed'))
  await tick()
  assert.equal(h.rail().sessionId, 'b')
  assert.equal(h.space().legacy, true)
  assert.ok(h.render().some(node => node.props.role === 'alert' && node.children.includes('selection write failed')))
})
