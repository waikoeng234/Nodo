#!/usr/bin/env node
// Adapter-route fixture: a fake ZCode app-server speaking JSON-RPC over stdio
// (handoff P3). Scripted per-turn output selected by markers in the prompt:
//   FLOW        text deltas → tool ×2 → turn completed + usage
//   ASK_FLOW    interaction/requestPermission → (allow: tool completed + text / deny: cancelled end)
//   QUESTION    interaction/requestUserInput → answer echoed back as text
//   HANG        tool → hang CODEX_FIXTURE_HANG_MS → tool → completed
//   RESUME      answers with the session id it resumed on
// Session ops, asks and interrupts are logged to zcode-requests.jsonl in the
// process cwd for bench assertions. No model, network or auth.
const { createInterface } = require('node:readline')
const { join } = require('node:path')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('zcode-adapter fixture 1.0'); process.exit(0) }
const HANG_MS = Number(process.env.CODEX_FIXTURE_HANG_MS) || 60000
const write = message => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => write({ id, result })
const fail = (id, message) => write({ id, error: { code: -32601, message } })
const log = entry => { try { appendFileSync(join(process.cwd(), 'zcode-requests.jsonl'), JSON.stringify(entry) + '\n') } catch {} }
const session = { id: null, mode: 'build' }
let count = 0
let turn = null
let compacting = false
const timers = new Set()
const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer }
const event = (type, payload) => write({ method: 'session/event', params: { seq: ++count, sessionId: session.id, type, payload } })
const say = text => {
  const message = `m-${turn?.id ?? count}`
  event('model.streaming', { kind: 'text_delta', delta: text.slice(0, 4), assistantMessageId: message })
  event('model.streaming', { kind: 'text_delta', delta: text.slice(4), assistantMessageId: message })
}
const tool = (id, name, done) => {
  event('tool.updated', { toolCallId: id, toolName: name })
  if (done) event('tool.updated', { toolCallId: id, toolName: name, result: { success: true } })
}
const completed = (resultType = 'success', compact = false) => {
  if (!turn && !compacting) return
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  event('turn.completed', { resultType, usage: { inputTokens: 1200, outputTokens: 45, totalTokens: 1245 } })
  turn = null
  compacting = compact ? compacting : false
}
// One engine ask = one server→client request written immediately; the host's
// reply comes back on the same id.
const ask = (method, params, permission) => new Promise(resolve => {
  turn.ask = { id: params.requestId, permission, resolve }
  write({ id: params.requestId, method, params })
})
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (!method) {
    if (turn?.ask && id === turn.ask.id) {
      const pending = turn.ask; turn.ask = null
      const answer = message.result ?? params
      log({ method: pending.permission ? 'approval-reply' : 'question-reply', ...(pending.permission ? { decision: answer.decision } : { content: answer.content }) })
      pending.resolve(answer)
    }
    return
  }
  if (method === 'initialize') { reply(id, { protocolVersion: 1 }); return }
  if (method === 'session/requestRuntimePreferences') { fail(id, 'method not found'); return }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') { reply(id, { headers: {} }); return }
  if (method === 'session/create' || method === 'session/resume') {
    log({ method, sessionId: params.sessionId ?? null, mode: params.mode ?? params.workspace?.mode })
    session.id = params.sessionId ?? 'fixture-zcode-session'
    session.mode = params.mode ?? session.mode
    reply(id, {
      session: { sessionId: session.id },
      settings: { model: {
        available: [{ ref: { providerId: 'fixture', modelId: 'fixture-model' }, label: 'Fixture Model', providerLabel: 'Fixture',
          reasoning: { levels: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }], defaultLevel: 'high' } }],
        current: { providerId: 'fixture', modelId: 'fixture-model' },
      } },
    })
    return
  }
  if (method === 'session/setMode') { log({ method: 'session/setMode', mode: params.mode }); session.mode = params.mode; reply(id, {}); return }
  if (['session/setModel', 'session/setThoughtLevel', 'session/subscribe', 'session/close'].includes(method)) { reply(id, {}); return }
  if (method === 'session/send') {
    log({ method: 'session/send', text: params.content, attachments: params.attachments, mode: session.mode })
    turn = { id: 'zt-' + ++count }
    reply(id, {})
    const text = String(params.content ?? '')
    if (text.includes('QUESTION')) {
      later(10, async () => {
        const answer = await ask('interaction/requestUserInput', { requestId: 7000 + count, prompt: 'Which color and name?' }, false)
        const content = answer.content ?? {}
        const values = Object.values(content.answers ?? { answer: content.answer })
        later(10, () => { say(`QUESTION done: ${values.join(', ')}`); completed() })
      })
    } else if (text.includes('STREAM_HANG')) {
      later(10, () => say('Waiting for cancellation'))
    } else if (text.includes('TOOL_HANG')) {
      later(10, () => { tool('hang-tool', 'Bash'); later(HANG_MS, () => { tool('hang-tool', 'Bash', true); later(10, () => { say('HANG done'); completed() }) }) })
    } else if (text.includes('ASK_FLOW')) {
      later(10, async () => {
        const decision = await ask('interaction/requestPermission', { requestId: 6000 + count, toolName: 'Bash', reason: 'echo fixture-ask', riskLevel: 'low',
          options: [{ response: { decision: 'allow' } }, { response: { decision: 'deny' } }] }, true)
        if (decision.decision === 'allow') { tool('cmd-ask', 'Bash', true); later(10, () => { say('ASK done'); completed() }) }
        else completed('cancelled')
      })
    } else if (text.includes('HANG')) {
      later(10, () => {
        tool('cmd-hang-a', 'Bash', true)
        later(HANG_MS, () => { tool('cmd-hang-b', 'Bash', true); later(10, () => { say('HANG done'); completed() }) })
      })
    } else if (text.includes('RESUME')) {
      later(10, () => { say(`Resumed on session ${session.id}`); completed() })
    } else if (text.includes('FLOW')) {
      later(10, () => {
        say('FLOW part one')
        tool('cmd-one', 'Bash', true)
        tool('cmd-two', 'Bash', true)
        later(10, () => { say('FLOW done'); completed() })
      })
    } else later(10, () => { say('Adapter fixture: ' + text.split('\n')[0].slice(0, 40)); completed() })
    return
  }
  if (method === 'session/stop') { log({ method: 'interrupt' }); reply(id, {}); completed('cancelled'); return }
  if (method === 'session/compact') {
    log({ method })
    compacting = true
    reply(id, { compact: { state: 'started' } })
    later(150, () => { log({ method: 'compact-completed' }); completed('success', true); compacting = false })
    return
  }
  fail(id, 'unknown method')
}
createInterface({ input: process.stdin }).on('line', receive)
