// Workspaces: the desks, hoisted out of the role cards. A workspace is one
// directory on this machine; profiles (roles) are configured under it and may
// share it, so the model is workspace first, roles after. A profile's working
// directory is resolved through its workspace — see sessions.js.
//
//   { id, name, cwd, createdAt, updatedAt }
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readdirSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { validateWorkspace } from '../../agent-drivers/dist/cli.js'
import { IMAGE_BYTES_MAX, NAME_MAX } from './constants.js'
import { normalize, unquote } from './text.js'

// The @-context search answers at most this many paths and walks at most this
// deep, so a big tree costs the same small reply.
const FILES_MAX = 30
const FILES_DEPTH = 6
// The changes card's on-demand file view reads at most this many bytes.
const FILE_VIEW_LIMIT = 512 * 1024
const DIR_MAX = 1000
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

const confine = (base, path) => {
  const rest = relative(base, path)
  if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw Object.assign(new Error('文件不在会话工作区内'), { code: 'orch/invalid' })
}
const unreadable = error => {
  if (error.code === 'ENOENT') return null
  throw Object.assign(new Error(`文件不可读：${error.message}`), { code: 'orch/invalid' })
}
const directoryUnreadable = error => {
  const missing = error.code === 'ENOENT'
  throw Object.assign(new Error(missing ? '目录不存在' : '目录不可读'), { code: missing ? 'orch/not-found' : 'orch/invalid' })
}

export function install(rt) {
  const { state } = rt

  const cleanName = (raw, exceptId) => {
    const name = unquote(raw).slice(0, NAME_MAX)
    if (name === '') throw Object.assign(new Error('A workspace needs a name'), { code: 'orch/invalid' })
    const taken = Object.values(state.workspaces).find(workspace => workspace.id !== exceptId && normalize(workspace.name) === normalize(name))
    if (taken !== undefined) throw Object.assign(new Error(`The name "${name}" is already ${taken.name}`), { code: 'orch/invalid' })
    return name
  }
  const cleanCwd = (raw) => {
    const cwd = typeof raw === 'string' ? raw.trim() : ''
    if (cwd === '' || !isAbsolute(cwd) || cwd.includes('\0')) throw Object.assign(new Error('Workspace directory must be an absolute path'), { code: 'orch/invalid' })
    try { return validateWorkspace(cwd) } catch (error) { if (!error.message.includes('does not exist')) throw error; return cwd }
  }

  const profilesIn = workspace => Object.values(state.profiles).filter(profile => profile.workspaceId === workspace.id
    || rt.sessionsOf(profile).some(session => rt.sessionWorkspace(profile, session)?.id === workspace.id))

  const createWorkspace = async ({ name, cwd, worktree }) => {
    await rt.load()
    const workspace = { id: randomUUID(), name: cleanName(name), cwd: cleanCwd(cwd), createdAt: Date.now(), updatedAt: Date.now(),
      ...(worktree === undefined ? {} : { worktree }) }
    state.workspaces[workspace.id] = workspace
    await rt.save()
    return workspaceView(workspace)
  }

  const updateWorkspace = async (id, changes) => {
    await rt.load()
    const workspace = state.workspaces[String(id ?? '')]
    if (workspace === undefined) throw Object.assign(new Error('No such workspace'), { code: 'orch/not-found' })
    const profiles = profilesIn(workspace).filter(profile => !profile.deletedAt)
    if (profiles.some(profile => rt.sessionsOf(profile).some(session => rt.sessionWorkspace(profile, session)?.id === workspace.id && rt.workView?.()[session.id]?.active))) throw Object.assign(new Error('Stop or finish the running tasks before editing this workspace'), { code: 'orch/busy' })
    // Validate the complete candidate before mutating the live record.
    const next = { ...workspace }
    if (changes.name !== undefined) next.name = cleanName(changes.name, workspace.id)
    if (changes.cwd !== undefined) next.cwd = cleanCwd(changes.cwd)
    const moved = next.cwd !== workspace.cwd
    Object.assign(workspace, next, { updatedAt: Date.now() })
    // A moved directory invalidates every engine conversation under it, exactly
    // as editing a profile's own directory did before workspaces existed.
    if (moved) for (const profile of profiles) await rt.restartConversations(profile, workspace.id)
    await rt.save()
    return workspaceView(workspace)
  }

  const deleteWorkspace = async (id) => {
    await rt.load()
    const workspace = state.workspaces[String(id ?? '')]
    if (workspace === undefined) throw Object.assign(new Error('No such workspace'), { code: 'orch/not-found' })
    for (const summary of await rt.listRuns()) {
      if (['done', 'failed', 'cancelled', 'unreadable'].includes(summary.status)) continue
      const run = await rt.loadRun(summary.id)
      const usesSession = Object.values(run.attempts).some(attempt => {
        const found = attempt.sessionId && rt.conversationOf(attempt.sessionId)
        return attempt.workspaceId === workspace.id || found && rt.sessionWorkspace(found.profile, found.session)?.id === workspace.id
      })
      const usesRole = run.snapshot.input?.workspaceId === undefined && Object.keys(run.snapshot.profiles ?? {}).some(id => {
        const profile = state.profiles[id]
        return profile && rt.sessionWorkspace(profile, rt.sessionsOf(profile).find(session => session.id === profile.activeSessionId))?.id === workspace.id
      })
      if (run.snapshot.input?.workspaceId === workspace.id || usesSession || usesRole) throw Object.assign(new Error('请先结束或取消使用此工作区的工作流，再删除工作区'), { code: 'orch/busy' })
    }
    const profiles = profilesIn(workspace)
    const refuseBusy = () => {
      const work = rt.workView()
      if (profilesIn(workspace).some(profile => rt.sessionsOf(profile).some(session => rt.sessionWorkspace(profile, session)?.id === workspace.id
        && work[session.id]?.active))) throw Object.assign(new Error('请先停止或完成此工作区中正在运行的任务，再删除工作区'), { code: 'orch/busy' })
    }
    refuseBusy()
    const rollback = await rt.archiveHostSessions?.(profiles.flatMap(profile => rt.sessionsOf(profile).filter(session => rt.sessionWorkspace(profile, session)?.id === workspace.id)))
    try { refuseBusy() } catch (error) { await rollback?.(error); throw error }
    for (const profile of profiles) {
      profile.sessions ??= rt.sessionsOf(profile)
      for (const session of profile.sessions) {
        if (rt.sessionWorkspace(profile, session)?.id !== workspace.id) continue
        rt.archiveDeletedSession(profile, session)
      }
      if (profile.sessions.some(session => session.id === profile.activeSessionId && session.archivedAt)) profile.activeSessionId = profile.sessions.find(session => !session.archivedAt)?.id
      if (profile.workspaceId === workspace.id) delete profile.workspaceId
    }
    delete state.workspaces[workspace.id]
    await rt.save()
    return true
  }

  const findWorkspace = (ref) => {
    if (ref === undefined || ref === null) return undefined
    if (state.workspaces[ref] !== undefined) return state.workspaces[ref]
    const wanted = normalize(unquote(ref))
    return Object.values(state.workspaces).find(workspace => normalize(workspace.name) === wanted)
  }

  const workspaceOf = profile => state.workspaces[profile?.workspaceId]
  const workspaceView = workspace => ({ ...workspace })

  // The composer's @-context search: relative file paths under the workspace's
  // directory, engine-agnostic — every agent reads a path with its own tools.
  const workspaceFiles = ({ workspace, query = '' }) => {
    const target = rt.findWorkspace(workspace)
    if (target === undefined) throw Object.assign(new Error(`No workspace "${workspace}"`), { code: 'orch/invalid' })
    const wanted = String(query ?? '').trim().toLowerCase()
    const found = []
    const visit = (prefix, depth) => {
      let entries
      try { entries = readdirSync(join(target.cwd, prefix), { withFileTypes: true }) } catch { return }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        if (entry.isFile()) {
          if (wanted === '' || path.toLowerCase().includes(wanted)) found.push(path)
        } else if (entry.isDirectory() && depth > 1) visit(path, depth - 1)
        if (found.length >= FILES_MAX) return
      }
    }
    visit('', FILES_DEPTH)
    return { files: found }
  }

  const workspacePath = async ({ workspace, profile, session, target, path: wanted }, directory = false) => {
    await rt.load()
    let found, cwd
    if (workspace !== undefined) {
      const project = typeof workspace === 'string' && rt.state.workspaces[workspace]
      if (!project || project.deletedAt) throw Object.assign(new Error('No such workspace'), { code: 'orch/not-found' })
      cwd = project.cwd
    } else if (target !== undefined) {
      found = Object.values(rt.state.profiles).flatMap(item => rt.sessionsOf(item).map(owned => ({ profile: item, session: owned })))
        .find(item => ((item.session.engine === 'dsh' ? item.session.driverSessionId : undefined) ?? item.session.id) === target)
      if (!found) throw Object.assign(new Error('No such session'), { code: 'orch/not-found' })
    } else {
      try { found = rt.conversation(profile, session) } catch { throw Object.assign(new Error('No such session'), { code: 'orch/not-found' }) }
    }
    if (found) cwd = found.session.cwd ?? rt.sessionWorkspace(found.profile, found.session)?.cwd
    if (!cwd || typeof wanted !== 'string' || (!directory && wanted === '') || wanted.includes('\0')) throw Object.assign(new Error('需要会话工作区内的文件路径'), { code: 'orch/invalid' })
    const root = resolve(cwd)
    const full = resolve(root, wanted)
    try { confine(root, full) } catch (error) {
      if (workspace === undefined || !isAbsolute(wanted)) throw error
      const actual = await realpath(root).catch(() => null)
      if (!actual) throw error
      confine(actual, full)
    }
    // Symbolic links are followed only while they stay inside the workspace.
    const real = await realpath(full).catch(directory ? directoryUnreadable : unreadable)
    const realRoot = real === null ? null : await (directory ? realpath(root).catch(directoryUnreadable) : realpath(root))
    if (real !== null) confine(realRoot, real)
    return { full, real, root: realRoot }
  }

  const workspaceDir = async body => {
    const { real, root } = await workspacePath(body, true)
    if (real === null || !(await stat(real).catch(directoryUnreadable)).isDirectory()) throw Object.assign(new Error('目录不存在'), { code: 'orch/not-found' })
    const entries = []
    for (const entry of await readdir(real, { withFileTypes: true }).catch(directoryUnreadable)) {
      if (entry.name === '.git') continue
      let info = entry
      if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(join(real, entry.name))
          confine(root, target)
          info = await stat(target)
        } catch { continue }
      }
      if (info.isDirectory() || info.isFile()) entries.push({ name: entry.name, kind: info.isDirectory() ? 'dir' : 'file' })
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    return { entries: entries.slice(0, DIR_MAX), ...(entries.length > DIR_MAX ? { truncated: true } : {}) }
  }

  // The changes card's 查看当前内容: one bounded read, constrained to the
  // conversation's own workspace so a captured path cannot reach elsewhere.
  const workspaceFile = async body => {
    const { full, real } = await workspacePath(body)
    if (real === null) return { path: full, missing: true }
    const info = await stat(real).catch(unreadable)
    if (!info?.isFile()) return { path: full, missing: true }
    const mediaType = IMAGE_TYPES[extname(full).toLowerCase()]
    if (mediaType && info.size > IMAGE_BYTES_MAX) return { path: full, binary: true }
    await rt.loadSecrets()
    const handle = await open(real, 'r')
    try {
      if (mediaType) {
        const chunk = Buffer.alloc(Math.min(info.size, IMAGE_BYTES_MAX) + 1)
        let size = 0
        while (size < chunk.length) {
          const { bytesRead } = await handle.read(chunk, size, chunk.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        return size > IMAGE_BYTES_MAX ? { path: full, binary: true }
          : { path: full, image: { mediaType, dataUrl: `data:${mediaType};base64,${chunk.subarray(0, size).toString('base64')}` } }
      }
      const chunk = Buffer.alloc(FILE_VIEW_LIMIT + 1)
      const { bytesRead } = await handle.read(chunk, 0, FILE_VIEW_LIMIT + 1, 0)
      if (chunk.subarray(0, bytesRead).includes(0)) return { path: full, binary: true }
      return { path: full, text: rt.redactSecrets(chunk.subarray(0, Math.min(bytesRead, FILE_VIEW_LIMIT)).toString('utf8')), truncated: bytesRead > FILE_VIEW_LIMIT || undefined }
    } finally { await handle.close() }
  }

  Object.assign(rt, {
    createWorkspace, updateWorkspace, deleteWorkspace, findWorkspace, workspaceOf, workspaceFiles, workspaceDir, workspaceFile, cleanWorkspaceName: cleanName,
    workspacesView: () => Object.values(state.workspaces).map(workspaceView),
  })
}
