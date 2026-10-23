import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZcodeDriver, findZcodeExecutable } from '../agent-drivers/src/zcode/index.js'
import { install } from '../src/host/adapter/registry.js'

const changesOnly = process.argv.includes('--changes')
if (process.argv[2] !== '--worker') {
  const root = mkdtempSync(join(tmpdir(), 'nodo-zcode-flow-'))
  const home = join(root, 'home')
  mkdirSync(home)
  try {
    const bin = findZcodeExecutable(process.argv.slice(2).find(arg => arg !== '--changes') ?? 'zcode')
    assert.ok(bin, 'ZCode CLI not found')
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', root, realpathSync(bin), ...(changesOnly ? ['--changes'] : [])], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60000,
    })
    process.stdout.write(result.stdout)
    assert.equal(result.status, 0, result.error?.message ?? result.stderr.slice(-2000))
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
} else {
  const root = process.argv[3], bin = process.argv[4], home = join(root, 'home'), cwd = join(root, 'workspace')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'input.txt'), 'local input')
  let stage = 'files', requests = 0, driver, adapter, service, cleanup
  const approvals = [], events = [], actions = []
  const pendingRequests = new Set()
  let peakRequests = 0
  const tool = (id, name, input, index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(input) } })
  const mock = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const compact = JSON.stringify(body.messages.at(-1)?.content).includes('CRITICAL: Respond with TEXT ONLY.')
    const primary = Boolean(body.tools?.length) && !compact
    if (primary) requests++
    if (primary && stage === 'retry' && requests === 1) { res.writeHead(503); res.end('local mock temporarily unavailable'); return }
    if (primary && stage === 'failed') { res.writeHead(401); res.end('local mock rejected request'); return }
    const calls = primary && stage === 'files' && requests === 1 ? [
      tool('local-read', 'Read', { file_path: join(cwd, 'input.txt') }, 0),
      tool('local-write', 'Write', { file_path: join(cwd, 'output.txt'), content: 'local output' }, 1),
      ...(changesOnly ? Array.from({ length: 9 }, (_, i) => tool(`local-write-${i}`, 'Write', { file_path: join(cwd, `file-${i}.txt`), content: 'local output' }, i + 2))
        : [1, 2].map((n, i) => tool(`local-bash-${n}`, 'Bash', { command: `printf local > '${join(root, `outside-${n}.txt`)}'`, description: `Local approval ${n}` }, i + 2))),
    ] : primary && stage === 'stop' && requests === 1 ? [tool('local-wait', 'Bash', { command: 'sleep 30', description: 'Local cancellation check' }, 0)] : undefined
    const base = { id: 'local', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1' }
    const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Local done' }, finish_reason: 'stop' }], usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: 'Local done' }) }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const personal = join(root, 'personal.json')
  writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: 'nodo-local', providerName: 'Local mock', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: 'local-test-only' },
      api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }, personalModelIds: ['gpt-4.1'],
    } }] }, modelConfigRules: { providerModelRules: [{ providerId: 'nodo-local', modelId: 'gpt-4.1', config: { properties: { contextWindow: 24000 } } }], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'nodo-local', modelId: 'gpt-4.1' },
  } }))
  const env = { HOME: home, SHELL: '/bin/bash', ZCODE_DATA_BASE_DIR: home, ZCODE_STORAGE_DIR: join(home, '.zcode'),
    ZCODE_MODEL_TELEMETRY_ENABLED: 'false', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(dirname(bin), '../config/provider/zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal }
  const binding = { profileId: 'local', preset: 'local-role', engine: 'zcode', cwd, engineOptions: { bin } }
  const agent = { id: 'local-session', session: {}, ctx: {}, status: 'running' }
  const ctx = {
    llm: { registerAdapter: (_ids, value) => { adapter = value; return () => {} } }, tools: { register() {} },
    agents: { get: () => agent }, agentPresets: { composedPreset: () => binding.preset },
    permissionPresets: { current: () => 'workspace', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }) },
    approval: { request: async request => { approvals.push(request.toolName); return 'allowed-once' } },
    provide: (_name, value) => { service = value }, on() {}, effect: fn => { cleanup = fn() },
  }
  install({ ctx, load: async () => {}, save: async () => {}, secretEnv: () => env, enginePermissionModes: () => ['workspace'],
    adapterMap: { of: () => binding, set: (_id, threadId) => { binding.threadId = threadId } }, conversationOf: () => null,
    createEngineDriver: async (_engine, options) => {
      driver = createZcodeDriver({ ...options, healthIntervalMs: 500, onEvent: event => {
        if (event.type === 'request/opened') pendingRequests.add(event.id)
        if (event.type === 'request/closed') pendingRequests.delete(event.id)
        peakRequests = Math.max(peakRequests, pendingRequests.size)
        events.push(event); options.onEvent(event)
      } })
      await driver.openSession()
      return driver
    } })
  const run = async name => {
    stage = name; requests = 0
    const start = events.length, controller = new AbortController()
    const options = { sessionId: agent.id, provider: 'nodo:zcode', model: 'nodo-local$gpt-4.1', signal: controller.signal,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: name }] }] }
    let timer
    try {
      for (let step = 0; step < 15; step++) {
        const chunks = []
        for await (const chunk of adapter.stream(options)) chunks.push(chunk)
        if (chunks.at(-1)?.reason.kind !== 'tool-calls') break
        const args = JSON.parse(chunks.find(chunk => chunk.block?.type === 'tool-call').block.arguments)
        actions.push(args.name)
        if (name === 'stop') timer = setTimeout(() => controller.abort(), 300)
        await service.execute(args, { agent, callId: `local-${step}`, signal: controller.signal })
        if (controller.signal.aborted) break
      }
      if (controller.signal.aborted) await driver.interruptTurn()
      const end = events.slice(start).find(event => event.type === 'turn/end')
      assert.equal(end?.reason, name === 'stop' ? 'interrupted' : 'done', JSON.stringify({ stage: name, requests, events: events.slice(start).filter(event => ['tool', 'turn/end'].includes(event.type)).map(event => ({ type: event.type, name: event.name, phase: event.phase, reason: event.reason, isError: event.isError, output: typeof event.output === 'string' ? event.output.slice(0, 180) : undefined })) }))
    } finally { clearTimeout(timer) }
  }
  try {
    await run('files')
    assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), 'local output')
    assert.ok(actions.includes('Read') && actions.includes('Write'))
    if (changesOnly) {
      const snapshot = events.find(event => event.type === 'changes')?.presentation.body
      assert.equal(snapshot?.fileCount, 10)
      assert.equal(snapshot.coverage, 'partial')
      assert.deepEqual(new Set(snapshot.files.map(file => file.path)), new Set([join(cwd, 'output.txt'), ...Array.from({ length: 9 }, (_, i) => join(cwd, `file-${i}.txt`))]))
      for (const file of snapshot.files) assert.equal(readFileSync(file.path, 'utf8'), 'local output')
      console.log(JSON.stringify({ result: 'passed', actualCli: 'zcode', filesWritten: 10, reportedFiles: snapshot.fileCount, coverage: snapshot.coverage, remoteModelCalls: 0 }))
    } else {
    assert.ok(approvals.length >= 2)
    await run('retry')
    assert.ok(events.some(event => event.type === 'note' && event.text.includes('重试')))
    await run('stop')
    await run('recovery')
    await assert.rejects(run('failed'))
    assert.equal(events.findLast(event => event.type === 'turn/end').reason, 'error')
    console.log(JSON.stringify({ result: 'passed', approvals: approvals.length, peakRequests, actions, checks: ['files', 'retry', 'stop', 'recovery', 'failure'] }))
    }
  } finally { await cleanup?.(); driver?.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)) }
}
