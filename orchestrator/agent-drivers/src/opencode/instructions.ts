import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidConfig } from '../cli.js'
import type { IdentityFiles } from '../identity-files.js'

export type OpencodeInstructionResult = { env: NodeJS.ProcessEnv; mode: 'none' | 'native'; dispose(): void }
type OpencodeAgent = { prompt?: unknown } | null | undefined

export function opencodeInstructions(instructions?: string, env: NodeJS.ProcessEnv = {}, directory?: string, identityFiles?: IdentityFiles, identityOwner?: string): OpencodeInstructionResult {
  if (!instructions) return { env, mode: 'none', dispose() {} }
  let config: unknown
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}') }
  catch { throw invalidConfig('OpenCode inline configuration must be valid JSON') }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(config) || (config.agent !== undefined && !object(config.agent))) throw invalidConfig('Invalid OpenCode inline configuration')
  const agent = { ...config.agent }
  for (const mode of ['build', 'plan']) {
    const previous = agent[mode] ?? {}
    if (!object(previous) || (previous.prompt !== undefined && typeof previous.prompt !== 'string')) throw invalidConfig('Invalid OpenCode agent prompt configuration')
  }
  let dir: string | undefined
  let path: string
  if (identityFiles) path = identityFiles.bind(identityOwner, instructions).path
  else {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 })
    dir = mkdtempSync(join(directory ?? tmpdir(), 'nodo-opencode-instructions-'))
    path = join(dir, 'role.md')
    try { writeFileSync(path, instructions, { mode: 0o600 }) }
    catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
  }
  // File contents are inserted after configuration interpolation, keeping role
  // text such as {env:...} and {file:...} literal.
  for (const mode of ['build', 'plan']) agent[mode] = { ...agent[mode] as OpencodeAgent, prompt: [(agent[mode] as OpencodeAgent)?.prompt, `{file:${path}}`].filter(Boolean).join('\n\n') }
  return {
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, agent }) },
    mode: 'native',
    dispose() { if (dir) rmSync(dir, { recursive: true, force: true }) },
  }
}
