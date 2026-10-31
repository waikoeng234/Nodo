import { heldImages } from './page.js'

export function createNativeSpace(ctx, Sidebar, SidebarControl) {
  let saved
  try { saved = JSON.parse(localStorage.getItem('nodo.space')) } catch {}
  let state = { active: false, legacy: saved?.legacy === true, nativeSession: saved?.nativeSession, nodoSession: saved?.nodoSession, draft: saved?.draft, drafting: saved?.drafting ?? !!saved?.draft }
  let awaitingEntry = false
  const listeners = new Set()
  const current = () => ctx.uiSession.adapter.current.getSnapshot().key
  const publish = changes => {
    const next = { ...state, ...changes }
    if (Object.keys(next).every(key => next[key] === state[key])) return
    state = next
    try { localStorage.setItem('nodo.space', JSON.stringify(state)) } catch {}
    for (const listener of listeners) listener()
  }
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  // An empty draft is worth nothing: any navigation away from it drops it. Text,
  // images, pinned references or picked files count as input and keep it (and
  // its rail row).
  const draftEmpty = draft => {
    const read = key => { try { return JSON.parse(localStorage.getItem(key)) } catch {} }
    const key = `new:${draft.id}`
    return String(read('nodo.drafts')?.[key] ?? '').trim() === ''
      && !read('nodo.draft-options')?.[key]?.references?.length && !read('nodo.draft-options')?.[key]?.files?.length
      && !heldImages?.[key]?.length
  }
  const keptDraft = () => state.draft && draftEmpty(state.draft) ? { draft: undefined } : {}
  const away = () => ({ drafting: false, ...keptDraft() })
  const resume = () => {
    const catalog = ctx.sessions.list.getSnapshot()
    if (!awaitingEntry || catalog.phase !== 'ready') return
    awaitingEntry = false
    if (state.legacy || state.drafting) ctx.layout.selectPanel('nodo')
    else if (state.nodoSession && catalog.byId[state.nodoSession]) ctx.uiWorkspace.openSession(state.nodoSession)
    else { publish({ nodoSession: undefined }); ctx.layout.selectPanel(null) }
  }
  const enter = () => {
    if (!state.active) publish({ active: true, nativeSession: current() === state.nodoSession ? state.nativeSession : current() ?? state.nativeSession })
    awaitingEntry = true
    resume()
    if (document.querySelector('[data-sidebar-collapsed]')) ctx.layout.toggleSidebar()
  }
  const seat = (slot, Component) => ctx.slots.inject(slot.name, () => {
    let unregister
    const update = () => {
      if (state.active && !unregister) unregister = ctx.slots.register(slot, Component)
      else if (!state.active && unregister) { unregister(); unregister = null }
    }
    const stop = subscribe(update)
    update()
    return () => { stop(); unregister?.() }
  })
  seat({ name: 'sidebar', priority: -100 }, Sidebar)
  seat({ name: 'shell.overlay', id: 'nodo.sidebar-toggle' }, SidebarControl)
  ctx.effect(() => {
    let live = true
    let selected = current()
    const stop = ctx.uiSession.adapter.current.subscribe(() => {
      const id = current()
      if (id === selected) return
      selected = id
      if (state.active && !state.legacy && id) publish({ nodoSession: id, ...away() })
    })
    const stopCatalog = ctx.sessions.list.subscribe(resume)
    if (saved?.active) queueMicrotask(() => { if (live) enter() })
    return () => { live = false; stop(); stopCatalog(); listeners.clear() }
  }, 'nodo: native space')
  return {
    subscribe, getSnapshot: () => state, enter,
    leave() {
      awaitingEntry = false
      publish({ active: false, ...keptDraft() })
      if (state.nativeSession && ctx.sessions.list.getSnapshot().byId[state.nativeSession]) ctx.uiWorkspace.openSession(state.nativeSession)
      else ctx.layout.selectPanel(null)
    },
    // The draft outlives session switches when it has input and is reachable
    // from the rail's "新会话" row; only its own successful send ends it.
    // `drafting` marks the draft as the page on show, apart from merely kept.
    // Another recipient gets its own draft: the open one would keep showing the
    // role its composer was seeded with, not the requested one.
    startDraft(options) {
      const held = state.draft && (options.profile === undefined || options.profile === state.draft.profile)
      publish({ legacy: false, drafting: true, draft: held ? { ...state.draft, ...options, id: state.draft.id } : { ...options, id: crypto.randomUUID() } })
      ctx.layout.selectPanel('nodo')
    },
    resumeDraft() { publish({ legacy: false, drafting: true }); ctx.layout.selectPanel('nodo') },
    endDraft(id) { if (state.draft?.id === id) publish({ draft: undefined, drafting: false }) },
    open(id) { publish({ legacy: false, nodoSession: id, ...away() }); ctx.uiWorkspace.openSession(id) },
    showLegacy() { publish({ legacy: true, ...away() }); ctx.layout.selectPanel('nodo') },
  }
}
