// The composer's /-menu for dsh: the skill roots dsh's own skill filesystem
// loads, scanned in rank order so a lower-ranked namesake never wins. An entry
// lists only when the /name gesture would actually fire — dsh ignores a skill
// file without kebab-case name and description frontmatter, rejects the legacy
// invocation keys, and never injects one marked `user-invocable: false`.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { collector, listDirs, listFiles } from '../skills.js'
import { validateDshOptions } from './config.js'
import type { EngineScanOptions } from '../index.js'
import type { SkillInventory } from '../skills.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BOOLEAN: Record<string, boolean> = { true: true, '1': true, yes: true, on: true, false: false, '0': false, no: false, off: false }
const LEGACY = /^(userInvocable|modelInvocable|disableModelInvocation):/m

export async function scanDshCommands({ engineOptions = {}, cwd }: EngineScanOptions = {}): Promise<SkillInventory> {
  validateDshOptions(engineOptions)
  const envHome = process.env.DSH_HOME
  const home = engineOptions.home as string | undefined ?? (envHome?.startsWith('~') ? join(homedir(), envHome.slice(1)) : envHome) ?? join(homedir(), '.dsh')
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  const found = collector()
  const add = (path: string, scope: string) => {
    let head
    try { head = readFileSync(path, 'utf8').slice(0, 4096) } catch { return }
    const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? ''
    const line = (key: string) => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(body)?.[1]?.trim()
    const name = line('name')
    if (!name || !SKILL_NAME.test(name) || !line('description') || LEGACY.test(body)) return
    const flag = line('user-invocable')
    if (flag !== undefined && BOOLEAN[flag.toLowerCase()] !== true) return
    found.add(path, name, undefined, scope)
  }
  const scanRoot = (dir: string, scope: string) => {
    for (const entry of listDirs(dir)) if (basename(entry) !== '.system') add(join(entry, 'SKILL.md'), scope)
    for (const entry of listFiles(dir)) if (entry.endsWith('.md')) add(entry, scope)
  }
  if (cwd) {
    scanRoot(join(cwd, '.dsh', 'skills'), 'project')
    scanRoot(join(cwd, '.agents', 'skills'), 'project')
  }
  // The custom dirs (rank 300) are dsh config the plugin never sets, and the
  // bundled root lives inside the install; both stay unlisted.
  scanRoot(join(home, 'skills'), 'global')
  scanRoot(join(agentsHome, 'skills'), 'global')
  return found.list('DSH skills')
}
