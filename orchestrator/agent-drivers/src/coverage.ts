// ES-01 coverage index and bounded unknown-event tracking. The index distills
// the reviewed declarations (engine-stream, 2026-10-17 revision) into data: one
// status per declared discriminant, no payload schemas. It is the assertion
// source for coverage — driver branches are never read back as the declaration.
// Trackers count unknown discriminants by finite category only; the raw name
// and payload of an unknown event never reach a log, storage or this module.

export type CoverageStatus = 'mapped' | 'partial' | 'excluded' | 'unmapped'
export type CoverageCategory = 'unknown-notification' | 'unknown-request' | 'unknown-variant'
export type CoverageDeclaration = {
  revision: string
  closureOpen: boolean
  verified: { versions: string[]; protocol?: number }
  notifications: Readonly<Record<string, CoverageStatus>>
  requests: Readonly<Record<string, CoverageStatus>>
  variants: Readonly<Record<string, CoverageStatus>>
  openTypes?: number
}
export type CoverageIdentity = { transport?: string; protocolVersion?: string | number; cliVersion?: string; [key: string]: unknown }
export type CoverageSnapshot = {
  engine: string; scope: string; identity: CoverageIdentity | null; counts: Record<string, number>
  closureOpen: boolean; branchesConcluded: boolean
}
export interface Coverage {
  setIdentity(facts: CoverageIdentity): void
  count(category: string): void
  drain(): string[]
  snapshot(): CoverageSnapshot
}

export const STATUS = Object.freeze(['mapped', 'partial', 'excluded', 'unmapped'] as const)
export const CATEGORIES: readonly string[] = Object.freeze(['unknown-notification', 'unknown-request', 'unknown-variant'])
const MILESTONE = 50

// notifications/requests: wire methods or frame types. variants: the declared
// second-level enums (ACP sessionUpdate, claude system subtype, codex item
// type, zcode event tag). verified: the versions the review actually checked.
const INDEX: Record<string, CoverageDeclaration> = {
  acp: {
    revision: '2026-10-17 · SDK 1.4.0分发 · sources.json',
    closureOpen: true,
    verified: { versions: [], protocol: 1 },
    notifications: { 'session/update': 'partial' },
    requests: {
      'session/request_permission': 'partial', 'elicitation/create': 'partial',
      'fs/read_text_file': 'unmapped', 'fs/write_text_file': 'unmapped',
      'terminal/create': 'unmapped', 'terminal/output': 'unmapped', 'terminal/wait_for_exit': 'unmapped',
      'terminal/kill': 'unmapped', 'terminal/release': 'unmapped',
    },
    variants: {
      user_message_chunk: 'unmapped', agent_message_chunk: 'partial', agent_thought_chunk: 'partial',
      tool_call: 'partial', tool_call_update: 'partial', usage_update: 'partial',
      plan: 'mapped', plan_update: 'partial', plan_removed: 'mapped',
      available_commands_update: 'unmapped', current_mode_update: 'unmapped', config_option_update: 'unmapped',
      session_info_update: 'partial', compaction_update: 'mapped', compaction_summary_chunk: 'unmapped',
    },
  },
  claude: {
    revision: '2026-10-26 · 本机 2.1.310 探针 · 官方SDK reference 2.1.301',
    closureOpen: true,
    verified: { versions: ['2.1.301', '2.1.310'] },
    notifications: {
      assistant: 'partial', user: 'partial', result: 'partial', stream_event: 'partial',
      tool_progress: 'partial', auth_status: 'unmapped', rate_limit_event: 'unmapped',
      tool_use_summary: 'unmapped', prompt_suggestion: 'unmapped', conversation_reset: 'unmapped',
    },
    requests: { can_use_tool: 'partial' },
    variants: {
      init: 'partial', compact_boundary: 'partial', status: 'mapped', api_retry: 'mapped', local_command_output: 'unmapped',
      hook_started: 'unmapped', hook_progress: 'unmapped', hook_response: 'unmapped', plugin_install: 'unmapped',
      task_notification: 'mapped', task_started: 'mapped', task_progress: 'mapped', task_updated: 'mapped',
      background_tasks_changed: 'unmapped', thinking_tokens: 'unmapped', session_state_changed: 'unmapped',
      worker_shutting_down: 'unmapped', commands_changed: 'unmapped', files_persisted: 'unmapped',
      permission_denied: 'unmapped', informational: 'unmapped',
    },
    // Declared in the SDK union but with no standalone section: notification,
    // memory recall, elicitation complete, mirror error. Their wire
    // type strings are unknown, so they cannot be classified at runtime and
    // count as unknown notifications if they ever appear.
    openTypes: 4,
  },
  qoder: {
    revision: '2026-10-22 · 本机 qodercli 1.1.76 探针 · protocol 1.5.0',
    closureOpen: true,
    verified: { versions: ['1.1.76'] },
    notifications: {
      assistant: 'partial', user: 'partial', result: 'partial', system: 'partial',
    },
    requests: { can_use_tool: 'partial' },
    variants: {
      init: 'partial', status: 'mapped', compact_boundary: 'partial', api_retry: 'mapped',
      task_started: 'mapped', task_progress: 'mapped', task_notification: 'mapped',
      permission_denied: 'unmapped', hook_started: 'unmapped', hook_response: 'unmapped', artifacts_update: 'unmapped',
    },
  },
  pi: {
    revision: '2026-10-22 · 本机 pi 1.4.0 探针 · 包内 docs 1.4.0',
    closureOpen: true,
    verified: { versions: ['1.4.0'] },
    notifications: {
      agent_settled: 'mapped', message_update: 'partial', message_end: 'partial', message_start: 'partial',
      tool_execution_start: 'partial', tool_execution_update: 'partial', tool_execution_end: 'partial',
      compaction_start: 'partial', compaction_end: 'partial', auto_retry_start: 'partial', auto_retry_end: 'partial',
      agent_start: 'excluded', agent_end: 'excluded', turn_start: 'excluded', turn_end: 'excluded',
      queue_update: 'unmapped', entry_appended: 'unmapped', session_info_changed: 'unmapped',
      thinking_level_changed: 'unmapped', bash_execution_update: 'unmapped', extension_error: 'unmapped',
      summarization_retry_scheduled: 'unmapped', summarization_retry_attempt_start: 'unmapped', summarization_retry_finished: 'unmapped',
    },
    requests: { extension_ui_request: 'partial' },
    variants: {
      text_delta: 'mapped', thinking_delta: 'mapped',
      toolcall_start: 'partial', toolcall_delta: 'partial', toolcall_end: 'partial',
      start: 'excluded', done: 'excluded', error: 'excluded', text_start: 'excluded', text_end: 'excluded',
      thinking_start: 'excluded', thinking_end: 'excluded',
    },
  },
  codex: {
    revision: '2026-10-17 · 本机 0.159.2 stable+experimental schema',
    closureOpen: true,
    verified: { versions: ['0.159.2'] },
    notifications: {
      'serverRequest/resolved': 'partial', 'thread/tokenUsage/updated': 'partial', 'turn/started': 'partial',
      'turn/completed': 'partial', 'item/started': 'partial', 'item/completed': 'partial',
      'item/agentMessage/delta': 'partial', 'item/reasoning/summaryTextDelta': 'partial', 'item/reasoning/textDelta': 'partial',
      error: 'partial', 'thread/started': 'unmapped', 'thread/status/changed': 'unmapped', 'thread/archived': 'unmapped',
      'thread/deleted': 'unmapped', 'thread/unarchived': 'unmapped', 'thread/closed': 'unmapped', 'thread/reverted': 'unmapped',
      'skills/changed': 'unmapped', 'thread/name/updated': 'unmapped', 'thread/attachment/updated': 'unmapped',
      'thread/goal/updated': 'unmapped', 'thread/goal/cleared': 'unmapped', 'thread/queue/changed': 'unmapped',
      'project/changed': 'unmapped', 'thread/project/updated': 'unmapped', 'thread/environment/connected': 'unmapped',
      'thread/environment/disconnected': 'unmapped', 'thread/settings/updated': 'unmapped',
      'hook/started': 'unmapped', 'hook/completed': 'unmapped', 'turn/diff/updated': 'partial', 'turn/plan/updated': 'mapped',
      'item/autoApprovalReview/started': 'unmapped', 'item/autoApprovalReview/completed': 'unmapped',
      'autoApprovalReview/strictReviewRequired': 'unmapped', 'item/plan/delta': 'unmapped',
      'command/exec/outputDelta': 'unmapped', 'process/outputDelta': 'unmapped', 'process/exited': 'unmapped',
      'item/commandExecution/outputDelta': 'partial', 'item/commandExecution/terminalInteraction': 'unmapped',
      'item/fileChange/outputDelta': 'unmapped', 'item/fileChange/patchUpdated': 'unmapped',
      'item/mcpToolCall/progress': 'partial', 'mcpServer/oauthLogin/completed': 'unmapped',
      'mcpServer/startupStatus/updated': 'unmapped', 'mcpServer/event/stream/notification': 'unmapped',
      'account/updated': 'unmapped', 'account/gatewayOAuth/changed': 'unmapped', 'account/rateLimits/updated': 'unmapped',
      'account/login/completed': 'unmapped', 'app/list/updated': 'unmapped', 'remoteControl/status/changed': 'unmapped',
      'externalAgentConfig/import/progress': 'unmapped', 'externalAgentConfig/import/completed': 'unmapped',
      'fs/changed': 'unmapped', 'item/reasoning/summaryPartAdded': 'unmapped',
      'model/rerouted': 'unmapped', 'model/verification': 'unmapped', 'modelProvider/authRecoveryStarted': 'unmapped',
      'modelProvider/authRecoveryCompleted': 'unmapped', 'turn/moderationMetadata': 'unmapped',
      'model/safetyBuffering/updated': 'unmapped', warning: 'unmapped', guardianWarning: 'unmapped',
      deprecationNotice: 'unmapped', configWarning: 'unmapped', 'fuzzyFileSearch/sessionUpdated': 'unmapped',
      'fuzzyFileSearch/sessionCompleted': 'unmapped', 'thread/realtime/started': 'unmapped', 'thread/realtime/itemAdded': 'unmapped',
      'thread/realtime/item/started': 'unmapped', 'thread/realtime/item/transcript/delta': 'unmapped',
      'thread/realtime/item/completed': 'unmapped', 'thread/realtime/transcript/delta': 'unmapped',
      'thread/realtime/transcript/done': 'unmapped', 'thread/realtime/outputAudio/delta': 'unmapped',
      'thread/realtime/sdp': 'unmapped', 'thread/realtime/error': 'unmapped', 'thread/realtime/closed': 'unmapped', 'thread/compacted': 'partial',
      'windows/worldWritableWarning': 'unmapped', 'windowsSandbox/setupCompleted': 'unmapped',
    },
    requests: {
      'item/commandExecution/requestApproval': 'partial', 'item/fileChange/requestApproval': 'partial',
      'item/tool/requestUserInput': 'partial', 'mcpServer/elicitation/request': 'unmapped',
      'item/permissions/requestApproval': 'unmapped', 'item/tool/call': 'unmapped',
      'account/chatgptAuthTokens/refresh': 'unmapped', 'attestation/generate': 'unmapped',
      'currentTime/read': 'unmapped', applyPatchApproval: 'unmapped', execCommandApproval: 'unmapped',
    },
    variants: {
      agentMessage: 'partial', reasoning: 'partial', commandExecution: 'partial', fileChange: 'partial',
      mcpToolCall: 'partial', dynamicToolCall: 'partial', collabAgentToolCall: 'partial',
      webSearch: 'partial', imageView: 'partial', imageGeneration: 'partial',
      userMessage: 'unmapped', hookPrompt: 'unmapped', functionCallOutput: 'unmapped', plan: 'unmapped',
      sleep: 'unmapped', enteredReviewMode: 'unmapped', exitedReviewMode: 'unmapped', contextCompaction: 'partial',
      subAgentActivity: 'mapped',
    },
  },
  zcode: {
    revision: '2026-10-19 · 安装包 0.16.9/0.17.0 legacy · V4另表',
    closureOpen: true,
    verified: { versions: ['0.16.9', '0.17.0'] },
    notifications: {
      'session/event': 'partial', 'state.updated': 'unmapped', 'computer-use/operation-event': 'unmapped',
      startup: 'unmapped', frame: 'unmapped',
    },
    requests: {
      'interaction/requestPermission': 'partial', 'interaction/requestUserInput': 'partial',
      'interaction/requestOfficialMcpAuthHeaders': 'partial', 'session/requestRuntimePreferences': 'partial',
      'automation/checkTaskBinding': 'unmapped', 'automation/create': 'unmapped', 'automation/delete': 'unmapped',
      'automation/list': 'unmapped', 'automation/update': 'unmapped', 'bot/channel/reply': 'unmapped',
      'interaction/browserExecute': 'unmapped', 'interaction/browserList': 'unmapped',
      'interaction/requestProviderRuntimeHeaders': 'unmapped', 'offPeak/create': 'unmapped', 'offPeak/list': 'unmapped',
      'subagents/readRuntimeConfig': 'unmapped', 'topic/resource/cancel': 'unmapped', 'topic/resource/read': 'unmapped',
    },
    variants: {
      'session.updated': 'partial', 'turn.started': 'partial', 'turn.steerQueued': 'partial', 'turn.steerDrained': 'partial',
      'turn.completed': 'partial', 'turn.failed': 'partial', 'model.streaming': 'partial', 'tool.updated': 'partial',
      'permission.resolved': 'partial', 'userInput.resolved': 'partial',
      'session.created': 'unmapped', 'session.resumed': 'unmapped', 'session.titleUpdated': 'unmapped', 'session.closed': 'unmapped',
      'message.upserted': 'unmapped', 'message.removed': 'unmapped', 'part.started': 'unmapped', 'part.delta': 'unmapped',
      'part.upserted': 'unmapped', 'part.removed': 'unmapped', 'permission.requested': 'unmapped',
      'userInput.requested': 'unmapped', 'checkpoint.created': 'unmapped', 'rewind.triggered': 'unmapped',
      'streamRecovery.updated': 'unmapped',
    },
  },
  'dsh-native': {
    revision: '2026-10-22 · CLI分发 0.2.0-rc.2/0.2.1-rc.2 · Desktop运行版未探测',
    closureOpen: true,
    verified: { versions: ['0.2.0-rc.2', '0.2.1-rc.2'] },
    notifications: {
      'assistant/message': 'partial', 'tool/call': 'partial', 'tool/result': 'partial', 'turn/start': 'partial', 'turn/end': 'partial',
      'agent-preset/selected': 'unmapped', 'agent/inbox/spliced': 'unmapped', 'approval/asked': 'unmapped',
      'approval/decided': 'unmapped', 'approval/policy': 'unmapped', 'assistant/attempt': 'unmapped',
      'command/done': 'unmapped', 'command/run': 'unmapped', 'compaction/end': 'mapped', 'compaction/prune': 'unmapped',
      'compaction/start': 'mapped', 'compaction/summary': 'unmapped', 'deliverables/presented': 'unmapped',
      'developer/message': 'unmapped', 'feedback/message-delete': 'unmapped', 'feedback/message-put': 'unmapped',
      'feedback/record': 'unmapped', 'goal/change': 'unmapped', 'hook/invoked': 'unmapped', 'hook/result': 'unmapped',
      'image/offload': 'unmapped', 'job/registered': 'unmapped', 'job/settled': 'unmapped',
      'llm/retry': 'mapped', 'llm/retry-started': 'mapped', 'model/selection': 'unmapped',
      'permission/preset': 'unmapped', 'plan/mode': 'unmapped', 'request/context': 'unmapped', 'request/header': 'unmapped',
      'sandbox/mode': 'unmapped', 'schedule/change': 'unmapped', 'session-log-deepseek/delivery-accepted': 'unmapped',
      'session/end-seed': 'unmapped', 'session/title': 'unmapped', 'session/title-llm-request': 'unmapped',
      'step/end': 'unmapped', 'step/start': 'unmapped', 'subagent/catalog': 'unmapped', 'subagent/descriptor': 'unmapped',
      'subagent/model-selection-policy': 'unmapped', 'system/message': 'unmapped', 'team/member': 'unmapped',
      'team/message/delivered': 'unmapped', 'team/message/queued': 'unmapped', 'team/task': 'unmapped', 'todo/write': 'mapped',
      'tool-workflow/agent-end': 'partial', 'tool-workflow/agent-start': 'mapped', 'tool-workflow/run-end': 'partial',
      'tool-workflow/run-start': 'mapped', 'tool/ptc-dispatch': 'unmapped', 'tool/ptc-dispatch-start': 'unmapped',
      'user/message': 'unmapped', 'web/deepseek-search-llm-request': 'unmapped',
      'working-directory/change': 'unmapped', 'workspace/changes': 'partial',
    },
    requests: { 'approval/request': 'partial', 'user-questions/request': 'partial', 'agent/error': 'partial' },
    variants: {},
  },
}

for (const entry of Object.values(INDEX)) for (const channel of ['notifications', 'requests', 'variants'] as const) entry[channel] = Object.freeze(entry[channel])
export const DECLARED = Object.freeze(Object.fromEntries(Object.entries(INDEX).map(([engine, entry]) => [engine, entry])))

const branchesConcluded = (entry: CoverageDeclaration) => Object.values(entry.notifications).every(status => STATUS.includes(status))
  && Object.values(entry.requests).every(status => STATUS.includes(status))
  && Object.values(entry.variants).every(status => STATUS.includes(status))

/** One tracker per driver instance, so counts never cross sessions. */
export function createCoverage(engine: string, scope = engine): Coverage {
  const entry = INDEX[scope]
  if (!entry) throw new Error(`No coverage index for scope ${scope}`)
  const counts = new Map<string, number>()
  const nextMilestone = new Map<string, number>()
  const pending = new Set<string>()
  let identity: CoverageIdentity | null = null
  let identityReported = false
  return {
    setIdentity(facts) { identity = { ...facts } },
    count(category) {
      if (!CATEGORIES.includes(category)) return
      const total = (counts.get(category) ?? 0) + 1
      counts.set(category, total)
      if (total >= (nextMilestone.get(category) ?? 1)) {
        pending.add(category)
        nextMilestone.set(category, Math.floor(total / MILESTONE) * MILESTONE + MILESTONE)
      }
    },
    // Lines the host warns once per status transition: the identity summary
    // once, then at most one bounded line per category per drain.
    drain() {
      const lines = []
      if (identity && !identityReported) {
        identityReported = true
        const match = identity.cliVersion
          ? entry.verified.versions.includes(identity.cliVersion) ? 'verified' : 'unverified'
          : 'unverified (version unknown)'
        lines.push(`nodo coverage: ${engine} ${identity.transport ?? ''}${identity.protocolVersion ? ` protocol ${identity.protocolVersion}` : ''} cli ${identity.cliVersion ?? 'unknown'} — ${match}; index ${entry.closureOpen ? 'open' : 'closed'}`)
      }
      for (const category of pending) lines.push(`nodo coverage: ${engine} ${category} total ${counts.get(category)}`)
      pending.clear()
      return lines
    },
    snapshot() {
      return {
        engine, scope, identity, counts: Object.fromEntries(counts),
        closureOpen: entry.closureOpen, branchesConcluded: branchesConcluded(entry),
      }
    },
  }
}
