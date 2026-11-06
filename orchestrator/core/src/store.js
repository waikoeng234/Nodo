import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, watch } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { NAME_MAX } from './constants.js'
import { normalize } from './text.js'
import { failure } from './errors.js'
import { homeLock } from './home-lock.js'
import { createTranscripts } from './transcripts.js'

const SECTIONS = ['workspaces', 'profiles', 'tasks', 'executions', 'decisions', 'transcripts', 'transcriptIndex', 'stats', 'engineCatalogs', 'prefs']
// `transcripts` holds only the transcripts loaded in memory and is not saved in state.json.
const blank = () => ({ version: 5, workspaces: {}, profiles: {}, tasks: {}, executions: {}, decisions: {}, transcripts: {}, transcriptIndex: {}, stats: {}, engineCatalogs: {}, prefs: {}, probe: null })
const STAMP_MS = 1000
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function install(rt) {
  const { ctx, home, warn } = rt
  const statePath = join(home, 'state.json')
  const activityPath = join(home, 'activity.json')

  /** @type {ReturnType<typeof blank>} */
  const state = blank()
  let watching = false
  const lock = homeLock(join(home, 'state.lock'), { watched: () => watching })
  let loading
  let writing = Promise.resolve()
  let queued
  let forceAll = false
  const forceIds = new Set()
  let timer
  let structureDirty = false
  let activityDirty = false
  let lastWrite = 0
  let activitySeen = ''
  let legacyState = false
  let retiredState = false
  let stopped = false
  // The lock record of the dsh that writes while this one reads.
  let other
  // The lock could not be used (odd file system): write without it, trying it again before each write.
  let unlockable = false
  // Why state.json could not be read; nothing is written while it is set.
  let blocked
  let warnedBlocked = false
  let seen = ''
  // 两个客户端版本号：结构版本随 save 增加（活动数据除外），活动计数只随对话内容增加。
  let struct = 0
  let activity = 0
  // 行编号的有效期标记：客户端回传的位置带它；换了宿主或重新读入状态就换新，客户端随之全量重取。
  let bootToken = randomUUID()
  const listeners = new Set()
  const notifyLive = () => { for (const listener of listeners) listener() }

  // Another machine's writes on a shared directory never reach the watcher, so the stamp also expires.
  const fileStamp = { value: null, at: 0 }
  const fileVersion = () => {
    if (fileStamp.value !== null && Date.now() - fileStamp.at < STAMP_MS) return fileStamp.value
    try {
      fileStamp.value = stamp(statePath)
    } catch {
      fileStamp.value = ''
    }
    fileStamp.at = Date.now()
    return fileStamp.value
  }
  let watcher
  try {
    mkdirSync(home, { recursive: true })
    watcher = watch(home, { persistent: false }, (_event, name) => {
      if (name === null || name === basename(statePath) || name === basename(activityPath)) fileStamp.value = null
      if (name === null || name === 'state.lock') lock.revalidate()
      if (listeners.size) void refresh().then(notifyLive).catch(() => {})
    })
    watcher.on('error', () => { watching = false })
    watching = true
  } catch {}

  // Whether this host may write after trying to take the lock.
  const takeLock = () => {
    try {
      mkdirSync(home, { recursive: true })
      other = lock.claim()
      unlockable = false
    } catch (error) {
      if (!unlockable) warn('nodo: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
      unlockable = true
      other = undefined
    }
    return other === undefined
  }

  // Whether this writer may still write over what it last read. A lock taken after
  // writing without one finds the file changed meanwhile: refresh reloads it first.
  const holds = () => {
    if (!unlockable) return lock.owns()
    if (takeLock() && !unlockable && fileVersion() !== seen) other = {}
    return other === undefined
  }

  const readOnly = () => {
    if (blocked !== undefined) return `The Nodo file ${statePath} could not be read (${blocked}). It is not changed; fix or move the file and reload.`
    if (other === undefined) return unlockable || loading === undefined || lock.owns() ? undefined : `Another dsh took over the Nodo data in ${home}. This window cannot change it; reload.`
    const who = [other.pid && `pid ${other.pid}`, other.host && `on ${other.host}`].filter(Boolean).join(' ') || 'unknown process'
    return `The Nodo data in ${home} is open in another dsh (Web or Desktop, ${who}). This window shows it but cannot change it; close the other one and reload.`
  }

  // The saved state, or undefined to start empty; sets `blocked` when the file must
  // not be overwritten. Unparsable JSON is copied aside first.
  const readSaved = async () => {
    let text
    try {
      text = await readFile(statePath, 'utf8')
    } catch (error) {
      blocked = error.code === 'ENOENT' ? undefined : error.code ?? error.message
      if (blocked !== undefined) warn('nodo: unreadable state %s: %s', statePath, error)
      return undefined
    } finally {
      seen = fileVersion()
    }
    let saved
    try {
      saved = JSON.parse(text)
    } catch (error) {
      const backup = `${statePath}.broken-${Date.now()}`
      blocked = await copyFile(statePath, backup).then(() => undefined, copyError => copyError.code ?? copyError.message)
      if (blocked === undefined) warn('nodo: unreadable state %s: %s; backed up as %s', statePath, error, backup)
      else warn('nodo: unreadable state %s: %s; backup failed: %s', statePath, error, blocked)
      return undefined
    }
    blocked = [1, 2, 3, 4, 5].includes(saved?.version) ? undefined : 'saved by a newer Nodo; update the plugin'
    if (blocked !== undefined) return undefined
    legacyState = ['transcriptIndex', 'stats', 'streamDetails'].some(key => Object.hasOwn(saved, key))
    retiredState = ['adapterSessions', 'streamDetails'].some(key => Object.hasOwn(saved, key))
    try {
      const live = JSON.parse(await readFile(activityPath, 'utf8'))
      for (const key of ['transcriptIndex', 'stats', 'streamDetails']) if (isRecord(live[key])) saved[key] = live[key]
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    activitySeen = stamp(activityPath)
    return saved
  }

  const adopt = (saved) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, blank(), saved)
    delete state.workflows
    delete state.revision
    delete state.adapterSessions
    for (const key of SECTIONS) if (!isRecord(state[key])) state[key] = {}
    let invalidStatus = false
    for (const task of Object.values(state.tasks)) {
      if (!Array.isArray(task.acceptances)) task.acceptances = []
      if (!['open', 'review', 'blocked', 'done', 'stopped'].includes(task.status)) {
        task.status = 'blocked'
        invalidStatus = true
      }
    }
    for (const execution of Object.values(state.executions)) {
      if (!Array.isArray(execution.references)) execution.references = []
      if (!['queued', 'running', 'done', 'failed', 'interrupted', 'cancelled', 'unconfirmed'].includes(execution.status)) {
        execution.status = 'unconfirmed'
        invalidStatus = true
      }
    }
    if (invalidStatus) warn('nodo: invalid task or execution status; tasks are blocked and executions are unconfirmed')
    transcripts.reset()
    structureDirty = false
    activityDirty = false
    bootToken = randomUUID()
    struct += 1
    activity += 1
    for (const [id, lines] of Object.entries(state.transcripts)) if (!Array.isArray(lines)) state.transcripts[id] = []
    if (state.version === 1) migrateV1()
    state.version = 5
    for (const profile of Object.values(state.profiles)) {
      if (!rt.listEngines().includes(profile.engine)) continue
      const modes = rt.enginePermissionModes(profile.engine)
      if (!modes.includes(profile.permission)) profile.permission = rt.defaultPermission(profile.engine)
      if (profile.permission === undefined) delete profile.permission
      for (const session of profile.sessions ?? []) {
        if (!modes.includes(session.permission)) delete session.permission
      }
    }
    const choices = [...Object.values(state.prefs.engineConfigs ?? {}),
      ...Object.values(state.profiles).flatMap(profile => [profile, ...(profile.sessions ?? [])])]
    for (const choice of choices) if (choice?.thinking === 'default') delete choice.thinking
  }

  // v1 → v2: profiles carried their working directory as `cwd`; v2 hoists it
  // into top-level workspaces, one per distinct directory, so several roles can
  // share one. A profile without a directory keeps the private one it used to
  // get on first conversation.
  const migrateV1 = () => {
    state.version = 2
    const uniqueName = (base) => {
      const root = (base && base.trim() !== '' ? base : 'workspace').replace(/[/\\]/g, ' ').trim().slice(0, NAME_MAX) || 'workspace'
      let name = root
      for (let n = 2; Object.values(state.workspaces).some(w => normalize(w.name) === normalize(name)); n++) name = `${root.slice(0, NAME_MAX - 3)} ${n}`.slice(0, NAME_MAX)
      return name
    }
    for (const profile of Object.values(state.profiles)) {
      if (profile.workspaceId !== undefined) continue
      const cwd = profile.cwd ?? join(home, 'workspaces', profile.id)
      let workspace = Object.values(state.workspaces).find(w => w.cwd === cwd)
      if (workspace === undefined) {
        workspace = { id: randomUUID(), name: uniqueName(profile.cwd !== undefined ? basename(cwd) : profile.name), cwd, createdAt: Date.now(), updatedAt: Date.now() }
        state.workspaces[workspace.id] = workspace
      }
      profile.workspaceId = workspace.id
      delete profile.cwd
    }
  }

  const restore = async () => {
    await rt.driversReady()
    const saved = await readSaved()
    adopt(saved)
    if (readOnly() === undefined) {
      await rm(join(home, 'runs'), { recursive: true, force: true })
      if (saved && saved.version !== 5) await copyFile(statePath, join(home, `state.v${saved.version}.json`))
      const retired = saved && retiredState
      if (retired) await copyFile(statePath, join(home, 'state.retired.json.bak'))
      if (saved && (saved.version !== 5 || retired || legacyState || Object.hasOwn(saved, 'workflows'))) await save(false, true)
    }
    rt.recoverLeadDelegations?.()
    rt.recoverDecisions?.()
  }

  // A failed load is tried again by the next caller.
  const load = () => loading ??= (async () => {
    if (!takeLock()) warn('nodo: %s', readOnly())
    await restore()
  })().catch((error) => {
    loading = undefined
    throw error
  })

  // Called before each request: a reader takes over once the writer has gone, a
  // writer that lost the lock becomes a reader, and a reader follows file changes.
  const sync = async () => {
    await load()
    const wasWriter = other === undefined
    if (wasWriter && holds()) {
      if (blocked !== undefined && fileVersion() !== seen) await restore()
      return
    }
    if (takeLock()) {
      if (!wasWriter) warn('nodo: the other dsh has closed; this one now saves the Nodo data')
      warnedBlocked = false
      await restore()
      return
    }
    if (wasWriter) warn('nodo: %s', readOnly())
    // A writer turned reader drops what it could not save.
    if (wasWriter || fileVersion() !== seen) await restore()
    else {
      if (stamp(activityPath) !== activitySeen) {
        const live = JSON.parse(await readFile(activityPath, 'utf8'))
        for (const key of ['transcriptIndex', 'stats', 'streamDetails']) if (isRecord(live[key])) state[key] = live[key]
        activitySeen = stamp(activityPath)
        activity += 1
      }
      if (transcripts.follow()) { activity += 1; bootToken = randomUUID() }
    }
  }
  // Concurrent requests share one pass, so none goes on before a takeover has reloaded.
  let refreshing
  const refresh = () => refreshing ??= sync().finally(() => { refreshing = undefined })

  const lockLost = () => failure('Nodo lost the state lock to another dsh', 'ELOCKLOST')
  // False on a host that only reads; throws on one that wrote until it lost the lock.
  const writable = () => {
    if (blocked === undefined && other === undefined) {
      if (holds()) return true
      throw lockLost()
    }
    if (!warnedBlocked) warn('nodo: not saving the Nodo data: %s', readOnly())
    warnedBlocked = true
    return false
  }

  const assertLock = () => {
    if (!unlockable && !lock.owns(true)) throw lockLost()
  }
  const writeLocked = async (path, text) => {
    const temp = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      assertLock()
      await writeFile(temp, text, 'utf8')
      assertLock()
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
  const stamp = path => {
    try { const s = statSync(path); return `${s.size}@${s.mtimeMs}` } catch { return '' }
  }
  const active = id => {
    const work = rt.workView?.()[id]
    return work?.active || work?.starting
  }
  const transcripts = createTranscripts({ home, state, warn, writable: () => readOnly() === undefined,
    assertLock, active, settling: id => rt.settlingAnswer?.(id), changed: () => { activityDirty = true; activity += 1; notifyLive(); return activity } })
  const writeState = async (force) => {
    const structural = structureDirty
    const live = activityDirty
    structureDirty = false
    activityDirty = false
    let failed
    try {
      failed = await transcripts.flush(force)
      for (const id of Object.keys(state.stats)) if (state.transcriptIndex[id] === undefined) delete state.stats[id]
      if (live || structural) {
        await writeLocked(activityPath, JSON.stringify({ transcriptIndex: state.transcriptIndex, stats: state.stats, ...(state.streamDetails ? { streamDetails: state.streamDetails } : {}) }))
        activitySeen = stamp(activityPath)
      }
      if (structural) {
        await writeLocked(statePath, JSON.stringify(state, function (key, value) {
          return this === state && ['transcripts', 'transcriptIndex', 'stats', 'streamDetails'].includes(key) ? undefined : value
        }))
        fileStamp.value = null
        seen = fileVersion()
      }
      lastWrite = Date.now()
    } catch (error) {
      structureDirty ||= structural
      activityDirty ||= live
      warn('nodo: state write failed: %s', error)
      throw error
    }
    if (failed.length) throw failed[0]
  }
  const flush = (force = false) => {
    clearTimeout(timer)
    timer = undefined
    if (force === true) forceAll = true
    else if (typeof force === 'string') forceIds.add(force)
    if (queued === undefined) {
      queued = writing.then(() => {
        queued = undefined
        if (!writable()) return
        const forced = forceAll ? true : new Set(forceIds)
        forceAll = false
        forceIds.clear()
        return writeState(forced)
      })
      writing = queued.catch(() => {})
    }
    return queued
  }
  const save = async (activitySave = false, force = false) => {
    if (stopped || !writable()) return writing
    if (!activitySave) { struct += 1; structureDirty = true }
    activityDirty = true
    notifyLive()
    const running = Object.values(rt.workView?.() ?? {}).some(work => work.active || work.starting)
    if (!force && (activitySave || running)) {
      if (timer === undefined) {
        timer = setTimeout(() => { void flush().catch(() => {}) }, Math.max(0, 1000 - (Date.now() - lastWrite))).unref()
      }
      return writing
    }
    return flush(force)
  }
  const saveStrict = async () => {
    const assertWritable = () => {
      if (stopped) throw failure('Nodo store is closed', 'orch/refused')
      if (!writable()) throw failure(readOnly(), 'orch/read-only')
    }
    assertWritable()
    await save(false, true)
    assertWritable()
  }

  ctx.effect(() => async () => {
    stopped = true
    clearTimeout(timer)
    watching = false
    watcher?.close()
    try {
      await writing
      if (readOnly() === undefined && (structureDirty || activityDirty || Object.values(state.transcripts).some(lines => lines.length))) await flush(true)
    } finally { lock.release() }
  }, 'nodo: state lock')

  Object.assign(rt, { state, load, save, saveStrict, refresh, readOnly,
    saveRuntime: force => { structureDirty = true; return save(true, force) },
    notifyLive, subscribeLive: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    transcriptOf: transcripts.linesOf, appendLine: transcripts.append, touchLine: transcripts.touch,
    transcriptDelta: (id, since) => transcripts.delta(id, since, bootToken, activity),
    transcriptInfo: id => state.transcriptIndex[id] ?? { lines: 0, at: 0 },
    versions: () => ({ struct, activity }) })
}
