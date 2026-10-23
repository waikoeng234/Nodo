import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeDriver } from '../agent-drivers/src/opencode/index.js'
import { cliVersion, findExecutable } from '../agent-drivers/src/cli.js'
import { toolText } from '../src/host/text.js'
import { createPump } from '../src/host/adapter/pump.js'

const bin = findExecutable('opencode')
assert.ok(bin, 'Install OpenCode before running this local check')
const root = mkdtempSync(join(tmpdir(), 'nodo-opencode-read-'))
const cwd = join(root, 'workspace')
mkdirSync(cwd)
const path = join(cwd, 'proof.txt')
writeFileSync(path, 'OPENCODE_READ_PROOF\n')
const events = []
let driver, pump, failure, requests = 0, modelSawContents = false
const server = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests++
    const read = body.tools?.find(tool => tool.function?.name === 'read')?.function
    const done = body.messages?.some(message => message.role === 'tool')
    if (done) modelSawContents ||= JSON.stringify(body.messages.filter(message => message.role === 'tool')).includes('OPENCODE_READ_PROOF')
    const field = read?.parameters.properties.path ? 'path' : 'filePath'
    const calls = done || !read ? undefined : [
      { index: 0, id: 'read-proof', type: 'function', function: { name: read.name, arguments: JSON.stringify({ [field]: path }) } },
      { index: 1, id: 'read-missing', type: 'function', function: { name: read.name, arguments: JSON.stringify({ [field]: join(cwd, 'missing.txt') }) } },
    ]
    const base = { id: 'local-read', object: 'chat.completion.chunk', created: 1, model: 'fixture' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: 'READ_CHECK_DONE' }) }, finish_reason: null }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) { failure = error; response.writeHead(500); response.end('Local fixture failed') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const config = { model: 'local/fixture', small_model: 'local/fixture', enabled_providers: ['local'], share: 'disabled', autoupdate: false,
    provider: { local: { npm: '@ai-sdk/openai-compatible', name: 'Local read check', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only' },
      models: { fixture: { name: 'Local fixture', limit: { context: 32000, output: 8000 } } } } } }
  const env = { XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' }
  const version = await cliVersion(bin, { env })
  driver = createOpencodeDriver({ bin, cwd, env, model: 'local/fixture', permission: 'workspace', onEvent: event => {
    events.push(event)
    pump?.receive(event)
    if (event.type === 'request/opened' && event.kind === 'permission') void driver.respondToRequest(event.id, { decision: 'allow' }).catch(error => { failure = error })
  } })
  pump = createPump({ driver })
  const options = { messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the local proof file and missing file with the read tool.' }] }] }
  let boundary
  const consume = async () => {
    const chunks = []
    for await (const chunk of pump.stream(options)) chunks.push(chunk)
    const block = chunks.find(chunk => chunk.block?.type === 'tool-call')?.block
    boundary = block ? JSON.parse(block.arguments) : null
    return chunks.at(-1)?.reason?.kind
  }
  let finish = await consume()
  const deadline = Date.now() + 60000
  while (!events.some(event => event.type === 'turn/end') && Date.now() < deadline) {
    if (failure) throw failure
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(events.find(event => event.type === 'turn/end')?.reason, 'done')
  const results = events.filter(event => event.type === 'tool' && event.phase === 'end')
  const success = results.find(event => !event.isError)
  const failed = results.find(event => event.isError)
  assert.ok(modelSawContents, 'The model must receive the native read contents')
  assert.match(toolText(success?.output), /OPENCODE_READ_PROOF/)
  assert.ok(Object.values(success.input).includes(path), 'Final read input must contain the actual path')
  assert.match(toolText(failed?.output), /not found|no such file/i)
  let mirroredReads = 0
  for (let steps = 0; finish === 'tool-calls' && steps < 4; steps++) {
    const claim = pump.takeMirror()
    assert.equal(claim?.settled, true, 'The native mirror must find buffered results beyond parameter updates')
    const result = await claim.done
    if (boundary?.kind !== 'changes') {
      assert.match(result.detail, /OPENCODE_READ_PROOF|not found|no such file/i)
      mirroredReads++
    }
    finish = await consume()
  }
  assert.equal(finish, 'stop')
  assert.equal(mirroredReads, 2)
  console.log(JSON.stringify({ result: 'passed', version, remoteModelCalls: 0, localRequests: requests,
    modelSawContents, displayedContents: true, displayedFailure: true, finalInput: true, mirroredReads }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', message: String(error.message).replaceAll(root, '<isolated>'), localRequests: requests }))
  process.exitCode = 1
} finally {
  pump?.dispose()
  driver?.dispose()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
