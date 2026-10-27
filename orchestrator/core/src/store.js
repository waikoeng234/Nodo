// state.json under the plugin home. Only the host holding state.lock (home-lock.js)
// writes it; another dsh on the same home follows the file read-only and takes over
// once the lock frees. Writes go through a temp file and are serialized.
import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { NAME_MAX, TRANSCRIPT_MAX } from './constants.js'
import { normalize } from './text.js'
import { homeLock } from './home-lock.js'
import { ensureFallback } from './profiles.js'

const SECTIONS = ['workspaces', 'profiles', 'transcripts', 'stats', 'workflows', 'engineCatalogs', 'prefs']
const blank = () => ({ version: 2, workspaces: {}, profiles: {}, transcripts: {}, stats: {}, workflows: {}, engineCatalogs: {}, prefs: {}, probe: null, revision: 0 })
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function install(rt) {
  const { ctx, home, warn } = rt
  const statePath = join(home, 'state.json')

  /** @type {ReturnType<typeof blank>} */
  const state = blank()
  const lock = homeLock(join(home, 'state.lock'))
  let loading
  let writing = Promise.resolve()
  let queued
  let stopped = false
  // The lock record of the dsh that writes while this one reads.
  let other
  // The lock could not be used (odd file system): write without it, trying it again before each write.
  let unlockable = false
  // Why state.json could not be read; nothing is written while it is set.
  let blocked
  let warnedBlocked = false
  let seen = ''

  const fileVersion = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${size}@${mtimeMs}`
    } catch {
      return ''
    }
  }

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
    blocked = saved?.version === 1 || saved?.version === 2 ? undefined : 'saved by a newer Nodo; update the plugin'
    return blocked === undefined ? saved : undefined
  }

  const adopt = (saved) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, blank(), saved)
    for (const key of SECTIONS) if (!isRecord(state[key])) state[key] = {}
    for (const [id, lines] of Object.entries(state.transcripts)) if (!Array.isArray(lines)) state.transcripts[id] = []
    if (state.version === 1) migrateV1()
    ensureFallback(state.profiles)
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

  const restore = async () => adopt(await readSaved())

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
      // Runs the other dsh left unfinished are this one's to recover now.
      rt.forgetRuns()
      return rt.recoverRuns()
    }
    if (wasWriter) warn('nodo: %s', readOnly())
    // A writer turned reader drops what it could not save.
    if (wasWriter || fileVersion() !== seen) await restore()
  }
  // Concurrent requests share one pass, so none goes on before a takeover has reloaded.
  let refreshing
  const refresh = () => refreshing ??= sync().finally(() => { refreshing = undefined })

  const lockLost = () => Object.assign(new Error('Nodo lost the state lock to another dsh'), { code: 'ELOCKLOST' })
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
    if (!unlockable && !lock.owns()) throw lockLost()
  }
  const writeState = async (text) => {
    const temp = `${statePath}.${randomUUID()}.tmp`
    await mkdir(home, { recursive: true })
    try {
      assertLock()
      await writeFile(temp, text, 'utf8')
      assertLock()
      await rename(temp, statePath)
      seen = fileVersion()
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  // A reader keeps the revision it read, so its window still sees the writer's next change.
  const save = async () => {
    if (stopped || !writable()) return writing
    state.revision += 1
    for (const [id, lines] of Object.entries(state.transcripts)) if (lines.length > TRANSCRIPT_MAX) state.transcripts[id] = lines.slice(-TRANSCRIPT_MAX)
    // Statistics of a dropped conversation would never be shown again.
    for (const id of Object.keys(state.stats)) if (state.transcripts[id] === undefined) delete state.stats[id]
    // Saves made before the next write starts share it: the state is serialized when it starts.
    if (queued === undefined) {
      queued = writing.then(() => {
        queued = undefined
        return writeState(JSON.stringify(state, null, 2))
      }).catch((error) => {
        warn('nodo: state write failed: %s', error)
        throw error
      })
      writing = queued.catch(() => {})
    }
    return queued
  }

  ctx.effect(() => async () => {
    stopped = true
    await writing
    lock.release()
  }, 'nodo: state lock')

  // Transcript helpers: every profile's conversation lives in state.transcripts.
  const transcriptOf = (profileId) => (state.transcripts[profileId] ??= [])
  const appendLine = (profileId, line) => {
    const lines = transcriptOf(profileId)
    lines.push({ at: Date.now(), ...line })
    if (lines.length > TRANSCRIPT_MAX) state.transcripts[profileId] = lines.slice(-TRANSCRIPT_MAX)
    return state.transcripts[profileId].at(-1)
  }

  Object.assign(rt, { state, load, save, refresh, readOnly, transcriptOf, appendLine })
}
