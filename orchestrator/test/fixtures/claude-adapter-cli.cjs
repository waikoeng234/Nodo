#!/usr/bin/env node
// Adapter-route fixture: a fake Claude Code CLI speaking stream-json over stdio
// (handoff P3). Scripted per-turn output selected by markers in the prompt:
//   FLOW        text → thinking → tool_use ×2 → final text + usage
//   ASK_FLOW    thinking → can_use_tool ask → (allow: tool result + text / deny: clean end)
//   QUESTION    AskUserQuestion control ask → answers echoed back as text
//   HANG        tool → hang CODEX_FIXTURE_HANG_MS → tool → final text
//   RESUME      answers with the session id it resumed on
// Asks, prompts and interrupts are logged to claude-requests.jsonl in the
// process cwd for bench assertions. No model, network or auth.
const { createInterface } = require('node:readline')
const { join } = require('node:path')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('claude-adapter fixture'); process.exit(0) }
const arg = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined }
const session = arg('--resume') ?? 'fixture-claude-session'
const HANG_MS = Number(process.env.CODEX_FIXTURE_HANG_MS) || 60000
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const log = entry => { try { appendFileSync(join(process.cwd(), 'claude-requests.jsonl'), JSON.stringify(entry) + '\n') } catch {} }
const sid = () => ({ session_id: session })
const usage = { input_tokens: 1200, output_tokens: 45, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }
let count = 0
let turn = null
let waiting = null
const timers = new Set()
const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer }
const init = () => write({ type: 'system', subtype: 'init', session_id: session, model: arg('--model') ?? 'fixture' })
const delta = (kind, key, text) => write({ type: 'stream_event', ...sid(), event: { type: 'content_block_delta', index: 0, delta: { type: kind, [key]: text } } })
const say = text => { delta('text_delta', 'text', text.slice(0, 4)); delta('text_delta', 'text', text.slice(4)); write({ type: 'assistant', ...sid(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) }
const think = text => { delta('thinking_delta', 'thinking', text); write({ type: 'assistant', ...sid(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } }) }
const toolUse = (id, name) => write({ type: 'stream_event', ...sid(), event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name } } })
const toolResult = id => write({ type: 'user', ...sid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } })
const finish = text => {
  if (!turn) return
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  say(text)
  write({ type: 'result', ...sid(), subtype: 'success', usage, modelUsage: { fixture: { contextWindow: 200000 } } })
  turn = null
}
const stop = () => {
  if (!turn) return
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  write({ type: 'result', ...sid(), subtype: 'success', usage })
  turn = null
}
const ask = (toolName, input, description) => new Promise(resolve => {
  waiting = { toolName, resolve }
  write({ type: 'control_request', request_id: `ask-${count}`, request: { subtype: 'can_use_tool', tool_name: toolName, input, ...(description ? { description } : {}) } })
})
const receive = line => {
  const frame = JSON.parse(line)
  if (frame.type === 'control_response') {
    if (!waiting) return
    const pending = waiting; waiting = null
    const response = frame.response?.response ?? {}
    log({ method: 'ask-reply', tool: pending.toolName, behavior: response.behavior, ...(response.updatedInput?.answers ? { answers: response.updatedInput.answers } : {}) })
    pending.resolve(response)
    return
  }
  if (frame.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
    if (frame.request?.subtype === 'interrupt') { log({ method: 'interrupt' }); stop() }
    return
  }
  if (frame.type !== 'user') return
  const text = (frame.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
  if (!frame.message?.content?.length) return
  log({ method: 'prompt', text, content: frame.message.content, ...(arg('--permission-mode') ? { permissionMode: arg('--permission-mode') } : {}), ...(arg('--append-system-prompt') ? { identity: arg('--append-system-prompt') } : {}) })
  turn = { n: ++count }
  init()
  if (text.includes('QUESTION')) {
    later(10, async () => {
      const response = await ask('AskUserQuestion', { questions: [
        { question: 'Choose a color', header: 'Color', options: [{ label: 'Blue', description: 'Cool' }, { label: 'Red', description: 'Warm' }] },
        { question: 'Choose a name', header: 'Name' },
      ] })
      const answers = Object.values(response?.updatedInput?.answers ?? {})
      later(10, () => finish(`QUESTION done: ${answers.join(', ')}`))
    })
  } else if (text.includes('STREAM_HANG')) {
    later(10, () => say('Waiting for cancellation'))
  } else if (text.includes('TOOL_HANG')) {
    later(10, () => { toolUse('hang-tool', 'Bash'); later(HANG_MS, () => { toolResult('hang-tool'); finish('HANG done') }) })
  } else if (text.includes('ASK_FLOW')) {
    later(10, async () => {
      think('Asking before touching the workspace')
      const response = await ask('Bash', { command: 'echo fixture-ask' }, 'echo fixture-ask')
      if (response?.behavior === 'allow') { toolUse('cmd-ask', 'Bash'); toolResult('cmd-ask'); later(10, () => finish('ASK done')) }
      else stop()
    })
  } else if (text.includes('HANG')) {
    later(10, () => {
      toolUse('cmd-hang-a', 'Bash'); toolResult('cmd-hang-a')
      later(HANG_MS, () => { toolUse('cmd-hang-b', 'Bash'); toolResult('cmd-hang-b'); later(10, () => finish('HANG done')) })
    })
  } else if (text.includes('RESUME')) {
    later(10, () => finish(`Resumed on session ${session}`))
  } else if (text.includes('FLOW')) {
    later(10, () => {
      say('FLOW part one')
      think('Fixture reasoning about ' + text.trim().slice(0, 20))
      toolUse('cmd-one', 'Bash'); toolResult('cmd-one')
      toolUse('cmd-two', 'Bash'); toolResult('cmd-two')
      later(10, () => finish('FLOW done'))
    })
  } else later(10, () => finish('Adapter fixture: ' + text.split('\n')[0].slice(0, 40)))
}
createInterface({ input: process.stdin }).on('line', receive)
