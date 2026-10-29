import {
  h, useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useStateView, call, readImage, nativeSpace, openNativeSession, completionTracker, layoutService,
  subscribeNativeSession, readNativeSession, runningOf, NodoLogo, NewConversation, Button, Tooltip, IconPanelLeftOutlineRegular, rightPanelService,
} from './ui-shared.js'
import { RolePicker } from './role-seat.js'
import { Rail } from './session-rail.tsx'
import { RunningLine } from './running.js'
import { Feed, SessionStats, StatsDialog } from './feed.js'
import { Composer, GoalDialog } from './composer.js'
import { roundIndex, RoundMenu, RoundFaces } from './round.js'
import { ApprovalCard } from './run-cards.js'
import { EngineSettingsDialog, OnboardingDialog } from './engine-settings.js'
import { WorkspaceDialog, WorktreeDialog, WorkspaceRenameDialog, WorkspaceDeleteDialog, SessionRenameDialog } from './workspace-dialogs.js'
import { openRoles, rolesSidebarSnapshot, rolesSubscribeSidebar, rolesGuard, registerDraftRemover } from './roles.tsx'

// Unsent drafts outlive the page: text is kept in localStorage across reloads,
// pasted images (too large for storage) in memory across remounts.
export let heldImages = {}
export const readDrafts = () => {
  try { return JSON.parse(localStorage.getItem('nodo.drafts')) ?? {} } catch { return {} }
}

let navigationSnapshot
const navigationListeners = new Set()
export const readNavigation = () => {
  if (navigationSnapshot === undefined) {
    try { navigationSnapshot = JSON.parse(localStorage.getItem('nodo.navigation') ?? localStorage.getItem('orchestrator.navigation')) ?? {} } catch { navigationSnapshot = {} }
  }
  return navigationSnapshot
}
export const subscribeNavigation = listener => { navigationListeners.add(listener); return () => navigationListeners.delete(listener) }
export const setNavigation = update => {
  navigationSnapshot = typeof update === 'function' ? update(readNavigation()) : update
  try { localStorage.setItem('nodo.navigation', JSON.stringify(navigationSnapshot)) } catch {}
  for (const listener of navigationListeners) listener()
}
export const nativeRole = profile => profile?.engine === 'dsh'
export const sessionForWorkspace = (profile, workspace, workspaces, selected) => {
  if (!profile || !workspace) return
  const sessions = profile.sessions.filter(item => !item.archivedAt
    && (item.workspaceRef ?? workspaces.find(workspace => workspace.cwd === item.cwd)?.id ?? profile.workspaceId) === workspace.id)
  return sessions.find(item => item.id === selected)
    ?? sessions.find(item => item.id === profile.activeSessionId)
    ?? sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

// The rail's session handlers keep the page's state in one object so the rail
// wiring and tests drive the same path.
export const selectSession = async (role, id, project, page) => {
  const { workspace, workspaces, work, navigation, sidebarOnly, readOnly, remember, refresh, selection, setActionError, setEditing } = page
  project ??= workspace
  const request = selection ? ++selection.current : undefined
  let origin = nativeSpace.getSnapshot()
  const current = () => nativeSpace.getSnapshot() === origin && (!selection || selection.current === request)
  setActionError('')
  try {
    id ??= sessionForWorkspace(role, project, workspaces, navigation.sessions?.[`${project?.id}:${role.id}`])?.id
    if (!id) {
      remember(role.id, project?.id); setEditing(null)
      if (sidebarOnly) nativeSpace.showLegacy()
      return
    }
    const selected = role.sessions.find(session => session.id === id)
    if (selected?.archivedAt || role.deletedAt) {
      remember(role.id, selected?.workspaceRef ?? project?.id, id, true)
      setEditing(null)
      if (sidebarOnly) nativeSpace.showLegacy()
      return
    }
    const native = nativeRole(role) && openNativeSession
    if (!current()) return
    const twin = native && role.sessions.find(session => session.id === id)?.driverSessionId
    if (work?.[id]?.active === true && (!native || twin)) {
      remember(role.id, project.id, id); setEditing(null)
      if (native) openNativeSession(twin)
      else if (sidebarOnly) nativeSpace.showLegacy()
      origin = nativeSpace.getSnapshot()
      if (!readOnly) {
        await call('session-select', { profile: role.id, session: id })
        if (current()) await refresh(true)
      }
      return
    }
    if (native) {
      const opened = await call('session-open', { profile: role.id, session: id, workspace: project.id })
      if (!current()) return
      remember(role.id, project.id, opened.conversationId)
      setEditing(null)
      openNativeSession(opened.sessionId)
      await refresh(true)
      return
    }
    if (!readOnly) {
      await call('session-select', { profile: role.id, session: id })
      if (!current()) return
      await refresh(true)
    }
    if (!current()) return
    remember(role.id, project.id, id); setEditing(null)
    if (sidebarOnly) nativeSpace.showLegacy()
  } catch (failure) { if (current()) setActionError(failure.message) }
}

export const startConversation = (roleId, page, project = page.workspace) => {
  const { busy, readOnly, setEditing } = page
  if (!project || busy || readOnly) return
  setEditing(null)
  nativeSpace.startDraft({ profile: roleId, workspace: project.id })
}

export const openInitialSidebarSession = page => {
  const { sidebarOnly, initiallyOpened, profile, workspace, sessionId } = page
  if (!sidebarOnly || initiallyOpened.current || !profile || !workspace) return
  initiallyOpened.current = true
  const state = nativeSpace.getSnapshot()
  if (state.nodoSession || state.drafting) return
  if (nativeRole(profile)) void selectSession(profile, sessionId, workspace, page)
  else nativeSpace.showLegacy()
}

export function NodoPage({ sidebarOnly = false, contentOnly = false, railNavigation = null } = {}) {
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
  // Deleting a role drops its sessions' drafts here, before the next edit
  // mirrors the in-memory copy back to storage.
  useEffect(() => {
    const remove = ids => setDrafts(current =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !ids.includes(key))))
    return registerDraftRemover(remove)
  }, [])
  const [goalOpen, setGoalOpen] = useState(false)
  // The statistics line under the composer opens its own dialog.
  const [statsOpen, setStatsOpen] = useState(false)
  // First-run onboarding dismisses for the rest of the browser session even if
  // the host could not persist the flag, so it can never block the page.
  const [onboardDone, setOnboardDone] = useState(false)
  const onboarding = useRef(false)
  if (view && view.prefs?.onboardedAt == null) onboarding.current = true
  const [busy, setBusy] = useState(false)
  const selection = useRef(0)
  const [pending, setPending] = useState([])
  const [compacting, setCompacting] = useState([])
  // Bumped on every accepted send: the feed answers it by resuming tail follow,
  // the host chat's rule that submitted input supersedes reader position.
  const [sentTick, setSentTick] = useState(0)
  const [actionError, setActionError] = useState('')
  // The lead session whose raw transcript replaces its round view.
  const [rawRound, setRawRound] = useState(null)
  const archived = view?.profiles.flatMap(role => role.sessions.filter(session => session.id === navigation.archivedSession && session.archivedAt)
    .map(session => ({ role, session })))[0]
  const profiles = view?.profiles.filter(item => !item.deletedAt) ?? []
  const profile = archived?.role ?? profiles.find(item => item.id === navigation.profile) ?? profiles[0] ?? null
  const workspaces = view?.workspaces ?? []
  const workspace = archived ? workspaces.find(item => item.id === archived.session.workspaceRef) ?? null
    : workspaces.find(item => item.id === navigation.workspace) ?? workspaces[0] ?? null
  const navigationKey = `${workspace?.id}:${profile?.id}`
  const session = archived?.session ?? sessionForWorkspace(profile, workspace, workspaces, navigation.sessions?.[navigationKey])
  const sessionId = session?.id
  const draftKey = sessionId ?? `new:${navigationKey}`
  const sessionBusy = busy || pending.includes(draftKey) || compacting.includes(sessionId)
  const setSessionBusy = value => setPending(current => value ? [...current, draftKey] : current.filter(key => key !== draftKey))
  const readOnly = view !== null && view.readOnly != null
  const archivedConversation = !!session?.archivedAt || !!profile?.deletedAt
  const conversationReadOnly = readOnly || archivedConversation
  const work = sessionId ? view.work[sessionId] : null
  const rounds = view ? roundIndex(view) : null
  const members = (sessionId && rounds?.members.get(sessionId)) || []
  const leadEntry = sessionId ? rounds?.lead.get(sessionId) : undefined
  const panelCwd = sessionId ? session?.cwd ?? workspaces.find(item => item.id === (session?.workspaceRef ?? profile?.workspaceId))?.cwd : workspace?.cwd
  useLayoutEffect(() => {
    if (sidebarOnly || !space.active || !space.legacy || editing) return
    if (sessionId) return rightPanelService?.bind({ profile: profile.id, session: sessionId, cwd: panelCwd, ...(conversationReadOnly ? { readOnly: true } : {}) })
    if (workspace) return rightPanelService?.bind({ workspace: workspace.id, cwd: panelCwd, ...(readOnly ? { readOnly: true } : {}) })
  }, [sidebarOnly, space.active, space.legacy, profile?.id, sessionId, workspace?.id, panelCwd, conversationReadOnly, !!editing])
  const roundLive = [{ role: profile, session }, ...members].filter(item => members.length && view.work[item.session?.id]?.active === true)
  // The composer shows the conversation's own choices: a session runs the model,
  // thinking and tier it was opened or last tuned with, the card only backs them.
  const composerProfile = profile && session
    ? { ...profile, model: session.model ?? profile.model, thinking: session.thinking ?? profile.thinking, permission: session.permission ?? profile.permission }
    : profile
  const viewed = foreground && space.active && !space.legacy && !editing && currentNativeSession
    ? view?.profiles.flatMap(role => role.sessions).find(item => (item.engine === 'dsh' ? item.driverSessionId : null) === currentNativeSession) : null
  const viewedWork = view?.work[viewed?.id]
  useEffect(() => {
    if (viewed && viewedWork?.active !== true && Number.isFinite(viewedWork?.completionSeq)) completionTracker.mark(viewed.id, viewedWork.completionSeq)
  }, [viewed?.id, viewedWork?.active, viewedWork?.completionSeq])
  const railView = view && { ...view, work: Object.fromEntries(Object.entries(view.work).map(([id, work]) => [id,
    { ...work, seen: Number.isFinite(work.completionSeq) && seen[id] >= work.completionSeq }])) }
  useEffect(() => {
    if (!profile || !workspace || archivedConversation) return
    setNavigation(current => ({ ...current, profile: profile.id, workspace: workspace.id,
      sessions: { ...current.sessions, ...(sessionId && !current.sessions?.[navigationKey] ? { [navigationKey]: sessionId } : {}) } }))
  }, [profile?.id, workspace?.id, sessionId, archivedConversation])
  const remember = (roleId, projectId, id, archived = false) => setNavigation(current => ({ ...current, profile: roleId, workspace: projectId,
    archivedSession: archived ? id : undefined,
    sessions: { ...current.sessions, ...(id && !archived ? { [`${projectId}:${roleId}`]: id } : {}) } }))
  const trackSelection = (sameSession = false) => {
    const origin = nativeSpace.getSnapshot(), request = selection.current
    return () => {
      const next = readNavigation()
      return nativeSpace.getSnapshot() === origin && (sameSession || selection.current === request)
        && next.profile === profile?.id && next.workspace === workspace?.id
        && next.sessions?.[navigationKey] === navigation.sessions?.[navigationKey]
    }
  }
  const cancelEditing = () => setEditing(null)
  const edit = value => { selection.current++; setEditing(value) }
  // The roles panel is the one place roles are configured; the roster's buttons
  // land there with the target preselected. Bumping the selection retires any
  // pending session selection, the way opening a form always did.
  const openRolesPage = target => { selection.current++; openRoles(target); layoutService?.selectPanel('nodo-roles') }
  // The role card seeds new conversations; the conversation window's own model,
  // thinking and permission picks belong to the open session (the native model seat's
  // semantics), so they write the session and never retune the card behind it.
  const updateEngineChoice = async changes => {
    if (!profile || sessionBusy || conversationReadOnly) return
    setSessionBusy(true)
    setActionError('')
    const current = trackSelection()
    const relevant = trackSelection(true)
    try {
      if (sessionId && ['model', 'thinking', 'permission'].some(key => changes[key] !== undefined)) {
        await call('session-update', { profile: profile.id, session: sessionId, changes })
      } else {
        const saved = await call('profile-update', { id: profile.id, changes })
        if (current()) remember(saved.id, workspace?.id, saved.activeSessionId)
      }
      await refresh(true)
    }
    catch (failure) { if (relevant()) setActionError(failure.message) }
    finally { setSessionBusy(false) }
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
  const pageEnv = { workspace, busy, workspaces, work: view?.work, navigation, sidebarOnly, readOnly, remember, refresh, selection, setActionError, setEditing }
  const select = (role, id, project) => selectSession(role, id, project, pageEnv)
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
  const startDraft = (roleId, project) => startConversation(roleId, pageEnv, project)
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
    if (!profile || !workspace || (!text && images.length === 0) || sessionBusy || conversationReadOnly) return
    setSessionBusy(true)
    setActionError('')
    const current = trackSelection()
    const relevant = trackSelection(true)
    try {
      const id = sessionId ?? (await call('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })).id
      const payload = images.map(image => ({ mediaType: image.mediaType, name: image.name, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) }))
      await call('send', { profile: profile.id, session: id, text, images: payload, mode: 'queue' })
      if (current()) setSentTick(tick => tick + 1)
      setDrafts(current => current[draftKey]?.trim() === text ? { ...current, [draftKey]: '' } : current)
      setPastedImages(current => current[draftKey] === images ? { ...current, [draftKey]: [] } : current)
      await refresh(true)
      if (current()) remember(profile.id, workspace.id, id)
    } catch (failure) { if (relevant()) setActionError(failure.message) }
    finally { setSessionBusy(false) }
  }
  const queueAction = async (seq, action) => {
    if (!profile || !sessionId || sessionBusy || conversationReadOnly) return
    setSessionBusy(true)
    setActionError('')
    const relevant = trackSelection(true)
    try {
      const result = await call('queued-message', { profile: profile.id, session: sessionId, seq, action })
      if (action === 'edit') {
        setDrafts(current => ({ ...current, [draftKey]: [result.text, current[draftKey]].filter(Boolean).join('\n\n') }))
        setPastedImages(current => ({ ...current, [draftKey]: [
          ...result.images.map(image => ({ ...image, dataUrl: `data:${image.mediaType};base64,${image.data}` })), ...(current[draftKey] ?? []),
        ] }))
      }
      if (action === 'send' && relevant()) {
        if (result.mode === 'queued') setActionError('当前无法插入本轮，消息仍在排队')
        else if (result.mode !== 'cancelled') setSentTick(tick => tick + 1)
      }
      await refresh(true)
    } catch (failure) { if (relevant()) setActionError(failure.message) }
    finally { setSessionBusy(false) }
  }
  const interrupt = async () => {
    if (!profile || sessionBusy || conversationReadOnly) return
    setSessionBusy(true)
    setActionError('')
    const current = trackSelection(true)
    try {
      for (const [id, target] of members.length ? roundLive.map(item => [item.role.id, item.session.id]) : [[profile.id, sessionId]]) {
        await call('interrupt', { profile: id, session: target })
      }
      await refresh(true)
    }
    catch (failure) { if (current()) setActionError(failure.message) }
    finally { setSessionBusy(false) }
  }
  const stopMember = async step => {
    try { await call('interrupt', { profile: step.profile, session: step.session }); await refresh(true) }
    catch (failure) { setActionError(failure.message) }
  }
  // Compaction runs the engine's own channel; there is nothing to show in the
  // feed afterwards — the engine's context shrinks, the transcript stays.
  const compactSession = async () => {
    if (!profile || sessionBusy || conversationReadOnly || work?.active === true) return
    if (!sessionId) { setActionError('先开始一个会话，再压缩上下文'); return }
    setCompacting(current => [...current, sessionId])
    setActionError('')
    const current = trackSelection(true)
    try { await call('session-compact', { profile: profile.id, session: sessionId }); await refresh(true) }
    catch (failure) { if (current()) setActionError(failure.message) }
    finally { setCompacting(current => current.filter(id => id !== sessionId)) }
  }

  const openSession = id => {
    const role = view.profiles.find(item => item.sessions.some(entry => entry.id === id))
    if (role) void select(role, id)
  }
  const conversation = () => h('div', { className: 'nodo-conversation' },
    // The host conversation header: the session's own name in the window-chrome
    // row and one hairline closing the block.
    h('header', { className: 'nodo-head' },
      h('div', { className: 'nodo-title-row' },
        leadEntry && h('button', { type: 'button', className: 'nodo-crumb nodo-crumb-link', title: leadEntry.session.name,
          onClick: () => void select(leadEntry.role, leadEntry.session.id) }, leadEntry.session.name),
        leadEntry && h('span', { className: 'nodo-crumb-sep', 'aria-hidden': true }, '›'),
        h('span', { className: 'nodo-crumb', title: session?.name ?? workspace?.name ?? profile.name },
          session?.name ?? workspace?.name ?? profile.name),
        members.length > 0 && h(RoundFaces, { roles: [...new Map([profile, ...members.map(item => item.role)].map(role => [role.id, role])).values()] }),
        h('span', { className: 'nodo-head-actions' },
          members.length > 0 && h(RoundMenu, { members, work: view.work, raw: rawRound === sessionId,
            onRaw: () => setRawRound(rawRound === sessionId ? null : sessionId), onOpen: openSession })))),
    h(Feed, { key: sessionId, profile, session, revision: view.revision, work, sentTick,
      round: members.length && rawRound !== sessionId ? { profiles: view.profiles, taskTypes: view.taskTypes, work: view.work, onOpen: openSession, onStop: conversationReadOnly ? undefined : stopMember } : undefined }),
    work?.active === true && h('div', { className: 'nodo-running-dock' },
      h(RunningLine, { key: sessionId, since: work.since, work })),
    ...(!archivedConversation ? view.approvals ?? [] : []).filter(card => card.profileId == null || card.profileId === sessionId
      || members.some(item => item.session.id === card.profileId)).map(card => h(ApprovalCard, { key: card.id, card, refresh, readOnly,
      from: members.find(item => item.session.id === card.profileId) })),
    !archivedConversation && h(Composer, {
      profile: composerProfile, workspace, value: drafts[draftKey] ?? '', images: pastedImages[draftKey] ?? [], running: work?.active === true,
      stoppable: members.length ? roundLive.length > 0 : undefined, stopLabel: roundLive.length > 1 ? `停止全部 ${roundLive.length} 个` : undefined, busy: sessionBusy, readOnly: readOnly || !workspace,
      modelDisabled: sessionBusy || readOnly,
      onChange: value => setDrafts(current => ({ ...current, [draftKey]: value })),
      onSend: () => void send(), onStop: () => void interrupt(), onAttach: attach, onRemoveImage: removeImage,
      pending: work?.pending ?? [], onQueueAction: (seq, action) => void queueAction(seq, action),
      onInsert: insertDraft,
      onGoal: () => setGoalOpen(true), onCompact: () => void compactSession(),
      onModelChange: changes => void updateEngineChoice(changes),
      rolePicker: h(RolePicker, { profiles: view.profiles, profile }),
    }),
    // The host chat's statistics line sits right below the input card, one per
    // session, inside the dock the composer keeps: the dock holds its height
    // before the session has any figure, so the input card never moves.
    h('div', { className: 'nodo-stats' },
      h(SessionStats, { stats: profile.lead === true ? undefined : (view?.stats ?? {})[sessionId], onOpen: () => setStatsOpen(true) })))

  const page = () => {
    if (profile && (workspace || session)) return conversation()
    return h('div', { className: 'nodo-empty' },
      h('p', { className: 'nodo-headline' }, workspace ? '选择一个角色' : '添加一个项目'),
      h('p', null, workspace ? '添加或选择左侧角色，与其在当前项目中对话。' : '点击左侧项目旁的 +，选择工作目录。'))
  }

  const initiallyOpened = useRef(false)
  useEffect(() => {
    openInitialSidebarSession({ sidebarOnly, initiallyOpened, profile, workspace, sessionId, ...pageEnv })
  }, [sidebarOnly, profile?.id, workspace?.id])

  return h('section', { className: `nodo-page${sidebarOnly ? ' nodo-space-sidebar' : ''}`, 'aria-label': sidebarOnly ? 'Nodo 空间' : 'Nodo' },
    error && h('p', { className: 'nodo-error-line', role: 'alert' }, error),
    h('div', { className: 'nodo-frame' },
      !contentOnly && view && h(Rail, {
        view: railView, profile, workspace, sessionId, editing, draft: space.draft, drafting: space.drafting, onResumeDraft: () => nativeSpace.resumeDraft(), readOnly, busy, navigation: railNavigation,
        onSelect: id => {
          const role = view.profiles.find(item => item.id === id)
          if (role && workspace) void select(role)
          else { remember(id, workspace?.id); setActionError(''); setEditing(null); if (sidebarOnly) nativeSpace.showLegacy() }
        },
        onSelectSession: (role, id, project) => void select(role, id, project),
        onArchiveSession: (role, id, archived) => void archiveSession(role, id, archived),
        onRenameSession: (role, session) => setSessionDialog({ role, session }),
        onPinSession: (role, id, pinned) => void updateSession(role, id, { pinned }),
        onNewSession: startDraft,
        onNewWorktree: project => { if (!readOnly) setWorktreeOpen(project) },
        onNewRole: () => openRolesPage({ profileId: 'new' }),
        onEditRole: item => openRolesPage({ profileId: item.id }),
        onSettings: () => edit({ kind: 'settings' }),
        onRoles: () => layoutService?.selectPanel('nodo-roles'),
        onSessions: () => rolesGuard(() => nativeSpace.showLegacy()),
        onBack: () => rolesGuard(() => nativeSpace ? nativeSpace.leave() : layoutService?.selectPanel(null)),
        onNewWorkspace: () => edit({ kind: 'workspace', id: 'new', workspace: null }),
        onRenameWorkspace: workspace => setWorkspaceDialog({ kind: 'rename', workspace }),
        onDeleteWorkspace: workspace => setWorkspaceDialog({ kind: 'delete', workspace }),
      }),
      !sidebarOnly && h('main', { className: 'nodo-main' },
        !view ? h('p', { className: 'nodo-note' }, '加载中…') : page(),
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
    worktreeOpen && h(WorktreeDialog, {
      key: `worktree:${worktreeOpen.id}`, workspace: worktreeOpen, profile,
      onCancel: () => setWorktreeOpen(false), onCreated: createdWorktree,
    }),
    goalOpen && profile && h(GoalDialog, {
      key: `goal:${profile.id}`, profile,
      onSaved: value => { setGoalOpen(false); void updateEngineChoice({ goal: value }) },
      onCancel: () => setGoalOpen(false),
    }),
    statsOpen && profile.lead !== true && view !== undefined && (view.stats ?? {})[sessionId] !== undefined && h(StatsDialog, {
      key: `stats:${sessionId}`, stats: view.stats[sessionId], onClose: () => setStatsOpen(false),
    }),
    editing?.kind === 'workspace' && h(WorkspaceDialog, {
      key: `ws:${editing.id}`, workspace: editing.workspace ?? null,
      onCancel: cancelEditing, onSaved: savedWorkspace,
    }),
    editing?.kind === 'settings' && h(EngineSettingsDialog, {
      key: 'settings', view, workspace, refresh, readOnly, onClose: cancelEditing,
    }),
    view && !readOnly && !onboardDone && onboarding.current && h(OnboardingDialog, {
      key: 'onboard', view, onDone: () => { setOnboardDone(true); refresh(true) },
    }),
    )
}

export function PanelIcon({ size = 16 }) {
  return h('span', { className: 'nodo-panel-logo' }, h(NodoLogo, { compact: size === 18, width: size === 18 ? size : 96 }))
}

export function NativeWelcome({ sessionId }) {
  return h(NewConversation, { key: sessionId, sourceSessionId: sessionId })
}

export function NodoEntry() {
  const state = useSyncExternalStore(nativeSpace.subscribe, nativeSpace.getSnapshot)
  useEffect(() => { nativeSpace.enter() }, [])
  // A kept draft only shows once reopened: otherwise the host session is on show.
  return state.legacy ? h(NodoPage, { contentOnly: true })
    : state.drafting && state.draft ? h(NewConversation, { key: state.draft.id, draft: state.draft }) : null
}

export function NodoSidebar({ collapsed }) {
  const rolesNavigation = useSyncExternalStore(rolesSubscribeSidebar, rolesSidebarSnapshot)
  const label = collapsed ? '展开侧边栏' : '收起侧边栏'
  return h('div', { className: 'nodo-space' },
    h('div', { className: 'nodo-space-chrome' },
      h(Tooltip, { label, side: 'bottom', delayMs: 500,
        children: h(Button, { variant: 'ghost', onClick: () => layoutService.toggleSidebar(),
          icon: h(IconPanelLeftOutlineRegular, { size: 16 }), 'aria-label': label }) })),
    h('div', { className: 'nodo-space-content', style: collapsed ? { display: 'none' } : undefined },
      h(NodoPage, { sidebarOnly: true, railNavigation: rolesNavigation })))
}
