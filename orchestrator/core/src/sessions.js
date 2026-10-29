import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { cleanModel, cleanThinking } from './profiles.js'

export function install(rt) {
  const snapshotIdentity = (profile, session) => {
    session.profileName ??= profile.name
    session.role ??= profile.role ?? ''
    session.instructions ??= profile.instructions ?? ''
    session.goal ??= profile.goal ?? ''
    session.identityVersion = createHash('sha256').update(JSON.stringify([session.profileName, session.role, session.instructions, session.goal])).digest('hex')
    return session
  }
  const sessionsOf = profile => profile.sessions ?? [{ id: profile.id, name: 'Session 1', engine: profile.engine, model: profile.model, thinking: profile.thinking, engineOptions: profile.engineOptions, driverSessionId: profile.driverSessionId, briefSent: !!profile.driverSessionId }]
  const sessionWorkspace = (profile, session) => rt.state.workspaces[session?.workspaceRef]
    ?? (session?.workspaceRef && session.cwd ? { id: session.workspaceRef, cwd: session.cwd } : undefined)
    ?? Object.values(rt.state.workspaces).find(workspace => session?.cwd && workspace.cwd === session.cwd)
    ?? rt.workspaceOf(profile)
  const assertSessionWritable = (profile, session) => {
    if (profile.deletedAt || session.archivedAt) {
      throw Object.assign(new Error('This conversation is read-only'), { code: 'orch/refused' })
    }
  }
  const archiveDeletedSession = (profile, session) => {
    const workspace = sessionWorkspace(profile, session)
    snapshotIdentity(profile, session)
    session.cwd ??= workspace?.cwd
    session.workspaceRef ??= workspace?.id
    session.workspaceName ??= workspace?.name
    session.archivedAt ??= Date.now()
  }
  const conversationOf = id => {
    for (const profile of Object.values(rt.state.profiles)) {
      const session = sessionsOf(profile).find(item => item.id === id)
      if (session) return { profile, session }
    }
  }
  const conversation = (profileId, id) => {
    const profile = rt.state.profiles[profileId]
    if (!profile) throw new Error('No such profile')
    const session = sessionsOf(profile).find(item => item.id === (id ?? profile.activeSessionId ?? profile.id))
    if (!session) throw new Error('This session does not belong to the profile')
    profile.sessions ??= sessionsOf(profile)
    return { profile, session: profile.sessions.find(item => item.id === session.id) }
  }
  const prepareConversation = async id => {
    const found = conversationOf(id)
    const { profile, session } = conversation(found.profile.id, id)
    snapshotIdentity(profile, session)
    // An existing engine conversation keeps its original working directory.
    const workspace = sessionWorkspace(profile, session)
    const cwd = session.cwd ?? workspace?.cwd
    if (!cwd) throw new Error('Choose a workspace before starting a conversation')
    if (!isAbsolute(cwd)) throw new Error('Workspace directory must be absolute')
    await mkdir(cwd, { recursive: true })
    session.cwd = await realpath(cwd)
    session.workspaceRef ??= workspace?.id
    await rt.save()
    return { ...profile, ...session, model: session.model, thinking: session.thinking, driverSessionId: session.driverSessionId, workspaceId: session.workspaceId, workspaceName: workspace?.name, name: session.profileName, sessionName: session.name, profileId: profile.id, workspaceKey: `${session.engine}:${session.cwd}` }
  }
  // A new conversation starts from the role card's model, thinking and permission.
  const sessionChoices = profile => ({ model: profile.model, thinking: profile.thinking, permission: profile.permission })
  const cleanSessionChoices = (profile, choices = {}) => {
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)
      || Object.keys(choices).some(key => !['model', 'thinking', 'permission'].includes(key))) {
      throw Object.assign(new Error('Invalid conversation choices'), { code: 'orch/invalid' })
    }
    return Object.fromEntries(Object.entries(choices).filter(([, value]) => value !== undefined).map(([key, value]) => [key,
      (key === 'model' ? cleanModel(value) : key === 'thinking' ? cleanThinking(value) : rt.cleanPermission(profile.engine, value)) ?? '']))
  }
  const createSession = async (profileId, name, workspaceRef, lazy = false, draft = false, choices = {}, source, { activate = true } = {}) => {
    const profile = rt.state.profiles[profileId]
    if (!profile || profile.deletedAt) throw new Error('No such profile')
    choices = cleanSessionChoices(profile, choices)
    const active = sessionsOf(profile).find(session => session.id === profile.activeSessionId)
    const workspace = workspaceRef !== undefined ? rt.findWorkspace(workspaceRef) : sessionWorkspace(profile, active)
    if (!workspace || rt.state.workspaces[workspace.id] === undefined) throw new Error('Choose a valid workspace for the conversation')
    profile.sessions ??= sessionsOf(profile)
    // A nameless draft is the new-conversation placeholder — one per role and
    // workspace, reused until its first input names it; the host has no
    // session-delete API, so an abandoned draft is kept and reused, never
    // multiplied.
    if (draft && name === undefined) {
      const reuse = profile.sessions.find(session => session.draftedAt && !session.briefSent && !session.archivedAt
        && (session.workspaceRef ?? sessionWorkspace(profile, session)?.id) === workspace.id)
      if (reuse) { if (activate) profile.activeSessionId = reuse.id; await rt.save(); return reuse }
    }
    const inherited = sessionChoices(profile)
    const model = choices.model !== undefined ? cleanModel(choices.model) : inherited.model
    const thinking = choices.thinking !== undefined ? cleanThinking(choices.thinking) : inherited.thinking
    const permission = choices.permission !== undefined ? rt.cleanPermission(profile.engine, choices.permission) : inherited.permission
    if (profile.lead === true && permission === 'plan') throw Object.assign(new Error('主控不能使用计划模式权限，请改选其他权限'), { code: 'orch/invalid' })
    const session = { id: randomUUID(), name: String(name ?? (draft ? '新会话' : `Session ${profile.sessions.length + 1}`)).slice(0, 80), workspaceRef: workspace.id,
      engine: profile.engine, model, thinking,
      engineOptions: { ...profile.engineOptions }, briefSent: false, createdAt: Date.now(),
      ...(source ? { source } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(draft && name === undefined ? { draftedAt: Date.now() } : {}) }
    snapshotIdentity(profile, session)
    profile.sessions.push(session)
    if (activate) profile.activeSessionId = session.id
    rt.transcriptOf(session.id)
    await rt.save()
    if (!lazy) {
      const driver = await rt.ensureDriver(await prepareConversation(session.id))
      await driver.openSession()
    }
    return session
  }
  const selectSession = async (profileId, id) => {
    const { profile, session } = conversation(profileId, id)
    assertSessionWritable(profile, session)
    profile.activeSessionId = session.id
    await rt.save()
    return session
  }
  const openNativeSession = async ({ profile: ref, session: id, workspace }) => {
    const profile = rt.findProfile(ref)
    if (profile?.engine !== 'dsh') throw new Error('This engine does not expose a native host session')
    if (id) assertSessionWritable(profile, conversation(profile.id, id).session)
    const session = id ? await selectSession(profile.id, id) : await createSession(profile.id, undefined, workspace, true, true)
    const sessionId = nativeTwinOf(session)
    const agent = sessionId && rt.ctx.agents?.get(sessionId)
    if (agent?.status === 'running') {
      if (agent.session.header.cwd !== (session.cwd ?? sessionWorkspace(profile, session)?.cwd)) throw new Error('DSH session belongs to another workspace')
      return { sessionId, conversationId: session.id }
    }
    const driver = await rt.ensureDriver(await prepareConversation(session.id))
    await driver.openSession()
    return { sessionId: session.driverSessionId, conversationId: session.id }
  }
  // Archiving hides a session from the rail without deleting its transcript or
  // engine conversation; a running session must finish or be stopped first.
  const archiveSession = async (profileId, id, archived) => {
    const { profile, session } = conversation(profileId, id)
    if (!archived) {
      assertSessionWritable(profile, { ...session, archivedAt: undefined })
      if (session.workspaceRef && !rt.state.workspaces[session.workspaceRef]) throw Object.assign(new Error('This conversation is read-only'), { code: 'orch/refused' })
    }
    if (archived && rt.workView?.()[session.id]?.active) throw Object.assign(new Error('Stop or finish the running task before archiving this session'), { code: 'orch/busy' })
    if (archived) session.archivedAt = Date.now()
    else delete session.archivedAt
    if (archived && profile.activeSessionId === session.id) profile.activeSessionId = profile.sessions.find(item => item.id !== session.id && !item.archivedAt)?.id
    await rt.save()
    return session
  }
  const updateSession = async (profileId, id, changes) => {
    const { profile, session } = conversation(profileId, id)
    assertSessionWritable(profile, session)
    const choices = cleanSessionChoices(profile, Object.fromEntries(['model', 'thinking', 'permission']
      .filter(key => changes[key] !== undefined).map(key => [key, changes[key]])))
    if (profile.lead === true && (choices.permission ?? session.permission) === 'plan') throw Object.assign(new Error('主控不能使用计划模式权限，请改选其他权限'), { code: 'orch/invalid' })
    let taskState
    if (changes.taskState !== undefined) {
      if (rt.workView?.()[session.id]?.active) throw Object.assign(new Error('Stop or finish the task before editing its saved context'), { code: 'orch/busy' })
      await rt.loadSecrets()
      taskState = rt.cleanTaskState(changes.taskState)
    }
    if (changes.name !== undefined) {
      const name = String(changes.name).trim().slice(0, 80)
      if (name === '') throw Object.assign(new Error('Session name cannot be empty'), { code: 'orch/invalid' })
      session.name = name
    }
    if (changes.pinned !== undefined) {
      if (changes.pinned) session.pinnedAt = Date.now()
      else delete session.pinnedAt
    }
    if (changes.taskState !== undefined) {
      session.taskState = taskState
      session.restoreContext = true
    }
    // The live driver keeps this turn's settings; the next turn reads these choices.
    for (const [key, value] of Object.entries(choices)) {
      if (value === '' && key !== 'permission') delete session[key]
      else session[key] = value
    }
    await rt.save()
    return session
  }
  // A session keeps its default "Session N" — or the new-conversation draft's
  // "新会话" — only until its first input; the opening of that input becomes
  // the name, so the rail matches the titles engines derive from the same
  // input in their own apps.
  const turnTitle = (fallback, text, images) => {
    if (!/^(Session \d+|新会话)$/.test(fallback)) return fallback
    const title = rt.redactSecrets(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, 40)
    return title || (images.length > 0 ? '[图片]' : fallback)
  }
  // Native sends never cross dispatch, so the first user/message event on the
  // host session names the plugin record here, and its native twin follows.
  // Every send stamps the rail's session time and saves: the state revision is
  // what makes the client's next poll re-sort the list.
  const messageText = data => {
    const content = data?.content
    return typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : ''
  }
  const nativeTwinOf = session => session.engine === 'dsh' ? session.driverSessionId : null
  const titleSessionFromNative = async (nativeSessionId, data) => {
    for (const profile of Object.values(rt.state.profiles)) {
      const session = rt.sessionsOf(profile).find(item => nativeTwinOf(item) === nativeSessionId)
      if (!session) continue
      session.lastActiveAt = Date.now()
      const named = rt.turnTitle(session.name, messageText(data), [])
      if (named === session.name) { await rt.save(); return }
      session.name = named
      delete session.draftedAt
      await rt.save()
      const twin = nativeTwinOf(session)
      if (twin) await rt.renameHostSession?.(twin, `${session.profileName ?? profile.name} · ${named}`)
      return
    }
  }
  const saveSessionEvent = async (id, event) => {
    const found = conversationOf(id)
    if (!found) return
    const { profile, session } = conversation(found.profile.id, id)
    if (event.sessionId) session.driverSessionId = event.sessionId
    if (event.workspaceId) session.workspaceId = event.workspaceId
    // Keep the legacy first-session pointer available to existing clients.
    if (session.id === profile.id && event.sessionId) profile.driverSessionId = event.sessionId
    await rt.save()
  }
  Object.assign(rt, { snapshotIdentity, sessionsOf, sessionChoices, cleanSessionChoices, sessionWorkspace, archiveDeletedSession, assertSessionWritable, conversationOf, conversation, prepareConversation, createSession, selectSession, openNativeSession, archiveSession, updateSession, turnTitle, titleSessionFromNative, saveSessionEvent })
}
