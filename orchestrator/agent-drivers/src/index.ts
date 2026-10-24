// Engine registration owns driver factories and display names.
import { createCodexDriver, codexInfo, validateCodexOptions, checkCodex, scanCodex, scanCodexCommands } from './codex/index.js'
import { createDshDriver, dshInfo, validateDshOptions, checkDsh, findDshExecutable, describeDsh, scanDsh, scanDshCommands } from './dsh/index.js'
import { createZcodeDriver, zcodeInfo, validateZcodeOptions, checkZcode, findZcodeExecutable, scanZcode, scanZcodeCommands } from './zcode/index.js'
import { createClaudeDriver, claudeInfo, validateClaudeOptions, checkClaude, scanClaude, scanClaudeCommands } from './claude/index.js'
import { createQoderDriver, qoderInfo, validateQoderOptions, checkQoder, findQoderExecutable, scanQoder, scanQoderCommands } from './qoder/index.js'
import { createPiDriver, piInfo, validatePiOptions, checkPi, scanPi, scanPiCommands } from './pi/index.js'
import { createOpencodeDriver, opencodeInfo, validateOpencodeOptions, checkOpencode, scanOpencode, scanOpencodeCommands } from './opencode/index.js'
import { createCodebuddyDriver, codebuddyInfo, validateCodebuddyOptions, checkCodebuddy, scanCodebuddy } from './codebuddy/index.js'
import { findExecutable, invalidConfig } from './cli.js'
import { missingPrimitives, OPTIONAL_METHODS, hasOptionalMethod } from './spi.js'
import type { Driver, EngineInfo, PermissionMode } from './spi.js'

export type EngineScanOptions = { engineOptions?: Record<string, unknown>; nativeHost?: unknown; cwd?: string }
export type EngineEntry = {
  name?: string
  shared?: string[]
  tests?: string[]
  create(options: Record<string, unknown>): Driver
  info: EngineInfo
  describe?(nativeHost: unknown): EngineInfo
  validate(raw: Record<string, unknown>): Record<string, unknown>
  check(options: EngineScanOptions): unknown
  findExecutable?(command?: string): string | undefined
  scan?(options: EngineScanOptions): unknown
  commands?(options: EngineScanOptions): unknown
}
export type CatalogModel = { id: string; label?: string; group?: string; defaultThinking?: string; thinking?: { id: string; label?: string }[] }
export type ModelCatalog = { engine: string; source: string; defaultModel?: string; models: CatalogModel[] }
export type CatalogCommand = { id: string; description?: string; path?: string; scope?: 'global' | 'project' | 'plugin'; origin?: string }
export type CommandCatalog = { engine: string; source: string; commands: CatalogCommand[] }
type RawCatalog = { source?: unknown; defaultModel?: unknown; models?: unknown; commands?: unknown }
type RawModel = { id?: unknown; label?: unknown; group?: unknown; defaultThinking?: unknown; thinking?: unknown }
type RawCommand = { id?: unknown; description?: unknown; path?: unknown; origin?: unknown; scope?: unknown }

const ENGINES: Record<string, EngineEntry> = {
  codex: { name: 'Codex', tests: ['engines'], create: createCodexDriver, info: codexInfo, validate: validateCodexOptions, check: checkCodex, scan: scanCodex, commands: scanCodexCommands },
  dsh: { name: 'DeepSeek Harness', shared: ['acp'], create: createDshDriver, info: dshInfo, describe: describeDsh, validate: validateDshOptions, check: checkDsh, findExecutable: findDshExecutable, scan: scanDsh, commands: scanDshCommands },
  claude: { name: 'Claude Code', create: createClaudeDriver, info: claudeInfo, validate: validateClaudeOptions, check: checkClaude, scan: scanClaude, commands: scanClaudeCommands },
  qoder: { name: 'Qoder', create: createQoderDriver, info: qoderInfo, validate: validateQoderOptions, check: checkQoder, findExecutable: findQoderExecutable, scan: scanQoder, commands: scanQoderCommands },
  pi: { name: 'Pi', create: createPiDriver, info: piInfo, validate: validatePiOptions, check: checkPi, scan: scanPi, commands: scanPiCommands },
  zcode: { name: 'ZCode', create: createZcodeDriver, info: zcodeInfo, validate: validateZcodeOptions, check: checkZcode, findExecutable: findZcodeExecutable, scan: scanZcode, commands: scanZcodeCommands },
  opencode: { name: 'OpenCode', shared: ['acp'], create: createOpencodeDriver, info: opencodeInfo, validate: validateOpencodeOptions, check: checkOpencode, scan: scanOpencode, commands: scanOpencodeCommands },
  codebuddy: { name: 'CodeBuddy', shared: ['acp'], create: createCodebuddyDriver, info: codebuddyInfo, validate: validateCodebuddyOptions, check: checkCodebuddy, scan: scanCodebuddy },
}

export function listEngines() {
  return Object.keys(ENGINES).sort()
}

export function engineMetadata() {
  return Object.entries(ENGINES).map(([id, entry]) => ({
    id, name: entry.name ?? entry.info.label,
    shared: [...(entry.shared ?? [])], tests: [...(entry.tests ?? [id])],
  }))
}

// Registration happens at boot, before any listEngines/createDriver call; an
// entry mirrors the ENGINES shape (create/info/validate/check plus optional
// scan/commands/findExecutable/describe).
export function registerEngine(id: string, entry: EngineEntry) {
  ENGINES[id] = entry
}

export function createDriver(engine: string, options: Record<string, unknown> = {}): Driver {
  const entry = ENGINES[engine]
  if (!Object.hasOwn(ENGINES, engine)) {
    throw Object.assign(new Error(`Unknown engine "${engine}"; known: ${listEngines().join(', ')}`), { code: 'driver/unknown-engine' })
  }
  const driver = entry.create(options)
  const missing = missingPrimitives(driver)
  if (missing.length > 0) {
    throw Object.assign(new Error(`Engine "${engine}" lacks SPI primitives: ${missing.join(', ')}`), { code: 'driver/bad-spi' })
  }
  const info = entry.describe?.(options.nativeHost) ?? entry.info
  const offContract = OPTIONAL_METHODS.filter(name => hasOptionalMethod(driver, name) !== (info?.capabilities?.[name] === true))
  if (offContract.length > 0) {
    throw Object.assign(new Error(`Engine "${engine}" capability/implementation mismatch on: ${offContract.join(', ')}`), { code: 'driver/bad-spi' })
  }
  return driver
}

export { probeSpawn } from './probe.js'
export { createIdentityFiles } from './identity-files.js'
export { PRIMITIVES, STEER, DECISION, missingPrimitives, OPTIONAL_METHODS, hasOptionalMethod } from './spi.js'
export { createCodexDriver } from './codex/index.js'
export { createDshDriver } from './dsh/index.js'
export { createZcodeDriver } from './zcode/index.js'
export { createClaudeDriver } from './claude/index.js'
export { createQoderDriver } from './qoder/index.js'
export { createPiDriver } from './pi/index.js'
export { createOpencodeDriver } from './opencode/index.js'
export { createCodebuddyDriver } from './codebuddy/index.js'

export function engineCatalog(nativeHost?: unknown): (EngineInfo & { executable: string | null })[] {
  return listEngines().map(id => {
    const info = ENGINES[id].describe?.(nativeHost) ?? ENGINES[id].info
    return { ...JSON.parse(JSON.stringify(info)) as EngineInfo, executable: info.command ? (ENGINES[id].findExecutable ?? findExecutable)(info.command) ?? null : null }
  })
}

export function validateEngineOptions(engine: string, raw: unknown = {}) {
  if (!Object.hasOwn(ENGINES, engine)) throw invalidConfig(`Unknown engine: ${engine}`)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalidConfig('engineOptions must be an object')
  const clean = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  if (JSON.stringify(clean).length > 4000) throw invalidConfig('engineOptions too large (4 kB at most)')
  return ENGINES[engine].validate(clean)
}

export function requiresWorkspace(engine: string) { return ENGINES[engine]?.info.requiresCwd === true }

// The autonomy tiers an engine actually offers (see spi.js `permission`); an
// undeclared engine keeps only the default tier.
export function enginePermissionModes(engine: string, nativeHost?: unknown): PermissionMode[] {
  if (!Object.hasOwn(ENGINES, engine)) throw invalidConfig(`Unknown engine: ${engine}`)
  const info = ENGINES[engine].describe?.(nativeHost) ?? ENGINES[engine].info
  const modes = info?.capabilities?.permissionModes
  return Array.isArray(modes) ? [...modes] : ['workspace']
}

export async function checkEngine(config: EngineScanOptions & { engine: string }) {
  const entry = ENGINES[config.engine]
  if (!Object.hasOwn(ENGINES, config.engine)) throw invalidConfig(`Unknown engine: ${config.engine}`)
  return entry.check({ ...config, engineOptions: validateEngineOptions(config.engine, config.engineOptions) })
}

// Model discovery: the models an engine can be told to use, each with the
// thinking levels (reasoning effort, thought level) it accepts. A driver gets
// these from its own protocol when it can and falls back to the CLI's local
// configuration file; `source` says which one answered, so the UI can be honest.
// `models` may be empty: the caller then keeps a free-text model field.
const text = (value: unknown, max = 200) => (typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\r\n\0]/.test(value) ? value.trim() : undefined)
const MODEL_MAX = 200
const MODELS_MAX = 300
const THINKING_MAX = 40

function cleanCatalog(engine: string, raw: unknown): ModelCatalog {
  const models = (Array.isArray((raw as RawCatalog)?.models) ? (raw as RawCatalog).models as RawModel[] : []).slice(0, MODELS_MAX).flatMap((model) => {
    const id = text(model?.id, MODEL_MAX)
    if (id === undefined) return []
    const label = text(model?.label, 160)
    const group = text(model?.group, 80)
    const defaultThinking = text(model?.defaultThinking, 60)
    const thinking = (Array.isArray(model?.thinking) ? model.thinking as { id?: unknown; label?: unknown }[] : []).slice(0, THINKING_MAX).flatMap((level) => {
      const levelId = text(level?.id, 60)
      if (levelId === undefined) return []
      const levelLabel = text(level?.label, 120)
      return [{ id: levelId, ...(levelLabel ? { label: levelLabel } : {}) }]
    })
    return [{ id, ...(label ? { label } : {}), ...(group ? { group } : {}), ...(defaultThinking ? { defaultThinking } : {}), ...(thinking.length ? { thinking } : {}) }]
  })
  const source = text((raw as RawCatalog)?.source, 200)
  const defaultModel = text((raw as RawCatalog)?.defaultModel, MODEL_MAX)
  return { engine, source: source ?? 'unknown', ...(defaultModel ? { defaultModel } : {}), models }
}

export async function scanEngine(engine: string, { engineOptions = {}, nativeHost, cwd }: EngineScanOptions = {}): Promise<ModelCatalog> {
  const entry = ENGINES[engine]
  if (!Object.hasOwn(ENGINES, engine)) throw invalidConfig(`Unknown engine: ${engine}`)
  const options = validateEngineOptions(engine, engineOptions)
  if (typeof entry.scan !== 'function') return { engine, source: 'unsupported', models: [] }
  return cleanCatalog(engine, await entry.scan({ engineOptions: options, nativeHost, cwd }))
}

// The composer's /-menu: the commands an engine would resolve from a slash line,
// scanned like the model catalog. An engine without a scannable source answers
// 'unsupported' instead of an empty list posing as the truth. A driver whose
// protocol reports the agent's own slash commands (ACP's available_commands)
// implements commands() by merging that native list in as-is — passthrough,
// never dressed up as scanned files.
function cleanCommands(engine: string, raw: unknown): CommandCatalog {
  const commands = (Array.isArray((raw as RawCatalog)?.commands) ? (raw as RawCatalog).commands as RawCommand[] : []).slice(0, 200).flatMap(command => {
    const id = text(command?.id, 200)
    if (id === undefined) return []
    const description = text(command?.description, 200)
    const path = text(command?.path, 512)
    const origin = text(command?.origin, 100)
    const scope = (['global', 'project', 'plugin'] as readonly unknown[]).includes(command?.scope) ? command.scope as CatalogCommand['scope'] : undefined
    return [{ id, ...(description ? { description } : {}), ...(path ? { path } : {}), ...(scope ? { scope } : {}), ...(origin ? { origin } : {}) }]
  })
  return { engine, source: text((raw as RawCatalog)?.source, 200) ?? 'unknown', commands }
}

export async function scanEngineCommands(engine: string, { engineOptions = {}, nativeHost, cwd }: EngineScanOptions = {}): Promise<CommandCatalog> {
  const entry = ENGINES[engine]
  if (!Object.hasOwn(ENGINES, engine)) throw invalidConfig(`Unknown engine: ${engine}`)
  const options = validateEngineOptions(engine, engineOptions)
  if (typeof entry.commands !== 'function') return { engine, source: 'unsupported', commands: [] }
  return cleanCommands(engine, await entry.commands({ engineOptions: options, nativeHost, cwd }))
}
