import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type IdentityBinding = { version: string; path: string }
export interface IdentityFiles {
  bind(owner: unknown, instructions: unknown): IdentityBinding
  collect(owners: Iterable<string>): void
}

export function createIdentityFiles(root: string): IdentityFiles {
  const references = join(root, 'references')
  const versions = join(root, 'versions')
  const reference = (owner: string) => join(references, `${encodeURIComponent(owner)}.json`)
  const prepare = () => {
    for (const path of [root, references, versions]) mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return {
    bind(owner, instructions) {
      if (typeof owner !== 'string' || !owner || typeof instructions !== 'string' || !instructions) throw new Error('Identity requires an owner and nonempty instructions')
      prepare()
      const version = createHash('sha256').update(instructions).digest('hex')
      const directory = join(versions, version)
      const path = join(directory, 'AGENTS.md')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!existsSync(path)) {
        const temporary = join(directory, `${randomUUID()}.tmp`)
        try {
          writeFileSync(temporary, instructions, { mode: 0o444, flag: 'wx' })
          try { linkSync(temporary, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      }
      if (readFileSync(path, 'utf8') !== instructions) throw new Error('Stored identity content does not match its version')
      const temporary = join(references, `${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, JSON.stringify({ version }), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, reference(owner))
      } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      return { version, path }
    },
    collect(owners) {
      if (!existsSync(references)) return
      const retained = new Set(owners)
      const used = new Set<unknown>()
      for (const file of readdirSync(references)) {
        if (!file.endsWith('.json')) continue
        const path = join(references, file)
        if (!retained.has(decodeURIComponent(file.slice(0, -5)))) { unlinkSync(path); continue }
        used.add((JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version)
      }
      for (const version of readdirSync(versions)) if (/^[a-f0-9]{64}$/.test(version) && !used.has(version)) rmSync(join(versions, version), { recursive: true, force: true })
    },
  }
}
