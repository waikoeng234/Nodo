#!/usr/bin/env node
const { createInterface } = require('node:readline')
const { appendFileSync, existsSync, readFileSync, realpathSync } = require('node:fs')
const { join } = require('node:path')
if (process.argv.includes('--version')) { console.log('dsh fixture'); process.exit(0) }
const args = process.argv.slice(2)
let personaPrefix
let patchPath
if (args[0] !== '--profile' || args[1] !== 'acp' || ![2, 4].includes(args.length)) process.exit(2)
if (args.length === 4) {
  if (args[2] !== '--patch') process.exit(2)
  const patch = JSON.parse(readFileSync(args[3], 'utf8'))
  for (const entry of patch) {
    if (entry.id === 'system-prompt' && typeof entry.config.personaPrefix === 'string') personaPrefix = entry.config.personaPrefix
    else if (entry.id !== 'session-persistence-jsonl' || !entry.config.root.endsWith('/dsh/sessions')) process.exit(2)
  }
  patchPath = args[3]
}
const wire = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const reply = (id, result) => wire({ id, result })
const update = value => wire({ method: 'session/update', params: { sessionId: 'fixture-dsh-session', update: value } })
let turn = null
let permission = null
let selectedModel = '["mock","model"]'
// Both options exist so a scan can read the model list and each model's levels.
const configOptions = () => [
  { id: 'model', category: 'model', type: 'select', currentValue: selectedModel, options: [{ group: 'mock', name: 'Mock', options: [
    { value: '["mock","model"]', name: 'Mock' },
    { value: '["mock","other"]', name: 'Mock Two' },
  ] }] },
  selectedModel === '["mock","other"]'
    ? { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
    : { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
]
const finish = (text, stopReason = 'end_turn') => {
  if (!turn) return
  if (text) update({ sessionUpdate: 'agent_message_chunk', messageId: `message-${turn.id}`, content: { type: 'text', text } })
  reply(turn.id, { stopReason })
  turn = null
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.jsonrpc !== '2.0') process.exit(3)
  const { id, method, params = {} } = message
  if (!method) {
    if (id !== permission) process.exit(4)
    permission = null
    const outcome = message.result.outcome
    if (outcome.outcome === 'cancelled') finish(null, 'cancelled')
    else finish(outcome.optionId === 'custom-allow' ? 'Approved' : 'Denied')
    return
  }
  if (method === 'initialize') {
    if (params.protocolVersion !== 1) process.exit(5)
    const capabilities = process.env.DSH_FIXTURE_NO_RESUME ? {} : process.env.DSH_FIXTURE_LEGACY ? { loadSession: true } : { sessionCapabilities: { resume: {} } }
    const initialize = () => reply(id, { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [] })
    if (process.env.DSH_FIXTURE_SLOW_BOOT) setTimeout(initialize, 1000)
    else initialize()
  } else if (['session/new', 'session/resume', 'session/load'].includes(method)) {
    appendFileSync(join(process.cwd(), 'dsh-requests.jsonl'), JSON.stringify({ method, personaPrefix, patchPath }) + '\n')
    if (process.env.DSH_FIXTURE_NEWER_FORMAT && method !== 'session/new') return wire({ id, error: { code: -32603, message: 'Internal error', data: { details: 'session uses log format v4, but this harness reads only v3' } } })
    if (realpathSync(params.cwd) !== realpathSync(process.cwd()) || params.mcpServers.length || (method !== 'session/new' && params.sessionId !== 'fixture-dsh-session')) process.exit(6)
    if (method !== 'session/new' && !existsSync(join(process.cwd(), 'session-ledger'))) process.exit(7)
    appendFileSync(join(process.cwd(), 'session-ledger'), `${method}\n`)
    reply(id, { sessionId: 'fixture-dsh-session', configOptions: configOptions() })
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      if (!['["mock","model"]', '["mock","other"]'].includes(params.value)) process.exit(8)
      selectedModel = params.value
      appendFileSync(join(process.cwd(), 'session-ledger'), 'model selected\n')
    } else if (params.configId === 'reasoning_effort') {
      if (!configOptions()[1].options.some(level => level.value === params.value)) process.exit(8)
      appendFileSync(join(process.cwd(), 'session-ledger'), `effort ${params.value}\n`)
    } else process.exit(8)
    reply(id, { configOptions: configOptions() })
  } else if (method === 'session/close') {
    appendFileSync(join(process.cwd(), 'session-ledger'), 'session/close\n')
    reply(id, {})
  } else if (method === 'session/prompt') {
    appendFileSync(join(process.cwd(), 'dsh-requests.jsonl'), JSON.stringify({ method, text: params.prompt[0].text }) + '\n')
    if (turn) process.exit(9)
    turn = { id }
    const text = params.prompt[0].text
    if (text === 'FILES') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'edit', kind: 'edit', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: [{ type: 'diff', path: 'edited.txt', oldText: 'before', newText: 'after' }] })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
      update({ sessionUpdate: 'tool_call', toolCallId: 'failed', kind: 'edit', status: 'failed', content: [{ type: 'diff', path: 'failed.txt', oldText: 'before', newText: 'after' }] })
      return finish('Files done')
    }
    if (text.startsWith('HANDOFF ')) {
      const [, tag, outcome] = text.split(' ')
      setTimeout(() => {
        for (const name of ['Progress', 'Final']) update({ sessionUpdate: 'agent_message_chunk', messageId: `${name}-${id}`, content: { type: 'text', text: `${name} ${tag}` } })
        finish(null, outcome === 'error' ? 'max_tokens' : 'end_turn')
      }, 30)
      return
    }
    if (text.includes('WAIT')) return
    if (text.includes('EXIT')) return process.exit(10)
    if (text.includes('LIMIT')) return finish('Partial', 'max_tokens')
    if (text.includes('LONG')) return setTimeout(() => finish('Long reply'), 16000)
    if (text.includes('ASK_PERMISSION')) {
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', status: 'in_progress' })
      permission = 'typed-request'
      wire({ id: permission, method: 'session/request_permission', params: { sessionId: 'fixture-dsh-session', toolCall: { toolCallId: 'tool-1' }, options: [
        { optionId: 'custom-allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'custom-deny', name: 'Deny', kind: 'reject_once' },
      ] } })
      return
    }
    // Thoughts and another session must not leak into the displayed reply.
    wire({ method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong session' } } } })
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } })
    update({ sessionUpdate: 'agent_message_chunk', messageId: `message-${id}`, content: { type: 'text', text: 'Hello ' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', status: 'in_progress' })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' })
    update({ sessionUpdate: 'usage_update', used: 10, size: 100 })
    setTimeout(() => finish('world'), 100)
  } else if (method === 'session/cancel') finish(null, 'cancelled')
  else wire({ id, error: { code: -32601, message: 'Unsupported' } })
}).on('close', () => process.exit(0))
