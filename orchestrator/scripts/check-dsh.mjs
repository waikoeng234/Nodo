// Opt-in integration check against an installed DSH CLI. All provider traffic
// goes to a local mock and all DSH data lives in a disposable temporary home.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { checkEngine, createDriver } from '../agent-drivers/dist/index.js'

const waitFor = async (check, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Integration check timed out')
}
const home = mkdtempSync(join(tmpdir(), 'orch-dsh-integration-'))
const calls = []
const delays = new Set()
const server = createServer(async (request, response) => {
  // DSH < 0.2 posts to /chat/completions; DSH >= 0.2 posts to <baseURL>/v1/messages.
  const openai = request.url.endsWith('/chat/completions')
  if (!openai && !request.url.endsWith('/messages')) { response.writeHead(404); response.end(); return }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  calls.push(body)
  const last = body.messages.at(-1).content
  const text = typeof last === 'string' ? last : last?.map(block => block.text ?? '').join('')
  const complete = () => {
    if (response.destroyed) return
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (!openai) {
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      event('message_start', { type: 'message_start', message: { id: `mock-${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DSH mock reply' } })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      event('message_stop', { type: 'message_stop' })
      response.end()
      return
    }
    const chunk = { id: `mock-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: body.model }
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'DSH mock reply' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  if (text?.includes('HOLD')) {
    const timer = setTimeout(() => { delays.delete(timer); complete() }, 10000)
    delays.add(timer)
    response.on('close', () => { clearTimeout(timer); delays.delete(timer) })
  } else complete()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const endpoint = `http://127.0.0.1:${server.address().port}`
// Trusted DSH configuration pins the provider to the local mock even if the
// launching shell has its own provider settings.
writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-deepseek', config: { baseURL: endpoint, apiKeyEnv: 'ORCH_DSH_MOCK_KEY' } },
]))
const events = []
const config = { cwd: home, home, storageDir: join(home, 'agent'), ...(process.argv[2] ? { bin: process.argv[2] } : {}),
  env: { ORCH_DSH_MOCK_KEY: 'local-test-only', DEEPSEEK_BASE_URL: endpoint }, onEvent: event => events.push(event) }
let driver
try {
  const check = await checkEngine({ engine: 'dsh', cwd: home, engineOptions: { home, ...(config.bin ? { bin: config.bin } : {}) } })
  assert.equal(check.ok, true, JSON.stringify(check.checks))
  console.log(`DSH ${check.version}: CLI / ACP handshake passed`)
  driver = createDriver('dsh', config)
  const send = async text => {
    events.length = 0
    await driver.sendTurn(text)
    const end = await waitFor(() => events.find(event => event.type === 'turn/end'))
    assert.equal(end.reason, 'done', end.error)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'DSH mock reply')
    return events.find(event => event.sessionId)?.sessionId
  }
  const sessionId = await send('FIRST')
  assert.ok(sessionId)
  assert.ok(sessionId.startsWith('dsh:isolated:'))
  await send('SECOND')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].messages.some(message => message.role === 'assistant'), 'follow-up must carry prior conversation')
  console.log('Two real CLI turns with a local mock provider passed')
  assert.equal(existsSync(join(home, 'sessions')), false, 'agent sessions must stay out of Desktop shared storage')
  assert.equal(existsSync(join(home, 'agent/dsh/sessions')), true)
  console.log('Agent session storage isolation passed')
  events.length = 0
  await driver.sendTurn('HOLD')
  await waitFor(() => calls.length === 3)
  await driver.interruptTurn()
  assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
  console.log('Real CLI cancellation passed')
  driver.dispose()
  // The CLI flushes its persisted session while handling SIGTERM.
  await new Promise(resolve => setTimeout(resolve, 500))
  driver = createDriver('dsh', { ...config, driverSessionId: sessionId })
  await send('AFTER_RESTART')
  assert.equal(events.find(event => event.sessionId)?.sessionId, sessionId)
  assert.ok(calls.at(-1).messages.filter(message => message.role === 'assistant').length >= 2)
  console.log('Real CLI persisted session resume passed')
} finally {
  driver?.dispose()
  for (const timer of delays) clearTimeout(timer)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => setTimeout(resolve, 500))
  rmSync(home, { recursive: true, force: true })
}
