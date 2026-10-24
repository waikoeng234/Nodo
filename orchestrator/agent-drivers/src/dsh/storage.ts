import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'

const PREFIX = 'dsh:isolated:'

export function dshStorage(storageDir?: string, driverSessionId?: string) {
  const isolated = driverSessionId?.startsWith(PREFIX)
  if (isolated && !storageDir) throw new Error('DSH isolated session requires its agent storage directory')
  const sessionId = isolated ? driverSessionId!.slice(PREFIX.length) : driverSessionId
  // Existing unprefixed sessions retain their original location.
  if (!storageDir || (driverSessionId && !isolated)) return { sessionId, savedId: (id: string) => id }
  if (!isAbsolute(storageDir)) throw new Error('DSH agent storage directory must be absolute')
  const dir = join(storageDir, 'dsh')
  mkdirSync(dir, { recursive: true })
  const patch = join(dir, 'sessions.patch.json')
  writeFileSync(patch, JSON.stringify([{ id: 'session-persistence-jsonl', config: { root: join(dir, 'sessions') } }]))
  return { sessionId, patch, savedId: (id: string) => PREFIX + id }
}

export function dshInstructionsPatch(directory?: string, patch?: string, instructions?: string): { patch?: string; instructionMode: 'none' | 'native'; dispose(): void } {
  // personaPrefix is a strict template; literal template examples run without identity.
  if (!instructions || instructions.includes('{{')) return { patch, instructionMode: 'none', dispose() {} }
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(directory ?? tmpdir(), 'orch-dsh-instructions-'))
  try {
    const entries: unknown[] = patch ? JSON.parse(readFileSync(patch, 'utf8')) : []
    entries.push({ id: 'system-prompt', config: { personaPrefix: instructions } })
    const path = join(dir, 'instructions.patch.json')
    writeFileSync(path, JSON.stringify(entries), { mode: 0o600 })
    return { patch: path, instructionMode: 'native', dispose() { rmSync(dir, { recursive: true, force: true }) } }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}
