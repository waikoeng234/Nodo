import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidConfig } from '../cli.js'

export function opencodeInstructions(instructions, env = {}, directory, identityFiles, identityOwner) {
  if (!instructions) return { env, mode: 'none', dispose() {} }
  let config
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}') }
  catch { throw invalidConfig('OpenCode inline configuration must be valid JSON') }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(config) || (config.agent !== undefined && !object(config.agent))) throw invalidConfig('Invalid OpenCode inline configuration')
  const agent = { ...config.agent }
  for (const mode of ['build', 'plan']) {
    const previous = agent[mode] ?? {}
    if (!object(previous) || (previous.prompt !== undefined && typeof previous.prompt !== 'string')) throw invalidConfig('Invalid OpenCode agent prompt configuration')
  }
  let dir
  let path
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
  for (const mode of ['build', 'plan']) agent[mode] = { ...agent[mode], prompt: [agent[mode]?.prompt, `{file:${path}}`].filter(Boolean).join('\n\n') }
  return {
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, agent }) },
    mode: 'native',
    dispose() { if (dir) rmSync(dir, { recursive: true, force: true }) },
  }
}
