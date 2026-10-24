import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STEER, addUsage, usageOf } from '../spi.js'
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import { collector } from '../skills.js'
import { createCoverage, DECLARED } from '../coverage.js'
import { claudeArgs, connectClaude } from './native.js'
import { createFileChanges } from '../file-changes.js'
import { claudeFileChanges } from './file-changes.js'
import type { ClaudeConnection } from './native.js'
import type { Driver, DriverEvent, DriverResponse, EngineCheckResult, EngineInfo, PermissionMode, Usage } from '../spi.js'
import type { Coverage } from '../coverage.js'
import type { FileChanges } from '../file-changes.js'
import type { EngineScanOptions, ModelCatalog } from '../index.js'
import type { SkillInventory } from '../skills.js'

export type ClaudeOptions = { bin?: string }
export type ClaudeDriverOptions = {
  onEvent?: (event: DriverEvent) => void; bin?: string; cwd?: string; env?: NodeJS.ProcessEnv
  model?: string; thinking?: string; permission?: PermissionMode; driverSessionId?: string; instructions?: string
}
type ClaudeHandshakeOptions = { executable: string; cwd?: string; env?: NodeJS.ProcessEnv }
type ClaudeModel = { value?: unknown; displayName?: unknown; supportedEffortLevels?: unknown[] }
type ClaudeInitialize = { models?: ClaudeModel[] }
type ClaudeHandshake = { peer: ClaudeConnection; models: ClaudeModel[] }
type ClaudeUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown }
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
  | { type: 'message_start'; message?: { id?: string } }
  | { type: 'content_block_start'; index: number; content_block?: ClaudeContent }
  | { type: 'content_block_delta'; index: number; delta?: ClaudeDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta' | 'message_stop' | 'ping' }
type ClaudeSystem = { type: 'system' } & (
  | { subtype: 'init'; capabilities?: string[]; claude_code_version: string }
  | { subtype: 'status'; status: string }
  | { subtype: 'compact_boundary' }
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
  | { type: 'assistant'; message?: { id?: string; content?: ClaudeContent[]; usage?: ClaudeUsage }; parent_tool_use_id?: string | null }
  | { type: 'result'; subtype?: string; is_error?: boolean; errors?: (string | { message?: string })[]; error?: { message?: string }
      result?: unknown; modelUsage?: Record<string, { contextWindow?: number }>; usage?: ClaudeUsage
      user_message_uuids?: string[]; user_message_uuid?: string }
  | { type: 'stream_event'; event?: ClaudeStreamEvent; parent_tool_use_id?: string | null }
  | { type: 'tool_progress'; tool_use_id: string; parent_tool_use_id?: string | null; elapsed_time_seconds?: unknown }
  | { type: 'auth_status' | 'rate_limit_event' | 'tool_use_summary' | 'prompt_suggestion' | 'conversation_reset' })
type ClaudeTool = { name: string; input?: unknown; parentCallId?: string }
type ClaudeBlock = ClaudeToolUse & { json: string; parentCallId?: string }
type ClaudeTurn = {
  id: string; started: boolean; tools: Map<string, ClaudeTool>; completedTools: Set<string>; blocks: Map<number, ClaudeBlock>
  thinking: Map<number | undefined, string>; messages: Set<string>; steers: Set<string | undefined>; sawText: boolean
  interrupting: boolean; settle: (() => void) | null; changes?: FileChanges; done?: Promise<void>
  compacting?: boolean; messageId?: string; contextUsed?: number; usage?: Usage; unconfirmed?: boolean
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
  capabilities: { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] },
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
  const checks: EngineCheckResult['checks'] = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: (error as Error).message }) }
  const options = validateClaudeOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'claude')
  if (!executable) return { engine: 'claude', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'Claude Code executable not found. Install Claude Code or enter its absolute path.' }] }
  let version
  try { version = await cliVersion(executable); checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` }) }
  catch { return { engine: 'claude', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  let peer: ClaudeConnection | undefined
  try {
    peer = (await handshakeClaude({ executable, cwd })).peer
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
          if (frame.type === 'control_response' && frame.response?.request_id === 'orch-check')
            settle(resolve, { peer: peer!, models: Array.isArray(frame.response.response?.models) ? frame.response.response.models : [] })
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
// slash line. There is no protocol listing, so this is a static scan of the
// documented locations — the workspace's project-level .claude, the user's
// skills and commands, and installed plugin caches (whose skills carry the
// plugin's name prefix). The frontmatter description rides along when present;
// `source` names what answered, so the UI can be honest about the method.
export async function scanClaudeCommands({ engineOptions = {}, cwd }: EngineScanOptions = {}): Promise<SkillInventory> {
  validateClaudeOptions(engineOptions)
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const found = collector()
  const scanSkills = (dir: string, owner: string | undefined, scope: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) found.add(join(dir, entry.name, 'SKILL.md'), entry.name, owner, scope)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.add(join(dir, entry.name), entry.name.replace(/\.md$/, ''), owner, scope)
    }
  }
  const scanCommands = (dir: string, owner: string | undefined, scope: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) found.add(join(dir, entry.name), entry.name.replace(/\.md$/, ''), owner, scope)
    }
  }
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
  return found.list('Claude skills and commands')
}

// Anthropic's usage counts the uncached prompt in `input_tokens` and the two
// cache buckets separately; the result frame sums the turn's API round-trips,
// while one assistant frame is one request, so its prompt size is the context
// occupancy. `modelUsage` carries the routed model's context window.
const claudePromptTokens = (raw: ClaudeUsage | undefined) => {
  const parts = [raw?.input_tokens, raw?.cache_read_input_tokens, raw?.cache_creation_input_tokens]
  return parts.some(value => typeof value === 'number' && Number.isFinite(value))
    ? parts.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0), 0)
    : undefined
}

export function createClaudeDriver({ onEvent, bin = 'claude', cwd, env = {}, model, thinking, permission, driverSessionId, instructions }: ClaudeDriverOptions = {}): Driver & { readonly instructionMode: string; readonly coverage: Coverage } {
  const emit = (event: DriverEvent) => { try { onEvent?.(event) } catch {} }
  let peer: ClaudeConnection | null = null
  let ready: Promise<void> | null = null
  let sessionId = driverSessionId
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
  const end = (reason: 'done' | 'interrupted' | 'error', error?: unknown, usage?: Usage, text?: string) => {
    if (!running) return
    const turn = running
    running = null
    // A steered turn keeps the usage its finished segments already reported.
    usage ??= turn.usage
    turn.settle?.()
    closeRequests()
    if (turn.changes) emit(turn.changes.snapshot(turn.id))
    emit({ type: 'turn/end', turnId: turn.id, reason, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) })
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
    const previous = turn.tools.get(block.id)
    turn.tools.set(block.id, { name: block.name ?? previous?.name ?? 'tool', input: block.input ?? previous?.input,
      parentCallId: parentCallId ?? previous?.parentCallId })
    if (!previous) emit({ type: 'tool', turnId: turn.id, callId: block.id, name: block.name ?? 'tool', phase: 'start', input: block.input,
      ...(parentCallId ? { parentCallId } : {}) })
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
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        turn.blocks.set(event.index, { ...event.content_block, json: '', parentCallId: frame.parent_tool_use_id ?? undefined })
        startTool(event.content_block, frame.parent_tool_use_id ?? undefined)
      }
      if (event.type === 'content_block_delta') {
        const delta: Partial<ClaudeDelta> = event.delta ?? {}
        if (delta.type === 'text_delta' && delta.text) { turn.sawText = true; emit({ type: 'delta', turnId: turn.id, text: delta.text }) }
        if (delta.type === 'thinking_delta' && delta.thinking) {
          turn.thinking.set(event.index, (turn.thinking.get(event.index) ?? '') + delta.thinking)
          emit({ type: 'thinking', turnId: turn.id, text: delta.thinking })
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
      const used = claudePromptTokens(frame.message?.usage)
      if (used !== undefined) turn.contextUsed = used
      const messageId = frame.message?.id
      const seen = messageId && turn.messages.has(messageId)
      for (const [index, block] of (Array.isArray(frame.message?.content) ? frame.message.content : []).entries()) {
        if (block.type === 'text' && block.text && !turn.sawText) emit({ type: 'text', turnId: turn.id, text: block.text })
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
          if (text) emit({ type: 'thinking', turnId: turn.id, text })
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
          || `Claude turn failed (${frame.subtype ?? 'unknown result'})`
        : undefined
      // A failed turn still owns its final text when nothing streamed.
      if (!turn.sawText && typeof frame.result === 'string' && frame.result !== '') emit({ type: 'text', turnId: turn.id, text: frame.result })
      const usage = addUsage(turn.usage, usageOf({
        inputTokens: frame.usage?.input_tokens,
        outputTokens: frame.usage?.output_tokens,
        cacheReadTokens: frame.usage?.cache_read_input_tokens,
        cacheWriteTokens: frame.usage?.cache_creation_input_tokens,
        contextUsed: turn.contextUsed,
        contextSize: Object.values(frame.modelUsage ?? {})[0]?.contextWindow,
      }))
      for (const uuid of frame.user_message_uuids ?? [frame.user_message_uuid]) turn.steers.delete(uuid)
      if (!turn.interrupting && turn.steers.size > 0) { turn.usage = usage; turn.sawText = false; return }
      end(reason, error, usage, typeof frame.result === 'string' ? frame.result : undefined)
    }
  }
  const ask = (frame: ClaudeRequest) => {
    const request: Partial<ClaudeRequestBody> = frame.request ?? {}
    if (!peer) return
    if (request.subtype !== 'can_use_tool' || !running) {
      if (request.subtype !== 'can_use_tool' && !DECLARED.claude.requests[request.subtype as string]) coverage.count('unknown-request')
      return peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'No matching active turn' } } })
    }
    const question = request.tool_name === 'AskUserQuestion'
    const cardId = `claude:${sessionId}:${frame.request_id}`
    requests.set(cardId, frame)
    emit({
      type: 'request/opened', id: cardId, kind: question ? 'question' : 'permission',
      tool: request.tool_name,
      reason: question
        ? (request.input?.questions ?? []).map(item => item.question).join('\n')
        : request.description ?? request.input?.description ?? request.input?.command ?? `${request.display_name ?? request.tool_name} requests permission`,
      ...(question ? { detail: { questions: (request.input?.questions ?? []).map((item, index) => ({ id: `q${index}`, question: item.question, header: item.header,
        ...(item.options ? { options: item.options } : {}), ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }) })) } }
        : { detail: { input: request.input } }),
    })
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
      connection = connectClaude<ClaudeFrame, ClaudeRequest>({ executable, args: claudeArgs({ model, thinking, permission, instructions, driverSessionId: sessionId }), cwd, env,
        onFrame: receive, onRequest: ask,
        onClose(error) {
          if (peer !== connection) return
          peer = null; ready = null; connected = false; canSteer = false
          closeRequests()
          if (running?.started) end('error', error.message)
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
      const turn: ClaudeTurn = running = { id: `claude-${++sequence}`, started: false, tools: new Map(), completedTools: new Set(), blocks: new Map(), thinking: new Map(), messages: new Set(), steers: new Set(), sawText: false, interrupting: false, settle: null }
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
    respondToRequest(id, { decision, value }: Omit<DriverResponse, 'value'> & { value?: unknown } = {}) {
      const frame = requests.get(id)
      if (!frame || !peer) return Promise.resolve(false)
      const request: Partial<ClaudeRequestBody> = frame.request ?? {}
      if (request.tool_name === 'AskUserQuestion') {
        const questions = request.input?.questions ?? []
        let answers: unknown
        if (questions.length === 1) answers = { [questions[0].question]: String(value ?? '').trim() }
        else {
          try { answers = JSON.parse(value as string) } catch { return Promise.reject(new Error('Answer each question using the form')) }
          if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return Promise.reject(new Error('Answer each question using the form'))
        }
        const answerOf = (item: ClaudeQuestion, index: number) => String((answers as Record<string, unknown>)?.[`q${index}`] ?? (answers as Record<string, unknown>)?.[item.question] ?? '').trim()
        if (questions.some((item, index) => answerOf(item, index) === '')) return Promise.reject(new Error('Answer every question first'))
        const mapped = Object.fromEntries(questions.map((item, index) => [item.question, answerOf(item, index)]))
        peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: { ...request.input, answers: mapped } } } })
      } else {
        if (!['allow', 'deny'].includes(decision as string)) return Promise.resolve(false)
        peer.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: decision === 'allow'
          ? { behavior: 'allow', updatedInput: request.input ?? {} }
          : { behavior: 'deny', message: 'Denied by the user' } } })
      }
      requests.delete(id)
      emit({ type: 'request/closed', id })
      return Promise.resolve(true)
    },
    onEvent() { throw new Error('Pass onEvent to createClaudeDriver') },
    hasSession() { return connected },
    dispose() { disposed = true; end('interrupted'); peer?.dispose() },
  }
}
