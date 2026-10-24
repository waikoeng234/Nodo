import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STEER, addUsage, steerFailed, usageOf } from '../spi.js'
import { cliVersion, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import { collector, listDirs } from '../skills.js'
import { createCoverage, DECLARED } from '../coverage.js'
import { createFileChanges } from '../file-changes.js'
import { connectZcode, findZcodeExecutable, parseZcodeModel } from './native.js'
import { roleMcp } from '../role-mcp.js'
import { zcodeInstructions } from './instructions.js'
import { zcodeMcpServers } from './mcp.js'
import type { Driver, DriverEvent, DriverImage, EngineInfo, EngineCheckResult, PermissionMode, SteerOutcome, Usage } from '../spi.js'
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcPeer, RpcId } from '../json-rpc-process.js'
import type { FileChanges } from '../file-changes.js'
import type { IdentityFiles } from '../identity-files.js'
import type { Coverage } from '../coverage.js'
import type { EngineScanOptions } from '../index.js'
import type { SkillInventory } from '../skills.js'
import type { ZcodeIdentity } from './instructions.js'
import type { ZcodeModelRoute } from './native.js'

export type ZcodeOptions = { bin?: string }
type ZcodeEvent = DriverEvent
  | { type: 'request/stray'; kind: string; requestId?: RpcId }
  | { type: 'request/missed'; id: string; connected: boolean; pending: string[] }
export type ZcodeDriverOptions = {
  onEvent?: (event: ZcodeEvent) => void; bin?: string; cwd?: string; env?: NodeJS.ProcessEnv
  model?: unknown; thinking?: string; permission?: PermissionMode; driverSessionId?: string
  instructions?: string; instructionDir?: string; identityFiles?: IdentityFiles; identityOwner?: string
  allowEmptyResume?: boolean; healthIntervalMs?: number; healthTimeoutMs?: number
}
type ZcodeDriver = Driver & {
  readonly instructionMode: ZcodeIdentity['mode']; readonly instructionTarget: ZcodeIdentity['target']
  readonly instructionFallback: ZcodeIdentity['reason']; readonly coverage: Coverage
}
type ContextUsage = { used?: number; size?: number }
type SessionSnapshot = {
  sessionId?: string; session?: { sessionId?: string; status?: string }; messages?: unknown[]
  contextUsage?: ContextUsage
  runtime?: { contextUsage?: ContextUsage; pendingRequestIds?: RpcId[]; activeTurnId?: string }
  projection?: { status?: string; lastError?: { message?: string } }
  settings?: { model?: { available?: {
    ref?: { providerId?: unknown; modelId?: unknown }; reasoning?: { defaultLevel?: unknown }
  }[] } }
}
type ZcodePayload = {
  kind: string; toolCallId?: string; toolName?: string; parentToolCallId?: string; input?: unknown
  schedule?: { command?: string; description?: string }
  inputId?: string; queryId?: string; pendingInputId?: string; assistantMessageId?: string
  queryIds?: string[]; pendingInputIds?: string[]; drainedInputs?: { intent?: { sourceCommandId?: string } }[]
  delta?: string; response?: string; resultType?: string; message?: string; error?: { message?: string }
  result?: { success?: boolean; content?: unknown; error?: unknown }
  modifiedInput?: unknown; requestId?: RpcId; contextUsage?: ContextUsage
  runtime?: { contextUsage?: ContextUsage }; cacheStats?: { cacheReadTokens?: unknown }
  usage?: {
    inputTokens?: number; input?: number; outputTokens?: number; output?: number; totalTokens?: number; total?: number
    cacheReadTokens?: number; cacheWriteTokens?: number; cache?: { read?: number; write?: number }
  }
  _meta?: { zcode?: { apiRetry?: { attempt: number; maxRetries: number; retryDelayMs?: number } } }
  elapsedMs?: number; stdoutTail?: unknown; stderrTail?: unknown; stdoutBytes?: number
  stderrBytes?: number; outputBytes?: number; outputPreview?: unknown
}
type PermissionOption = { response?: { decision?: string } }
type ZcodeQuestion = {
  question: string; header: string; multiSelect?: unknown
  options?: (string | { label?: string; value?: string; description?: string })[]
}
type ZcodeParams = {
  sessionId?: string; type?: string; payload?: ZcodePayload
  requestId?: RpcId; toolCallId?: string; toolName?: string; riskLevel?: string; reason?: string
  prompt?: string; options?: PermissionOption[]; questions?: ZcodeQuestion[]
}
type ZcodeRequest = JsonRpcRequest<ZcodeParams> & { params: ZcodeParams }
type RunningTurn = {
  id: string; started: boolean; messages: Set<string | undefined>; tools: Set<string>; completedTools: Set<string>
  names: Map<string, string>; inputs: Map<string, unknown>; parents: Map<string, string>; parentEmitted: Set<string>
  guides: Set<string | undefined>; guideIds: Map<string | undefined, string | undefined>; sawText: boolean; settle: (() => void) | null
  changes: FileChanges; usage?: Usage; final?: string; unconfirmed?: boolean; checking?: boolean; interrupting?: boolean
  lastEventAt: number; healthTimer?: ReturnType<typeof setInterval>; done?: Promise<void>; v4Inputs?: number
  finished?: { reason: 'done'; error?: string }
}
type Compaction = { resolve(): void; reject(error: unknown): void; turnId: string; started: boolean }
type CommandResult = { status: string; result?: { type?: string; inputId?: string } }
type CompactResult = { compact?: { state?: string } }

export { findZcodeExecutable } from './native.js'
export { scanZcode } from './catalog.js'

export const zcodeInfo = {
  id: 'zcode', label: 'ZCode CLI', command: 'zcode', requiresCwd: true,
  description: 'Uses the local ZCode app-server and its existing login; sessions are shared with the ZCode app.',
  fields: [
    { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect ZCode; or enter an absolute path' },
    { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'providerId$modelId; blank uses ZCode settings' },
  ],
  capabilities: { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] },
} satisfies EngineInfo

export function validateZcodeOptions(raw: Record<string, unknown> = {}): ZcodeOptions {
  for (const key of Object.keys(raw)) if (key !== 'bin') throw invalidConfig(`Unsupported ZCode option: ${key}`)
  const bin = validateBin(raw.bin)
  return bin ? { bin } : {}
}

export async function checkZcode({ cwd, engineOptions = {} }: EngineScanOptions = {}): Promise<EngineCheckResult> {
  const checks: EngineCheckResult['checks'] = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: (error as Error).message }) }
  const options = validateZcodeOptions(engineOptions)
  const executable = findZcodeExecutable(options.bin ?? 'zcode')
  if (!executable) return { engine: 'zcode', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'ZCode executable not found. Install ZCode or enter its absolute path.' }] }
  let version
  try { version = await cliVersion(executable); checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` }) }
  catch { return { engine: 'zcode', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  const peer = connectZcode({ executable, cwd, onRequest: request => {
    if (request.method === 'interaction/requestOfficialMcpAuthHeaders') peer.reply(request.id, { headers: {} })
    else peer.refuse(request.id)
  } })
  try {
    await peer.request('runtime/capabilities')
    checks.push({ label: 'Protocol', ok: true, message: 'ZCode app-server connected' })
    const { sessions } = await peer.request<{ sessions: unknown }>('session/list', {})
    checks.push({ label: 'Session store', ok: true, message: `Readable (${Array.isArray(sessions) ? sessions.length : 0} existing sessions)` })
    checks.push({ label: 'Model / credentials', ok: null, message: 'The protocol has no credential query. The existing ZCode login is used; a conversation is needed to verify the model route.' })
  } catch (error) {
    checks.push({ label: 'Protocol', ok: false, message: `Could not reach the ZCode app-server (${(error as Error).message}). Verify the installation; the first start may take a moment.` })
  } finally { peer.dispose() }
  return { engine: 'zcode', ok: checks.every(check => check.ok !== false), executable, version, checks }
}

// The thinking level ZCode itself would pick for a model, read from the session
// snapshot that create/resume returned; undefined when the catalog is silent.
const selectionDefault = (snapshot: SessionSnapshot, selection: ZcodeModelRoute) => (snapshot?.settings?.model?.available ?? [])
  .find(entry => entry?.ref?.providerId === selection.providerId && entry?.ref?.modelId === selection.modelId)?.reasoning?.defaultLevel

// ZCode passes the provider's own usage object through and providers disagree on
// its shape: GLM-style `{input, output, total, cache: {read, write}}` next to the
// AI SDK's `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
// `sessionCacheRead` is the growth of the whole-session cacheStats counter since
// the previous observation, and the session runtime snapshot carries the context
// occupancy with the window it is measured against.
const zcodeUsage = (payload: ZcodePayload, context: ContextUsage | undefined, sessionCacheRead: number | undefined) => {
  const usage = payload?.usage ?? {}
  const outputTokens = usage.outputTokens ?? usage.output
  const total = usage.totalTokens ?? usage.total
  const cacheReadTokens = usage.cacheReadTokens ?? usage.cache?.read ?? sessionCacheRead
  const cacheWriteTokens = usage.cacheWriteTokens ?? usage.cache?.write
  // Both shapes count the whole prompt with the cache buckets inside, unless the
  // total only adds up with the cache on top — the same test ZCode applies itself.
  const cached = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const input = usage.inputTokens ?? usage.input ?? (typeof total === 'number' && typeof outputTokens === 'number' ? Math.max(0, total - outputTokens) : undefined)
  const output = outputTokens ?? 0
  const disjoint = typeof input === 'number' && typeof total === 'number' && cached > 0
    && Math.abs(total - (input + cached + output)) < Math.abs(total - (input + output))
  const prompt = input === undefined ? undefined : disjoint ? input + cached : input
  const inputTokens = prompt === undefined ? undefined : Math.max(0, prompt - cached)
  const used = context?.used ?? prompt
  return usageOf({
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    contextUsed: used, contextSize: context?.size,
  })
}

const zcodeContext = (payload: Pick<SessionSnapshot, 'contextUsage' | 'runtime'>) => payload?.contextUsage ?? payload?.runtime?.contextUsage

export function createZcodeDriver({ onEvent, bin = 'zcode', cwd, env = {}, model, thinking, permission, driverSessionId, instructions, instructionDir, identityFiles, identityOwner, allowEmptyResume = false, healthIntervalMs = 30_000, healthTimeoutMs = 10_000 }: ZcodeDriverOptions = {}): ZcodeDriver {
  const emit = (event: ZcodeEvent) => {
    if (running && ['delta', 'thinking', 'tool', 'request/opened', 'request/closed'].includes(event.type)) running.lastEventAt = Date.now()
    try { onEvent?.(event) } catch {}
  }
  let peer: JsonRpcPeer | null = null
  let ready: Promise<void> | null = null
  let sessionId = driverSessionId
  let connected = false
  let disposed = false
  let sequence = 0
  let running: RunningTurn | null = null
  let context: ContextUsage | undefined
  let canRecreateEmpty = allowEmptyResume === true
  let identity: ZcodeIdentity | undefined
  let compaction: Compaction | null | undefined
  const requests = new Map<string, ZcodeRequest>()
  const answeredRequests = new Set<RpcId | undefined>()
  const coverage = createCoverage('zcode')

  // `cacheStats` counts the whole engine session's cache read; a turn's own read
  // is its growth since the previous observation — nothing before a first
  // observation, or when the counter goes backwards.
  let cacheStatsBasis: number | undefined
  const grewCacheRead = (to: unknown) => {
    const from = cacheStatsBasis
    if (typeof to === 'number') cacheStatsBasis = to
    return typeof from === 'number' && typeof to === 'number' && to >= from ? to - from : undefined
  }

  const finishCompact = (error?: unknown) => {
    const pending = compaction
    compaction = null
    if (error) pending?.reject(error)
    else pending?.resolve()
  }
  // An accepted compaction reports its lifetime as a turn (spi.js); a lost
  // connection ends that turn so the host does not stay active on it.
  const settleCompact = (error: Error) => {
    if (!compaction) return
    const { turnId, started } = compaction
    finishCompact(error)
    if (started) emit({ type: 'turn/end', turnId, reason: 'error', error: error.message })
  }

  const disconnect = () => {
    settleCompact(new Error('ZCode disconnected during compaction'))
    const current = peer
    peer = null; ready = null; connected = false
    closeRequests()
    current?.dispose()
    if (current) emit({ type: 'session', state: 'closed' })
  }
  const closeRequests = () => {
    for (const id of requests.keys()) emit({ type: 'request/closed', id })
    requests.clear()
    answeredRequests.clear()
  }
  const end = (reason: 'done' | 'interrupted' | 'error', error?: string, usage?: Usage) => {
    if (!running) return
    const turn = running
    running = null
    // Segments the engine already billed (steered guides, earlier model calls)
    // stay reported even when the turn fails or is cut off mid-flight.
    usage ??= turn.usage
    clearInterval(turn.healthTimer)
    turn.settle?.()
    closeRequests()
    emit(turn.changes.snapshot(turn.id))
    emit({ type: 'turn/end', turnId: turn.id, reason, ...(turn.final ? { text: turn.final } : {}), ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) })
  }
  const command = (type: string, payload: unknown, commandId: string = randomUUID(), timeout = 15000) => peer!.request<CommandResult>('v4/command', { commandId, clientId: 'nodo', sessionId, type, payload, issuedAt: Date.now() }, timeout)
  const checkHealth = async (turn: RunningTurn) => {
    if (running !== turn || turn.checking || turn.interrupting || Date.now() - turn.lastEventAt < healthIntervalMs) return
    turn.checking = true
    const connection = peer
    const checkedAt = turn.lastEventAt
    try {
      const snapshot = await connection!.request<SessionSnapshot>('session/read', { sessionId, contentProfile: 'index', messageLimit: 1 }, healthTimeoutMs)
      if (running !== turn || peer !== connection || turn.interrupting || turn.lastEventAt !== checkedAt) return
      if (Array.isArray(snapshot.runtime?.pendingRequestIds)) {
        if ([...answeredRequests].some(id => snapshot.runtime!.pendingRequestIds!.includes(id as RpcId))) {
          end('error', 'ZCode 仍在等待已经答复的审批或提问，应答未获 Agent 确认，连接已关闭；请重发任务继续。')
          disconnect()
          return
        }
        answeredRequests.clear()
      }
      if (snapshot.runtime && !snapshot.runtime.activeTurnId && ['idle', 'error', 'closed'].includes(snapshot.projection?.status ?? snapshot.session?.status as string)) {
        end('error', snapshot.projection?.lastError?.message ?? 'ZCode 已停止运行，但未收到本轮结束事件；请重发任务继续。')
      }
    } catch (error) {
      if (running !== turn || peer !== connection || turn.interrupting || turn.lastEventAt !== checkedAt) return
      if ((error as { code?: unknown }).code === -32601) {
        clearInterval(turn.healthTimer)
        return
      }
      end('error', 'ZCode 状态检查失败，无法确认任务进度，连接已关闭；请重发任务继续。')
      disconnect()
    } finally { turn.checking = false }
  }
  const startTool = (payload: ZcodePayload) => {
    const turn = running!
    const id = payload.toolCallId
    if (!id || turn.completedTools.has(id)) return
    if (payload.toolName) turn.names.set(id, payload.toolName)
    if (payload.parentToolCallId) turn.parents.set(id, payload.parentToolCallId)
    if (payload.input !== undefined) turn.inputs.set(id, payload.input)
    if (turn.tools.has(id)) {
      // A parent relation may arrive with the scheduled/started notification
      // after the input stream already opened the row; preserve it once.
      if (payload.parentToolCallId && !turn.parentEmitted.has(id) && !['result', 'error'].includes(payload.kind)) {
        turn.parentEmitted.add(id)
        emit({ type: 'tool', turnId: turn.id, callId: id, name: turn.names.get(id) ?? 'tool', phase: 'update', parentCallId: payload.parentToolCallId })
      }
      return
    }
    turn.tools.add(id)
    if (turn.parents.get(id)) turn.parentEmitted.add(id)
    emit({ type: 'tool', turnId: turn.id, callId: id, name: turn.names.get(id) ?? 'tool', phase: 'start',
      input: turn.inputs.get(id), brief: payload.schedule?.command ?? payload.schedule?.description,
      ...(turn.parents.get(id) ? { parentCallId: turn.parents.get(id) } : {}) })
  }
  const receive = ({ method, params = {} }: JsonRpcMessage<ZcodeParams>) => {
    // Known surfaces the receive does not consume stay silent; anything else
    // counts by category, with no name or payload retained.
    if (method !== 'session/event') {
      if (method !== undefined && !DECLARED.zcode.notifications[method]) coverage.count('unknown-notification')
      return
    }
    const event = params
    if (event.sessionId && event.sessionId !== sessionId) return
    if (event.type !== undefined && !DECLARED.zcode.variants[event.type]) coverage.count('unknown-variant')
    const payload: ZcodePayload = event.payload ?? {} as ZcodePayload
    const reported = zcodeContext(payload)
    if (reported) context = reported
    if (compaction && event.type === 'turn.completed') {
      const failed = payload.resultType !== 'success'
      const error = failed ? payload.error?.message ?? `ZCode compact ended: ${payload.resultType}` : undefined
      const { turnId } = compaction
      finishCompact(failed ? new Error(error) : undefined)
      // The SPI compaction contract (spi.js): an asynchronous compaction reports
      // its lifetime as a turn, so hosts waiting on turn/end are released.
      emit({ type: 'turn/end', turnId, reason: failed ? 'error' : 'done', ...(failed ? { error } : {}) })
      return
    }
    if (compaction && event.type === 'turn.failed') {
      const error = new Error(payload.error?.message ?? payload.message ?? 'ZCode compact failed')
      const { turnId } = compaction
      finishCompact(error)
      emit({ type: 'turn/end', turnId, reason: 'error', error: error.message })
      return
    }
    if (!running) return
    const turn = running
    if (event.type === 'turn.steerQueued' && turn.guides.has(payload.inputId ?? payload.queryId)) turn.guideIds.set(payload.pendingInputId, payload.inputId ?? payload.queryId)
    if (event.type === 'turn.steerDrained') {
      for (const inputId of payload.queryIds ?? []) turn.guides.delete(inputId)
      for (const id of payload.pendingInputIds ?? []) { turn.guides.delete(turn.guideIds.get(id)); turn.guideIds.delete(id) }
      for (const input of payload.drainedInputs ?? []) if (input.intent?.sourceCommandId) turn.guides.delete(input.intent.sourceCommandId)
    }
    if (event.type === 'model.streaming' && payload.kind === 'text_delta' && payload.delta) {
      if (!turn.messages.has(payload.assistantMessageId)) {
        if (turn.messages.size > 0) emit({ type: 'delta', turnId: turn.id, text: '\n' })
        turn.messages.add(payload.assistantMessageId)
      }
      turn.sawText = true
      emit({ type: 'delta', turnId: turn.id, text: payload.delta })
    }
    if (event.type === 'model.streaming' && payload.kind === 'reasoning_delta' && payload.delta) emit({ type: 'thinking', turnId: turn.id, text: payload.delta })
    if (event.type === 'model.streaming' && ['tool_input_start', 'tool_input_delta', 'tool_input_end', 'tool_call'].includes(payload.kind)) {
      const id = payload.toolCallId
      const existed = id ? turn.tools.has(id) : false
      startTool(payload)
      if (id && existed && !turn.completedTools.has(id)) {
        const base: Extract<DriverEvent, { type: 'tool' }> = { type: 'tool', turnId: turn.id, callId: id, name: turn.names.get(id) ?? payload.toolName ?? 'tool', phase: 'update',
          ...(turn.parents.get(id) ? { parentCallId: turn.parents.get(id) } : {}) }
        // The delta field is the model stream's own partial input JSON; it is a
        // character stream, not the final parsed input carried by tool_call.
        if (payload.kind === 'tool_input_delta' && typeof payload.delta === 'string' && payload.delta !== '') emit({ ...base, inputDelta: payload.delta })
        else if (payload.kind !== 'tool_input_start' && payload.input !== undefined) emit({ ...base, input: payload.input })
      }
    }
    if (event.type === 'session.closed') { end('error', 'ZCode 会话已关闭，本轮未正常结束。'); return }
    // Retries are the engine's own status: each announcement rides the
    // lifecycle channel (work-animation phase), never the text feed.
    const retry = payload._meta?.zcode?.apiRetry
    if ((event.type === 'session.updated' || event.type === 'streamRecovery.updated') && retry) {
      emit({ type: 'lifecycle', turnId: turn.id, kind: 'retry', phase: 'start',
        detail: `第 ${retry.attempt}/${retry.maxRetries} 次，等待 ${Math.ceil((retry.retryDelayMs ?? 0) / 1000)} 秒` })
    }
    if (event.type === 'tool.updated') {
      if (payload.kind === 'batch' || !payload.toolCallId || turn.completedTools.has(payload.toolCallId)) return
      startTool(payload)
      const parent = turn.parents.get(payload.toolCallId)
      if (payload.kind === 'progress') {
        // These are the source's own latest snapshots (tails/preview/byte
        // counts); repeated progress replaces the display facts, never appends.
        const progress = {
          ...(Number.isFinite(payload.elapsedMs) ? { elapsedMs: payload.elapsedMs } : {}),
          ...(typeof payload.stdoutTail === 'string' ? { stdoutTail: payload.stdoutTail } : {}),
          ...(typeof payload.stderrTail === 'string' ? { stderrTail: payload.stderrTail } : {}),
          ...(Number.isFinite(payload.stdoutBytes) ? { stdoutBytes: payload.stdoutBytes } : {}),
          ...(Number.isFinite(payload.stderrBytes) ? { stderrBytes: payload.stderrBytes } : {}),
          ...(Number.isFinite(payload.outputBytes) ? { outputBytes: payload.outputBytes } : {}),
          ...(typeof payload.outputPreview === 'string' ? { outputPreview: payload.outputPreview } : {}),
        }
        if (Object.keys(progress).length) emit({ type: 'tool', turnId: turn.id, callId: payload.toolCallId,
          name: turn.names.get(payload.toolCallId) ?? 'tool', phase: 'update', progress,
          ...(parent ? { parentCallId: parent } : {}) })
      }
      if (payload.result !== undefined || payload.kind === 'error') {
        turn.tools.delete(payload.toolCallId)
        turn.completedTools.add(payload.toolCallId)
        turn.parents.delete(payload.toolCallId)
        turn.parentEmitted.delete(payload.toolCallId)
        let input = turn.inputs.get(payload.toolCallId)
        if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = undefined } }
        const name = turn.names.get(payload.toolCallId)
        const path = ['Write', 'Edit'].includes(name as string) ? (input as { file_path?: unknown } | undefined)?.file_path : undefined
        turn.changes.add(payload.toolCallId, typeof path === 'string' ? [{ path, edit: { operation: name === 'Edit' ? 'update' : 'unknown' } }] : [],
          payload.kind === 'result' && payload.result?.success === true)
        emit({ type: 'tool', turnId: turn.id, callId: payload.toolCallId, name: turn.names.get(payload.toolCallId) ?? 'tool', phase: 'end',
          input: turn.inputs.get(payload.toolCallId), output: payload.result?.content ?? payload.result?.error ?? payload.error ?? payload.result,
          isError: payload.kind === 'error' || payload.result?.success === false, ...(parent ? { parentCallId: parent } : {}) })
      }
    }
    if (event.type === 'permission.resolved' || event.type === 'userInput.resolved') {
      if (event.type === 'permission.resolved' && payload.toolCallId && payload.modifiedInput !== undefined) turn.inputs.set(payload.toolCallId, payload.modifiedInput)
      const acknowledged = answeredRequests.delete(payload.requestId ?? payload.toolCallId)
      let matched = false
      for (const [id, request] of requests) if (request.params.requestId === payload.requestId) { matched = true; requests.delete(id); emit({ type: 'request/closed', id }) }
      // A resolution for an ask we never mapped means the engine settled it
      // outside this channel; surface it instead of dropping it silently.
      if (!matched && !acknowledged) emit({ type: 'request/stray', kind: event.type, requestId: payload.requestId })
    }
    if (event.type === 'turn.completed' && payload.resultType !== undefined) {
      const reason = payload.resultType === 'success' ? 'done' : payload.resultType === 'cancelled' ? 'interrupted' : 'error'
      if (reason === 'done' && !turn.sawText && payload.response) emit({ type: 'text', turnId: turn.id, text: payload.response })
      turn.final = typeof payload.response === 'string' ? payload.response : undefined
      turn.guides.delete(payload.inputId)
      turn.usage = addUsage(turn.usage, zcodeUsage(payload, context, grewCacheRead(payload.cacheStats?.cacheReadTokens)))
      const error = reason === 'error' ? payload.error?.message ?? `ZCode turn ended: ${payload.resultType}` : undefined
      if (reason === 'done' && turn.guides.size > 0) { turn.finished = { reason, error }; turn.sawText = false; return }
      end(reason, error, turn.usage)
    }
    if (event.type === 'turn.failed') end('error', payload.error?.message ?? payload.message ?? 'ZCode turn failed')
  }
  const ask = (message: JsonRpcRequest<ZcodeParams>) => {
    const { id, method, params = {} } = message
    if (!DECLARED.zcode.requests[method]) coverage.count('unknown-request')
    // Refusing runtime preferences makes the server apply its documented defaults.
    if (method === 'session/requestRuntimePreferences') return peer!.refuse(id)
    // Empty headers keep the protocol flowing; desktop-authenticated MCP tools
    // will surface their own auth errors when called.
    if (method === 'interaction/requestOfficialMcpAuthHeaders') return peer!.reply(id, { headers: {} })
    if (!running || (params.sessionId && params.sessionId !== sessionId)) return peer!.refuse(id, 'No matching active turn')
    const permission = method === 'interaction/requestPermission'
    if (method !== 'interaction/requestUserInput' && !permission) return peer!.refuse(id)
    if (permission && (!Array.isArray(params.options) || params.options.length === 0)) return peer!.refuse(id, 'No permission choices supplied')
    const cardId = `zcode:${sessionId}:${params.requestId ?? id}`
    requests.set(cardId, message as ZcodeRequest)
    // The approval panel renders only the reason line, so tool and risk level ride inside it.
    const label = permission ? [params.toolName, params.riskLevel ? `${params.riskLevel} risk` : null].filter(Boolean).join(' · ') : ''
    // AskUserQuestion arrives as `questions` ({question, header, options, multiSelect});
    // the protocol has no inputType/choices fields, and a prompt-only ask still becomes one card.
    const questions = permission ? null : (Array.isArray(params.questions) && params.questions.length > 0
      ? params.questions.map((item, index) => ({
        id: `q${index}`, question: item.question, header: item.header,
        ...(Array.isArray(item.options) ? { options: item.options.map(option => typeof option === 'string' ? { label: option }
          : { label: option.label ?? option.value, ...(option.description ? { description: option.description } : {}) }) } : {}),
        ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
      }))
      : [{ id: 'q0', question: params.prompt ?? 'ZCode asks for input' }])
    emit({
      type: 'request/opened', id: cardId, kind: permission ? 'permission' : 'question',
      ...(params.toolCallId ? { callId: params.toolCallId } : {}),
      tool: permission ? params.toolName ?? 'tool' : undefined,
      reason: permission ? [label && `${label}:`, params.reason].filter(Boolean).join(' ') || 'ZCode requests permission' : params.prompt ?? 'ZCode asks for input',
      detail: permission ? { riskLevel: params.riskLevel, options: params.options } : { questions },
    })
  }
  const boot = () => {
    if (ready) return ready
    let connection: JsonRpcPeer | undefined
    const pending = (async () => {
      if (disposed) throw new Error('ZCode driver disposed')
      validateWorkspace(cwd, true)
      const selection = parseZcodeModel(model)
      const executable = findZcodeExecutable(bin)
      if (!executable) throw new Error('ZCode executable not found. Install ZCode or edit the profile CLI path.')
      if (!identity) {
        const version = instructions ? await cliVersion(executable, { env, cwd }).catch(() => '') : ''
        if (disposed) throw new Error('ZCode driver disposed')
        identity = zcodeInstructions({ instructions, env, cwd, version, directory: instructionDir, identityFiles, identityOwner })
        coverage.setIdentity({ transport: 'legacy session/event', ...(version ? { cliVersion: version } : {}) })
      }
      identity.reset?.()
      emit({ type: 'session', state: 'starting' })
      connection = connectZcode({ executable, cwd, env: identity.env, onNotification: receive, onRequest: ask,
        onClose(error) {
          if (peer !== connection) return
          settleCompact(error)
          peer = null; ready = null; connected = false
          if (running?.started) end('error', error.message)
          emit({ type: 'session', state: 'closed' })
        } })
      if (disposed) { connection.dispose(); throw new Error('ZCode driver disposed') }
      peer = connection
      // The autonomy tier is the session's own permission mode; the engine
      // validates the enum strictly (plan/build/edit/yolo/guarded/auto).
      // `guarded` is the engine's own autonomy tier — edits and ordinary
      // commands run, only its recognized-dangerous commands ask — matching
      // the workspace-write tier; `edit` would still ask for every command,
      // and an unset tier keeps `build` (every change asks).
      const mode = permission === 'plan' ? 'plan' : permission === 'full' ? 'yolo'
        : permission === 'workspace' ? 'guarded' : 'build'
      let resumed = Boolean(sessionId)
      const createParams = { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode }
      const inherited = instructions ? zcodeMcpServers({ cwd: cwd!, env }) : []
      if (!inherited) identity.reason = 'mcp-config-not-representable'
      const roleServers = inherited ? roleMcp(instructions, identity.path, identity).map(server => ({ ...server, isolation: 'session', protocolVersion: 'legacy' })) : []
      const mcpServers = [...(inherited ?? []), ...roleServers]
      let attached = Boolean(roleServers.length)
      const attach = async (method: string, params: { sessionId?: string } | typeof createParams) => {
        try { return await peer!.request<SessionSnapshot>(method, { ...params, ...(mcpServers.length ? { mcpServers } : {}) }) }
        catch (error) {
          if (!mcpServers.length || (error as { code?: unknown }).code !== -32602 || !/unknown field\s+[`'"]?mcpServers\b/i.test((error as Error).message)) throw error
          attached = false
          identity!.reason = 'mcp-field-unsupported'
          return peer!.request<SessionSnapshot>(method, params)
        }
      }
      let result
      try { result = await attach(resumed ? 'session/resume' : 'session/create', resumed ? { sessionId } : createParams) }
      catch (error) {
        // ZCode does not persist a blank session until its first task.
        if (!resumed || !canRecreateEmpty || (error as { code?: unknown }).code !== -32004 || (error as Error).message !== `Session not found: ${sessionId}`) throw error
        canRecreateEmpty = false
        result = await attach('session/create', createParams)
        resumed = false
      }
      sessionId = result.session?.sessionId ?? result.sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('ZCode returned no session id')
      if (result.messages?.length) canRecreateEmpty = false
      context = zcodeContext(result) ?? context
      // session/resume has no mode parameter, so the profile's tier rides setMode.
      if (resumed) await peer.request('session/setMode', { sessionId, mode })
      if (selection) {
        // An object-form selection needs a thinking level, so the requested one is
        // used and a model's own default fills in when none was chosen.
        const level = thinking ?? selectionDefault(result, selection)
        await peer.request('session/setModel', { sessionId, model: { ...selection, ...(level ? { options: { reasoningLevel: level } } : {}) } })
      } else if (thinking) {
        await peer.request('session/setThoughtLevel', { sessionId, thoughtLevel: thinking })
      }
      await peer.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' })
      if (attached) await identity.install?.()
      if (disposed) throw new Error('ZCode driver disposed')
      connected = true
      emit({ type: 'session', state: 'ready', sessionId })
    })().catch(error => {
      // A failed boot cannot answer cards it opened mid-flight (running is set
      // before boot); close them so no reply can land on a later connection.
      if (peer === connection) { peer = null; connected = false; closeRequests(); connection?.dispose() }
      if (ready === pending) ready = null
      throw error
    })
    ready = pending
    return pending
  }

  return {
    get instructionMode() { return connected ? identity?.mode ?? 'none' : 'none' },
    get instructionTarget() { return identity?.target },
    get instructionFallback() { return identity?.reason },
    get coverage() { return coverage },
    openSession: boot,
    async sendTurn(text, images: (DriverImage & { name?: string })[] = []) {
      if (disposed) throw new Error('ZCode driver disposed')
      if (compaction) throw new Error('ZCode is compacting this session')
      if (running) throw new Error('ZCode already has a running turn')
      const turn: RunningTurn = running = { id: `zcode-${++sequence}`, started: false, messages: new Set(), tools: new Set(), completedTools: new Set(), names: new Map(), inputs: new Map(), parents: new Map(), parentEmitted: new Set(), guides: new Set(), guideIds: new Map(), sawText: false, settle: null } as RunningTurn
      turn.changes = createFileChanges(cwd)
      try {
        await boot()
        if (disposed || running !== turn) return turn.id
        const attachments = images.map(image => ({ kind: 'image', filename: image.name || 'image', mimeType: image.mediaType, dataBase64: image.data, sizeBytes: Buffer.from(image.data, 'base64').length }))
        canRecreateEmpty = false
        await peer!.request('session/send', { sessionId, content: String(text), ...(attachments.length > 0 ? { attachments } : {}) })
        if (running !== turn) return turn.id
        turn.started = true
        turn.lastEventAt = Date.now()
        turn.healthTimer = setInterval(() => { void checkHealth(turn) }, healthIntervalMs)
        turn.healthTimer.unref?.()
        turn.done = new Promise<void>(resolve => { turn.settle = resolve })
        emit({ type: 'turn/start', turnId: turn.id })
        return turn.id
      } catch (error) { if (running === turn) running = null; throw error }
    },
    // Compaction is a protocol method: the engine rewrites its own history.
    async compact() {
      if (disposed) throw new Error('ZCode driver disposed')
      await boot()
      if (running || compaction) throw new Error('ZCode already has a running turn or compaction')
      const completion = new Promise<void>((resolve, reject) => { compaction = { resolve, reject, turnId: `zcode-compact-${++sequence}`, started: false } })
      completion.catch(() => {})
      try {
        const result = await peer!.request<CompactResult>('session/compact', { sessionId })
        if (result.compact?.state && compaction) { (compaction as Compaction).started = true; emit({ type: 'turn/start', turnId: (compaction as Compaction).turnId }) }
        else finishCompact()
        await completion
        return result
      } catch (error) { finishCompact(error); throw error }
    },
    async steer(text) {
      const turn = running
      if (!turn?.started || compaction || disposed || turn.interrupting) return STEER.REFUSED
      const inputId = randomUUID()
      turn.guides.add(inputId)
      turn.v4Inputs = (turn.v4Inputs ?? 0) + 1
      let outcome: SteerOutcome = STEER.REFUSED
      try {
        const ack = await command('sendText', { text: String(text), requestedDelivery: 'guide' }, inputId)
        if (ack.status === 'accepted' && ack.result?.type === 'inputAccepted' && ack.result.inputId === inputId) {
          return STEER.STEERED
        }
      } catch (error) { outcome = steerFailed(error) }
      turn.v4Inputs--
      turn.guides.delete(inputId)
      if (running === turn && turn.guides.size === 0 && turn.finished) end(turn.finished.reason, turn.finished.error, turn.usage)
      return outcome
    },
    async interruptTurn() {
      const turn = running
      if (!turn) return
      if (turn.interrupting) return turn.done
      turn.interrupting = true
      const drop = () => { turn.unconfirmed = true; disconnect(); end('interrupted') }
      if (!turn.started) { drop(); return }
      try {
        if (turn.v4Inputs) {
          const ack = await command('stop', {}, undefined, 5000)
          if (!['accepted', 'noop'].includes(ack.status)) throw new Error('ZCode refused to stop')
        } else await peer!.request('session/stop', { sessionId }, 5000)
      }
      catch { drop(); return }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([turn.done, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
      clearTimeout(timer)
      if (running === turn) drop()
    },
    async respondToRequest(id, { decision, value } = {}) {
      const request = requests.get(id)
      if (!request || !peer) {
        // A reply that cannot land is the approval-loss seam; leave a trace
        // naming what was still pending so the race can be pinned afterwards.
        emit({ type: 'request/missed', id, connected: Boolean(peer), pending: [...requests.keys()] })
        return false
      }
      if (request.method === 'interaction/requestUserInput') {
        const answer = String(value ?? '').trim()
        if (!answer) throw new Error('Answer the question first')
        // AskUserQuestion answers are keyed by the question text; MCP elicitation
        // uses the same shape, a single question falls back to {answer}. Multi-question
        // cards answer as {qN: text|array}, keyed back onto each question's own text.
        const questions = Array.isArray(request.params.questions) ? request.params.questions : []
        const parts = questions.map(() => answer)
        if (questions.length > 1) {
          let values: Record<string, unknown>
          try { values = JSON.parse(answer) } catch { throw new Error('Answer each question using the form') }
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Answer each question using the form')
          questions.forEach((item, index) => {
            parts[index] = Array.isArray(values[`q${index}`]) ? (values[`q${index}`] as unknown[]).filter(Boolean).join('\n') : String(values[`q${index}`] ?? '').trim()
          })
          if (parts.some(part => !part)) throw new Error('Answer every question first')
        }
        const content = questions.length > 0
          ? { answers: Object.fromEntries(questions.map((item, index) => [item.question, parts[index]])) }
          : { answer }
        peer.reply(request.id, { action: 'accept', content })
      } else {
        if (!['allow', 'deny'].includes(decision as string)) return false
        const offered = (request.params.options ?? []).map(option => option.response?.decision)
        if (offered.length > 0 && !offered.includes(decision)) throw new Error('ZCode did not offer this permission decision')
        peer.reply(request.id, { decision })
      }
      requests.delete(id)
      const nativeId = request.params.requestId ?? request.params.toolCallId
      if (nativeId !== undefined) answeredRequests.add(nativeId)
      if (running) running.lastEventAt = Date.now()
      emit({ type: 'request/closed', id })
      return true
    },
    onEvent() { throw new Error('Pass onEvent to createZcodeDriver') },
    hasSession() { return connected },
    dispose() { disposed = true; end('interrupted'); disconnect(); identity?.dispose() },
  }
}

// The composer's /-menu inventory: the machine's shared skill directory and
// the installed plugin caches, the locations the CLI itself loads skills from.
// A plugin cache keeps every downloaded version; only the newest is listed.
export async function scanZcodeCommands({ engineOptions = {} }: EngineScanOptions = {}): Promise<SkillInventory> {
  validateZcodeOptions(engineOptions)
  const found = collector()
  const scanSkills = (dir: string, owner?: string, scope?: string) => {
    for (const path of listDirs(dir)) found.add(join(path, 'SKILL.md'), basename(path), owner, scope)
  }
  scanSkills(join(homedir(), '.agents', 'skills'))
  const cache = join(homedir(), '.zcode', 'cli', 'plugins', 'cache')
  for (const org of listDirs(cache)) for (const plugin of listDirs(org)) {
    const versions = listDirs(plugin).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (versions.length > 0) scanSkills(join(versions.at(-1)!, 'skills'), basename(plugin), 'plugin')
  }
  return found.list('ZCode skills')
}
