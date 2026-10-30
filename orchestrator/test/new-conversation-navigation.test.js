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
    workspaces: [{ id: 'main', cwd: '/main' }, { id: 'branch', cwd: '/branch' }], work: {}, stats: {}, prefs: { onboardedAt: 1 },
  }
  const views = { sidebar: clone(server), draft: clone(server) }
  const storage = new Map([['nodo.navigation', JSON.stringify({ profile: 'a', workspace: 'main', sessions: { 'main:a': 'a-main' } })]])
  const cells = {}, effects = [], listeners = new Set(), calls = [], opened = [], panels = [], bindings = []
  let instance, cursor, selected = 'native-a-main'
  const shared = {
    nativeSpace: {},
    NewConversation: 'NewConversation',
    rightPanelService: { bind: target => { bindings.push(clone(target)); return () => bindings.push(null) } },
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
  const effect = (run, deps) => {
    const slots = cells[instance], at = cursor++
    if (!(at in slots) || deps.some((value, index) => !Object.is(value, slots[at][index]))) effects.push(run)
    slots[at] = deps
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
      useEffect: effect, useLayoutEffect: effect,
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
  return { loaded, server, views, space, calls, opened, panels, sidebar, composer, bindings, storage,
    welcome: props => render('welcome', NewConversation, props),
    addMenu: props => render('add-menu', loaded.AddMenu, props)[0],
    page: () => render('page', loaded.NodoPage, { contentOnly: true }),
    content: () => render('content', loaded.NodoPage, { contentOnly: true }).find(node => node.type === loaded.Feed).props }
}

test('a new conversation displays the role tier and keeps explicit draft permission choices', async () => {
  const h = await harness('codex', 'a', 'main')
  const role = h.views.draft.profiles[0]
  role.permission = 'workspace'
  role.sessions.at(-1).permission = 'plan'
  assert.equal(h.composer().profile.permission, 'workspace', 'the last session does not seed the draft')
  const menu = h.addMenu({ profile: h.composer().profile, trigger: null, disabled: false, onModelChange: h.composer().onModelChange })
  menu.props.onSelect('plan')
  assert.equal(h.composer().profile.permission, 'plan', '/计划 toggles from the displayed role tier')
  h.composer().onChange('task')
  await h.composer().onSend()
  assert.equal(h.calls.find(call => call.endpoint === 'session-create').choices.permission, 'plan')
})

test('Team new conversations and their role picker are limited to lead roles', async () => {
  const h = await harness('codex', 'a', 'main')
  for (const view of Object.values(h.views)) view.profiles[0].lead = true
  h.loaded.setNavigation(current => ({ ...current, view: 'team' }))
  h.sidebar().onNewSession('b', h.views.sidebar.workspaces[0])
  assert.equal(h.space.getSnapshot().draft.profile, 'a')
  assert.deepEqual(clone(h.composer().rolePicker.props.profiles.map(role => role.id)), ['a'])
  h.loaded.setNavigation(current => ({ ...current, view: 'sessions' }))
  assert.deepEqual(clone(h.composer().rolePicker.props.profiles.map(role => role.id)), ['a', 'b'])
})

for (const engine of ['codex', 'dsh']) for (const target of [
  { profile: 'a', workspace: 'main', label: 'the same role and project' },
  { profile: 'b', workspace: 'main', label: 'another recipient' },
  { profile: 'a', workspace: 'branch', label: 'another project' },
]) test(`${engine} first send selects the new conversation for ${target.label} while the sidebar view lags`, async () => {
  const h = await harness(engine, target.profile, target.workspace)
  h.composer().onChange('new task')
  assert.deepEqual(h.bindings.at(-1), { workspace: target.workspace, cwd: `/${target.workspace}` })
  assert.equal(h.calls.length, 0, 'the welcome page never precreates a session')
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
    assert.deepEqual(h.bindings.at(-1), { profile: target.profile, session: 'new-session', cwd: `/${target.workspace}` })
    assert.equal(h.panels.at(-1), 'nodo')
  }
  h.views.sidebar = clone(h.server)
  assert.equal(h.sidebar().sessionId, 'new-session', 'the refreshed rail selects the same new conversation')
})

test('only draft welcomes bind a selected project; legacy empty and native views keep their original content', async () => {
  const h = await harness('dsh', undefined, 'main')
  h.views.welcome = clone(h.server)
  h.views.welcome.profiles = []
  h.welcome({ draft: h.space.getSnapshot().draft })
  assert.deepEqual(h.bindings, [{ workspace: 'main', cwd: '/main' }])
  assert.deepEqual(h.calls, [])
  h.views.page = clone(h.views.welcome)
  h.space.showLegacy()
  const page = h.page()
  assert.equal(page.some(node => node.type === 'NewConversation'), false)
  assert.ok(page.some(node => node.props.className === 'nodo-empty'))
  assert.ok(page.some(node => node.children?.includes('选择一个角色')))
  assert.deepEqual(h.bindings.at(-1), { workspace: 'main', cwd: '/main' })
  const bound = h.bindings.length
  h.views.welcome = clone(h.server)
  h.welcome({ sourceSessionId: 'native-a-main' })
  assert.equal(h.bindings.length, bound, 'NativeWelcome keeps the host sidebar')
  h.space.open('native-a-main')
  h.welcome({})
  assert.equal(h.bindings.length, bound, 'the native conversation view never binds Nodo tools')
  h.views.welcome.workspaces = []
  h.space.showLegacy()
  h.welcome({})
  assert.equal(h.bindings.length, bound, 'no selected project means no sidebar')
  assert.equal(h.storage.get('nodo.draft-options'), undefined)
  assert.equal(Object.hasOwn(JSON.parse(h.storage.get('nodo.drafts')), 'new:undefined'), false)
})

test('legacy session shells keep project drafts separate and bind the new conversation only after send', async () => {
  const h = await harness('codex', 'a', 'main')
  h.space.showLegacy()
  h.views.page = clone(h.server)
  for (const role of h.views.page.profiles) role.sessions = []
  for (const project of ['main', 'branch']) {
    h.loaded.setNavigation({ profile: 'a', workspace: project, sessions: {} })
    const page = h.page()
    assert.equal(page.some(node => node.type === 'NewConversation'), false)
    assert.ok(page.some(node => node.props.className === 'nodo-conversation'))
    assert.deepEqual(h.bindings.at(-1), { workspace: project, cwd: `/${project}` })
    const composer = page.find(node => node.type === h.loaded.Composer).props
    composer.onChange(`${project} draft`)
    h.page()
  }
  assert.deepEqual(JSON.parse(h.storage.get('nodo.drafts')), { 'new:main:a': 'main draft', 'new:branch:a': 'branch draft' })
  assert.equal(h.storage.get('nodo.draft-options'), undefined)
  assert.deepEqual(h.calls, [], 'no session is precreated by rendering or editing either project')
  h.page().find(node => node.type === h.loaded.Composer).props.onSend()
  await tick()
  assert.equal(h.calls.filter(call => call.endpoint === 'session-create').length, 1)
  h.views.page = clone(h.server)
  h.page()
  assert.deepEqual(h.bindings.at(-1), { profile: 'a', session: 'new-session', cwd: '/branch' })
  assert.equal(Object.hasOwn(JSON.parse(h.storage.get('nodo.drafts')), 'new:undefined'), false)
})
