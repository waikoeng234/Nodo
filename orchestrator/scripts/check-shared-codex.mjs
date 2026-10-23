import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createDriver } from '../agent-drivers/dist/index.js'
import { connectCodex } from '../agent-drivers/dist/codex/native.js'
import { findExecutable } from '../agent-drivers/dist/cli.js'

const home = mkdtempSync(join(tmpdir(), 'orch-shared-codex-'))
const socket = join(home, 's')
const calls = []
const changesProbe = process.argv.includes('--changes')
let patchSent = false
let probeFailure
const mock = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  calls.push(JSON.parse(raw))
  const id = `response-${calls.length}`
  const message = { type: 'message', id: `message-${calls.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native Codex reply', annotations: [] }] }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
  if (changesProbe && !patchSent) {
    const tools = calls.at(-1).tools ?? []
    const direct = tools.find(tool => tool.name === 'apply_patch')
    const namespace = tools.find(tool => tool.tools?.some(child => child.name === 'apply_patch'))
    const tool = direct ?? namespace?.tools.find(tool => tool.name === 'apply_patch')
    const commandTool = tools.find(tool => tool.name === 'exec_command')
    if (!tool && !commandTool) { probeFailure = 'Local model offers neither patch nor command tools'; response.end(); return }
    patchSent = true
    const patch = '*** Begin Patch\n' + Array.from({ length: 10 }, (_, i) => `*** Add File: file-${i}.txt\n+local confirmed\n`).join('') + '*** End Patch'
    const item = tool ? { type: 'custom_tool_call', id: 'local-patch', call_id: 'local-patch', name: 'apply_patch', input: patch, status: 'completed', ...(namespace ? { namespace: namespace.name } : {}) }
      : { type: 'function_call', id: 'local-patch', call_id: 'local-patch', name: 'exec_command', arguments: JSON.stringify({ cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`, workdir: home }), status: 'completed' }
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(tool ? { input: '' } : { arguments: '' }), status: 'in_progress' } })
    send(tool ? { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: item.id, delta: patch }
      : { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments })
    send({ type: 'response.output_item.done', output_index: 0, item })
    send({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } })
    response.end(); return
  }
  send({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } })
  send({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Native Codex reply' })
  send({ type: 'response.output_item.done', output_index: 0, item: message })
  send({ type: 'response.completed', response: { id, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  response.end()
})
mock.listen(0, '127.0.0.1')
await once(mock, 'listening')
const bin = findExecutable('codex')
const runtime = spawn(bin, ['app-server', '--listen', `unix://${socket}`,
  '-c', changesProbe ? 'model="gpt-5.3-codex"' : 'model="orch_mock"', '-c', 'model_provider="orch_mock"',
  '-c', 'model_providers.orch_mock.name="Local mock"',
  '-c', `model_providers.orch_mock.base_url="http://127.0.0.1:${mock.address().port}"`,
  '-c', 'model_providers.orch_mock.wire_api="responses"',
  '-c', 'model_providers.orch_mock.requires_openai_auth=false',
], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
runtime.stdout.on('data', () => {})
let runtimeFailure = ''
runtime.stderr.on('data', chunk => { runtimeFailure = (runtimeFailure + chunk).slice(-2000) })
const until = async check => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (probeFailure) throw new Error(probeFailure)
    if (runtime.exitCode !== null) throw new Error(`Isolated Codex runtime exited (${runtime.exitCode}); ${/Operation not permitted/.test(runtimeFailure) ? 'OS permission denied' : /too long|length/i.test(runtimeFailure) ? 'socket path rejected' : 'raw diagnostic withheld'}`)
    const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Shared Codex integration timed out')
}
const events = []
let driver
let observer
try {
  await until(() => existsSync(socket))
  driver = createDriver('codex', { bin, socket, cwd: home, env: { CODEX_HOME: home }, name: 'Native integration', sessionName: 'Session 1', ...(changesProbe ? { permission: 'full' } : {}), onEvent: event => events.push(event) })
  const send = async text => {
    events.length = 0
    await driver.sendTurn(text)
    const end = await until(() => events.find(event => event.type === 'turn/end'))
    assert.equal(end.reason, 'done', end.error)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Native Codex reply')
  }
  await send('FIRST')
  if (changesProbe) {
    const body = events.find(event => event.type === 'changes')?.presentation.body
    assert.equal(body?.fileCount, 10)
    assert.deepEqual(new Set(body.files.map(file => file.path)), new Set(Array.from({ length: 10 }, (_, i) => join(home, `file-${i}.txt`))))
    for (const file of body.files) assert.equal(readFileSync(file.path, 'utf8'), 'local confirmed\n')
    assert.equal(typeof body.turnDiff, 'string', 'Actual turn/diff notification should reach the snapshot')
    console.log(JSON.stringify({ result: 'passed', actualCli: 'codex', filesWritten: 10, reportedFiles: 10, actualTurnDiff: true, localRequests: calls.length, remoteModelCalls: 0 }))
  } else {
  const binding = events.find(event => event.sessionId)
  assert.ok(binding.workspaceId)
  observer = await connectCodex({ executable: bin, socket, env: { CODEX_HOME: home } })
  await observer.request('initialize', { clientInfo: { name: 'native_observer', version: '0.1.0' }, capabilities: { experimentalApi: true } })
  observer.notify('initialized')
  const resumed = await observer.request('thread/resume', { threadId: binding.sessionId, excludeTurns: true })
  assert.equal(resumed.thread.id, binding.sessionId)
  await send('SECOND')
  assert.equal(calls.length, 2)
  const metadata = await observer.request('thread/read', { threadId: binding.sessionId, includeTurns: false })
  assert.equal(metadata.thread.projectId, binding.workspaceId)
  driver.dispose()
  driver = createDriver('codex', { bin, socket, cwd: home, env: { CODEX_HOME: home }, driverSessionId: binding.sessionId, onEvent: event => events.push(event) })
  await send('THIRD')
  const nextEvents = []
  const another = createDriver('codex', { bin, socket, cwd: home, env: { CODEX_HOME: home }, name: 'Native integration', sessionName: 'Session 2', onEvent: event => nextEvents.push(event) })
  try {
    await another.openSession()
    const nextBinding = nextEvents.find(event => event.sessionId)
    assert.notEqual(nextBinding.sessionId, binding.sessionId)
    const draft = await observer.request('thread/read', { threadId: nextBinding.sessionId, includeTurns: false })
    assert.equal(draft.thread.projectId, binding.workspaceId)
    // Codex lists durable conversations after their first turn; the empty
    // draft already exists and can be addressed by its native thread id.
    await another.sendTurn('NEW_SESSION')
    assert.equal((await until(() => nextEvents.find(event => event.type === 'turn/end'))).reason, 'done')
    assert.equal(calls.at(-1).input.some(item => item.role === 'assistant'), false)
    const list = await observer.request('thread/list', { projectId: binding.workspaceId, limit: 20, sourceKinds: ['cli', 'vscode', 'appServer'] })
    assert.equal(list.data.length, 2)
  } finally { another.dispose() }
  console.log('Real shared Codex runtime: native project, two clients on one thread, multi-turn reconnect and two sessions passed (local mock provider)')
  }
} finally {
  driver?.dispose(); observer?.dispose()
  runtime.kill('SIGTERM')
  await Promise.race([once(runtime, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
  if (runtime.exitCode === null) runtime.kill('SIGKILL')
  mock.closeAllConnections()
  await new Promise(resolve => mock.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
