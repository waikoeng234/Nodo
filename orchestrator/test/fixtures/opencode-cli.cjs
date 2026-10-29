#!/usr/bin/env node
// Local executable fixture: OpenCode ACP wire without model/network/auth.
const { createInterface } = require('node:readline')
const { appendFileSync, readFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('opencode fixture v2'); process.exit(0) }
const log = entry => appendFileSync('opencode-requests.jsonl', JSON.stringify(entry) + '\n')
let next = 0
const session = 'fixture-oc-session'
let prompt = null // { id, text, cancel: () => {} }
const MODELS = [
  { value: 'fixture/one', name: 'fixture/Model One' },
  { value: 'fixture/two', name: 'fixture/Model Two' },
  { value: 'other/three', name: 'other/Model Three' },
]
// Levels belong to one model: the option set is recomputed per selection.
const EFFORTS = {
  'fixture/one': [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }],
  'fixture/two': [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }],
  'other/three': [{ value: 'default', name: 'Default' }],
}
const selection = { model: 'fixture/one', effort: 'default' }
const configOptions = () => {
  const efforts = EFFORTS[selection.model]
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selection.model, options: MODELS },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: efforts.some(level => level.value === selection.effort) ? selection.effort : efforts[0].value, options: efforts },
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
  ]
}
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = payload => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: payload } })
const chunks = text => {
  const at = Math.ceil(text.length / 2)
  update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm' + next + ':reasoning:0', content: { type: 'text', text: 'thinking' } })
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm' + next, content: { type: 'text', text: text.slice(0, at) } })
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm' + next, content: { type: 'text', text: text.slice(at) } })
}
const finish = (stopReason = 'end_turn') => {
  if (!prompt) return
  const { id } = prompt
  prompt = null
  update({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0, currency: 'USD' } })
  reply(id, { stopReason, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })
}
const settle = (text, delay = 30) => {
  const timer = setTimeout(() => {
    if (!prompt) return
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-' + next, name: 'write', title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-' + next, status: 'completed', kind: 'edit', title: 'write', locations: [] })
    chunks(text)
    finish()
  }, delay)
  prompt.cancel = () => { clearTimeout(timer); finish('cancelled') }
}
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') { reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }); return }
  if (method === 'session/new' || method === 'session/load') {
    log({ method, sessionId: params.sessionId, cwd: params.cwd })
    if (process.env.OPENCODE_CONFIG_CONTENT) {
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
      for (const mode of ['build', 'plan']) if (config.agent?.[mode]?.prompt) log({ method: 'native/instructions', mode, prompt: config.agent[mode].prompt.replace(/\{file:([^}]+)\}/g, (_, path) => readFileSync(path, 'utf8')), config })
    }
    reply(id, { sessionId: params.sessionId ?? session, configOptions: configOptions() })
    return
  }
  if (method === 'session/set_config_option') {
    log({ method, configId: params.configId, value: params.value })
    if (!['model', 'effort', 'mode'].includes(params.configId) || typeof params.value !== 'string') { send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } }); return }
    if (params.configId === 'model' && !MODELS.some(model => model.value === params.value)) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'ACPInvalidModelError' } }); return }
    selection[params.configId] = params.value
    reply(id, { configOptions: configOptions() })
    return
  }
  if (method === 'session/cancel') { prompt?.cancel(); return }
  if (method === 'session/prompt') {
    log({ method, text: params.prompt?.[0]?.text })
    prompt = { id, text: params.prompt?.[0]?.text ?? '' }
    const text = prompt.text
    next++
    if (text.startsWith('FAILURE ')) {
      send({ id, error: { code: -32603, message: 'Fixture failure', data: { errorName: JSON.parse(text.slice(8)) } } })
      prompt = null
      return
    }
    if (text.startsWith('HANDOFF ')) {
      const [, tag, outcome] = text.split(' ')
      setTimeout(() => {
        for (const name of ['Progress', 'Final']) update({ sessionUpdate: 'agent_message_chunk', messageId: `${name}-${next}`, content: { type: 'text', text: `${name} ${tag}` } })
        finish(outcome === 'error' ? 'max_tokens' : 'end_turn')
      }, 30)
      return
    }
    if (text.includes('ASK_PERMISSION')) {
      send({ jsonrpc: '2.0', id: 100 + next, method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'call-' + next, name: 'write', title: 'write /tmp/fixture', kind: 'edit', status: 'pending' }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } })
    } else if (text.includes('ASK_QUESTIONS')) {
      send({ jsonrpc: '2.0', id: 100 + next, method: 'elicitation/create', params: { mode: 'form', sessionId: session, message: 'Questions', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Favorite color?', description: 'Which one?', oneOf: [{ const: 'Red', title: 'Red' }, { const: 'Blue', title: 'Blue' }] }, q0_custom: { type: 'string', title: 'Favorite color? (other)' } }, required: ['q0'] } } })
    } else if (text.includes('WAIT')) settle('Waited', 200)
    else settle('Hello world')
    return
  }
  if (!method && id === 100 + next) {
    // agent-side answer to request_permission / elicitation
    const outcome = message.result?.outcome
    const content = message.result?.content
    if (outcome) {
      const allowed = outcome.outcome === 'selected' && ['once', 'always'].includes(outcome.optionId)
      chunks(allowed ? 'Approved' : 'Rejected')
      finish(allowed ? 'end_turn' : 'cancelled')
    } else if (content) {
      chunks('Answered ' + Object.values(content).join(','))
      finish()
    }
  }
}
createInterface({ input: process.stdin }).on('line', receive)
