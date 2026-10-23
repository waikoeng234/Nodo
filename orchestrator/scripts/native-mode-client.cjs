const { createElement: h, useSyncExternalStore } = require('react')
const { Button, IconUsersOutlineRegular, IconFolderOpenOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
const STORAGE = 'nodo.native-mode-probe'

function apply(ctx) {
  let saved
  try { saved = JSON.parse(localStorage.getItem(STORAGE)) } catch {}
  let state = { mode: 'native', role: 'Native integration', ...saved, profiles: [], workspaces: [], ready: false, error: '' }
  const listeners = new Set()
  const read = () => state
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const publish = changes => {
    state = { ...state, ...changes }
    localStorage.setItem(STORAGE, JSON.stringify({ mode: state.mode, role: state.role, nativeSession: state.nativeSession, nodoSession: state.nodoSession }))
    for (const listener of listeners) listener()
  }
  const owned = () => new Map(state.profiles.flatMap(profile => (profile.sessions ?? []).filter(session => session.driverSessionId).map(session => [session.driverSessionId, { profile, session }])))
  const currentId = () => ctx.uiSession.adapter.current.getSnapshot().key
  const remember = () => {
    const id = currentId()
    if (!state.ready || !id) return
    const owner = owned().get(id)
    publish(owner ? { mode: 'nodo', role: owner.profile.name, nodoSession: id } : { mode: 'native', nativeSession: id })
  }
  const open = id => {
    if (!id) throw new Error('This space has no session')
    ctx.uiWorkspace.openSession(id)
  }
  const navigate = operation => {
    try { publish({ error: '' }); operation() } catch (error) { publish({ error: error.message }) }
  }
  const switchMode = mode => navigate(() => {
    remember()
    if (mode === 'nodo') {
      const sessions = owned()
      const preferred = sessions.has(state.nodoSession) ? state.nodoSession
        : [...sessions].find(([, owner]) => owner.profile.name === state.role)?.[0] ?? sessions.keys().next().value
      open(preferred)
    } else {
      const rows = Object.values(ctx.sessions.list.getSnapshot().byId).filter(row => !owned().has(row.id))
      open(rows.find(row => row.id === state.nativeSession)?.id ?? rows.find(row => row.title === 'Native plain baseline')?.id ?? rows[0]?.id)
    }
  })
  ctx.effect(() => {
    let active = true
    const current = ctx.uiSession.adapter.current
    const stop = current.subscribe(remember)
    void (async () => {
      const response = await fetch('/api/nodo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }) })
      const result = await response.json()
      if (!result.ok) throw new Error('Cannot read Nodo metadata')
      if (!active) return
      publish({ profiles: result.value.profiles, workspaces: result.value.workspaces, ready: true })
      const target = state.mode === 'nodo' ? state.nodoSession : state.nativeSession
      if (target && ctx.sessions.list.getSnapshot().byId[target]) open(target)
      else remember()
    })().catch(error => { if (active) publish({ error: error.message }) })
    return () => { active = false; stop() }
  })
  function WorkspaceRegion({ useSessions, useWorkspaces, wide, expandSidebar }) {
    const mode = useSyncExternalStore(subscribe, read)
    const sessions = useSessions(snapshot => snapshot)
    const workspaces = useWorkspaces(snapshot => snapshot)
    if (!mode.ready) return h('p', null, '正在连接工作空间…')
    const ownership = owned()
    const selected = currentId()
    const rows = sessions.ids.map(id => sessions.byId[id]).filter(row => mode.mode === 'nodo'
      ? ownership.get(row.id)?.profile.name === mode.role
      : !ownership.has(row.id))
    const button = (label, onClick, selected = false) => h(Button, { variant: 'ghost', size: 'sm', onClick, 'aria-current': selected ? 'page' : undefined, style: { width: '100%', justifyContent: 'flex-start' } }, label)
    return h('section', {
      'data-workspace-mode': mode.mode,
      'data-mode-proof': JSON.stringify({ nativeMain: ctx.layout.panelInfo.getSnapshot().activePanelId === null, rightbarMatchesCurrent: ctx.sidebarRight.mounted.getSnapshot() === selected }),
      style: { padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflow: 'auto' },
    },
      !wide && h(Button, { onClick: expandSidebar, icon: h(IconUsersOutlineRegular) }, '展开工作空间'),
      h('strong', null, mode.mode === 'nodo' ? 'Nodo 空间' : '普通空间'),
      button(mode.mode === 'nodo' ? '返回普通空间' : '进入 Nodo 空间', () => switchMode(mode.mode === 'nodo' ? 'native' : 'nodo')),
      mode.error && h('p', { role: 'alert' }, mode.error),
      mode.mode === 'nodo' && h('div', { 'aria-label': 'Nodo 角色' },
        h('strong', null, '角色'),
        ...mode.profiles.filter(profile => profile.sessions?.some(session => session.driverSessionId)).map(profile => h('div', { key: profile.id }, button(profile.name, () => navigate(() => open(profile.sessions.find(session => session.driverSessionId).driverSessionId)), profile.name === mode.role)))),
      h('strong', null, '项目与会话'),
      ...rows.map(row => {
        const workspace = workspaces.items.find(workspace => workspace.sessionIds.includes(row.id))
        return h('div', { key: row.id, 'data-space-session': row.id },
          h('small', null, h(IconFolderOpenOutlineRegular, { size: 12 }), ' ', workspace?.title ?? '未分组'),
          button(row.displayTitle, () => navigate(() => open(row.id)), selected === row.id))
      }))
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces', priority: -100 }, WorkspaceRegion))
}

module.exports = { inject: ['slots', 'sessions', 'uiSession', 'uiWorkspace', 'layout', 'sidebarRight'], apply }
