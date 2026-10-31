// Exercise the browser's classic-script boundary; Node ESM parsing alone does
// not catch export declarations accidentally placed inside the loader factory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { loadClient } from './helpers/client-module.js'
import { route } from '../core/shared/route.js'
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
  assert.deepEqual([...pending.keys()], ['sidebar', 'shell.overlay', 'conversation.input.model', 'conversation.input.right', 'rightbar', 'conversation.input.dock', 'conversation.chat.node', 'main', 'main.conversation', 'sidebar.panellist'])
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
  assert.match(rule('.nodo-head'), /min-height:var\(--nodo-top-clearance,0px\)/)
  assert.equal(rule('html[data-platform=darwin]'), '--nodo-top-clearance:var(--dsh-frame-top-clearance,0px)', 'Windows columns already start below the titlebar')
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
  const { workLabel, runningOf, workDot, workKind } = await loadClient('ui-shared.js')
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
  assert.deepEqual([work.two, { ...work.two, suspect: true }, { status: 'waiting-question' }, { status: 'blocked' }, { status: 'completed' }, { status: 'error' }, { status: 'stopped' }, {}].map(workKind),
    ['run', 'wait', 'wait', 'wait', 'done', 'err', 'stop', 'stop'], 'each state maps to one marker kind')
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
  assert.match(block(clientSource('roles.tsx'), 'const deletedRole', '// A role leads exactly'), /call\('profile-delete'/)
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
    const profile = { id: 'role', name: 'Role', engine: 'echo', lead, sessions: [] }
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
    render().find(node => node.props.className === 'nodo-template-pick').props.onClick()
    await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const saved = calls.at(-1)
    assert.equal(saved.endpoint, 'profile-update')
    assert.notEqual(saved.payload.changes.identity, '')
    for (const key of ['lead']) assert.equal(Object.hasOwn(saved.payload.changes, key), false)
    assert.notEqual(saved.payload.changes.instructions, '')
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
  const card = () => render().find(node => node.type === RoleAvatar && node.props.size === 104)
  const trigger = () => render().find(node => node.props?.['aria-label'] === '更换头像')
  assert.equal(card().props.profile.avatarTemplate, templates[2].id, 'a new role shows the dango its creation order assigns')
  mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  render().find(node => node.props['aria-label'] === '名字').props.onChange({ target: { value: 'Cute coder' } })
  assert.equal(render().find(node => node.props['aria-label'] === '名字').props.value, 'Cute coder', 'the hero name follows the edit')
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
const loadRail = async (react, primitives) => loadClient(['session-rail.tsx', 'search-dialog.tsx', 'avatar.tsx', 'ui-shared.js'], { react, primitives })

test('rail omits redundant status icons and distinguishes unarchive from the archive filter', async () => {
  const { SessionRow, RoleAvatar, workspacePicker } = await loadRail()
  const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : []
  const changes = []
  const row = nodes(SessionRow({ role: { name: 'Coder' }, session: { name: 'History', archivedAt: 1 },
    onArchive: value => changes.push(value) }))
  assert.equal(row.find(node => node.type === RoleAvatar).props.profile.name, 'Coder', 'a session row leads with its role avatar')
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

// A roster row narrows the session list to one role; pressing it again lifts
// the filter. Only the list changes, never the roster.
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
  const edit = (tree, label) => tree.find(node => node.props?.className === 'nodo-row-action' && node.props['aria-label'] === `配置角色 ${label}`)
  let tree = render()
  assert.deepEqual(roster(tree).map(name), ['大肥鱼', '贼 coder'])
  assert.deepEqual(pressed(tree), [])
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
  assert.deepEqual(roster(tree).map(name), ['大肥鱼', '贼 coder'], 'the roster stays complete')
  assert.equal(tree.some(node => node.props?.className === 'nodo-roster-detail'), false, 'picking a role opens no detail bar')
  const fold = () => render().find(node => node.props?.className === 'nodo-project-select' && node.props.title === '/bot').props.onClick()
  fold()
  assert.deepEqual(rows(render()), [], 'a role filter still lets a project fold')
  fold()
  assert.deepEqual(rows(render()), ['贼 coder · 删除新会话'])
  press('贼 coder')
  tree = render()
  assert.deepEqual(pressed(tree), [], 'pressing the role again lifts its filter')
  assert.deepEqual(rows(tree), ['大肥鱼 · 读当前任务', '贼 coder · 删除新会话'])
  press('大肥鱼')
  assert.deepEqual(rows(render()), ['大肥鱼 · 读当前任务'])
  press('大肥鱼')
  assert.deepEqual(rows(render()), ['大肥鱼 · 读当前任务', '贼 coder · 删除新会话'])
})

// A long plain list folds to the ten most recent sessions; searching lists every
// match with no fold, and the toggle re-folds after expanding.
test('the rail folds a long session list behind a show-more toggle', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow, SearchDialog } = await loadRail({ useState: (initial) => {
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
  const dockButton = label => tree.find(node => node.type === 'button' && node.props['aria-label'] === label)
  assert.deepEqual(['主页', '新建会话', '搜索', '角色'].map(label => dockButton(label).props['aria-pressed']), [true, undefined, false, false], 'the dock leads with home, new session, search and roles')
  assert.equal(dockButton('Team'), undefined, 'Team moved from the dock to the home tabs')
  assert.deepEqual(tree.filter(node => node.props?.role === 'tab').map(node => [node.children[0], node.props['aria-selected']]), [['角色', true], ['团队', false]], 'home opens on the roles tab')
  assert.equal(dockButton('主页').children[0].type, 'IconFlatListOutlineRegular', 'session navigation represents a list')
  const finder = () => tree.find(node => node.type === SearchDialog)
  const menu = () => tree.find(node => node.type === 'Menu' && node.props.items.some(item => item.id === 'archived:only'))
  assert.equal(finder(), undefined, 'the finder waits behind the dock button')
  dockButton('搜索').props.onClick()
  tree = render()
  assert.deepEqual(finder().props.items.map(item => item.id), view.profiles[0].sessions.map(session => session.id), 'the finder lists every session, newest first')
  assert.equal(ids(tree).length, 10, 'the rail list keeps its fold behind the finder')
  finder().props.onClose()
  tree = render()
  assert.equal(finder(), undefined, 'closing the finder removes it')
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
  press('Coder')
  assert.deepEqual(ids(render()), Array.from({ length: 10 }, (_, index) => `s${index}`), 'lifting the filter keeps the collapsed state')
})

test('the session finder lists sessions with project and time, filters by query and picks with the keyboard', async () => {
  const slots = []
  let cursor = 0
  const { SearchDialog } = await loadRail({ useState: initial => {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
  } }, { relativeTime: () => ({ unit: 'now', n: 0 }) })
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const picked = []
  let closed = 0
  const items = [
    { id: 'a', role: { id: 'r', name: 'Coder', lead: true }, name: 'Fix login', project: { id: 'p', name: 'bot' }, updatedAt: 2,
      terms: ['Coder', 'Fix login', 'bot'], pick: () => picked.push('a') },
    { id: 'b', role: { id: 'q', name: 'Writer' }, name: 'Docs', project: { id: 'w', name: 'feat/x', worktree: { branch: 'feat/x' } }, work: { active: true }, updatedAt: 1,
      terms: ['Writer', 'Docs', 'feat/x'], pick: () => picked.push('b') },
  ]
  const render = () => { cursor = 0; return nodes(SearchDialog({ items, onClose: () => closed++ })) }
  const rows = () => render().filter(node => node.props?.role === 'option')
  const input = () => render().find(node => node.type === 'input')
  const key = (name, extra = {}) => input().props.onKeyDown({ key: name, preventDefault() {}, ...extra })
  assert.deepEqual(rows().map(row => row.children[1].children[0]), ['Fix login', 'Docs'])
  assert.equal(rows()[0].children[0].props['data-lead'], '', 'a lead keeps its ring')
  assert.equal(rows()[1].children[0].props['data-lead'], undefined)
  assert.equal(rows()[0].children[2].children[1].children[0], 'bot')
  assert.equal(rows()[1].children[2].children[0].type, 'IconBranchOutlineRegular', 'a worktree shows the branch glyph')
  assert.equal(rows()[0].children[3].children[0], '↵', 'the active row shows the open hint in place of the time')
  assert.ok(nodes(rows()[1].children[3]).some(node => node.props?.className === 'nodo-row-running'), 'an idle row shows the run state while it runs')
  assert.deepEqual(rows().map(row => row.props['aria-selected']), [true, false])
  key('ArrowDown')
  assert.deepEqual(rows().map(row => row.props['aria-selected']), [false, true])
  key('ArrowDown')
  assert.deepEqual(rows().map(row => row.props['aria-selected']), [true, false], 'the selection wraps')
  key('ArrowUp')
  assert.deepEqual(rows().map(row => row.props['aria-selected']), [false, true])
  key('Enter', { nativeEvent: { isComposing: true } })
  assert.deepEqual(picked, [], 'Enter while composing only confirms the input method')
  key('Enter')
  assert.deepEqual(picked, ['b'])
  assert.equal(closed, 1, 'picking closes the finder')
  input().props.onChange({ target: { value: 'DOCS' } })
  assert.deepEqual(rows().map(row => row.children[1].children[0]), ['Docs'], 'the query matches names case-insensitively')
  input().props.onChange({ target: { value: 'bot' } })
  assert.deepEqual(rows().map(row => row.children[1].children[0]), ['Fix login'], 'the query also matches the project')
  rows()[0].props.onClick()
  assert.deepEqual(picked, ['b', 'a'])
  input().props.onChange({ target: { value: 'zzz' } })
  assert.equal(rows().length, 0)
  assert.ok(render().some(node => node.props?.role === 'status' && node.children.includes('没有找到匹配的会话')))
})

// The unsent new-conversation draft lists as its own 新会话 row of its project,
// above the sessions, so switching sessions cannot orphan the draft.
test('the rail lists the pending draft as a 新会话 row that returns to it', async () => {
  const slots = []
  let cursor = 0
  const { Rail, SessionRow, RoleAvatar } = await loadRail({ useState: (initial) => {
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
  assert.equal(row.children[0].type, RoleAvatar, 'the draft row leads with its role avatar')
  assert.equal(row.children[0].props.profile.id, 'fish')
  assert.deepEqual(row.children[1].children, ['新会话'])
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
  const top = tree => tree.find(node => node.type === 'nav').children.filter(child => child?.props?.className === 'nodo-tree-node')
  const toggleOf = node => node.children[0].children[0]
  const state = tree => tree.find(node => node.props?.className === 'nodo-tree-state')
  let tree = render()
  // Workspaces sort by createdAt desc: the branch (busy) comes first.
  assert.deepEqual(top(tree).map(node => node.props.key), ['branch', 'main'])
  assert.deepEqual(top(tree).map(node => toggleOf(node).props['aria-expanded']), [false, true], 'only the current project opens')
  assert.equal(toggleOf(top(tree)[0]).children[0].children[0].type, 'IconBranchOutlineRegular')
  assert.deepEqual(state(tree).children.map(child => child.props?.kind ?? child), ['run', '1 个运行中'])
  view.work.away = { active: true, status: 'waiting-approval' }
  assert.deepEqual(state(render()).children.map(child => child.props?.kind ?? child), ['wait', '待处理'])
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
  assert.equal(projects.children[0].children[0], '项目区', 'every project sits under one 项目区 header')
  nodes(projects).find(node => node.type === 'button' && node.props['aria-label'] === '添加项目').props.onClick({ stopPropagation() {} })
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
  assert.equal(modelName('opencode-go/deepseek-v4'), 'deepseek-v4', 'a provider/model route reads as its model')
  assert.equal(modelName('glm-5'), 'glm-5', 'a plain id keeps its own wording')
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
  const { RoleEditor } = await loadRoleEditor({
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
  const select = (held, label) => render(held).find(node => node.type === 'select' && node.props['aria-label'] === label)
  const level = held => render(held).find(node => node.props?.label === '思考强度')
  render(profile); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([select(profile, 'Agent').props.value, select(profile, '模型').props.value, level(profile).props.value], ['zcode', 'glm-x', 'high'],
    'the card shows the pair it already carries')
  assert.deepEqual([...level(profile).props.options].map(option => option.label), ['High', 'Low'], 'the levels read as one segmented row without a default entry')
  assert.deepEqual(select(profile, '模型').children.filter(Boolean).map(option => [option.type, option.props.label]),
    [['optgroup', 'Mock'], ['optgroup', 'Other']], 'a provider keeps its own section like the composer picker')
  select(profile, '模型').props.onChange({ target: { value: 'glm-y' } })
  assert.equal(level(profile).props.value, '', 'a level the next model lacks resets to following its default')
  select(profile, '模型').props.onChange({ target: { value: 'glm-x' } })
  level(profile).props.onChange('low')
  await render(profile).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const sent = requests.at(-1)
  assert.equal(sent.endpoint, 'profile-update')
  assert.deepEqual({ model: sent.payload.changes.model, thinking: sent.payload.changes.thinking }, { model: 'glm-x', thinking: 'low' },
    'the picked pair is what the card saves')
  // Nothing saved yet: the catalog's default model stands in and the level
  // selector starts at "follow the model default".
  states.length = 0; effects.length = 0; mounted = false
  render(undefined); mounted = true; effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([select(undefined, '模型').props.value, level(undefined).props.value], ['glm-x', ''],
    'an unset pair reads the model default and follows it')
  // Another engine owns another model table: the switch restarts the pair.
  select(undefined, 'Agent').props.onChange({ target: { value: 'mock' } })
  assert.deepEqual([select(undefined, '模型').props.value, level(undefined).props.value], ['mock-a', ''],
    'an engine switch restarts the pair on the next engine\'s own table')
  level(undefined).props.onChange('mid')
  assert.equal(level(undefined).props.value, 'mid')
  level(undefined).props.onChange('mid')
  assert.equal(level(undefined).props.value, '', 'picking the held level again returns to the model default')
  render(undefined).find(node => node.props['aria-label'] === '名字')
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
  assert.equal(render().filter(node => node.props.className === 'nodo-template-pick').length, 4, 'the box shows four templates until expanded')
  render().find(node => node.props.className === 'nodo-text-button' && node.props['aria-expanded'] === false).props.onClick()
  const cards = () => render().filter(node => node.props.className === 'nodo-template-pick')
  const nameOf = card => card.children.find(child => child?.props?.className === 'nodo-template-name').children.join('')
  const pick = name => cards().find(card => nameOf(card) === name).props.onClick()
  const pressed = () => cards().filter(card => card.props['aria-pressed']).map(nameOf)
  const roleInput = () => render().find(node => node.type === 'input' && node.props.placeholder === '一句话说明这个角色做什么')
  const instructions = () => render().find(node => node.type === 'textarea').props.value
  const filled = () => render().find(node => node.props.className === 'nodo-template-filled')
  assert.deepEqual(cards().map(nameOf), presets.filter(item => item.name !== 'leader').map(item => item.name), 'executor templates exclude leader')
  assert.deepEqual(pressed(), [], 'a new role starts on its own text')
  const [coder, reviewer] = ['coder', 'reviewer'].map(name => presets.find(item => item.name === name))
  pick('coder')
  assert.deepEqual(pressed(), ['coder'])
  assert.equal(roleInput().props.value, coder.role)
  assert.equal(instructions(), coder.instructions)
  assert.equal(filled().children.filter(item => typeof item === 'string').join(''), '已用「coder」填写身份、职责概述和身份信息')
  filled().children.find(item => item?.type === 'button').props.onClick()
  assert.equal(roleInput().props.value, '', '撤销 restores the text the template replaced')
  assert.equal(instructions(), '')
  assert.equal(filled(), undefined)
  pick('coder')
  pick('reviewer')
  filled().children.find(item => item?.type === 'button').props.onClick()
  assert.equal(roleInput().props.value, coder.role, 'a second fill takes back to the first template')
  pick('coder')
  roleInput().props.onChange({ target: { value: `${coder.role}，并补测试` } })
  assert.deepEqual(pressed(), [], 'an edit leaves the template')
  assert.equal(filled(), undefined)
  pick('reviewer')
  render().find(node => node.props['aria-label'] === '名字')
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
  render().find(node => node.props.className === 'nodo-text-button' && node.props['aria-expanded'] === false).props.onClick()
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
  assert.equal(render().find(node => node.props['aria-label'] === '名字').props.value, 'Reviewer')
  const meta = render().find(node => node.props.className === 'nodo-role-meta').children.filter(Boolean)
  assert.deepEqual([meta[0].children.at(-1), meta.at(-1).children.join('')], ['Echo', '3 个会话'])
  assert.deepEqual(tabs(), [])
  assert.equal(text('nodo-tag'), undefined, 'an executor carries no kind tag')
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

test('the role editor follows the detail design: back link, cancel only while dirty, segmented permission', async () => {
  let backed = 0
  const { RoleEditor, host } = await loadRoleEditor({ call: async endpoint => endpoint === 'engine-catalog'
    ? [{ id: 'echo', label: 'Echo', capabilities: { permissionModes: ['plan', 'workspace'] }, catalog: { models: [] } }] : {} })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const profile = { id: 'r', name: 'R', engine: 'echo', permission: 'plan', sessions: [], model: 'm-x', thinking: 'high', createdAt: Date.now() - 3.5 * 86400000 }
  const render = () => { host.reset(); const tree = nodes(RoleEditor({ profile, onSaved() {}, onCancel() {}, onBack: () => { backed++ } })); host.effects.splice(0).forEach(effect => effect()); return tree }
  const buttons = () => render().filter(node => node.type === 'Button').map(node => node.children.join(''))
  render(); await new Promise(resolve => setImmediate(resolve))
  render().find(node => node.props.className === 'nodo-assign-back').props.onClick()
  assert.equal(backed, 1)
  assert.deepEqual(buttons(), ['保存'], 'a clean card shows only the disabled save')
  assert.equal(render().find(node => node.type === 'Button').props.disabled, true)
  assert.equal(render().find(node => node.props.segmented === true)?.props.value, 'plan', 'permission is a segmented row')
  assert.equal(render().some(node => node.children?.includes('预算')), false, 'the budget row has no data model')
  const meta = render().find(node => node.props.className === 'nodo-role-meta').children.filter(Boolean)
  assert.deepEqual(meta.filter(node => node.props.className === 'nodo-role-chip').map(node => node.children.join('')), ['m-x', 'high'], 'model and thinking read as tags')
  assert.equal(meta.at(-1).children.join(''), '还没有会话 · 已创建 3 天')
  render().find(node => node.props['aria-label'] === '名字').props.onChange({ target: { value: 'Renamed' } })
  assert.deepEqual(buttons(), ['取消', '保存'])
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

test('a lead card\'s 1:1 chat gets the plan tier while its Team sessions keep it hidden', async () => {
  const states = [], refs = [], effects = []
  let cursor = 0
  const { AddMenu, PermissionMenu } = await loadClient('composer.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef(initial) { const at = cursor++; return refs[at] ??= { current: initial } },
      useEffect(effect) { effects.push(effect) },
    },
    async call(endpoint) {
      if (endpoint === 'engine-catalog') return [{ id: 'claude', capabilities: { permissionModes: ['plan', 'workspace', 'full'] } }]
      if (endpoint === 'engine-commands') return { source: 'Claude skills and commands', commands: [] }
      return {}
    },
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const chat = { engine: 'claude', permission: 'workspace', lead: true, leadMode: false }
  const team = { engine: 'claude', permission: 'workspace', lead: true }
  const menu = profile => { cursor = 0; return AddMenu({ profile, workspace: { id: 'w1', name: 'one' }, disabled: false, trigger: null,
    onInsert() {}, onModelChange() {} }) }
  const opened = async profile => { menu(profile).props.anchor.props.onClick(); await tick(); await tick(); return menu(profile) }
  assert.equal((await opened(chat)).props.items.some(item => item.id === 'plan'), true, 'the add menu offers plan to a lead 1:1 chat')
  assert.equal((await opened(team)).props.items.some(item => item.id === 'plan'), false, 'a Team lead session keeps plan out of the add menu')
  states.length = 0; refs.length = 0
  const perm = profile => { cursor = 0; return PermissionMenu({ profile, disabled: false, onChange() {} }) }
  const tiers = async profile => { perm(profile).children[0].props.anchor.props.onClick(); await tick(); await tick(); return perm(profile).children[0].props.items.map(item => item.id) }
  assert.deepEqual(await tiers(chat), ['plan', 'workspace', 'full'], 'the permission menu offers every tier to a lead 1:1 chat')
  assert.deepEqual(await tiers(team), ['workspace', 'full'], 'a Team lead session keeps plan out of the permission menu')
})

test('a lead card\'s 1:1 chat keeps usage rows while Team sessions hide them', async () => {
  const states = [], effects = []
  let cursor = 0
  const lines = [
    { who: 'user', kind: 'text', text: 'hi', at: 1 },
    { who: 'system', kind: 'usage', usage: { inputTokens: 3, outputTokens: 4 }, at: 2 },
  ]
  const { Feed, TurnUsage } = await loadClient('feed.js', {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
      useRef: initial => ({ current: null }),
      useEffect(effect) { effects.push(effect) },
    },
    uiShared: {
      call: async () => lines, MARKDOWN_LABELS: {}, TOOL_VARIANTS: {}, toolVariant: () => 'run', ComposerGlyph: () => 'send',
      billedTokens: stats => stats.inputTokens + stats.outputTokens, cacheHitPercent: () => null, contextPercent: () => null,
      compactTokens: value => String(value), compactDuration: () => '', exactTokens: value => String(value),
      tokensPerSecond: () => '', turnTokens: usage => (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  })
  const all = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all), ...Object.values(tree.props ?? {}).flatMap(all)] : []
  const render = (profile, session) => { cursor = 0; return all(Feed({ profile, session, revision: 1, work: null, sentTick: 0 })) }
  const open = async (profile, session) => {
    render(profile, session)
    for (const effect of effects.splice(0)) effect()
    await new Promise(resolve => setImmediate(resolve))
    return render(profile, session)
  }
  const lead = { id: 'lead', engine: 'claude', lead: true }
  assert.equal((await open(lead, { id: 'chat', leadMode: false })).some(node => node.type === TurnUsage), true, 'a 1:1 chat session shows its usage rows')
  states.length = 0
  assert.equal((await open(lead, { id: 'team' })).some(node => node.type === TurnUsage), false, 'a Team lead session keeps usage hidden')
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
  const dockButton = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label)
  const [sessions, roles] = ['主页', '角色'].map(label => dockButton(tree, label))
  assert.deepEqual([sessions.props['aria-pressed'], roles.props['aria-pressed']], [false, true])
  assert.equal(roles.props.onClick, undefined, 'the current view is not a link to itself')
  sessions.props.onClick()
  assert.deepEqual(calls, ['sessions'])
  const plain = render(null)
  assert.equal(plain.props['aria-label'], '角色与项目会话')
  const idle = dockButton(plain, '主页')
  assert.equal(idle.props['aria-pressed'], true)
  assert.ok(nodes(plain).some(node => node.props.className === 'nodo-roster'), 'without a published view the roster returns')
})

// The roles page is the single place roles and teams are configured. The main
// area shows the role grid and team tree, the picked role's editor or the task
// assignment page; switching with unsaved edits asks first.
const loadRolesPage = async options => loadClient(['roles.tsx', 'profile-dialogs.js', 'avatar.tsx', 'teams.tsx'], options)

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
    const { RoleEditor, host } = await loadRoleEditor({ call: async endpoint => endpoint === 'engine-catalog'
      ? [{ id: 'echo', catalog: { models: [] } }] : {} })
    const profile = { id: 'role', name: 'Role', engine: 'echo', lead, instructions: 'original', sessions: [] }
    const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
    const render = () => { host.reset(); const tree = nodes(RoleEditor({ profile, savedIdentities: [own], onSaved() {},
      onDirtyChange: value => dirty.push(value) })); host.effects.splice(0).forEach(effect => effect()); return tree }
    render(); await new Promise(resolve => setImmediate(resolve))
    const expand = () => render().find(node => node.props.className === 'nodo-text-button' && node.props['aria-expanded'] === false)?.props.onClick()
    const cards = () => render().filter(node => node.props.className === 'nodo-template-pick')
    const names = () => cards().map(card => card.children[0].children[0])
    expand()
    assert.deepEqual(names(), lead ? ['leader'] : [...presets.filter(item => item.name !== 'leader').map(item => item.name), own.name])
    assert.equal(render().some(node => node.children.includes('存为模板')), !lead)
    assert.equal(render().some(node => node.props.role === 'tablist' || node.props.role === 'tabpanel' || node.props.className === 'nodo-role-kind'), false)
    assert.equal(render().some(node => node.props.role === 'switch'), false)
    const template = lead ? presets.find(item => item.name === 'leader') : own
    const chosen = cards().find(card => card.children[0].children[0] === template.name)
    assert.equal(chosen.props.title, template.role)
    assert.equal(chosen.children.length, 1, 'template pills show only their names')
    chosen.props.onClick()
    assert.equal(dirty.at(-1), false)
    const tree = render()
    assert.equal(dirty.at(-1), true, 'template edits reach the page guard')
    const input = label => tree.find(node => node.props['aria-label'] === label)
    assert.equal(input('职责概述').props.value, template.role)
    assert.equal(input('身份信息').props.value, template.instructions)
    assert.equal(cards().find(card => card.props['aria-pressed']).children[0].children[0], template.name)
    input('职责概述').props.onChange({ target: { value: '自由职责' } })
    assert.equal(cards().some(card => card.props['aria-pressed']), false)
    assert.equal(render().find(node => node.props.className === 'nodo-tag')?.children[0], lead ? '主控' : undefined)
  }
})

// The overview tree reaches into Menu anchors and items through props.
const rolesTree = node => node && typeof node === 'object'
  ? [node, ...[...(node.children ?? []), ...Object.values(node.props ?? {})].flatMap(rolesTree)] : []
const rolesText = node => ['string', 'number'].includes(typeof node) ? String(node) : (node?.children ?? []).map(rolesText).join('')
const tickAll = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve)) }

test('the last executor stays protected while a lead exists', async () => {
  const states = [], pending = []
  cursor = 0
  const view = { profiles: [
    { id: 'lead', name: 'Lead', engine: 'echo', lead: true, sessions: [] },
    { id: 'a', name: 'First', engine: 'echo', sessions: [] },
    { id: 'b', name: 'Second', engine: 'echo', sessions: [] },
  ], taskTypes: [], teams: [] }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async () => [] })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const editor = () => render().find(node => node.type === loaded.RoleEditor)
  loaded.openRoles({ profileId: 'b' })
  assert.equal(editor().props.deleteReason, undefined)
  view.profiles = view.profiles.filter(role => role.id !== 'a')
  assert.equal(editor().props.deleteReason, '主控至少需要一个执行角色')
  view.profiles = view.profiles.filter(role => role.id !== 'lead')
  assert.equal(editor().props.deleteReason, undefined)
})

test('an empty roles page opens the role editor on a blank role', async () => {
  const loaded = await loadRolesPage({ call: async () => [] })
  const render = () => { loaded.host.reset(); return rolesTree(loaded.RolesPage({ view: { profiles: [] }, readOnly: false, refresh: async () => {} })) }
  const editor = render().find(node => node.type === loaded.RoleEditor)
  assert.equal(editor.props.profile, null)
  assert.equal(editor.props.onBack, null, 'with no executor there is no overview to go back to')
  assert.equal(render().some(node => node.type === loaded.TeamsSection), false, 'teams wait for a first role')
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

test('创建角色 opens the role editor on a blank role and leaves it through 取消 or the unsaved guard', async () => {
  const states = [], pending = []
  cursor = 0
  const view = { profiles: [{ id: 'lead', name: '决策者', engine: 'echo', lead: true, sessions: [] }, { id: 'a', name: 'Writer', engine: 'echo', sessions: [] }],
    workspaces: [], work: {}, taskTypes: [], teams: [], prefs: {} }
  const loaded = await loadRolesPage({ react: rolesReact(states, pending), call: async () => [], globals: { document: { querySelector: () => null } } })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    pending.splice(0).forEach(effect => effect()); return tree }
  const editor = () => render().find(node => node.type === loaded.RoleEditor)
  const add = () => render().find(node => node.props?.className === 'nodo-roles-add' && node.children.includes('创建角色'))
  assert.equal(editor(), undefined)
  add().props.onClick()
  assert.equal(editor().props.profile, null)
  assert.equal(editor().props.avatarSeed, 2, 'the avatar follows the role count')
  editor().props.onCancel()
  assert.equal(editor(), undefined, '取消 returns to the overview')
  add().props.onClick()
  editor().props.onDirtyChange(true)
  let left = 0
  loaded.rolesGuard(() => left++)
  assert.ok(render().find(node => node.type === 'Modal'), 'typed edits ask before leaving')
  assert.equal(left, 0)
  editor().props.onBack()
  assert.ok(render().find(node => node.type === 'Modal'))
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
      roleStateOf: () => ({ active: false }), workKind: () => 'stop', WorkDot: 'WorkDot', workLabel: () => '', sessionTime: () => '刚刚',
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
  rail().find(node => node.props?.className === 'nodo-roster-item nodo-roster-new').props.onClick()
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
  const open = name => render().find(node => node.type === loaded.TeamsSection).props.openRole(view.profiles.find(role => role.name === name).id)
  const overview = () => rolesTree(loaded.rolesSidebarSnapshot().content).find(node => node.props?.className === 'nodo-role-types').props.onClick()
  const assignNav = () => rolesTree(loaded.rolesSidebarSnapshot().content).filter(node => node.props?.className === 'nodo-role-types')[1].props.onClick()
  const editorEl = tree => tree.find(node => node.type === loaded.RoleEditor)
  const editor = () => {
    const tree = render()
    const el = editorEl(tree)
    const shape = el ? nodes(loaded.RoleEditor(el.props)) : []
    pending.splice(0).forEach(effect => effect())
    return { tree, shape }
  }
  const modal = tree => tree.find(node => node.type === 'Modal')
  const nameInput = shape => shape.find(node => node.props['aria-label'] === '名字')

  open('Writer')
  let current = editor()
  await tickAll(); current = editor(); await tickAll()
  nameInput(current.shape).props.onChange({ target: { value: '改过的名字' } })
  current = editor()
  assert.equal(editorEl(current.tree).props.profile.id, 'a')

  assignNav()
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

test('deleting a lead or executor drops session drafts from memory and storage', async () => {
  for (const lead of [false, true]) {
    const states = [], pending = [], calls = [], removed = []
    let stored = { sa: 'draft', other: 'keep' }
    cursor = 0
    const view = {
      profiles: [{ id: 'a', name: 'Writer', engine: 'echo', lead, sessions: [{ id: 'sa' }, { id: 'draft-only', draftedAt: 1, briefSent: false }] }],
      workspaces: [], work: {}, taskTypes: [], teams: [],
    }
    const loaded = await loadRolesPage({
      react: rolesReact(states, pending),
      call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return endpoint === 'engine-catalog'
        ? [{ id: 'echo', label: 'Echo', catalog: { models: [] } }] : { id: payload?.id } },
      globals: { document: { querySelector: () => null },
        localStorage: { getItem: () => JSON.stringify(stored), setItem: (_key, value) => { stored = JSON.parse(value) } } },
    })
    const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} })); pending.splice(0).forEach(effect => effect()); return tree }

    loaded.registerDraftRemover(ids => removed.push([...ids]))
    loaded.openRoles({ profileId: 'a' })
    await render().find(node => node.type === loaded.RoleEditor).props.onDeleted(view.profiles[0])
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
  const nameInput = () => shape().find(node => node.props['aria-label'] === '名字')
  const saveButton = () => shape().find(node => node.type === 'Button' && node.props.type === 'submit')

  const section = () => render().find(node => node.type === loaded.TeamsSection)
  assert.equal(section().props.locked, true)
  assert.equal(section().props.createButton.props.disabled, true)
  section().props.openRole('a')
  for (let round = 0; round < 3; round++) { await tickAll(); shape() }
  assert.equal(nameInput().props.disabled, true, 'the name input stays disabled once the engine catalog arrives')
  assert.equal(saveButton().props.disabled, true, 'the save button stays disabled')
})

test('saving teams makes exactly the lead-column roles leads, demoting before promoting', async () => {
  const states = [], pending = [], calls = []
  cursor = 0
  const view = {
    profiles: [{ id: 'L', name: 'Lead', engine: 'echo', lead: true, sessions: [] }, { id: 'a', name: 'Writer', engine: 'echo', sessions: [] }, { id: 'b', name: 'Coder', engine: 'echo', sessions: [] }],
    workspaces: [], work: {}, taskTypes: [], teams: [{ id: 't1', name: '', lead: 'L', members: ['a'], assign: {} }],
  }
  const loaded = await loadRolesPage({
    react: rolesReact(states, pending),
    call: async (endpoint, body) => { calls.push([endpoint, body]); return endpoint === 'engine-catalog' ? [] : {} },
    globals: { document: { querySelector: () => null } },
  })
  const render = () => { cursor = 0; const tree = rolesTree(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} })); pending.splice(0).forEach(effect => effect()); return tree }
  render().find(node => node.type === loaded.TeamsSection).props.save([{ id: 't1', name: '', lead: 'a', members: ['b'], assign: {} }])
  await tickAll()
  assert.deepEqual(calls.filter(([endpoint]) => endpoint !== 'engine-catalog'), [
    ['profile-update', { id: 'L', changes: { lead: false } }],
    ['profile-update', { id: 'a', changes: { lead: true } }],
    ['teams-update', { teams: [{ id: 't1', name: '', lead: 'a', members: ['b'], assign: {} }] }],
  ])
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
})


const teamRoles = [
  { id: 'L', name: '大总管', engine: 'echo', lead: true },
  { id: 'A', name: '前端', engine: 'echo', model: 'm1' },
  { id: 'B', name: '后端', engine: 'echo' },
]
const teamList = () => [
  { id: 't1', name: '研发', lead: 'L', members: ['A'], assign: { docs: { normal: { profile: 'A' } } } },
  { id: 't2', name: '评审', lead: null, members: [], assign: {} },
]

test('the teams section edits membership by drag and button and saves the whole list', async () => {
  const states = [], pending = []
  cursor = 0
  const { TeamsSection } = await loadRolesPage({ react: rolesReact(states, pending), globals: { crypto: globalThis.crypto } })
  const saved = [], actives = []
  let teams = teamList(), active = 't1'
  const render = (locked = false) => { cursor = 0; return rolesTree(TeamsSection({ roles: teamRoles, teams, activeId: active, locked,
    onActive: id => { active = id; actives.push(id) }, save: next => { saved.push(JSON.parse(JSON.stringify(next))); teams = next },
    openRole() {}, onAssign() {}, createButton: 'create' })) }
  const cards = () => render().filter(node => node.props?.className === 'nodo-team-card')
  const named = name => cards().find(node => rolesText(node).includes(name))

  assert.equal(cards().length, 3 + 2, 'every role shows in the grid and the team tree lists its lead and members')
  assert.equal(render().filter(node => node.props?.role === 'tab').map(rolesText).join(), '1研发,2评审')
  assert.equal(render().find(node => node.props?.role === 'tab').props['aria-selected'], true)
  assert.equal(rolesText(render().find(node => node.props?.title === '在 1 个团队中')), '1', 'the grid counts a role’s teams')
  assert.equal(render().filter(node => node.props?.className === 'nodo-team-slot').map(rolesText).join(), '拖入角色')

  const dragFromGrid = name => { named(name).props.onDragStart({ dataTransfer: {} }) }
  const panel = () => render().find(node => node.props?.className === 'nodo-team-panel')
  dragFromGrid('后端')
  panel().props.onDrop({ preventDefault() {} })
  assert.deepEqual(saved.at(-1)[0].members, ['A', 'B'], 'dropping on the panel adds the role')
  assert.deepEqual(actives.at(-1), 't1')

  assert.equal(render().some(node => rolesText(node) === '主控'), false, 'cards carry no lead mark or toggle')
  const leadColumn = () => render().find(node => node.props?.className === 'nodo-team-col' && node.props.onDrop)
  dragFromGrid('前端')
  leadColumn().props.onDrop({ preventDefault() {} })
  assert.deepEqual([saved.at(-1)[0].lead, saved.at(-1)[0].members], ['A', ['B']], 'dropping on the lead column makes the role this team’s lead')

  teams = teamList()
  dragFromGrid('大总管')
  render().filter(node => node.props?.role === 'tab')[1].props.onDrop({ preventDefault() {} })
  assert.deepEqual(saved.at(-1).map(team => [team.lead, team.members]), [[null, ['A']], [null, ['L']]], 'dropping a lead on another tab makes it a member there')
  assert.equal(actives.at(-1), 't2')

  active = 't1'
  teams = teamList()
  render().find(node => node.props?.['aria-label'] === '把 前端 移出团队').props.onClick()
  assert.deepEqual(saved.at(-1)[0].members, [])
  assert.equal(saved.at(-1)[0].assign.docs.normal.profile, undefined, 'a removed member leaves its assignments empty')

  render().find(node => node.props?.['aria-label'] === '新增团队').props.onClick()
  assert.equal(saved.at(-1).length, 3)
  assert.deepEqual({ ...saved.at(-1)[2], id: 'x' }, { id: 'x', name: '', lead: null, members: [], assign: {} })
  assert.equal(actives.at(-1), saved.at(-1)[2].id)

  active = 't1'; teams = teamList()
  render().find(node => node.props?.['aria-label'] === '团队名称').props.onBlur({ target: { value: '改名' } })
  assert.equal(saved.at(-1)[0].name, '改名')
  render().find(node => node.props?.['aria-label'] === '删除团队').props.onClick()
  assert.deepEqual(saved.at(-1).map(team => team.id), ['t2'])

  assert.equal(render(true).find(node => node.props?.['aria-label'] === '新增团队').props.disabled, true)
  assert.equal(render(true).find(node => node.props?.className === 'nodo-team-card').props.draggable, false)
})

test('the assignment page picks roles with model and thinking, splits hard tasks and edits types in place', async () => {
  const states = [], pending = []
  cursor = 0
  const loaded = await loadRolesPage({ react: rolesReact(states, pending) })
  const engines = [{ id: 'echo', catalog: { defaultModel: 'm1', models: [
    { id: 'm1', label: 'M1', defaultThinking: 'low', thinking: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }] },
    { id: 'm2', label: 'M2', thinking: [{ id: 'low', label: '低' }] },
  ] } }]
  const savedTeams = [], savedTypes = []
  let teams = [{ id: 't1', name: '研发', lead: 'L', members: ['A', 'B'], assign: { docs: { normal: { profile: 'A' } } } }]
  let types = [{ id: 'docs', name: '文档', when: '写说明' }, { id: 'ops', name: '运维', when: '' }]
  let disabled = false
  const render = () => { cursor = 0; return rolesTree(loaded.AssignPage({ roles: teamRoles, teams, types, engines, activeId: 't1', disabled,
    onActive() {}, onBack() {}, save: next => { savedTeams.push(JSON.parse(JSON.stringify(next))); teams = next },
    saveTypes: async next => { savedTypes.push(JSON.parse(JSON.stringify(next))); types = next } })) }
  const slots = { '文档': 100, '运维': 101, '文档 · 困难任务': 102 }
  const cell = label => {
    const element = render().find(node => node.type === loaded.PickCell && node.props.label === (label.includes('困难') ? label : `${label} · 普通和困难任务`))
    cursor = slots[label]
    return rolesTree(loaded.PickCell(element.props))
  }
  const trigger = label => cell(label).find(node => node.props?.className === 'nodo-pick-trigger')
  const options = label => cell(label).filter(node => node.props?.className === 'nodo-pick-option')
  const press = (label, text) => options(label).find(node => rolesText(node) === text).props.onClick()
  const gap = () => { const node = render().find(node => node.props?.className === 'nodo-assign-gap'); return node && rolesText(node) }

  assert.equal(gap(), '1 处无人承接', '运维 has nobody yet')
  assert.equal(rolesText(cell('文档').find(node => node.props?.className === 'nodo-pick-name')), '前端')
  assert.equal(rolesText(cell('运维').find(node => node.props?.className === 'nodo-pick-name')), '无人承接')
  trigger('文档').props.onClick()
  assert.deepEqual(options('文档').map(rolesText), ['前端', '后端', 'M1', 'M2', '低', '高'], '不单独指定 only belongs to the hard cell')
  assert.deepEqual(options('文档').filter(node => node.props['aria-pressed']).map(rolesText), ['前端'], 'a model and thinking level nobody picked stay unmarked')
  press('文档', '高')
  assert.deepEqual(savedTeams.at(-1)[0].assign.docs.normal, { profile: 'A', thinking: 'high' })
  assert.deepEqual(options('文档').filter(node => node.props['aria-pressed']).map(rolesText), ['前端', '高'], 'only the explicit pick is marked')
  press('文档', 'M2')
  assert.deepEqual(savedTeams.at(-1)[0].assign.docs.normal, { profile: 'A', model: 'm2' }, 'a thinking level the new model lacks is dropped')
  press('文档', '后端')
  assert.deepEqual(savedTeams.at(-1)[0].assign.docs.normal, { profile: 'B' }, 'another role starts from its own settings')

  trigger('运维').props.onClick()
  press('运维', '前端')
  assert.deepEqual(savedTeams.at(-1)[0].assign.ops.normal, { profile: 'A' })
  assert.equal(gap(), undefined, 'every type has a holder')

  render().find(node => node.props?.className === 'nodo-assign-split' && node.props.disabled === false).props.onClick()
  assert.deepEqual(savedTeams.at(-1)[0].assign.docs.hard, {}, 'a split without a role is a gap')
  assert.equal(gap(), '1 处无人承接')
  trigger('文档 · 困难任务').props.onClick()
  assert.equal(options('文档 · 困难任务').some(node => rolesText(node) === '不单独指定'), true)
  press('文档 · 困难任务', '前端')
  assert.deepEqual(savedTeams.at(-1)[0].assign.docs.hard, { profile: 'A' })
  assert.equal(gap(), undefined)
  press('文档 · 困难任务', '不单独指定')
  assert.equal(Object.hasOwn(savedTeams.at(-1)[0].assign.docs, 'hard'), false)

  const form = () => render().find(node => node.type === 'form')
  const field = label => rolesTree(form()).find(node => node.props?.['aria-label'] === label)
  const add = () => rolesTree(form()).find(node => node.props?.type === 'submit')
  render().find(node => node.props?.className === 'nodo-roles-add').props.onClick()
  field('类型名称').props.onChange({ target: { value: '文档' } })
  assert.equal(add().props.disabled, true, 'a name already in the catalog cannot be added')
  field('类型名称').props.onChange({ target: { value: '审查' } })
  field('类型说明').props.onChange({ target: { value: '看改动' } })
  assert.equal(add().props.disabled, false)
  form().props.onSubmit({ preventDefault() {} })
  await tickAll()
  assert.deepEqual(savedTypes.at(-1), [...types.slice(0, 2), { name: '审查', when: '看改动' }].map(item => item), 'the new type carries no id so core issues one')
  assert.equal(form(), undefined, 'the form closes after adding')

  render().find(node => node.props?.['aria-label'] === '任务类型名称 文档').props.onBlur({ target: { value: ' 文档组 ' } })
  assert.equal(savedTypes.at(-1)[0].name, '文档组')
  render().find(node => node.props?.['aria-label'] === '任务类型说明 运维').props.onBlur({ target: { value: '部署' } })
  assert.equal(savedTypes.at(-1)[1].when, '部署')
  cell('运维').find(node => node.props?.['aria-label'] === '删除 运维').props.onClick()
  cell('运维').find(node => node.props?.className === 'nodo-assign-confirm').props.onClick()
  assert.deepEqual(savedTypes.at(-1).map(item => item.name), ['文档组', '审查'], '运维 leaves after the inline confirm')

  disabled = true
  assert.equal(render().find(node => node.props?.className === 'nodo-roles-add').props.disabled, true)
  assert.equal(render().find(node => node.props?.['aria-label'] === '任务类型名称 文档组').props.disabled, true)
})
