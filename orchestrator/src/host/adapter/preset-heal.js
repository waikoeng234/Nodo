// A native session stores the agent preset it was created with, and resumes
// strictly through that id. Deleting a role unregisters its preset (registry.js
// dropAdapterProfile), so the session keeps a dangling id: the host mode picker
// then answers "Unknown agent preset" from the resume path, and that session is
// stuck for good. Healing rewrites such a session onto a preset that exists,
// which is what removes the dangling id for every later resume.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const SESSION_LOG = 'session.v4.jsonl.zstd' // the log name the host writes; every version of it is a complete log
const RESCUE_DESCRIPTION = 'Deleted Nodo role: history only'

export async function listSessionLogs(root) {
  const found = []
  const walk = async dir => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === SESSION_LOG) found.push(path)
    }
  }
  await walk(root)
  return found
}

// Only the header is needed, and the Zstandard frame carries it in its first
// block, so a truncated read still yields the first line.
export async function readSessionHeader(path) {
  const buffered = await readFile(path).catch(() => undefined)
  if (buffered === undefined) return undefined
  let text
  try { text = zstdDecompressSync(buffered).toString('utf8') } catch {
    try { text = zstdDecompressSync(buffered.subarray(0, 8192)).toString('utf8') } catch { return undefined }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { return JSON.parse(line) } catch { return undefined }
  }
  return undefined
}

// The dangling ids, each with the native sessions that carry it. Only Nodo ids
// qualify: the host registers its own presets itself, and a Nodo role preset is
// the one fallback that would rebuild the same trap.
export async function findOrphanedPresets({ listing, isRegistered }) {
  const found = new Map()
  for (const path of await listing()) {
    const header = await readSessionHeader(path)
    const id = typeof header?.agentPreset === 'string' ? header.agentPreset : undefined
    if (!id?.startsWith('nodo:') || typeof header?.id !== 'string') continue
    if (await isRegistered(id)) continue
    const sessions = found.get(id) ?? []
    if (!sessions.includes(header.id)) found.set(id, [...sessions, header.id])
  }
  return [...found].map(([id, sessions]) => ({ id, sessions }))
}

// The rescue definition claims the dangling id, because the host cannot resume
// an unknown preset at all; it mounts nothing, and the switch below is what the
// session keeps. A session whose first turn already ran cannot change preset —
// that one keeps working and heals on its next cold resume.
export async function healPreset({ id, sessions, fallback, agentPresets, sessionController, warn }) {
  let drop
  try {
    drop = await agentPresets.register({ id, name: id, description: RESCUE_DESCRIPTION, plugins: [] })
    let healed = 0
    let refusal
    for (const sessionId of sessions) {
      const { agent, error } = await sessionController.resolveAgent(sessionId)
      if (error) { refusal = error.message; continue }
      try {
        await agentPresets.select(agent, fallback)
        healed += 1
      } catch (error) {
        refusal = error?.message ?? String(error)
      }
    }
    if (refusal) warn?.('nodo: kept %d of %d native session(s) on the deleted role preset "%s" until their next cold resume: %s', sessions.length - healed, sessions.length, id, refusal)
    return { healed, refused: sessions.length - healed }
  } catch (error) {
    warn?.('nodo: cannot heal native sessions on the deleted role preset "%s": %s', id, error?.message ?? error)
    return { healed: 0, refused: sessions.length, failed: true }
  } finally {
    await drop?.().catch(() => {})
  }
}
