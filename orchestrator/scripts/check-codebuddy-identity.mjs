import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver } from '../agent-drivers/src/index.js'

// Real CodeBuddy CLI against a local mock model, with a separate home and
// config directory; the placeholder key only passes the ACP login gate.
const root = mkdtempSync(join(tmpdir(), 'nodo-codebuddy-identity-live-'))
const home = join(root, 'home'), config = join(root, 'config'), cwd = join(root, 'work')
for (const dir of [home, config, cwd]) mkdirSync(dir)
const bin = process.argv[2] ?? 'codebuddy'
const marker = 'NODO_CODER_IDENTITY', other = 'NODO_REVIEWER_IDENTITY'
const coder = `${marker}\n${'完整角色边界与长期规则。'.repeat(1500)}\nROLE_END_MARKER`
const captures = [], drivers = []
let stage = 'first', toolSent = false
const mock = createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text || '{}')
  const tool = stage === 'automatic' && !toolSent && Boolean(body.tools?.length)
  if (tool) toolSent = true
  captures.push({ stage, body })
  const tool_calls = tool ? [{ index: 0, id: 'local-bash', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} -e 'console.log("x".repeat(120000))'`, description: 'Generate local compaction input' }) } }] : undefined
  const usage = { prompt_tokens: tool ? 29000 : 100, completion_tokens: 2, total_tokens: tool ? 29002 : 102 }
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'local', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: '<summary>Continue the local identity check.</summary>' }, finish_reason: 'stop' }], usage }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: `local-${captures.length}`, object: 'chat.completion.chunk', created: 1, model: body.model }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls } : { content: 'Local answer' }) }, finish_reason: null }] })}\n\n`)
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
})
await new Promise(done => mock.listen(0, '127.0.0.1', done))
writeFileSync(join(config, 'models.json'), JSON.stringify({ models: [{ id: 'nodo-mock', name: 'Nodo mock', vendor: 'OpenAI', url: `http://127.0.0.1:${mock.address().port}/v1/chat/completions`, apiKey: 'local-test-only', maxInputTokens: 32000, maxOutputTokens: 2000, supportsToolCall: true, supportsImages: false }] }))
const env = { HOME: home, CODEBUDDY_CONFIG_DIR: config, CODEBUDDY_API_KEY: 'local-test-only' }
const makeDriver = (instructions, driverSessionId) => {
  const events = []
  const driver = createDriver('codebuddy', { bin, cwd, env, model: 'nodo-mock', permission: 'full', instructions, driverSessionId,
    onEvent: event => { events.push(event); if (event.type === 'request/opened' && event.kind === 'permission') void driver.respondToRequest(event.id, { decision: 'allow' }) } })
  drivers.push(driver)
  return { driver, events }
}
const outcomes = []
const turn = async (entry, task) => {
  entry.events.length = 0
  await entry.driver.sendTurn(task)
  const deadline = Date.now() + 60000
  while (!entry.events.some(event => event.type === 'turn/end') && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
  const end = entry.events.find(event => event.type === 'turn/end')
  outcomes.push([stage, end?.reason ?? 'timeout'])
  // CodeBuddy may end a turn that compacted internally as cancelled.
  if (stage !== 'automatic') assert.equal(end?.reason, 'done', `${stage}: ${end?.error ?? 'timeout'}`)
  assert.equal(entry.driver.instructionMode, entry.native === false ? 'none' : 'native', stage)
}
try {
  let entry = makeDriver(coder)
  await turn(entry, 'FIRST_TASK')
  const sessionId = entry.events.find(event => event.type === 'session' && event.sessionId)?.sessionId
  stage = 'second'; await turn(entry, 'SECOND_TASK')
  stage = 'manual-compact'; await turn(entry, '/compact')
  stage = 'after-manual'; await turn(entry, 'AFTER_MANUAL_COMPACT')
  stage = 'automatic'; await turn(entry, 'AUTO_TASK')
  stage = 'after-automatic'; await turn(entry, 'AFTER_AUTO_COMPACT')
  entry.driver.dispose()
  assert.ok(sessionId, 'the first boot must report a session id')
  stage = 'resume'; entry = makeDriver(coder, sessionId); await turn(entry, 'RESUMED_TASK')
  entry.driver.dispose()
  stage = 'other-role'; entry = makeDriver(other, sessionId); await turn(entry, 'OTHER_ROLE_TASK')
  entry.driver.dispose()
  stage = 'no-identity'; entry = makeDriver(undefined, sessionId); entry.native = false; await turn(entry, 'NO_IDENTITY_TASK')
  const rows = captures.filter(({ body }) => body.tools?.length > 1).map(({ stage, body }) => {
    const system = JSON.stringify(body.messages.filter(item => item.role === 'system'))
    const history = JSON.stringify(body.messages.filter(item => item.role !== 'system'))
    return { stage, coder: system.split(marker).length - 1, complete: system.includes('ROLE_END_MARKER'), other: system.split(other).length - 1, inHistory: history.includes(marker) || history.includes(other) }
  })
  console.log(JSON.stringify({ outcomes, rows }, null, 2))
  for (const row of rows) {
    assert.equal(row.inHistory, false, `${row.stage}: identity must stay out of task and history messages`)
    if (row.stage === 'other-role') assert.deepEqual([row.coder, row.other], [0, 1], 'a changed identity replaces the old one')
    else if (row.stage === 'no-identity') assert.deepEqual([row.coder, row.other], [0, 0], 'identity is not persisted in the session')
    else assert.deepEqual([row.coder, row.complete, row.other], [1, true, 0], `${row.stage}: identity must arrive once and intact`)
  }
  for (const name of ['first', 'second', 'after-manual', 'automatic', 'after-automatic', 'resume', 'other-role', 'no-identity']) assert.ok(rows.some(row => row.stage === name), `${name}: no primary model request`)
  const automatic = captures.filter(item => item.stage === 'automatic')
  assert.ok(automatic.some(item => !item.body.tools?.length && JSON.stringify(item.body.messages).includes('x'.repeat(1000))), 'automatic compaction must summarize the large tool output within the turn')
} finally {
  for (const driver of drivers) driver.dispose()
  mock.closeAllConnections()
  await new Promise(done => mock.close(done))
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
