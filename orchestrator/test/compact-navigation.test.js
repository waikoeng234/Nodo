import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))

async function mount() {
  const slots = [], calls = [], requests = new Map()
  let cursor = 0
  let navigation = { profile: 'role', workspace: 'workspace', sessions: { 'workspace:role': 'a' } }
  const role = { id: 'role', name: 'Role', engine: 'zcode', workspaceId: 'workspace', activeSessionId: 'a',
    sessions: ['a', 'b'].map(id => ({ id, name: id, workspaceRef: 'workspace' })) }
  const view = { profiles: [role], workspaces: [{ id: 'workspace' }], work: {}, stats: {}, approvals: [] }
  // selectSession compares snapshots by identity to detect navigation away.
  const space = { active: true, legacy: true }
  const loaded = await loadClient(['page.js', 'session-rail.js', 'composer.js', 'feed.js', 'running.js', 'run-cards.js', 'role-seat.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      readNavigation: () => navigation, subscribeNavigation() {},
      setNavigation: update => { navigation = update(navigation) },
      nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy() {} },
      readNativeSession: () => null, subscribeNativeSession() {},
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      openNativeSession: null,
      runningOf: () => ({ active: false }),
      workLabel: () => '', sessionTime: () => '',
      call: async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        if (endpoint !== 'session-compact') return undefined
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
  const render = () => { cursor = 0; return nodes(loaded.NodoPage()) }
  return { loaded, view, role, calls, requests, render,
    composer: () => render().find(node => node.type === loaded.Composer).props,
    rail: () => render().find(node => node.type === loaded.Rail).props }
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
