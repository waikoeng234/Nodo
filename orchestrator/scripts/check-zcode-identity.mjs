import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZcodeDriver, findZcodeExecutable } from '../agent-drivers/dist/zcode/index.js'
import { createIdentityFiles } from '../agent-drivers/dist/identity-files.js'

// Use a separate home and local model endpoint, leaving real login data alone.
if (process.argv[2] !== '--worker') {
  const root = mkdtempSync(join(tmpdir(), 'nodo-zcode-identity-live-'))
  const home = join(root, 'user')
  mkdirSync(home)
  try {
    const bin = findZcodeExecutable(process.argv[2] ?? 'zcode')
    assert.ok(bin, 'ZCode CLI not found')
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', root, bin], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 90000,
    })
    process.stdout.write(result.stdout)
    if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.slice(-2000))
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
} else {
  const root = resolve(process.argv[3]), bin = process.argv[4], home = join(root, 'user')
  const captures = [], drivers = [], stages = []
  process.once('SIGTERM', () => { for (const driver of drivers) driver.dispose(); process.exit(1) })
  let stage = 'first', toolSent = false
  const marker = 'NODO_CODER_IDENTITY', globalMarker = 'NODO_GLOBAL_RULE'
  const coder = `${marker}\n${'完整角色边界与长期规则。'.repeat(4000)}\nROLE_END_MARKER`
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const mock = createServer(async (req, res) => {
    req.setEncoding('utf8')
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const compact = JSON.stringify(body.messages.at(-1)?.content).includes('CRITICAL: Respond with TEXT ONLY.')
    const primary = Boolean(body.tools?.length) && !compact
    const tool = primary && stage === 'automatic' && !toolSent
    captures.push({ stage, body, compact, tool })
    if (tool) toolSent = true
    const content = primary ? 'Local answer' : '<summary>Continue the local identity verification task.</summary>'
    const tool_calls = tool ? [{ index: 0, id: 'local-bash', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `test "$HOME" = ${quote(home)} && ${quote(process.execPath)} -e 'console.log("SHELL_HOME_RESTORED");console.log("x".repeat(120000))'`, description: 'Check the isolated shell home and generate local compaction input' }) } }] : undefined
    const usage = { prompt_tokens: tool ? 23000 : 100, completion_tokens: 2, total_tokens: tool ? 23002 : 102 }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'local', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: `local-${captures.length}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1' }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls } : { content }) }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(done => mock.listen(0, '127.0.0.1', done))
  mkdirSync(join(home, '.zcode'), { recursive: true })
  writeFileSync(join(home, '.zcode/AGENTS.md'), globalMarker)
  mkdirSync(join(home, '.zcode/cli'), { recursive: true })
  writeFileSync(join(home, '.zcode/cli/config.json'), JSON.stringify({ mcp: { servers: { existing: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../agent-drivers/dist/role-server.js', import.meta.url))], env: { NODO_ROLE_INSTRUCTIONS: 'EXISTING_MCP_CONTEXT', NODO_ROLE_TOOL_IDENTITY: '1' } } } }, plugins: { enabledPlugins: { 'fixture-disabled': false } } }))
  writeFileSync(join(root, '.env'), '')
  const personal = join(root, 'personal.json')
  writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: 'nodo-local', providerName: 'Local mock', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: 'local-test-only' },
      api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }, personalModelIds: ['gpt-4.1'],
    } }] },
    modelConfigRules: { providerModelRules: [{ providerId: 'nodo-local', modelId: 'gpt-4.1', config: { properties: { contextWindow: 24000 } } }], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'nodo-local', modelId: 'gpt-4.1' },
  } }))
  const env = {
    HOME: home, SHELL: '/bin/bash', ZCODE_DATA_BASE_DIR: home, ZCODE_STORAGE_DIR: join(home, '.zcode'),
    ZCODE_MODEL_TELEMETRY_ENABLED: 'false', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(dirname(bin), '../config/provider/zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
  }
  const identityFiles = createIdentityFiles(join(root, 'identities'))
  const makeDriver = (role = coder, driverSessionId) => {
    const events = []
    const driver = createZcodeDriver({ bin, cwd: root, env, model: 'nodo-local$gpt-4.1', instructions: role, identityFiles, identityOwner: role === coder ? 'coder' : 'reviewer', driverSessionId,
      onEvent: event => { events.push(event); if (event.type === 'request/opened' && event.kind === 'permission') void driver.respondToRequest(event.id, { decision: 'allow' }) },
    })
    drivers.push(driver)
    return { driver, events }
  }
  const turn = async (entry, task) => {
    entry.events.length = 0
    await entry.driver.sendTurn(task)
    const deadline = Date.now() + 25000
    while (!entry.events.some(event => event.type === 'turn/end') && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
    const end = entry.events.find(event => event.type === 'turn/end')
    assert.equal(end?.reason, 'done', `${stage}: ${end?.error ?? 'timeout'}`)
    assert.equal(entry.driver.instructionMode, 'native', `${stage}: ${entry.driver.instructionFallback}`)
    assert.equal(entry.driver.instructionTarget, 'tool-schema')
    stages.push(stage)
  }
  try {
    let entry = makeDriver()
    await turn(entry, 'FIRST_TASK')
    const sessionId = entry.events.find(event => event.type === 'session' && event.sessionId)?.sessionId
    assert.ok(sessionId)
    stage = 'second'
    await turn(entry, 'SECOND_TASK')
    stage = 'manual-compact'
    await entry.driver.compact()
    stage = 'after-manual'
    await turn(entry, 'AFTER_MANUAL_COMPACT')
    entry.driver.dispose()
    stage = 'resume'
    entry = makeDriver(coder, sessionId)
    await turn(entry, 'RESUMED_TASK')
    stage = 'automatic'
    await turn(entry, 'AUTO_TASK')
    stage = 'other-role'
    const other = makeDriver('NODO_REVIEWER_IDENTITY')
    await Promise.all([turn(entry, 'CODER_PARALLEL_TASK'), turn(other, 'REVIEWER_PARALLEL_TASK')])
    const counts = captures.map(({ stage, body, compact }) => {
      const text = JSON.stringify(body.messages)
      const schemas = JSON.stringify(body.tools ?? [])
      return { stage, compact, primary: Boolean(body.tools?.length) && !compact, coder: schemas.split(marker).length - 1, completeCoder: body.tools?.some(item => item.function?.description?.includes(coder)), reviewer: schemas.split('NODO_REVIEWER_IDENTITY').length - 1, identityInHistory: text.includes(marker) || text.includes('NODO_REVIEWER_IDENTITY'), existingMcp: schemas.includes('EXISTING_MCP_CONTEXT'), global: text.split(globalMarker).length - 1, shellHome: body.messages.some(item => item.role === 'tool' && JSON.stringify(item.content).includes('SHELL_HOME_RESTORED')), messageCount: body.messages.length }
    })
    console.log(JSON.stringify({ stages, counts }, null, 2))
    for (const result of counts.filter(item => item.primary)) {
      assert.equal(result.global, 1, 'global instruction must appear exactly once')
      assert.equal(result.coder + result.reviewer, 1, 'each request must contain only its own identity once')
      assert.equal(result.identityInHistory, false, 'identity must stay out of task and history messages')
      if (result.coder) assert.equal(result.completeCoder, true, 'long identity must arrive intact')
      assert.equal(result.existingMcp, true, 'existing user MCP tools must remain available')
    }
    assert.ok(counts.some(item => item.stage === 'manual-compact' && item.compact), 'manual compaction must issue a summary request')
    const automatic = captures.filter(item => item.stage === 'automatic')
    const toolIndex = automatic.findIndex(item => item.tool)
    const compactIndex = automatic.findIndex((item, index) => index > toolIndex && item.compact)
    assert.ok(toolIndex >= 0 && compactIndex > toolIndex && compactIndex < automatic.length - 1, 'automatic compaction must occur between the tool call and continuation within one turn')
    assert.ok(counts.some(item => item.stage === 'automatic' && item.primary && item.shellHome), 'Bash must restore HOME during the automatic-compaction turn')
    assert.ok(existsSync(join(home, '.zcode/cli/db/db.sqlite')), 'the original user session store must remain in use')
  } finally {
    for (const driver of drivers) driver.dispose()
    mock.closeAllConnections()
    await new Promise(done => mock.close(done))
    await new Promise(done => setTimeout(done, 250))
  }
}
