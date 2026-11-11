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
// a catalog of its own: the same live catalog, its entry switched to code mode
// with the agent tools off, written next to the profile's other files.
export async function writeLeaderCatalog({ executable, model, dir, env }: { executable: string; model: string; dir: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const launch = launchCommand(executable, ['debug', 'models'])
  let raw: string
  try {
    raw = (await execute(launch.bin, launch.args, { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) })).stdout
  } catch (error) {
    // execFile puts the CLI's stderr in the message; only its exit code is safe
    // to show, the same reason json-rpc-process keeps stderr out of errors.
    const code = (error as { code?: unknown }).code
    throw leadUnavailable(`Codex model catalog could not be read (${typeof code === 'string' ? code : typeof code === 'number' ? `exit ${code}` : 'unavailable'}). Leaders need it to remove the built-in execution tools.`)
  }
  let catalog: Catalog
  try { catalog = JSON.parse(raw) as Catalog } catch { throw leadUnavailable('Codex model catalog was not JSON. Leaders need it to remove the built-in execution tools.') }
  const models = Array.isArray(catalog?.models) ? catalog.models as CatalogModel[] : []
  if (models.length === 0) throw leadUnavailable('Codex model catalog was empty. Leaders need it to remove the built-in execution tools.')
  const target = models.find(entry => entry?.slug === model)
  if (target === undefined) throw leadUnavailable(`Codex model catalog has no entry for "${model}". Leaders need it to remove the built-in execution tools.`)
  // Both fields decide the leader's tool surface. A renamed field would only
  // add a key the CLI ignores, silently keeping `exec` and collaboration.
  if (!Object.hasOwn(target, 'tool_mode') || !Object.hasOwn(target, 'multi_agent_version')) {
    throw leadUnavailable(`The Codex model catalog entry "${model}" lost tool_mode or multi_agent_version. Leaders cannot remove the built-in execution tools without them.`)
  }
  // `direct` looks closer to routing-only, but on 0.167.0 its MCP tool
  // declarations answer every call with `unsupported call`; code mode keeps
  // the exec sandbox, the only path on which MCP tools actually dispatch.
  target.tool_mode = 'code_mode'
  target.multi_agent_version = 'disabled'
  const path = join(dir, CATALOG_FILE)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 })
  renameSync(temporary, path)
  return path
}
