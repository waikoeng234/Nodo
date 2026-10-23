#!/usr/bin/env node
// Local executable fixture: Qoder CLI stream-json wire without model/network/auth.
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const log = entry => appendFileSync('qoder-requests.jsonl', JSON.stringify(entry) + '\n')
if (process.argv.includes('--version')) { console.log('qoder-cli fixture'); process.exit(0) }
const arg = name => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1] }
const session = arg('--resume') ?? 'fixture-qoder-session'
// The initialize control response's tables, in the shape the real CLI writes:
// model value + display name + per-model efforts, and the slash-command list.
const fixtureModels = [
  { value: 'qfmodel', displayName: 'Qwen3.8-Flash', isDefault: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { value: 'dfmodel', displayName: 'DeepSeek-Flash', isFree: true, efforts: ['high', 'max', 'low'], defaultEffort: 'max' },
  { value: 'gmodel', displayName: 'GLM-5.3', efforts: [] },
]
const fixtureCommands = [
  { name: 'compact', description: 'Compresses the context by replacing it with a summary', argumentHint: '' },
  { name: 'review', description: 'Review code changes and find actionable issues', argumentHint: '' },
]
let turn = 0
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
// Qoder has no partial-message channel: every assistant frame is the whole
// message and the result carries the turn's final text and accumulated usage.
const requestUsage = { input_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 45 }
const turnUsage = { input_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 90 }
const modelUsage = { qfmodel: { inputTokens: 300, outputTokens: 90, cacheReadInputTokens: 900, cacheCreationInputTokens: 100, contextWindow: 200000, maxOutputTokens: 32000 } }
const say = (text, extra = {}) => {
  send({ type: 'assistant', message: { id: 'm' + turn, role: 'assistant', content: [{ type: 'text', text }], usage: requestUsage }, session_id: session })
  send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text, usage: turnUsage, modelUsage, ...extra })
}
const toolResult = (id, output, isError) => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] }, session_id: session })
const control = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const init = () => send({ type: 'system', subtype: 'init', session_id: session, qodercli_version: '1.1.76-fixture', protocol_version: '1.5.0', model: arg('--model') ?? 'qfmodel', permissionMode: arg('--permission-mode') ?? 'default', tools: [], mcp_servers: [], slash_commands: [], capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] })
let initialized = !process.env.QODER_FIXTURE_DELAY_INIT
if (initialized) init()
log({ spawn: process.argv.slice(1), instructions: arg('--append-system-prompt'), reasoningEffort: arg('--reasoning-effort'), model: arg('--model'), permissionMode: arg('--permission-mode'), resume: arg('--resume') })
let pending = null // can_use_tool awaiting the host decision
let lastText
let lateInterrupt
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
        send({ type: 'assistant', session_id: session, message: { id: 'tool-' + turn, content: [{ type: 'tool_use', id: 'tool-1', name: decision.tool, input: decision.input }] } })
        if (decision.tool === 'Write') toolResult('tool-1', `File created successfully at: ${decision.input.file_path}. The file state is current in your context.`)
        else toolResult('tool-1', 'done')
        say('Allowed')
      } else {
        send({ type: 'assistant', session_id: session, message: { id: 'tool-' + turn, content: [{ type: 'tool_use', id: 'tool-1', name: decision.tool, input: decision.input }] } })
        toolResult('tool-1', 'denied', true)
        send({ type: 'system', subtype: 'permission_denied', tool_name: decision.tool, tool_use_id: 'tool-1', message: 'The user doesn\'t want to proceed with this tool use.', session_id: session })
        say('Denied')
      }
    }
    return
  }
  if (frame.type === 'control_request') {
    log({ control: frame.request?.subtype })
    if (frame.request?.subtype === 'interrupt') {
      const fail = () => send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Interrupt rejected' } })
      if (lastText === 'CANCEL_LATE') { say('First done'); lateInterrupt = fail }
      else if (lastText === 'CANCEL_ERROR') fail()
      else if (lastText === 'CANCEL_SILENT') control(frame.request_id, { still_queued: [] })
      else { control(frame.request_id, { still_queued: [] }); send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, usage: turnUsage }) }
    }
    else if (process.env.QODER_FIXTURE_INIT_ERROR) send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported initialize' } })
    else if (process.env.QODER_FIXTURE_INIT_MALFORMED) control(frame.request_id, null)
    else control(frame.request_id, process.env.QODER_FIXTURE_NO_MODELS ? { commands: [] } : { commands: fixtureCommands, models: fixtureModels })
    return
  }
  if (frame.type !== 'user') return
  if (!initialized) { initialized = true; init() }
  const text = frame.message?.content?.find(block => block.type === 'text')?.text ?? ''
  log({ user: text })
  lastText = text
  turn++
  if (lateInterrupt) { lateInterrupt(); lateInterrupt = null }
  if (text.startsWith('CANCEL_')) return
  if (text === 'EXIT') { say('Before exit'); return setImmediate(() => process.exit(0)) }
  if (text === 'TASK_BACKGROUND') {
    send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'old-task' })
    return say('Background started')
  }
  if (text === 'TASK_NEXT') {
    send({ type: 'system', subtype: 'task_started', session_id: 'foreign-session', task_id: 'foreign-task' })
    for (const task_id of ['old-task', 'unknown-task']) {
      send({ type: 'system', subtype: 'task_progress', session_id: session, task_id, summary: 'Old progress' })
      send({ type: 'system', subtype: 'task_notification', session_id: session, task_id, status: 'completed', summary: 'Old output' })
    }
    send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'current-task' })
    send({ type: 'system', subtype: 'task_progress', session_id: session, task_id: 'current-task', summary: 'Current progress' })
    for (let i = 0; i < 2; i++) send({ type: 'system', subtype: 'task_notification', session_id: session, task_id: 'current-task', status: 'completed', summary: 'Current output' })
    send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'current-task' })
    send({ type: 'system', subtype: 'task_progress', session_id: session, task_id: 'current-task', summary: 'Late progress' })
    return say('Next done')
  }
  if (text.startsWith('HANDOFF ')) {
    const [, tag, outcome] = text.split(' ')
    return setTimeout(() => {
      send({ type: 'assistant', session_id: session, message: { id: 'progress-' + turn, content: [{ type: 'text', text: `Progress ${tag}` }] } })
      say(`Final ${tag}`, outcome === 'error' ? { subtype: 'error_during_execution', is_error: true } : {})
    }, 30)
  }
  if (text === 'FILES') {
    const start = (id, name, input) => send({ type: 'assistant', session_id: session, message: { id: 'files-' + id, content: [{ type: 'tool_use', id, name, input }] } })
    start('write-0', 'Write', { file_path: process.cwd() + '/created.txt', content: 'new body' })
    toolResult('write-0', `File created successfully at: ${process.cwd()}/created.txt. The file state is current in your context.`)
    start('write-1', 'Write', { file_path: process.cwd() + '/updated.txt', content: 'newer body' })
    toolResult('write-1', `The file ${process.cwd()}/updated.txt has been updated successfully.`)
    start('edit-2', 'Edit', { file_path: process.cwd() + '/edited.txt', old_string: 'before', new_string: 'after' })
    toolResult('edit-2', `The file ${process.cwd()}/edited.txt has been updated.`)
    start('denied', 'Write', { file_path: process.cwd() + '/denied.txt', content: 'never written' })
    toolResult('denied', 'denied', true)
    start('alien', 'Bash', { command: 'printf x > /tmp/not-tracked' })
    toolResult('alien', 'done')
    return say('Files done')
  }
  if (text === 'LIFECYCLE') {
    send({ type: 'system', subtype: 'status', status: 'compacting', session_id: session })
    send({ type: 'system', subtype: 'status', status: null, session_id: session })
    send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 23810, post_tokens: 811, messages_summarized: 5, duration_ms: 13744 }, session_id: session })
    send({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'spawn-tool', description: 'Research subtask', task_type: 'local_agent', subagent_type: 'general-purpose', session_id: session })
    send({ type: 'system', subtype: 'task_progress', task_id: 'task-1', tool_use_id: 'spawn-tool', description: 'List files with hidden entries', last_tool_name: 'Bash', session_id: session })
    send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'spawn-tool', status: 'completed', summary: 'child one done', output_file: '/tmp/out', session_id: session })
    return say('Lifecycle done')
  }
  if (text.includes('ASK_PERMISSION')) {
    pending = { id: 'perm-' + turn, tool: 'Write', input: { file_path: '/tmp/fixture', content: 'hi' } }
    send({ type: 'control_request', request_id: pending.id, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: pending.input, description: '/tmp/fixture', title: 'Write file', options: [], decision_reason: 'default' } })
  } else if (text.includes('ASK_QUESTIONS')) {
    pending = { id: 'ask-' + turn, tool: 'AskUserQuestion', input: { questions: [{ question: 'Favorite color?', header: 'Color', options: [{ label: 'Red', description: 'red' }, { label: 'Blue', description: 'blue' }], multiSelect: false }] } }
    send({ type: 'control_request', request_id: pending.id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', requires_user_interaction: true, input: pending.input } })
  } else if (text.includes('WAIT')) setTimeout(() => say('Waited'), Number(process.env.QODER_FIXTURE_WAIT_MS) || 200)
  else if (text.includes('EFFORT')) say(`Effort ${arg('--reasoning-effort') ?? 'none'}`)
  else if (text.startsWith('RESULT ')) send({ type: 'result', session_id: session, ...JSON.parse(text.slice(7)) })
  else say('Hello world')
}
createInterface({ input: process.stdin }).on('line', receive)
