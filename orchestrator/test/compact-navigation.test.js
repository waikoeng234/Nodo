import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPanelSource } from './helpers/client-source.js'
import { createContext, Script } from 'node:vm'

const source = readPanelSource()
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))

function mount() {
  const slots = [], calls = [], requests = new Map()
  let cursor = 0
  let navigation = { profile: 'role', workspace: 'workspace', sessions: { 'workspace:role': 'a' } }
  const role = { id: 'role', name: 'Role', engine: 'zcode', workspaceId: 'workspace', activeSessionId: 'a',
    sessions: ['a', 'b'].map(id => ({ id, name: id, workspaceRef: 'workspace' })) }
  const view = { profiles: [role], workspaces: [{ id: 'workspace' }], work: {}, stats: {}, approvals: [] }
  // selectSession compares snapshots by identity to detect navigation away.
  const space = { active: true, legacy: true }
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useRef(initial) { const slot = cursor++; return slots[slot] ??= { current: initial } },
    useEffect() {}, useSyncExternalStore: (_subscribe, read) => read(),
    useStateView: () => ({ view, refresh: async () => {} }),
    readNavigation: () => navigation, subscribeNavigation() {},
    setNavigation: update => { navigation = update(navigation) },
    nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy() {} },
    readNativeSession: () => null, subscribeNativeSession() {},
    completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
    document: { visibilityState: 'visible', hasFocus: () => true },
    readDrafts: () => ({}), heldImages: {}, openNativeSession: null,
    runningOf: () => ({ active: false }),
    workLabel: () => '', sessionTime: () => '',
    ...Object.fromEntries(['Rail', 'Composer', 'Feed', 'RunningLine', 'ApprovalCard', 'SessionStats', 'RoleAvatar', 'RolePicker', 'Menu', 'Fragment', 'OnboardingDialog'].map(name => [name, name])),
    ...Object.fromEntries([...new Set([...source.matchAll(/\bIcon[A-Za-z]+(?:Regular|Medium)\b/g)].map(match => match[0]))].map(name => [name, name])),
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint !== 'session-compact') return undefined
      const request = Promise.withResolvers()
      requests.set(payload.session, request)
      return request.promise
    },
  })
  new Script(source.slice(source.indexOf('const nativeRole ='), source.indexOf('\nfunction PanelIcon('))).runInContext(context)
  new Script(source.slice(source.indexOf('function SessionRow('), source.indexOf('\nfunction Rail('))).runInContext(context)
  new Script(source.slice(source.indexOf('const RUN_STATUS ='), source.indexOf('\nfunction RunDetail('))).runInContext(context)
  const render = () => { cursor = 0; return nodes(context.NodoPage()) }
  return { context, view, role, calls, requests, render,
    composer: () => render().find(node => node.type === 'Composer').props,
    rail: () => render().find(node => node.type === 'Rail').props }
}

test('a pending compact leaves session navigation available and locks only that session composer', async () => {
  const h = mount()
  h.composer().onCompact()
  assert.equal(h.requests.has('a'), true)
  assert.equal(h.composer().busy, true)
  h.composer().onCompact()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-compact').length, 1)
  const rail = h.rail()
  assert.equal(rail.busy, false)
  for (const session of h.role.sessions) {
    const row = h.context.SessionRow({ role: h.role, session, busy: rail.busy, work: { active: session.id === 'a' } })
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
  const h = mount()
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
