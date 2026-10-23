import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeDriver } from '../agent-drivers/dist/opencode/index.js'
import { cliVersion, findExecutable } from '../agent-drivers/dist/cli.js'

const bin = findExecutable('opencode')
assert.ok(bin, 'Install OpenCode before running this local check')
const root = mkdtempSync(join(tmpdir(), 'nodo-es05-opencode-'))
const cwd = join(root, 'workspace')
mkdirSync(cwd)
let requests = 0, driver, otherDriver, failure, offeredTools = [], writeFields
const issued = new Set()
let releaseWrites
const writesReady = new Promise(resolve => { releaseWrites = resolve })
const events = []
const otherEvents = []
const shape = value => Array.isArray(value) ? value.slice(0, 2).map(shape) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value
const files = Array.from({ length: 10 }, (_, i) => join(cwd, `proof-${i + 1}.txt`))
const otherFiles = Array.from({ length: 3 }, (_, i) => join(cwd, `other-${i + 1}.txt`))
const wrapper = join(root, 'opencode.cjs')
const wire = join(root, 'wire-shapes.jsonl')
writeFileSync(wrapper, `#!/usr/bin/env node
const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),{appendFileSync}=require('node:fs')
const child=spawn(${JSON.stringify(bin)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']})
const shape=v=>Array.isArray(v)?v.slice(0,2).map(shape):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shape(x)])):typeof v
process.stdin.pipe(child.stdin)
createInterface({input:child.stdout}).on('line',line=>{process.stdout.write(line+'\\n');try{const u=JSON.parse(line).params?.update;if(u?.toolCallId)appendFileSync(${JSON.stringify(wire)},JSON.stringify({update:u.sessionUpdate,kind:u.kind,status:u.status,locations:shape(u.locations),content:shape(u.content),meta:shape(u._meta),rawOutput:shape(u.rawOutput)})+'\\n',{mode:0o600})}catch{}})
child.on('exit',code=>process.exit(code??0));process.on('SIGTERM',()=>child.kill('SIGTERM'))
`)
chmodSync(wrapper, 0o755)
const server = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests += 1
    offeredTools = (body.tools ?? []).map(tool => tool.function?.name)
    const write = body.tools?.find(tool => tool.function?.name === 'write')?.function
    if (write) writeFields = { required: write.parameters?.required, fields: Object.keys(write.parameters?.properties ?? {}) }
    const done = body.messages?.some(message => message.role === 'tool')
    const role = JSON.stringify(body.messages).includes('ES05_ROLE_B') ? 'B' : 'A'
    const selected = role === 'B' ? otherFiles : files
    const calls = !done && write && !issued.has(role) ? selected.map((path, index) => ({ index, id: `es05-${role}-${index}`, type: 'function', function: {
      name: write.name, arguments: JSON.stringify({ [write.parameters?.properties?.path ? 'path' : 'filePath']: path, content: `ES05_LOCAL_${index + 1}\n` }),
    } })) : undefined
    if (calls) {
      issued.add(role)
      if (issued.size === 2) releaseWrites()
      await writesReady
    }
    const base = { id: 'es05-local', object: 'chat.completion.chunk', created: 1, model: 'fixture' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: 'ES05_LOCAL_DONE' }) }, finish_reason: null }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) { failure = error; response.writeHead(500); response.end('Local fixture failed') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const config = { model: 'es05/fixture', small_model: 'es05/fixture', enabled_providers: ['es05'], share: 'disabled', autoupdate: false,
    provider: { es05: { npm: '@ai-sdk/openai-compatible', name: 'ES05 local fixture', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only' },
      models: { fixture: { name: 'ES05 local', limit: { context: 32000, output: 8000 } } } } } }
  const env = { XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' }
  const version = await cliVersion(bin, { env })
  driver = createOpencodeDriver({ bin: wrapper, cwd, env, model: 'es05/fixture', permission: 'workspace', onEvent: event => {
    events.push(event)
    if (event.type === 'request/opened' && event.kind === 'permission') void driver.respondToRequest(event.id, { decision: 'allow' }).catch(error => { failure = error })
  } })
  otherDriver = createOpencodeDriver({ bin: wrapper, cwd, env, model: 'es05/fixture', permission: 'workspace', onEvent: event => {
    otherEvents.push(event)
    if (event.type === 'request/opened' && event.kind === 'permission') void otherDriver.respondToRequest(event.id, { decision: 'allow' }).catch(error => { failure = error })
  } })
  await driver.openSession()
  await otherDriver.openSession()
  await Promise.all([driver.sendTurn('ES05_ROLE_A: Write ten requested local fixture files using the write tool.'),
    otherDriver.sendTurn('ES05_ROLE_B: Write three other local fixture files using the write tool.')])
  const deadline = Date.now() + 90000
  while ((!events.some(event => event.type === 'turn/end') || !otherEvents.some(event => event.type === 'turn/end')) && Date.now() < deadline) {
    if (failure) throw failure
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const end = events.find(event => event.type === 'turn/end')
  assert.equal(end?.reason, 'done', 'The actual CLI must finish the local-model turn')
  assert.equal(otherEvents.find(event => event.type === 'turn/end')?.reason, 'done')
  for (const [i, path] of files.entries()) assert.equal(readFileSync(path, 'utf8'), `ES05_LOCAL_${i + 1}\n`)
  const changes = events.find(event => event.type === 'changes')
  assert.equal(changes?.presentation.body.fileCount, 10, 'The actual CLI must expose all ten confirmed file edits')
  const otherChanges = otherEvents.find(event => event.type === 'changes')
  assert.equal(otherChanges?.presentation.body.fileCount, 3)
  for (const [i, path] of otherFiles.entries()) assert.equal(readFileSync(path, 'utf8'), `ES05_LOCAL_${i + 1}\n`)
  assert.ok(changes.presentation.body.files.every(file => files.includes(file.path)))
  assert.ok(otherChanges.presentation.body.files.every(file => otherFiles.includes(file.path)))
  console.log(JSON.stringify({ result: 'passed', actualCli: 'opencode', version, model: 'local HTTP fixture', remoteModelCalls: 0, localRequests: requests,
    filesWritten: files.length, reportedFiles: changes.presentation.body.fileCount, concurrentOtherFiles: otherChanges.presentation.body.fileCount,
    sameWorkspaceIsolation: true, coverage: changes.presentation.body.coverage }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', message: String(error.message).replaceAll(root, '<isolated>'), localRequests: requests, offeredTools, writeFields,
    firstToolOutput: shape(events.find(event => event.type === 'tool' && event.phase === 'end')?.output),
    wireShape: (() => { try { return readFileSync(wire, 'utf8').trim().split('\n').slice(0, 2).map(JSON.parse) } catch { return null } })(),
    events: events.filter(event => ['tool', 'changes', 'turn/end'].includes(event.type)).map(event => ({ type: event.type, phase: event.phase, name: event.name,
      reason: event.reason, files: event.presentation?.body?.fileCount, outputType: Array.isArray(event.output) ? event.output.map(block => block.type) : typeof event.output })) }))
  process.exitCode = 1
} finally {
  releaseWrites(); driver?.dispose(); otherDriver?.dispose(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true })
}
