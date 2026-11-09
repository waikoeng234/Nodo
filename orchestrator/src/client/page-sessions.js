import { call, nativeSpace, openNativeSession } from './ui-shared.js'
import { pullTranscript } from './live.js'
import { projectAnchorOf } from '../../core/shared/workspaces.js'

export const nativeRole = profile => profile?.engine === 'dsh'

export const sessionForWorkspace = (profile, workspace, workspaces, selected) => {
  if (!profile || !workspace) return
  const sessions = profile.sessions.filter(item => !item.archivedAt
    && projectAnchorOf(workspaces, item.workspaceRef ?? workspaces.find(workspace => workspace.cwd === item.cwd)?.id ?? profile.workspaceId) === workspace.id)
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
        const selecting = call('session-select', { profile: role.id, session: id })
        if (current()) await refresh(true)
        await selecting
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
      // 会话 id 前端已知：选中、全量 state 和 transcript 三路并行发出，
      // transcript 不等 state 落地才开始。
      void pullTranscript(role.id, id)
      const selecting = call('session-select', { profile: role.id, session: id })
      if (current()) await refresh(true)
      await selecting
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

// The phone summary panel overlays the transcript, so the body hands it the room
// the composer needs below; an archived conversation has no composer and keeps
// the whole column.
export const sessionPanelBottom = body => {
  const composer = body.querySelector('.nodo-composer')
  return composer ? `${Math.max(0, body.getBoundingClientRect().bottom - composer.getBoundingClientRect().top)}px` : '0px'
}
