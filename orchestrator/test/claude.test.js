import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, checkEngine, scanEngine, validateEngineOptions } from '../agent-drivers/dist/index.js'
import { until, withHost } from './helpers/host.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-fixture-'))
  const bin = join(dir, 'claude')
  copyFileSync(new URL('./fixtures/claude-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const deltas = events => events.filter(event => event.type === 'delta').map(event => event.text).join('')

test('Claude adapter streams one response natively and resumes the same CLI session', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('claude', { bin, cwd, model: 'fixture-model', thinking: 'high', instructions: 'Role rules', onEvent: event => events.push(event) })
    try {
      assert.equal(driver.instructionMode, 'none', 'instructions are native only after the session is up')
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Hello world', 'completed text must not duplicate streamed text')
      assert.equal(events.filter(event => event.type === 'text').length, 0)
      assert.deepEqual(events.find(event => event.type === 'turn/end').usage,
        { inputTokens: 300, outputTokens: 90, cacheReadTokens: 900, cacheWriteTokens: 100, contextUsed: 1300, contextSize: 200000 },
        'the turn\'s buckets come from the result frame, the context from the last request and the routed window')
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-claude-session')

      events.length = 0
      await driver.compact()
      await until(() => events.find(event => event.type === 'turn/end'))
      const users = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.user !== undefined)
      assert.equal(users.at(-1).user, '/compact', 'compaction rides the native slash channel')
      assert.equal(driver.instructionMode, 'native')
      driver.dispose()
      events.length = 0
      driver = createDriver('claude', { bin, cwd, driverSessionId: 'fixture-claude-session', thinking: 'high', instructions: 'Role rules', onEvent: event => events.push(event) })
      await driver.sendTurn('EFFORT')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Effort high')
    } finally { driver.dispose() }
    const spawns = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)
    assert.equal(spawns[0].model, 'fixture-model')
    assert.equal(spawns[0].effort, 'high')
    assert.equal(spawns[0].instructions, 'Role rules')
    assert.equal(spawns[0].resume, undefined)
    assert.equal(spawns[1].resume, 'fixture-claude-session')
  })
})

test('Claude preserves streamed and assembled thinking and tool input/results without duplicates', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EVENTS')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.deepEqual(events.filter(event => event.type === 'thinking' && event.text).map(event => event.text), ['Check ', 'route.', ' More.', 'Fallback thought.'])
      assert.ok(events.some(event => event.type === 'thinking' && event.boundary === 'start' && event.blockIndex === 0))
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => [event.callId, event.phase]), [['stream-tool', 'start'], ['stream-tool', 'update'], ['stream-tool', 'update'],
        ['stream-tool', 'update'], ['stream-tool', 'update'], ['stream-tool', 'end'], ['assembled-tool', 'start'], ['assembled-tool', 'end']])
      assert.deepEqual(tools.filter(event => event.inputDelta !== undefined).map(event => event.inputDelta), ['{"path":', '"/tmp/fixture"}'])
      assert.deepEqual(tools[3].input, { path: '/tmp/fixture' })
      assert.deepEqual(tools[4].progress, { elapsedMs: 1500 })
      assert.deepEqual(tools[5].input, { path: '/tmp/fixture' })
      assert.equal(tools[5].output, 'done')
      assert.equal(tools[7].isError, true)
      assert.equal(tools[7].output, 'denied')
    } finally { driver.dispose() }
  })
})

test('Claude maps the CLI api_retry frame to a retry lifecycle with attempt identity', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('RETRY')
      await until(() => events.some(event => event.type === 'turn/end'))
      const retry = events.find(event => event.type === 'lifecycle' && event.kind === 'retry')
      assert.equal(retry.phase, 'start')
      assert.equal(retry.turnId, events.find(event => event.type === 'turn/start').turnId)
      assert.equal(retry.entityId, 'retry-2')
      assert.equal(retry.detail, '第 2/6 次，等待 5 秒：rate limited')
    } finally { driver.dispose() }
  })
})

test('Claude compaction boundaries close one status and subagent tasks stay attributed activity', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('LIFECYCLE')
      await until(() => events.some(event => event.type === 'turn/end'))
      const lifecycle = events.filter(event => event.type === 'lifecycle')
      assert.deepEqual(lifecycle.map(event => [event.kind, event.phase]),
        [['compaction', 'start'], ['compaction', 'end']], 'the boundary closes the status exactly once')
      const activity = events.filter(event => event.type === 'activity')
      assert.deepEqual(activity.map(event => [event.entityId, event.phase, event.isError === true]),
        [['task-1', 'start', false], ['task-1', 'update', false], ['task-1', 'end', true], ['task-2', 'start', false], ['task-2', 'end', false]])
      assert.equal(activity[0].title, 'Research subtask')
      assert.equal(activity[0].parentId, 'task-0')
      assert.equal(activity[0].toolCallId, 'spawn-tool')
      assert.equal(activity[1].detail, 'found 3 files')
      assert.equal(activity[2].detail, 'child boom')
      assert.equal(activity[4].detail, 'child two done')
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done', 'a failed member never ends the owning turn')
    } finally { driver.dispose() }
  })
})

test('Claude installs instructions before its delayed init frame and keeps first-turn messages clean', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, instructions: 'Stay a reviewer', env: { CLAUDE_FIXTURE_DELAY_INIT: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.openSession()
      assert.equal(events.some(event => event.type === 'session' && event.state === 'ready'), false)
      assert.equal(driver.instructionMode, 'native')
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      const requests = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requests.find(item => item.spawn).instructions, 'Stay a reviewer')
      assert.deepEqual(requests.filter(item => item.user !== undefined).map(item => item.user), ['FIRST'])
    } finally { driver.dispose() }
  })
})

test('Claude approvals and question answers round-trip through the control channel', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_PERMISSION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(card.kind, 'permission')
      assert.equal(await driver.respondToRequest(card.id, { decision: 'deny' }), true)
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.ok(events.some(event => event.type === 'tool' && event.phase === 'start' && event.name === 'Write'))
      assert.ok(events.some(event => event.type === 'tool' && event.phase === 'end' && event.isError === true))
      assert.equal(deltas(events), 'Denied')
      events.length = 0
      await driver.sendTurn('ASK_QUESTIONS')
      const question = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(question.kind, 'question')
      assert.deepEqual(question.detail.questions[0].options.map(option => option.label), ['Red', 'Blue'])
      await assert.rejects(driver.respondToRequest(question.id, { decision: 'answer', value: '  ' }), /Answer every question first/)
      assert.equal(events.filter(event => event.type === 'request/closed').length, 0, 'a failed answer must keep the card open')
      await driver.respondToRequest(question.id, { decision: 'answer', value: 'Blue' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered Blue')
    } finally { driver.dispose() }
  })
})

test('Claude permission tiers reach the spawned CLI args', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const permission of ['workspace', 'plan', 'full']) {
      const events = []
      const driver = createDriver('claude', { bin, cwd, permission, onEvent: event => events.push(event) })
      try {
        await driver.sendTurn('Hello')
        await until(() => events.find(event => event.type === 'turn/end'))
      } finally { driver.dispose() }
    }
    const modes = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.spawn).map(entry => entry.permissionMode)
    assert.deepEqual(modes, ['auto', 'plan', 'bypassPermissions'])
  })
})

for (const useFile of [false, true]) test(`Claude mounts the lead MCP on start and resume with exact allowedTools and an env-only ${useFile ? 'token file path' : 'token'}`, async () => {
  await withFixture(async ({ bin, cwd }) => {
    const socket = join(cwd, 'lead.sock')
    const tokenFile = join(cwd, 'lead.token')
    const leadMcpServers = [{ name: 'nodo_lead', command: process.execPath, args: [join(cwd, 'lead-server.js')],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket },
        { name: useFile ? 'NODO_LEAD_TOKEN_FILE' : 'NODO_LEAD_TOKEN', value: useFile ? tokenFile : 'lead-token-secret' }] }]
    let events = []
    let driver = createDriver('claude', { bin, cwd, leadMcpServers, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { driver.dispose() }
    events = []
    driver = createDriver('claude', { bin, cwd, driverSessionId: 'fixture-claude-session', leadMcpServers, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('SECOND')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { driver.dispose() }

    const spawns = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)
    assert.equal(spawns.length, 2)
    assert.equal(spawns[0].resume, undefined)
    assert.equal(spawns[1].resume, 'fixture-claude-session')
    for (const spawn of spawns) {
      assert.equal(JSON.stringify(spawn.spawn).includes('lead-token-secret'), false, 'the token never rides argv')
      assert.equal(spawn.spawn.includes('--strict-mcp-config'), false, 'user MCP servers stay loaded')
      const config = JSON.parse(spawn.mcpConfig)
      assert.deepEqual(config.mcpServers.nodo_lead, { command: process.execPath, args: [join(cwd, 'lead-server.js')], env: { ELECTRON_RUN_AS_NODE: '1' } },
        'only env without channel secrets enters the config')
      assert.equal(JSON.stringify(config).includes('lead-token-secret'), false)
      assert.equal(JSON.stringify(config).includes(socket), false)
      assert.equal(JSON.stringify(config).includes(tokenFile), false)
      assert.deepEqual(spawn.allowedTools, ['mcp__nodo_lead__nodo_board', 'mcp__nodo_lead__nodo_delegate', 'mcp__nodo_lead__nodo_interrupt'],
        'exactly the three lead tools skip approval, nothing injectable')
      assert.equal(spawn.leadSocketEnv, socket)
      assert.equal(spawn.leadTokenEnv, useFile ? undefined : 'lead-token-secret')
      assert.equal(spawn.leadTokenFileEnv, useFile ? tokenFile : undefined)
    }
    events = []
    const plain = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await plain.sendTurn('THIRD')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { plain.dispose() }
    const executor = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn).at(-1)
    assert.equal(executor.mcpConfig, undefined)
    assert.equal(executor.allowedTools, undefined)
    assert.equal(executor.leadTokenEnv, undefined)
    assert.equal(executor.leadTokenFileEnv, undefined)
    assert.equal(executor.leadSocketEnv, undefined)
    assert.equal(executor.spawn.includes('--mcp-config'), false)
  })
})

test('Claude interrupt rides the control channel and ends the turn as interrupted', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      assert.equal(await driver.steer('change focus'), 'refused', 'mid-turn text queues CLI-side, so the host must queue instead')
      await driver.sendTurn('WAIT')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
      assert.ok(readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').includes('{"control":"interrupt"}'))
    } finally { driver.dispose() }
  })
})

test('Claude stop that the CLI never answers resets the connection and the next turn reboots', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: { CLAUDE_FIXTURE_INTERRUPT_SILENT: '1', CLAUDE_FIXTURE_WAIT_MS: '30000' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await driver.interruptTurn()
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.unconfirmed, true)
      assert.equal(driver.hasSession(), false, 'a dropped connection must not claim a live session')
      assert.ok(events.some(event => event.type === 'session' && event.state === 'closed'))
      events.length = 0
      await driver.sendTurn('Hello')
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'done')
      assert.equal(deltas(events), 'Hello world')
    } finally { driver.dispose() }
    const spawns = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)
    assert.equal(spawns.length, 2, 'the next turn spawns a fresh CLI process')
    assert.equal(spawns[1].resume, 'fixture-claude-session')
  })
})

test('Claude counts undeclared frame types that arrive outside a running turn', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: { CLAUDE_FIXTURE_NOISE: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('Hello')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(driver.coverage.snapshot().counts['unknown-notification'], 1)
    } finally { driver.dispose() }
  })
})

test('Claude priority steering waits for the result answering the injected uuid', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: { CLAUDE_FIXTURE_STEERING: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await until(() => events.find(event => event.type === 'session' && event.state === 'ready'))
      assert.equal(await driver.steer('change focus'), 'steered')
      await until(() => readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').includes('"steer"'))
      assert.equal(events.some(event => event.type === 'turn/end'), false)
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.ok(deltas(events).includes('Steered change focus'))
      assert.equal(end.usage.outputTokens, 180)
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
    } finally { driver.dispose() }
  })
})

test('Claude steering preserves pending questions and old CLIs refuse without sending', async () => {
  for (const supported of [false, true]) await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: supported ? { CLAUDE_FIXTURE_STEERING: '1' } : {}, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_QUESTIONS')
      await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(await driver.steer('keep the question'), supported ? 'steered' : 'refused')
      if (supported) {
        await until(() => readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').includes('"priority":"later"'))
        assert.equal(events.some(event => event.type === 'request/closed'), false)
      } else assert.equal(readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').includes('keep the question'), false)
    } finally { driver.dispose() }
  })
})

test('Claude stop cancels queued priority input as well as the active generation', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: { CLAUDE_FIXTURE_STEERING: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await until(() => events.find(event => event.type === 'session' && event.state === 'ready'))
      assert.equal(await driver.steer('change focus'), 'steered')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
      const requests = readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.ok(requests.some(request => request.control === 'interrupt' && request.cancel_queued === true))
    } finally { driver.dispose() }
  })
})

test('a cut-off steered Claude turn keeps the usage its finished segment reported', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, env: { CLAUDE_FIXTURE_STEERING: '1', CLAUDE_FIXTURE_STEER_HOLD: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await until(() => events.find(event => event.type === 'session' && event.state === 'ready'))
      assert.equal(await driver.steer('change focus'), 'steered')
      await until(() => readFileSync(join(cwd, 'claude-requests.jsonl'), 'utf8').includes('"steer"'))
      await new Promise(resolve => setTimeout(resolve, 100))
      driver.dispose()
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.usage.outputTokens, 90, 'the absorbed segment stays counted')
    } finally { driver.dispose() }
  })
})

test('Claude result frames settle done only on clean success and keep a failed turn\'s text', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const [frame, reason, error, text] of [
        [{ subtype: 'success', is_error: false, result: 'clean' }, 'done', undefined, 'clean'],
        [{ subtype: 'error_max_turns', is_error: true, result: 'partial answer', errors: ['Reached the maximum number of turns'] }, 'error', /Reached the maximum number of turns/, 'partial answer'],
        [{ subtype: 'error_max_budget_usd', is_error: true, error: { message: 'Budget exceeded' } }, 'error', /Budget exceeded/, ''],
        [{ subtype: 'future_result', is_error: true }, 'error', /future_result/, ''],
        [{ subtype: 'success', is_error: true, result: 'looks done' }, 'error', /\(success\)/, 'looks done'],
      ]) {
        events.length = 0
        await driver.sendTurn(`RESULT ${JSON.stringify(frame)}`)
        const end = await until(() => events.find(event => event.type === 'turn/end'))
        assert.equal(end.reason, reason, frame.subtype)
        if (error) assert.match(String(end.error), error)
        else assert.equal(end.error, undefined)
        assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), text, frame.subtype)
      }
    } finally { driver.dispose() }
  })
})

test('Claude identity rides the init frame and reports outside verified scope as unverified', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('Hello')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(driver.coverage.snapshot().identity.cliVersion, '9.9.9-fixture')
      const lines = driver.coverage.drain()
      assert.equal(lines.length, 1)
      assert.match(lines[0], /nodo coverage: claude stream-json cli 9\.9\.9-fixture — unverified/)
    } finally { driver.dispose() }
  })
})

test('Claude environment check uses the stream handshake; the catalog reads the initialize model table and falls back to settings', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'claude', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'claude-cli fixture')
    assert.equal((await checkEngine({ engine: 'claude', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
    const home = mkdtempSync(join(tmpdir(), 'orch-claude-home-'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    process.env.CLAUDE_CONFIG_DIR = home
    try {
      const catalog = await scanEngine('claude', { engineOptions: { bin } })
      assert.equal(catalog.source, 'Claude Code initialize response')
      assert.equal(catalog.defaultModel, 'sonnet')
      assert.deepEqual(catalog.models.map(model => model.id), ['opus', 'sonnet', 'claude-haiku-4-5'])
      assert.equal(catalog.models[0].label, 'Opus 9.9')
      assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['low', 'high'])
      assert.equal(catalog.models[2].thinking, undefined)
      process.env.CLAUDE_FIXTURE_NO_MODELS = '1'
      const fallback = await scanEngine('claude', { engineOptions: { bin } })
      assert.equal(fallback.source, 'Claude settings.json')
      assert.equal(fallback.defaultModel, 'sonnet')
      assert.deepEqual(fallback.models.map(model => model.id), ['fable', 'opus', 'sonnet', 'haiku'])
      assert.equal(fallback.models[0].thinking, undefined, 'the settings fallback does not invent effort levels')
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
      delete process.env.CLAUDE_FIXTURE_NO_MODELS
      rmSync(home, { recursive: true, force: true })
    }
    assert.throws(() => validateEngineOptions('claude', { bin: 'claude --flag' }), /absolute path or a command/)
    assert.throws(() => validateEngineOptions('claude', { args: ['--yolo'] }), /Unsupported/)
  })
})

test('Claude cards settle through the host approval pipeline', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Fixture', cwd })
    const profile = await api('profile-create', { name: 'Fixture', engine: 'claude', workspace: workspace.id, engineOptions: { bin } })
    await api('send', { profile: profile.id, text: 'ASK_QUESTIONS' })
    const question = await until(async () => (await api('state')).approvals[0])
    assert.equal(question.kind, 'question')
    await api('approval-answer', { id: question.id, decision: 'answer', value: 'Blue' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.ok((await api('transcript', { profile: profile.id })).some(line => line.text === 'Answered Blue'))
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[profile.id].driverSessionId, 'fixture-claude-session')
  }))
})

test('claude only marks structured transient failures retryable', () => withFixture(async ({ bin, cwd }) => {
  const events = []
  const driver = createDriver('claude', { bin, cwd, onEvent: event => events.push(event) })
  try {
    for (const [failure, retryable] of [ [{ kind: 'rate_limit', apiError: 'usage_limit_reached', status: 429 }, false],
  [{ kind: 'rate_limit' }, false], ...['overloaded', 'server_error'].map(kind => [{ kind }, true]),
  ...['authentication_failed', 'billing_error', 'invalid_request', 'model_not_found', 'unknown'].map(kind => [{ kind, status: 503 }, false]),
  ...[408, 500, 529, 401, 402, 404, 429].map(status => [{ status }, status === 408 || status >= 500]),
  [{}, false] ]) {
      events.length = 0
      await driver.sendTurn('FAILURE ' + JSON.stringify(failure))
      const ended = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(ended.retryable, retryable ? true : undefined, JSON.stringify(failure))
    }
    events.length = 0
    await driver.sendTurn('WAIT')
    await driver.interruptTurn()
    const ended = await until(() => events.find(event => event.type === 'turn/end'))
    assert.equal(ended.reason, 'interrupted')
    assert.equal(ended.retryable, undefined)
  } finally { driver.dispose() }
}))
