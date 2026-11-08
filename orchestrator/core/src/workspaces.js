// Workspaces: one directory per project. Profiles (roles) are configured under
// it and may share it; a profile's working directory resolves through its
// workspace (sessions.js).
//
//   { id, name, cwd, worktree?, deletedAt?, createdAt, updatedAt }
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { readdirSync, realpathSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { validateWorkspace } from '../../agent-drivers/dist/cli.js'
import { IMAGE_BYTES_MAX } from './constants.js'
import { DISPLAY_IMAGE_MIME_BY_EXT } from './image-types.js'
import { readImageFile } from './image-files.js'
import { normalize, unquote, uniqueName } from './text.js'
import { failure, invalid } from './errors.js'
import { inside } from './fs.js'
import { nativeIdOf } from '../shared/session.js'

// The @-context search answers at most this many paths and walks at most this
// deep, so a big tree costs the same small reply.
const FILES_MATCH_MAX = 30
const FILES_DEPTH = 6
// The changes card's on-demand file view reads at most this many bytes.
const FILE_VIEW_LIMIT = 512 * 1024
const DIR_MAX = 1000

const confine = (base, path) => {
  if (!inside(base, path)) throw invalid('文件不在会话工作区内')
}
const unreadable = error => {
  if (error.code === 'ENOENT') return null
  throw invalid(`文件不可读：${error.message}`)
}
const directoryUnreadable = error => {
  const missing = error.code === 'ENOENT'
  throw missing ? failure('目录不存在', 'orch/not-found') : invalid('目录不可读')
}

export function install(rt) {
  const { state } = rt

  const cleanName = (raw, exceptId) => uniqueName(raw, 'workspace', name =>
    Object.values(state.workspaces).find(workspace => workspace.id !== exceptId && normalize(workspace.name) === normalize(name))?.name)
  const cleanCwd = (raw) => {
    const cwd = typeof raw === 'string' ? raw.trim() : ''
    if (cwd === '' || !isAbsolute(cwd) || cwd.includes('\0')) throw invalid('Workspace directory must be an absolute path')
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
    return { ...workspace }
  }

  const updateWorkspace = async (id, changes) => {
    await rt.load()
    const workspace = state.workspaces[String(id ?? '')]
    if (workspace === undefined) throw failure('No such workspace', 'orch/not-found')
    const profiles = profilesIn(workspace).filter(profile => !profile.deletedAt)
    if (profiles.some(profile => rt.sessionsOf(profile).some(session => rt.sessionWorkspace(profile, session)?.id === workspace.id && rt.workView?.()[session.id]?.active))) throw failure('Stop or finish the running tasks before editing this workspace', 'orch/busy')
    // Validate the complete candidate before mutating the live record.
    const next = { ...workspace }
    if (changes.name !== undefined) next.name = cleanName(changes.name, workspace.id)
    if (changes.cwd !== undefined) next.cwd = cleanCwd(changes.cwd)
    const moved = next.cwd !== workspace.cwd
    Object.assign(workspace, next, { updatedAt: Date.now() })
    // A moved directory invalidates every engine conversation under it.
    if (moved) for (const profile of profiles) await rt.restartConversations(profile, workspace.id)
    await rt.save()
    return { ...workspace }
  }

  const deleteWorkspace = async (id) => {
    await rt.load()
    const workspace = state.workspaces[String(id ?? '')]
    if (workspace === undefined) throw failure('No such workspace', 'orch/not-found')
    // A project takes its worktrees with it; a worktree alone deletes alone.
    const realpaths = projectRealpaths()
    const removals = [workspace.id, ...Object.values(state.workspaces).filter(item => item.worktree !== undefined
      && item.id !== workspace.id && worktreeProjectOf(item, realpaths) === workspace.id).map(item => item.id)]
    const inScope = ref => removals.includes(ref)
    const profiles = Object.values(state.profiles).filter(profile => profile.workspaceId === workspace.id
      || rt.sessionsOf(profile).some(session => inScope(rt.sessionWorkspace(profile, session)?.id)))
    const refuseBusy = () => {
      const work = rt.workView()
      if (profiles.some(profile => rt.sessionsOf(profile).some(session => inScope(rt.sessionWorkspace(profile, session)?.id)
        && work[session.id]?.active))) throw failure('请先停止或完成此工作区中正在运行的任务，再删除工作区', 'orch/busy')
    }
    refuseBusy()
    const rollback = await rt.archiveHostSessions?.(profiles.flatMap(profile => rt.sessionsOf(profile).filter(session => inScope(rt.sessionWorkspace(profile, session)?.id))))
    try { refuseBusy() } catch (error) { await rollback?.(error); throw error }
    for (const profile of profiles) {
      profile.sessions ??= rt.sessionsOf(profile)
      for (const session of profile.sessions) {
        if (!inScope(rt.sessionWorkspace(profile, session)?.id)) continue
        rt.archiveDeletedSession(profile, session)
      }
      if (profile.sessions.some(session => session.id === profile.activeSessionId && session.archivedAt)) profile.activeSessionId = profile.sessions.find(session => !session.archivedAt)?.id
      if (profile.workspaceId === workspace.id) delete profile.workspaceId
    }
    for (const ref of removals) delete state.workspaces[ref]
    await rt.save()
    return true
  }

  // One realpath per project; legacy worktree records resolve their owner
  // through this table.
  const projectRealpaths = () => {
    const paths = new Map()
    for (const item of Object.values(state.workspaces)) {
      if (item.worktree !== undefined) continue
      let real = item.cwd
      try { real = realpathSync(item.cwd) } catch {}
      paths.set(item.id, [item.cwd, real])
    }
    return paths
  }
  const worktreeProjectOf = (workspace, realpaths = projectRealpaths()) => {
    let current = workspace
    while (current?.worktree) {
      const source = state.workspaces[current.worktree.sourceWorkspaceRef ?? '']
      if (source === undefined) break
      if (source.worktree === undefined) return source.id
      current = source
    }
    if (current?.worktree === undefined) return current?.id ?? null
    const root = current.worktree.repositoryRoot
    for (const [id, paths] of realpaths) if (paths.includes(root)) return id
    return null
  }

  const findWorkspace = (ref) => {
    if (ref === undefined || ref === null) return undefined
    if (state.workspaces[ref] !== undefined) return state.workspaces[ref]
    const wanted = normalize(unquote(ref))
    return Object.values(state.workspaces).find(workspace => normalize(workspace.name) === wanted)
  }

  const workspaceOf = profile => state.workspaces[profile?.workspaceId]

  // The composer's @-context search: relative file paths under the workspace's
  // directory, engine-agnostic — every agent reads a path with its own tools.
  const workspaceFiles = async ({ workspace, query = '', ...scope }) => {
    const target = workspace !== undefined ? rt.findWorkspace(workspace) : { cwd: await sessionCwd(scope) }
    if (target === undefined) throw invalid(`No workspace "${workspace}"`)
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
        if (found.length >= FILES_MATCH_MAX) return
      }
    }
    visit('', FILES_DEPTH)
    return { files: found }
  }

  const sessionCwd = async ({ workspace, profile, session, target }) => {
    await rt.load()
    let found, cwd
    if (workspace !== undefined) {
      const project = typeof workspace === 'string' && rt.state.workspaces[workspace]
      if (!project || project.deletedAt) throw failure('No such workspace', 'orch/not-found')
      cwd = project.cwd
    } else if (target !== undefined) {
      found = Object.values(rt.state.profiles).flatMap(item => rt.sessionsOf(item).map(owned => ({ profile: item, session: owned })))
        .find(item => (nativeIdOf(item.session) ?? item.session.id) === target)
      if (!found) throw failure('No such session', 'orch/not-found')
    } else {
      try { found = rt.conversation(profile, session) } catch { throw failure('No such session', 'orch/not-found') }
    }
    return found ? found.session.cwd ?? rt.sessionWorkspace(found.profile, found.session)?.cwd : cwd
  }

  const workspacePath = async ({ path: wanted, workspace, ...scope }, directory = false) => {
    const cwd = await sessionCwd({ workspace, ...scope })
    if (!cwd || typeof wanted !== 'string' || (!directory && wanted === '') || wanted.includes('\0')) throw invalid('需要会话工作区内的文件路径')
    const root = resolve(cwd)
    const full = resolve(root, wanted)
    try { confine(root, full) } catch (error) {
      const real = isAbsolute(wanted) ? await realpath(full).catch(() => null) : null
      const rootReal = await realpath(root).catch(() => null)
      // An absolute path can spell the workspace root through a symlink (/tmp vs /private/tmp).
      const reachable = real !== null && (inside(root, real) || (rootReal !== null && inside(rootReal, real)))
      if (!reachable) {
        if (workspace === undefined || !isAbsolute(wanted)) throw error
        if (!rootReal) throw error
        confine(rootReal, full)
      }
    }
    // Symbolic links are followed only while they stay inside the workspace.
    const real = await realpath(full).catch(directory ? directoryUnreadable : unreadable)
    const realRoot = real === null ? null : await (directory ? realpath(root).catch(directoryUnreadable) : realpath(root))
    if (real !== null) confine(realRoot, real)
    return { full, real, root: realRoot }
  }

  const workspaceDir = async body => {
    const { real, root } = await workspacePath(body, true)
    if (real === null || !(await stat(real).catch(directoryUnreadable)).isDirectory()) throw failure('目录不存在', 'orch/not-found')
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

  // One bounded read confined to the conversation's own workspace; the outer workspaceFile additionally serves attachment-policy images.
  const readWorkspaceFile = async body => {
    const { full, real } = await workspacePath(body)
    if (real === null) return { path: full, missing: true }
    const info = await stat(real).catch(unreadable)
    if (!info?.isFile()) return { path: full, missing: true }
    const mediaType = DISPLAY_IMAGE_MIME_BY_EXT[extname(full).toLowerCase()]
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

  // Stream tool rows reference images outside the workspace; image extensions
  // fall back to the attachment read policy (cwd, tmp roots, generated images).
  const workspaceFile = async body => {
    try { return await readWorkspaceFile(body) } catch (error) {
      const wanted = typeof body?.path === 'string' ? body.path : ''
      if (error.message !== '文件不在会话工作区内' || !DISPLAY_IMAGE_MIME_BY_EXT[extname(wanted).toLowerCase()]) throw error
      const root = resolve(await sessionCwd(body))
      const full = resolve(root, wanted)
      if (inside(root, full)) throw error // escaped through a symlink after passing containment — keep it refused
      const info = await stat(full).catch(unreadable)
      if (!info?.isFile()) return { path: full, missing: true }
      let image
      try { image = await readImageFile(wanted, root) } catch (reason) {
        if (reason.message === 'image-too-large') return { path: full, binary: true }
        // OS error messages carry absolute paths; refuse without them.
        throw invalid('文件不在会话工作区内')
      }
      return { path: full, image: { mediaType: image.mediaType, dataUrl: `data:${image.mediaType};base64,${image.data}` } }
    }
  }

  Object.assign(rt, {
    createWorkspace, updateWorkspace, deleteWorkspace, findWorkspace, workspaceOf, workspaceFiles, workspaceDir, workspaceFile, cleanWorkspaceName: cleanName,
    worktreeProjectOf,
    workspacesView: () => {
      const realpaths = projectRealpaths()
      return Object.values(state.workspaces).map(workspace => ({ ...workspace,
        ...(workspace.worktree === undefined ? {} : { worktree: { ...workspace.worktree, project: worktreeProjectOf(workspace, realpaths) } }) }))
    },
  })
}
