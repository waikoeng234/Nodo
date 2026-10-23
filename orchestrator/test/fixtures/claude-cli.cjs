#!/usr/bin/env node
// Local executable fixture: Claude Code stream-json wire without model/network/auth.
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const log = entry => appendFileSync('claude-requests.jsonl', JSON.stringify(entry) + '\n')
if (process.argv.includes('--version')) { console.log('claude-cli fixture'); process.exit(0) }
const arg = name => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1] }
const session = 'fixture-claude-session'
// The initialize control response's model table, in the shape the real CLI
// writes: alias value, resolved versioned id, display name, per-model efforts.
const fixtureModels = [
  { value: 'opus', resolvedModel: 'claude-opus-9-9', displayName: 'Opus 9.9', description: 'Fixture opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-9-9', displayName: 'Sonnet 9.9', description: 'Fixture sonnet', supportedEffortLevels: ['medium'] },
  { value: 'claude-haiku-4-5', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fixture haiku' },
]
let turn = 0
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const delta = (id, text) => send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }, session_id: session })
// One request's usage on the assistant frame (the prompt side is what the
// context window is measured against) and the turn's accumulated usage on the
// result frame, with the routed model's window beside it — the shapes Claude Code
// writes for a real model call.
const requestUsage = { input_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 45 }
const turnUsage = { input_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 90 }
const modelUsage = { 'fixture-model': { inputTokens: 300, outputTokens: 90, cacheReadInputTokens: 900, cacheCreationInputTokens: 100, contextWindow: 200000, maxOutputTokens: 32000 } }
const say = (text, extra = {}) => {
  delta('m' + turn, text.slice(0, 3))
  delta('m' + turn, text.slice(3))
  send({ type: 'assistant', message: { id: 'm' + turn, role: 'assistant', content: [{ type: 'text', text }], usage: requestUsage }, session_id: session })
  send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text, usage: turnUsage, modelUsage, ...extra })
}
const toolResult = (id, name, isError) => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'denied' : 'done', is_error: isError }] }, session_id: session })
const control = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const init = () => send({ type: 'system', subtype: 'init', session_id: session, claude_code_version: '9.9.9-fixture', model: arg('--model') ?? 'fixture-model', permissionMode: 'default', tools: [], mcp_servers: [], slash_commands: [],
  capabilities: process.env.CLAUDE_FIXTURE_STEERING ? ['request_marker_lists_v1', 'interrupt_cancel_queued_v1', 'interrupt_send_now_v1'] : [] })
let initialized = !process.env.CLAUDE_FIXTURE_DELAY_INIT
if (process.env.CLAUDE_FIXTURE_NOISE) send({ type: 'future_frame', session_id: session })
if (initialized) init()
log({ spawn: process.argv.slice(1), instructions: arg('--append-system-prompt'), effort: arg('--effort'), model: arg('--model'), permissionMode: arg('--permission-mode'), resume: arg('--resume') })
let pending = null // can_use_tool awaiting the host decision
const receive = line => {
  const frame = JSON.parse(line)
  if (frame.type === 'control_response') {
    if (pending && frame.response?.request_id === pending.id) {
      const decision = pending
      pending = null
      if (decision.tool === 'AskUserQuestion') {
        const answers = frame.response?.response?.updatedInput?.answers ?? {}
        say('Answered ' + Object.values(answers).join(','))
      } else if (frame.response?.response?.behavior === 'allow') {
        send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: decision.tool } }, session_id: session })
        toolResult('tool-1', decision.tool, false)
        say('Allowed')
      } else {
        send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: decision.tool } }, session_id: session })
        toolResult('tool-1', decision.tool, true)
        say('Denied')
      }
    }
    return
  }
  if (frame.type === 'control_request') {
    log({ control: frame.request?.subtype, ...(frame.request?.cancel_queued ? { cancel_queued: true } : {}) })
    if (frame.request?.subtype === 'interrupt') {
      if (process.env.CLAUDE_FIXTURE_INTERRUPT_SILENT) return
      control(frame.request_id, { still_queued: [] }); send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session })
    }
    else control(frame.request_id, process.env.CLAUDE_FIXTURE_NO_MODELS ? { commands: [] } : { commands: [], models: fixtureModels })
    return
  }
  if (frame.type !== 'user') return
  if (!initialized) { initialized = true; init() }
  const text = frame.message?.content?.find(block => block.type === 'text')?.text ?? ''
  log({ user: text })
  if (frame.priority) {
    log({ steer: text, priority: frame.priority, uuid: frame.uuid })
    if (!['now', 'later'].includes(frame.priority) || !frame.uuid) process.exit(8)
    send({ type: 'result', subtype: 'error_during_execution', queued_turn_count: 1, user_message_uuids: ['original'], session_id: session, usage: turnUsage })
    if (process.env.CLAUDE_FIXTURE_STEER_HOLD) return
    return setTimeout(() => say('Steered ' + text, { user_message_uuids: [frame.uuid], queued_turn_count: 0 }), 50)
  }
  turn++
  if (text.startsWith('HANDOFF ')) {
    const [, tag, outcome] = text.split(' ')
    return setTimeout(() => {
      delta('progress-' + turn, `Progress ${tag}`)
      send({ type: 'assistant', session_id: session, message: { id: 'progress-' + turn, content: [{ type: 'text', text: `Progress ${tag}` }] } })
      say(`Final ${tag}`, outcome === 'error' ? { subtype: 'error_during_execution', is_error: true } : {})
    }, 30)
  }
  if (text === 'FILES_FLOW') {
    const start = (id, name, input) => send({ type: 'assistant', session_id: session, message: { id: 'files-' + id, content: [{ type: 'tool_use', id, name, input }] } })
    const result = (id, output, extra = {}, is_error = false) => send({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'tool finished' }] }, tool_use_result: output, ...extra })
    for (let i = 0; i < 10; i++) {
      const filePath = process.cwd() + '/.agent/文件 ' + i + '.txt'
      start('write-' + i, 'Write', { file_path: filePath, content: 'proposed' })
      const output = { type: i ? 'create' : 'update', filePath, content: 'confirmed ' + i, originalFile: null, structuredPatch: [], userModified: true }
      if (!i) result('write-' + i, { ...output, filePath: '/foreign' }, { isReplay: true })
      result('write-' + i, output)
      result('write-' + i, output)
    }
    for (const id of ['failed', 'staged', 'foreign', 'unknown', 'mismatch']) {
      const filePath = process.cwd() + '/' + id
      start(id, 'Write', { file_path: filePath, content: 'proposed' })
      result(id, id === 'unknown' ? 'future output shape' : { type: 'create', filePath: id === 'mismatch' ? '/other-path' : filePath, content: 'after', originalFile: null, staged: id === 'staged' },
        id === 'foreign' ? { session_id: 'other-session' } : {}, id === 'failed')
    }
    start('bash', 'Bash', { command: 'printf x > /tmp/not-a-confirmed-file' })
    result('bash', { filePath: '/tmp/not-a-confirmed-file' })
    return say('Files done')
  }
  if (text === 'EVENTS') {
    const messageId = 'stream-' + turn
    const stream = event => send({ type: 'stream_event', session_id: session, event })
    stream({ type: 'message_start', message: { id: messageId } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'route.' } })
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'stream-tool', name: 'Read', input: {} } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/fixture"}' } })
    stream({ type: 'content_block_stop', index: 1 })
    send({ type: 'tool_progress', tool_use_id: 'stream-tool', tool_name: 'Read', parent_tool_use_id: null, elapsed_time_seconds: 1.5, uuid: 'progress-1', session_id: session })
    const snapshot = { type: 'assistant', session_id: session, message: { id: messageId, content: [
      { type: 'thinking', thinking: 'Check route. More.' }, { type: 'tool_use', id: 'stream-tool', name: 'Read', input: { path: '/tmp/fixture' } },
    ] } }
    send(snapshot)
    send(snapshot)
    toolResult('stream-tool', 'Read', false)
    send({ type: 'assistant', session_id: session, message: { id: 'assembled-' + turn, content: [
      { type: 'thinking', thinking: 'Fallback thought.' }, { type: 'tool_use', id: 'assembled-tool', name: 'Write', input: { path: '/tmp/other' } },
    ] } })
    toolResult('assembled-tool', 'Write', true)
    return say('Events done')
  }
  if (text === 'LIFECYCLE') {
    send({ type: 'system', subtype: 'status', status: 'compacting', session_id: session })
    send({ type: 'system', subtype: 'status', status: null, session_id: session })
    send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 42000 }, session_id: session })
    send({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'spawn-tool', description: 'Research subtask', task_type: 'research', parent_task_id: 'task-0', session_id: session })
    send({ type: 'system', subtype: 'task_progress', task_id: 'task-1', description: 'Research subtask', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1500 }, last_tool_name: 'Grep', summary: 'found 3 files', session_id: session })
    send({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'failed', error: 'child boom' }, session_id: session })
    send({ type: 'system', subtype: 'task_started', task_id: 'task-2', description: 'Second child', session_id: session })
    send({ type: 'system', subtype: 'task_notification', task_id: 'task-2', status: 'completed', summary: 'child two done', output_file: '/tmp/out', session_id: session })
    return say('Lifecycle done')
  }
  if (text.includes('ASK_PERMISSION')) {
    pending = { id: 'perm-' + turn, tool: 'Write' }
    send({ type: 'control_request', request_id: pending.id, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: { file_path: '/tmp/fixture', content: 'hi' }, description: '/tmp/fixture' } })
  } else if (text.includes('ASK_QUESTIONS')) {
    pending = { id: 'ask-' + turn, tool: 'AskUserQuestion' }
    send({ type: 'control_request', request_id: pending.id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', requires_user_interaction: true, input: { questions: [{ question: 'Favorite color?', header: 'Color', options: [{ label: 'Red', description: 'red' }, { label: 'Blue', description: 'blue' }], multiSelect: false }] } } })
  } else if (text.includes('WAIT')) setTimeout(() => say('Waited'), Number(process.env.CLAUDE_FIXTURE_WAIT_MS) || 200)
  else if (text.includes('EFFORT')) say(`Effort ${arg('--effort') ?? 'none'}`)
  else if (text.startsWith('RESULT ')) send({ type: 'result', session_id: session, ...JSON.parse(text.slice(7)) })
  else say('Hello world')
}
createInterface({ input: process.stdin }).on('line', receive)
