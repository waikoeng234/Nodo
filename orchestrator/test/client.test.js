// Exercise the browser's classic-script boundary; Node ESM parsing alone does
// not catch export declarations accidentally placed inside the loader factory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { loadClient } from './helpers/client-module.js'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'

const clientSource = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

const bundleURL = new URL('../client.js', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// The two module-table words the shell seeds for every client plugin: React
// itself and the shared UI kit (Menu/Modal/Button/Tooltip/icons) the native
// packages require as well.
const SEEDED = ['react', '@deepseek-ai/dsh-client-ui-primitives']

const load = (globals = {}) => {
  const registrations = []
  const context = createContext({
    window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
    ...globals,
  })
  new Script(readFileSync(bundleURL, 'utf8'), { filename: 'client.js' }).runInContext(context)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, manifest.name)
  const requested = []
  const entry = registrations[0].factory((name) => {
    requested.push(name)
    assert.ok(SEEDED.includes(name), `only shell-seeded modules may be required, got ${name}`)
    // Any export materializes as a component stand-in; the kit is the host's.
    return new Proxy({ createElement: (...args) => args }, { get: (target, key) => target[key] ?? (() => key) })
  })
  assert.deepEqual(requested, SEEDED)
  return entry
}

test('client registers as a classic script and exposes the plugin entry lazily', () => {
  // No DOM or network globals: registration and materialization must be inert.
  const entry = load()
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject))
  assert.deepEqual(Array.from(entry.inject), ['slots', 'uiWorkspace', 'uiSession', 'sessions', 'layout', 'modelDirectories', 'remote', 'remote.session', 'commandUi', 'inputTriggers', 'conversation'])
  assert.equal(Object.prototype.toString.call(entry), '[object Module]')
})

test('client registers matching sidebar/main seats after the shell declares them and cleans up', () => {
  const styles = []
  const registrations = []
  const pending = new Map()
  const disposers = []
  const listeners = new Set(), attributes = new Set()
  const document = {
    createElement: tag => ({ tag, removed: false, remove() { this.removed = true } }),
    head: { appendChild: node => styles.push(node) },
    documentElement: { toggleAttribute: (name, on) => on ? attributes.add(name) : attributes.delete(name), removeAttribute: name => attributes.delete(name) },
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
  }
  const entry = load({ document, fetch: () => { throw new Error('page must stay lazy until selected') } })
  entry.apply({
    effect(factory) { disposers.push(factory()) },
    layout: { toggleSidebar() {} },
    uiSession: { adapter: { current: { getSnapshot: () => ({}), subscribe: () => () => {} } } },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }), subscribe: () => () => {} } },
    slots: {
      inject(name, factory) { pending.set(name, factory) },
      register(options, component) {
        const row = { options, component }
        registrations.push(row)
        return () => registrations.splice(registrations.indexOf(row), 1)
      },
    },
  })
  assert.equal(registrations.length, 0, 'wait for the shell-owned slot declarations')
  assert.deepEqual([...pending.keys()], ['sidebar', 'conversation.input.model', 'conversation.input.right', 'rightbar', 'shell.overlay', 'conversation.input.dock', 'conversation.chat.node', 'main', 'main.conversation', 'sidebar.panellist'])
  for (const factory of pending.values()) disposers.push(factory())
  const page = registrations.find(row => row.options.name === 'main')
  const nav = registrations.find(row => row.options.name === 'sidebar.panellist')
  const seat = registrations.find(row => row.options.name === 'conversation.input.model')
  assert.equal(seat, undefined, 'ordinary space must keep the native model picker')
  assert.equal(page.options.key, 'nodo')
  assert.equal(nav.options.id, page.options.key)
  assert.equal(nav.options.label, 'Nodo')
  assert.equal(nav.options.order, 1, 'Plugins has order 0; Nodo follows it')
  assert.equal(typeof page.component, 'function')
  assert.equal(typeof nav.component, 'function')
  const css = styles[0].textContent
  assert.ok(css.includes('.nodo-page'))
  assert.ok(css.includes('.nodo-rail'), 'the page owns a sidebar rail')
  assert.ok(css.includes('.nodo-composer'), 'the page owns a composer')
  assert.ok(css.includes('.nodo-welcome'), 'the native space owns its blank-session welcome')
  assert.ok(!css.includes('position:fixed'))
  // The page may only style itself through the host theme: theme tokens carry
  // light/dark and every font-size setting, literals would freeze one theme.
  assert.match(css, /--dsw-specific-sidebar-fill/)
  assert.match(css, /--dsw-radius-panel/)
  assert.match(css, /--dsh-chat-content-width/)
  assert.equal(/(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(css), false, 'theme tokens instead of literal colors')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'])
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(styles[0].removed, true)
  assert.equal(registrations.length, 0)
  assert.equal(listeners.size, 0, 'the scroll listener leaves with the plugin')
  assert.equal(attributes.size, 0)
})

test('the conversation frame paints its border above the transcript and keeps its background below', async () => {
  const { CSS } = await loadClient('styles.js')
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  const column = 'html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])'
  const geometry = rule(`${column}::before,${column}::after`)
  assert.match(geometry, /inset:var\(--dsh-frame-top-clearance,0px\) 0 0/, 'both layers start at the content frame edge')
  assert.match(geometry, /pointer-events:none/, 'the foreground stroke leaves controls clickable')
  assert.equal(rule(`${column}::before`), 'z-index:-1;background:var(--dsw-alias-bg-base)')
  assert.equal(rule(`${column}::after`), 'z-index:1;border:var(--nodo-card-edge);border-left:0')
  assert.match(rule('.nodo-head'), /min-height:var\(--dsh-frame-top-clearance,0px\)/)
  assert.match(rule('.nodo-feedwrap'), /flex:1;min-height:0/, 'the feed retains the existing space below the header')
  assert.match(rule('.nodo-feed'), /overflow-y:auto/, 'the inner feed remains the scroll owner')
})

test('tool rows preserve separate input and output for concurrent calls with the same name', async () => {
  const { transcriptRows, ProcessRow, ToolCall } = await loadClient(['feed.js', 'tool-call.tsx'], {
    uiShared: { DisclosureRow: 'DisclosureRow', TOOL_VARIANTS: { generic: { icon: () => 'icon' } } },
    react: { useState: () => [false, () => {}] },
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
  })
  const rows = transcriptRows([
    { kind: 'tool', name: 'Read', callId: 'a', phase: 'start', input: 'A input', brief: 'read A' },
    { kind: 'tool', name: 'Read', callId: 'b', phase: 'start', input: 'B input' },
    { kind: 'tool', name: 'Read', callId: 'b', phase: 'end', output: 'B output', isError: true },
    { kind: 'tool', name: 'Read', callId: 'a', phase: 'end', output: 'A output' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].item.input, 'A input')
  assert.equal(rows[0].item.output, 'A output')
  assert.equal(rows[0].error, false)
  assert.equal(rows[1].item.output, 'B output')
  assert.equal(rows[1].error, true)
  const rendered = ProcessRow({ kind: 'tool', input: rows[0].item.input, output: rows[0].item.output })
  assert.equal(rendered.type, ToolCall)
  assert.equal(rendered.props.open, false)
  assert.equal(rendered.props.status, 'done')
  const sections = rendered.props.children.children
  assert.deepEqual(sections.map(section => section.children[0].children[0]), ['输入', '输出'])
  assert.deepEqual(sections.map(section => section.children[1].children[0]), ['A input', 'A output'])
  const live = ProcessRow({ kind: 'tool', title: 'Read', input: 'A input',
    progress: { elapsedMs: 1200, stdoutTail: 'tail fixture', stdoutBytes: 4 } })
  const text = JSON.stringify(live)
  assert.match(text, /已用时 1\.2 秒/)
  assert.match(text, /stdout 4 B/)
  assert.match(text, /stdout（尾部）/)
  const merged = transcriptRows([
    { kind: 'tool', name: 'Read', callId: 'p', phase: 'start', input: 'input', progress: { elapsedMs: 5 } },
    { kind: 'tool', name: 'Read', callId: 'p', phase: 'end', output: 'output' },
  ])
  assert.deepEqual(merged[0].item.progress, { elapsedMs: 5 }, 'the running progress survives the end merge for display')
})

test('plan rows rewrite in place, clear when removed, and subagent rows merge by entity id', async () => {
  const { transcriptRows, PlanRow } = await loadClient('feed.js', {
    uiShared: { DisclosureRow: 'DisclosureRow', TOOL_VARIANTS: { generic: { icon: () => 'icon' }, plan: { icon: () => 'icon' }, task: { icon: () => 'icon' } } },
    react: { useState: () => [false, () => {}] },
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
  })
  const rows = transcriptRows([
    { who: 'agent', kind: 'plan', text: 'Fix it', steps: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }] },
    { who: 'agent', kind: 'tool', name: 'task', callId: 'task-1', phase: 'start', brief: 'Research' },
    { who: 'agent', kind: 'tool', name: 'task', callId: 'task-1', phase: 'end', output: 'child two done', isError: true },
  ])
  assert.equal(rows.length, 2)
  const plan = PlanRow({ plan: rows[0].item, running: true })
  assert.equal(plan.props.title, '计划')
  assert.equal(plan.props.running, true)
  assert.match(JSON.stringify(plan.props.collapsedContent), /two/, 'the running step is the summary')
  const list = plan.props.children
  assert.equal(list.props.className, 'nodo-plan-list')
  assert.deepEqual(list.children.map(child => child.props['data-status']), ['completed', 'in_progress'])
  const merged = rows[1]
  assert.equal(merged.running, false)
  assert.equal(merged.error, true)
  assert.equal(merged.item.output, 'child two done')
  assert.equal(transcriptRows([{ who: 'agent', kind: 'plan', text: '', steps: [], removed: true }]).length, 0,
    'a cleared plan leaves no row behind')
  const textPlan = PlanRow({ plan: { who: 'agent', kind: 'plan', text: '# Steps' }, running: false })
  assert.equal(textPlan.props.expandable, true, 'a markdown-form plan has no steps but a real body to expand')
  assert.equal(textPlan.props.children.props.className, 'nodo-plan-text')
})

test('committed client bundle matches its source', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-client.mjs', import.meta.url)), '--check'])
})

test('source parent ids render bounded nesting within one turn and activities have their own count', async () => {
  const { transcriptRows, ProcessGroup } = await loadClient('feed.js', {
    primitives: { IconSparkleRegular: () => 'icon' },
    react: { useState: () => [false, () => {}] },
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
  })
  const rows = transcriptRows([
    { who: 'user', text: 'first' },
    { kind: 'tool', callId: 'child', phase: 'start', activity: true },
    { kind: 'tool', callId: 'parent', phase: 'start', activity: true },
    { kind: 'tool', callId: 'child', phase: 'end', parentCallId: 'parent', output: 'done' },
    { kind: 'tool', callId: 'grandchild', phase: 'end', parentCallId: 'child', activity: true },
    { kind: 'tool', callId: 'orphan', phase: 'end', parentCallId: 'missing', activity: true },
    { who: 'user', text: 'second' },
    { kind: 'tool', callId: 'next', phase: 'end', parentCallId: 'parent' },
    { kind: 'tool', callId: 'a', phase: 'end', parentCallId: 'b' },
    { kind: 'tool', callId: 'b', phase: 'end', parentCallId: 'a' },
  ])
  assert.equal(rows.find(row => row.item.callId === 'child').depth, 1, 'late parent ids survive the end merge')
  assert.equal(rows.find(row => row.item.callId === 'grandchild').depth, 2)
  assert.equal(rows.find(row => row.item.callId === 'orphan').depth, 0)
  assert.equal(rows.find(row => row.item.callId === 'next').depth, 0, 'parents do not cross user turns')
  assert.equal(rows.find(row => row.item.callId === 'a').depth, 0, 'a cycle cannot invent a hierarchy')
  assert.ok(rows.every(row => !row.depth || row.depth <= 8), 'cycles cannot grow indentation indefinitely')
  const group = ProcessGroup({ rows: [{ kind: 'thinking' }, { kind: 'tool', activity: true }, { kind: 'tool' }, { kind: 'plan' }] })
  assert.equal(group.props.summary, '思考 1 · 工具 1 · 子任务 1 · 计划 1')
})

test('conversation selection restores its records without creating a new draft', async () => {
  let handleCall = async () => {}
  const { createNativeSpace, createNativeWelcome, setHostServices, selectSession, startConversation } = await loadClient(
    ['native-space.js', 'native-welcome.js', 'ui-shared.js', 'page.js'], {
      globals: { localStorage: { getItem: () => null, setItem() {} }, document: { querySelector: () => null }, crypto: { randomUUID: () => 'draft' } },
      call: (...args) => handleCall(...args),
    })
  for (const scenario of [
    { engine: 'zcode', transcript: [{ who: 'user', text: 'Task' }], legacy: true },
    { engine: 'codex', transcript: [{ who: 'user', text: 'Task' }, { who: 'agent', kind: 'text', text: 'Reply' }], legacy: true },
    { engine: 'claude', transcript: [{ who: 'user', text: 'Task' }], legacy: true, readOnly: true },
    { engine: 'zcode', transcript: [], legacy: true },
    { engine: 'opencode', transcript: [{ who: 'system', kind: 'note', text: 'closed' }], legacy: true },
    { engine: 'dsh', transcript: [{ who: 'user', text: 'Task' }], legacy: false },
    { engine: 'qoder', transcript: [{ who: 'user', text: 'Task' }], legacy: true },
    { engine: 'qoder', hosted: true, transcript: [{ who: 'user', text: 'Task' }], legacy: true },
    { engine: 'zcode', fresh: true, transcript: [], legacy: true },
    { engine: 'zcode', restore: true, transcript: [], legacy: true },
    { engine: 'zcode', hosted: true, transcript: [{ who: 'user', text: 'Task' }], legacy: true },
    { engine: 'codex', draft: true, transcript: [{ who: 'user', text: 'Old task' }], legacy: true },
    { engine: 'codex', draft: true, transcript: [], legacy: true },
  ]) {
    const calls = [], remembered = [], opened = [], panels = []
    const errors = [], busy = []
    const current = { key: 'blank-twin' }
    let welcomes = 0
    handleCall = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'transcript') return scenario.transcript
      if (endpoint === 'session-open') return { sessionId: 'native', conversationId: 'conversation' }
    }
    const ctx = {
      slots: { inject() {}, register() { welcomes++; return () => { welcomes-- } } }, effect() {},
      sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { 'blank-twin': { blank: true } } }), subscribe: () => () => {} } },
      uiSession: { adapter: { current: { getSnapshot: () => current, subscribe: () => () => {} } } },
      uiWorkspace: { openSession: id => { opened.push(id); panels.push(null) } },
      layout: { selectPanel: id => panels.push(id) },
    }
    const space = createNativeSpace(ctx, () => null)
    space.enter()
    const disposeWelcome = createNativeWelcome(ctx, space, () => null)()
    assert.equal(welcomes, 1)
    if (scenario.draft) space.startDraft({ workspace: 'branch' })
    setHostServices({ nativeSpace: space, openNativeSession: id => space.open(id) })
    const page = {
      workspace: { id: 'branch' }, busy: false, workspaces: [{ id: 'branch' }],
      navigation: { sessions: { 'branch:role': 'conversation' } },
      sidebarOnly: true, readOnly: scenario.readOnly === true,
      setBusy: value => busy.push(value), setActionError: value => { if (value) errors.push(value) }, setEditing() {},
      remember: (...args) => remembered.push(args), refresh: async () => {},
    }
    const role = { id: 'role', engine: scenario.engine, activeSessionId: 'other', sessions: scenario.restore ? [
      { id: 'other', workspaceRef: 'main' }, { id: 'conversation', workspaceRef: 'branch' },
      { id: 'newer', workspaceRef: 'branch', updatedAt: 10 },
    ] : scenario.hosted ? [{ id: 'conversation', workspaceRef: 'branch', nativeSessionId: 'native' }] : [] }
    await selectSession(role, scenario.fresh || scenario.restore ? undefined : 'conversation', undefined, page)
    assert.deepEqual(errors, [])
    assert.deepEqual(busy, [], 'session selection must not lock the entire page')
    assert.equal(space.getSnapshot().legacy, scenario.legacy)
    assert.equal(welcomes, scenario.legacy ? 0 : 1, 'dispatch records release the welcome overlay')
    assert.deepEqual(remembered.at(-1), scenario.fresh ? ['role', 'branch'] : ['role', 'branch', 'conversation'])
    assert.deepEqual(opened, scenario.legacy ? [] : ['native'])
    assert.equal(panels.at(-1), scenario.legacy ? 'nodo' : null)
    assert.equal(calls.some(call => call.endpoint === 'session-select'), scenario.legacy && !scenario.readOnly && !scenario.fresh)
    assert.ok(calls.every(call => ['session-open', 'session-select'].includes(call.endpoint)), 'viewing must not send, stop or recreate the engine task')
    if (scenario.fresh) {
      assert.deepEqual(calls, [], 'selecting an empty role must not persist a draft or open an engine session')
      startConversation(role.id, page)
      assert.deepEqual(calls, [], 'new conversation opens an unbound local draft without creating a role session')
      assert.equal(space.getSnapshot().draft.profile, role.id)
      assert.equal(space.getSnapshot().legacy, false)
    }
    disposeWelcome()
    assert.equal(welcomes, 0)
  }
})

test('conversation controls allow next-turn settings while this or another session is running', async () => {
  const calls = []
  const view = { profiles: [{ id: 'role', engine: 'codex', model: 'm1', activeSessionId: 'conversation', sessions: [
    { id: 'conversation', workspaceRef: 'project' }, { id: 'sibling', workspaceRef: 'project' },
  ] }], workspaces: [{ id: 'project' }], work: { conversation: { active: true }, sibling: { active: true } }, stats: {}, prefs: { onboardedAt: 1 } }
  const loaded = await loadClient('page.js', {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => ({ active: true, legacy: true }) },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      subscribeNativeSession() {}, readNativeSession: () => null, runningOf: () => ({ active: true }),
      call: async (endpoint, payload) => { calls.push(JSON.parse(JSON.stringify({ endpoint, payload }))); return { id: 'role', activeSessionId: 'conversation' } },
    },
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: key => key === 'nodo.navigation'
        ? JSON.stringify({ profile: 'role', workspace: 'project', sessions: { 'project:role': 'conversation' } }) : null, setItem() {} },
    },
  })
  const all = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(all)] : []
  const render = () => { loaded.host.reset(); return all(loaded.NodoPage({ contentOnly: true })) }
  const composer = () => render().find(node => node.props?.onModelChange)
  assert.equal(composer().props.running, true)
  assert.equal(composer().props.modelDisabled, false)
  view.work.conversation = { active: false }
  assert.equal(composer().props.modelDisabled, false, 'another running session must not lock these controls')
  for (const changes of [{ permission: 'plan' }, { model: 'm2', thinking: 'high' }]) {
    await composer().props.onModelChange(changes)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls.at(-1), { endpoint: 'session-update', payload: { profile: 'role', session: 'conversation', changes } })
  }
  composer().props.onGoal()
  render().find(node => node.props?.key === 'goal:role').props.onSaved('Ship it')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.at(-1), { endpoint: 'profile-update', payload: { id: 'role', changes: { goal: 'Ship it' } } }, 'the goal stays a role setting')
})

test('role selection restores a conversation within the current workspace', async () => {
  const { sessionForWorkspace: choose } = await loadClient('page.js')
  const workspaces = [{ id: 'main', cwd: '/main' }, { id: 'branch', cwd: '/branch' }]
  const profile = { id: 'role', workspaceId: 'main', activeSessionId: 'main-active', sessions: [
    { id: 'main-active', workspaceRef: 'main', updatedAt: 100 },
    { id: 'old', workspaceRef: 'branch', updatedAt: 1 },
    { id: 'latest', cwd: '/branch', updatedAt: 2 },
    { id: 'archived', workspaceRef: 'branch', updatedAt: 200, archivedAt: 1 },
    { id: 'compat', updatedAt: 0 },
  ] }
  assert.equal(choose(profile, workspaces[1], workspaces, 'old').id, 'old')
  assert.equal(choose(profile, workspaces[1], workspaces).id, 'latest')
  assert.equal(choose(profile, workspaces[1], workspaces, 'archived').id, 'latest')
  profile.activeSessionId = 'old'
  assert.equal(choose(profile, workspaces[1], workspaces).id, 'old')
  assert.equal(choose(profile, workspaces[0], workspaces, 'compat').id, 'compat')
  assert.equal(choose(profile, { id: 'empty' }, workspaces), undefined)
  assert.equal(choose(null, workspaces[1], workspaces), undefined)
  assert.equal(choose(profile, null, workspaces), undefined)
})

test('sidebar initialization preserves an open new-conversation draft', async () => {
  const { openInitialSidebarSession, setHostServices } = await loadClient(['ui-shared.js', 'page.js'], { call: async () => {} })
  for (const engine of ['codex', 'custom']) {
    const calls = []
    const draft = { id: 'new-draft', workspace: 'project' }
    setHostServices({
      nativeSpace: { getSnapshot: () => ({ draft, drafting: true }), showLegacy: () => calls.push('legacy') },
      openNativeSession: null,
    })
    openInitialSidebarSession({
      sidebarOnly: true, initiallyOpened: { current: false }, profile: { id: 'role', engine },
      workspace: { id: 'project' }, sessionId: 'old-conversation', busy: false, workspaces: [], navigation: {},
      readOnly: false, remember() {}, refresh: async () => {}, setBusy() {}, setActionError() {}, setEditing() {},
    })
    assert.deepEqual(calls, [], `${engine} must not restore an old conversation over a draft`)
  }
})

test('NodoPage initializes its sidebar session after loading without replacing drafts or open sessions', async () => {
  for (const scenario of [
    { engine: 'codex', legacy: true }, { engine: 'dsh', native: true },
    { engine: 'codex', drafting: true }, { engine: 'dsh', drafting: true },
    { engine: 'dsh', nodoSession: 'already-open' },
    { engine: 'dsh', sidebarOnly: false },
  ]) {
    const cells = [], effects = [], cleanups = [], calls = [], opened = []
    let cursor = 0, view = null, legacy = 0, refreshed = 0
    const space = { active: true, legacy: false, drafting: scenario.drafting, nodoSession: scenario.nodoSession,
      ...(scenario.drafting ? { draft: { id: 'new-draft', workspace: 'branch' } } : {}) }
    const loaded = await loadClient('page.js', {
      uiShared: {
        useStateView: () => ({ view, refresh: async () => { refreshed++ } }),
        nativeSpace: { subscribe() {}, getSnapshot: () => space, showLegacy: () => { legacy++ } },
        completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
        subscribeNativeSession() {}, readNativeSession: () => null, runningOf: () => ({ active: false }),
        openNativeSession: id => opened.push(id),
        call: async (endpoint, payload) => {
          calls.push({ endpoint, payload: { ...payload } })
          return { sessionId: 'native', conversationId: 'selected' }
        },
      },
      react: {
        useState(initial) {
          const at = cursor++
          if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
          return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
        },
        useRef(initial) { const at = cursor++; return cells[at] ??= { current: initial } },
        useEffect(effect, deps) {
          const at = cursor++
          if (!(at in cells) || deps.some((value, index) => !Object.is(value, cells[at][index]))) effects.push(effect)
          cells[at] = deps
        },
      },
      globals: {
        document: { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
        window: { addEventListener() {}, removeEventListener() {} },
        localStorage: { getItem: key => key === 'nodo.navigation'
          ? JSON.stringify({ profile: 'role', workspace: 'branch', sessions: { 'branch:role': 'selected' } }) : null, setItem() {} },
      },
    })
    const render = async () => {
      cursor = 0
      loaded.NodoPage({ sidebarOnly: scenario.sidebarOnly !== false })
      for (const effect of effects.splice(0)) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    try {
      await render()
      assert.equal(legacy, 0, 'initialization waits for the view')
      assert.deepEqual(calls, [])
      view = { profiles: [{ id: 'role', engine: scenario.engine, activeSessionId: 'other', sessions: [
        { id: 'selected', workspaceRef: 'branch' }, { id: 'other', workspaceRef: 'main' },
      ] }], workspaces: [{ id: 'main' }, { id: 'branch' }], work: {}, stats: {}, prefs: { onboardedAt: 1 } }
      await render()
      assert.equal(legacy, scenario.legacy ? 1 : 0)
      assert.deepEqual(opened, scenario.native ? ['native'] : [])
      assert.deepEqual(calls, scenario.native ? [{ endpoint: 'session-open', payload: { profile: 'role', session: 'selected', workspace: 'branch' } }] : [])
      assert.equal(refreshed, scenario.native ? 1 : 0)
      assert.equal(loaded.readNavigation().sessions['branch:role'], 'selected')
      view = { ...view, profiles: view.profiles.map(profile => ({ ...profile, id: 'next-role' })) }
      loaded.setNavigation(current => ({ ...current, profile: 'next-role' }))
      await render()
      assert.equal(legacy, scenario.legacy ? 1 : 0, 'later role changes do not repeat initialization')
      assert.equal(calls.length, scenario.native ? 1 : 0)
    } finally { for (const cleanup of cleanups.reverse()) cleanup() }
  }
})

test('pending conversation selection cannot replace a newer draft or its opened native session', async () => {
  let handleCall = async () => {}
  const { selectSession, setHostServices } = await loadClient(['ui-shared.js', 'page.js'], { call: (...args) => handleCall(...args) })
  for (const endpoint of ['session-open', 'session-select']) for (const sent of [false, true]) {
    const calls = [], remembered = [], opened = [], errors = []
    let release, state = { active: true }
    const waiting = new Promise(resolve => { release = resolve })
    handleCall = async name => {
      calls.push(name)
      if (name === endpoint) await waiting
      if (name === 'transcript') return endpoint === 'session-open' ? [] : [{ who: 'user', text: 'Old task' }]
      if (name === 'session-open') return { sessionId: 'native-old', conversationId: 'old-conversation' }
    }
    setHostServices({
      nativeSpace: { getSnapshot: () => state, showLegacy: () => { calls.push('legacy'); state = { ...state, legacy: true, draft: undefined } } },
      openNativeSession: id => { opened.push(id); state = { ...state, nodoSession: id, draft: undefined } },
    })
    const page = {
      workspace: { id: 'project' }, busy: false, workspaces: [], navigation: {},
      sidebarOnly: true, readOnly: false,
      setBusy() {}, setEditing() {}, setActionError: value => { if (value) errors.push(value) },
      remember: (...args) => remembered.push(args), refresh: async () => {},
    }
    const role = { id: 'role', engine: endpoint === 'session-open' ? 'dsh' : 'codex', sessions: [] }
    const pending = selectSession(role, 'old-conversation', undefined, page)
    while (!calls.includes(endpoint)) await new Promise(resolve => setImmediate(resolve))
    state = { ...state, draft: { id: 'new-draft', workspace: 'project' }, drafting: true }
    if (sent) state = { ...state, draft: undefined, nodoSession: 'native-new' }
    const newer = state
    release()
    await pending
    assert.equal(state, newer, `${endpoint} completion must preserve the newer draft or native session`)
    assert.deepEqual(opened, [])
    assert.deepEqual(remembered, [])
    assert.deepEqual(errors, [])
    assert.equal(calls.at(-1), endpoint, 'stale selection must stop before further requests or navigation')
  }
})

test('sidebar status labels and role aggregation preserve concurrent native waits and final outcomes', async () => {
  const { workLabel, runningOf, workDot } = await loadClient('ui-shared.js')
  const role = { sessions: [{ id: 'one' }, { id: 'two' }] }
  const work = { one: { active: false, status: 'completed', finishedAt: 99 }, two: { active: true, status: 'waiting-question' } }
  assert.equal(workLabel(runningOf(role, work)), '等待回答')
  work.two = { active: true, status: 'waiting-approval' }
  assert.equal(workLabel(runningOf(role, work)), '等待审批')
  work.two = { active: false, status: 'stopped', finishedAt: 100 }
  assert.equal(workLabel(runningOf(role, work)), '已停止')
  work.two = { active: false, status: 'error', finishedAt: 101 }
  assert.equal(workLabel(runningOf(role, work)), '执行失败')
  work.two = { active: false, status: 'completed', finishedAt: 102 }
  assert.equal(workLabel(runningOf(role, work)), '已完成')
  assert.equal(workDot(work.two), 'done')
  work.one.seen = true
  work.two.seen = true
  assert.equal(workLabel(runningOf(role, work)), '', 'viewed completions leave no permanent badge')
  work.two.status = 'stopped'
  assert.equal(workLabel(runningOf(role, work)), '', 'a viewed stop leaves no permanent badge either')
  work.two.status = 'error'
  assert.equal(workLabel(runningOf(role, work)), '', 'a viewed failure leaves no permanent badge either')
  work.two = { active: true }
  assert.equal(workLabel(runningOf(role, work)), '运行中')
  work.two.suspect = true
  assert.equal(workLabel(runningOf(role, work)), '疑似卡住')
  assert.equal(workDot(work.two), 'warning')
  work.two.suspect = false
  assert.equal(workLabel(runningOf(role, work)), '运行中')
  assert.equal(workDot(work.two), 'ongoing')
  for (const [status, label] of [['waiting-approval', '等待审批'], ['waiting-question', '等待回答'], ['error', '执行失败'], ['completed', '已完成']]) {
    assert.equal(workLabel({ active: true, suspect: true, status }), label, 'explicit status takes precedence over suspicion')
  }
  assert.equal(workLabel({ active: true, suspect: true, seen: true }), '', 'seen states keep their label hidden')
})

test('a finished role label only counts sessions the current workspace lists', async () => {
  const { workLabel, roleStateOf } = await loadClient('ui-shared.js')
  const role = { id: 'role', workspaceId: 'bot', sessions: [
    { id: 'read', workspaceRef: 'bot' },
    { id: 'unread-bot', workspaceRef: 'bot' },
    { id: 'unread-test', workspaceRef: 'test' },
    { id: 'unread-archived', workspaceRef: 'bot', archivedAt: 1 },
  ] }
  const view = { workspaces: [{ id: 'bot', cwd: '/bot' }, { id: 'test', cwd: '/test' }], work: {
    read: { active: false, status: 'completed', finishedAt: 1, seen: true },
    'unread-bot': { active: false, status: 'completed', finishedAt: 2 },
    'unread-test': { active: false, status: 'completed', finishedAt: 3 },
    'unread-archived': { active: false, status: 'completed', finishedAt: 4 },
  } }
  assert.equal(workLabel(roleStateOf(role, view, { id: 'bot' })), '已完成',
    'the unread turn this workspace lists still badges the role')
  view.work['unread-bot'].seen = true
  assert.equal(workLabel(roleStateOf(role, view, { id: 'bot' })), '',
    'unread turns left in other projects and archived sessions leave no stranded label')
  assert.equal(workLabel(roleStateOf(role, view, { id: 'test' })), '已完成',
    'the other project shows the badge its own session list can retire')
  view.work['unread-test'].active = true
  view.work['unread-test'].status = 'running'
  assert.equal(workLabel(roleStateOf(role, view, { id: 'bot' })), '运行中',
    'a run or wait anywhere stays a global label')
})

// The settings dialog's primary action sits in the modal footer, so it reaches
// the form in the body only through the form attribute: without that binding the
// button saves nothing and no render check would notice.
test('the settings dialog keeps its footer action bound to its own form', () => {
  const source = clientSource('engine-settings.js')
  const start = source.indexOf('function EngineSettingsDialog(')
  assert.ok(start > 0, 'the settings dialog exists')
  const dialog = source.slice(start, source.indexOf('\nfunction ', start + 1))
  assert.match(dialog, /h\(Modal, \{/)
  assert.match(dialog, /key: 'run', type: 'submit', form: ENGINE_FORM/)
  assert.match(dialog, /id: ENGINE_FORM, className: 'nodo-dialog-fields(?: [^']+)?'/)
  assert.equal(source.includes('nodo-form-page'), false, 'settings no longer owns the main area')
})

test('engine cards save defaults and check saved values in the current project', async () => {
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false
  const view = {
    profiles: [{ id: 'coder', name: 'Coder', engine: 'codex', engineOptions: { bin: '/role/codex' } }],
    prefs: { engineConfigs: { codex: { engineOptions: { bin: '/default/codex' } } } },
    workspaces: [{ id: 'w1', name: 'one', cwd: '/one' }, { id: 'w2', name: 'two', cwd: '/two' }], work: {},
  }
  let workspace = view.workspaces[0]
  const { EngineSettingsDialog } = await loadClient('engine-settings.js', {
    stubs: { 'engine-logos.js': { EngineMark: 'EngineMark', engineDisplayName: item => item.label } },
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    primitives: {
      Modal: 'Modal', Button: 'Button', Field: 'Field', StateDot: 'StateDot',
      IconChevronDownOutlineRegular: 'Icon', IconCheckOutlineRegular: 'Icon',
    },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-detect') return ['codex', 'dsh'].map(id => ({ id, label: id, usable: true,
        fields: [{ name: 'bin', label: 'CLI', target: 'engineOptions', type: 'text' }] }))
      if (endpoint === 'engine-check') return { ok: true, version: '1.0', checks: [] }
      if (endpoint === 'engine-config-set') view.prefs.engineConfigs[payload.engine] = { engineOptions: payload.engineOptions }
      if (endpoint === 'engine-enable-set') {
        view.prefs.enabledEngines = payload.engines.length > 0 ? payload.engines : view.prefs.enabledEngines
        return { enabledEngines: view.prefs.enabledEngines ?? null, onboardedAt: 1 }
      }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(EngineSettingsDialog({ view, workspace, refresh: async () => {}, readOnly: false, onClose() {} })) }
  const find = (type, label) => render().find(node => node.type === type && node.children.includes(label))
  const tick = () => new Promise(resolve => setImmediate(resolve))
  render(); mounted = true; effects.forEach(effect => effect()); await tick()
  render().find(node => node.props.className === 'nodo-engine-toggle').props.onClick()
  assert.equal(render().some(node => node.type === 'select'), false, 'configuration target and project selectors are absent')
  render().find(node => node.type === 'input').props.onChange({ target: { value: '/edited/codex' } })
  await find('Button', '检查连接').props.onClick(); await tick()
  assert.deepEqual(requests.at(-1), { endpoint: 'engine-check', payload: { engine: 'codex', engineOptions: { bin: '/default/codex' }, cwd: '/one' } })
  await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(requests.at(-1), { endpoint: 'engine-config-set', payload: { engine: 'codex', engineOptions: { bin: '/edited/codex' } } })
  assert.equal(view.profiles[0].engineOptions.bin, '/role/codex', 'saving defaults preserves existing roles')
  assert.ok(find('strong', '未检查'), 'saving invalidates the previous result')
  await find('Button', '检查连接').props.onClick(); await tick()
  assert.equal(requests.at(-1).payload.engineOptions.bin, '/edited/codex')
  workspace = view.workspaces[1]
  assert.ok(find('strong', '未检查'), 'a different workspace has no inherited result')
  assert.equal(find('Button', '重新检查').props.icon.type, 'IconRefreshOutlineRegular')
  await find('Button', '重新检查').props.onClick(); await tick()
  const checks = requests.filter(item => item.endpoint === 'engine-check').slice(-2)
  assert.deepEqual(checks.map(item => item.payload.engine), ['codex', 'dsh'])
  assert.equal(checks[0].payload.engineOptions.bin, '/edited/codex', 'batch checks use each engine default')
  assert.equal(checks[0].payload.cwd, '/two')
})

// The onboarding choice is what scopes the role dialog later, so bind the
// settings page's enable toggles and the detection groups to the endpoint.
test('settings cards group by detection and toggle the enabled set', async () => {
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false
  const view = { profiles: [], prefs: { enabledEngines: ['codex'] }, workspaces: [], work: {} }
  const { EngineSettingsDialog } = await loadClient('engine-settings.js', {
    stubs: { 'engine-logos.js': { EngineMark: 'EngineMark', engineDisplayName: item => item.label } },
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    primitives: {
      Modal: 'Modal', Button: 'Button', StateDot: 'StateDot',
      IconChevronDownOutlineRegular: 'Icon', IconRefreshOutlineRegular: 'Icon', IconCheckOutlineRegular: 'Icon',
    },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-detect') return [
        { id: 'codex', label: 'Codex CLI', usable: true, executable: '/bin/codex' },
        { id: 'dsh', label: 'DSH', usable: true, nativeRuntime: true },
        { id: 'echo', label: 'Echo', usable: false },
      ]
      if (endpoint === 'engine-enable-set') {
        view.prefs.enabledEngines = [...payload.engines]
        return { enabledEngines: [...payload.engines], onboardedAt: 1 }
      }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(EngineSettingsDialog({ view, workspace: null, refresh: async () => {}, readOnly: false, onClose() {} })) }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  render(); mounted = true; effects.forEach(effect => effect()); await tick()
  const heads = render().filter(node => node.type === 'h3').map(node => node.children[0])
  assert.deepEqual(heads, ['已检测', '未检测到'], 'detected engines lead, the rest stay configurable')
  const switches = () => render().filter(node => node.type === 'button' && node.props.className === 'nodo-engine-switch')
  assert.equal(switches().length, 2, 'an undetected engine offers no enable toggle')
  assert.equal(requests.at(-1).endpoint, 'engine-detect')
  await switches().find(node => node.props['aria-label'] === '启用 DSH').props.onClick(); await tick()
  assert.deepEqual(requests.at(-1), { endpoint: 'engine-enable-set', payload: { engines: ['codex', 'dsh'] } })
  assert.deepEqual(view.prefs.enabledEngines, ['codex', 'dsh'])
  await switches().find(node => node.props['aria-label'] === '停用 Codex CLI').props.onClick(); await tick()
  assert.deepEqual(requests.at(-1).payload.engines, ['dsh'])
})

test('first-run onboarding lists detected engines and stores the choice', async () => {
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false, done = 0
  const { OnboardingDialog } = await loadClient('engine-settings.js', {
    stubs: { 'engine-logos.js': { EngineMark: 'EngineMark', engineDisplayName: item => item.label } },
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    primitives: { Modal: 'Modal', Button: 'Button', IconCheckOutlineRegular: 'Icon' },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-detect') return [
        { id: 'codex', label: 'Codex CLI', usable: true, executable: '/bin/codex' },
        { id: 'echo', label: 'Echo', usable: false },
      ]
      return { enabledEngines: payload.engines, onboardedAt: 1 }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(OnboardingDialog({ view: { profiles: [{ id: 'worker' }], workspaces: [{ id: 'project' }] }, onDone: async () => { done++ } })) }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  render(); mounted = true; effects.forEach(effect => effect()); await tick()
  const picks = () => render().filter(node => node.type === 'button' && node.props.className === 'nodo-engine-card nodo-engine-pick')
  assert.deepEqual(requests.map(item => item.endpoint), ['engine-detect'], 'onboarding detects once')
  assert.equal(picks().length, 1, 'an undetected engine is not offered')
  picks()[0].props.onClick()
  assert.equal(picks()[0].props['aria-pressed'], true, 'the last enabled engine cannot be deselected')
  // The dialog's actions live in the Modal's footer prop, not its children.
  const footer = () => render().find(node => node.type === 'Modal').props.footer.flatMap(nodes)
  assert.equal(footer().find(node => node.type === 'Button').children[0], '下一步')
  render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.deepEqual(requests.at(-1), { endpoint: 'engine-enable-set', payload: { engines: ['codex'] } })
  assert.equal(done, 1, 'finishing hands back to the page for its refresh')
})

// An old or read-only host refuses both endpoints; the dialog must still let
// the user through instead of blocking the page behind it.
test('onboarding dismisses even when the host rejects detection and the write', async () => {
  const states = [], effects = [], errors = []
  let cursor = 0, mounted = false, done = 0
  const { OnboardingDialog } = await loadClient('engine-settings.js', {
    stubs: { 'engine-logos.js': { EngineMark: 'EngineMark', engineDisplayName: item => item.label } },
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    primitives: { Modal: 'Modal', Button: 'Button', IconCheckOutlineRegular: 'Icon' },
    async call(endpoint) {
      if (endpoint === 'engine-enable-set') errors.push(endpoint)
      throw new Error(`Unknown endpoint ${endpoint}`)
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(OnboardingDialog({ onDone: async () => { done++ } })) }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  render(); mounted = true; effects.forEach(effect => effect()); await tick()
  assert.ok(render().some(node => node.props.className === 'nodo-dialog-hint'
    && node.children.some(child => typeof child === 'string' && child.includes('未检测到已适配的 Agent'))),
  'a failing detection degrades to the empty state')
  render().find(node => node.type === 'Modal').props.onClose(); await tick(); await tick()
  assert.equal(errors.length, 1, 'closing still attempts the write once')
  assert.equal(done, 1, 'the dialog hands back to the page regardless of the failure')
})

const onboardingFixture = async ({ view = { profiles: [], workspaces: [] }, failAt, pickDirectory } = {}) => {
  const requests = [], navigation = [], drafts = []
  let mounted = false, done = 0
  const loaded = await loadClient('engine-settings.js', {
    react: { useEffect(effect) { if (!mounted) loaded.host.effects.push(effect) } },
    stubs: {
      'page.js': { setNavigation: update => navigation.push(JSON.parse(JSON.stringify(update({ archivedSession: 'old' })))) },
      'engine-logos.js': { EngineMark: 'EngineMark', engineDisplayName: item => item.label },
    },
    uiShared: { nativePickDirectory: pickDirectory, nativeSpace: { startDraft: selection => drafts.push({ ...selection }) }, call: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === failAt) throw new Error(`${endpoint} refused`)
      if (endpoint === 'engine-detect') return [
        { id: 'codex', label: 'Codex', usable: true }, { id: 'echo', label: 'Echo', usable: true }, { id: 'absent', label: 'Absent', usable: false },
      ]
      if (endpoint === 'profile-create') return { id: 'new-role' }
      if (endpoint === 'workspace-create') return { id: 'new-project' }
      return { enabledEngines: payload.engines, onboardedAt: 1 }
    } },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { loaded.host.reset(); return nodes(loaded.OnboardingDialog({ view, onDone: () => { done++ } })) }
  const modal = () => render().find(node => node.type === 'Modal')
  const input = label => render().find(node => node.props?.['aria-label'] === label)
  const next = async () => { render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tickAll() }
  render(); mounted = true
  loaded.host.effects.splice(0).forEach(effect => effect())
  await tickAll()
  return { requests, navigation, drafts, render, modal, input, next, done: () => done }
}

test('onboarding creates a general-purpose role and project in three steps and selects both', async () => {
  const flow = await onboardingFixture()
  const { modal, render, input, next, requests, navigation } = flow
  const frame = () => [modal().props.className, modal().props.contentClassName]
  const initialFrame = frame()
  assert.equal(modal().props.title, '启用 Agent')
  const cards = () => render().filter(node => node.props?.className === 'nodo-engine-card nodo-engine-pick')
  assert.equal(cards().length, 2)
  cards()[1].props.onClick()
  await next()
  assert.equal(modal().props.title, '创建万能角色')
  assert.deepEqual(frame(), initialFrame)
  assert.equal(input('名字').props.value, '万能助手')
  assert.equal(input('名字').props.maxLength, 40)
  assert.deepEqual(input('Agent').children.map(node => node.props.value), ['codex'])
  assert.equal(input('Agent').props.value, 'codex')
  assert.equal(render().filter(node => node.type === 'input').length, 1)
  await next()
  const avatar = JSON.parse(readFileSync(new URL('../core/shared/avatar-templates.json', import.meta.url), 'utf8'))[0].id
  assert.deepEqual(requests.find(item => item.endpoint === 'profile-create').payload, { name: '万能助手', engine: 'codex', avatarTemplate: avatar })
  assert.equal(modal().props.title, '添加项目')
  assert.deepEqual(frame(), initialFrame)
  assert.equal(modal().props.footer.at(-1).children[0], '完成')
  assert.equal(modal().props.footer.at(-1).props.disabled, true)
  input('项目名称').props.onChange({ target: { value: '  Website  ' } })
  input('项目目录').props.onChange({ target: { value: '  /tmp/website  ' } })
  await next()
  assert.deepEqual(requests.map(item => item.endpoint), ['engine-detect', 'engine-enable-set', 'profile-create', 'workspace-create'])
  assert.deepEqual(requests.at(-1).payload, { name: 'Website', cwd: '/tmp/website' })
  assert.deepEqual(navigation, [{ profile: 'new-role', workspace: 'new-project' }])
  assert.deepEqual(flow.drafts, navigation, 'completion opens a new conversation with the created role and project')
  assert.equal(flow.done(), 1)
  assert.equal(render().some(node => JSON.stringify(node).includes('兜底')), false)
})

for (const [profiles, workspaces, titles, endpoints, selected] of [
  [[{ id: 'kept-role' }], [], ['添加项目'], ['workspace-create'], { profile: 'kept-role', workspace: 'new-project' }],
  [[], [{ id: 'kept-project' }], ['创建万能角色'], ['profile-create'], { profile: 'new-role', workspace: 'kept-project' }],
  [[{ id: 'kept-role' }], [{ id: 'kept-project' }], [], [], undefined],
]) test(`onboarding skips existing steps (${profiles.length} executors, ${workspaces.length} projects)`, async () => {
  const flow = await onboardingFixture({ view: { profiles, workspaces } })
  await flow.next()
  for (const title of titles) {
    assert.equal(flow.modal().props.title, title)
    if (title === '添加项目') {
      flow.input('项目名称').props.onChange({ target: { value: 'Project' } })
      flow.input('项目目录').props.onChange({ target: { value: '/tmp/project' } })
    }
    await flow.next()
  }
  assert.deepEqual(flow.requests.map(item => item.endpoint), ['engine-detect', 'engine-enable-set', ...endpoints])
  assert.deepEqual(flow.navigation, selected ? [selected] : [])
  assert.deepEqual(flow.drafts, selected ? [selected] : [])
  assert.equal(flow.done(), 1)
})

for (const step of ['engines', 'role', 'workspace']) test(`closing onboarding during ${step} hands back without creating more records`, async () => {
  const flow = await onboardingFixture()
  if (step !== 'engines') await flow.next()
  if (step === 'workspace') await flow.next()
  const created = flow.requests.filter(item => item.endpoint.endsWith('-create')).length
  flow.modal().props.onClose(); await tickAll()
  assert.equal(flow.done(), 1)
  assert.equal(flow.requests.filter(item => item.endpoint.endsWith('-create')).length, created)
  assert.deepEqual(flow.navigation, [])
})

for (const endpoint of ['engine-enable-set', 'profile-create', 'workspace-create']) test(`onboarding stays on its step after ${endpoint} fails`, async () => {
  const flow = await onboardingFixture({ failAt: endpoint })
  if (endpoint !== 'engine-enable-set') await flow.next()
  if (endpoint === 'workspace-create') await flow.next()
  if (endpoint === 'workspace-create') {
    flow.input('项目名称').props.onChange({ target: { value: 'Project' } })
    flow.input('项目目录').props.onChange({ target: { value: '/tmp/project' } })
  }
  const title = flow.modal().props.title
  await flow.next()
  assert.equal(flow.modal().props.title, title)
  assert.equal(flow.done(), 0)
  assert.equal(flow.render().find(node => node.props?.role === 'alert').children[0], `${endpoint} refused`)
  flow.modal().props.onClose(); await tickAll()
  assert.equal(flow.done(), 1)
})

test('onboarding offers the native directory picker for its project step', async () => {
  const flow = await onboardingFixture({ view: { profiles: [{ id: 'worker' }], workspaces: [] }, pickDirectory: async () => '/tmp/picked' })
  await flow.next()
  flow.input('项目名称').props.onChange({ target: { value: 'Picked' } })
  flow.render().find(node => node.type === 'Button' && node.children.includes('选择目录…')).props.onClick()
  await tickAll()
  await flow.next()
  assert.deepEqual(flow.requests.at(-1), { endpoint: 'workspace-create', payload: { name: 'Picked', cwd: '/tmp/picked' } })
})

// A destructive confirmation that forgets its write closes the dialog and
// changes nothing, which no render check would notice, so bind every delete to
// the endpoint that has to run.
test('every delete path writes through the endpoint that owns it', () => {
  const pageSource = clientSource('page.js')
  const block = (source, open, close) => {
    const start = source.indexOf(open)
    assert.ok(start > 0, `${open} exists`)
    const end = close === undefined ? source.length : source.indexOf(close, start + open.length)
    assert.ok(end > start, `${open} ends`)
    return source.slice(start, end)
  }
  assert.match(block(clientSource('roles.tsx'), 'const deletedRole', 'const typeNameOf'), /call\('profile-delete'/)
  assert.match(block(pageSource, 'const deletedWorkspace', 'const select ='), /call\('workspace-delete'/)
  for (const [dialog, file, close] of [['RoleEditor', 'profile-dialogs.js', '\nexport function '], ['WorkspaceDeleteDialog', 'workspace-dialogs.js', undefined]]) {
    assert.match(block(clientSource(file), `function ${dialog}(`, close), /await onDeleted\(/, `${dialog} hands its confirmation to the page`)
  }
})

// The kit is destructured once at the top; a member used further down but
// missing from that list renders as undefined (a missing sidebar icon, a blank
// row) without failing the bundle check, so guard the two directions here.
test('every host UI kit member the page uses is destructured from the kit', () => {
  const source = clientSource('ui-shared.js')
  const from = source.indexOf("from '@deepseek-ai/dsh-client-ui-primitives'")
  assert.ok(from > 0, 'the kit is imported')
  const open = source.lastIndexOf('import {', from)
  const close = source.indexOf('}', from)
  const imported = new Set(source.slice(open + 'import {'.length, close)
    .split(',').map(name => name.trim()).filter(Boolean))
  const members = ['Button', 'DisclosureRow', 'Input', 'MarkdownText', 'Menu', 'Modal',
    'StateDot', 'Tooltip', 'relativeTime']
  const named = [...source.matchAll(/\bIcon[A-Za-z]+(?:Regular|Medium)\b/g)].map(match => match[0])
  for (const name of new Set([...members, ...named])) {
    assert.ok(imported.has(name), `${name} is used but not imported from the kit`)
  }
})

test('tool variants distinguish writing, editing, subtasks and generic calls', async () => {
  const { TOOL_VARIANTS } = await loadClient('ui-shared.js')
  for (const [kind, icon] of Object.entries({ write: 'IconContextInjectionOutlineRegular', edit: 'IconEditOutlineRegular',
    code: 'IconInspectOutlineRegular', task: 'IconAgentPresetOutlineRegular', generic: 'IconPluginPinwheelOutlineRegular' })) {
    assert.equal(TOOL_VARIANTS[kind].icon, icon)
  }
})

// The role dialog loads with the real avatar module; each caller brings its own
// hook fakes and call handler.
const loadRoleEditor = async ({ react, call }) => loadClient(['profile-dialogs.js', 'avatar.tsx'], { react, call })

test('the role editor saves identity without changing role kind or assignment', async () => {
  for (const lead of [false, true]) {
    const calls = []
    const profile = { id: 'role', name: 'Role', engine: 'echo', lead, taskTypes: ['docs'], hard: { model: 'hard' }, sessions: [] }
    const { RoleEditor, host } = await loadRoleEditor({ call: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : { id: 'saved' }
    } })
    const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
    const render = () => { host.reset(); return nodes(RoleEditor({ profile, onSaved() {} })) }
    render()
    host.effects.splice(0).forEach(effect => effect())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(render().some(node => node.props.role === 'tablist' || node.props.className === 'nodo-role-kind'), false)
    assert.equal(render().some(node => node.props['aria-label'] === '可接难题'), false)
    const input = render().find(node => node.type === 'input' && node.props.className.includes('nodo-role-identity'))
    assert.equal(input.props.maxLength, 40)
    input.props.onChange({ target: { value: 'custom identity' } })
    await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const saved = calls.at(-1)
    assert.equal(saved.endpoint, 'profile-update')
    assert.equal(saved.payload.changes.identity, 'custom identity')
    for (const key of ['lead', 'taskTypes', 'hard']) assert.equal(Object.hasOwn(saved.payload.changes, key), false)
    assert.equal(saved.payload.changes.instructions, '')
  }
})

test('the header avatar opens the template grid and submits the selected template', async () => {
  const templates = JSON.parse(readFileSync(new URL('../core/shared/avatar-templates.json', import.meta.url), 'utf8'))
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false, saved
  const { RoleEditor, RoleAvatar } = await loadRoleEditor({
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    call: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'codex', label: 'Codex', catalog: { models: [] } }]
      return { id: 'saved', ...payload }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(RoleEditor({ avatarSeed: 2, onSaved: item => { saved = item } })) }
  const card = () => render().find(node => node.type === RoleAvatar && node.props.size === 44)
  const trigger = () => render().find(node => node.props?.['aria-label'] === '更换头像')
  assert.equal(card().props.profile.avatarTemplate, templates[2].id, 'a new role shows the dango its creation order assigns')
  mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  render().find(node => node.type === 'input' && node.props.placeholder === '例如 Coder 或 Reviewer').props.onChange({ target: { value: 'Cute coder' } })
  assert.ok(render().some(node => node.type === 'h2' && node.children[0] === 'Cute coder'), 'the header follows the name')
  const choices = () => render().filter(node => node.props.className === 'nodo-avatar-option')
  assert.equal(choices().length, 0, 'the grid stays closed until the avatar is clicked')
  for (const template of templates) {
    trigger().props.onClick()
    assert.equal(trigger().props['aria-expanded'], true)
    assert.equal(choices().length, templates.length)
    choices().find(node => node.children.includes(template.label)).props.onClick()
    assert.equal(choices().length, 0, 'a pick closes the grid')
    assert.equal(card().props.profile.avatarTemplate, template.id)
  }
  trigger().props.onClick()
  assert.equal(choices().filter(node => node.props['aria-pressed']).length, 1)
  await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(requests.at(-1).endpoint, 'profile-create')
  assert.equal(saved.avatarTemplate, templates.at(-1).id)
  assert.equal(saved.name, 'Cute coder')
  assert.equal(Object.hasOwn(saved, 'previewRunning'), false)
})

// The rail loads with its real ui-shared helpers; kit members stand in as their
// own names and hooks come from the caller's fakes.
const loadRail = async (react, primitives) => loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], { react, primitives })

test('rail omits redundant status icons and distinguishes unarchive from the archive filter', async () => {
  const { SessionRow, workspacePicker } = await loadRail()
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const changes = []
  const row = nodes(SessionRow({ role: { name: 'Coder' }, session: { name: 'History', archivedAt: 1 },
    onArchive: value => changes.push(value) }))
  const status = row.find(node => node.props.className === 'nodo-row-archived')
  assert.deepEqual(status.children, ['已归档'])
  const action = row.find(node => node.props['aria-label'] === '取消归档会话“History”')
  assert.equal(action.children[0].type, 'IconUnarchiveOutlineRegular')
  action.props.onClick({ stopPropagation() {} })
  assert.deepEqual(changes, [false])
  const picker = workspacePicker({ workspaces: [{ id: 'p', name: 'Project' }], none: '无项目' })
  assert.equal(picker.props.items[0].icon, undefined)
  assert.equal(picker.props.items[1].icon.type, 'IconFolderOpenOutlineRegular')
  assert.equal(nodes(picker.props.anchor).some(node => node.type === 'IconUsersOutlineRegular'), false)
})

test('the global archive lists only archived sessions with a deleted role or project and keeps their names', async () => {
  const loaded = await loadRail()
  const { Rail, SessionRow, host } = loaded
  const project = { id: 'kept', name: 'Kept project', cwd: '/kept' }
  const view = { workspaces: [project], work: {}, profiles: [
    { id: 'removed', name: 'Deleted role', deletedAt: 1, sessions: [
      { id: 'role-archive', name: 'Past work', archivedAt: 1, workspaceRef: 'kept', workspaceName: 'Original project', profileName: 'Original role' },
      { id: 'role-draft', name: 'Unsent role draft', archivedAt: 1, workspaceRef: 'kept', draftedAt: 1, briefSent: false },
    ] },
    { id: 'active', name: 'Active role', sessions: [
      { id: 'project-archive', name: 'Deleted project work', archivedAt: 2, workspaceRef: 'gone', workspaceName: 'Gone project' },
      { id: 'manual', name: 'Manual archive', archivedAt: 3, workspaceRef: 'kept' },
      { id: 'legacy-orphan', name: 'Old orphan', workspaceRef: 'old' },
      { id: 'project-draft', name: 'Unsent project draft', archivedAt: 2, workspaceRef: 'gone', draftedAt: 1, briefSent: false },
      { id: 'sent-draft', name: 'Sent draft', archivedAt: 2, workspaceRef: 'gone', draftedAt: 1, briefSent: true },
    ] },
  ] }
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const selected = []
  const render = () => { host.reset(); return nodes(Rail({ view, workspace: project, onSelectSession: (role, id) => selected.push([role.id, id]) })) }
  const toggle = () => render().find(node => node.props.className === 'nodo-project-select'
    && nodes(node).some(child => child.props.className === 'nodo-row-title' && child.children.includes('已移除')))
  toggle().props.onClick()
  const archived = render().filter(node => node.type === SessionRow && node.props.readOnly)
  assert.deepEqual(archived.map(node => node.props.session.id).sort(), ['project-archive', 'role-archive', 'sent-draft'])
  assert.equal(archived.find(node => node.props.session.id === 'role-archive').props.context, 'Original role · Original project')
  assert.equal(archived.find(node => node.props.session.id === 'project-archive').props.context, 'Active role · Gone project')
  assert.equal(render().some(node => node.props.className === 'nodo-roster-name' && node.children.includes('Deleted role')), false)
  const row = nodes(SessionRow(archived[0].props))
  assert.equal(row.find(node => node.props.className === 'nodo-row nodo-session').props.disabled, undefined)
  assert.equal(row.some(node => node.props.className === 'nodo-row-actions'), false, 'deleted archives have no unarchive or edit controls')
  row.find(node => node.props.className === 'nodo-row nodo-session').props.onClick()
  assert.equal(selected[0][1], archived[0].props.session.id)
  view.workspaces = []
  assert.ok(render().some(node => node.type === SessionRow && node.props.session.id === 'role-archive'), 'archives remain reachable without any project')
})

// The global removed entry only earns a spot when something was actually removed.
test('the rail hides the global removed entry while no removed session exists', async () => {
  const loaded = await loadRail()
  const { Rail, host } = loaded
  const project = { id: 'kept', name: 'Kept project', cwd: '/kept' }
  const view = { workspaces: [project], work: {}, profiles: [
    { id: 'active', name: 'Active role', sessions: [
      { id: 'live', name: 'Current work', workspaceRef: 'kept' },
      { id: 'manual', name: 'Manual archive', archivedAt: 1, workspaceRef: 'kept' },
    ] },
  ] }
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const render = () => { host.reset(); return nodes(Rail({ view, workspace: project, onSelect: () => {} })) }
  assert.equal(render().some(node => node.props.className === 'nodo-row-title' && node.children.includes('已移除')), false,
    'a clean rail lists no removed entry')
  assert.equal(render().some(node => node.type === 'p' && node.children.includes('暂无已归档会话')), false,
    'the removed empty state is gone with the entry')
})

test('the global removed entry returns once a removed session exists and lists it', async () => {
  const loaded = await loadRail()
  const { Rail, SessionRow, host } = loaded
  const view = { workspaces: [{ id: 'kept', name: 'Kept project', cwd: '/kept' }], work: {}, profiles: [
    { id: 'removed', name: 'Removed role', deletedAt: 1, sessions: [
      { id: 'gone', name: 'Removed work', archivedAt: 1, workspaceRef: 'kept', profileName: 'Removed role', workspaceName: 'Kept project' },
    ] },
  ] }
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const render = () => { host.reset(); return nodes(Rail({ view, onSelectSession: () => {} })) }
  const toggle = () => render().find(node => node.props.className === 'nodo-project-select'
    && nodes(node).some(child => child.props.className === 'nodo-row-title' && child.children.includes('已移除')))
  assert.ok(toggle(), 'a removed session restores the entry')
  assert.equal(toggle().props['aria-expanded'], false, 'the entry starts folded')
  toggle().props.onClick()
  const rows = render().filter(node => node.type === SessionRow && node.props.readOnly)
  assert.deepEqual(rows.map(node => node.props.session.id), ['gone'])
})

test('opening an archived dsh session uses the read-only feed without native open, select or a composer', async () => {
  const session = { id: 'archived', name: 'History', archivedAt: 1, workspaceRef: 'gone', workspaceName: 'Original project', engine: 'dsh', driverSessionId: 'native-history' }
  const role = { id: 'deleted', name: 'Deleted role', engine: 'dsh', deletedAt: 1, sessions: [session] }
  const view = { profiles: [role], workspaces: [], work: {}, stats: {}, prefs: { onboardedAt: 1 } }
  const calls = [], remembered = []
  const state = { active: true, legacy: true }
  const loaded = await loadClient(['page.js', 'feed.js', 'composer.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => state, showLegacy: () => calls.push('legacy') },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) }, subscribeNativeSession() {}, readNativeSession: () => null,
      openNativeSession: () => calls.push('native-open'), call: async endpoint => { calls.push(endpoint) },
    },
    globals: { document: { visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: key => key === 'nodo.navigation' ? JSON.stringify({ archivedSession: session.id, profile: role.id, workspace: 'gone' }) : null, setItem() {} } },
  })
  await loaded.selectSession(role, session.id, undefined, {
    workspace: null, workspaces: [], navigation: {}, sidebarOnly: true, readOnly: false,
    remember: (...args) => remembered.push(args), refresh: async () => calls.push('refresh'), setActionError() {}, setEditing() {},
  })
  assert.deepEqual(calls, ['legacy'])
  assert.deepEqual(remembered, [[role.id, 'gone', session.id, true]])
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  for (const deleted of [true, false]) {
    role.deletedAt = deleted ? 1 : undefined
    loaded.host.reset()
    const tree = nodes(loaded.NodoPage({ contentOnly: true }))
    const feed = tree.find(node => node.type === loaded.Feed)
    assert.equal(feed.props.session.id, session.id)
    assert.equal(tree.some(node => node.type === loaded.Composer), false)
  }
  assert.deepEqual(calls, ['legacy'], 'rendering archived content never opens an execution path')
})

test('sidebar avatar follows any active session and returns to idle when work ends', async () => {
  const { Rail, RoleAvatar } = await loadRail({ useState: initial => [initial, () => {}] })
  const profile = { id: 'one', name: 'One', avatarTemplate: 'mint', sessions: [{ id: 'a' }, { id: 'b' }] }
  const view = { profiles: [profile], workspaces: [], work: { a: { active: false }, b: { active: true } } }
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const avatar = () => nodes(Rail({ view, profile })).find(node => node.type === RoleAvatar)
  assert.equal(avatar().props.running, true)
  assert.equal(avatar().props.profile.avatarTemplate, 'mint')
  view.work.b.active = false
  assert.equal(avatar().props.running, false)
  view.work.a.active = true
  assert.equal(avatar().props.running, true)
})

// A roster avatar narrows the session list to one role; pressing it again or
// 全部 lifts the filter. Only the list changes, never the roster.
test('the rail filters sessions by the role picked in the roster', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow } = await loadRail({ useState: (initial) => {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
  } })
  const workspace = { id: 'w', name: 'bot', cwd: '/bot', createdAt: 1 }
  const view = { workspaces: [workspace], work: {}, profiles: [
    { id: 'fish', name: '大肥鱼', sessions: [{ id: 'a', name: '读当前任务', workspaceRef: 'w', updatedAt: 2 }] },
    { id: 'coder', name: '贼 coder', sessions: [{ id: 'b', name: '删除新会话', workspaceRef: 'w', updatedAt: 1 }] },
  ] }
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const selected = [], edited = []
  const render = () => { cursor = 0; return nodes(Rail({ view, workspace, onSelect: id => selected.push(id), onEditRole: role => edited.push(role.id) })) }
  const rows = tree => tree.filter(node => node.type === SessionRow).map(node => `${node.props.role.name} · ${node.props.session.name}`)
  const roster = tree => tree.filter(node => node.props?.className === 'nodo-roster-item')
  const name = node => node.children[1].children[0]
  const press = label => roster(render()).find(node => name(node) === label).props.onClick()
  const pressed = tree => roster(tree).filter(node => node.props['aria-current']).map(name)
  const edit = (tree, label) => tree.find(node => node.props?.className === 'nodo-roster-edit' && node.props['aria-label'] === `配置角色 ${label}`)
  let tree = render()
  assert.deepEqual(roster(tree).map(name), ['全部', '大肥鱼', '贼 coder'])
  assert.deepEqual(pressed(tree), ['全部'])
  assert.deepEqual(rows(tree), ['大肥鱼 · 读当前任务', '贼 coder · 删除新会话'])
  assert.ok(edit(tree, '大肥鱼') && edit(tree, '贼 coder'), 'every role carries its own config entry')
  edit(tree, '贼 coder').props.onClick()
  assert.deepEqual([selected, edited], [[], ['coder']], 'the config entry opens the role card without picking the role')
  assert.equal(tree.some(node => node.props?.className === 'nodo-roster-detail'), false, 'picking a role opens no detail bar')
  press('贼 coder')
  tree = render()
  assert.deepEqual(selected, ['coder'], 'pressing a role also selects it')
  assert.deepEqual(pressed(tree), ['贼 coder'])
  assert.deepEqual(rows(tree), ['贼 coder · 删除新会话'])
  assert.deepEqual(roster(tree).map(name), ['全部', '大肥鱼', '贼 coder'], 'the roster stays complete')
  assert.equal(tree.some(node => node.props?.className === 'nodo-roster-detail'), false, 'picking a role opens no detail bar')
  const fold = () => render().find(node => node.props?.className === 'nodo-project-select' && node.props.title === '/bot').props.onClick()
  fold()
  assert.deepEqual(rows(render()), [], 'a role filter still lets a project fold')
  fold()
  assert.deepEqual(rows(render()), ['贼 coder · 删除新会话'])
  press('贼 coder')
  tree = render()
  assert.deepEqual(pressed(tree), ['全部'], 'pressing the role again lifts its filter')
  assert.deepEqual(rows(tree), ['大肥鱼 · 读当前任务', '贼 coder · 删除新会话'])
  press('大肥鱼')
  assert.deepEqual(rows(render()), ['大肥鱼 · 读当前任务'])
  press('全部')
  assert.deepEqual(rows(render()), ['大肥鱼 · 读当前任务', '贼 coder · 删除新会话'])
})

// A long plain list folds to the ten most recent sessions; searching lists every
// match with no fold, and the toggle re-folds after expanding.
test('the rail folds a long session list behind a show-more toggle', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow } = await loadRail({ useState: (initial) => {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
  } })
  const workspace = { id: 'w', name: 'bot', cwd: '/bot', createdAt: 1 }
  const view = { workspaces: [workspace], work: {}, profiles: [
    { id: 'role', name: 'Coder', sessions: Array.from({ length: 12 }, (_, index) =>
      ({ id: `s${index}`, name: `会话${index}`, workspaceRef: 'w', updatedAt: 100 - index })) },
  ] }
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(Rail({ view, workspace, onSelect: () => {} })) }
  const ids = tree => tree.filter(node => node.type === SessionRow).map(node => node.props.session.id)
  const toggle = tree => tree.find(node => node.props?.className === 'nodo-show-more')
  let tree = render()
  assert.deepEqual(ids(tree), Array.from({ length: 10 }, (_, index) => `s${index}`), 'only the ten most recent sessions show')
  assert.deepEqual(toggle(tree).children, ['显示更多'])
  toggle(tree).props.onClick()
  assert.deepEqual(ids(render()), view.profiles[0].sessions.map(session => session.id), 'expanding shows every session')
  assert.deepEqual(toggle(render()).children, ['收起'])
  toggle(render()).props.onClick()
  assert.deepEqual(ids(render()), Array.from({ length: 10 }, (_, index) => `s${index}`), 'folding again hides the tail')
  const views = tree.find(node => node.props?.className === 'nodo-rail-switch')
  assert.deepEqual(views.children.map(tip => [tip.children[0].props['aria-label'], tip.children[0].props['aria-pressed']]), [['会话', true], ['角色', false]], 'the dock switch shows sessions and roles')
  assert.equal(views.children[0].children[0].children[0].type, 'IconFlatListOutlineRegular', 'session navigation represents a list')
  const search = () => tree.find(node => node.type === 'Input')
  const menu = () => tree.find(node => node.type === 'Menu' && node.props.items.some(item => item.id === 'archived:only'))
  assert.equal(search(), undefined, 'search waits behind the project row action')
  tree.find(node => node.props?.className === 'nodo-row-action' && node.props['aria-label'] === '搜索“bot”的会话').props.onClick({ stopPropagation() {} })
  tree = render()
  assert.equal(search().props['aria-label'], '搜索“bot”的会话')
  search().props.onChange({ target: { value: '会话0' } })
  tree = render()
  assert.deepEqual(ids(tree), ['s0'], 'a search sees every match')
  assert.equal(toggle(tree), undefined, 'a search never folds')
  search().props.onKeyDown({ key: 'Escape' })
  tree = render()
  assert.equal(search(), undefined, 'Escape clears and closes the search')
  assert.equal(ids(tree).length, 10)
  menu().props.onSelect('archived:only')
  tree = render()
  assert.equal(menu().props.selectedId, 'archived:only', 'the project menu marks its archived view')
  assert.deepEqual(ids(tree), [])
  assert.ok(tree.some(node => node.props?.role === 'status' && node.children.includes('暂无已归档会话')), 'the project stays listed with an empty note')
  menu().props.onSelect('archived:hide')
  tree = render()
  // A role filter still folds: only the ten most recent matches show.
  const press = label => tree.find(node => node.props?.className === 'nodo-roster-item' && node.children[1].children[0] === label).props.onClick()
  press('Coder')
  tree = render()
  assert.deepEqual(ids(tree), Array.from({ length: 10 }, (_, index) => `s${index}`), 'a role filter keeps the fold')
  assert.equal(toggle(tree).children[0], '显示更多')
  press('全部')
  assert.deepEqual(ids(render()), Array.from({ length: 10 }, (_, index) => `s${index}`), '「全部」keeps the collapsed state')
})

// The unsent new-conversation draft lists as its own 新会话 row of its project,
// above the sessions, so switching sessions cannot orphan the draft.
test('the rail lists the pending draft as a 新会话 row that returns to it', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow } = await loadRail({ useState: (initial) => {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
  } }, { relativeTime: () => ({ unit: 'now', n: 0 }) })
  const workspace = { id: 'w', name: 'bot', cwd: '/bot', createdAt: 1 }
  const view = { workspaces: [workspace], work: {}, profiles: [
    { id: 'fish', name: '大肥鱼', sessions: [{ id: 'a', name: '读当前任务', workspaceRef: 'w', updatedAt: 2 }] },
  ] }
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const resumed = []
  const render = (draft, extra = {}) => {
    cursor = 0
    return nodes(Rail({ view, workspace, draft, onResumeDraft: () => resumed.push(draft.id), onSelect: () => {}, ...extra }))
  }
  const draftRow = tree => tree.find(node => node.props?.title === '新会话（草稿）')
  let tree = render({ id: 'd1', workspace: 'w', profile: 'fish' })
  const row = draftRow(tree)
  assert.ok(row, 'a draft of this project shows as its own row')
  assert.deepEqual(row.children[0].children, ['新会话'])
  const order = tree.filter(node => node.props?.title === '新会话（草稿）' || node.type === SessionRow)
    .map(node => node.props.title === '新会话（草稿）' ? 'draft' : node.props.session.id)
  assert.deepEqual(order, ['draft', 'a'], 'the draft row sits above the sessions')
  row.props.onClick()
  assert.deepEqual(resumed, ['d1'])
  assert.equal(draftRow(render({ id: 'd1', workspace: 'elsewhere' })), undefined, 'another project keeps its own list clean')
  tree = render({ id: 'd1', workspace: 'w' })
  tree.find(node => node.props?.className === 'nodo-roster-item' && node.props.title === '大肥鱼').props.onClick()
  assert.ok(draftRow(render({ id: 'd1', workspace: 'w', profile: 'fish' })), 'the draft survives its own role filter')
  assert.equal(draftRow(render({ id: 'd1', workspace: 'w', profile: 'other' })), undefined, 'a role filter hides foreign drafts')
  const openedRow = () => tree.find(node => node.type === SessionRow && node.props.session.id === 'a')
  const rowButton = row => nodes(SessionRow(row.props)).find(node => node.props.className === 'nodo-row nodo-session')
  tree = render({ id: 'd1', workspace: 'w', profile: 'fish' }, { sessionId: 'a', drafting: true })
  assert.equal(draftRow(tree).props['aria-current'], 'page', 'the draft row carries the highlight while drafting')
  assert.equal(openedRow().props.current, false)
  assert.equal(rowButton(openedRow()).props['aria-current'], undefined, 'no session row stays current while drafting')
  tree = render({ id: 'd1', workspace: 'w', profile: 'fish' }, { sessionId: 'a' })
  assert.equal(draftRow(tree).props['aria-current'], undefined, 'leaving the draft drops the highlight again')
  assert.equal(rowButton(openedRow()).props['aria-current'], 'page', 'the opened session is current again')
})

// A running session in a collapsed project or branch must stay findable: its tree
// row says how many sessions run, or that one waits for a person.
test('the project tree marks collapsed workspaces with running sessions', async () => {
  const { Rail } = await loadRail({ useState: initial => [initial, () => {}] })
  const workspaces = [{ id: 'main', name: 'bot', cwd: '/bot', createdAt: 1 }, { id: 'branch', name: 'feature', cwd: '/feature', worktree: { branch: 'feature' }, createdAt: 2 }]
  const view = { workspaces, work: { away: { active: true } }, profiles: [
    { id: 'role', name: 'Coder', sessions: [
      { id: 'home', name: '闲会话', workspaceRef: 'main', updatedAt: 2 },
      { id: 'away', name: '忙会话', workspaceRef: 'branch', updatedAt: 1 },
    ] },
  ] }
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const render = () => nodes(Rail({ view, workspace: workspaces[0], onSelect: () => {} }))
  const childNodes = node => node.children.find(child => child?.props?.className === 'nodo-tree-children').children
    .filter(child => child?.props?.className === 'nodo-tree-node')
  const top = tree => childNodes(tree.find(node => node.type === 'nav').children[0])
  const toggleOf = node => node.children[0].children[0]
  const state = tree => tree.find(node => node.props?.className === 'nodo-tree-state')
  let tree = render()
  // Workspaces sort by createdAt desc: the branch (busy) comes first.
  assert.deepEqual(top(tree).map(node => node.props.key), ['branch', 'main'])
  assert.deepEqual(top(tree).map(node => toggleOf(node).props['aria-expanded']), [false, true], 'only the current project opens')
  assert.equal(toggleOf(top(tree)[0]).children[1].children[0].type, 'IconBranchOutlineRegular')
  assert.deepEqual(state(tree).children.map(child => child.props?.state ?? child), ['ongoing', '1 个运行中'])
  view.work.away = { active: true, status: 'waiting-approval' }
  assert.deepEqual(state(render()).children.map(child => child.props?.state ?? child), ['warning', '待处理'])
  view.work.away.active = false
  assert.equal(state(render()), undefined, 'an all-idle tree carries no hint')
})

test('the project tree adds projects at its root and creates worktrees from the project menu', async () => {
  const source = clientSource('workspace-dialogs.js')
  const { Rail } = await loadRail({ useState: initial => [initial, () => {}] })
  const workspace = { id: 'w', name: 'bot', cwd: '/bot', createdAt: 1 }
  const view = { workspaces: [workspace], work: {}, profiles: [] }
  let worktrees = 0
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  let added = 0
  const tree = nodes(Rail({ view, workspace, onSelect: () => {}, onNewWorktree: () => { worktrees++ }, onNewWorkspace: () => { added++ }, busy: false, readOnly: false }))
  const projects = tree.find(node => node.type === 'nav').children[0]
  assert.equal(projects.children[0].children[0].children[1].children[0], '项目', 'every project sits under one 项目 row')
  nodes(projects.children[0]).find(node => node.type === 'button' && node.props['aria-label'] === '添加项目').props.onClick({ stopPropagation() {} })
  assert.equal(added, 1)
  assert.equal(tree.some(node => node.type === 'button' && node.props?.['aria-label'] === '从“bot”创建工作树'), false, 'the row keeps no separate worktree button')
  const menu = tree.find(node => node.type === 'Menu' && node.props?.items?.some(item => item.id === 'worktree'))
  assert.ok(menu, 'the project menu offers the action')
  menu.props.onSelect('worktree')
  assert.equal(worktrees, 1)
  assert.match(source, /使用已有分支/, 'the dialog offers direct existing-branch checkout')
  assert.match(source, /mode: 'existing'/, 'the dialog sends the existing-branch mode')
})

test('the worktree dialog selects a free existing branch or creates a new one', async () => {
  let cursor = 0
  const calls = []
  const slots = [
    { repositoryRoot: '/repo', head: { name: 'main' },
      branches: [{ name: 'main', checkedOutAt: '/repo' }, { name: 'feat/login' }], tags: [] },
    '', 'new', 'main', false, 'nodo/test', '', false, '', '', '', true, false, '',
  ]
  const { WorktreeDialog } = await loadClient('workspace-dialogs.js', {
    react: {
      useState: (initial) => {
        const slot = cursor++
        if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
        return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
      },
      useEffect: () => {},
    },
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { workspace: { id: 'w2' }, worktree: { path: '/repo/.nodo/worktrees/nodo/test' } }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(WorktreeDialog({
    workspace: { id: 'w', cwd: '/repo' }, profile: { id: 'p' }, onCreated: async () => {}, onCancel() {},
  })) }
  let tree = render()
  const existingMode = tree.find(node => node.type === 'Button' && node.children.join('') === '使用已有分支')
  assert.ok(existingMode, 'the dialog offers the existing-branch mode')
  existingMode.props.onClick()
  tree = render()
  assert.equal(tree.find(node => node.type === 'input' && node.props?.['aria-label'] === '搜索或选择已有分支').props.value, 'feat/login',
    'an occupied main branch is skipped and the first free branch is selected')
  await tree.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { endpoint: 'worktree-create',
    payload: { workspace: 'w', mode: 'existing', branch: 'feat/login' } })

  slots[2] = 'new'
  slots[12] = false
  tree = render()
  await tree.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { endpoint: 'worktree-create',
    payload: { workspace: 'w', mode: 'new', branch: 'nodo/test', from: 'main' } })
})

// The composer picker writes model and thinking onto the role card and offers
// no provider row — the engine is the role dialog's decision alone.
test('the composer model picker drills model and level over one engine catalog', async () => {
  const states = [], requests = [], picked = [], effects = []
  let cursor = 0, mounted = false
  const profile = { id: 'coder', engine: 'zcode', model: '', thinking: '' }
  const { ModelPicker } = await loadClient('feed.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }),
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'zcode', label: 'ZCode', catalog: { defaultModel: 'glm-x', models: [
        { id: 'glm-x', label: 'GLM X', group: 'Mock', defaultThinking: 'high', thinking: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] },
        { id: 'glm-y', label: 'GLM Y', group: 'Other', thinking: [{ id: 'low', label: 'Low' }] },
      ] } }]
      if (endpoint === 'engine-scan') return { models: [] }
    },
  })
  const render = () => { cursor = 0; return ModelPicker({ profile, disabled: false, onChange: changes => picked.push(changes) }) }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  render(); mounted = true; effects.forEach(effect => effect()); await tick(); await tick()
  assert.equal(render().props.anchor.props['aria-label'], '选择模型，当前 GLM X，推理等级 High', 'the trigger resolves labels on mount, before any open')
  const anchor = render().props.anchor
  assert.equal(anchor.type, 'button')
  assert.deepEqual([...render().props.items].map(item => item.id), ['model', 'thinking'], 'no provider row exists')
  anchor.props.onClick()
  await tick(); await tick()
  const opened = render()
  assert.equal(requests.at(-1).endpoint, 'engine-catalog', 'first open loads the catalog')
  assert.equal(opened.props.anchor.props['aria-label'], '选择模型，当前 GLM X，推理等级 High', 'unset values read the catalog defaults')
  opened.props.onSelect('model')
  let list = render()
  assert.equal(list.props.selectedId, 'model:glm-x')
  assert.equal(list.props.listClassName, 'nodo-model-list', 'the card carries the hook that reaches a portaled list')
  assert.deepEqual([...list.props.items].map(item => item.id), ['group:Mock', 'model:glm-x', 'group:Other', 'model:glm-y'], 'a provider row leads its models')
  assert.deepEqual([...list.props.items].map(item => item.type === 'label' ? item.text : item.label), ['Mock', 'GLM X', 'Other', 'GLM Y'], 'a provider row names the section, a row carries the model name alone')
  list.props.onSelect('group:Mock')
  assert.equal(picked.length, 0, 'a provider section is not a choice')
  list.props.onSelect('model:glm-y')
  assert.deepEqual({ ...picked.at(-1) }, { model: 'glm-y', thinking: '' }, 'a level the next model lacks resets to its default')
  render().props.onSelect('thinking')
  list = render()
  assert.equal(list.props.selectedId, 'thinking:high')
  assert.deepEqual([...list.props.items].map(item => item.id), ['thinking:', 'thinking:high', 'thinking:low'])
  list.props.onSelect('thinking:low')
  assert.deepEqual({ ...picked.at(-1) }, { model: 'glm-x', thinking: 'low' }, 'choosing a level also saves the displayed default model')
  profile.model = 'glm-y'
  profile.thinking = ''
  assert.equal(render().props.anchor.props['aria-label'], '选择模型，当前 GLM Y')
})

// Before any scan the trigger has no catalog label to show, and it must not fall
// back to the route the engine is addressed by — the model's own name is what the
// resolved picker shows afterwards, so the entry looks the same. The trigger
// keeps the bare route when no route shape matches (a hand-typed model).
test('the composer model trigger names a saved route before any catalog exists', async () => {
  const states = [], effects = []
  let cursor = 0, mounted = false
  const profile = { id: 'coder', engine: 'zcode', model: 'bigmodel-api$GLM-5.3-Flash', thinking: 'max' }
  const { ModelPicker, modelName } = await loadClient('feed.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }),
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    // An engine whose catalog was never scanned: the mount fetch answers with it
    // and nothing else, exactly as the host does before the first open.
    call: async endpoint => {
      if (endpoint === 'engine-catalog') return [{ id: 'zcode', label: 'ZCode CLI', catalog: null }]
      return { models: [] }
    },
  })
  const render = () => { cursor = 0; return ModelPicker({ profile, disabled: false, onChange: () => {} }) }
  render(); mounted = true; effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  const anchor = render().props.anchor
  assert.equal(anchor.props['aria-label'], '选择模型，当前 GLM-5.3-Flash，推理等级 max', 'the route reads as the model name')
  assert.deepEqual(anchor.children.filter(Boolean).map(child => child.children).slice(1, 3), [['GLM-5.3-Flash'], ['max']], 'the name and level are the picker\'s own two words')
  assert.equal(modelName('["mock","glm-x"]'), 'glm-x', 'the DSH JSON pair reads as its model')
  assert.equal(modelName('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4', 'a plain id keeps its own wording')
  assert.equal(modelName(''), '', 'an unset model stays empty')
})

// Each composer menu card carries the geometry of the native menu of its kind:
// the model list takes ui-model-selection `.menu` (240–420px wide, 360px tall, its
// own scroll) instead of the host Menu's window-high cap, and the add menu hangs
// from the composer card's top edge at its width — inline, like ui-input-trigger
// MenuView, so it never covers the draft and rides the card as it grows.
test('the composer menu cards take the native card geometry', () => {
  const source = clientSource('styles.js')
  assert.match(source, /\.nodo-model-list\{[^}]*max-height:min\(360px,100vh - 96px\)[^}]*\}/, 'the model list takes the native picker cap')
  assert.match(source, /\.nodo-model-list\{[^}]*min-width:min\(240px,100vw - 32px\)[^}]*max-width:min\(420px,100vw - 32px\)[^}]*\}/, 'and the native card widths')
  assert.match(source, /\.nodo-add\{[^}]*bottom:calc\(100% \+ 4px\)[^}]*left:0;right:0[^}]*max-height:min\(400px,var\(--nodo-add-space,100vh\)\)[^}]*\}/, 'the add menu pins itself above the composer card at its width, capped at the native 400px and at the room above the card')
  assert.match(source, /\.nodo-composer\{[^}]*position:relative[^}]*\}/, 'the composer card is the menu\'s containing block')
  assert.match(source, /\.nodo-add-anchor\{position:static\}/, 'the host anchor wrapper must not become the containing block')
})

// The dialog owns the engine and the model pair that seeds new conversations: it
// lists the engine's scanned models with the selected one's levels, and a save
// writes both onto the card.
test('the role dialog offers the model and thinking defaults and saves them', async () => {
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false
  const { RoleEditor, Field } = await loadRoleEditor({
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload })
      if (endpoint === 'engine-catalog') return [{ id: 'zcode', label: 'ZCode', catalog: { defaultModel: 'glm-x', source: 'mock', models: [
        { id: 'glm-x', label: 'GLM X', group: 'Mock', defaultThinking: 'high', thinking: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] },
        { id: 'glm-y', label: 'GLM Y', group: 'Other', thinking: [{ id: 'low', label: 'Low' }] } ] } },
      { id: 'mock', label: 'Mock', catalog: { defaultModel: 'mock-a', source: 'mock', models: [{ id: 'mock-a', thinking: [{ id: 'mid', label: 'Mid' }] }] } }]
      return { id: 'saved' }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const profile = { id: 'coder', name: 'Coder', engine: 'zcode', model: 'glm-x', thinking: 'high', sessions: [] }
  const render = held => { cursor = 0; return nodes(RoleEditor({ profile: held, onSaved: () => {} })) }
  const field = (held, label) => render(held).filter(node => node.type === Field).find(node => node.props.label === label)
  const select = (held, label) => field(held, label).children.filter(Boolean).find(node => node.type === 'select')
  render(profile); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(render(profile).filter(node => node.type === Field).map(node => node.props.label),
    ['名字', '身份', 'Agent', '权限', '模型', '思考档位', '职责概述', '身份信息'], 'the single page follows the specified field order')
  assert.deepEqual(render(profile).filter(node => node.type === 'select').map(node => node.props.value), ['zcode', 'glm-x', 'high'],
    'the card shows the pair it already carries')
  assert.deepEqual(select(profile, '模型').children.filter(Boolean).map(option => [option.type, option.props.label]),
    [['optgroup', 'Mock'], ['optgroup', 'Other']], 'a provider keeps its own section like the composer picker')
  select(profile, '模型').props.onChange({ target: { value: 'glm-y' } })
  assert.equal(select(profile, '思考档位').props.value, '', 'a level the next model lacks resets to following its default')
  select(profile, '模型').props.onChange({ target: { value: 'glm-x' } })
  select(profile, '思考档位').props.onChange({ target: { value: 'low' } })
  await render(profile).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const sent = requests.at(-1)
  assert.equal(sent.endpoint, 'profile-update')
  assert.deepEqual({ model: sent.payload.changes.model, thinking: sent.payload.changes.thinking }, { model: 'glm-x', thinking: 'low' },
    'the picked pair is what the card saves')
  // Nothing saved yet: the catalog's default model stands in and the level
  // selector starts at "follow the model default".
  states.length = 0; effects.length = 0; mounted = false
  render(undefined); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(['模型', '思考档位'].map(label => select(undefined, label).props.value), ['glm-x', ''],
    'an unset pair reads the model default and follows it')
  // Another engine owns another model table: the switch restarts the pair.
  select(undefined, 'Agent').props.onChange({ target: { value: 'mock' } })
  assert.deepEqual(['模型', '思考档位'].map(label => select(undefined, label).props.value), ['mock-a', ''],
    'an engine switch restarts the pair on the next engine\'s own table')
  select(undefined, '思考档位').props.onChange({ target: { value: 'mid' } })
  select(undefined, '思考档位').props.onChange({ target: { value: '' } })
  assert.equal(select(undefined, '思考档位').props.value, '', '"跟随模型默认" stays selectable and keeps the card unset')
  render(undefined).find(node => node.type === 'input' && node.props.placeholder === '例如 Coder 或 Reviewer')
    .props.onChange({ target: { value: 'Newcomer' } })
  await render(undefined).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(requests.at(-1).endpoint, 'profile-create')
  assert.deepEqual({ model: requests.at(-1).payload.model, thinking: requests.at(-1).payload.thinking }, { model: 'mock-a', thinking: '' },
    'a new role records the held pair; an empty level means the model default')
})

// A template fills 职责概述 and 身份信息 in one click and can be taken back;
// the card stays pressed only while the text still matches it.
test('a template card fills the identity fields and 撤销 restores the previous text', async () => {
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false
  const { RoleEditor } = await loadRoleEditor({
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    call: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'dsh', label: 'DSH' }]
      return { id: 'saved' }
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(RoleEditor({ onSaved: () => {} })) }
  render(); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  const cards = () => render().filter(node => node.props.className === 'nodo-template-pick')
  const nameOf = card => card.children.find(child => child?.props?.className === 'nodo-template-name').children.join('')
  const pick = name => cards().find(card => nameOf(card) === name).props.onClick()
  const pressed = () => cards().filter(card => card.props['aria-pressed']).map(nameOf)
  const roleInput = () => render().find(node => node.type === 'input' && node.props.placeholder === '一句话说明这个角色做什么')
  const identity = () => render().find(node => node.type === 'input' && node.props.className.includes('nodo-role-identity'))
  const instructions = () => render().find(node => node.type === 'textarea').props.value
  const filled = () => render().find(node => node.props.className === 'nodo-template-filled')
  assert.deepEqual(cards().map(nameOf), presets.filter(item => item.name !== 'leader').map(item => item.name), 'executor templates exclude leader')
  assert.deepEqual(pressed(), [], 'a new role starts on its own text')
  const [coder, reviewer] = ['coder', 'reviewer'].map(name => presets.find(item => item.name === name))
  pick('coder')
  assert.deepEqual(pressed(), ['coder'])
  assert.equal(identity().props.value, 'coder')
  assert.equal(roleInput().props.value, coder.role)
  assert.equal(instructions(), coder.instructions)
  assert.equal(filled().children.filter(item => typeof item === 'string').join(''), '已用「coder」填写身份、职责概述和身份信息')
  filled().children.find(item => item?.type === 'button').props.onClick()
  assert.equal(roleInput().props.value, '', '撤销 restores the text the template replaced')
  assert.equal(instructions(), '')
  assert.equal(identity().props.value, '')
  assert.equal(filled(), undefined)
  pick('coder')
  pick('reviewer')
  filled().children.find(item => item?.type === 'button').props.onClick()
  assert.equal(roleInput().props.value, coder.role, 'a second fill takes back to the first template')
  assert.equal(identity().props.value, 'coder')
  identity().props.onChange({ target: { value: 'custom' } })
  assert.deepEqual(pressed(), [], 'identity alone also affects template matching')
  pick('coder')
  roleInput().props.onChange({ target: { value: `${coder.role}，并补测试` } })
  assert.deepEqual(pressed(), [], 'an edit leaves the template')
  assert.equal(filled(), undefined)
  pick('reviewer')
  render().find(node => node.type === 'input' && node.props.placeholder === '例如 Coder 或 Reviewer')
    .props.onChange({ target: { value: 'Leader' } })
  await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const sent = requests.at(-1)
  assert.equal(sent.endpoint, 'profile-create')
  assert.equal(sent.payload.role, reviewer.role)
  assert.equal(sent.payload.instructions, reviewer.instructions)
  assert.equal(sent.payload.identity, 'reviewer', 'the template name becomes the display identity')
  assert.equal(Object.hasOwn(sent.payload, 'goal'), false, 'the editor no longer owns the goal')
})

// Customized text can be saved as a template that every later role is offered;
// the entry rides prefs, and its own card can delete it again.
test('the editor saves the current identity as a template and deletes it from its card', async () => {
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const states = [], effects = [], requests = []
  let cursor = 0, mounted = false, refreshes = 0, savedEntries = []
  const { RoleEditor, IdentityDeleteDialog } = await loadRoleEditor({
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    call: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'echo', label: 'Echo' }]
      return {}
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(RoleEditor({
    savedIdentities: savedEntries, refresh: force => { refreshes += force === true ? 1 : 0 }, onSaved: () => {},
  })) }
  const cards = () => render().filter(node => node.props.className === 'nodo-template')
  const nameOf = card => nodes(card).find(child => child.props?.className === 'nodo-template-name').children.join('')
  const saveTrigger = () => render().find(node => node.type === 'button' && node.children.join('') === '存为模板')
  const saveRow = () => render().find(node => node.props.className === 'nodo-identity-save')
  const rowButton = text => saveRow().children.find(node => node?.type === 'Button' && node.children.join('') === text)
  const nameInput = () => render().find(node => node.type === 'input' && node.props['aria-label'] === '模板名称')
  const roleInput = () => render().find(node => node.type === 'input' && node.props.placeholder === '一句话说明这个角色做什么')
  // The fake h leaves nested function components uninvoked; opening one means
  // calling it with the props the parent handed it.
  const dialog = () => {
    const owned = render().find(node => node.type === IdentityDeleteDialog)
    return owned && owned.type(owned.props)
  }
  render(); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.equal(saveTrigger().props.disabled, true, 'an empty identity offers nothing to save')
  const baseStates = states.length
  const role = '独立审查实现与风险', instructions = '你是审查员。'
  roleInput().props.onChange({ target: { value: role } })
  render().find(node => node.type === 'textarea').props.onChange({ target: { value: instructions } })
  saveTrigger().props.onClick()
  assert.ok(nameInput(), 'saving opens an inline naming row')
  assert.equal(saveTrigger().props.disabled, true, 'the open row parks its trigger')
  rowButton('保存').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.some(item => item.endpoint === 'role-preset-save'), false, 'an empty name saves nothing')
  nameInput().props.onChange({ target: { value: '审查员' } })
  rowButton('保存').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.at(-1), { endpoint: 'role-preset-save', payload: { name: '审查员', role, instructions } })
  assert.equal(refreshes, 1, 'a saved template refreshes the polled view')
  assert.equal(nameInput(), undefined, 'the naming row closes once saved')
  savedEntries = [{ name: '审查员', role, instructions, createdAt: 1 }]
  assert.deepEqual(cards().map(nameOf), [...presets.filter(item => item.name !== 'leader').map(item => item.name), '审查员'], 'saved templates follow the built-in ones')
  nodes(cards().find(card => nameOf(card) === '审查员')).find(node => node.props?.className === 'nodo-template-pick').props.onClick()
  const own = cards().find(card => nameOf(card) === '审查员')
  assert.equal(own.props['data-saved'], 'true')
  assert.equal(nodes(own).find(node => node.props?.className === 'nodo-template-pick').props['aria-pressed'], true)
  assert.equal(cards().filter(card => nodes(card).some(node => node.props?.className === 'nodo-template-remove')).length, 1,
    'only a saved template can be deleted')
  assert.equal(saveTrigger().props.disabled, true, 'a known identity offers no second copy')
  states.length = baseStates // the fake store shares one slot array across the two dialogs
  render().find(node => node.props?.['aria-label'] === '删除模板 审查员').props.onClick()
  assert.equal(dialog().props.title, '删除模板')
  assert.equal(dialog().props.description, '将删除模板“审查员”。用它填写的角色不受影响。')
  dialog().props.footer.find(item => item.children.join('') === '删除模板').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.at(-1), { endpoint: 'role-preset-delete', payload: { name: '审查员' } })
  assert.equal(refreshes, 2, 'a deleted template refreshes the polled view too')
  savedEntries = []
  assert.equal(dialog(), undefined)
  assert.deepEqual(cards().map(nameOf), presets.filter(item => item.name !== 'leader').map(item => item.name))
  assert.equal(roleInput().props.value, role, 'the identity text survives the template')
})

// Editing a role keeps its engine, says when an identity change lands, and
// confirms deletion inline before handing it to the page.
test('the role editor edits an existing role and confirms its deletion inline', async () => {
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const states = [], effects = []
  let cursor = 0, mounted = false, deleted
  const { RoleEditor } = await loadRoleEditor({
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    call: async endpoint => endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : {},
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const reviewer = presets.find(item => item.name === 'reviewer')
  const profile = { id: 'rev', name: 'Reviewer', identity: 'reviewer', engine: 'echo', role: reviewer.role, instructions: reviewer.instructions,
    sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'draft', draftedAt: 1, briefSent: false }] }
  const render = () => { cursor = 0; return nodes(RoleEditor({ profile, onSaved() {}, onCancel() {}, onDeleted: async item => { deleted = item } })) }
  const actions = () => render().find(node => node.props.className === 'nodo-role-actions').children.filter(Boolean)
  const action = text => actions().find(node => node.type === 'Button' && node.children.join('') === text)
  const confirmRow = () => render().find(node => node.props.className === 'nodo-role-confirm-row')
  const text = className => render().find(node => node.props.className === className)?.children.join('')
  const tabs = () => render().filter(node => node.props.role === 'tab')
  const pressed = () => render().filter(node => node.props.className === 'nodo-template-pick' && node.props['aria-pressed'])
  render(); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.equal(render().find(node => node.type === 'form').props['aria-label'], '配置角色')
  assert.equal(render().find(node => node.type === 'h2').children[0], 'Reviewer')
  assert.equal(render().find(node => node.props.className === 'nodo-role-head-copy').children.find(node => node?.type === 'p').children.join(''),
    'Echo，3 个会话')
  assert.deepEqual(tabs(), [])
  assert.equal(text('nodo-tag'), '执行角色')
  const select = render().find(node => node.type === 'select')
  assert.equal(select.props.disabled, true, 'the engine is fixed once created')
  assert.equal(select.props.title, '创建后不能更换 Agent')
  assert.equal(text('nodo-role-notice'), undefined, 'an untouched identity keeps the timing note quiet')
  assert.equal(pressed().length, 1)
  render().find(node => node.type === 'textarea').props.onChange({ target: { value: `${reviewer.instructions}\n- 关注前端交互。` } })
  assert.equal(text('nodo-role-notice'), '身份已修改，保存后将于下轮生效 · 影响 3 个会话', 'an edited identity raises the note')
  assert.equal(pressed().length, 0, 'the edited text no longer matches its template')
  assert.ok(action('保存') && action('取消'))
  const menu = () => actions().find(node => node.type === 'Menu')
  assert.deepEqual([...menu().props.items].map(item => item.label), ['删除角色'])
  menu().props.onSelect('delete')
  assert.equal(text('nodo-role-confirm'), '将删除角色“Reviewer”，其 3 个会话会自动归档，可在「已移除」中查看。项目目录和文件会保留。')
  confirmRow().children.find(node => node?.type === 'Button' && node.children.join('') === '取消').props.onClick()
  assert.equal(confirmRow(), undefined, 'cancelling closes the confirmation')
  assert.equal(deleted, undefined)
  menu().props.onSelect('delete')
  confirmRow().children.find(node => node?.type === 'Button' && node.children.join('') === '删除角色').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deleted, profile, 'the confirmed deletion goes to the page')
})

// The add menu copies the host's sectioned trigger menu: 添加 offers the
// workspace's files and the plan tier, 指令 the compact command and the
// engine's scanned commands; every pick lands in the draft as plain text.
test('the composer add menu offers the native sections and inserts text picks into the draft', async () => {
  const states = [], effects = [], requests = [], inserted = [], tokened = [], changed = [], requested = []
  let cursor = 0
  const { AddMenu } = await loadClient('composer.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: initial }),
      useEffect(effect) { effects.push(effect) },
    },
    async call(endpoint, payload) {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-commands') return { source: 'Claude skills and commands', commands: [{ id: 'deploy', description: 'Ship the build' }] }
      if (endpoint === 'engine-catalog') return [{ id: 'claude', capabilities: { commands: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] } },
        { id: 'pi', capabilities: { permissionModes: ['plan', 'full'] } }]
    },
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const render = (props = {}) => { cursor = 0; return AddMenu({ profile: { engine: 'claude', permission: '' }, workspace: { id: 'w1', name: 'one' }, disabled: false, trigger: null,
    onInsert: text => inserted.push(text), onToken: text => tokened.push(text), onModelChange: change => changed.push(change),
    onGoal: () => requested.push('goal'), onCompact: () => requested.push('compact'), ...props }) }
  const closed = render()
  assert.deepEqual([...closed.props.items].map(item => item.id), ['add-title', 'file', 'goal', 'cmd-title', 'hint'], 'the add section offers file and goal before the scans answer')
  closed.props.anchor.props.onClick()
  await tick(); await tick()
  assert.deepEqual(requests.filter(request => request.endpoint === 'engine-commands').map(request => ({ ...request.payload })), [{ engine: 'claude', workspace: 'w1' }])
  const open = render()
  assert.equal(open.props.open, true)
  assert.equal(open.props.portal, undefined, 'the card stays in the composer card so it can pin itself above it')
  assert.equal(open.props.listClassName, 'nodo-add')
  assert.deepEqual([...open.props.items].map(item => item.id), ['add-title', 'file', 'goal', 'plan', 'cmd-title', 'compact', 'cmd:deploy'], 'the native sections with the scanned rows')
  const withReferences = render({ onReference: () => requested.push('reference') })
  assert.ok(withReferences.props.items.some(item => item.id === 'reference'))
  withReferences.props.onSelect('reference')
  assert.equal(requested.pop(), 'reference')
  open.props.onSelect('compact')
  assert.deepEqual([...requested], ['compact'], 'compact runs the engine channel instead of touching the draft')
  assert.deepEqual([...inserted], [], 'compact never inserts text')
  const reopened = render()
  reopened.props.onSelect('cmd:deploy')
  assert.deepEqual([...inserted], ['/deploy '])
  reopened.props.onSelect('plan')
  assert.deepEqual([...changed.map(change => ({ ...change }))], [{ permission: 'plan' }])
  const asked = render()
  asked.props.onSelect('goal')
  assert.deepEqual([...requested], ['compact', 'goal'], 'the goal row opens the goal dialog')
  const planned = render({ profile: { engine: 'claude', permission: 'plan' } })
  planned.props.onSelect('plan')
  assert.deepEqual([...changed.map(change => ({ ...change }))], [{ permission: 'plan' }, { permission: 'workspace' }], 'plan toggles back to an explicit workspace tier')
  const gated = render({ profile: { engine: 'pi', permission: 'plan' } })
  assert.equal(gated.props.items.some(item => item.id === 'plan'), false,
    'an engine without a workspace tier gets no plan row: it could not leave plan and stepping up to full belongs to the role card')
  const leading = render({ profile: { engine: 'claude', permission: 'workspace', lead: true } })
  assert.equal(leading.props.items.some(item => item.id === 'plan'), false, 'a lead gets no plan row in the add menu')
  render().props.onSelect('file')
  assert.equal(inserted.at(-1), '@', 'the file row types an @ that opens the composer file card')
  const file = render({ workspace: null }).props.items.find(item => item.id === 'file')
  assert.equal(file.disabled, true, 'a file row without a workspace is disabled')
  const uploads = []
  const pickerMenu = render({ onUpload: () => uploads.push('picker') })
  assert.deepEqual([...pickerMenu.props.items].map(item => item.id).filter(id => id === 'upload' || id === 'file'), ['upload'],
    'with an upload channel the 文件 row is the system picker, not the @ card')
  pickerMenu.props.onSelect('upload')
  assert.deepEqual([...uploads], ['picker'])
  effects.length = 0
  const dollar = render({ trigger: { char: '$', start: 4, query: '' } })
  assert.equal(dollar.props.open, true, 'a live $ token holds the menu open')
  effects.at(-1)?.()
  const pane = render({ trigger: { char: '$', start: 4, query: '' } })
  assert.equal(pane.props.open, true)
  assert.deepEqual([...pane.props.items].map(item => item.id), ['cmd-title', 'compact', 'cmd:deploy'], 'the dollar token opens the commands pane alone')
  pane.props.onSelect('cmd:deploy')
  assert.deepEqual([...tokened], ['/deploy '], 'a pick from a typed token replaces the token in the draft')
  const referenced = render({ onReference: () => requested.push('reference'), trigger: { char: '/', start: 0, query: '' } })
  referenced.props.onSelect('reference')
  assert.deepEqual([...tokened], ['/deploy ', ''], 'an action picked from a typed token consumes the token')
  assert.equal(requested.pop(), 'reference')
  render({ onUpload: () => uploads.push('picker'), trigger: { char: '/', start: 0, query: '' } }).props.onSelect('upload')
  assert.deepEqual([...tokened], ['/deploy ', '', ''], 'the picker row picked from a typed token consumes the token too')
  assert.deepEqual([...uploads], ['picker', 'picker'])
  const slash = render({ trigger: { char: '/', start: 0, query: 'dep' } })
  assert.deepEqual([...slash.props.items].map(item => item.id), ['cmd-title', 'cmd:deploy'], 'the text after the trigger narrows the command rows')
  const missed = render({ trigger: { char: '/', start: 0, query: 'zz' } })
  assert.deepEqual([...missed.props.items].map(item => item.id), ['cmd-title', 'hint'], 'a query matching nothing says so instead of lying about the scan')
  assert.equal(render({ trigger: null }).props.open, false, 'whitespace or deletion ends the token and closes the menu')
  const escapee = render({ trigger: { char: '/', start: 6, query: '' } })
  escapee.props.onClose()
  assert.equal(render({ trigger: { char: '/', start: 6, query: 'de' } }).props.open, false, 'Escape dismisses the token while it keeps growing')
  assert.equal(render({ trigger: { char: '/', start: 9, query: '' } }).props.open, true, 'a token typed elsewhere opens the menu again')

})

test('the new composer offers references through @ without a recipient and enables reference-only messages', async () => {
  const edits = [], opened = [], removed = []
  const { Composer, AddMenu } = await loadClient('composer.js', {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: { useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {} },
    uiShared: { ComposerGlyph: () => 'Send' },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []
  const props = { workspace: { id: 'w' }, images: [], value: '请参考 @', onChange: value => edits.push(value), onSend() {},
    onReference: value => opened.push(value), onRemoveReference: id => removed.push(id) }
  const tree = Composer(props), menu = all(tree).find(node => node.type === 'Menu')
  assert.ok(menu.props.items.some(item => item.id === 'reference'))
  menu.props.onSelect('reference')
  assert.deepEqual(edits, ['请参考 '])
  assert.equal(opened.length, 1)
  assert.equal(all(tree).find(node => node.type === AddMenu).props.profile.engine, '')
  const attached = Composer({ ...props, value: '', references: [{ id: 'snapshot', label: 'Planner · Plan' }] })
  assert.equal(all(attached).find(node => node.type === 'Tooltip').props.children.props.disabled, false)
  all(attached).find(node => node.props['aria-label'] === '移除引用 Planner · Plan').props.onClick()
  assert.deepEqual(removed, ['snapshot'])
})

test('the @ file card lists workspace files with the file glyph', async () => {
  let cursor = 0
  const states = []
  const { Composer } = await loadClient('composer.js', {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: {
      useState: initial => {
        const at = cursor++
        if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
        return [states[at], next => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
      },
      useRef: initial => ({ current: initial }),
      useEffect: effect => { effect() },
    },
    globals: { setTimeout: fn => { fn(); return 0 }, clearTimeout() {} },
    uiShared: { ComposerGlyph: () => 'Send', call: async endpoint => endpoint === 'workspace-files' ? { files: ['docs/architecture.md'] } : { files: [] } },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []
  const props = { workspace: { id: 'w' }, images: [], value: '@', onChange() {}, onSend() {} }
  const render = () => { cursor = 0; return Composer(props) }
  render()
  await new Promise(resolve => setImmediate(resolve))
  const items = all(render()).find(node => node.type === 'Menu').props.items
  const row = items.find(item => item.id === 'file:docs/architecture.md')
  assert.equal(row.icon.type, 'IconPaperclipOutlineRegular', 'workspace file rows carry the file glyph like the native menu')
  assert.deepEqual(row.label.children.map(child => child.children).flat(), ['architecture.md', 'docs/architecture.md'])
})

test('the new conversation feeds picker files into the draft and sends documents as workspace paths', async () => {
  const calls = []
  let cursor = 0
  const view = { profiles: [{ id: 'role', name: '开发', engine: 'echo', sessions: [] }], workspaces: [{ id: 'project', name: '项目', cwd: '/tmp' }] }
  const { createNewConversation, Composer } = await loadClient(['new-conversation.js', 'composer.js'], {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: {
      useState: initial => {
        const at = cursor++
        if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
        return [states[at], next => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
      },
      useRef: initial => ({ current: initial }), useEffect: () => {},
    },
    uiShared: {
      useStateView: () => ({ view, error: '' }),
      readImage: async file => file,
      call: async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        if (endpoint === 'attachment-save') return { images: [], files: [{ id: '11111111-1111-1111-1111-111111111111', name: 'spec.pdf' }] }
        if (endpoint === 'attachment-place') return { files: ['/tmp/.nodo/workflow-inputs/task-1/1-spec.pdf'], text: '## Attached files (user provided)\n- "/tmp/.nodo/workflow-inputs/task-1/1-spec.pdf"' }
        if (endpoint === 'session-create') return { id: 'session-1' }
        return {}
      },
    },
    globals: {
      crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
      localStorage: { getItem: key => key === 'nodo.navigation' ? JSON.stringify({ profile: 'role', workspace: 'project' }) : null, setItem() {} },
    },
  })
  const states = []
  const { NewConversation } = createNewConversation({ uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'native-1' }) } } } }, { getSnapshot: () => ({ active: true }), showLegacy() {}, endDraft() {}, open() {} }, 'ReferenceDialog')
  const all = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []
  const render = () => { cursor = 0; return all(NewConversation({ sourceSessionId: 'native-1' })).find(node => node.type === Composer).props }
  const composer = render()
  await composer.onAttachFiles([
    { name: 'shot.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
    { name: 'spec.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,Qg==' },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.endpoint === 'attachment-save').payload.files)), [{ name: 'spec.pdf', mediaType: 'application/pdf', data: 'Qg==' }])
  const loaded = render()
  assert.equal(loaded.images[0].name, 'shot.png', 'images ride the draft inline')
  assert.equal(loaded.files[0].name, 'spec.pdf')
  loaded.onRemoveFile(0)
  await render().onAttachFiles([{ name: 'spec.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,Qg==' }])
  render().onChange('看下这份规格')
  render().onSend()
  for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(call => call.endpoint === 'attachment-place'), false, 'the plugin route hands refs to send; placement stays host-side')
  const sent = calls.find(call => call.endpoint === 'send')
  assert.equal(sent.payload.text, '看下这份规格', 'the echoed text stays clean; the path block never reaches the bubble')
  assert.deepEqual(JSON.parse(JSON.stringify(sent.payload.files)), [{ id: '11111111-1111-1111-1111-111111111111', name: 'spec.pdf' }])
  assert.deepEqual(JSON.parse(JSON.stringify(sent.payload.images)), [{ mediaType: 'image/png', name: 'shot.png', data: 'AAAA' }])
})

test('the responsibilities dialog retains the goal field and saves it trimmed', async () => {
  const states = [], saved = []
  let cursor = 0
  const { GoalDialog } = await loadClient('composer.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
    },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return GoalDialog({ profile: { goal: '  ship it  ' }, onSaved: value => saved.push(value), onCancel() {} }) }
  assert.equal(render().props.title, '角色职责')
  const box = nodes(render()).find(node => node.props?.className?.includes?.('nodo-dialog-textarea'))
  assert.equal(box.props.value, '  ship it  ', 'the dialog opens with the saved goal')
  box.props.onChange({ target: { value: '  port the tests  ' } })
  const form = nodes(render()).find(node => node.props?.id === 'nodo-goal-form')
  assert.equal(form.props['aria-label'], '角色职责')
  form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual([...saved], ['port the tests'])
})

test('shared composer accepts file paste, drop and picker input without changing ordinary image paste', async () => {
  const attachments = [], images = []
  const { Composer, AddMenu } = await loadClient('composer.js', {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: { useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {} },
    uiShared: { ComposerGlyph: () => 'Send' },
  })
  const props = { profile: { engine: 'echo' }, value: '任务', images: [], files: [], readOnly: false, busy: false,
    onSend() {}, onChange() {}, onInsert() {}, onAttach: files => images.push(...files), onAttachFiles: files => attachments.push(...files) }
  const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []
  const tree = Composer(props)
  const textarea = all(tree).find(item => item.type === 'textarea')
  const file = { name: 'requirements.pdf', type: 'application/pdf' }
  let prevented = 0
  const paste = value => ({ clipboardData: { items: [{ kind: 'file', type: value.type, getAsFile: () => value }] }, preventDefault() { prevented++ } })
  textarea.props.onPaste(paste(file))
  assert.deepEqual(attachments, [file])
  assert.equal(prevented, 1)
  tree.props.onDrop({ dataTransfer: { files: [file] }, preventDefault() {} })
  assert.equal(attachments.length, 2)
  tree.props.onDrop({ dataTransfer: { files: [] }, preventDefault() { assert.fail('ordinary text drops keep their native editing behavior') } })
  const picker = all(tree).find(item => item.type === 'input' && item.props.type === 'file')
  const target = { files: [file], value: 'selected-file' }
  picker.props.onChange({ target })
  assert.equal(target.value, '')
  assert.equal(attachments.length, 3)
  let clicks = 0
  picker.props.ref.current = { click() { clicks++ } }
  all(tree).find(item => item.type === AddMenu).props.onUpload()
  assert.equal(clicks, 1)
  assert.equal(all(tree).find(item => item.type === 'Tooltip').props.children.props['aria-label'], '发送消息')
  const ordinary = Composer({ ...props, onAttachFiles: undefined })
  const input = all(ordinary).find(item => item.type === 'textarea')
  input.props.onPaste(paste(file))
  assert.equal(attachments.length, 3)
  const image = { name: 'image.png', type: 'image/png' }
  input.props.onPaste(paste(image))
  assert.deepEqual(images, [image])
  const readonly = Composer({ ...props, readOnly: true })
  all(readonly).find(item => item.type === 'textarea').props.onPaste(paste(file))
  assert.equal(attachments.length, 3)
})

test('a composer image attachment opens the host lightbox for the original image', async () => {
  let preview = null
  const { Composer, ComposerAttachmentChip } = await loadClient(['composer.js', 'composer-attachments.tsx'], {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: { useState: value => value === null ? [preview, next => { preview = next }] : [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {} },
    primitives: { ImageLightbox: 'ImageLightbox' },
    uiShared: { ComposerGlyph: () => 'Send' },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []
  const props = { value: '', images: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AA' }, { name: 'loading.png' }], onChange() {}, onRemoveImage() {} }
  const chips = all(Composer(props)).filter(item => item.type === ComposerAttachmentChip)
  assert.equal(chips[1].props.onPreview, undefined, 'an image still loading has nothing to enlarge')
  assert.equal(all(Composer(props)).some(item => item.type === 'ImageLightbox'), false)
  const open = all(ComposerAttachmentChip(chips[0].props)).find(item => item.props['aria-label'] === '预览图片 shot.png')
  open.props.onClick()
  const lightbox = all(Composer(props)).find(item => item.type === 'ImageLightbox')
  assert.equal(lightbox.props.src, 'data:image/png;base64,AA')
  lightbox.props.onClose()
  assert.equal(preview, null)
})

test('the composer drops its submit button without onSend and leaves Enter to the textarea', async () => {
  const { Composer } = await loadClient('composer.js', {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: { useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {} },
    uiShared: { ComposerGlyph: running => running ? 'Stop' : 'Send' },
    stubs: { 'feed.js': { ModelPicker: 'ModelPicker' } },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []
  const tooltip = tree => all(tree).find(item => item.type === 'Tooltip')
  const submit = tree => tooltip(tree).props.children
  const silent = Composer({ value: '任务', images: [], rolePicker: { type: 'RolePicker', props: {}, children: [] }, onModelChange() {} })
  assert.equal(tooltip(silent), undefined, 'no send or save button is drawn')
  assert.deepEqual(all(silent).find(item => item.props.className === 'nodo-composer-row').children.slice(1).map(item => item.type), ['RolePicker', 'ModelPicker'], 'role and model controls close the row directly')
  assert.doesNotMatch(clientSource('styles.js'), /nodo-composer-target/)
  assert.match(clientSource('styles.js'), /\.nodo-composer-tools\{[^}]*margin-right:auto/)
  assert.doesNotMatch(clientSource('styles.js'), /\.nodo-model\{[^}]*margin-left:auto/, 'a second auto margin would center the role seat in the row')
  all(silent).find(item => item.type === 'textarea').props.onKeyDown({ key: 'Enter', preventDefault() { assert.fail('Enter inserts a line break when there is nothing to send') } })
  silent.props.onSubmit({ preventDefault() {} })
  let sends = 0
  const props = { value: 'hello', images: [], onSend() { sends++ } }
  let tree = Composer(props)
  assert.equal(submit(tree).children[0], 'Send')
  assert.equal(submit(tree).props.disabled, false)
  tree.props.onSubmit({ preventDefault() {} })
  all(tree).find(item => item.type === 'textarea').props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.equal(sends, 2)
  for (const blocked of [{ value: '' }, { readOnly: true }, { busy: true }]) {
    tree = Composer({ ...props, ...blocked })
    assert.equal(submit(tree).props.disabled, true)
    tree.props.onSubmit({ preventDefault() {} })
    all(tree).find(item => item.type === 'textarea').props.onKeyDown({ key: 'Enter', preventDefault() {} })
    assert.equal(sends, 2)
  }
  assert.equal(submit(Composer({ value: '', images: [], running: true, onSend() {} })).children[0], 'Stop')
})

test('the composer model trigger drops to its icon when the control row overflows', async () => {
  const effects = [], observed = []
  const { Composer } = await loadClient('composer.js', {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    react: { useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: effect => effects.push(effect) },
    uiShared: { ComposerGlyph: () => 'Send' },
    globals: {
      ResizeObserver: class { constructor(callback) { observed.push(callback) } observe() {} disconnect() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ columnGap: '12px', paddingLeft: '8px', paddingRight: '8px' }),
    },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []
  const tree = Composer({ value: '', images: [] })
  const attributes = new Set(), widths = [200, 260, 34]
  let width = 600
  all(tree).find(item => item.props.className === 'nodo-composer-row').props.ref.current = {
    children: widths.map((_, i) => ({ getBoundingClientRect: () => ({ width: widths[i] }) })),
    getBoundingClientRect: () => ({ width }),
    removeAttribute: name => attributes.delete(name),
    toggleAttribute: (name, on) => on ? attributes.add(name) : attributes.delete(name),
  }
  effects.forEach(effect => effect())
  assert.equal(attributes.has('data-model-compact'), false, '494 + 24 gaps fit in 584')
  width = 500
  observed.at(-1)()
  assert.equal(attributes.has('data-model-compact'), true)
  width = 600
  observed.at(-1)()
  assert.equal(attributes.has('data-model-compact'), false, 'the text returns once there is room')
})

test('the composer file card reads the @ being typed: at a line start or after a space, up to the first space', async () => {
  const { mentionOf } = await loadClient('composer.js')
  assert.deepEqual({ ...mentionOf('@') }, { at: 0, query: '' })
  assert.deepEqual({ ...mentionOf('see @src/ma') }, { at: 4, query: 'src/ma' })
  assert.equal(mentionOf('mail@host'), null, 'an @ inside a word is plain text')
  assert.equal(mentionOf('@a.md done'), null, 'a space after the query closes the card')
  assert.equal(mentionOf('plain text'), null)
})

test('the composer command token reads a / or $ from a line start or after a space, never inside a word', async () => {
  const { triggerOf } = await loadClient('composer.js')
  assert.deepEqual({ ...triggerOf('/') }, { char: '/', start: 0, query: '' })
  assert.deepEqual({ ...triggerOf('see /deploy') }, { char: '/', start: 4, query: 'deploy' })
  assert.deepEqual({ ...triggerOf('$') }, { char: '$', start: 0, query: '' })
  assert.equal(triggerOf('mail/list'), null, 'a slash inside a word is plain text')
  assert.equal(triggerOf('https://host'), null, 'a URL keeps its slashes')
  assert.equal(triggerOf('sent /done '), null, 'a space after the token closes the menu')
  assert.equal(triggerOf('plain text'), null)
})

// The permission control is the host's own PermissionSelect copy: kit glyphs on
// trigger and rows, only the tiers the engine declares,
// and the native risk confirmation gating the full tier. The catalog is
// re-read when a role moves engines, so a stale engine's tiers never show.
test('the permission control copies the native select, glyphs and full-tier confirmation', async () => {
  const states = [], refs = [], requests = []
  let dshModes = ['workspace']
  let cursor = 0, refCursor = 0
  const { PermissionMenu } = await loadClient('composer.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef(initial) {
        const index = refCursor++
        if (!(index in refs)) refs[index] = { current: initial }
        return refs[index]
      },
    },
    primitives: { RiskConfirmation: 'Risk', PermissionIconReadOnlyRegular: 'GlyphPlan', PermissionIconWorkspaceWriteRegular: 'GlyphWorkspace', PermissionIconFullAccessRegular: 'GlyphFull' },
    call: async (endpoint, payload) => {
      requests.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'zcode', capabilities: { permissionModes: ['plan', 'workspace', 'full'] } },
        { id: 'dsh', capabilities: { permissionModes: dshModes } },
        { id: 'unavailable', capabilities: { permissionModes: [] } }]
    },
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const changes = []
  const render = profile => { cursor = 0; refCursor = 0; return nodes(PermissionMenu({ profile, disabled: false, onChange: change => changes.push(change) })) }
  const menuOf = tree => tree.find(node => node.type === 'Menu')
  const closed = render({ engine: 'zcode', permission: 'workspace' })
  assert.ok(menuOf(closed).props.anchor.props['aria-label'].includes('工作区内修改'), 'the explicit tier labels the trigger')
  assert.deepEqual([...menuOf(closed).props.items].map(item => item.id), ['workspace'], 'only the current tier shows before the catalog answers')
  menuOf(closed).props.anchor.props.onClick()
  await tick(); await tick()
  assert.equal(requests.at(-1).endpoint, 'engine-catalog')
  const open = menuOf(render({ engine: 'zcode', permission: 'workspace' }))
  assert.deepEqual([...open.props.items].map(item => item.id), ['plan', 'workspace', 'full'])
  assert.deepEqual([...open.props.items.map(item => item.icon.type)], ['GlyphPlan', 'GlyphWorkspace', 'GlyphFull'], 'native permission glyphs ride the rows')
  assert.equal(open.props.selectedId, 'workspace')
  open.props.onSelect('plan')
  assert.deepEqual([...changes.map(change => ({ ...change }))], [{ permission: 'plan' }])
  changes.length = 0
  // The top tier opens the native risk confirmation; only confirming applies it.
  open.props.onSelect('full')
  const gated = render({ engine: 'zcode', permission: 'workspace' })
  const risk = gated.find(node => node.type === 'Risk')
  assert.ok(risk, 'the full tier asks for confirmation')
  assert.equal(risk.props.title, '确认启用完全权限？')
  assert.deepEqual([...changes.map(change => ({ ...change }))], [])
  risk.props.onConfirm()
  assert.deepEqual([...changes.map(change => ({ ...change }))], [{ permission: 'full' }])
  changes.length = 0
  menuOf(render({ engine: 'zcode', permission: 'full' })).props.onSelect('workspace')
  assert.deepEqual([...changes.map(change => ({ ...change }))], [{ permission: 'workspace' }], 'workspace is saved explicitly for every engine')
  changes.length = 0
  assert.deepEqual([...menuOf(render({ engine: 'zcode', permission: 'full', lead: true })).props.items].map(item => item.id),
    ['workspace', 'full'], 'a lead is offered no plan tier')
  const dshClosed = render({ engine: 'dsh', permission: 'full' })
  menuOf(dshClosed).props.anchor.props.onClick()
  await tick(); await tick()
  assert.equal(requests.filter(request => request.endpoint === 'engine-catalog').length, 2, 'a role moved to another engine re-reads the catalog')
  const dshOpen = menuOf(render({ engine: 'dsh', permission: 'full' }))
  assert.deepEqual([...dshOpen.props.items].map(item => item.id), ['workspace'], 'an engine without a tier does not offer it')
  dshOpen.props.onSelect('workspace')
  assert.deepEqual([...changes.map(change => ({ ...change }))], [{ permission: 'workspace' }], 'DSH needs an explicit tier to leave full access instead of preserving the native selection')
  menuOf(render({ engine: 'unavailable', permission: '' })).props.anchor.props.onClick()
  await tick(); await tick()
  assert.deepEqual([...menuOf(render({ engine: 'unavailable', permission: '' })).props.items], [], 'a host without permission presets must not gain a workspace option')
  dshModes = []
  menuOf(render({ engine: 'dsh', permission: 'workspace' })).props.anchor.props.onClick()
  await tick(); await tick()
  const inherited = menuOf(render({ engine: 'dsh', permission: 'workspace' }))
  assert.deepEqual([...inherited.props.items], [])
  assert.equal(inherited.props.anchor.props.disabled, true, 'a host without presets has a disabled placeholder')
  assert.ok(inherited.props.anchor.children.some(node => node.children?.includes('无可用权限档位')))
})

// The statistics line is the host chat's own three pills, and both it and the
// dialog it opens must leave out a figure the session has no data for instead of
// showing a zero. The helpers and the three components share one slice so the
// test exercises the real number words, not copies of them.
const statsUi = async () => {
  const { SessionStats, TurnUsage, StatsDialog } = await loadClient('feed.js', {
    primitives: { IconGaugeOutlineRegular: 'Gauge' },
  })
  return { SessionStats, TurnUsage, StatsDialog }
}

const emptyStats = () => ({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextUsed: 0, contextSize: 0 })

test('the statistics line shows the host chat groups and hides what the session lacks', async () => {
  const source = clientSource('page.js')
  const { SessionStats } = await statsUi()
  const opened = []
  const groups = stats => SessionStats({ stats, onOpen: () => opened.push(true) })

  const full = groups({ ...emptyStats(), turns: 2, steps: 134, decodeMs: 2000, decodeTokens: 132,
    inputTokens: 1000, cacheReadTokens: 900000, outputTokens: 5000, contextUsed: 1400, contextSize: 10000 })
  assert.equal(full.props.className, 'nodo-stats-pill', 'the line itself is the pill button')
  const text = full.children.map(node => node.children.at(-1).children.join(''))
  assert.deepEqual(text, ['2 轮 134 步 · 66 tok/s', '906K tok · 缓存命中 99.9%', '14%'],
    'rounds and decode speed, the compact token total with the cache share, then the context window')
  full.props.onClick()
  assert.deepEqual([...opened], [true], 'the line opens the dialog')

  const partial = groups({ ...emptyStats(), turns: 1, inputTokens: 100, outputTokens: 50 })
  assert.deepEqual(full.children.map(node => node.children.filter(child => child.type !== 'span').map(child => child.type)), [[], [], ['Gauge']],
    'only context occupancy needs a statistics icon')
  assert.deepEqual(partial.children.map(node => node.children.at(-1).children.join('')), ['1 轮 0 步', '150 tok'],
    'a session without timing or a window shows only what it has')
  assert.equal(groups({ ...emptyStats() }), null, 'a session with nothing to report draws no line at all')
  assert.equal(groups(undefined), null)
  // The row that holds the line is the composer's own dock: it is drawn with the
  // composer, before the session has a figure, so the input card never moves.
  assert.match(source, /h\('div', \{ className: 'nodo-stats' \},\s*\n\s*h\(SessionStats/,
    'the composer always draws the statistics dock, empty or not')
})

test('the turn usage caption prints the buckets and stays away when there are none', async () => {
  const { TurnUsage } = await statsUi()
  const caption = TurnUsage({ usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 900000, cacheWriteTokens: 0 } })
  assert.equal(caption.props.className, 'nodo-turn-usage')
  assert.deepEqual(caption.children, ['902K tok'], 'the caption counts every bucket')
  assert.equal(TurnUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), null)
  assert.equal(TurnUsage({ usage: undefined }), null, 'a turn the engine reported nothing for keeps no caption')
})

test('the statistics dialog lists the buckets, times and speed the session has', async () => {
  const { StatsDialog } = await statsUi()
  const dialog = StatsDialog({ stats: { ...emptyStats(), turns: 2, steps: 134, llmMs: 65000, toolMs: 4000,
    ttftMs: 800, ttftSteps: 2, decodeMs: 2000, decodeTokens: 132, inputTokens: 1000, cacheReadTokens: 900000, cacheWriteTokens: 20,
    outputTokens: 5000, contextUsed: 1400, contextSize: 10000 }, onClose: () => {} })
  const sections = dialog.children[0].children.filter(node => node.props.className === 'nodo-stats-section')
  assert.deepEqual(sections.map(section => section.children[0].children.join('')), ['Token 用量', '用时与速度'])
  const rows = sections.flatMap(section => section.children.slice(1).filter(node => node.props.className === 'nodo-stats-row'))
  const listed = rows.map(row => [row.children[0].children.join(''), row.children[1].children.join('')])
  assert.deepEqual(listed, [
    ['未缓存输入', '1,000'], ['缓存读取', '900,000'], ['缓存写入', '20'], ['输出', '5,000'], ['缓存命中', '99.9%'],
    ['轮次 / 步数', '2 轮 134 步'], ['模型用时', '1分5秒'], ['工具调用用时', '4秒'],
    ['首 token 平均（TTFT）', '0.4秒'], ['输出速度（TPS）', '66 tok/s'], ['上下文', '1,400 / 10,000（14%）'],
  ])
  const hollow = StatsDialog({ stats: { ...emptyStats(), turns: 1, ttftSteps: 3 }, onClose: () => {} })
  const hollowRows = hollow.children[0].children.filter(node => node?.props?.className === 'nodo-stats-section')
    .flatMap(section => section.children.slice(1).filter(node => node?.props?.className === 'nodo-stats-row'))
  assert.ok(!hollowRows.some(row => row.children[0].children.includes('首 token 平均（TTFT）')),
    'steps without a measured span show no average instead of 0 ms')
})

test('the reference dialog keeps its frame still and scrolls the reply pane', () => {
  const source = clientSource('session-references.js')
  const rule = selector => source.match(new RegExp(`\\${selector}\\{([^}]*)\\}`))?.[1] ?? ''
  assert.match(rule('.nodo-reference-dialog'), /max-height:calc\(100vh - 120px\)/, 'the card must fit the viewport instead of growing past it')
  const layout = rule('.nodo-reference-layout')
  assert.match(layout, /height:min\(/, 'the layout needs a definite height, or the reply pane has nothing to scroll inside')
  assert.doesNotMatch(layout, /max-height/, 'a max-height lets flex content push the card out of the viewport')
  const preview = rule('.nodo-reference-preview')
  assert.match(preview, /overflow:auto/)
  assert.match(preview, /min-height:0/, 'a flex item needs min-height:0 before it can scroll on its own')
})

test('the rail marks the roles view pressed and shows its published body', async () => {
  assert.match(clientSource('index.js'), /register\(\{ name: 'main', key: 'nodo-roles' \}, RolesEntry\)/)
  assert.match(clientSource('ui-shared.js'), /work: answer\.work, approvals: answer\.approvals, stats: answer\.stats/)
  const { Rail } = await loadRail({ useState: initial => [initial, () => {}] })
  const content = { type: 'nav', props: {}, children: ['角色列表'] }
  const calls = []
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const render = navigation => Rail({ view: { profiles: [], workspaces: [] }, navigation,
    onSessions: () => calls.push('sessions'), onRoles: () => calls.push('roles') })
  const tree = render({ view: 'roles', content })
  assert.equal(tree.props['aria-label'], '角色导航')
  assert.ok(nodes(tree).includes(content))
  const [sessions, roles] = nodes(tree).find(node => node.props.className === 'nodo-rail-switch').children.map(tip => tip.children[0])
  assert.deepEqual([sessions.props['aria-pressed'], roles.props['aria-pressed']], [false, true])
  assert.equal(roles.props.onClick, undefined, 'the current view is not a link to itself')
  sessions.props.onClick()
  assert.deepEqual(calls, ['sessions'])
  const plain = render(null)
  assert.equal(plain.props['aria-label'], '角色与项目会话')
  const [idle] = nodes(plain).find(node => node.props.className === 'nodo-rail-switch').children.map(tip => tip.children[0])
  assert.equal(idle.props['aria-pressed'], true)
  assert.ok(nodes(plain).some(node => node.props.className === 'nodo-roster'), 'without a published view the roster returns')
})

// The roles page is the single place roles are configured. The rail body lists
// the roster with drag and keyboard ordering; the main area edits the picked role
// or the task-type catalog; switching with unsaved edits asks first.
const loadRolesPage = async options => loadClient(['roles.tsx', 'profile-dialogs.js', 'avatar.tsx'], options)

const rolesReact = (states, pendingEffects) => ({
  useState(initial) {
    const at = cursor++
    if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
    return [states[at], next => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
  },
  useRef(initial) { const at = cursor++; return states[at] ??= { current: initial } },
  useEffect(effect) { pendingEffects.push(effect) },
})
let cursor = 0

test('the single-page editor scopes templates by role kind and reports all template edits', async () => {
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const own = { name: '前端编码', role: '前端实现', instructions: '检查布局' }
  for (const lead of [true, false]) {
    const dirty = []
    const { RoleEditor, Field, host } = await loadRoleEditor({ call: async endpoint => endpoint === 'engine-catalog'
      ? [{ id: 'echo', catalog: { models: [] } }] : {} })
    const profile = { id: 'role', name: 'Role', engine: 'echo', lead, instructions: 'original', sessions: [] }
    const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
    const render = () => { host.reset(); const tree = nodes(RoleEditor({ profile, savedIdentities: [own], onSaved() {},
      onDirtyChange: value => dirty.push(value) })); host.effects.splice(0).forEach(effect => effect()); return tree }
    render(); await new Promise(resolve => setImmediate(resolve))
    const cards = () => render().filter(node => node.props.className === 'nodo-template-pick')
    const names = () => cards().map(card => card.children[0].children[0])
    assert.deepEqual(names(), lead ? ['leader'] : [...presets.filter(item => item.name !== 'leader').map(item => item.name), own.name])
    assert.equal(render().some(node => node.children.includes('存为模板')), !lead)
    assert.equal(render().some(node => node.props.role === 'tablist' || node.props.role === 'tabpanel' || node.props.className === 'nodo-role-kind'), false)
    assert.equal(render().some(node => node.props.role === 'switch'), false)
    assert.equal(render().filter(node => node.type === Field).some(node => node.props.label === '任务类型'), false)
    const template = lead ? presets.find(item => item.name === 'leader') : own
    const chosen = cards().find(card => card.children[0].children[0] === template.name)
    assert.equal(chosen.props.title, template.role)
    assert.equal(chosen.children.length, 1, 'template pills show only their names')
    chosen.props.onClick()
    assert.equal(dirty.at(-1), false)
    const tree = render()
    assert.equal(dirty.at(-1), true, 'template edits reach the page guard')
    const input = label => tree.find(node => node.type === Field && node.props.label === label).children[0]
    assert.equal(input('身份').props.value, template.name)
    assert.equal(input('职责概述').children[0].props.value, template.role)
    assert.equal(input('身份信息').children[0].props.value, template.instructions)
    assert.equal(cards().find(card => card.props['aria-pressed']).children[0].children[0], template.name)
    input('身份').props.onChange({ target: { value: '自由身份' } })
    assert.equal(cards().some(card => card.props['aria-pressed']), false)
    assert.equal(render().find(node => node.props.className === 'nodo-tag').children[0], lead ? '主控' : '执行角色')
  }
})

test('the task type page keeps ids on saved rows, omits them on new rows, confirms removals in use inline and caps at twenty', async () => {
  const states = [], pending = []
  cursor = 0
  const calls = []
  const view = {
    profiles: [
      { id: 'a', name: 'Writer', taskTypes: ['docs'], sessions: [] },
      { id: 'b', name: 'Reviewer', taskTypes: ['docs', 'review'], sessions: [] },
    ],
    workspaces: [], work: {},
    taskTypes: [{ id: 'docs', name: '文档', when: '' }, { id: 'review', name: '审查', when: '代码评审' }, { id: 'ops', name: '运维', when: '' }],
  }
  const { TaskTypesEditor, RoleAvatar } = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint !== 'task-types-update') return payload?.types ?? []
      return payload.types.map(item => item.id !== undefined
        ? { id: item.id, name: item.name, when: item.when }
        : { id: `fresh:${item.name}`, name: item.name, when: item.when })
    },
  })
  const all = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(all)] : []
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const remount = () => { cursor = 0; states.length = 0; return all(TaskTypesEditor({ view, disabled: false, onDone: async () => {} })) }
  const render = () => { cursor = 0; return all(TaskTypesEditor({ view, disabled: false, onDone: async () => {} })) }
  const rows = () => render().filter(node => node.props?.className === 'nodo-type-row')
  const nameInput = row => row.children.find(node => node.props['aria-label'] === '任务类型名称')
  const names = () => rows().map(row => nameInput(row).props.value)
  const button = label => render().find(node => node.type === 'Button' && node.children.includes(label))
  const confirmRow = () => render().find(node => node.props?.className === 'nodo-type-confirm')
  const remove = name => render().find(node => node.props?.['aria-label'] === `删除类型 ${name}`).props.onClick()

  assert.deepEqual(remount().filter(node => node.props?.className === 'nodo-type-row').map(row => nameInput(row).props.value), ['文档', '审查', '运维'])
  assert.equal(render().find(node => node.props?.className === 'nodo-types-count').children.join(''), '3 / 20')
  const takers = row => row.children.find(node => node.props?.className === 'nodo-type-takers')
  assert.deepEqual(rows().map(row => all(takers(row)).filter(node => node.type === RoleAvatar).map(node => node.props.profile.name)),
    [['Writer', 'Reviewer'], ['Reviewer'], []])
  assert.equal(all(takers(rows()[2])).find(node => node.props?.className === 'nodo-roles-miss').children.join(''), '无人承接')
  assert.equal(button('保存'), undefined, 'a clean catalog shows no save bar')
  button('添加类型').props.onClick()
  assert.equal(rows().length, 4)
  nameInput(rows()[3]).props.onChange({ target: { value: '新类型' } })
  button('保存').props.onClick()
  await tick(); await tick()
  const saved = calls.at(-1)
  assert.equal(saved.endpoint, 'task-types-update')
  assert.deepEqual(saved.payload.types.map(item => [Object.hasOwn(item, 'id') ? item.id : null, item.name]),
    [['docs', '文档'], ['review', '审查'], ['ops', '运维'], [null, '新类型']], 'saved rows keep their id, a new row carries no id key')

  calls.length = 0
  remount()
  remove('运维')
  assert.deepEqual(names(), ['文档', '审查'], 'a type nobody takes leaves at once')
  assert.equal(confirmRow(), undefined)
  remove('文档')
  assert.equal(render().some(node => node.type === 'Modal'), false, 'a type in use confirms in its own row, not in a dialog')
  assert.equal(confirmRow().children.find(node => node.type === 'span').children.join(''), '将从 Writer、Reviewer 上移除')
  confirmRow().children.find(node => node.children.includes('取消')).props.onClick()
  assert.equal(confirmRow(), undefined)
  assert.deepEqual(names(), ['文档', '审查'], '取消 keeps the type')
  remove('文档')
  confirmRow().children.find(node => node.children.includes('删除')).props.onClick()
  assert.deepEqual(names(), ['审查'])
  button('放弃').props.onClick()
  assert.deepEqual(names(), ['文档', '审查', '运维'], '放弃 restores the saved catalog')
  assert.equal(button('保存'), undefined)
  remove('文档')
  confirmRow().children.find(node => node.children.includes('删除')).props.onClick()
  button('保存').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls.at(-1).payload.types, [{ id: 'review', name: '审查', when: '代码评审' }, { id: 'ops', name: '运维', when: '' }])

  // The page learns about unsaved catalog edits, and a saved draft adopts the
  // ids core issued so it stops looking dirty instead of re-issuing them.
  cursor = 0; states.length = 0; pending.length = 0
  const reports = []
  let savedTypes = null
  view.taskTypes = [{ id: 'docs', name: '文档', when: '' }]
  const live = () => { cursor = 0; const tree = all(TaskTypesEditor({ view, disabled: false,
    onDone: async () => { view.taskTypes = savedTypes },
    onDirtyChange: value => reports.push(value) }))
    pending.splice(0).forEach(effect => effect()); return tree }
  live()
  assert.equal(reports.at(-1), false, 'a fresh catalog starts clean')
  live().find(node => node.type === 'Button' && node.children.includes('添加类型')).props.onClick()
  live().filter(node => node.props?.className === 'nodo-type-row').at(-1).children
    .find(node => node.props['aria-label'] === '任务类型名称').props.onChange({ target: { value: '新增' } })
  live()
  assert.equal(reports.at(-1), true, 'catalog edits reach the page through onDirtyChange')
  savedTypes = [{ id: 'docs', name: '文档', when: '' }, { id: 'fresh:新增', name: '新增', when: '' }]
  live().find(node => node.type === 'Button' && node.children.includes('保存')).props.onClick()
  await tick(); await tick(); await tick()
  live()
  assert.equal(reports.at(-1), false, 'the saved draft adopts the issued ids and turns clean')
  assert.equal(live().find(node => node.type === 'Button' && node.children.includes('保存')), undefined, 'a saved catalog drops its save bar')

  cursor = 0; states.length = 0
  const capped = { ...view, taskTypes: Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, name: `类型${index}`, when: '' })) }
  const capTree = all(TaskTypesEditor({ view: capped, disabled: false, onDone: async () => {} }))
  assert.equal(capTree.find(node => node.type === 'Button' && node.children.includes('添加类型')).props.disabled, true, 'twenty types fill the catalog')
})

// The overview tree reaches into Menu anchors and items through props.
const rolesTree = node => node && typeof node === 'object'
  ? [node, ...[...(node.children ?? []), ...Object.values(node.props ?? {})].flatMap(rolesTree)] : []
const rolesText = node => ['string', 'number'].includes(typeof node) ? String(node) : (node?.children ?? []).map(rolesText).join('')
const tickAll = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve)) }

test('fallback controls and deletion safeguards appear only when a lead exists', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const view = { profiles: [
    { id: 'lead', name: 'Lead', engine: 'echo', lead: true, sessions: [] },
    { id: 'a', name: 'First', engine: 'echo', fallback: true, taskTypes: ['docs'], sessions: [] },
    { id: 'b', name: 'Second', engine: 'echo', sessions: [] },
  ], taskTypes: [{ id: 'docs', name: '文档' }, { id: 'ops', name: '运维' }] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    if (endpoint === 'engine-catalog') return []
    if (endpoint === 'profile-update') {
      view.profiles.forEach(role => { delete role.fallback })
      view.profiles.find(role => role.id === payload.id).fallback = true
    }
    return {}
  } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const trigger = name => render().find(node => node.props?.['aria-label'] === `承接任务 ${name}`)
  const action = (verb, name) => render().find(node => node.props?.['aria-label'] === `${verb} ${name}`)
  const box = () => render().find(node => node.type === 'input' && node.props['aria-label'] === '兜底')
  assert.equal(rolesText(trigger('First')), '文档、兜底')
  trigger('First').props.onClick()
  assert.equal(box().props.checked, true)
  assert.equal(box().props.disabled, true)
  action('删除', 'First').props.onClick()
  const confirmation = () => render().find(node => node.type === 'Modal' && node.props.title === '删除角色“First”？')
  assert.match(rolesText(confirmation()), /兜底将转给「Second」。/)
  confirmation().props.onClose()
  trigger('Second').props.onClick()
  assert.equal(box().props.checked, false)
  box().props.onChange(); await tickAll()
  assert.deepEqual(calls.at(-1), { endpoint: 'profile-update', payload: { id: 'b', changes: { fallback: true } } })
  assert.equal(rolesText(trigger('Second')), '兜底')
  assert.equal(rolesText(trigger('First')), '文档')
  action('编辑', 'Second').props.onClick()
  assert.equal(render().find(node => node.type === loaded.RoleEditor).props.deleteHint, '兜底将转给「First」。')
  render().find(node => node.props?.className === 'nodo-roles-crumbs').children[0].props.onClick()
  view.profiles = view.profiles.filter(role => role.id !== 'lead')
  assert.equal(rolesText(trigger('Second')), '选择承接任务')
  trigger('Second').props.onClick()
  assert.equal(box(), undefined)
  assert.equal(render().some(node => rolesText(node).includes('兜底')), false)
  action('删除', 'Second').props.onClick()
  assert.equal(render().some(node => node.type === 'p' && rolesText(node).includes('兜底将转给')), false)
  render().find(node => node.type === 'Modal' && node.props.title === '删除角色“Second”？').props.onClose()
  view.profiles = [{ id: 'lead', name: 'Lead', lead: true, sessions: [] }, view.profiles[1]]
  const remove = action('删除', 'Second')
  assert.equal(remove.props.disabled, true)
  assert.equal(remove.props.title, '主控至少需要一个执行角色')
  action('编辑', 'Second').props.onClick()
  assert.equal(render().find(node => node.type === loaded.RoleEditor).props.deleteReason, '主控至少需要一个执行角色')
})

test('an empty roles page starts an executor and disables adding a lead', async () => {
  const loaded = await loadRolesPage({ call: async () => [] })
  const render = () => { loaded.host.reset(); return rolesTree(loaded.RolesPage({ view: { profiles: [] }, readOnly: false, refresh: async () => {} })) }
  assert.equal(render().find(node => node.type === 'form').props['aria-label'], '添加角色')
  const lead = render().find(node => node.type === 'button' && node.children.includes('添加主控'))
  assert.equal(lead.props.disabled, true)
  assert.equal(lead.props.title, '先添加执行角色')
})

test('onboarding stays mounted when enabling engines refreshes onboardedAt', async () => {
  const view = { profiles: [], workspaces: [], work: {}, prefs: {} }
  const states = [], pending = []
  const react = rolesReact(states, pending)
  const loaded = await loadClient('page.js', {
    react: { ...react, useRef: initial => react.useState(() => ({ current: initial }))[0] },
    uiShared: { useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => ({ active: true, legacy: true }) },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) }, subscribeNativeSession() {}, readNativeSession: () => null },
    stubs: { 'engine-settings.js': { OnboardingDialog: 'Onboarding', EngineSettingsDialog: 'Settings' } },
    globals: { document: { visibilityState: 'visible', hasFocus: () => true }, localStorage: { getItem: () => null, setItem() {} } },
  })
  const render = () => { cursor = 0; return rolesTree(loaded.NodoPage()) }
  assert.equal(render().find(node => node.type === 'Onboarding').props.view, view)
  view.prefs.onboardedAt = 1
  assert.ok(render().find(node => node.type === 'Onboarding'), 'the current three-step dialog survives the first-step save')
  render().find(node => node.type === 'Onboarding').props.onDone()
  assert.equal(render().find(node => node.type === 'Onboarding'), undefined)
})

test('the executor table reorders through keyboard handles and drag, keeping leads in their slots', async () => {
  const states = [], pending = []
  cursor = 0
  const calls = []
  const view = {
    profiles: [
      { id: 'a', name: '大肥鱼', engine: 'echo', taskTypes: ['docs'], sessions: [{ id: 'sa' }] },
      { id: 'lead', name: '决策者', engine: 'echo', lead: true, role: '拆分任务', instructions: 'Standing instructions', model: 'opus', sessions: [] },
      { id: 'b', name: '贼 coder', engine: 'echo', taskTypes: ['docs'], sessions: [] },
      { id: 'c', name: 'Reviewer', engine: 'echo', hard: {}, sessions: [] },
    ],
    workspaces: [], work: {}, taskTypes: [{ id: 'docs', name: '文档', when: '' }, { id: 'ops', name: '运维', when: '' }],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => { calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) }); return [] },
  })
  let tree
  const render = () => { cursor = 0; tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} })); pending.splice(0).forEach(effect => effect()); return tree }
  const rows = () => render().filter(node => node.props?.className === 'nodo-roles-row')
  const rowName = row => rolesText(row.children.find(node => node.props?.className === 'nodo-roles-who-cell')
    .children.find(node => node.props?.className === 'nodo-roles-copy').children[0])
  const cell = (row, className) => row.children.find(node => node.props?.className === className)
  const handle = name => render().find(node => node.props?.['aria-label'] === `调整 ${name} 顺序`)
  const action = (verb, name) => render().find(node => node.props?.['aria-label'] === `${verb} ${name}`)
  const orders = () => calls.filter(item => item.endpoint === 'profile-order').map(item => item.payload.ids)

  render()
  assert.deepEqual(rows().map(rowName), ['大肥鱼', '贼 coder', 'Reviewer'], 'the table lists executors only, in roster order')
  assert.deepEqual(rows().map(row => rolesText(cell(row, 'nodo-roles-takes'))), ['文档', '文档', '选择承接任务'])
  assert.deepEqual(rows().map(row => rolesText(cell(row, 'nodo-roles-hard'))), ['', '', '可接'])
  const leads = tree.filter(node => node.props?.className === 'nodo-roles-lead')
  assert.equal(leads.length, 1)
  assert.match(rolesText(leads[0]), /决策者拆分任务自定义/)
  const nav = rolesTree(loaded.rolesSidebarSnapshot().content).filter(node => node.props?.className === 'nodo-role-types')
  assert.deepEqual(nav.map(node => [rolesText(node), node.props['aria-pressed']]), [['全部角色4', true], ['任务类型2', false]])

  assert.equal(render().some(node => node.type === 'Menu'), false, 'row actions no longer use a menu')
  assert.ok(action('编辑', '大肥鱼') && action('删除', '大肥鱼'))
  assert.equal(cell(rows()[0], 'nodo-tag nodo-roles-identity').props['data-empty'], '')
  assert.equal(rolesText(cell(rows()[0], 'nodo-tag nodo-roles-identity')), '—')
  handle('大肥鱼').props.onKeyDown({ altKey: true, key: 'ArrowUp', preventDefault() {} })
  assert.equal(orders().length, 0, 'the first row cannot move up')
  handle('大肥鱼').props.onKeyDown({ altKey: true, key: 'ArrowDown', preventDefault() {} })
  await tickAll()
  assert.deepEqual(orders().at(-1), ['b', 'lead', 'a', 'c'], 'moving down sends every id with the lead kept in its slot')
  handle('Reviewer').props.onKeyDown({ altKey: true, key: 'ArrowUp', preventDefault() {} })
  await tickAll()
  assert.deepEqual(orders().at(-1), ['a', 'lead', 'c', 'b'])

  rows()[0].props.onDragStart({ dataTransfer: {} })
  assert.equal(rows()[0].props['data-dragging'], '')
  rows()[2].props.onDragOver({ preventDefault() {} })
  assert.equal(rows()[2].props['data-drop'], '', 'the hovered row marks itself as the drop target')
  rows()[2].props.onDrop({ preventDefault() {} })
  await tickAll()
  assert.deepEqual(orders().at(-1), ['b', 'lead', 'c', 'a'], 'dropping onto a row reorders the same way')

  view.work = { sa: { active: true } }
  const [running] = rows()
  assert.equal(cell(running, 'nodo-roles-who-cell').props.disabled, true, 'a running role cannot be edited')
  assert.equal(running.props.draggable, false, 'a running role cannot be dragged')
  assert.equal(action('编辑', '大肥鱼').props.disabled, true)
  assert.equal(action('删除', '大肥鱼').props.disabled, true)
  assert.deepEqual(['编辑', '删除'].map(verb => action(verb, '大肥鱼').props.title), ['角色运行中，结束后再修改', '角色运行中，结束后再修改'], 'disabled actions say why')
  assert.equal(handle('大肥鱼').props['aria-disabled'], true)
  const count = orders().length
  handle('大肥鱼').props.onKeyDown({ altKey: true, key: 'ArrowDown', preventDefault() {} })
  assert.equal(orders().length, count, 'a running role cannot move or be removed')

  view.work = {}
  action('编辑', '贼 coder').props.onClick()
  const editor = render().find(node => node.type === loaded.RoleEditor)
  assert.equal(editor.props.profile.id, 'b', '编辑 opens the role page')
  assert.equal(rolesText(tree.find(node => node.props?.className === 'nodo-roles-crumbs')), '角色贼 coder')
  assert.equal(rolesTree(loaded.rolesSidebarSnapshot().content).find(node => node.props?.className === 'nodo-role-types').props['aria-pressed'], true,
    '全部角色 stays pressed while a role is open')
  tree.find(node => node.props?.className === 'nodo-roles-crumbs').children[0].props.onClick()
  assert.equal(render().find(node => node.type === loaded.RoleEditor), undefined, 'the crumb returns to the overview')
})

test('a rejected reorder resyncs the view and asks for a retry', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  let refreshes = 0
  const view = {
    profiles: [
      { id: 'a', name: 'Writer', engine: 'echo', sessions: [] },
      { id: 'b', name: 'Reviewer', engine: 'echo', sessions: [] },
    ],
    workspaces: [], work: {}, taskTypes: [],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'profile-order') throw new Error('profile-order needs every profile id exactly once')
      return endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : {}
    },
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => { refreshes++ } }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const rows = () => render().filter(node => node.props?.className === 'nodo-roles-row')

  rows()[0].props.onDragStart({ dataTransfer: {} })
  rows()[1].props.onDragOver({ preventDefault() {} })
  rows()[1].props.onDrop({ preventDefault() {} })
  await tickAll()
  assert.ok(calls.some(item => item.endpoint === 'profile-order'), 'the reorder reached the core and was refused')
  assert.equal(refreshes, 1, 'the view resyncs before the message shows')
  assert.equal(render().find(node => node.props?.className === 'nodo-error-line')?.children[0], '角色列表已变化，请重试',
    'the technical refusal becomes a retry hint')
  assert.equal(rows().length, 2, 'the resynced roster still lists every role')
})

test('the inline new row creates a role from a name, identity and Agent', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const templates = JSON.parse(readFileSync(new URL('../core/shared/avatar-templates.json', import.meta.url), 'utf8'))
  const view = {
    profiles: [{ id: 'lead', name: '决策者', engine: 'echo', lead: true, sessions: [] }, { id: 'a', name: 'Writer', engine: 'echo', sessions: [] }],
    workspaces: [], work: {}, taskTypes: [], prefs: { enabledEngines: ['codex', 'echo'] },
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      return endpoint === 'engine-catalog' ? [{ id: 'mock', label: 'Mock' }, { id: 'echo', label: 'Echo CLI' }, { id: 'codex', label: 'Codex CLI' }] : { id: 'new' }
    },
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const form = () => render().find(node => node.type === 'form' && node.props['aria-label'] === '添加角色')
  const inForm = predicate => rolesTree(form()).find(predicate)
  const nameInput = () => inForm(node => node.type === 'input')
  const create = () => inForm(node => node.type === 'Button' && node.children.includes('创建'))
  const modal = () => render().find(node => node.type === 'Modal')

  assert.equal(form(), undefined, 'the row stays closed until 添加角色')
  render().find(node => node.props?.className === 'nodo-roles-add' && node.children.includes('添加角色')).props.onClick()
  render(); await tickAll()
  assert.equal(form().props.className, 'nodo-roles-row nodo-roles-new')
  assert.equal(rolesText(form().children[0]), '2', 'the new row takes the next position')
  assert.equal(nameInput().props.autoFocus, true)
  assert.equal(nameInput().props.maxLength, 40)
  const agent = inForm(node => node.type === 'select')
  assert.deepEqual(agent.children.map(option => [option.props.value, rolesText(option)]), [['echo', 'Echo'], ['codex', 'Codex']],
    'the Agent list follows the enabled engines and their short names')
  assert.equal(create().props.disabled, true, 'an empty name cannot be created')
  form().props.onKeyDown({ key: 'Escape' })
  assert.equal(form(), undefined, 'Esc cancels the row')

  render().find(node => node.props?.className === 'nodo-roles-add' && node.children.includes('添加角色')).props.onClick()
  const cancel = inForm(node => node.type === 'Button' && node.children.includes('取消'))
  assert.equal(cancel.props.type, 'button', '取消 must not submit the form')
  cancel.props.onClick()
  assert.equal(form(), undefined, '取消 closes the row')
  assert.equal(calls.some(item => item.endpoint === 'profile-create'), false, '取消 never creates a role')

  render().find(node => node.props?.className === 'nodo-roles-add' && node.children.includes('添加角色')).props.onClick()
  nameInput().props.onChange({ target: { value: 'Coder' } })
  render()
  let left = 0
  loaded.rolesGuard(() => left++)
  assert.ok(modal(), 'a typed name counts as an unsaved edit')
  modal().props.footer.find(node => node.children.includes('继续编辑')).props.onClick()
  assert.equal(left, 0)
  assert.equal(nameInput().props.value, 'Coder')
  assert.equal(create().props.disabled, false)
  view.prefs.enabledEngines = ['codex']
  assert.deepEqual(inForm(node => node.type === 'select').children.map(option => option.props.value), ['codex'])
  assert.equal(create().props.disabled, true, 'a selected Agent that is no longer enabled cannot be created')
  form().props.onSubmit({ preventDefault() {} })
  await tickAll()
  assert.equal(calls.some(item => item.endpoint === 'profile-create'), false, 'submitting also refuses the disabled Agent')
  inForm(node => node.type === 'select').props.onChange({ target: { value: 'codex' } })
  assert.equal(create().props.disabled, false, 'selecting an available Agent enables creation again')
  form().props.onSubmit({ preventDefault() {} })
  await tickAll()
  assert.deepEqual(calls.at(-1), { endpoint: 'profile-create', payload: { name: 'Coder', engine: 'codex', avatarTemplate: templates[2 % templates.length].id, identity: '' } },
    'the row sends the name, identity, Agent and next avatar')
  assert.equal(form(), undefined, 'the created role becomes a regular row')
  assert.equal(render().find(node => node.type === loaded.RoleEditor), undefined, 'creating stays on the overview')
  loaded.rolesGuard(() => left++)
  assert.equal(left, 1, 'nothing is held once created')
})

test('the lead section creates with a fixed leader identity and shares one create row with executors', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const preset = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8')).find(item => item.name === 'leader')
  const view = { profiles: [{ id: 'a', name: 'Writer', engine: 'echo', sessions: [] }], taskTypes: [] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    if (endpoint === 'engine-catalog') return [{ id: 'claude', catalog: { models: [] } }, { id: 'echo', catalog: { models: [] } }]
    if (endpoint === 'profile-create') view.profiles.push({ id: `lead${view.profiles.length}`, ...payload, sessions: [] })
    return {}
  } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const form = () => render().find(node => node.type === 'form')
  const add = label => render().find(node => node.type === 'button' && node.children.includes(label))
  const field = label => rolesTree(form()).find(node => node.props?.['aria-label'] === label)
  const create = () => rolesTree(form()).find(node => node.type === 'Button' && node.children.includes('创建'))
  assert.equal(form(), undefined, 'having no lead does not open a lead creation row')
  add('添加主控').props.onClick()
  assert.equal(form().props['aria-label'], '添加主控')
  assert.equal(create().props.disabled, true, 'the Agent is not loaded and the name is empty')
  assert.equal(add('添加主控'), undefined)
  assert.equal(rolesTree(form()).some(node => node.children?.includes('取消')), false)
  assert.equal(rolesTree(form()).filter(node => node.type === 'select').length, 1, 'only Agent is selectable')
  assert.equal(rolesText(rolesTree(form()).find(node => node.props?.className === 'nodo-tag nodo-roles-identity')), 'leader')
  assert.equal(field('身份'), undefined)
  await tickAll()
  field('名字').props.onChange({ target: { value: '  Leader  ' } })
  form().props.onSubmit({ preventDefault() {} })
  await tickAll()
  const created = calls.find(item => item.endpoint === 'profile-create')
  assert.deepEqual(created.payload, { name: 'Leader', engine: 'claude', avatarTemplate: created.payload.avatarTemplate,
    lead: true, identity: 'leader', role: preset.role, instructions: preset.instructions })
  add('添加主控').props.onClick()
  assert.equal(form().props['aria-label'], '添加主控')
  assert.ok(rolesTree(form()).some(node => node.children?.includes('取消')))
  form().props.onKeyDown({ key: 'Escape' })
  assert.equal(form(), undefined)
  add('添加主控').props.onClick()
  add('添加角色').props.onClick()
  assert.equal(render().filter(node => node.type === 'form').length, 1)
  assert.equal(form().props['aria-label'], '添加角色')
  field('身份').props.onChange({ target: { value: 'custom' } })
  add('添加主控').props.onClick()
  const confirm = render().find(node => node.type === 'Modal')
  assert.equal(confirm.props.title, '放弃未保存的修改？', 'identity alone is an unsaved edit')
  confirm.props.footer.find(node => node.children.includes('放弃修改')).props.onClick()
  assert.equal(form().props['aria-label'], '添加主控')
  field('名字').props.onChange({ target: { value: 'Second' } })
  form().props.onSubmit({ preventDefault() {} })
  await tickAll()
  assert.equal(render().filter(node => node.props?.className === 'nodo-roles-lead').length, 2)
})

test('a lead row opened before the catalog answers lands on a whitelisted engine', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  let resolveCatalog
  const view = { profiles: [{ id: 'a', name: 'Writer', engine: 'echo', sessions: [] }], taskTypes: [] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    if (endpoint === 'engine-catalog') return new Promise(resolve => { resolveCatalog = resolve })
    return { id: 'new' }
  } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const form = () => render().find(node => node.type === 'form')
  const field = label => rolesTree(form()).find(node => node.props?.['aria-label'] === label)
  render()
  render().find(node => node.type === 'button' && node.children.includes('添加主控')).props.onClick()
  resolveCatalog([{ id: 'echo', catalog: { models: [] } }, { id: 'codex', catalog: { models: [] } }])
  await tickAll()
  assert.equal(field('Agent').props.value, 'codex', 'the backfill skips engines outside the lead whitelist')
  field('名字').props.onChange({ target: { value: 'Leader' } })
  form().props.onSubmit({ preventDefault() {} }); await tickAll()
  assert.equal(calls.find(item => item.endpoint === 'profile-create').payload.engine, 'codex')
})

test('executor creation matches exact built-in and saved identity names without applying leader', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const presets = JSON.parse(readFileSync(new URL('../core/shared/role-presets.json', import.meta.url), 'utf8'))
  const saved = { name: '前端编码', role: '前端实现', instructions: '验证布局' }
  const view = { profiles: [{ id: 'lead', name: 'Lead', engine: 'echo', lead: true, sessions: [] },
    { id: 'a', name: 'Writer', engine: 'echo', sessions: [] }], prefs: { rolePresets: [saved] }, taskTypes: [] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    return endpoint === 'engine-catalog' ? [{ id: 'echo', catalog: { models: [] } }] : {}
  } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  render(); await tickAll()
  for (const identity of ['coder', 'leader', '任意文字', saved.name, 'Coder', ' coder ']) {
    render().find(node => node.type === 'button' && node.children.includes('添加角色')).props.onClick()
    const form = () => render().find(node => node.type === 'form')
    const inputs = rolesTree(form()).filter(node => node.type === 'input')
    const input = inputs.find(node => node.props['aria-label'] === '身份')
    assert.ok(input)
    assert.equal(input.props.placeholder, '身份')
    assert.equal(input.props.maxLength, 40)
    assert.equal(rolesTree(form()).filter(node => node.type === 'select').length, 1, 'identity has no dropdown')
    inputs.find(node => node.props['aria-label'] === '名字').props.onChange({ target: { value: 'New role' } })
    input.props.onChange({ target: { value: identity } })
    form().props.onSubmit({ preventDefault() {} })
    await tickAll()
    const request = calls.at(-1)
    assert.equal(request.endpoint, 'profile-create')
    const preset = [...presets.filter(item => item.name !== 'leader'), saved].find(item => item.name === identity)
    assert.deepEqual(request.payload, { name: 'New role', identity, engine: 'echo', avatarTemplate: request.payload.avatarTemplate,
      ...(preset ? { role: preset.role, instructions: preset.instructions } : {}) })
    assert.equal(form(), undefined)
  }
  assert.equal(calls.filter(item => item.endpoint === 'engine-catalog').length, 1)
})

test('a task cell saves each tick at once and falls back when core refuses', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  let refuse = false
  const view = {
    profiles: [{ id: 'a', name: 'Writer', engine: 'echo', taskTypes: ['docs'], sessions: [] }],
    workspaces: [], work: {}, taskTypes: [{ id: 'docs', name: '文档', when: '' }, { id: 'review', name: '审查', when: '' }],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      if (endpoint === 'engine-catalog') return [{ id: 'echo', catalog: { models: [] } }]
      if (refuse) throw new Error('profile-update refused')
      return {}
    },
    globals: { document: { querySelector: () => null, addEventListener() {}, removeEventListener() {} } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const trigger = () => render().find(node => node.props?.['aria-label'] === '承接任务 Writer')
  const option = name => render().find(node => node.props?.className === 'nodo-roles-takes-option' && node.children.includes(name))
  const box = name => option(name).children.find(node => node.type === 'input')

  trigger().props.onClick()
  assert.equal(trigger().props['aria-expanded'], true)
  assert.deepEqual(['文档', '审查'].map(name => box(name).props.checked), [true, false])
  box('审查').props.onChange()
  assert.equal(rolesText(trigger()), '文档、审查', 'the cell shows the tick before core answers')
  await tickAll()
  assert.deepEqual(calls.at(-1), { endpoint: 'profile-update', payload: { id: 'a', changes: { taskTypes: ['docs', 'review'] } } },
    'a tick saves only the task types')
  view.profiles[0].taskTypes = ['docs', 'review']
  refuse = true
  box('文档').props.onChange()
  await tickAll()
  assert.equal(rolesText(trigger()), '文档、审查', 'a refusal falls back to the saved card')
  assert.equal(render().find(node => node.props?.className === 'nodo-error-line').children[0], 'profile-update refused')
  render().find(node => node.props?.className === 'nodo-roles-takes-pop').props.onKeyDown({ key: 'Escape' })
  assert.equal(trigger().props['aria-expanded'], false, 'Esc closes the list')
})

test('hard settings in the task popup share model choices, save immediately and roll back host failures', async () => {
  const states = [], pending = [], calls = [], listeners = new Map()
  cursor = 0
  let refuse = false, pause = false, release
  const role = { id: 'a', name: 'Writer', engine: 'echo', model: 'm1', thinking: 'high', taskTypes: ['docs'], sessions: [] }
  const view = { profiles: [role], taskTypes: [{ id: 'docs', name: '文档' }] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    if (endpoint === 'engine-catalog') return [{ id: 'echo', catalog: { defaultModel: 'm2', models: [
      { id: 'm1', label: 'M1', group: 'Provider', defaultThinking: 'high', thinking: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] },
      { id: 'm2', label: 'M2', thinking: [{ id: 'low', label: 'Low' }] }, { id: 'm3', thinking: [] },
    ] } }]
    if (endpoint === 'profile-update') {
      if (pause) await new Promise(resolve => { release = resolve })
      if (refuse) throw new Error('host refused hard settings')
      if (payload.changes.hard === null) delete role.hard
      else role.hard = payload.changes.hard
    }
    return {}
  }, globals: { document: {
    addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type),
  } } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const trigger = () => render().find(node => node.props?.['aria-label'] === '承接任务 Writer')
  const popup = () => render().find(node => node.props?.className === 'nodo-roles-takes-pop')
  const field = label => rolesTree(popup()).find(node => node.props?.['aria-label'] === label)
  const hard = () => field('可接难题')
  const change = async (label, value) => { field(label).props.onChange({ target: { value } }); await tickAll() }
  const lastHard = () => calls.filter(item => item.endpoint === 'profile-update').at(-1)
  render(); await tickAll()
  trigger().props.onClick()
  hard().props.onChange({ target: { checked: true } })
  assert.equal(hard().props.checked, true, 'hard status changes immediately')
  await tickAll()
  assert.deepEqual(lastHard(), { endpoint: 'profile-update', payload: { id: 'a', changes: { hard: {} } } })
  assert.deepEqual(rolesTree(field('难题思考档位')).filter(node => node.type === 'option').map(rolesText), ['默认', 'High（模型默认）', 'Low'],
    'an unset hard model follows the role model before the engine default')
  assert.ok(rolesTree(field('难题模型')).some(node => node.type === 'optgroup' && node.props.label === 'Provider'))
  await change('难题模型', 'm1')
  assert.deepEqual(lastHard().payload.changes, { hard: { model: 'm1' } }, 'a model edit sends only hard settings')
  await change('难题思考档位', 'high')
  assert.deepEqual(lastHard().payload.changes, { hard: { model: 'm1', thinking: 'high' } })
  await change('难题模型', 'm2')
  assert.deepEqual(lastHard().payload.changes, { hard: { model: 'm2' } }, 'unsupported thinking resets on model change')
  await change('难题思考档位', 'low')
  await change('难题模型', 'm1')
  assert.deepEqual(lastHard().payload.changes.hard, { model: 'm1', thinking: 'low' }, 'supported thinking survives a switch')
  await change('难题模型', 'm3')
  assert.deepEqual(rolesTree(field('难题思考档位')).filter(node => node.type === 'option').map(rolesText), ['默认'])
  await change('难题模型', '')
  assert.deepEqual(lastHard().payload.changes.hard, {}, 'defaults omit unset keys')
  role.hard = { model: 'unlisted-model', thinking: 'unlisted-level' }
  assert.ok(rolesTree(field('难题模型')).some(node => node.type === 'option' && rolesText(node) === '不在清单：unlisted-model'))
  assert.ok(rolesTree(field('难题思考档位')).some(node => node.type === 'option' && rolesText(node) === '不在清单：unlisted-level'))
  const before = { ...role.hard }
  pause = true; refuse = true
  field('难题模型').props.onChange({ target: { value: 'm2' } })
  assert.equal(field('难题模型').props.value, 'm2')
  assert.equal(field('难题模型').props.disabled, true, 'the pending row cannot race another save')
  release(); await tickAll()
  assert.equal(field('难题模型').props.value, 'unlisted-model', 'a failure restores the saved cell')
  assert.equal(field('难题思考档位').props.value, 'unlisted-level')
  assert.deepEqual(role.hard, before)
  assert.deepEqual(role.taskTypes, ['docs'])
  assert.equal(render().find(node => node.props?.className === 'nodo-error-line').children[0], 'host refused hard settings')
  pause = false; refuse = false
  hard().props.onChange({ target: { checked: false } }); await tickAll()
  assert.deepEqual(lastHard().payload.changes, { hard: null })
  assert.equal(field('难题模型'), undefined)
  popup().props.onKeyDown({ key: 'Escape' })
  assert.equal(popup(), undefined)
  view.taskTypes = []
  assert.equal(trigger().props.disabled, false, 'hard settings stay available without task types')
  trigger().props.onClick(); render()
  listeners.get('mousedown')({ target: { closest: () => true } })
  assert.ok(popup(), 'inside clicks keep the popup open')
  listeners.get('mousedown')({ target: { closest: () => null } })
  assert.equal(popup(), undefined, 'outside clicks close the popup')
  assert.equal(calls.filter(item => item.endpoint === 'engine-catalog').length, 1)
  assert.equal(calls.some(item => item.endpoint === 'engine-scan'), false, 'the popup reuses the loaded catalog')
})

test('the gap status uses core routing and separates routine gaps from hard-only gaps', async () => {
  const states = [], pending = []
  cursor = 0
  const view = {
    profiles: [
      { id: 'lead', name: '决策者', engine: 'echo', lead: true, taskTypes: ['ops'], sessions: [] },
      { id: 'a', name: '资深', engine: 'echo', taskTypes: ['docs'], fallback: true, hard: {}, sessions: [] },
      { id: 'b', name: '编码', engine: 'echo', taskTypes: ['docs', 'review'], sessions: [] },
    ],
    workspaces: [], work: {},
    taskTypes: [{ id: 'docs', name: '文档' }, { id: 'review', name: '审查' }, { id: 'ops', name: '运维' }, { id: 'test', name: '测试' }],
  }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async () => [], globals: { document: { querySelector: () => null } } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const note = () => render().find(node => node.props?.className === 'nodo-roles-gap-note')
  assert.deepEqual(rolesTree(note()).filter(node => node.type === 'p').map(rolesText), ['运维没有角色承接，由「资深」兜底', '测试没有角色承接，由「资深」兜底', '审查没有可接难题的角色'],
    'unclaimed types use fallback; an accepting role without hard settings still leaves a hard gap')
  assert.equal(note().props.role, 'status')
  assert.equal(render().some(node => rolesText(node).includes('派活结果') || rolesText(node).includes('管理任务类型')), false)
  view.taskTypes = [view.taskTypes[1]]
  assert.deepEqual(rolesTree(note()).filter(node => node.type === 'p').map(rolesText), ['审查没有可接难题的角色'])
  view.taskTypes = [{ id: 'docs', name: '文档' }]
  assert.equal(note(), undefined, 'no gaps, no status block')
  view.profiles = view.profiles.map(item => ({ ...item, taskTypes: [] }))
  assert.deepEqual(rolesTree(note()).filter(node => node.type === 'p').map(rolesText), ['文档没有角色承接，由「资深」兜底'])
  view.profiles = view.profiles.filter(item => !item.lead)
  assert.equal(note(), undefined, 'without a lead no routing gaps or fallback hints are shown')
})

test('with no executors the overview offers the inline form and lists every lead', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const view = {
    profiles: [
      { id: 'l1', name: '决策者', engine: 'echo', lead: true, sessions: [] },
      { id: 'l2', name: '架构师', engine: 'echo', lead: true, sessions: [] },
    ],
    workspaces: [], work: {}, taskTypes: [],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo' }] : {} },
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  render(); await tickAll()
  const empty = () => render().find(node => node.props?.className === 'nodo-roles-empty')
  assert.equal(rolesText(empty().children[0]), '给主控配一个执行角色')
  assert.equal(render().some(node => node.props?.className === 'nodo-roles-plan-none'), false, 'the empty block has no task routing hint')
  assert.equal(render().some(node => node.props?.className === 'nodo-roles-row'), false, 'executor rows give way to the empty block')
  assert.equal(render().filter(node => node.props?.className === 'nodo-roles-lead').length, 2, 'every lead keeps its row')
  const form = rolesTree(empty()).find(node => node.type === 'form')
  assert.equal(form.props.className, 'nodo-roles-create')
  assert.equal(rolesTree(form).some(node => node.type === 'Button' && node.children.includes('取消')), false, 'the empty form has nothing to cancel')
  rolesTree(form).find(node => node.type === 'input').props.onChange({ target: { value: 'Coder' } })
  rolesTree(empty()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await tickAll()
  assert.deepEqual({ ...calls.at(-1).payload }, { name: 'Coder', engine: 'echo', avatarTemplate: calls.at(-1).payload.avatarTemplate, identity: '' })
  assert.equal(calls.at(-1).endpoint, 'profile-create')
  view.profiles = []
  assert.equal(render().some(node => node.props?.className === 'nodo-roles-lead-none'), false)
  assert.ok(render().find(node => node.type === 'form' && node.props['aria-label'] === '添加角色'))
  const addLead = render().find(node => node.type === 'button' && node.children.includes('添加主控'))
  assert.equal(addLead.props.disabled, true)
  assert.equal(addLead.props.title, '先添加执行角色')
})

test('roster buttons open the roles page with the role selected or a new draft', async () => {
  const panels = []
  const view = { profiles: [
    { id: 'lead', name: '主控', engine: 'echo', lead: true, activeSessionId: 's', sessions: [{ id: 's', name: '会话', workspaceRef: 'p' }] },
    { id: 'coder', name: 'Coder', engine: 'echo', activeSessionId: 'c', sessions: [{ id: 'c', name: '编码', workspaceRef: 'p' }] },
  ], workspaces: [{ id: 'p', name: '项目' }], work: {}, stats: {}, prefs: { onboardedAt: 1 } }
  const loaded = await loadClient(['page.js', 'roles.tsx', 'session-rail.tsx'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => ({ active: true, legacy: true }) },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      subscribeNativeSession() {}, readNativeSession: () => null,
      workspaceIdOf: (view, role, session) => session.workspaceRef ?? role.workspaceId,
      roleStateOf: () => ({ active: false }), workDot: () => 'idle', workLabel: () => '', sessionTime: () => '刚刚',
      ARCHIVED_VIEWS: { hide: '隐藏已归档', all: '全部对话（显示已归档）', only: '仅显示已归档' }, SESSION_FOLD: 10,
      layoutService: { selectPanel: key => panels.push(key) },
      call: async () => ({}),
    },
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true },
      window: { addEventListener() {}, removeEventListener() {} },
      localStorage: { getItem: key => key === 'nodo.navigation' ? JSON.stringify({ profile: 'lead', workspace: 'p' }) : null, setItem() {} },
    },
  })
  const all = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(all)] : []
  const render = () => { loaded.host.reset(); return all(loaded.NodoPage({ sidebarOnly: true })) }
  // The rail is a component: invoke it to reach its roster.
  const rail = () => { const tree = render(); const el = tree.find(node => node.type === loaded.Rail); return all(loaded.Rail(el.props)) }
  rail().find(node => node.props?.['aria-label'] === '配置角色 Coder').props.onClick()
  assert.deepEqual(panels, ['nodo-roles'])
  assert.equal(loaded.readRolesTarget().profileId, 'coder', 'the roster hands the role to the page')
  rail().find(node => node.props?.['aria-label'] === '添加角色').props.onClick()
  assert.equal(loaded.readRolesTarget().profileId, 'new')
})

test('switching roles with unsaved edits asks before discarding, and so does leaving', async () => {
  const states = [], pending = []
  cursor = 0
  const view = {
    profiles: [
      { id: 'a', name: 'Writer', engine: 'echo', sessions: [] },
      { id: 'b', name: 'Reviewer', engine: 'echo', sessions: [] },
    ],
    workspaces: [], work: {}, taskTypes: [],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, payload) => endpoint === 'engine-catalog'
      ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : { id: payload?.id },
    globals: { document: { querySelector: () => null } },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} })); pending.splice(0).forEach(effect => effect()); return tree }
  const open = name => render().find(node => node.props?.className === 'nodo-roles-who-cell' && node.props.title === name).props.onClick()
  const overview = () => rolesTree(loaded.rolesSidebarSnapshot().content).find(node => node.props?.className === 'nodo-role-types').props.onClick()
  const typesNav = () => rolesTree(loaded.rolesSidebarSnapshot().content).filter(node => node.props?.className === 'nodo-role-types')[1].props.onClick()
  const editorEl = tree => tree.find(node => node.type === loaded.RoleEditor)
  const editor = () => {
    const tree = render()
    const el = editorEl(tree)
    const shape = el ? nodes(loaded.RoleEditor(el.props)) : []
    pending.splice(0).forEach(effect => effect())
    return { tree, shape }
  }
  const modal = tree => tree.find(node => node.type === 'Modal')
  const nameInput = shape => shape.find(node => node.type === 'input' && node.props.placeholder === '例如 Coder 或 Reviewer')

  open('Writer')
  let current = editor()
  await tickAll(); current = editor(); await tickAll()
  nameInput(current.shape).props.onChange({ target: { value: '改过的名字' } })
  current = editor()
  assert.equal(editorEl(current.tree).props.profile.id, 'a')

  typesNav()
  current = editor()
  assert.ok(modal(current.tree), 'an unsaved edit asks before switching')
  modal(current.tree).props.footer.find(node => node.children.includes('继续编辑')).props.onClick()
  current = editor()
  assert.equal(modal(current.tree), undefined)
  assert.equal(editorEl(current.tree).props.profile.id, 'a', '继续编辑 keeps the role')

  overview()
  current = editor()
  modal(current.tree).props.footer.find(node => node.children.includes('放弃修改')).props.onClick()
  current = editor()
  assert.equal(modal(current.tree), undefined)
  assert.equal(editorEl(current.tree), undefined, '放弃修改 lands on the overview')
  states.length = 0 // the fake host runs no unmount cleanup, which would report the editor clean

  open('Reviewer')
  current = editor()
  nameInput(current.shape).props.onChange({ target: { value: '又一个名字' } })
  current = editor()
  let left = 0
  loaded.rolesGuard(() => left++)
  assert.equal(left, 0, 'the guard holds the leave until the confirm answers')
  modal(render()).props.footer.find(node => node.children.includes('放弃修改')).props.onClick()
  assert.equal(left, 1, 'a discarded edit lets the leave through')
  states.length = 0
  editor()
  loaded.rolesGuard(() => left++)
  assert.equal(left, 2, 'without unsaved edits the guard is a passthrough')

  // Saving an existing role hands back a live editor: the submit must not leave
  // it busy, and the page must not hold the saved card as unsaved.
  open('Writer')
  let fresh = editor()
  for (let round = 0; round < 3; round++) { await tickAll(); fresh = editor() }
  nameInput(fresh.shape).props.onChange({ target: { value: '保存过的名字' } })
  const before = editor()
  await before.shape.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await tickAll()
  const after = editor()
  assert.equal(editorEl(after.tree).props.profile.id, 'a')
  assert.equal(nameInput(after.shape).props.disabled, false, 'a saved role re-enables the editor')
  assert.ok(after.shape.find(node => node.type === 'Button' && node.props.type === 'submit').children.includes('保存'),
    'the save button leaves its busy label')
  let leftAfterSave = 0
  loaded.rolesGuard(() => leftAfterSave++)
  assert.equal(leftAfterSave, 1, 'a saved role is not held as unsaved')
})

test('deleting a lead or executor confirms and drops session drafts from memory and storage', async () => {
  for (const lead of [false, true]) {
    const states = [], pending = [], calls = [], removed = []
    let stored = { sa: 'draft', other: 'keep' }
    cursor = 0
    const view = {
      profiles: [{ id: 'a', name: 'Writer', engine: 'echo', lead, sessions: [{ id: 'sa' }, { id: 'draft-only', draftedAt: 1, briefSent: false }] }],
      workspaces: [], work: {}, taskTypes: [],
    }
    const loaded = await loadRolesPage({
      react: rolesReact(states, pending),
      call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return endpoint === 'engine-catalog'
        ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : { id: payload?.id } },
      globals: { document: { querySelector: () => null },
        localStorage: { getItem: () => JSON.stringify(stored), setItem: (_key, value) => { stored = JSON.parse(value) } } },
    })
    const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} })); pending.splice(0).forEach(effect => effect()); return tree }
    const modal = () => render().find(node => node.type === 'Modal')

    loaded.registerDraftRemover(ids => removed.push([...ids]))
    view.work = { sa: { active: true } }
    for (const label of ['编辑 Writer', '删除 Writer']) assert.equal(render().find(node => node.props?.['aria-label'] === label).props.disabled, true)
    view.work = {}
    render().find(node => node.props?.['aria-label'] === '删除 Writer').props.onClick()
    assert.equal(modal().props.title, '删除角色“Writer”？')
    assert.equal(rolesText(modal().children[0]), '将删除角色“Writer”，其 1 个会话会自动归档，可在「已移除」中查看。项目目录和文件会保留。')
    assert.equal(calls.some(item => item.endpoint === 'profile-delete'), false, 'nothing is deleted before confirming')
    modal().props.footer.find(node => node.children.includes('取消')).props.onClick()
    assert.equal(modal(), undefined, 'cancel keeps the role and its drafts')
    assert.deepEqual(stored, { sa: 'draft', other: 'keep' })
    render().find(node => node.props?.['aria-label'] === '删除 Writer').props.onClick()
    modal().props.footer.find(node => node.children.includes('删除角色')).props.onClick()
    await tickAll()
    assert.ok(calls.some(item => item.endpoint === 'profile-delete'), 'the delete reaches the core')
    assert.deepEqual(removed, [['sa', 'draft-only']], 'the registered page drops the deleted sessions’ drafts')
    assert.deepEqual(stored, { other: 'keep' }, 'only the deleted role’s session drafts leave storage')
  }
})

test('a read-only window keeps the overview locked and shows the role editor disabled', async () => {
  const states = [], pending = []
  cursor = 0
  const view = {
    profiles: [{ id: 'a', name: 'Writer', engine: 'echo', sessions: [] }],
    workspaces: [], work: {}, taskTypes: [{ id: 'docs', name: '文档', when: '' }],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async endpoint => endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : {},
    globals: { document: { querySelector: () => null } },
  })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: true, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const shape = () => nodes(loaded.RoleEditor(render().find(node => node.type === loaded.RoleEditor).props))
  const nameInput = () => shape().find(node => node.type === 'input' && node.props.placeholder === '例如 Coder 或 Reviewer')
  const saveButton = () => shape().find(node => node.type === 'Button' && node.props.type === 'submit')

  const [row] = render().filter(node => node.props?.className === 'nodo-roles-row')
  assert.equal(row.props.draggable, false)
  assert.equal(render().find(node => node.props?.className === 'nodo-roles-add').props.disabled, true)
  assert.equal(render().find(node => node.props?.['aria-label'] === '承接任务 Writer').props.disabled, true)
  render().find(node => node.props?.className === 'nodo-roles-who-cell').props.onClick()
  for (let round = 0; round < 3; round++) { await tickAll(); shape() }
  assert.equal(nameInput().props.disabled, true, 'the name input stays disabled once the engine catalog arrives')
  assert.equal(saveButton().props.disabled, true, 'the save button stays disabled')
})

test('a roster jump is consumed once, so re-entering lands on the overview', async () => {
  const states = [], pending = []
  cursor = 0
  const view = {
    profiles: [{ id: 'a', name: 'Writer', engine: 'echo', sessions: [] }],
    workspaces: [], work: {}, taskTypes: [],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async endpoint => endpoint === 'engine-catalog' ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : {},
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }

  loaded.openRoles({ profileId: 'a' })
  assert.equal(render().find(node => node.type === loaded.RoleEditor).props.profile.id, 'a', 'the jump opens the role page')
  assert.equal(loaded.readRolesTarget(), null, 'the page consumes the target after applying it')
  states.length = 0
  assert.equal(render().find(node => node.type === loaded.RoleEditor), undefined, 're-entering from the rail lands on the overview')
})

test('a failed engine catalog stops after one request and shows the host error', async () => {
  const states = [], pending = [], requests = []
  cursor = 0
  const view = { profiles: [], workspaces: [], work: {}, taskTypes: [] }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async endpoint => { requests.push(endpoint); throw new Error('catalog is down') },
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }

  render(); await tickAll()
  assert.equal(requests.filter(endpoint => endpoint === 'engine-catalog').length, 1, 'one request, no retry loop')
  render(); await tickAll()
  assert.equal(requests.filter(endpoint => endpoint === 'engine-catalog').length, 1, 'the failure settles instead of retrying')
  assert.equal(render().find(node => node.props?.className === 'nodo-error-line')?.children[0], 'catalog is down')
  rolesTree(render().find(node => node.type === 'form')).find(node => node.type === 'input')
    .props.onChange({ target: { value: 'Coder' } })
  const form = render().find(node => node.type === 'form')
  assert.equal(rolesTree(form).find(node => node.type === 'Button' && node.children.includes('创建')).props.disabled, true,
    'a failed catalog keeps the create button disabled')
})

test('the inline remove confirm stays on its row while the list shifts', async () => {
  const states = [], pending = []
  cursor = 0
  const view = {
    profiles: [
      { id: 'a', name: 'Writer', taskTypes: ['docs'], sessions: [] },
      { id: 'b', name: 'Reviewer', taskTypes: ['review'], sessions: [] },
    ],
    workspaces: [], work: {},
    taskTypes: [{ id: 'ops', name: '运维', when: '' }, { id: 'docs', name: '文档', when: '' }, { id: 'review', name: '审查', when: '' }],
  }
  const { TaskTypesEditor } = await loadRolesPage({ react: rolesReact(states, pending), call: async () => [] })
  const render = () => { cursor = 0; return rolesTree(TaskTypesEditor({ view, disabled: false, onDone: async () => {} })) }
  const rows = () => render().filter(node => node.props?.className === 'nodo-type-row')
  const nameInput = row => row.children.find(node => node.props['aria-label'] === '任务类型名称')
  const confirmRow = () => render().find(node => node.props?.className === 'nodo-type-confirm')

  render().find(node => node.props?.['aria-label'] === '删除类型 文档').props.onClick()
  assert.equal(confirmRow().children[0].children.join(''), '将从 Writer 上移除')
  render().find(node => node.props?.['aria-label'] === '删除类型 运维').props.onClick()
  assert.deepEqual(rows().map(row => nameInput(row).props.value), ['文档', '审查'], 'the unused type leaves at once')
  assert.equal(confirmRow().children[0].children.join(''), '将从 Writer 上移除', 'the confirm keeps pointing at 文档')
  confirmRow().children.find(node => node.children.includes('删除')).props.onClick()
  assert.deepEqual(rows().map(row => nameInput(row).props.value), ['审查'], '删除 removes the confirmed type, not the one that took its index')
})
