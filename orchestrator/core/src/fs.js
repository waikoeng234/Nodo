// State, secrets and tool details go through a same-directory temp file so a
// crash mid-write never leaves a half-written JSON behind.
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'

export const inside = (base, path) => {
  const rest = relative(base, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

export const stamp = path => {
  try { const s = statSync(path); return `${s.size}@${s.mtimeMs}` } catch { return '' }
}

export async function atomicWrite(path, text, mode, guard) {
  const temp = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    guard?.()
    await writeFile(temp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) })
    guard?.()
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
