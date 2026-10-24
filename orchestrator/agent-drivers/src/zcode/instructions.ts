import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createIdentityFiles } from '../identity-files.js'
import type { IdentityBinding, IdentityFiles } from '../identity-files.js'

export type ZcodeIdentity = {
  env: NodeJS.ProcessEnv; mode: 'none' | 'native'; target?: 'tool-schema'; reason?: string
  path?: string; version?: string; toolIdentity?: boolean; readyFile?: string
  reset?(): void; install?(timeout?: number): Promise<void>; dispose(): void
}
type ActiveIdentity = ZcodeIdentity & IdentityBinding & { readyFile: string; toolIdentity: boolean }
type InstructionOptions = {
  instructions?: string; env?: NodeJS.ProcessEnv; version?: string; directory?: string
  cwd?: string; identityFiles?: IdentityFiles; identityOwner?: string
}

// CLI versions whose tool-schema identity delivery scripts/check-zcode-identity.mjs confirmed.
const toolIdentityVersions = ['0.16.9', '0.17.0']

export function zcodeInstructions({ instructions, env = {}, version, directory, identityFiles, identityOwner = 'session' }: InstructionOptions = {}): ZcodeIdentity {
  if (!instructions) return { env, mode: 'none', dispose() {} }
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(directory ?? tmpdir(), 'nodo-zcode-instructions-'))
  let disposed = false
  try {
    const files = identityFiles ?? createIdentityFiles(join(root, 'identities'))
    const artifact = files.bind(identityOwner, instructions)
    const toolIdentity = toolIdentityVersions.includes(version as string)
    return {
      env, ...artifact, toolIdentity,
      readyFile: join(root, 'catalog.json'), mode: 'none', reason: toolIdentity ? 'catalog-not-discovered' : 'unverified-version',
      reset(this: ActiveIdentity) {
        rmSync(this.readyFile, { force: true })
        this.readyFile = join(root, `${randomUUID()}.json`)
        this.mode = 'none'; this.target = undefined
        this.reason = this.toolIdentity ? 'catalog-not-discovered' : 'unverified-version'
      },
      async install(this: ActiveIdentity, timeout = 5000) {
        if (!this.toolIdentity) return
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          if (disposed) throw new Error('ZCode identity disposed during setup')
          try {
            if ((JSON.parse(readFileSync(this.readyFile, 'utf8')) as { version?: unknown }).version !== artifact.version) throw new Error('Role tool catalog has a different identity version')
            this.mode = 'native'; this.target = 'tool-schema'
            this.reason = undefined
            return
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      },
      dispose() { disposed = true; rmSync(root, { recursive: true, force: true }) },
    }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
}
