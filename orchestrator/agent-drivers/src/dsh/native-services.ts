import type { PermissionMode } from '../spi.js'

type NativeResult<Value> = Value | Promise<Value>
type NativeSelection = { provider?: unknown; model?: unknown }
type NativeQuestion = { id: string; question: string; multiSelect?: unknown; options?: { label: string }[] }
type NativeTodo = { content?: unknown; status: string }
type NativeFile = { path?: string; binary?: boolean; oversized?: boolean }
type NativeHunk = { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown; [key: string]: unknown }
type NativeSession = {
  header: { cwd: string }
  snapshotEvents?(): ({ type: 'model/selection'; data: NativeSelection } | { type: 'request/header'; data: { header: { config: NativeSelection } } })[]
}
type NativeAgent = {
  session: NativeSession
  status: string
  whenIdle(): unknown
  ctx?: { systemPrompt?: { section?(spec: { name: string; order: number; text: string; interpolate: boolean }): () => void } }
}
type NativeCompaction = { compactNow(agent: NativeAgent, signal: AbortSignal): unknown } | { compactNow?: undefined }
type NativeRequest = { agent: NativeAgent; signal?: AbortSignal }
type NativeEvent<Data> = { seq?: unknown; data: { turn?: unknown } & Data }
type NativeSessionEvent =
  | ({ type: 'compaction/start' | 'compaction/end' } & NativeEvent<{ compactionId?: unknown; error?: unknown }>)
  | ({ type: 'turn/start' } & NativeEvent<{ turn: unknown }>)
  | ({ type: 'llm/retry' | 'llm/retry-started' } & NativeEvent<{ retryId?: unknown; retry?: unknown; maxRetries?: unknown; delayMs?: unknown; failure?: { message?: unknown } }>)
  | ({ type: 'todo/write' } & NativeEvent<{ todos?: NativeTodo[] }>)
  | ({ type: 'tool-workflow/run-start' | 'tool-workflow/run-end' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' } & NativeEvent<{ runId?: unknown; seq?: unknown; name?: unknown; label?: unknown; childId?: unknown }>)
  | ({ type: 'workspace/changes' } & NativeEvent<{ turn: unknown }>)
  | ({ type: 'assistant/message' } & NativeEvent<{ message: { content: { type: string; text: string }[] }; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>)
  | ({ type: 'tool/call' } & NativeEvent<{ callId: string; name: string; arguments: unknown }>)
  | ({ type: 'tool/result' } & NativeEvent<{ message: { toolCallId: string; content: unknown; isError?: boolean } }>)
  | ({ type: 'turn/end' } & NativeEvent<{ turn: unknown; reason: { kind: string; error?: { message: string } } }>)
type NativeServices = {
  permissionPresets: {
    names: string[]
    resolve?(name: string): { sandbox: string; approval: string }
    set(session: NativeSession, preset: string): unknown
    current(session: NativeSession): unknown
  }
  agentPresets: { serviceFor?(agent: NativeAgent, name: 'compaction'): NativeCompaction | undefined }
  compaction: NativeCompaction
  sessionProjections: { snapshot?(session: NativeSession | undefined, names: string[]): { values?: Record<string, Record<string, unknown> | undefined> } | undefined }
  agentDefaultModel: { currentSelection?(): { provider?: unknown; model?: unknown } | undefined }
  llm: {
    listProviders?(): NativeResult<{ id: string; name?: string }[] | undefined>
    listModels(provider: string): NativeResult<{ id: string; name?: string }[] | undefined>
    resolveModelInfo(provider: string, model: string): NativeResult<{ reasoning?: { efforts?: { id?: unknown; name?: unknown }[]; defaultEffort?: unknown } } | undefined>
  }
  workspaceChanges: {
    summary?(sessionId: string | undefined, seq: number): { turn: unknown; cwd: string; files: NativeFile[]; total: number } | undefined
    diff?(sessionId: string | undefined, seq: number, index: number, signal: AbortSignal): NativeResult<{ path: string; kind: string; hunks?: NativeHunk[]; coarse?: boolean } | undefined>
  }
}
export type DshNativeHost = {
  workspaceRegistry?: {
    create(cwd: string | undefined, name?: string): NativeResult<{ id: string }>
    resolveByPath(cwd: string | undefined): NativeResult<{ id: string } | undefined>
  }
  sessionController?: {
    create(options: { workspaceId?: string }): NativeResult<{ sessionId: string }>
    prompt(request: { requestId: string; sessionId?: string; mode: 'queue' | 'steer'; content: { type: string; text?: string; mediaType?: string; data?: string }[] }, signal: AbortSignal): unknown
    cancel(options: { sessionId?: string }): unknown
    rename(options: { sessionId?: string; title: string }): unknown
    resolveAgent(sessionId: string | undefined): NativeResult<{ error?: { message: string }; agent: NativeAgent }>
    selectModel(options: { sessionId?: string; provider: unknown; model: unknown; reasoningEffort?: string }): unknown
  }
  get?<Name extends keyof NativeServices>(name: Name): NativeServices[Name] | undefined
  on?(name: 'session/event', handler: (session: { id: string }, event: NativeSessionEvent) => unknown): () => void
  on?(name: 'agent/error', handler: (event: { agent: NativeAgent; turn?: unknown; error?: { message?: unknown } }) => unknown): () => void
  on?(name: 'approval/request', handler: (request: NativeRequest & { toolName: string; reason: string }, next: () => unknown) => unknown, options: { prepend: boolean }): () => void
  on?(name: 'user-questions/request', handler: (request: NativeRequest & { questions?: NativeQuestion[] }, next: () => unknown) => unknown, options: { prepend: boolean }): () => void
}
export type DshNativeRuntime = DshNativeHost & Required<Pick<DshNativeHost, 'workspaceRegistry' | 'sessionController' | 'get' | 'on'>>

const SANDBOXES = { plan: 'read-only', workspace: 'workspace-write', full: 'danger-full-access' }

export function nativeDshPermissions(host?: DshNativeHost): Partial<Record<PermissionMode, string>> {
  const service = host?.get?.('permissionPresets')
  if (typeof service?.resolve !== 'function' || typeof service?.set !== 'function') return {}
  return Object.fromEntries(Object.entries(SANDBOXES).flatMap(([tier, sandbox]) => {
    const preset = service.names.find(name => {
      const spec = service.resolve!(name)
      return spec.sandbox === sandbox && (tier !== 'full' || spec.approval === 'never')
    })
    return preset ? [[tier, preset]] : []
  }))
}

export function nativeDshCompaction(host?: DshNativeHost): NativeCompaction | undefined {
  const presets = host?.get?.('agentPresets')
  if (typeof presets?.serviceFor !== 'function') return host?.get?.('compaction')
  return {
    compactNow(agent, signal) {
      const service = presets.serviceFor!(agent, 'compaction')
      if (typeof service?.compactNow !== 'function') throw new Error('This DSH session preset has no native compaction service')
      return service.compactNow(agent, signal)
    },
  }
}
