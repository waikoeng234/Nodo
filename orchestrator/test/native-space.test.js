import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'
import { randomUUID } from 'node:crypto'

async function harness(saved, ready = true) {
  let selected = ready ? 'ordinary-session' : undefined
  const known = new Set(['ordinary-session', saved?.nodoSession].filter(Boolean))
  const catalogListeners = new Set()
  const storage = new Map(saved ? [['nodo.space', JSON.stringify(saved)]] : [])
  const listeners = new Set()
  const registrations = []
  const effects = []
  const pending = []
  const panels = []
  let factory, sequence = 0
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ phase: ready ? 'ready' : 'pending', byId: Object.fromEntries([...known].map(id => [id, {}])) }),
      subscribe: listener => { catalogListeners.add(listener); return () => catalogListeners.delete(listener) } } },
    layout: { selectPanel: id => panels.push(id), toggleSidebar() {} },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: selected }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } } },
    uiWorkspace: { openSession(id) { assert.ok(ready, 'native navigation must wait for the host catalog'); known.add(id); selected = id; panels.push(null); for (const listener of listeners) listener() } },
    effect: run => effects.push(run()),
    slots: { inject: (_name, run) => { factory = run }, register(options, component) {
      const entry = { options, component, id: ++sequence }
      registrations.push(entry)
      return () => registrations.splice(registrations.indexOf(entry), 1)
    } },
  }
  const { createNativeSpace } = await loadClient('native-space.js', {
    globals: { crypto: { randomUUID }, document: { querySelector: () => null }, queueMicrotask: fn => pending.push(fn),
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
  })
  const Sidebar = () => null
  const space = createNativeSpace(ctx, Sidebar)
  const unmount = factory()
  pending.forEach(run => run())
  return { space, registrations, panels, storage, get selected() { return selected },
    notifyCurrent() { for (const listener of listeners) listener() },
    selectNative: ctx.uiWorkspace.openSession,
    loadCatalog() { ready = true; for (const listener of catalogListeners) listener() },
    dispose() { unmount(); effects.forEach(dispose => dispose()) } }
}

test('Nodo replaces the whole sidebar and retains it across native role and session switches', async () => {
  const h = await harness()
  assert.equal(h.registrations.length, 0)
  h.space.enter()
  const sidebar = h.registrations[0]
  assert.equal(sidebar.options.name, 'sidebar', 'the whole sidebar must be replaced, not its workspaces region')
  assert.equal(h.panels.at(-1), null)
  for (const id of ['codex-session', 'dsh-session', 'codex-second-session']) {
    h.space.open(id)
    assert.equal(h.selected, id)
    assert.equal(h.registrations[0], sidebar, 'opening a native session must not unmount the Nodo rail')
    assert.equal(h.space.getSnapshot().active, true)
  }
  h.space.leave()
  assert.equal(h.selected, 'ordinary-session')
  assert.equal(h.registrations.length, 0, 'leaving restores the host sidebar occupant')
  h.space.enter()
  assert.equal(h.selected, 'codex-second-session')
  h.dispose()
  assert.equal(h.registrations.length, 0)
})

test('legacy engine content retains the Nodo sidebar and can return to a native role', async () => {
  const h = await harness()
  h.space.enter()
  const sidebar = h.registrations[0]
  h.space.showLegacy()
  assert.equal(h.panels.at(-1), 'nodo')
  assert.equal(h.registrations[0], sidebar)
  h.space.open('codex-session')
  assert.equal(h.space.getSnapshot().legacy, false)
  assert.equal(h.panels.at(-1), null)
  assert.equal(h.registrations[0], sidebar)
  h.dispose()
})

const input = (storage, draft, text) => storage.set('nodo.drafts', JSON.stringify({ [`new:${draft.id}`]: text }))

test('a draft holding only picked files survives navigation away', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  const draft = h.space.getSnapshot().draft
  h.storage.set('nodo.draft-options', JSON.stringify({ [`new:${draft.id}`]: { files: [{ id: '11111111-1111-1111-1111-111111111111', name: 'spec.pdf' }] } }))
  h.space.open('native-role')
  assert.equal(h.space.getSnapshot().draft, draft, 'picked files count as input and keep the draft')
  h.storage.set('nodo.draft-options', JSON.stringify({ [`new:${draft.id}`]: {} }))
  h.space.open('ordinary-session')
  assert.equal(h.space.getSnapshot().draft, undefined, 'an emptied draft is still dropped')
  h.dispose()
})

test('new conversation opens a local draft without a role and input keeps it across navigation', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  assert.equal(h.selected, 'ordinary-session', 'opening a draft must not create or navigate to a host session')
  assert.equal(h.panels.at(-1), 'nodo')
  assert.equal(h.space.getSnapshot().draft.profile, undefined)
  assert.equal(h.space.getSnapshot().draft.workspace, 'project')
  const draft = h.space.getSnapshot().draft
  input(h.storage, draft, '任务说明')
  h.space.open('native-role')
  assert.equal(h.space.getSnapshot().draft, draft, 'a draft with input survives the session switch')
  assert.equal(h.selected, 'native-role')
  h.space.resumeDraft()
  assert.equal(h.panels.at(-1), 'nodo')
  assert.equal(h.space.getSnapshot().draft, draft)
  h.space.endDraft(draft.id)
  assert.equal(h.space.getSnapshot().draft, undefined)
  h.dispose()
})

test('a kept draft yields the page to the opened session until the rail row reopens it', async () => {
  const h = await harness()
  const { setHostServices, NodoEntry, NewConversation, NodoPage } = await loadClient(['ui-shared.js', 'page.js'], {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useEffect: () => {} },
    createElement: (type, props) => ({ type, props }),
  })
  setHostServices({ nativeSpace: h.space })
  const shown = () => NodoEntry()?.type ?? null
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  input(h.storage, h.space.getSnapshot().draft, '任务说明')
  assert.equal(shown(), NewConversation)
  h.space.open('native-role')
  assert.equal(shown(), null, 'the opened native session must not stay covered by the kept draft')
  h.space.resumeDraft()
  assert.equal(shown(), NewConversation)
  h.selectNative('other-native')
  assert.equal(shown(), null, 'a host-driven session change shows that session')
  assert.ok(h.space.getSnapshot().draft, 'the draft is still kept for its rail row')
  h.space.leave()
  h.space.enter()
  assert.equal(h.selected, 'other-native', 'entering again opens the session, not the kept draft')
  assert.equal(h.panels.at(-1), null)
  h.space.showLegacy()
  assert.equal(shown(), NodoPage)
  h.dispose()
})

test('switching away drops an empty draft, whatever the route', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  h.space.open('native-role')
  assert.equal(h.space.getSnapshot().draft, undefined, 'an empty draft does not survive open')
  h.space.startDraft({ workspace: 'project' })
  h.space.showLegacy()
  assert.equal(h.space.getSnapshot().draft, undefined, 'an empty draft does not survive the legacy page')
  h.space.startDraft({ workspace: 'project' })
  const draft = h.space.getSnapshot().draft
  h.selectNative('other-native')
  assert.equal(h.space.getSnapshot().draft, undefined, 'a host-driven session change drops the empty draft')
  h.space.startDraft({ workspace: 'project' })
  assert.notEqual(h.space.getSnapshot().draft.id, draft.id, 'the dropped draft is not reused')
  h.space.leave()
  assert.equal(h.space.getSnapshot().draft, undefined, 'leaving drops the empty draft')
  h.dispose()
})

test('a draft opened over an existing session survives entering the space', async () => {
  for (const ready of [true, false]) {
    const h = await harness({ active: true, legacy: false, nodoSession: 'native-role' }, ready)
    assert.equal(h.selected, ready ? 'native-role' : undefined, 'the space restores the role session it was on')
    h.space.startDraft({ profile: 'a', workspace: 'project' })
    const draft = h.space.getSnapshot().draft
    h.space.enter()
    h.loadCatalog()
    assert.equal(h.space.getSnapshot().draft, draft, `entering must not discard a draft while the catalog is ${ready ? 'ready' : 'pending'}`)
    assert.equal(h.panels.at(-1), 'nodo', 'the draft keeps the panel instead of reopening the previous session')
    assert.equal(h.selected, ready ? 'native-role' : undefined, 'entering a draft must not navigate the host conversation')
    h.dispose()
  }
})

test('starting a draft again returns to the same draft with the new seed', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ profile: 'a', workspace: 'project' })
  const draft = h.space.getSnapshot().draft
  input(h.storage, draft, '正文')
  h.space.open('native-role')
  h.space.startDraft({ workspace: 'other' })
  const next = h.space.getSnapshot().draft
  assert.notEqual(next, draft)
  assert.equal(next.id, draft.id, 'the draft id carries the saved text in nodo.drafts')
  assert.equal(next.workspace, 'other')
  assert.equal(next.profile, 'a')
  h.dispose()
})

test('a draft for another recipient starts its own instead of returning the open one', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ profile: 'a', workspace: 'project' })
  const first = h.space.getSnapshot().draft
  input(h.storage, first, '给 A 的任务')
  h.space.open('native-role')
  h.space.startDraft({ profile: 'b', workspace: 'project' })
  const next = h.space.getSnapshot().draft
  assert.notEqual(next.id, first.id, 'the requested role gets a draft of its own')
  assert.equal(next.profile, 'b')
  assert.equal(next.workspace, 'project')
  assert.equal(h.panels.at(-1), 'nodo')
  h.space.endDraft(next.id)
  h.dispose()
})

test('endDraft clears only its own draft', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  const draft = h.space.getSnapshot().draft
  h.space.endDraft('other-draft')
  assert.equal(h.space.getSnapshot().draft, draft)
  h.space.endDraft(draft.id)
  assert.equal(h.space.getSnapshot().draft, undefined)
  h.dispose()
})

test('host updates for the same session preserve a draft and a session change keeps it too', async () => {
  const h = await harness()
  h.space.enter()
  h.space.startDraft({ workspace: 'project' })
  const draft = h.space.getSnapshot().draft
  input(h.storage, draft, '任务说明')
  h.notifyCurrent()
  h.notifyCurrent()
  assert.equal(h.space.getSnapshot().draft, draft)
  assert.equal(h.panels.at(-1), 'nodo')
  h.selectNative('native-role')
  assert.equal(h.space.getSnapshot().draft, draft, 'a native session change must not discard the draft')
  assert.equal(h.space.getSnapshot().nodoSession, 'native-role')
  assert.equal(h.panels.at(-1), null)
  h.dispose()
})

test('reload restores Nodo mode and its last session through the public navigation API', async () => {
  const h = await harness({ active: true, nativeSession: 'ordinary-session', nodoSession: 'codex-session' })
  assert.equal(h.space.getSnapshot().active, true)
  assert.equal(h.selected, 'codex-session')
  assert.equal(h.registrations.length, 1)
  h.space.leave()
  assert.equal(h.selected, 'ordinary-session')
  h.dispose()
})

test('reload waits for the host catalog and preserves the ordinary-space session', async () => {
  const h = await harness({ active: true, nativeSession: 'ordinary-session', nodoSession: 'codex-session' }, false)
  assert.equal(h.selected, undefined)
  assert.equal(h.panels.length, 0)
  h.loadCatalog()
  assert.equal(h.selected, 'codex-session')
  h.space.leave()
  assert.equal(h.selected, 'ordinary-session')
  h.dispose()
})

test('leaving and reloading a legacy conversation retains its main-panel route', async () => {
  const h = await harness({ active: true, legacy: true, nativeSession: 'ordinary-session', nodoSession: 'codex-session' })
  assert.equal(h.panels.at(-1), 'nodo')
  h.space.leave()
  h.space.enter()
  assert.equal(h.panels.at(-1), 'nodo')
  h.space.open('codex-session')
  assert.equal(h.space.getSnapshot().legacy, false)
  h.dispose()
})
