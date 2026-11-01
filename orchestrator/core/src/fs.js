// State, secrets and tool details go through a same-directory temp file so a
// crash mid-write never leaves a half-written JSON behind.
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function atomicWrite(path, text, mode) {
  const temp = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
