#!/usr/bin/env node
// Adapter-route fixture: a fake OpenCode CLI speaking ACP (JSON-RPC 2.0) over
// stdio (handoff P3). Scripted per-turn output selected by markers in the prompt:
//   FLOW        thought → text → tool_call ×2 → end_turn + usage
//   ASK_FLOW    session/request_permission → (allow: tool completed + text / reject: cancelled)
//   QUESTION    elicitation/create form → answer echoed back as text
//   HANG        tool_call → hang CODEX_FIXTURE_HANG_MS → tool_call → end_turn
//   RESUME      answers with the session id it loaded
// Config options, asks and prompts are logged to opencode-requests.jsonl in the
// process cwd for bench assertions. No model, network or auth.
const { createInterface } = require('node:readline')
const { join } = require('node:path')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('opencode-adapter fixture 1.0'); process.exit(0) }
const HANG_MS = Number(process.env.CODEX_FIXTURE_HANG_MS) || 60000
const write = message => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => write({ id, result })
const fail = (id, message) => write({ id, error: { code: -32601, message } })
const log = entry => { try { appendFileSync(join(process.cwd(), 'opencode-requests.jsonl'), JSON.stringify(entry) + '\n') } catch {} }
const sessionId = 'fixture-opencode-session'
let count = 0
let mode = 'build'
let turn = null
const timers = new Set()
const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer }
const config = () => [
  { id: 'mode', currentValue: mode },
  { id: 'model', currentValue: 'fixture/fixture-model', options: [{ value: 'fixture/fixture-model', name: 'fixture/fixture-model' }] },
  { id: 'effort', currentValue: 'high', options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] },
]
const update = (sessionUpdate, extra) => write({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...extra } } })
const say = text => { update('agent_message_chunk', { messageId: 'm' + count, content: { type: 'text', text: text.slice(0, 4) } }); update('agent_message_chunk', { messageId: 'm' + count, content: { type: 'text', text: text.slice(4) } }) }
const toolCall = (id, title, status) => update(status ? 'tool_call_update' : 'tool_call', { toolCallId: id, name: 'bash', title, status: status ?? 'running' })
// Ending the prompt settles the JSON-RPC reply the ACP host is awaiting.
const settle = (stopReason, usage) => {
  if (!turn) return
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  const pending = turn; turn = null
  reply(pending.rpcId, { stopReason, ...(usage ? { usage } : {}) })
}
// One engine ask = one server→client request written immediately; the host's
// reply comes back on the same id.
const ask = (method, params) => new Promise(resolve => {
  turn.ask = { id: params.id ?? 8000 + count, resolve }
  write({ id: turn.ask.id, method, params })
})
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (!method) {
    if (turn?.ask && id === turn.ask.id) {
      const pending = turn.ask; turn.ask = null
      const answer = message.result ?? params
      log({ method: 'ask-reply', ...(answer.outcome ? { outcome: answer.outcome } : { content: answer.content }) })
      pending.resolve(answer)
    }
    return
  }
  if (method === 'initialize') { reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }); return }
  if (method === 'session/new') { log({ method: 'session/new' }); reply(id, { sessionId, configOptions: config() }); return }
  if (method === 'session/load') { log({ method: 'session/load', sessionId: params.sessionId }); reply(id, { sessionId }); return }
  if (method === 'session/set_config_option') {
    log({ method: 'session/set_config_option', configId: params.configId, value: params.value })
    if (params.configId === 'mode') mode = params.value
    reply(id, { configOptions: config() }); return
  }
  if (method === 'session/prompt') {
    const text = (params.prompt ?? []).map(item => item.text ?? '').join('')
    log({ method: 'session/prompt', text, prompt: params.prompt, mode })
    turn = { rpcId: id, ask: null }
    if (text.includes('FILE_LOCATIONS')) {
      for (let i = 0; i < 10; i++) {
        update('tool_call', { toolCallId: 'location-' + i, name: 'source-edit', kind: 'edit', status: 'pending' })
        update('tool_call_update', { toolCallId: 'location-' + i, status: 'completed', locations: [{ path: `location-${i}.txt` }], rawOutput: { metadata: { truncated: false } } })
      }
      update('tool_call', { toolCallId: 'read-location', kind: 'read', status: 'completed', locations: [{ path: 'read-only.txt' }] })
      update('tool_call', { toolCallId: 'confirmed-new', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'location-0.txt', oldText: null, newText: 'created' }] })
      update('tool_call', { toolCallId: 'failed-location', kind: 'edit', status: 'failed', locations: [{ path: 'failed.txt' }] })
      say('ES05_LOCATIONS_DONE'); settle('end_turn')
    } else if (text.includes('FILES_FLOW')) {
      const paths = ['子 目录/一.md', '.agent/tmp/proof.md', '/tmp/nodo-outside-proof.md', ...Array.from({ length: 7 }, (_, i) => `file-${i + 4}.txt`)]
      const diff = path => ({ type: 'diff', path, oldText: 'ES05_BEFORE\n', newText: 'ES05_AFTER\n' })
      update('tool_call', { toolCallId: 'file-edit', title: 'Edit', status: 'pending', content: paths.map(diff) })
      update('tool_call_update', { toolCallId: 'file-edit', status: 'in_progress', rawOutput: { text: 'ES05_RAW_OUTPUT' } })
      update('tool_call_update', { toolCallId: 'file-edit', status: 'completed', content: paths.map(diff) })
      update('tool_call_update', { toolCallId: 'file-edit', status: 'completed', content: paths.map(diff) })
      update('tool_call', { toolCallId: 'second-edit', title: 'Edit', status: 'completed', content: [{ ...diff(paths[0]), oldText: 'ES05_AFTER\n', newText: 'ES05_BEFORE\n' }] })
      update('tool_call', { toolCallId: 'failed-edit', title: 'Edit', status: 'failed', content: [diff('failed.txt')] })
      update('tool_call', { toolCallId: 'unknown-before', title: 'Edit', status: 'completed', content: [{ type: 'diff', path: paths[1], newText: 'ES05_UNKNOWN_BEFORE\n' }] })
      write({ method: 'session/update', params: { sessionId: 'foreign-session', update: { sessionUpdate: 'tool_call', toolCallId: 'foreign', status: 'completed', content: [diff('foreign.txt')] } } })
      say('ES05_FILES_DONE'); settle('end_turn')
    } else if (text.includes('QUESTION')) {
      later(10, async () => {
        const answer = await ask('elicitation/create', { id: 8000 + count, mode: 'form', message: 'Pick a color',
          requestedSchema: { properties: { color: { title: 'Choose a color', oneOf: [{ const: 'Blue', title: 'Blue' }, { const: 'Red', title: 'Red' }] }, color_custom: { type: 'string' } } } })
        later(10, () => { say(`QUESTION done: ${Object.values(answer.content ?? {}).join(', ')}`); settle('end_turn', { inputTokens: 1245, outputTokens: 45, cachedReadTokens: 900 }) })
      })
    } else if (text.includes('STREAM_HANG')) {
      later(10, () => say('Waiting for cancellation'))
    } else if (text.includes('TOOL_HANG')) {
      later(10, () => { toolCall('hang-tool', 'sleep 60'); later(HANG_MS, () => { toolCall('hang-tool', 'sleep 60', 'completed'); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) }) })
    } else if (text.includes('ASK_FLOW')) {
      later(10, async () => {
        update('agent_thought_chunk', { content: { type: 'text', text: 'Asking before touching the workspace' } })
        const outcome = await ask('session/request_permission', { id: 8100 + count, sessionId, options: [
          { kind: 'allow_once', optionId: 'allow', name: 'Allow' }, { kind: 'reject_once', optionId: 'reject', name: 'Reject' }],
          toolCall: { toolCallId: 'cmd-ask', name: 'bash', title: 'echo fixture-ask' } })
        if (outcome.outcome?.outcome === 'selected' && outcome.outcome.optionId === 'allow') {
          toolCall('cmd-ask', 'echo fixture-ask', 'completed')
          later(10, () => { say('ASK done'); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) })
        } else settle('cancelled')
      })
    } else if (text.includes('HANG')) {
      later(10, () => {
        toolCall('cmd-hang-a', 'echo before-hang', 'completed')
        later(HANG_MS, () => { toolCall('cmd-hang-b', 'echo after-hang', 'completed'); later(10, () => { say('HANG done'); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) }) })
      })
    } else if (text.includes('RESUME')) {
      later(10, () => { say(`Resumed on session ${sessionId}`); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) })
    } else if (text.includes('FLOW')) {
      later(10, () => {
        update('agent_thought_chunk', { content: { type: 'text', text: 'Fixture reasoning' } })
        say('FLOW part one')
        toolCall('cmd-one', 'echo one', 'completed')
        toolCall('cmd-two', 'echo two', 'completed')
        later(10, () => { say('FLOW done'); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) })
      })
    } else later(10, () => { say('Adapter fixture: ' + text.split('\n')[0].slice(0, 40)); settle('end_turn', { inputTokens: 1245, outputTokens: 45 }) })
    return
  }
  if (method === 'session/cancel') { log({ method: 'interrupt' }); settle('cancelled'); return }
  fail(id, 'unknown method')
}
createInterface({ input: process.stdin }).on('line', receive)
