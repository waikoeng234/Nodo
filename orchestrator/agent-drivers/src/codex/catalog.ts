import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchCommand } from '../cli.js'

const execute = promisify(execFile)

export type CatalogModel = Record<string, unknown>
export type Catalog = { models?: unknown }
export const CATALOG_FILE = 'codex-leader-catalog.json'

export const leadUnavailable = (message: string) => Object.assign(new Error(message), { code: 'orch/lead-unavailable' })

// The app-server loads the model catalog once at process start and only from
// process-level config. Its per-model `tool_mode`/`multi_agent_version` decide
// whether `exec` and the collaboration tools reach the model, so a leader gets
// a catalog of its own: the same live catalog, one entry switched to direct
// tool calling, written next to the profile's other files.
export async function writeLeaderCatalog({ executable, model, dir, env }: { executable: string; model: string; dir: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const launch = launchCommand(executable, ['debug', 'models'])
  let raw: string
  try {
    raw = (await execute(launch.bin, launch.args, { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) })).stdout
  } catch (error) {
    throw leadUnavailable(`Codex model catalog could not be read (${(error as Error).message}). Leaders need it to remove the built-in execution tools.`)
  }
  let catalog: Catalog
  try { catalog = JSON.parse(raw) as Catalog } catch { throw leadUnavailable('Codex model catalog was not JSON. Leaders need it to remove the built-in execution tools.') }
  const models = Array.isArray(catalog?.models) ? catalog.models as CatalogModel[] : []
  if (models.length === 0) throw leadUnavailable('Codex model catalog was empty. Leaders need it to remove the built-in execution tools.')
  const target = models.find(entry => entry?.slug === model)
  if (target === undefined) throw leadUnavailable(`Codex model catalog has no entry for "${model}". Leaders need it to remove the built-in execution tools.`)
  target.tool_mode = 'direct'
  target.multi_agent_version = 'disabled'
  const path = join(dir, CATALOG_FILE)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 })
  renameSync(temporary, path)
  return path
}
