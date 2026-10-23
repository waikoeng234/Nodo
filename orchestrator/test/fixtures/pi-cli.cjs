#!/usr/bin/env node
// Local executable fixture: pi --mode rpc wire without model/network/auth.
const { appendFileSync, writeFileSync } = require('node:fs')
const log = entry => appendFileSync('pi-requests.jsonl', JSON.stringify(entry) + '\n')
if (process.argv.includes('--version')) { console.log('pi-cli fixture'); process.exit(0) }
const arg = name => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1] }
const session = arg('--session-id') ?? 'fixture-pi-session'
log({ spawn: process.argv.slice(1), mode: arg('--mode'), approve: process.argv.includes('--no-approve') ? 'no-approve' : undefined, instructions: arg('--append-system-prompt'), thinking: arg('--thinking'), model: arg('--model'), sessionId: arg('--session-id') })
// The driver stats these before the write/edit tools run: updated.txt and
// edited.txt must exist, created.txt must not.
if (!writeFileSyncSafe('updated.txt', 'older body')) process.exit(1)
if (!writeFileSyncSafe('edited.txt', 'before')) process.exit(1)
function writeFileSyncSafe(name, content) { try { writeFileSync(name, content) ; return true } catch { return false } }

const fixtureModels = [
  { id: 'fixture-model', name: 'Fixture Model', provider: 'fixture', contextWindow: 200000, thinkingLevelMap: { high: 'high', medium: 'medium' } },
  { id: 'other-model', name: 'Other Model', provider: 'fixture' },
  { id: 'cross-model', name: 'Cross Model', provider: 'other' },
]
const fixtureCommands = [
  { name: 'review', description: 'Review code changes and find actionable issues', source: 'prompt', sourceInfo: { path: '/tmp/prompts/review.md', source: 'local', scope: 'project' } },
  { name: 'skill:demo', description: 'Demo skill', source: 'skill', sourceInfo: { path: '/tmp/skills/demo', source: 'auto', scope: 'user' } },
]
let turn = 0
let runActive = false
const send = record => process.stdout.write(JSON.stringify(record) + '\n')
const response = (id, success, data) => send({ id, type: 'response', command: 'unknown', success, ...(success ? { data } : { error: data }) })
const usage = { input: 300, output: 45, cacheRead: 900, cacheWrite: 100, totalTokens: 1345 }
const model = { role: 'assistant', content: [], stopReason: 'pending' }
// One assistant message streamed as deltas; the driver then suppresses the
// snapshot text at message_end. `snap` sends the whole message with no deltas.
const say = (text, extra = {}) => {
  const content = [{ type: 'text', text }]
  send({ type: 'message_start', message: { ...model, content: [] } })
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
  send({ type: 'message_end', message: { role: 'assistant', content, usage, stopReason: 'stop', timestamp: Date.now() } })
}
const saySnap = text => {
  send({ type: 'message_start', message: { ...model, content: [] } })
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop', timestamp: Date.now() } })
}
const settle = (aborted = false) => { runActive = false; send({ type: 'agent_start' }); send({ type: 'agent_end', messages: [], willRetry: false }); send({ type: 'agent_settled', aborted }) }
const tool = (id, name, args, resultText, isError = false) => {
  send({ type: 'message_start', message: { ...model, content: [] } })
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id, toolName: name } })
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args) } })
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id, name, arguments: args } } })
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], usage, stopReason: 'toolUse', timestamp: Date.now() } })
  send({ type: 'tool_execution_start', toolCallId: id, toolName: name, args })
  send({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [{ type: 'text', text: resultText }] }, isError, durationMs: 3 })
}
let pendingDialog = null
const receive = line => {
  const record = JSON.parse(line)
  if (record.type === 'extension_ui_response') {
    if (pendingDialog && record.id === pendingDialog.id) {
      const dialog = pendingDialog
      pendingDialog = null
      saySnap('Answered ' + (record.cancelled ? 'cancelled' : record.confirmed !== undefined ? record.confirmed : record.value))
      settle()
    }
    return
  }
  const commands = ['get_state', 'get_available_models', 'get_commands', 'prompt', 'steer', 'abort', 'compact']
  if (!commands.includes(record.type)) return
  log({ command: record.type, message: record.message, images: Array.isArray(record.images) ? record.images.length : undefined, steer: record.type === 'steer' ? record.message : undefined })
  if (record.type === 'get_state') {
    if (process.env.PI_FIXTURE_FAIL_STATE) return response(record.id, false, 'fixture state refused')
    return response(record.id, true, { sessionId: session, sessionFile: `/tmp/fixture/${session}.jsonl`, model: { id: 'fixture-model', provider: 'fixture', name: 'Fixture Model', contextWindow: 200000, reasoning: true }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 })
  }
  if (record.type === 'get_available_models') return response(record.id, true, { models: fixtureModels })
  if (record.type === 'get_commands') return response(record.id, true, { commands: fixtureCommands })
  if (record.type === 'steer') return response(record.id, runActive, runActive ? { disposition: 'queued' } : 'No run to steer')
  if (record.type === 'abort') {
    response(record.id, true)
    if (runActive) settle(true)
    return
  }
  if (record.type === 'compact') {
    send({ type: 'compaction_start', reason: 'manual' })
    send({ type: 'compaction_end', reason: 'manual', result: { summary: 'Summary of conversation', firstKeptEntryId: 'e1', tokensBefore: 150000, estimatedTokensAfter: 32000 } })
    return response(record.id, true, { summary: 'Summary of conversation', firstKeptEntryId: 'e1', tokensBefore: 150000, estimatedTokensAfter: 32000 })
  }
  // prompt
  turn++
  const text = typeof record.message === 'string' ? record.message : ''
  if (text === 'DIE') { process.exit(9) }
  response(record.id, true, { disposition: 'started' })
  runActive = true
  if (text.startsWith('HANDOFF ')) {
    const [, tag, outcome] = text.split(' ')
    return setTimeout(() => {
      say(`Progress ${tag}`)
      if (outcome === 'error') {
        send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'Reached the maximum number of turns' })
        send({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'Reached the maximum number of turns' })
        say(`Final ${tag}`)
      } else saySnap(`Final ${tag}`)
      settle()
    }, 30)
  }
  if (text === 'FILES') {
    tool('write-0', 'write', { path: process.cwd() + '/created.txt', content: 'new body' }, `Successfully wrote to ${process.cwd()}/created.txt`)
    tool('write-1', 'write', { path: process.cwd() + '/updated.txt', content: 'newer body' }, `Successfully wrote to ${process.cwd()}/updated.txt`)
    tool('edit-2', 'edit', { path: process.cwd() + '/edited.txt', edits: [{ oldText: 'before', newText: 'after' }] }, `Edited ${process.cwd()}/edited.txt`)
    tool('alien', 'bash', { command: 'printf x > /tmp/not-tracked' }, 'done')
    return setTimeout(() => { saySnap('Files done'); settle() }, 10)
  }
  if (text === 'LIFECYCLE') {
    send({ type: 'compaction_start', reason: 'threshold' })
    send({ type: 'compaction_end', reason: 'threshold', result: { summary: 'Compacted', firstKeptEntryId: 'e2', tokensBefore: 9000, estimatedTokensAfter: 2000 } })
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '529 overloaded' })
    send({ type: 'auto_retry_end', success: true, attempt: 2 })
    return setTimeout(() => { saySnap('Lifecycle done'); settle() }, 10)
  }
  if (text === 'FAILRETRY') {
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '529 overloaded' })
    send({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' })
    return setTimeout(() => { saySnap('partial answer'); settle() }, 10)
  }
  if (text.includes('DIALOG')) {
    pendingDialog = { id: `dialog-${turn}`, method: 'select', title: 'Pick one', options: ['Red', 'Blue'] }
    return send({ type: 'extension_ui_request', id: pendingDialog.id, method: 'select', title: 'Pick one', options: ['Red', 'Blue'] })
  }
  if (text === 'IMG') return setTimeout(() => { saySnap(`Seen ${record.images?.length ?? 0} image(s)`); settle() }, 10)
  if (text.includes('EFFORT')) return setTimeout(() => { saySnap(`Effort ${arg('--thinking') ?? 'none'}`); settle() }, 10)
  if (text === 'WAIT') return setTimeout(() => { saySnap('Waited'); settle() }, Number(process.env.PI_FIXTURE_WAIT_MS) || 200)
  setTimeout(() => { say('Hello world'); settle() }, 10)
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim()) receive(line)
  }
})
