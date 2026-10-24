// Profiles: the role cards. One profile is who an agent is and which engine
// runs it — the orchestrator's equivalent of a hire: name, role, tools. Each
// conversation chooses its workspace independently; keys reach a profile
// through each key's own scope (secrets.js).
//
//   { id, name, role, engine, workspaceId?, model?, thinking?,
//     instructions, driverSessionId?, createdAt, updatedAt }
//
// The driverSessionId is the engine-side conversation id (e.g. a Codex thread
// id) captured from the driver; it lets a fresh process resume where the
// last one left off. Nothing here knows how to talk to an engine — that is drivers.js.
import { randomUUID } from 'node:crypto'
import { INSTRUCTIONS_MAX, MAX_PROFILES, NAME_MAX, ROLE_MAX } from './constants.js'
import { normalize, unquote } from './text.js'
import avatarTemplates from '../shared/avatar-templates.json' with { type: 'json' }
import builtInPresets from '../shared/role-presets.json' with { type: 'json' }

const cleanAvatarTemplate = raw => {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (!avatarTemplates.some(item => item.id === raw)) throw Object.assign(new Error('Invalid avatar template'), { code: 'orch/invalid' })
  return raw
}

export const cleanModel = raw => {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > 200 || /[\r\n\0]/.test(raw)) throw Object.assign(new Error('Invalid model name'), { code: 'orch/invalid' })
  return raw.trim() || undefined
}

// A thinking level is one engine-defined id (Codex reasoning effort, DSH
// reasoning effort, ZCode thought level). It is not checked against the scanned
// catalog, so a saved level survives a catalog that changed since.
export const cleanThinking = raw => {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > 60 || !/^[\w.-]+$/.test(raw.trim())) throw Object.assign(new Error('Invalid thinking level'), { code: 'orch/invalid' })
  return raw.trim()
}

export function install(rt) {
  const { state } = rt

  // A permission tier is one of the host's three autonomy levels (spi.js), kept
  // only when the engine declares it. An unset tier is the engine's default.
  const cleanPermission = (engine, raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined
    const permission = String(raw)
    if (!rt.enginePermissionModes(engine).includes(permission)) throw Object.assign(new Error(`Engine ${engine} does not offer the permission tier "${permission}"`), { code: 'orch/invalid' })
    return permission
  }

  const cleanName = (raw, exceptId) => {
    const name = unquote(raw).slice(0, NAME_MAX)
    if (name === '') throw Object.assign(new Error('A profile needs a name'), { code: 'orch/invalid' })
    const taken = Object.values(state.profiles).find(profile => profile.id !== exceptId && normalize(profile.name) === normalize(name))
    if (taken !== undefined) throw Object.assign(new Error(`The name "${name}" is already ${taken.name}`), { code: 'orch/invalid' })
    return name
  }
  const cleanEngine = (raw) => {
    const engine = String(raw ?? '')
    if (!rt.listEngines().includes(engine)) {
      throw Object.assign(new Error(`Unknown engine "${engine}"; pick from ${rt.listEngines().join(', ')}`), { code: 'orch/invalid' })
    }
    return engine
  }
  const cleanWorkspace = (raw) => {
    if (raw === undefined || raw === null || raw === '') throw Object.assign(new Error('A profile needs a workspace'), { code: 'orch/invalid' })
    const workspace = rt.findWorkspace(raw)
    if (workspace === undefined) throw Object.assign(new Error(`No workspace "${raw}"`), { code: 'orch/invalid' })
    return workspace.id
  }

  const createProfile = async ({ name, role = '', engine, workspace, model, thinking, permission, engineOptions, instructions = '', goal = '', avatarTemplate }) => {
    await rt.load()
    await rt.driversReady()
    if (Object.keys(state.profiles).length >= MAX_PROFILES) throw Object.assign(new Error(`At most ${MAX_PROFILES} profiles`), { code: 'orch/invalid' })
    engine = cleanEngine(engine)
    const workspaceId = workspace === undefined ? undefined : cleanWorkspace(workspace)
    const defaults = rt.engineConfig(engine)
    const chosenModel = cleanModel(model === undefined ? defaults.model : model)
    const chosenThinking = cleanThinking(thinking === undefined ? defaults.thinking : thinking)
    const chosenPermission = cleanPermission(engine, permission)
    const profile = {
      id: randomUUID(),
      name: cleanName(name),
      role: String(role ?? '').slice(0, ROLE_MAX),
      engine,
      avatarTemplate: cleanAvatarTemplate(avatarTemplate)
        ?? avatarTemplates[Object.keys(state.profiles).length % avatarTemplates.length].id,
      ...(workspaceId ? { workspaceId } : { sessions: [] }),
      ...(chosenModel !== undefined ? { model: chosenModel } : {}),
      ...(chosenThinking !== undefined ? { thinking: chosenThinking } : {}),
      ...(chosenPermission !== undefined ? { permission: chosenPermission } : {}),
      engineOptions: rt.validateEngineOptions(engine, engineOptions === undefined ? defaults.engineOptions : engineOptions),
      instructions: String(instructions ?? '').slice(0, INSTRUCTIONS_MAX),
      goal: String(goal ?? '').slice(0, INSTRUCTIONS_MAX),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    state.profiles[profile.id] = profile
    await rt.save()
    rt.releaseDriver?.(profile.id)
    return profileView(profile)
  }

  const updateProfile = async (id, changes) => {
    await rt.load()
    await rt.driversReady()
    const profile = state.profiles[String(id ?? '')]
    if (profile === undefined) throw Object.assign(new Error('No such profile'), { code: 'orch/not-found' })
    if (rt.sessionsOf(profile).some(session => rt.workView?.()[session.id]?.active)) throw Object.assign(new Error('Stop or finish the running task before editing this profile'), { code: 'orch/busy' })
    // Validate the complete candidate before mutating the live record or driver.
    const next = { ...profile }
    if (changes.name !== undefined) next.name = cleanName(changes.name, profile.id)
    if (changes.role !== undefined) next.role = String(changes.role ?? '').slice(0, ROLE_MAX)
    if (changes.avatarTemplate !== undefined) next.avatarTemplate = cleanAvatarTemplate(changes.avatarTemplate)
    next.engine = cleanEngine(changes.engine !== undefined ? changes.engine : profile.engine)
    // An engine is fixed for the life of a role: presets and native sessions
    // are keyed by it, and a switch would orphan every conversation it has.
    if (next.engine !== profile.engine) throw Object.assign(new Error('An engine is fixed once a role is created; make a new role for another engine'), { code: 'orch/invalid' })
    if (changes.workspace !== undefined) next.workspaceId = cleanWorkspace(changes.workspace)
    next.model = cleanModel(changes.model !== undefined ? changes.model : profile.model)
    next.thinking = cleanThinking(changes.thinking !== undefined ? changes.thinking : profile.thinking)
    next.permission = cleanPermission(next.engine, changes.permission !== undefined ? changes.permission : profile.permission)
    next.engineOptions = rt.validateEngineOptions(next.engine, changes.engineOptions !== undefined ? changes.engineOptions : profile.engineOptions)
    if (changes.instructions !== undefined) next.instructions = String(changes.instructions ?? '').slice(0, INSTRUCTIONS_MAX)
    if (changes.goal !== undefined) next.goal = String(changes.goal ?? '').slice(0, INSTRUCTIONS_MAX)
    // permission is absent on purpose: every engine applies the tier when its
    // process spawns or its session resumes, so a tier change re-arms the driver
    // and keeps the conversation instead of opening a new one.
    const respawnKeys = ['name', 'engine', 'workspaceId', 'model', 'thinking', 'engineOptions', 'role', 'instructions', 'goal']
      .filter(key => JSON.stringify(next[key]) !== JSON.stringify(profile[key]))
    const permissionChanged = next.permission !== profile.permission
    const respawn = respawnKeys.length > 0
    if (respawn) {
      profile.sessions ??= rt.sessionsOf(profile)
      for (const session of profile.sessions) {
        session.workspaceRef ??= rt.sessionWorkspace(profile, session)?.id
        rt.snapshotIdentity(profile, session)
      }
    }
    Object.assign(profile, next, { updatedAt: Date.now() })
    if (profile.model === undefined) delete profile.model
    if (profile.thinking === undefined) delete profile.thinking
    if (respawn || permissionChanged) {
      const active = rt.sessionsOf(profile).find(item => item.id === profile.activeSessionId)
      // The card's model/thinking pair is the default for conversations it opens
      // later: a started conversation keeps its own pair, an unsent draft adopts
      // the card in place. Any other card change outlives a started conversation,
      // so only a session that has not sent its first message yet adopts the full
      // card.
      const retuned = respawn ? respawnKeys.every(key => key === 'model' || key === 'thinking') : true
      if (!active || respawnKeys.includes('workspaceId') || (!retuned && active.briefSent)) await rt.restartConversations(profile)
      else if (retuned) {
        if (!active.briefSent) Object.assign(active, { model: profile.model, thinking: profile.thinking })
        // The autonomy tier is per-turn: a tier change re-arms the driver and
        // keeps the conversation, and never rides along a model-only edit.
        if (permissionChanged) active.permission = profile.permission
      }
      else rt.snapshotIdentity(profile, Object.assign(active, {
        engine: profile.engine,
        model: profile.model,
        thinking: profile.thinking,
        engineOptions: { ...profile.engineOptions },
        profileName: profile.name,
        role: profile.role ?? '',
        instructions: profile.instructions ?? '',
        goal: profile.goal ?? '',
      }))
    }
    await rt.save()
    return profileView(profile)
  }

  // Engine conversations cannot follow a role card across a changed engine,
  // workspace, keys or instructions: they start over. Existing messages stay;
  // model and thinking follow the conversation instead.
  const restartConversations = async (profile, workspaceRef) => {
    if (rt.sessionsOf(profile).length) await rt.createSession(profile.id, undefined, workspaceRef ?? profile.workspaceId, true)
  }

  const deleteProfile = async (id) => {
    await rt.load()
    const profile = state.profiles[String(id ?? '')]
    if (profile === undefined) throw Object.assign(new Error('No such profile'), { code: 'orch/not-found' })
    if (rt.sessionsOf(profile).some(session => rt.workView?.()[session.id]?.active)) throw Object.assign(new Error('Stop or finish the running task before deleting this profile'), { code: 'orch/busy' })
    await rt.dropStreamDetails?.(profile.id)
    for (const session of rt.sessionsOf(profile)) { rt.cancelApprovals?.(session.id); rt.releaseDriver?.(session.id); rt.statsDrop?.(session.id); delete state.transcripts[session.id] }
    delete state.profiles[profile.id]
    delete state.transcripts[profile.id]
    rt.statsDrop?.(profile.id)
    await rt.save()
    await rt.dropReferences?.(rt.sessionsOf(profile))
    rt.collectIdentityFiles?.()
    return true
  }

  const findProfile = (ref) => {
    if (ref === undefined || ref === null) return undefined
    if (state.profiles[ref] !== undefined) return state.profiles[ref]
    const wanted = normalize(unquote(ref)).replace(/^@/, '')
    return Object.values(state.profiles).find(profile => normalize(profile.name) === wanted)
  }

  // Saved identities: a customized 身份/身份信息 pair kept beside the built-in
  // presets. They live in prefs, outside the role cards, so deleting a role
  // never takes its saved identity along and a later new role can pick it up.
  const savedIdentities = () => Array.isArray(state.prefs.rolePresets) ? state.prefs.rolePresets : []

  const saveRolePreset = async ({ name, role = '', instructions = '' } = {}) => {
    await rt.load()
    const title = unquote(name).slice(0, NAME_MAX)
    if (title === '') throw Object.assign(new Error('A saved identity needs a name'), { code: 'orch/invalid' })
    if (builtInPresets.some(item => normalize(item.name) === normalize(title))) throw Object.assign(new Error(`"${title}" is a built-in identity; pick another name`), { code: 'orch/invalid' })
    const entries = savedIdentities().filter(item => normalize(item.name) !== normalize(title))
    entries.push({ name: title, role: String(role ?? '').slice(0, ROLE_MAX), instructions: String(instructions ?? '').slice(0, INSTRUCTIONS_MAX), createdAt: Date.now() })
    entries.sort((a, b) => a.createdAt - b.createdAt)
    state.prefs.rolePresets = entries
    await rt.save()
    return entries
  }

  const deleteRolePreset = async ({ name } = {}) => {
    await rt.load()
    const entries = savedIdentities()
    const kept = entries.filter(item => item.name !== String(name ?? ''))
    if (kept.length === entries.length) throw Object.assign(new Error(`No saved identity "${name ?? ''}"`), { code: 'orch/not-found' })
    state.prefs.rolePresets = kept
    await rt.save()
    return kept
  }

  // Only configuration and identifiers are exposed; credentials live separately.
  // cwd/workspaceName are resolved from the profile's workspace for display.
  // Two shapes stay out of the rail: the implicit first session (id = profile
  // id, a v1 compat phantom until it has actually carried a turn), and a
  // never-sent draft — the host has no session-delete API, so an abandoned
  // "新会话" is kept for reuse and reappears only while it is the session in use.
  const profileView = profile => {
    const used = profile.driverSessionId !== undefined || (state.transcripts[profile.id]?.length ?? 0) > 0
    return { ...profile, cwd: rt.workspaceOf(profile)?.cwd, workspaceName: rt.workspaceOf(profile)?.name,
      sessions: rt.sessionsOf(profile)
        .filter(session => session.id !== profile.id || used)
        .filter(session => !session.draftedAt || session.briefSent || session.id === profile.activeSessionId)
        .map(session => ({ ...session, workspaceRef: rt.sessionWorkspace(profile, session)?.id,
          // The rail's session time is its latest activity — the dispatch
          // transcript's last line, the native twin's last turn, or a native
          // send stamp — falling back to when the session was created.
          updatedAt: (Math.max(state.transcripts[session.id]?.at(-1)?.at ?? 0, rt.nativeWork?.(session)?.lastAt ?? 0, session.lastActiveAt ?? 0)
            || session.createdAt) ?? profile.createdAt })),
      activeSessionId: profile.activeSessionId ?? profile.id }
  }

  Object.assign(rt, {
    createProfile, updateProfile, deleteProfile, findProfile, profileView, restartConversations,
    saveRolePreset, deleteRolePreset, cleanPermission,
    profilesView: () => Object.values(state.profiles).map(profileView),
  })
}
