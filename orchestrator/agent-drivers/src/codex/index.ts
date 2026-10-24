import { readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { STEER, addUsage, steerFailed, usageOf } from '../spi.js'
import { jsonRpcProcess } from '../json-rpc-process.js'
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import { collector, listDirs } from '../skills.js'
import { createCoverage, DECLARED } from '../coverage.js'
import type { Coverage } from '../coverage.js'
import { connectCodex, ensureCodexWorkspace } from './native.js'
import { createFileChanges } from '../file-changes.js'
import type { FileChanges } from '../file-changes.js'
import type { Driver, DriverEvent, EngineInfo, Usage } from '../spi.js'
import type { JsonRpcMessage, JsonRpcRequest } from '../json-rpc-process.js'
import type { CodexPeer, RpcId } from './native.js'

type CodexOptions = { cwd?: string; engineOptions?: Record<string, unknown> }
type CodexEvent = DriverEvent | { type: 'delta' | 'text'; text: string; turnId?: string }
type DriverOptions = {
  onEvent?: (event: CodexEvent) => void
  bin?: string
  socket?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  model?: string
  thinking?: string
  permission?: 'plan' | 'workspace' | 'full'
  driverSessionId?: string
  name?: string
  sessionName?: string
  workspaceId?: string
  instructions?: string
}
type ConfigModel = { id?: string; label?: string; defaultThinking?: string }
type CodexModel = {
  model: string
  hidden?: boolean
  displayName?: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: { reasoningEffort: string }[]
  isDefault?: boolean
}
type ThreadResult = { thread: { id: string; projectId?: string } }
type CodexQuestion = { id: string; question: string; options?: unknown }
type CodexItem = {
  id: string
  type: string
  text?: string
  phase?: string
  kind?: string
  agentPath?: string
  agentThreadId?: unknown
  status?: string
  success?: boolean
  command?: string
  query?: string
  tool?: string
  path?: string
  savedPath?: string
  prompt?: string
  arguments?: unknown
  aggregatedOutput?: unknown
  result?: unknown
  error?: unknown
  contentItems?: unknown
  agentsStates?: unknown
  changes?: { path: string; kind?: { type?: string; move_path?: string }; diff?: string }[]
  summary?: unknown[]
  content?: unknown[]
}
type CodexParams = {
  threadId?: string
  requestId?: RpcId
  turnId?: string
  diff?: string
  plan?: { step: string; status?: string }[]
  explanation?: string
  willRetry?: boolean
  error?: { message?: string }
  itemId: string
  summaryIndex?: number
  contentIndex?: number
  delta: string
  message?: string
  item?: CodexItem
  tokenUsage?: { last?: { cachedInputTokens?: number; cacheWriteInputTokens?: number; inputTokens?: number; outputTokens?: number }; modelContextWindow?: number | null }
  turn?: { id: string; status?: string; error?: { message?: string } }
  questions: CodexQuestion[]
  reason?: string
  command?: string
  cwd?: string
  availableDecisions?: string[]
}
type CodexMessage = JsonRpcMessage<CodexParams>
type CodexRequest = JsonRpcRequest<CodexParams>
type RunningTurn = {
  id: string
  started: boolean
  compacting?: boolean
  texts: Map<string, string>
  thoughts: Map<string, { channel: 'summary' | 'content'; parts: Map<number, string> }>
  tools?: Map<string, string>
  changes?: FileChanges
  final?: string
  usage?: Usage
  unconfirmed?: boolean
  settle?: () => void
}

export const codexInfo = {
  id: 'codex', label: 'Codex CLI', command: 'codex', requiresCwd: true,
  description: 'Uses the local Codex CLI and its existing login and settings.',
  fields: [
    { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect codex; or enter an absolute path' },
    { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'Leave blank to use Codex settings' },
    { name: 'socket', target: 'engineOptions', label: 'Shared Codex socket (optional)', type: 'text', placeholder: 'Default shared daemon; or its absolute control socket path' },
  ],
  capabilities: { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] },
} satisfies EngineInfo

export function validateCodexOptions(raw: Record<string, unknown> = {}) {
  for (const key of Object.keys(raw)) if (!['bin', 'socket'].includes(key)) throw invalidConfig(`Unsupported Codex option: ${key}`)
  const bin = validateBin(raw.bin)
  if (raw.socket !== undefined && (typeof raw.socket !== 'string' || !raw.socket.startsWith('/') || raw.socket.includes('\0'))) throw invalidConfig('Codex socket must be an absolute path')
  return { ...(bin ? { bin } : {}), ...(raw.socket ? { socket: raw.socket } : {}) }
}

async function initialize(peer: CodexPeer) {
  const result = await peer.request<{ userAgent?: unknown }>('initialize', {
    clientInfo: { name: 'dsh_nodo', title: 'DSH Nodo', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  peer.notify('initialized')
  return result
}

export async function checkCodex({ cwd, engineOptions = {} }: CodexOptions = {}) {
  const checks = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: (error as Error).message }) }
  const options = validateCodexOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'codex')
  if (!executable) return { engine: 'codex', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'Codex executable not found. Enter its absolute path.' }] }
  let version
  try { version = await cliVersion(executable); checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` }) }
  catch { return { engine: 'codex', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  const peer = await connectCodex({ executable, socket: options.socket, start: false })
  try {
    await initialize(peer)
    checks.push({ label: 'Protocol', ok: true, message: 'Shared Codex app-server connected' })
    const account = await peer.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>('account/read', { refreshToken: false })
    const ready = account.account != null || account.requiresOpenaiAuth === false
    checks.push({ label: 'Authentication', ok: ready, message: ready ? 'Using existing Codex authentication/provider settings' : 'Sign in with codex login in your terminal, then check again.' })
  } catch {
    checks.push({ label: 'Protocol / authentication', ok: false, message: 'Could not check app-server. Verify the CLI version and existing settings in your terminal.' })
  } finally { peer.dispose() }
  return { engine: 'codex', ok: checks.every(check => check.ok), executable, version, checks }
}

// The reasoning efforts Codex documents; the config file carries no per-model
// list, so the file fallback offers these and marks the configured one.
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high']

// Targeted key scan of config.toml (not a TOML parser): the model and reasoning
// effort of the top-level table and of every [profiles.*] table.
function codexConfigModels(path: string) {
  let lines
  try { lines = readFileSync(path, 'utf8').split('\n') } catch { return [] }
  const entries: ConfigModel[] = []
  let table = ''
  let current: ConfigModel | undefined
  const flush = () => { if (current?.id) entries.push(current); current = undefined }
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim()
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) { flush(); table = section[1].trim(); continue }
    const pair = /^(model|model_reasoning_effort)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    const profile = /^profiles\.([^.]+)$/.exec(table)?.[1]
    if (table !== '' && profile === undefined) continue
    const value = (/^"(.*)"$/.exec(pair[2].trim())?.[1] ?? pair[2].trim())
    if (!/^[\w.:/-]{1,200}$/.test(value)) continue
    current ??= { id: undefined, ...(profile ? { label: profile } : {}) }
    if (profile !== undefined && pair[1] === 'model') { flush(); current = { id: value, label: profile }; continue }
    if (profile === undefined && pair[1] === 'model') current.id = value
    if (pair[1] === 'model_reasoning_effort') current.defaultThinking = value
  }
  flush()
  return entries.map(entry => ({ id: entry.id, ...(entry.label ? { label: entry.label } : {}),
    ...(entry.defaultThinking ? { defaultThinking: entry.defaultThinking } : {}), thinking: CODEX_EFFORTS.map(id => ({ id })) }))
}

export async function scanCodex({ engineOptions = {} }: CodexOptions = {}) {
  const options = validateCodexOptions(engineOptions)
  const configModels = () => {
    const models = codexConfigModels(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'))
    return { source: 'Codex config.toml', ...(models[0] ? { defaultModel: models[0].id } : {}), models }
  }
  const executable = findExecutable(options.bin ?? 'codex')
  if (!executable) return configModels()
  const peer = await connectCodex({ executable, socket: options.socket, start: true }).catch(() => null)
  if (!peer) return configModels()
  try {
    await initialize(peer)
    const data: CodexModel[] = []
    let cursor: string | undefined
    do {
      const page = await peer.request<{ data?: CodexModel[]; nextCursor?: string | null }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      data.push(...(page.data ?? []))
      cursor = page.nextCursor ?? undefined
    } while (cursor && data.length < 300)
    const models = data.filter(model => !model.hidden && typeof model.model === 'string' && model.model !== '').map(model => ({
      id: model.model,
      ...(typeof model.displayName === 'string' && model.displayName !== '' ? { label: model.displayName } : {}),
      ...(typeof model.defaultReasoningEffort === 'string' && model.defaultReasoningEffort !== '' ? { defaultThinking: model.defaultReasoningEffort } : {}),
      thinking: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
        .filter(option => typeof option?.reasoningEffort === 'string' && option.reasoningEffort !== '')
        .map(option => ({ id: option.reasoningEffort })),
    }))
    if (models.length === 0) return configModels()
    return { source: 'Codex app-server model/list', ...(data.find(model => model.isDefault)?.model ? { defaultModel: data.find(model => model.isDefault)!.model } : {}), models }
  } catch {
    return configModels()
  } finally { peer.dispose() }
}

// Models drift between the blocking question tool, its async variant and plain
// text, and older sessions carry failed attempts that teach the wrong habit.
// Only the blocking request_user_input reaches this client as a card.
const QUESTION_ROUTING = 'Asking the user questions: always use the request_user_input tool. Never use request_user_input_async — its questions never surface here — and never ask a question in plain text while request_user_input is available.'

export function createCodexDriver({ onEvent, bin = 'codex', socket, cwd, env = {}, model, thinking, permission, driverSessionId, name, sessionName, workspaceId, instructions }: DriverOptions = {}): Driver & { readonly instructionMode: string; readonly coverage: Coverage } {
  const emit = (event: CodexEvent) => { try { onEvent?.(event) } catch {} }
  let peer: CodexPeer | null = null
  let ready: Promise<void> | null = null
  let threadId = driverSessionId
  let connected = false
  let disposed = false
  let sequence = 0
  let instructionMode = 'none'
  let running: RunningTurn | null = null
  const requests = new Map<string, CodexRequest & { params: CodexParams }>()
  const coverage = createCoverage('codex')

  const closeRequests = () => {
    for (const id of requests.keys()) emit({ type: 'request/closed', id })
    requests.clear()
  }
  const end = (reason: 'done' | 'interrupted' | 'error', error?: string) => {
    if (!running) return
    const turn = running
    running = null
    closeRequests()
    if (!turn.compacting && turn.started) emit(turn.changes!.snapshot(turn.id))
    turn.settle?.()
    emit({ type: 'turn/end', turnId: turn.id, reason, ...(turn.final !== undefined ? { text: turn.final } : {}), ...(error ? { error } : {}), ...(turn.usage ? { usage: turn.usage } : {}), ...(turn.unconfirmed ? { unconfirmed: true } : {}) })
  }
  const start = (id: string) => {
    if (!running || running.started) return
    running.id = id
    running.started = true
    emit({ type: 'turn/start', turnId: id })
  }
  const thought = (itemId: string, channel: 'summary' | 'content', index: number, text: unknown, delta = false) => {
    if (typeof text !== 'string' || !text) return
    let item = running!.thoughts.get(itemId)
    if (!item) running!.thoughts.set(itemId, item = { channel, parts: new Map() })
    if (item.channel !== channel) return
    const previous = item.parts.get(index) ?? ''
    const suffix = delta ? text : text.startsWith(previous) ? text.slice(previous.length) : ''
    if (!suffix) return
    const separator = !item.parts.has(index) && item.parts.size ? '\n\n' : ''
    item.parts.set(index, previous + suffix)
    emit({ type: 'thinking', turnId: running!.id, text: separator + suffix })
  }
  const receive = ({ method, params = {} as CodexParams }: CodexMessage) => {
    // Notifications outside the declared schema count by category only; the
    // raw method name and payload go nowhere.
    if (method !== undefined && !DECLARED.codex.notifications[method]) { coverage.count('unknown-notification'); return }
    if (method === 'serverRequest/resolved') {
      for (const [id, request] of requests) if (request.id === params.requestId) { requests.delete(id); emit({ type: 'request/closed', id }) }
      return
    }
    if (!running || params.threadId !== threadId) return
    if (running.started && params.turnId && params.turnId !== running.id) return
    // turn ids come only from the driver's own turn/start result: a notification
    // can be a stale turn left over on the shared daemon, and adopting it here
    // would mis-attribute the turn the driver just sent.
    if (method === 'turn/diff/updated') running.changes?.diff(params.diff)
    // The structured plan notification is a whole-plan snapshot: every update
    // replaces the previous steps instead of appending to the transcript.
    if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      emit({ type: 'plan', turnId: running.id, ...(typeof params.explanation === 'string' && params.explanation !== '' ? { explanation: params.explanation } : {}),
        steps: params.plan.filter(step => typeof step?.step === 'string' && step.step !== '').map(step => ({
          text: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status === 'completed' ? 'completed' : 'pending' })) })
    }
    // A retry the engine itself announces; only willRetry=true maps here, a
    // final error stays with turn/completed. The wait has no end signal, so the
    // host shows it as a status line rather than an ongoing spinner.
    if (method === 'error' && params.willRetry === true) {
      emit({ type: 'lifecycle', turnId: running.id, kind: 'retry', phase: 'start', ...(typeof params.error?.message === 'string' && params.error.message ? { detail: params.error.message } : {}) })
    }
    if (method === 'thread/compacted') {
      emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' })
      if (running.compacting) end('done')
    }
    if (method === 'item/reasoning/summaryTextDelta') thought(params.itemId, 'summary', params.summaryIndex ?? 0, params.delta, true)
    if (method === 'item/reasoning/textDelta') thought(params.itemId, 'content', params.contentIndex ?? 0, params.delta, true)
    // Command output and MCP progress are declared deltas/messages of a tool
    // item that already started; a repeated delta has no source identity, so it
    // appends again rather than being guessed away. An item that ended is gone
    // from the map and cannot be revived by a late notification.
    if (method === 'item/commandExecution/outputDelta' && running.tools!.has(params.itemId) && typeof params.delta === 'string' && params.delta !== '') {
      emit({ type: 'tool', turnId: running.id, callId: params.itemId, name: running.tools!.get(params.itemId)!, phase: 'update', outputDelta: params.delta })
    }
    if (method === 'item/mcpToolCall/progress' && running.tools!.has(params.itemId) && typeof params.message === 'string' && params.message !== '') {
      emit({ type: 'tool', turnId: running.id, callId: params.itemId, name: running.tools!.get(params.itemId)!, phase: 'update', progress: { message: params.message } })
    }
    if (method === 'item/agentMessage/delta') {
      const previous = running.texts.get(params.itemId) ?? ''
      if (!running.texts.has(params.itemId) && running.texts.size > 0) emit({ type: 'delta', text: '\n' })
      running.texts.set(params.itemId, previous + params.delta)
      emit({ type: 'delta', turnId: running.id, text: params.delta })
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item ?? {} as CodexItem
      if (item.type === 'agentMessage' && method === 'item/completed') {
        const previous = running.texts.get(item.id)
        if (item.phase === 'final_answer' && typeof item.text === 'string' && item.text !== '') running.final = item.text
        if (previous === undefined) { running.texts.set(item.id, item.text ?? ''); emit({ type: 'text', text: item.text ?? '' }) }
        else if (item.text?.startsWith(previous) && item.text.length > previous.length) emit({ type: 'delta', text: item.text.slice(previous.length) })
      } else if (item.type === 'subAgentActivity') {
        // An engine-declared subagent record, not a tool call: its source ids
        // (id, agentThreadId) stay on the activity, and no parent is invented.
        const kind = item.kind
        emit({ type: 'activity', turnId: running.id, phase: method === 'item/started' ? 'start' : ['completed', 'interrupted'].includes(kind!) ? 'end' : 'update',
          entityId: item.id, name: 'subagent',
          ...(typeof item.agentPath === 'string' && item.agentPath !== '' ? { title: item.agentPath } : {}),
          ...(item.agentThreadId !== undefined && item.agentThreadId !== null ? { detail: `agentThreadId: ${item.agentThreadId}` } : {}),
          isError: kind === 'interrupted' })
      } else if (item.type === 'contextCompaction' && method === 'item/completed') {
        emit({ type: 'lifecycle', turnId: running.id, kind: 'compaction', phase: 'end' })
        if (running.compacting) end('done')
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageView', 'imageGeneration'].includes(item.type)) {
        if (method === 'item/started') running.tools!.set(item.id, item.type)
        else running.tools!.delete(item.id)
        if (item.type === 'fileChange' && method === 'item/completed') running.changes?.add(item.id, Array.isArray(item.changes) ? item.changes.map(change => {
          const moved = change?.kind?.type === 'update' && change.kind.move_path
          return { path: moved || change?.path, edit: { operation: moved ? 'move' : change?.kind?.type ?? 'unknown',
            ...(moved ? { fromPath: change.path } : {}), diffText: change?.diff } }
        }) : undefined, item.status === 'completed')
        // Viewed and generated images carry only a local path. Present it as a
        // bounded resource reference without dropping the item's own output.
        const path = item.type === 'imageView' ? item.path : item.type === 'imageGeneration' ? item.savedPath : undefined
        const picture = typeof path === 'string' && path !== ''
          ? [{ type: 'resource_link', name: path.split(/[\\/]/).filter(Boolean).pop() ?? 'image', uri: path }] : undefined
        const result = item.aggregatedOutput ?? item.result ?? item.error ?? item.contentItems ?? item.agentsStates ?? item.changes
        const output = picture ? result === undefined ? picture : [...Array.isArray(result) ? result : [result], ...picture] : result
        emit({ type: 'tool', turnId: running.id, callId: item.id, name: item.type, phase: method === 'item/started' ? 'start' : 'end',
          brief: item.command ?? item.query ?? item.tool ?? item.path,
          input: item.arguments ?? item.command ?? item.query ?? item.prompt ?? item.path ?? item.changes,
          ...(method === 'item/completed' ? { output,
            isError: item.type === 'fileChange' && item.status !== 'completed' || ['failed', 'declined'].includes(item.status!) || item.success === false || Boolean(item.error) } : {}) })
      } else if (item.type === 'reasoning' && method === 'item/completed') {
        const channel = running.thoughts.get(item.id)?.channel ?? (item.summary?.some(text => text) ? 'summary' : 'content')
        const parts = item[channel]?.length ? item[channel] : typeof item.text === 'string' ? [item.text] : []
        parts.forEach((text, index) => thought(item.id, channel, index, text))
      } else if (!DECLARED.codex.variants[item.type]) coverage.count('unknown-variant')
    }
    if (method === 'thread/tokenUsage/updated') {
      // The notification carries the request that just finished, so a turn that
      // ran several requests folds them one by one. Codex's inputTokens is the
      // whole prompt with the cached part included (Responses API semantics), so
      // the uncached bucket is what remains after both cache buckets.
      const last = params.tokenUsage?.last ?? {}
      const cacheReadTokens = last.cachedInputTokens ?? 0
      const cacheWriteTokens = last.cacheWriteInputTokens ?? 0
      const inputTokens = Math.max(0, (last.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens)
      running.usage = addUsage(running.usage, usageOf({
        inputTokens, outputTokens: last.outputTokens, cacheReadTokens, cacheWriteTokens,
        contextUsed: inputTokens + cacheReadTokens + cacheWriteTokens,
        contextSize: params.tokenUsage?.modelContextWindow ?? undefined,
      }))
      return
    }
    if (method === 'turn/completed' && running.started && params.turn?.id === running.id) {
      const status = params.turn?.status
      end(status === 'completed' ? 'done' : status === 'interrupted' ? 'interrupted' : 'error', params.turn?.error?.message)
    }
  }
  const ask = (message: CodexRequest) => {
    const { id, method, params = {} as CodexParams } = message
    const declared = DECLARED.codex.requests[method]
    if (!declared) coverage.count('unknown-request')
    if (!running || params.threadId !== threadId) return peer!.refuse(id, 'No matching active turn')
    const permission = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)
    const question = method === 'item/tool/requestUserInput'
    if (!permission && !question) {
      // A refusal reads as a decline, so a declared request this client cannot
      // surface still leaves a line instead of vanishing.
      if (declared) emit({ type: 'note', text: `Codex requested ${method}, which this client does not support; the request was declined.` })
      return peer!.refuse(id)
    }
    if (question && (!Array.isArray(params.questions) || params.questions.length === 0)) return peer!.refuse(id, 'No questions supplied')
    const cardId = `codex:${threadId}:${typeof id}:${id}`
    requests.set(cardId, message as CodexRequest & { params: CodexParams })
    emit({
      type: 'request/opened', id: cardId, kind: question ? 'question' : 'permission',
      tool: permission ? method.split('/')[1] : undefined,
      reason: question ? params.questions.map(item => item.question).join('\n') : params.reason ?? params.command ?? 'Codex requests permission',
      detail: question ? { questions: params.questions } : { command: params.command, cwd: params.cwd },
    })
  }
  const boot = () => {
    if (ready) return ready
    let connection: CodexPeer | undefined
    const pending = (async () => {
    if (disposed) throw new Error('Codex driver disposed')
    validateWorkspace(cwd, true)
    const executable = findExecutable(bin)
    if (!executable) throw new Error('Codex executable not found. Edit the profile CLI path or install the CLI separately.')
    emit({ type: 'session', state: 'starting' })
    connection = await connectCodex({ executable, cwd, env, socket,
      onNotification: receive, onRequest: ask,
      onClose(error) {
        if (peer !== connection) return
        connected = false; ready = null; closeRequests()
        if (running?.started) { running.unconfirmed = true; end('error', error.message) }
        emit({ type: 'session', state: 'closed' })
      },
    })
    if (disposed) { connection.dispose(); throw new Error('Codex driver disposed') }
    peer = connection
    const hello = await initialize(peer)
    // The daemon is shared, so the handshake's own agent string is the only
    // version the driver sees without a second process.
    const version = /(\d[\w.-]*)/.exec(typeof hello?.userAgent === 'string' ? hello.userAgent : '')?.[1]
    coverage.setIdentity({ transport: 'app-server proxy', ...(version ? { cliVersion: version } : {}) })
    workspaceId = await ensureCodexWorkspace(peer, { cwd: cwd!, name, workspaceId })
    const method = threadId ? 'thread/resume' : 'thread/start'
    const params = { ...(threadId ? { threadId } : { projectId: workspaceId, historyMode: 'paginated' }), cwd, ...(model ? { model } : {}) }
    // The autonomy tier rides the thread params: the sandbox bounds what the
    // engine may touch at all, `never` approval is what makes the top tier full.
    const extras = {
      ...(permission === 'plan' ? { sandbox: 'read-only' } : permission === 'full' ? { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        : permission === 'workspace' ? { sandbox: 'workspace-write' } : {}),
      ...(instructions ? { developerInstructions: `${instructions}\n\n${QUESTION_ROUTING}` } : {}),
    }
    let result: ThreadResult
    try {
      result = await peer.request<ThreadResult>(method, { ...params, ...extras })
      instructionMode = instructions ? 'native' : 'none'
    } catch (error) {
      if (!instructions || (error as { code?: unknown }).code !== -32602 || !/unknown field\s+[`'"]?developerInstructions\b/i.test((error as Error).message)) throw error
      const fallback = { ...extras }
      delete fallback.developerInstructions
      result = await peer.request<ThreadResult>(method, { ...params, ...fallback })
      instructionMode = 'none'
    }
    threadId = result.thread.id
    if (result.thread.projectId !== workspaceId) await peer.request('thread/metadata/update', { threadId, projectId: workspaceId })
    if (sessionName && !driverSessionId) await peer.request('thread/name/set', { threadId, name: `${name} · ${sessionName}` })
    if (disposed) throw new Error('Codex driver disposed')
    connected = true
    emit({ type: 'session', state: 'ready', sessionId: threadId, workspaceId })
    })().catch(error => {
      if (peer === connection) { peer = null; connected = false; connection?.dispose() }
      if (ready === pending) ready = null
      throw error
    })
    ready = pending
    return pending
  }

  return {
    get instructionMode() { return connected ? instructionMode : 'none' },
    get coverage() { return coverage },
    openSession: boot,
    async sendTurn(text, images = []) {
      if (disposed) throw new Error('Codex driver disposed')
      if (running) throw new Error('Codex already has a running turn')
      const turn: RunningTurn = running = { id: `starting-${++sequence}`, started: false, texts: new Map(), thoughts: new Map(), tools: new Map(), changes: createFileChanges(cwd) }
      try {
        await boot()
        if (disposed || running !== turn) return turn.id
        const input = [...(text === '' ? [] : [{ type: 'text', text: String(text), text_elements: [] }]), ...images.map(image => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` }))]
        const result = await peer!.request<{ turn: { id: string } }>('turn/start', { threadId, input, ...(thinking ? { effort: thinking } : {}) })
        if (running === turn) start(result.turn.id)
        return result.turn.id
      } catch (error) { if (running === turn) running = null; throw error }
    },
    async compact() {
      if (disposed) throw new Error('Codex driver disposed')
      if (running) throw new Error('Codex already has a running turn')
      const turn: RunningTurn = running = { id: `compact-${++sequence}`, started: false, compacting: true, texts: new Map(), thoughts: new Map() }
      try {
        await boot()
        if (disposed || running !== turn) return
        start(turn.id)
        const result = await peer!.request('thread/compact/start', { threadId })
        // thread/compacted settles the turn when the engine announces it; settle
        // here too so an engine that only resolves the request cannot wedge us.
        if (running === turn) end('done')
        return result
      } catch (error) { if (running === turn) end('error', (error as Error).message); throw error }
    },
    async steer(text) {
      if (!running?.started || running.compacting) return STEER.REFUSED
      try { await peer!.request('turn/steer', { threadId, expectedTurnId: running.id, input: [{ type: 'text', text: String(text), text_elements: [] }] }); return STEER.STEERED }
      catch (error) { return steerFailed(error) }
    },
    async interruptTurn() {
      const turn = running
      if (!turn) return
      if (!turn.started) { turn.unconfirmed = true; end('interrupted'); return }
      const done = new Promise<void>(resolve => { turn.settle = resolve })
      const drop = () => {
        turn.unconfirmed = true
        const current = peer
        peer = null; ready = null; connected = false
        current?.dispose()
        end('interrupted')
        if (current) emit({ type: 'session', state: 'closed' })
      }
      try { await peer!.request('turn/interrupt', { threadId, turnId: turn.id }, 5000) }
      catch { if (running === turn) drop(); return }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
      clearTimeout(timer)
      if (running === turn) drop()
    },
    respondToRequest(id, { decision, value } = {}) {
      const request = requests.get(id)
      if (!request || !peer) return Promise.resolve(false)
      let result
      if (request.method === 'item/tool/requestUserInput') {
        const questions = request.params.questions
        let values: Record<string, unknown>
        if (questions.length === 1) values = { [questions[0].id]: [String(value ?? '')] }
        else {
          try { values = JSON.parse(value!) } catch { return Promise.reject(new Error('Answer each question using the form')) }
        }
        if (!values || questions.some(question => {
          const answer = values[question.id]
          return answer == null || (Array.isArray(answer) ? answer.length === 0 || answer.some(text => !String(text).trim()) : !String(answer).trim())
        })) return Promise.reject(new Error('Answer every question first'))
        result = { answers: Object.fromEntries(questions.map(question => [question.id, { answers: Array.isArray(values[question.id]) ? (values[question.id] as unknown[]).map(String) : [String(values[question.id] ?? '')] }])) }
      } else {
        if (!['allow', 'deny'].includes(decision!)) return Promise.resolve(false)
        const chosen = decision === 'allow' ? 'accept' : 'decline'
        if (request.params.availableDecisions && !request.params.availableDecisions.includes(chosen)) return Promise.reject(new Error('This approval requires a decision not supported by this client'))
        result = { decision: chosen }
      }
      peer.reply(request.id, result)
      // The request is deleted above before the daemon's serverRequest/resolved
      // arrives, so the receive loop can no longer match it; the close must come
      // from here or the host keeps showing a settled card.
      requests.delete(id)
      emit({ type: 'request/closed', id })
      return Promise.resolve(true)
    },
    onEvent() { throw new Error('Pass onEvent to createCodexDriver') },
    hasSession() { return connected },
    dispose() { disposed = true; if (running) running.unconfirmed = true; end('interrupted'); const current = peer; peer = null; current?.dispose() },
  }
}

// The composer's /-menu inventory: the custom prompts and the installed plugin
// skills the CLI resolves, the latter by their plain names from each plugin's
// newest cached version.
export async function scanCodexCommands({ engineOptions = {} }: CodexOptions = {}) {
  validateCodexOptions(engineOptions)
  const found = collector()
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  let entries: Dirent[]
  try { entries = readdirSync(join(home, 'prompts'), { withFileTypes: true }) } catch { entries = [] }
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.md')) found.add(join(home, 'prompts', entry.name), entry.name.replace(/\.md$/, ''))
  const scanSkills = (dir: string) => {
    for (const path of listDirs(dir)) found.add(join(path, 'SKILL.md'), basename(path), undefined, 'plugin')
  }
  const cache = join(home, 'plugins', 'cache')
  for (const org of listDirs(cache)) for (const plugin of listDirs(org)) {
    const versions = listDirs(plugin).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (versions.length > 0) scanSkills(join(versions.at(-1)!, 'skills'))
  }
  return found.list('Codex prompts and plugin skills')
}
