#!/usr/bin/env node
// Local executable fixture: CodeBuddy ACP wire without model/network/auth.
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('CodeBuddy fixture v1'); process.exit(0) }
const log = entry => appendFileSync('codebuddy-requests.jsonl', JSON.stringify(entry) + '\n')
let next = 0
const session = 'fixture-cb-session'
let prompt = null // { id, text, cancel: () => {} }
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'fullAccess', 'delegate']
const MODELS = [
  { value: 'default-model', name: 'Auto' },
  { value: 'fixture/one', name: 'Model One' },
  { value: 'fixture/two', name: 'Model Two' },
]
// Levels belong to one model: the option set is recomputed per selection.
const LEVELS = {
  'default-model': [{ value: 'enabled', name: 'Enabled' }, { value: 'high', name: 'High' }],
  'fixture/one': [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }],
  'fixture/two': [{ value: 'disabled', name: 'Disabled' }, { value: 'high', name: 'High' }],
}
const selection = { mode: 'default', model: 'default-model', thought_level: 'enabled' }
const configOptions = () => {
  const levels = LEVELS[selection.model]
  return [
    { id: process.env.CB_MULTITASK_ID ?? 'multitask', type: 'boolean', currentValue: process.env.CB_MULTITASK === '1' },
    { id: 'mode', name: 'Permission Mode', category: 'mode', type: 'select', currentValue: selection.mode, options: MODES.map(value => ({ value, name: value })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selection.model, options: MODELS },
    { id: 'thought_level', name: 'Thought Level', category: 'thought_level', type: 'select', currentValue: levels.some(level => level.value === selection.thought_level) ? selection.thought_level : levels[0].value, options: levels },
  ]
}
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = payload => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: payload } })
const chunks = (text, messageId = 'm' + next) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
// The engine reports no token usage: a zeroed context ping and a bare result.
const finish = (stopReason = 'end_turn') => {
  if (!prompt) return
  const { id } = prompt
  prompt = null
  update({ sessionUpdate: 'usage_update', used: 0, size: 0 })
  reply(id, { stopReason, userMessageId: 'u' + next })
}
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    log({ method, clientCapabilities: params.clientCapabilities, args: process.argv.slice(2) })
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] })
    return
  }
  if (method === 'session/new' || method === 'session/load') {
    log({ method, sessionId: params.sessionId, cwd: params.cwd })
    reply(id, { sessionId: params.sessionId ?? session, configOptions: configOptions() })
    return
  }
  if (method === 'session/set_config_option') {
    log({ method, configId: params.configId, value: params.value })
    const valid = { mode: MODES, model: MODELS.map(model => model.value), thought_level: LEVELS[selection.model].map(level => level.value) }
    if (!valid[params.configId]?.includes(params.value)) { send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } }); return }
    selection[params.configId] = params.value
    reply(id, { configOptions: configOptions() })
    return
  }
  if (method === 'session/cancel') { prompt?.cancel(); return }
  if (method === '_codebuddy.ai/resolveInterruption') {
    log({ method, ...params })
    if (['UNRESOLVED_QUESTION', 'UNKNOWN_QUESTION'].includes(prompt?.text) && !prompt.failed) {
      prompt.failed = true
      reply(id, prompt.text === 'UNRESOLVED_QUESTION' ? { resolved: false, queued: false } : {})
      return
    }
    if (prompt?.text === 'FAIL_QUESTION' && !prompt.failed) {
      prompt.failed = true
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'ask service busy' } })
      return
    }
    reply(id, { resolved: true, queued: false })
    chunks('Answered ' + Object.values(params.answers ?? {}).flat().join(','))
    finish()
    return
  }
  if (method === 'session/prompt') {
    log({ method, text: params.prompt?.[0]?.text })
    prompt = { id, text: params.prompt?.[0]?.text ?? '' }
    const text = prompt.text
    next++
    if (text === 'FILES') {
      const edit = { file_path: 'edited.txt', old_string: 'before\n', new_string: 'after\n' }
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Editing file', rawInput: edit, status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', name: 'Edit', status: 'completed' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
      update({ sessionUpdate: 'tool_call', toolCallId: 'write', name: 'Write', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write', rawInput: { file_path: 'written.txt', content: 'new body' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' })
      update({ sessionUpdate: 'tool_call', toolCallId: 'native', name: 'Edit', rawInput: { ...edit, file_path: 'native.txt' }, status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'native', status: 'completed', content: [{ type: 'diff', path: 'native.txt', oldText: 'whole before', newText: 'whole after' }] })
      for (const [toolCallId, extra, status] of [['failed', {}, 'failed'], ['replay', { _meta: { isReplay: true } }, 'completed'], ['member', { _meta: { 'codebuddy.ai/memberEvent': 'worker-A' } }, 'completed']]) {
        update({ sessionUpdate: 'tool_call', toolCallId, name: 'Edit', rawInput: { ...edit, file_path: toolCallId + '.txt' }, status, ...extra })
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'tool_call', toolCallId: 'foreign', name: 'Edit', rawInput: { ...edit, file_path: 'foreign.txt' }, status: 'completed' } } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'read', name: 'Read', rawInput: { file_path: 'read.txt' }, status: 'completed' })
      chunks('Files done')
      finish()
      return
    }
    if (text === 'MEMBER_CHUNKS' || text === 'MEMBER_UNBOUNDED') {
      chunks('Parent final', 'parent-' + next)
      const _meta = { 'codebuddy.ai/memberEvent': 'worker-A' }
      update({ sessionUpdate: 'agent_message_chunk', ...(text === 'MEMBER_CHUNKS' ? { messageId: 'worker-' + next } : {}), content: { type: 'text', text: 'Worker history' }, _meta })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Worker thought' }, _meta })
      update({ sessionUpdate: 'tool_call', toolCallId: 'worker-tool', name: 'Read', status: 'completed', _meta })
      update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'multitask', currentValue: true }], _meta })
      update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'multitask', currentValue: true }], _meta: { isReplay: true } })
      finish()
      return
    }
    if (text === 'ENABLE_MULTITASK') {
      update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'multitask', type: 'boolean', currentValue: true }] })
      chunks('Unsupported background output')
      finish()
      return
    }
    if (['WORKER_AFTER_END', 'WORKER_DURING_TURN', 'DRAIN_AFTER_END'].includes(text)) {
      if (text !== 'WORKER_DURING_TURN') finish()
      setTimeout(() => {
        if (text === 'DRAIN_AFTER_END') {
          update({ sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId: 'drain-1', reason: 'background_drain' } } })
          chunks('Unsolicited output')
        } else {
          send({ jsonrpc: '2.0', id: 100 + next, method: 'session/request_permission', params: { sessionId: session,
            toolCall: { toolCallId: 'worker-ask', rawInput: { questions: [{ question: 'Worker input?' }] }, _meta: { 'codebuddy.ai/isTeamMember': true, 'codebuddy.ai/memberName': 'worker-A' } },
            options: [{ kind: 'allow_once', optionId: 'once' }] } })
        }
      }, 30)
      return
    }
    if (text.startsWith('HANDOFF ')) {
      const [, tag, outcome] = text.split(' ')
      for (const name of ['Progress', 'Final']) chunks(`${name} ${tag}`, `${name}-${next}`)
      finish(outcome === 'error' ? 'max_tokens' : 'end_turn')
      return
    }
    const OPTIONS = [{ optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'once', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
    const stream = (name, input, kind) => update({ sessionUpdate: 'tool_call', toolCallId: 'call-' + next, name, kind: kind ?? 'other', status: 'in_progress', rawInput: input })
    // The gate reply alone never completes a question turn; only the private
    // interruption resolution carries the answers.
    const gate = (toolCall, settles) => {
      send({ jsonrpc: '2.0', id: 100 + next, method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'call-' + next, ...toolCall }, options: OPTIONS } })
      prompt.cancel = () => finish('cancelled')
      if (settles) prompt.answer = outcome => {
        const allowed = outcome?.outcome === 'selected' && ['once', 'always'].includes(outcome.optionId)
        chunks(allowed ? 'Approved' : 'Rejected')
        finish(allowed ? 'end_turn' : 'cancelled')
      }
    }
    const dinner = [{ header: 'Dinner', question: '今晚吃什么？', options: [{ label: '面条' }, { label: '饺子', description: 'Paginated choice' }], multiSelect: false }]
    const colors = [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }]
    if (text === 'ASK_PERMISSION') {
      // The permission card names no tool: the client falls back to the call
      // it already streamed.
      stream('bash', { command: 'ls /tmp/fixture' }, 'execute')
      gate({ rawInput: { command: 'ls /tmp/fixture' } }, true)
    } else if (text === 'ASK_QUESTION') {
      stream('AskUserQuestion', { questions: dinner })
      gate({ rawInput: { questions: dinner } })
    } else if (text === 'ASK_QUESTIONS') {
      const drinks = [{ question: 'Which drink?', options: [{ label: 'tea' }, { label: 'coffee' }] }]
      stream('AskUserQuestion', { questions: [...colors, ...drinks] })
      gate({ rawInput: { questions: [...colors, ...drinks] } })
    } else if (['FAIL_QUESTION', 'UNRESOLVED_QUESTION', 'UNKNOWN_QUESTION'].includes(text)) {
      stream('AskUserQuestion', { questions: colors })
      gate({ rawInput: { questions: colors } })
    } else if (text === 'ASK_OTHER') {
      // A questions-shaped input on an ordinary tool: a permission, not a card.
      stream('write', { questions: colors }, 'edit')
      gate({ name: 'write', kind: 'edit', rawInput: { questions: colors } }, true)
    } else if (text === 'WAIT') {
      const timer = setTimeout(() => { chunks('Waited'); finish() }, 200)
      prompt.cancel = () => { clearTimeout(timer); finish('cancelled') }
    } else {
      chunks('Hello world')
      finish()
    }
    return
  }
  if (!method && id === 100 + next) {
    log({ method: 'permission-reply', result: message.result, ...(message.error ? { error: message.error } : {}) })
    prompt?.answer?.(message.result?.outcome)
  }
}
createInterface({ input: process.stdin }).on('line', receive)
