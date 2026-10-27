import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const clone = value => JSON.parse(JSON.stringify(value))
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))

async function harness(engine, profile, workspace) {
  const server = {
    profiles: ['a', 'b'].map(id => ({ id, name: id, engine, activeSessionId: `${id}-main`, sessions: ['main', 'branch'].map(project =>
      ({ id: `${id}-${project}`, name: `${id}-${project}`, engine, workspaceRef: project, driverSessionId: `native-${id}-${project}` })) })),
    workspaces: [{ id: 'main' }, { id: 'branch' }], work: {}, stats: {}, prefs: { onboardedAt: 1 },
  }
  const views = { sidebar: clone(server), draft: clone(server) }
  const storage = new Map([['nodo.navigation', JSON.stringify({ profile: 'a', workspace: 'main', sessions: { 'main:a': 'a-main' } })]])
  const cells = {}, effects = [], listeners = new Set(), calls = [], opened = [], panels = []
  let instance, cursor, selected = 'native-a-main'
  const shared = {
    nativeSpace: {},
    useStateView: () => ({ view: views[instance], error: '', refresh: async () => {} }),
    subscribeNativeSession() {}, readNativeSession: () => selected,
    completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
    call: async (endpoint, payload) => {
      calls.push({ endpoint, ...clone(payload) })
      if (endpoint === 'session-create') {
        const role = server.profiles.find(role => role.id === payload.profile)
        const session = { id: 'new-session', name: 'new task', engine, workspaceRef: payload.workspace }
        role.sessions.push(session)
        role.activeSessionId = session.id
        return session
      }
      if (endpoint === 'session-open') return { conversationId: payload.session, sessionId: 'native-new' }
      if (endpoint === 'send') return { mode: 'turn' }
      throw new Error(`Unexpected ${endpoint}`)
    },
  }
  const loaded = await loadClient(['new-conversation.js', 'page.js', 'native-space.js', 'composer.js', 'feed.js', 'session-rail.tsx'], {
    uiShared: shared,
    react: {
      useState(initial) {
        const slots = cells[instance], at = cursor++
        if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
        return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
      },
      useRef(initial) { const slots = cells[instance], at = cursor++; return slots[at] ??= { current: initial } },
      useEffect(effect, deps) {
        const slots = cells[instance], at = cursor++
        if (!(at in slots) || deps.some((value, index) => !Object.is(value, slots[at][index]))) effects.push(effect)
        slots[at] = deps
      },
    },
    globals: {
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      crypto: { randomUUID: () => 'draft-id' },
      document: { querySelector: () => null, visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    },
  })
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready', byId: {} }), subscribe: () => () => {} },
      using: async (_id, _options, callback) => callback({ ready: Promise.resolve({ session: { prompt: async () => ({ ok: true }) } }) }),
    },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: selected }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } } },
    uiWorkspace: { openSession(id) { opened.push(id); selected = id; panels.push(null); for (const listener of listeners) listener() } },
    layout: { selectPanel: id => panels.push(id) }, slots: { inject() {} }, effect: run => run(),
  }
  const space = loaded.createNativeSpace(ctx, () => null)
  Object.assign(shared.nativeSpace, space)
  space.enter()
  space.startDraft({ profile, workspace })
  const draft = space.getSnapshot().draft
  const { NewConversation } = loaded.createNewConversation(ctx, space, 'ReferenceDialog')
  const render = (name, component, props) => {
    instance = name; cursor = 0; cells[name] ??= []
    const tree = nodes(component(props))
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const sidebar = () => render('sidebar', loaded.NodoPage, { sidebarOnly: true }).find(node => node.type === loaded.Rail).props
  const composer = () => render('draft', NewConversation, { draft }).find(node => node.type === loaded.Composer).props
  sidebar()
  return { loaded, server, views, space, calls, opened, panels, sidebar, composer,
    content: () => render('content', loaded.NodoPage, { contentOnly: true }).find(node => node.type === loaded.Feed).props }
}

for (const engine of ['codex', 'dsh']) for (const target of [
  { profile: 'a', workspace: 'main', label: 'the same role and project' },
  { profile: 'b', workspace: 'main', label: 'another recipient' },
  { profile: 'a', workspace: 'branch', label: 'another project' },
]) test(`${engine} first send selects the new conversation for ${target.label} while the sidebar view lags`, async () => {
  const h = await harness(engine, target.profile, target.workspace)
  h.composer().onChange('new task')
  h.composer().onSend()
  await tick()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-create').length, 1)
  assert.equal(h.calls.some(call => call.endpoint === (engine === 'dsh' ? 'session-open' : 'send')), true)
  assert.equal(h.space.getSnapshot().draft, undefined)
  h.sidebar()
  assert.equal(h.loaded.readNavigation().sessions[`${target.workspace}:${target.profile}`], 'new-session',
    'the stale sidebar must not replace the explicit new-session selection with its fallback')
  if (engine === 'dsh') {
    assert.deepEqual(h.opened, ['native-new'])
    assert.equal(h.space.getSnapshot().nodoSession, 'native-new')
    assert.equal(h.panels.at(-1), null)
  } else {
    h.views.content = clone(h.server)
    assert.equal(h.space.getSnapshot().legacy, true)
    assert.equal(h.content().session.id, 'new-session', 'the main area shows the conversation that received the first message')
    assert.equal(h.panels.at(-1), 'nodo')
  }
  h.views.sidebar = clone(h.server)
  assert.equal(h.sidebar().sessionId, 'new-session', 'the refreshed rail selects the same new conversation')
})
