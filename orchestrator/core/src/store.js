// state.json under the plugin home, with each conversation's transcript in
// transcripts/<id>.json. Only the host holding state.lock (home-lock.js) writes
// them; another dsh on the same home follows the files read-only and takes over
// once the lock frees. Writes go through a temp file and are serialized.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { NAME_MAX, TRANSCRIPT_MAX } from './constants.js'
import { normalize } from './text.js'
import { failure } from './errors.js'
import { homeLock } from './home-lock.js'

const SECTIONS = ['workspaces', 'profiles', 'transcripts', 'transcriptIndex', 'stats', 'engineCatalogs', 'prefs']
// `transcripts` holds only the transcripts loaded in memory and is not saved in state.json.
const blank = () => ({ version: 3, workspaces: {}, profiles: {}, transcripts: {}, transcriptIndex: {}, stats: {}, engineCatalogs: {}, prefs: {}, probe: null, revision: 0 })
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function install(rt) {
  const { ctx, home, warn } = rt
  const statePath = join(home, 'state.json')
  const transcriptPath = id => join(home, 'transcripts', `${encodeURIComponent(id)}.json`)
  // Transcript text as last read or written, and the transcripts this host appended to:
  // lines handed out by appendLine may still change, so those stay loaded.
  const written = new Map()
  const held = new Set()

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
    blocked = [1, 2, 3].includes(saved?.version) ? undefined : 'saved by a newer Nodo; update the plugin'
    return blocked === undefined ? saved : undefined
  }

  const adopt = (saved) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, blank(), saved)
    delete state.workflows
    for (const key of SECTIONS) if (!isRecord(state[key])) state[key] = {}
    written.clear()
    held.clear()
    for (const [id, lines] of Object.entries(state.transcripts)) if (!Array.isArray(lines)) state.transcripts[id] = []
    if (state.version === 1) migrateV1()
    state.version = 3
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
      if (saved && saved.version !== 3) await copyFile(statePath, join(home, `state.v${saved.version}.json`))
      if (saved && (saved.version !== 3 || Object.hasOwn(saved, 'workflows'))) await save()
    }
    rt.recoverLeadDelegations?.()
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
    if (!unlockable && !lock.owns()) throw lockLost()
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
  const indexOf = lines => ({ lines: lines.length, at: lines.at(-1)?.at ?? 0 })
  // Changed transcripts are written before state.json, so its index never points past
  // them; transcripts loaded only for reading are then dropped from memory.
  const writeState = async (stateText, loaded) => {
    for (const [id, , text] of loaded) {
      if (written.get(id) === text) continue
      await writeLocked(transcriptPath(id), text)
      written.set(id, text)
    }
    await writeLocked(statePath, stateText)
    seen = fileVersion()
    for (const [id, value] of loaded) {
      if (held.has(id) || state.transcripts[id] !== value) continue
      delete state.transcripts[id]
      written.delete(id)
    }
  }

  // A reader keeps the revision it read, so its window still sees the writer's next change.
  const save = async () => {
    if (stopped || !writable()) return writing
    state.revision += 1
    // Saves made before the next write starts share it: the state is serialized when it starts.
    if (queued === undefined) {
      queued = writing.then(() => {
        queued = undefined
        for (const [id, lines] of Object.entries(state.transcripts)) {
          if (lines.length > TRANSCRIPT_MAX) state.transcripts[id] = lines.slice(-TRANSCRIPT_MAX)
          state.transcriptIndex[id] = indexOf(state.transcripts[id])
        }
        // Statistics of a dropped conversation would never be shown again.
        for (const id of Object.keys(state.stats)) if (state.transcriptIndex[id] === undefined) delete state.stats[id]
        const loaded = Object.entries(state.transcripts).map(([id, lines]) => [id, lines, JSON.stringify(lines)])
        return writeState(JSON.stringify(state, function (key, value) { return this === state && key === 'transcripts' ? undefined : value }, 2), loaded)
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

  // A conversation's transcript, loaded into state.transcripts on first use. An
  // unreadable file is moved aside so the next write does not replace it.
  const transcriptOf = (id) => {
    if (state.transcripts[id] !== undefined) return state.transcripts[id]
    const path = transcriptPath(id)
    let lines = []
    try {
      const text = readFileSync(path, 'utf8')
      lines = JSON.parse(text)
      if (!Array.isArray(lines)) throw new TypeError('not a list')
      written.set(id, text)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        lines = []
        warn('nodo: unreadable transcript %s: %s', path, error)
        if (readOnly() === undefined) try { renameSync(path, `${path}.broken-${Date.now()}`) } catch {}
      }
    }
    return (state.transcripts[id] = lines)
  }
  const appendLine = (id, line) => {
    const lines = transcriptOf(id)
    held.add(id)
    lines.push({ at: Date.now(), ...line })
    if (lines.length > TRANSCRIPT_MAX) state.transcripts[id] = lines.slice(-TRANSCRIPT_MAX)
    return state.transcripts[id].at(-1)
  }
  // Line count and last line time without loading the transcript.
  const transcriptInfo = (id) => state.transcripts[id] !== undefined ? indexOf(state.transcripts[id]) : state.transcriptIndex[id] ?? { lines: 0, at: 0 }

  Object.assign(rt, { state, load, save, refresh, readOnly, transcriptOf, appendLine, transcriptInfo })
}
