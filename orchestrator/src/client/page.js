// Unsent drafts outlive the page: text is kept in localStorage across reloads,
// pasted images (too large for storage) in memory across remounts.
let heldImages = {}
const readDrafts = () => {
  try { return JSON.parse(localStorage.getItem('nodo.drafts')) ?? {} } catch { return {} }
}

let navigationSnapshot
const navigationListeners = new Set()
const readNavigation = () => {
  if (navigationSnapshot === undefined) {
    try { navigationSnapshot = JSON.parse(localStorage.getItem('nodo.navigation') ?? localStorage.getItem('orchestrator.navigation')) ?? {} } catch { navigationSnapshot = {} }
  }
  return navigationSnapshot
}
const subscribeNavigation = listener => { navigationListeners.add(listener); return () => navigationListeners.delete(listener) }
const setNavigation = update => {
  navigationSnapshot = typeof update === 'function' ? update(readNavigation()) : update
  try { localStorage.setItem('nodo.navigation', JSON.stringify(navigationSnapshot)) } catch {}
  for (const listener of navigationListeners) listener()
}
const nativeRole = profile => ['codex', 'claude', 'zcode', 'opencode', 'codebuddy', 'qoder', 'pi', 'dsh'].includes(profile?.engine)
const sessionForWorkspace = (profile, workspace, workspaces, selected) => {
  if (!profile || !workspace) return
  const sessions = profile.sessions.filter(item => !item.archivedAt
    && (item.workspaceRef ?? workspaces.find(workspace => workspace.cwd === item.cwd)?.id ?? profile.workspaceId) === workspace.id)
  return sessions.find(item => item.id === selected)
    ?? sessions.find(item => item.id === profile.activeSessionId)
    ?? sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

function NodoPage({ sidebarOnly = false, contentOnly = false, workflowNavigation = null } = {}) {
  const { view, error, refresh } = useStateView()
  const navigation = useSyncExternalStore(subscribeNavigation, readNavigation)
  const space = useSyncExternalStore(nativeSpace.subscribe, nativeSpace.getSnapshot)
  const currentNativeSession = useSyncExternalStore(subscribeNativeSession, readNativeSession)
  const seen = useSyncExternalStore(completionTracker.subscribe, completionTracker.getSnapshot)
  const [foreground, setForeground] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
  useEffect(() => {
    const update = () => setForeground(document.visibilityState === 'visible' && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => { document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('blur', update) }
  }, [])
  // One place opens forms: the main area behaves like a settings page, the rail
  // stays a list. {kind:'workspace'|'profile', id, workspaceId?, profile?}
  const [editing, setEditing] = useState(null)
  // The rail's project menu opens these instead: {kind:'rename'|'delete', workspace}
  const [workspaceDialog, setWorkspaceDialog] = useState(null)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  // {role, session} while the session rename dialog is open.
  const [sessionDialog, setSessionDialog] = useState(null)
  const [drafts, setDrafts] = useState(readDrafts)
  const [pastedImages, setPastedImages] = useState(() => heldImages)
  useEffect(() => { localStorage.setItem('nodo.drafts', JSON.stringify(drafts)) }, [drafts])
  useEffect(() => { heldImages = pastedImages }, [pastedImages])
  const [goalOpen, setGoalOpen] = useState(false)
  // The statistics line under the composer opens its own dialog.
  const [statsOpen, setStatsOpen] = useState(false)
  // First-run onboarding dismisses for the rest of the browser session even if
  // the host could not persist the flag, so it can never block the page.
  const [onboardDone, setOnboardDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [compacting, setCompacting] = useState([])
  // Bumped on every accepted send: the feed answers it by resuming tail follow,
  // the host chat's rule that submitted input supersedes reader position.
  const [sentTick, setSentTick] = useState(0)
  const [actionError, setActionError] = useState('')
  const profile = view?.profiles.find(item => item.id === navigation.profile) ?? view?.profiles[0] ?? null
  const workspaces = view?.workspaces ?? []
  const workspace = workspaces.find(item => item.id === navigation.workspace) ?? workspaces[0] ?? null
  const navigationKey = `${workspace?.id}:${profile?.id}`
  const session = sessionForWorkspace(profile, workspace, workspaces, navigation.sessions?.[navigationKey])
  const sessionId = session?.id
  const sessionBusy = busy || compacting.includes(sessionId)
  const draftKey = sessionId ?? `new:${navigationKey}`
  const readOnly = view !== null && view.readOnly != null
  const work = sessionId ? view.work[sessionId] : null
  // The composer shows the conversation's own choices: a session runs the model,
  // thinking and tier it was opened or last tuned with, the card only backs them.
  const composerProfile = profile && session
    ? { ...profile, model: session.model ?? profile.model, thinking: session.thinking ?? profile.thinking, permission: session.permission ?? profile.permission }
    : profile
  const viewed = foreground && space.active && !space.legacy && !editing && currentNativeSession
    ? view?.profiles.flatMap(role => role.sessions).find(item => (item.nativeSessionId ?? (item.engine === 'dsh' ? item.driverSessionId : null)) === currentNativeSession) : null
  const viewedWork = view?.work[viewed?.id]
  useEffect(() => {
    if (viewed && viewedWork?.active !== true && Number.isFinite(viewedWork?.completionSeq)) completionTracker.mark(viewed.id, viewedWork.completionSeq)
  }, [viewed?.id, viewedWork?.active, viewedWork?.completionSeq])
  const railView = view && { ...view, work: Object.fromEntries(Object.entries(view.work).map(([id, work]) => [id,
    { ...work, seen: Number.isFinite(work.completionSeq) && seen[id] >= work.completionSeq }])) }
  useEffect(() => {
    if (!profile || !workspace) return
    setNavigation(current => ({ ...current, profile: profile.id, workspace: workspace.id,
      sessions: { ...current.sessions, ...(sessionId ? { [navigationKey]: sessionId } : {}) } }))
  }, [profile?.id, workspace?.id, sessionId])
  const remember = (roleId, projectId, id) => setNavigation(current => ({ ...current, profile: roleId, workspace: projectId,
    sessions: { ...current.sessions, ...(id ? { [`${projectId}:${roleId}`]: id } : {}) } }))
  const cancelEditing = () => setEditing(null)
  // The role card is the single configuration record: the composer's model
  // picker and the role dialog both write it, so each surface follows the
  // other, and the view lands on the respawned active session either way.
  const savedProfile = async saved => { await refresh(true); remember(saved.id, workspace?.id, saved.activeSessionId); setEditing(null) }
  // The role card seeds new conversations; the conversation window's own model
  // and thinking picks belong to the open session (the native model seat's
  // semantics), so they write the session and never retune the card behind it.
  const updateEngineChoice = async changes => {
    if (!profile || sessionBusy || readOnly) return
    setBusy(true)
    setActionError('')
    try {
      if (sessionId && (changes.model !== undefined || changes.thinking !== undefined)) {
        await call('session-update', { profile: profile.id, session: sessionId, changes })
        remember(profile.id, workspace?.id, sessionId)
      } else {
        const saved = await call('profile-update', { id: profile.id, changes })
        remember(saved.id, workspace?.id, saved.activeSessionId)
      }
      await refresh(true)
    }
    catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const savedWorkspace = async saved => { await refresh(true); remember(profile?.id, saved.id); setEditing(null) }
  const createdWorktree = async created => {
    setWorktreeOpen(false)
    await refresh(true)
    remember(profile?.id, created.workspace.id)
    setActionError('')
    if (!profile || !created.openSession) return
    setBusy(true)
    try {
      let sessionId
      if (nativeRole(profile) && openNativeSession) {
        const opened = await call('session-open', { profile: profile.id, workspace: created.workspace.id })
        sessionId = opened.conversationId
        if (created.sessionName !== '') await call('session-update', { profile: profile.id, session: sessionId, changes: { name: created.sessionName } })
        openNativeSession(opened.sessionId)
      } else {
        const saved = await call('session-create', { profile: profile.id, workspace: created.workspace.id, lazy: true,
          ...(created.sessionName === '' ? {} : { name: created.sessionName }) })
        sessionId = saved.id
        if (sidebarOnly) nativeSpace.showLegacy()
      }
      await refresh(true)
      remember(profile.id, created.workspace.id, sessionId)
      setEditing(null)
    } catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const deletedProfile = async item => {
    await call('profile-delete', { id: item.id })
    await refresh(true)
    if (profile?.id === item.id) setNavigation(current => ({ ...current, profile: null }))
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !item.sessions.some(session => session.id === key))))
    setEditing(null)
  }
  // Both dialogs surface the host's refusal (a duplicate name, roles still on the
  // workspace) themselves, so failures propagate instead of landing in actionError.
  const renamedWorkspace = async (id, name) => {
    await call('workspace-update', { id, changes: { name } })
    await refresh(true)
    setWorkspaceDialog(null)
  }
  const deletedWorkspace = async id => {
    await call('workspace-delete', { id })
    await refresh(true)
    if (workspace?.id === id) setNavigation(current => ({ ...current, workspace: null }))
    setWorkspaceDialog(null)
  }
  const selectSession = async (role, id, project = workspace) => {
    if (busy) return
    const origin = nativeSpace.getSnapshot()
    const current = () => nativeSpace.getSnapshot() === origin
    setBusy(true); setActionError('')
    try {
      id ??= sessionForWorkspace(role, project, workspaces, navigation.sessions?.[`${project?.id}:${role.id}`])?.id
      if (!id) {
        remember(role.id, project?.id); setEditing(null)
        if (sidebarOnly) nativeSpace.showLegacy()
        return
      }
      const native = nativeRole(role) && openNativeSession
      const dispatched = native && id && role.engine !== 'dsh' && !role.sessions?.find(item => item.id === id)?.nativeSessionId
        && (await call('transcript', { profile: role.id, session: id })).some(line => line.who === 'user')
      if (!current()) return
      if (native && !dispatched) {
        const opened = await call('session-open', { profile: role.id, session: id, workspace: project.id })
        if (!current()) return
        remember(role.id, project.id, opened.conversationId)
        setEditing(null)
        openNativeSession(opened.sessionId)
        await refresh(true)
        return
      }
      if (!readOnly) { await call('session-select', { profile: role.id, session: id }); await refresh(true) }
      if (!current()) return
      remember(role.id, project.id, id); setEditing(null)
      if (sidebarOnly) nativeSpace.showLegacy()
    } catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const archiveSession = async (role, id, archived) => {
    if (busy || readOnly) return
    setBusy(true); setActionError('')
    try { await call('session-archive', { profile: role.id, session: id, archived }); await refresh(true) }
    catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const updateSession = async (role, id, changes) => {
    if (busy || readOnly) return
    setBusy(true); setActionError('')
    try { await call('session-update', { profile: role.id, session: id, changes }); await refresh(true) }
    catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const renamedSession = async ({ role, session }, name) => {
    await call('session-update', { profile: role.id, session: session.id, changes: { name } })
    await refresh(true)
    setSessionDialog(null)
  }
  const startConversation = roleId => {
    if (!workspace || busy || readOnly) return
    setEditing(null)
    nativeSpace.startDraft({ profile: roleId, workspace: workspace.id })
  }
  const attach = async (files) => {    try {
      const added = await Promise.all(files.map(readImage))
      setPastedImages(current => ({ ...current, [draftKey]: [...(current[draftKey] ?? []), ...added] }))
    } catch (failure) { setActionError(failure.message) }
  }
  const removeImage = index => setPastedImages(current => ({ ...current, [draftKey]: (current[draftKey] ?? []).filter((_, position) => position !== index) }))
  // Context and commands land in the draft as plain text (an @path, a slash
  // line); the composer's own send path is untouched.
  const insertDraft = insertion => setDrafts(current => {
    const value = current[draftKey] ?? ''
    return { ...current, [draftKey]: value === '' || /\s$/.test(value) ? `${value}${insertion}` : `${value} ${insertion}` }
  })
  const send = async () => {
    const text = (drafts[draftKey] ?? '').trim()
    const images = pastedImages[draftKey] ?? []
    if (!profile || !workspace || (!text && images.length === 0) || sessionBusy || readOnly) return
    setBusy(true)
    setActionError('')
    try {
      const id = sessionId ?? (await call('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })).id
      const payload = images.map(image => ({ mediaType: image.mediaType, name: image.name, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) }))
      await call('send', { profile: profile.id, session: id, text, images: payload })
      setSentTick(tick => tick + 1)
      setDrafts(current => current[draftKey]?.trim() === text ? { ...current, [draftKey]: '' } : current)
      setPastedImages(current => current[draftKey] === images ? { ...current, [draftKey]: [] } : current)
      await refresh(true)
      remember(profile.id, workspace.id, id)
    } catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  const interrupt = async () => {
    if (!profile || busy || readOnly) return
    setBusy(true)
    setActionError('')
    try { await call('interrupt', { profile: profile.id, session: sessionId }); await refresh(true) }
    catch (failure) { setActionError(failure.message) }
    finally { setBusy(false) }
  }
  // Compaction runs the engine's own channel; there is nothing to show in the
  // feed afterwards — the engine's context shrinks, the transcript stays.
  const compactSession = async () => {
    if (!profile || sessionBusy || readOnly || work?.active === true) return
    if (!sessionId) { setActionError('先开始一个会话，再压缩上下文'); return }
    setCompacting(current => [...current, sessionId])
    setActionError('')
    try { await call('session-compact', { profile: profile.id, session: sessionId }); await refresh(true) }
    catch (failure) { setActionError(failure.message) }
    finally { setCompacting(current => current.filter(id => id !== sessionId)) }
  }

  const conversation = () => h('div', { className: 'nodo-conversation' },
    // The host conversation header: the session's own name in the window-chrome
    // row, the view tab under it, and one hairline closing the block.
    h('header', { className: 'nodo-head' },
      h('div', { className: 'nodo-title-row' },
        h('span', { className: 'nodo-crumb', title: session?.name ?? workspace?.name ?? profile.name },
          session?.name ?? workspace?.name ?? profile.name)),
      h('div', { className: 'nodo-tabs', role: 'tablist', 'aria-label': '会话视图' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', className: 'nodo-tab' }, '对话'))),
    h(Feed, { key: sessionId, profile, session, revision: view.revision, work, sentTick }),
    work?.active === true && h('div', { className: 'nodo-running-dock' },
      h(RunningLine, { key: sessionId, since: work.since })),
    ...(view.approvals ?? []).filter(card => card.profileId == null || card.profileId === sessionId).map(card => h(ApprovalCard, { key: card.id, card, refresh, readOnly })),
    h(Composer, {
      profile: composerProfile, workspace, value: drafts[draftKey] ?? '', images: pastedImages[draftKey] ?? [], running: work?.active === true, busy: sessionBusy, readOnly: readOnly || !workspace,
      modelDisabled: sessionBusy || readOnly || runningOf(profile, view.work).active,
      onChange: value => setDrafts(current => ({ ...current, [draftKey]: value })),
      onSend: () => void send(), onStop: () => void interrupt(), onAttach: attach, onRemoveImage: removeImage,
      onInsert: insertDraft,
      onGoal: () => setGoalOpen(true), onCompact: () => void compactSession(),
      onModelChange: changes => void updateEngineChoice(changes),
      rolePicker: h(RolePicker, { profiles: view.profiles, profile }),
    }),
    // The host chat's statistics line sits right below the input card, one per
    // session, inside the dock the composer keeps: the dock holds its height
    // before the session has any figure, so the input card never moves.
    h('div', { className: 'nodo-stats' },
      h(SessionStats, { stats: (view?.stats ?? {})[sessionId], onOpen: () => setStatsOpen(true) })))

  const page = () => {
    if (profile && workspace) return conversation()
    return h('div', { className: 'nodo-empty' },
      h('p', { className: 'nodo-headline' }, workspace ? '选择一个角色' : '添加一个项目'),
      h('p', null, workspace ? '添加或选择左侧角色，与其在当前项目中对话。' : '点击左侧项目旁的 +，选择工作目录。'))
  }

  const initiallyOpened = useRef(false)
  useEffect(() => {
    if (!sidebarOnly || initiallyOpened.current || !profile || !workspace) return
    initiallyOpened.current = true
    const state = nativeSpace.getSnapshot()
    if (state.nodoSession || state.drafting) return
    if (nativeRole(profile)) void selectSession(profile, sessionId)
    else nativeSpace.showLegacy()
  }, [sidebarOnly, profile?.id, workspace?.id])

  return h('section', { className: `nodo-page${sidebarOnly ? ' nodo-space-sidebar' : ''}`, 'aria-label': sidebarOnly ? 'Nodo 空间' : 'Nodo' },
    error && h('p', { className: 'nodo-error-line', role: 'alert' }, error),
    h('div', { className: 'nodo-frame' },
      !contentOnly && view && h(Rail, {
        view: railView, profile, workspace, sessionId, editing, draft: space.draft, onResumeDraft: () => nativeSpace.resumeDraft(), readOnly, busy, workflowNavigation,
        onSelect: id => {
          const role = view.profiles.find(item => item.id === id)
          if (role && workspace) void selectSession(role)
          else { remember(id, workspace?.id); setActionError(''); setEditing(null); if (sidebarOnly) nativeSpace.showLegacy() }
        },
        onSelectWorkspace: id => {
          remember(profile?.id, id); setActionError(''); setEditing(null)
          if (profile) {
            const project = workspaces.find(item => item.id === id)
            void selectSession(profile, undefined, project)
          }
        },
        onSelectSession: (role, id) => void selectSession(role, id),
        onArchiveSession: (role, id, archived) => void archiveSession(role, id, archived),
        onRenameSession: (role, session) => setSessionDialog({ role, session }),
        onPinSession: (role, id, pinned) => void updateSession(role, id, { pinned }),
        onNewSession: startConversation,
        onNewWorktree: () => { if (!readOnly) setWorktreeOpen(true) },
        onNewRole: () => setEditing({ kind: 'profile', profile: null }),
        onEditRole: item => setEditing({ kind: 'profile', profile: item }),
        onSettings: () => setEditing({ kind: 'settings' }),
        onWorkflows: () => layoutService?.selectPanel('nodo-workflow'), runsWaiting: (view.runs ?? []).some(needsPerson),
        onBack: () => workflowNavigation ? nativeSpace.showLegacy() : nativeSpace ? nativeSpace.leave() : layoutService?.selectPanel(null),
        onNewWorkspace: () => setEditing({ kind: 'workspace', id: 'new', workspace: null }),
        onRenameWorkspace: workspace => setWorkspaceDialog({ kind: 'rename', workspace }),
        onDeleteWorkspace: workspace => setWorkspaceDialog({ kind: 'delete', workspace }),
      }),
      !sidebarOnly && h('main', { className: 'nodo-main' },
        !view ? h('p', { className: 'nodo-note' }, 'Loading…') : page(),
        actionError && h('p', { className: 'nodo-error-line', role: 'alert' }, actionError))),
    sidebarOnly && actionError && h('p', { className: 'nodo-error-line', role: 'alert' }, actionError),
    sessionDialog && h(SessionRenameDialog, {
      key: `session:${sessionDialog.session.id}`, session: sessionDialog.session,
      onCancel: () => setSessionDialog(null), onSaved: name => renamedSession(sessionDialog, name),
    }),
    workspaceDialog && h(workspaceDialog.kind === 'rename' ? WorkspaceRenameDialog : WorkspaceDeleteDialog, {
      key: `${workspaceDialog.kind}:${workspaceDialog.workspace.id}`, workspace: workspaceDialog.workspace,
      ...(workspaceDialog.kind === 'rename' ? { names: workspaces } : {}),
      onCancel: () => setWorkspaceDialog(null),
      ...(workspaceDialog.kind === 'rename' ? { onSaved: renamedWorkspace } : { onDeleted: deletedWorkspace }),
    }),
    worktreeOpen && workspace && h(WorktreeDialog, {
      key: `worktree:${workspace.id}`, workspace, profile,
      onCancel: () => setWorktreeOpen(false), onCreated: createdWorktree,
    }),
    goalOpen && profile && h(GoalDialog, {
      key: `goal:${profile.id}`, profile,
      onSaved: value => { setGoalOpen(false); void updateEngineChoice({ goal: value }) },
      onCancel: () => setGoalOpen(false),
    }),
    statsOpen && view !== undefined && (view.stats ?? {})[sessionId] !== undefined && h(StatsDialog, {
      key: `stats:${sessionId}`, stats: view.stats[sessionId], onClose: () => setStatsOpen(false),
    }),
    editing?.kind === 'profile' && h(ProfileDialog, {
      key: `role:${editing.profile?.id ?? 'new'}`, profile: editing.profile ?? null, avatarSeed: view?.profiles.length ?? 0,
      enabledEngines: view?.prefs?.enabledEngines ?? null,
      savedIdentities: view?.prefs?.rolePresets ?? null, refresh,
      onCancel: cancelEditing, onSaved: savedProfile, onDeleted: deletedProfile,
    }),
    editing?.kind === 'workspace' && h(WorkspaceDialog, {
      key: `ws:${editing.id}`, workspace: editing.workspace ?? null,
      onCancel: cancelEditing, onSaved: savedWorkspace,
    }),
    editing?.kind === 'settings' && h(EngineSettingsDialog, {
      key: 'settings', view, workspace, refresh, readOnly, onClose: cancelEditing,
    }),
    view && !readOnly && !onboardDone && view.prefs?.onboardedAt == null && h(OnboardingDialog, {
      key: 'onboard', onDone: () => { setOnboardDone(true); refresh(true) },
    }),
    )
}

function PanelIcon({ size = 16 }) {
  return h('span', { className: 'nodo-panel-logo' }, h(NodoLogo, { compact: size === 18, width: size === 18 ? size : 96 }))
}

function NativeWelcome({ sessionId }) {
  return h(NewConversation, { key: sessionId, sourceSessionId: sessionId })
}

function NodoEntry() {
  const state = useSyncExternalStore(nativeSpace.subscribe, nativeSpace.getSnapshot)
  useEffect(() => { nativeSpace.enter() }, [])
  // A kept draft only shows once reopened: otherwise the host session is on show.
  return state.legacy ? h(NodoPage, { contentOnly: true })
    : state.drafting && state.draft ? h(NewConversation, { key: state.draft.id, draft: state.draft }) : null
}

function NodoSidebar({ collapsed }) {
  const workflowNavigation = useSyncExternalStore(wfSubscribeSidebar, wfSidebarSnapshot)
  const label = collapsed ? '展开侧边栏' : '收起侧边栏'
  return h('div', { className: 'nodo-space' },
    h('div', { className: 'nodo-space-chrome' },
      h(Tooltip, { label, side: 'bottom', delayMs: 500,
        children: h(Button, { variant: 'ghost', onClick: () => layoutService.toggleSidebar(),
          icon: h(IconPanelLeftOutlineRegular, { size: 16 }), 'aria-label': label }) })),
    h('div', { className: 'nodo-space-content', style: collapsed ? { display: 'none' } : undefined },
      h(NodoPage, { sidebarOnly: true, workflowNavigation })))
}
