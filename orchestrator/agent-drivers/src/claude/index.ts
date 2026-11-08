import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STEER, addUsage, isTodoTool, promptTokensOf, todoPlanSteps, usageOf } from '../spi.js'
import { checkCliBase, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import { collector } from '../skills.js'
import { createCoverage, DECLARED } from '../coverage.js'
import { claudeArgs, connectClaude, leadMcpEnv } from './native.js'
import { askAnswers, askOpened } from '../questions.js'
import { createFileChanges } from '../file-changes.js'
import { claudeFileChanges } from './file-changes.js'
import type { ClaudeConnection } from './native.js'
import type { Driver, DriverEvent, DriverResponse, EngineCheckResult, EngineCommandInventory, EngineInfo, PermissionMode, Usage } from '../spi.js'
import type { Coverage } from '../coverage.js'
import type { FileChanges } from '../file-changes.js'
import type { EngineScanOptions, ModelCatalog } from '../index.js'
import type { McpMount } from '../role-mcp.js'

export type ClaudeOptions = { bin?: string }
export type ClaudeDriverOptions = {
  onEvent?: (event: DriverEvent) => void; bin?: string; cwd?: string; env?: NodeJS.ProcessEnv
  model?: string; thinking?: string; permission?: PermissionMode; driverSessionId?: string; instructions?: string
  leadMcpServers?: McpMount[]
}
type ClaudeHandshakeOptions = { executable: string; cwd?: string; env?: NodeJS.ProcessEnv }
type ClaudeModel = { value?: unknown; displayName?: unknown; supportedEffortLevels?: unknown[] }
type ClaudeCommand = { name?: unknown; description?: unknown }
type ClaudeInitialize = { models?: ClaudeModel[]; commands?: ClaudeCommand[] }
type ClaudeHandshake = { peer: ClaudeConnection; models: ClaudeModel[]; commands: ClaudeCommand[] }
type ClaudeUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown }
type ClaudeModelUsage = { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheCreationInputTokens?: unknown; contextWindow?: number }
type ClaudeQuestion = { question: string; header: string; options?: unknown; multiSelect?: unknown }
type ClaudeInput = { questions?: ClaudeQuestion[]; description?: string; command?: string }
type ClaudeToolUse = { type: 'tool_use'; id: string; name?: string; input?: unknown }
type ClaudeContent = ClaudeToolUse
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'text'; text: string } | { type: 'thinking'; thinking: string }
type ClaudeRequestBody = { subtype: string; tool_name: string; input?: ClaudeInput; description?: string; display_name?: string }
type ClaudeRequest = { type: 'control_request'; request_id: string; request?: ClaudeRequestBody }
type ClaudeDelta = { type: 'text_delta'; text?: string } | { type: 'thinking_delta'; thinking?: string }
  | { type: 'input_json_delta'; partial_json?: string } | { type: 'signature_delta'; signature?: string }
type ClaudeStreamEvent =
  | { type: 'message_start'; message?: { id?: string; usage?: ClaudeUsage } }
  | { type: 'content_block_start'; index: number; content_block?: ClaudeContent }
  | { type: 'content_block_delta'; index: number; delta?: ClaudeDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: ClaudeUsage }
  | { type: 'message_stop' | 'ping' }
type ClaudeSystem = { type: 'system' } & (
  | { subtype: 'init'; capabilities?: string[]; claude_code_version: string }
  | { subtype: 'status'; status: string }
  | { subtype: 'compact_boundary' }
  | { subtype: 'api_retry'; attempt?: number; max_retries?: number; retry_delay_ms?: number
      ; error_status?: number | null; error?: string | { message?: string }; no_response?: { waited_ms?: number } }
  | { subtype: 'task_started'; task_id?: unknown; description?: unknown; parent_task_id?: string; tool_use_id?: string }
  | { subtype: 'task_progress'; task_id?: unknown; summary?: unknown; last_tool_name?: unknown }
  | { subtype: 'task_updated'; task_id?: unknown; patch?: { status?: string; error?: unknown } }
  | { subtype: 'task_notification'; task_id?: unknown; summary?: unknown; status: string }
  | { subtype: 'local_command_output' | 'hook_started' | 'hook_progress' | 'hook_response' | 'plugin_install'
      | 'background_tasks_changed' | 'thinking_tokens' | 'session_state_changed' | 'worker_shutting_down'
      | 'commands_changed' | 'files_persisted' | 'permission_denied' | 'informational' })
type ClaudeFrame<Response = unknown> = { session_id?: unknown } & (
  | { type: 'control_response'; response?: { request_id: string } & (
      | { subtype: 'success'; response?: Response; error?: never }
      | { subtype: 'error'; response?: never; error?: string }) }
  | ClaudeSystem
  | { type: 'user'; isReplay?: boolean; message?: { content?: ClaudeContent[] }; tool_use_result?: Parameters<typeof claudeFileChanges>[2] }
  | { type: 'assistant'; error?: string; message?: { id?: string; content?: ClaudeContent[]; usage?: ClaudeUsage }; parent_tool_use_id?: string | null }
  | { type: 'result'; subtype?: string; is_error?: boolean; api_error_status?: number | null; errors?: (string | { message?: string })[]; error?: { message?: string }
      result?: unknown; modelUsage?: Record<string, ClaudeModelUsage>; usage?: ClaudeUsage
      user_message_uuids?: string[]; user_message_uuid?: string }
  | { type: 'stream_event'; event?: ClaudeStreamEvent; parent_tool_use_id?: string | null }
  | { type: 'tool_progress'; tool_use_id: string; parent_tool_use_id?: string | null; elapsed_time_seconds?: unknown }
  | { type: 'auth_status' | 'rate_limit_event' | 'tool_use_summary' | 'prompt_suggestion' | 'conversation_reset' })
type ClaudeTool = { name: string; input?: unknown; parentCallId?: string }
type ClaudeBlock = ClaudeToolUse & { json: string; parentCallId?: string }
type ClaudeTurn = {
  id: string; started: boolean; tools: Map<string, ClaudeTool>; completedTools: Set<string>; blocks: Map<number, ClaudeBlock>
  thinking: Map<number | undefined, string>; texts: Map<number | undefined, string>; messages: Set<string>; steers: Set<string | undefined>; sawText: boolean
  interrupting: boolean; settle: (() => void) | null; changes?: FileChanges; done?: Promise<void>
  compacting?: boolean; messageId?: string; mainMessageId?: string; contextUsed?: number; usage?: Usage
  requests?: Map<string, Usage>; subagents?: Map<string, Usage>; unconfirmed?: boolean; errorKind?: string
}
type ClaudeControl = { resolve(value: unknown): void; reject(error: Error): void }

export { findExecutable } from '../cli.js'

export const claudeInfo = {
  id: 'claude', label: 'Claude Code CLI', command: 'claude', requiresCwd: true,
  description: 'Uses the local Claude Code CLI and its existing login; sessions are shared with Claude Code.',
  fields: [
    { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect claude; or enter an absolute path' },
    { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'Alias or full name; blank uses Claude Code settings' },
  ],
  capabilities: { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, goals: true, permissionModes: ['plan', 'workspace', 'full'] },
} satisfies EngineInfo

export function validateClaudeOptions(raw: Record<string, unknown> = {}): ClaudeOptions {
  for (const key of Object.keys(raw)) if (key !== 'bin') throw invalidConfig(`Unsupported Claude option: ${key}`)
  const bin = validateBin(raw.bin)
  return bin ? { bin } : {}
}

// The CLI keeps no queryable credential state in print mode; the protocol check
// is the stream handshake itself, and the model route stays unverified until a
// turn runs — same honesty as the other adapters.
export async function checkClaude({ cwd, engineOptions = {} }: EngineScanOptions = {}): Promise<EngineCheckResult> {
  const options = validateClaudeOptions(engineOptions)
  const base = await checkCliBase('claude', cwd, findExecutable(options.bin ?? 'claude'), 'Claude Code executable not found. Install Claude Code or enter its absolute path.')
  if (base.failed) return base.failed
  const { checks, executable, version } = base
  let peer: ClaudeConnection | undefined
  try {
    peer = (await handshakeClaude({ executable: executable!, cwd })).peer
    checks.push({ label: 'Protocol', ok: true, message: 'Claude Code stream protocol connected' })
    checks.push({ label: 'Model / credentials', ok: null, message: 'The protocol has no credential query. The existing Claude Code login is used; a conversation is needed to verify the model route.' })
  } catch (error) {
    checks.push({ label: 'Protocol', ok: false, message: `Could not reach the Claude Code stream protocol (${(error as Error).message}). Verify the installation; the first start may take a moment.` })
  } finally { peer?.dispose() }
  return { engine: 'claude', ok: checks.every(check => check.ok !== false), executable, version, checks }
}

// Spawn once and prove the control channel round-trips with an initialize
// control request — the CLI answers it before the session starts and at no
// model cost. The session init itself only follows the first user frame.
export function handshakeClaude({ executable, cwd, env }: ClaudeHandshakeOptions) {
  return new Promise<ClaudeHandshake>((resolve, reject) => {
    let peer: ClaudeConnection | null | undefined
    const timer = setTimeout(() => { peer?.dispose(); reject(new Error('handshake timed out')) }, 20_000)
    const settle = <Value>(fn: (value: Value) => void, value: Value) => { clearTimeout(timer); peer = null; fn(value) }
    try {
      peer = connectClaude<ClaudeFrame<ClaudeInitialize>, ClaudeRequest>({ executable, args: claudeArgs({}), cwd, env,
        onClose: error => settle(reject, error),
        onRequest: frame => { if (peer) peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'No active turn' } } }) },
        onFrame: frame => {
          if (frame.type === 'control_response' && frame.response?.request_id === 'orch-check') {
            const response = frame.response.response
            settle(resolve, { peer: peer!, models: Array.isArray(response?.models) ? response.models : [], commands: Array.isArray(response?.commands) ? response.commands : [] })
          }
        } })
      peer.write({ type: 'control_request', request_id: 'orch-check', request: { subtype: 'initialize' } })
    } catch (error) { clearTimeout(timer); return reject(error) }
  })
}

// Fallback when the CLI does not answer the initialize handshake: the alias
// menu, and the settings file's configured model as default.
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']

function claudeSettings(path: string) {
  try {
    const settings: { model?: unknown } | null = JSON.parse(readFileSync(path, 'utf8'))
    const model = typeof settings?.model === 'string' && settings.model.trim() !== '' && settings.model.length <= 200 ? settings.model.trim() : undefined
    return model ? { source: 'Claude settings.json', defaultModel: model, models: CLAUDE_ALIASES } : { source: 'Claude settings.json', models: CLAUDE_ALIASES }
  } catch { return { source: 'Claude settings.json', models: CLAUDE_ALIASES } }
}

// The initialize control response carries the CLI's own model table: each entry
// resolves its alias to the full versioned id, names it for display, and lists
// the efforts that model takes. 'default' is the configured default, not a
// distinct choice, and `value` is what --model accepts.
const claudeCatalog = (models: ClaudeModel[]) => models.flatMap(model => {
  if (typeof model?.value !== 'string' || model.value === '' || model.value === 'default') return []
  const levels = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && level !== '') : []
  return [{ id: model.value, ...(typeof model.displayName === 'string' && model.displayName !== '' ? { label: model.displayName } : {}), ...(levels.length ? { thinking: levels.map(id => ({ id })) } : {}) }]
})

export async function scanClaude({ engineOptions = {}, cwd }: EngineScanOptions = {}): Promise<Omit<ModelCatalog, 'engine'>> {
  const options = validateClaudeOptions(engineOptions)
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const settings = claudeSettings(join(config, 'settings.json'))
  const fallback = { ...settings, models: settings.models.map(id => ({ id })) }
  const executable = findExecutable(options.bin ?? 'claude')
  let probed: ReturnType<typeof claudeCatalog> = []
  if (executable) {
    try { const peek = await handshakeClaude({ executable, cwd }); peek.peer.dispose(); probed = claudeCatalog(peek.models) } catch { }
  }
  return probed.length ? { ...settings, source: 'Claude Code initialize response', models: probed } : fallback
}

// The composer's /-menu inventory: what the CLI would resolve from a prompt's
// slash line. The initialize response lists the commands available in this
// mode, built-ins included; a CLI that does not answer with them falls back to
// a static scan of the documented locations — the workspace's project-level
// .claude, the user's skills and commands, and installed plugin caches (whose
// skills carry the plugin's name prefix). `source` names what answered, so the
// UI can be honest about the method.
export async function scanClaudeCommands({ engineOptions = {}, cwd }: EngineScanOptions = {}): Promise<EngineCommandInventory> {
  const options = validateClaudeOptions(engineOptions)
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const found = collector()
  const scanDir = (dir: string, owner: string | undefined, scope: string, skills: boolean) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (skills && entry.isDirectory()) found.add(join(dir, entry.name, 'SKILL.md'), entry.name, owner, scope)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.add(join(dir, entry.name), entry.name.replace(/\.md$/, ''), owner, scope)
    }
  }
  const scanSkills = (dir: string, owner: string | undefined, scope: string) => scanDir(dir, owner, scope, true)
  const scanCommands = (dir: string, owner: string | undefined, scope: string) => scanDir(dir, owner, scope, false)
  // A `plugins` directory segment announces the plugin cache: the next level
  // names the plugin, and its skills resolve as `plugin:skill`.
  const walk = (root: string, depth: number, owner: string | undefined, scope: string) => {
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      if (entry.name === 'skills') { scanSkills(path, owner, scope); continue }
      if (entry.name === 'commands') { scanCommands(path, owner, scope); continue }
      if (depth <= 0 || entry.name.startsWith('.')) continue
      walk(path, depth - 1, /plugins?$/.test(entry.name) ? '' : owner === '' ? entry.name : owner, scope)
    }
  }
  walk(join(cwd ?? '.', '.claude'), 1, undefined, 'project')
  walk(config, 0, undefined, 'global')
  walk(join(config, 'plugins'), 5, undefined, 'plugin')
  const disk = found.list('Claude skills and commands')
  const executable = findExecutable(options.bin ?? 'claude')
  if (executable) {
    try {
      const peek = await handshakeClaude({ executable, cwd })
      peek.peer.dispose()
      const known = new Map(disk.commands.map(command => [command.id, command]))
      const commands = peek.commands.flatMap(command => typeof command?.name === 'string'
        ? [{ ...(known.get(command.name) ?? (command.name.includes(':') ? { scope: 'plugin' } : {})), id: command.name,
          ...(typeof command.description === 'string' ? { description: command.description.slice(0, 200) } : {}) }] : [])
      if (commands.length) return { source: 'Claude Code initialize response', commands }
    } catch { }
  }
  return disk
}

// Anthropic's usage counts the uncached prompt in `input_tokens` and the two
// cache buckets separately; the result frame sums the turn's API round-trips,
// while one assistant frame is one request, so its prompt size is the context
// occupancy. `modelUsage` carries the routed model's context window.
const claudePromptTokens = (raw: ClaudeUsage | undefined) =>
  promptTokensOf([raw?.input_tokens, raw?.cache_read_input_tokens, raw?.cache_creation_input_tokens])
const claudeUsage = (raw: ClaudeUsage | undefined) => usageOf({ inputTokens: raw?.input_tokens, outputTokens: raw?.output_tokens,
  cacheReadTokens: raw?.cache_read_input_tokens, cacheWriteTokens: raw?.cache_creation_input_tokens })

// The result frame's `usage` counts the main conversation only; `modelUsage`
// sums every model the process called, subagents included, over the whole
// process (a resumed process starts from the session's earlier sum).
const CLAUDE_MODEL_BUCKETS = [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cacheReadTokens', 'cacheReadInputTokens'], ['cacheWriteTokens', 'cacheCreationInputTokens']] as const
const claudeModelTotals = (raw: Record<string, ClaudeModelUsage> | undefined) => raw && usageOf(Object.values(raw).reduce<Record<string, number>>((sum, model) => {
  for (const [key, field] of CLAUDE_MODEL_BUCKETS) if (typeof model?.[field] === 'number') sum[key] = (sum[key] ?? 0) + (model[field] as number)
  return sum
}, {}))

export function createClaudeDriver({ onEvent, bin = 'claude', cwd, env = {}, model, thinking, permission, driverSessionId, instructions, leadMcpServers }: ClaudeDriverOptions = {}): Driver & { readonly instructionMode: string; readonly coverage: Coverage } {
  const emit = (event: DriverEvent) => { try { onEvent?.(event) } catch {} }
  let peer: ClaudeConnection | null = null
  let ready: Promise<void> | null = null
  let sessionId = driverSessionId
  let resuming = false
  // The process's `modelUsage` sum at the previous result; unknown after a resume until one arrives.
  let modelTotals: Usage | undefined
  let contextSize: number | undefined
  let connected = false
  let disposed = false
  let sequence = 0
  let controlSeq = 0
  let running: ClaudeTurn | null = null
  let canSteer = false
  const controls = new Map<string | undefined, ClaudeControl>()
  const requests = new Map<string, ClaudeRequest>()
  const coverage = createCoverage('claude')

  const closeRequests = () => {
    for (const id of requests.keys()) emit({ type: 'request/closed', id })
    requests.clear()
  }
  const end = (reason: 'done' | 'interrupted' | 'error', error?: unknown, usage?: Usage, text?: string, retryable = false) => {
    if (!running) return
    const turn = running
    running = null
    // Without a result, the turn's usage is what its finished segments and live requests reported.
    usage ??= liveUsage(turn)
    turn.settle?.()
    closeRequests()
    if (turn.changes) emit(turn.changes.snapshot(turn.id))
    emit({ type: 'turn/end', turnId: turn.id, reason, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(turn.errorKind === 'resume-failed' ? { errorKind: 'resume-failed' } : {}), ...(usage ? { usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}), ...(reason === 'error' && retryable ? { retryable: true } : {}) })
  }
  const control = (request: { subtype: string; cancel_queued?: boolean }) => new Promise<unknown>((resolve, reject) => {
    const request_id = `orch-${++controlSeq}`
    const timer = setTimeout(() => { if (controls.delete(request_id)) reject(new Error('Claude control request timed out')) }, 5000)
    controls.set(request_id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    try { peer!.write({ type: 'control_request', request_id, request }) }
    catch (error) { controls.delete(request_id); clearTimeout(timer); reject(error) }
  })
  const startTool = (block: ClaudeToolUse, parentCallId: string | undefined) => {
    const turn = running!
    if (turn.completedTools.has(block.id)) return
    // The top-level todo list rides the plan channel; its call and result never
    // become a tool row. Subagent todos keep the ordinary row.
    if (!parentCallId && isTodoTool(block.name)) {
      const steps = todoPlanSteps(block.input)
      if (steps) { emit({ type: 'plan', turnId: turn.id, steps }); turn.completedTools.add(block.id) }
      return
    }
    const previous = turn.tools.get(block.id)
    turn.tools.set(block.id, { name: block.name ?? previous?.name ?? 'tool', input: block.input ?? previous?.input,
      parentCallId: parentCallId ?? previous?.parentCallId })
    if (!previous) emit({ type: 'tool', turnId: turn.id, callId: block.id, name: block.name ?? 'tool', phase: 'start', input: block.input,
      ...(parentCallId ? { parentCallId } : {}) })
  }
  const liveUsage = (turn: ClaudeTurn) => usageOf({
    ...[...turn.requests?.values() ?? [], ...turn.subagents?.values() ?? []].reduce(addUsage, turn.usage),
    contextUsed: turn.contextUsed, contextSize,
  })
  // A main-conversation request's counts open on message_start and settle on its
  // message_delta (some endpoints send only the output there); a subagent's ride
  // its assistant frames alone, its output and last request partial until the result.
  const requestUsage = (turn: ClaudeTurn, subagent: boolean, id: string | undefined, raw: ClaudeUsage | undefined) => {
    const usage = claudeUsage(raw)
    if (!id || !usage) return
    const counted = subagent ? (turn.subagents ??= new Map()) : (turn.requests ??= new Map())
    counted.set(id, { ...counted.get(id), ...usage })
    emit({ type: 'usage', turnId: turn.id, usage: liveUsage(turn)! })
  }
  const receive = (frame: ClaudeFrame) => {
    if (frame.type === 'control_response') {
      const pending = controls.get(frame.response?.request_id)
      if (!pending) return
      controls.delete(frame.response!.request_id)
      frame.response!.subtype === 'success' ? pending.resolve(frame.response!.response) : pending.reject(new Error(frame.response!.error ?? 'Claude rejected the control request'))
      return
    }
    if (frame.type === 'system') {
      if (frame.subtype !== 'init' && !DECLARED.claude.variants[frame.subtype]) coverage.count('unknown-variant')
      if (frame.subtype === 'init') {
        canSteer = ['request_marker_lists_v1', 'interrupt_cancel_queued_v1', 'interrupt_send_now_v1'].every(capability => frame.capabilities?.includes(capability))
        coverage.setIdentity({ transport: 'stream-json', cliVersion: frame.claude_code_version })
      }
      if (frame.subtype === 'init' && typeof frame.session_id === 'string' && frame.session_id !== '') {
        resuming = false
        sessionId = frame.session_id
        connected = true
        emit({ type: 'session', state: 'ready', sessionId })
      }
      // Compaction is one durable boundary per completed compaction; the live
      // `status` frame only opens the indicator, so the end never doubles.
      if (running && frame.subtype === 'status' && frame.status === 'compacting' && !running.compacting) {
        running.compacting = true
        emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'start' })
      }
      if (running && frame.subtype === 'compact_boundary') {
        running.compacting = false
        emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' })
      }
      // The engine's own API retry banner; it has no end frame, so the turn end closes it.
      if (running && frame.subtype === 'api_retry') {
        const reason = typeof frame.error === 'string' ? frame.error : frame.error?.message
        emit({ type: 'lifecycle', turnId: running.id, kind: 'retry', phase: 'start',
          ...(typeof frame.attempt === 'number' && Number.isFinite(frame.attempt) ? { entityId: `retry-${frame.attempt}` } : {}),
          detail: `第 ${frame.attempt ?? '?'}/${frame.max_retries ?? '?'} 次，等待 ${typeof frame.retry_delay_ms === 'number' ? Math.ceil(frame.retry_delay_ms / 1000) : 0} 秒${reason ? `：${reason}` : ''}` })
      }
      // Subagent tasks are engine-declared members with their own identity and
      // lifecycle; a member's failure never ends the owning turn.
      if (running && frame.subtype === 'task_started' && typeof frame.task_id === 'string' && frame.task_id !== '') {
        emit({ type: 'activity', turnId: running.id, phase: 'start', entityId: frame.task_id, name: 'task',
          ...(typeof frame.description === 'string' && frame.description ? { title: frame.description, detail: frame.description } : {}),
          ...(frame.parent_task_id ? { parentId: frame.parent_task_id } : {}),
          ...(frame.tool_use_id ? { toolCallId: frame.tool_use_id } : {}) })
      }
      if (running && frame.subtype === 'task_progress' && typeof frame.task_id === 'string') {
        emit({ type: 'activity', turnId: running.id, phase: 'update', entityId: frame.task_id, name: 'task',
          ...(typeof frame.summary === 'string' && frame.summary ? { detail: frame.summary }
            : typeof frame.last_tool_name === 'string' && frame.last_tool_name ? { detail: `最近工具：${frame.last_tool_name}` } : {}) })
      }
      if (running && frame.subtype === 'task_updated' && typeof frame.task_id === 'string' && ['completed', 'failed', 'killed'].includes(frame.patch?.status as string)) {
        emit({ type: 'activity', turnId: running.id, phase: 'end', entityId: frame.task_id, name: 'task',
          ...(frame.patch!.status === 'failed' && frame.patch!.error ? { detail: String(frame.patch!.error) } : {}),
          isError: frame.patch!.status === 'failed' })
      }
      if (running && frame.subtype === 'task_notification' && typeof frame.task_id === 'string') {
        emit({ type: 'activity', turnId: running.id, phase: 'end', entityId: frame.task_id, name: 'task',
          ...(typeof frame.summary === 'string' && frame.summary ? { detail: frame.summary } : {}),
          isError: frame.status === 'failed' })
      }
      return
    }
    if (frame.session_id && sessionId && frame.session_id !== sessionId) return
    // Frame types outside the declared union count by category only; the raw
    // type name and payload never reach a log or storage.
    if (!DECLARED.claude.notifications[frame.type]) coverage.count('unknown-notification')
    if (!running) return
    const turn = running
    if (frame.type === 'tool_progress') {
      // The SDK reports elapsed time (and an optional heartbeat) for a known
      // top-level tool; it carries no output text. Nested tools stay with
      // their parent and are not promoted to a top-level row here.
      const tool = turn.tools.get(frame.tool_use_id)
      if (tool && frame.parent_tool_use_id == null && typeof frame.elapsed_time_seconds === 'number' && Number.isFinite(frame.elapsed_time_seconds) && frame.elapsed_time_seconds >= 0) {
        emit({ type: 'tool', turnId: turn.id, callId: frame.tool_use_id, name: tool.name, phase: 'update',
          progress: { elapsedMs: Math.round(frame.elapsed_time_seconds * 1000) }, ...(tool.parentCallId ? { parentCallId: tool.parentCallId } : {}) })
      }
      return
    }
    if (frame.type === 'stream_event') {
      const event: ClaudeStreamEvent | { type?: never } = frame.event ?? {}
      if (event.type === 'message_start') {
        turn.messageId = event.message?.id
        turn.blocks.clear()
        turn.thinking.clear()
        turn.texts.clear()
        emit({ type: 'delta', turnId: turn.id, messageId: turn.messageId, text: '', boundary: 'start',
          ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        if (!frame.parent_tool_use_id) {
          turn.mainMessageId = event.message?.id
          turn.contextUsed = claudePromptTokens(event.message?.usage) ?? turn.contextUsed
          requestUsage(turn, false, turn.mainMessageId, event.message?.usage)
        }
      }
      if (event.type === 'message_delta' && !frame.parent_tool_use_id) requestUsage(turn, false, turn.mainMessageId, event.usage)
      if (event.type === 'content_block_start' && (event.content_block?.type === 'text' || event.content_block?.type === 'thinking')) {
        const block = event.content_block
        const text = block.type === 'text' ? block.text : block.thinking
        if (block.type === 'text') turn.texts.set(event.index, text)
        else turn.thinking.set(event.index, text)
        emit({ type: block.type === 'text' ? 'delta' : 'thinking', turnId: turn.id, messageId: turn.messageId,
          blockIndex: event.index, text, boundary: 'start', ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        turn.blocks.set(event.index, { ...event.content_block, json: '', parentCallId: frame.parent_tool_use_id ?? undefined })
        startTool(event.content_block, frame.parent_tool_use_id ?? undefined)
      }
      if (event.type === 'content_block_delta') {
        const delta: Partial<ClaudeDelta> = event.delta ?? {}
        if (delta.type === 'text_delta' && delta.text) {
          turn.sawText = true
          turn.texts.set(event.index, (turn.texts.get(event.index) ?? '') + delta.text)
          emit({ type: 'delta', turnId: turn.id, text: delta.text, messageId: turn.messageId, blockIndex: event.index,
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        }
        if (delta.type === 'thinking_delta' && delta.thinking) {
          turn.thinking.set(event.index, (turn.thinking.get(event.index) ?? '') + delta.thinking)
          emit({ type: 'thinking', turnId: turn.id, text: delta.thinking, messageId: turn.messageId, blockIndex: event.index,
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        }
        if (delta.type === 'input_json_delta' && turn.blocks.has(event.index)) {
          const block = turn.blocks.get(event.index)!
          block.json += delta.partial_json ?? ''
          const tool = turn.tools.get(block.id)
          // The partial JSON is the input character stream; the parsed object
          // arrives only at content_block_stop. Append it, never guess.
          if (tool && typeof delta.partial_json === 'string' && delta.partial_json !== '') {
            emit({ type: 'tool', turnId: turn.id, callId: block.id, name: tool.name, phase: 'update', inputDelta: delta.partial_json,
              ...(tool.parentCallId ? { parentCallId: tool.parentCallId } : {}) })
          }
        }
      }
      if (event.type === 'content_block_stop') {
        if (turn.texts.has(event.index) || turn.thinking.has(event.index)) {
          emit({ type: turn.texts.has(event.index) ? 'delta' : 'thinking', turnId: turn.id, text: '',
            messageId: turn.messageId, blockIndex: event.index, boundary: 'end',
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        }
        const block = turn.blocks.get(event.index)
        if (block?.json) {
          try {
            const input: unknown = JSON.parse(block.json)
            startTool({ ...block, input }, block.parentCallId)
            if (turn.tools.has(block.id)) {
              emit({ type: 'tool', turnId: turn.id, callId: block.id, name: block.name ?? 'tool', phase: 'update', input,
                ...(block.parentCallId ? { parentCallId: block.parentCallId } : {}) })
            }
          } catch {}
        }
      }
      return
    }
    if (frame.type === 'user') {
      if (frame.isReplay === true) return
      for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
        if (block.type !== 'tool_result' || !turn.tools.has(block.tool_use_id)) continue
        const tool = turn.tools.get(block.tool_use_id)!
        turn.tools.delete(block.tool_use_id)
        turn.completedTools.add(block.tool_use_id)
        turn.changes?.add(block.tool_use_id, claudeFileChanges(tool.name, tool.input, frame.tool_use_result), block.is_error !== true)
        emit({ type: 'tool', turnId: turn.id, callId: block.tool_use_id, name: tool.name, phase: 'end', input: tool.input, output: block.content,
          isError: block.is_error === true, ...(tool.parentCallId ? { parentCallId: tool.parentCallId } : {}) })
      }
      return
    }
    if (frame.type === 'assistant') {
      if (!frame.parent_tool_use_id) turn.errorKind = frame.error
      // The session's context is the main conversation's; a subagent runs in its own.
      const used = frame.parent_tool_use_id ? undefined : claudePromptTokens(frame.message?.usage)
      if (used !== undefined) turn.contextUsed = used
      if (frame.parent_tool_use_id) requestUsage(turn, true, frame.message?.id, frame.message?.usage)
      const messageId = frame.message?.id
      const seen = messageId && turn.messages.has(messageId)
      for (const [index, block] of (Array.isArray(frame.message?.content) ? frame.message.content : []).entries()) {
        if (block.type === 'text' && block.text && !seen) {
          const previous = !turn.messageId || turn.messageId === messageId ? turn.texts.get(index) ?? turn.texts.get(undefined) : undefined
          if (previous === undefined || !block.text.startsWith(previous)) emit({ type: 'text', turnId: turn.id, text: block.text, messageId, blockIndex: index,
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
          else emit({ type: 'delta', turnId: turn.id, text: block.text.slice(previous.length), messageId: turn.messageId ? messageId : undefined,
            blockIndex: turn.texts.has(index) ? index : undefined, boundary: 'end',
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        }
        if (block.type === 'tool_use') {
          const before = turn.tools.get(block.id)
          startTool(block, frame.parent_tool_use_id ?? undefined)
          // The assembled message repeats the same input the stream already
          // delivered; forward it as the final structured value only when it
          // differs from what the start/stop path stored.
          if (before && block.input !== undefined && JSON.stringify(block.input) !== JSON.stringify(before.input)) {
            emit({ type: 'tool', turnId: turn.id, callId: block.id, name: block.name ?? before.name, phase: 'update', input: block.input,
              ...(before.parentCallId ? { parentCallId: before.parentCallId } : {}) })
          }
        }
        if (block.type === 'thinking' && block.thinking && !seen) {
          const previous = !turn.messageId || turn.messageId === messageId ? turn.thinking.get(index) ?? turn.thinking.get(undefined) ?? '' : ''
          const text = block.thinking.startsWith(previous) ? block.thinking.slice(previous.length) : ''
          emit({ type: 'thinking', turnId: turn.id, text, messageId, blockIndex: index, boundary: 'end',
            ...(frame.parent_tool_use_id ? { parentCallId: frame.parent_tool_use_id } : {}) })
        }
      }
      if (messageId) turn.messages.add(messageId)
      turn.thinking.clear()
      return
    }
    if (frame.type === 'result') {
      // Only a clean success is a normal finish; known failure subtypes and a
      // success flag carrying a structured error must not pass as done.
      const reason = frame.subtype === 'success' && frame.is_error !== true ? 'done'
        : turn.interrupting ? 'interrupted' : 'error'
      const error = reason === 'error'
        ? (Array.isArray(frame.errors) && frame.errors.length ? frame.errors.map(item => typeof item === 'string' ? item : item?.message).filter(Boolean).join('; ') : '')
          || frame.error?.message
          || (typeof frame.result === 'string' && frame.result.trim())
          || `Claude turn failed (${frame.subtype ?? 'unknown result'})`
        : undefined
      // A failed turn still owns its final text when nothing streamed.
      if (!turn.sawText && typeof frame.result === 'string' && frame.result !== '') emit({ type: 'text', turnId: turn.id, text: frame.result })
      const totals = claudeModelTotals(frame.modelUsage)
      const grown = totals && modelTotals ? Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value - (modelTotals![key as keyof Usage] ?? 0)])) : undefined
      modelTotals = totals ?? modelTotals
      contextSize = Object.values(frame.modelUsage ?? {})[0]?.contextWindow ?? contextSize
      // Without a known baseline the main conversation is exact and the subagents only as live as they streamed.
      const counted = grown ?? addUsage(claudeUsage(frame.usage), [...turn.subagents?.values() ?? []].reduce(addUsage, undefined))
      const usage = addUsage(turn.usage, usageOf({ ...counted, contextUsed: turn.contextUsed, contextSize }))
      turn.requests = undefined
      turn.subagents = undefined
      for (const uuid of frame.user_message_uuids ?? [frame.user_message_uuid]) turn.steers.delete(uuid)
      if (!turn.interrupting && turn.steers.size > 0) { turn.usage = usage; turn.sawText = false; return }
      const retryable = turn.errorKind !== undefined ? ['overloaded', 'server_error'].includes(turn.errorKind)
        : typeof frame.api_error_status === 'number' && (frame.api_error_status === 408 || frame.api_error_status >= 500 && frame.api_error_status < 600)
      if (reason === 'error' && resuming && error?.includes(`No conversation found with session ID: ${sessionId}`)) turn.errorKind = 'resume-failed'
      end(reason, error, usage, typeof frame.result === 'string' ? frame.result : undefined, retryable)
    }
  }
  const ask = (frame: ClaudeRequest) => {
    const request: Partial<ClaudeRequestBody> = frame.request ?? {}
    if (!peer) return
    if (request.subtype !== 'can_use_tool' || !running) {
      if (request.subtype !== 'can_use_tool' && !DECLARED.claude.requests[request.subtype as string]) coverage.count('unknown-request')
      return peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'No matching active turn' } } })
    }
    const opened = askOpened('claude', sessionId, frame.request_id, request)
    requests.set(opened.id, frame)
    emit(opened)
  }
  const boot = () => {
    if (ready) return ready
    let connection: ClaudeConnection | undefined
    const pending = (async () => {
      if (disposed) throw new Error('Claude driver disposed')
      validateWorkspace(cwd, true)
      const executable = findExecutable(bin)
      if (!executable) throw new Error('Claude Code executable not found. Install Claude Code or edit the profile CLI path.')
      emit({ type: 'session', state: 'starting' })
      resuming = !!sessionId
      modelTotals = sessionId ? undefined : {}
      connection = connectClaude<ClaudeFrame, ClaudeRequest>({ executable, args: claudeArgs({ model, thinking, permission, instructions, driverSessionId: sessionId, leadMcpServers }), cwd, env: { ...env, ...leadMcpEnv(leadMcpServers) },
        onFrame: receive, onRequest: ask,
        onClose(error) {
          if (peer !== connection) return
          peer = null; ready = null; connected = false; canSteer = false
          closeRequests()
          if (running?.started) {
            if (resuming && error.message.includes(`No conversation found with session ID: ${sessionId}`)) running.errorKind = 'resume-failed'
            end('error', error.message)
          }
          emit({ type: 'session', state: 'closed' })
        } })
      if (disposed) { connection.dispose(); throw new Error('Claude driver disposed') }
      peer = connection
      // The CLI emits its session init only after the first user frame, so a
      // boot can only confirm the process came up; the session id arrives with
      // the init frame and is persisted through the session event.
      await connection.running
      if (disposed) throw new Error('Claude driver disposed')
      connected = true
    })().catch(error => {
      if (peer === connection) { peer = null; connected = false; connection?.dispose() }
      if (ready === pending) ready = null
      throw error
    })
    ready = pending
    return pending
  }

  return {
    get instructionMode() { return connected && instructions ? 'native' : 'none' },
    get coverage() { return coverage },
    openSession: boot,
    async sendTurn(text, images = []) {
      if (disposed) throw new Error('Claude driver disposed')
      if (running) throw new Error('Claude already has a running turn')
      const turn: ClaudeTurn = running = { id: `claude-${++sequence}`, started: false, tools: new Map(), completedTools: new Set(), blocks: new Map(), thinking: new Map(), texts: new Map(), messages: new Set(), steers: new Set(), sawText: false, interrupting: false, settle: null }
      if (text !== '/compact') turn.changes = createFileChanges(cwd)
      try {
        await boot()
        if (disposed || running !== turn) return turn.id
        const content = [...(text === '' ? [] : [{ type: 'text', text: String(text) }]), ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }))]
        peer!.write({ type: 'user', message: { role: 'user', content } })
        if (running !== turn) return turn.id
        turn.started = true
        turn.done = new Promise<void>(resolve => { turn.settle = resolve })
        emit({ type: 'turn/start', turnId: turn.id })
        return turn.id
      } catch (error) { if (running === turn) running = null; throw error }
    },
    async steer(text) {
      if (!canSteer || !running?.started || running.interrupting || disposed) return STEER.REFUSED
      const uuid = randomUUID()
      running.steers.add(uuid)
      try {
        peer!.write({ type: 'user', uuid, priority: requests.size ? 'later' : 'now', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: String(text) }] } })
        return STEER.STEERED
      } catch { running?.steers.delete(uuid); return STEER.REFUSED }
    },
    // The slash line is claude's own native channel; print mode executes it.
    compact() { return this.sendTurn('/compact') },
    goals(objective) { return this.sendTurn(objective === undefined ? '/goal' : objective === null ? '/goal clear' : `/goal ${objective}`) },
    async interruptTurn() {
      const turn = running
      if (!turn) return
      // dispose() suppresses onClose, so a forced drop performs onClose's reset
      // itself; otherwise the dead pipe keeps answering hasSession() true and
      // every later turn fails without a respawn.
      const drop = () => {
        turn.unconfirmed = true
        peer?.dispose()
        peer = null; ready = null; connected = false; canSteer = false
        end('interrupted')
        emit({ type: 'session', state: 'closed' })
      }
      if (!turn.started) { drop(); return }
      turn.interrupting = true
      try { await control({ subtype: 'interrupt', ...(canSteer ? { cancel_queued: true } : {}) }) }
      catch { drop(); return }
      let raceTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([turn.done, new Promise(resolve => { raceTimer = setTimeout(resolve, 5000) })])
      clearTimeout(raceTimer)
      if (running === turn) drop()
    },
    async respondToRequest(id, { decision, value }: Omit<DriverResponse, 'value'> & { value?: unknown } = {}) {
      const frame = requests.get(id)
      if (!frame || !peer) return false
      const request: Partial<ClaudeRequestBody> = frame.request ?? {}
      if (request.tool_name === 'AskUserQuestion') {
        const mapped = askAnswers(request.input?.questions ?? [], value)
        peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: { ...request.input, answers: mapped } } } })
      } else {
        if (!['allow', 'deny'].includes(decision as string)) return false
        peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: decision === 'allow'
          ? { behavior: 'allow', updatedInput: request.input ?? {} }
          : { behavior: 'deny', message: 'Denied by the user' } } })
      }
      requests.delete(id)
      emit({ type: 'request/closed', id })
      return true
    },
    onEvent() { throw new Error('Pass onEvent to createClaudeDriver') },
    hasSession() { return connected },
    dispose() { disposed = true; end('interrupted'); peer?.dispose() },
  }
}
