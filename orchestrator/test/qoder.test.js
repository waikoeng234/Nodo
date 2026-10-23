import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, checkEngine, engineCatalog, scanEngine, scanEngineCommands, validateEngineOptions } from '../agent-drivers/dist/index.js'
import { findQoderExecutable } from '../agent-drivers/dist/qoder/index.js'
import { until, withHost } from './helpers/host.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-qoder-fixture-'))
  const bin = join(dir, 'qoder')
  copyFileSync(new URL('./fixtures/qoder-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const texts = events => events.filter(event => event.type === 'text').map(event => event.text)

test('Qoder adapter streams whole messages natively and resumes the same CLI session', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('qoder', { bin, cwd, model: 'qfmodel', thinking: 'high', instructions: 'Role rules', onEvent: event => events.push(event) })
    try {
      assert.equal(driver.instructionMode, 'none', 'instructions are native only after the session is up')
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'delta').length, 0, 'the engine has no partial-message channel')
      assert.deepEqual(texts(events), ['Hello world'])
      assert.deepEqual(events.find(event => event.type === 'turn/end').usage,
        { inputTokens: 300, outputTokens: 90, cacheReadTokens: 900, cacheWriteTokens: 100, contextUsed: 1300, contextSize: 200000 },
        'the turn\'s buckets come from the result frame, the context from the last request and the routed window')
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-qoder-session')
      assert.equal(driver.instructionMode, 'native')

      events.length = 0
      await driver.compact()
      await until(() => events.find(event => event.type === 'turn/end'))
      const users = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.user !== undefined)
      assert.equal(users.at(-1).user, '/compact', 'compaction rides the native slash channel')
      driver.dispose()
      events.length = 0
      driver = createDriver('qoder', { bin, cwd, driverSessionId: 'fixture-qoder-session', thinking: 'high', instructions: 'Role rules', onEvent: event => events.push(event) })
      await driver.sendTurn('EFFORT')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Effort high'])
    } finally { driver.dispose() }
    const spawns = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)
    assert.equal(spawns[0].model, 'qfmodel')
    assert.equal(spawns[0].reasoningEffort, 'high')
    assert.equal(spawns[0].instructions, 'Role rules')
    assert.equal(spawns[0].resume, undefined)
    assert.equal(spawns[1].resume, 'fixture-qoder-session')
  })
})

test('Qoder derives confirmed file changes from Write and Edit tool flows alone', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FILES')
      await until(() => events.some(event => event.type === 'turn/end'))
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => [event.callId, event.phase]), [['write-0', 'start'], ['write-0', 'end'], ['write-1', 'start'], ['write-1', 'end'],
        ['edit-2', 'start'], ['edit-2', 'end'], ['denied', 'start'], ['denied', 'end'], ['alien', 'start'], ['alien', 'end']])
      assert.equal(tools[7].isError, true)
      const changes = events.find(event => event.type === 'changes').presentation
      assert.equal(changes.kind, 'changes')
      assert.deepEqual(changes.body.files.map(file => [file.path.endsWith('created.txt') ? 'created.txt' : file.path.split('/').at(-1), file.edits.map(edit => edit.operation)]),
        [['created.txt', ['add']], ['updated.txt', ['update']], ['edited.txt', ['update']]], 'the denied write never joins the snapshot')
      assert.deepEqual(changes.body.files[0].edits[0], { operation: 'add', oldText: null, newText: 'new body' })
      assert.deepEqual(changes.body.files[2].edits[0], { operation: 'update', oldText: 'before', newText: 'after' })
    } finally { driver.dispose() }
  })
})

test('Qoder compaction boundaries close one status and subagent tasks stay attributed activity', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('LIFECYCLE')
      await until(() => events.some(event => event.type === 'turn/end'))
      const lifecycle = events.filter(event => event.type === 'lifecycle')
      assert.deepEqual(lifecycle.map(event => [event.kind, event.phase]),
        [['compaction', 'start'], ['compaction', 'end']], 'the boundary closes the status exactly once')
      const activity = events.filter(event => event.type === 'activity')
      assert.deepEqual(activity.map(event => [event.entityId, event.phase, event.isError === true]),
        [['task-1', 'start', false], ['task-1', 'update', false], ['task-1', 'end', false]])
      assert.equal(activity[0].title, 'Research subtask')
      assert.equal(activity[0].toolCallId, 'spawn-tool')
      assert.equal(activity[1].detail, '最近工具：Bash')
      assert.equal(activity[2].detail, 'child one done')
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
    } finally { driver.dispose() }
  })
})

test('Qoder installs instructions before its delayed init frame and keeps first-turn messages clean', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, instructions: 'Stay a reviewer', env: { QODER_FIXTURE_DELAY_INIT: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.openSession()
      assert.equal(events.some(event => event.type === 'session' && event.state === 'ready'), false)
      assert.equal(driver.instructionMode, 'native')
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      const requests = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requests.find(item => item.spawn).instructions, 'Stay a reviewer')
      assert.deepEqual(requests.filter(item => item.user !== undefined).map(item => item.user), ['FIRST'])
    } finally { driver.dispose() }
  })
})

test('Qoder approvals and question answers round-trip through the control channel', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_PERMISSION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(card.kind, 'permission')
      assert.equal(await driver.respondToRequest(card.id, { decision: 'deny' }), true)
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.ok(events.some(event => event.type === 'tool' && event.phase === 'end' && event.isError === true))
      assert.deepEqual(texts(events), ['Denied'])
      events.length = 0
      await driver.sendTurn('ASK_QUESTIONS')
      const question = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(question.kind, 'question')
      assert.deepEqual(question.detail.questions[0].options.map(option => option.label), ['Red', 'Blue'])
      await assert.rejects(driver.respondToRequest(question.id, { decision: 'answer', value: '  ' }), /Answer every question first/)
      assert.equal(events.filter(event => event.type === 'request/closed').length, 0, 'a failed answer must keep the card open')
      await driver.respondToRequest(question.id, { decision: 'answer', value: 'Blue' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Answered Blue'])
    } finally { driver.dispose() }
  })
})

test('Qoder permission tiers reach the spawned CLI args, plan falls back to the asking default', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const permission of ['workspace', 'plan', 'full']) {
      const events = []
      const driver = createDriver('qoder', { bin, cwd, permission, onEvent: event => events.push(event) })
      try {
        await driver.sendTurn('Hello')
        await until(() => events.find(event => event.type === 'turn/end'))
      } finally { driver.dispose() }
    }
    const modes = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.spawn).map(entry => entry.permissionMode)
    assert.deepEqual(modes, ['auto', 'default', 'bypass_permissions'])
  })
})

test('Qoder refuses steering and its interrupt receipt ends the turn as interrupted', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      assert.equal(await driver.steer('change focus'), 'refused', 'mid-turn user frames queue as the next turn, so the host must queue instead')
      await driver.sendTurn('WAIT')
      await until(() => events.find(event => event.type === 'session' && event.state === 'ready'))
      assert.equal(await driver.steer('change focus'), 'refused')
      assert.ok(!readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').includes('change focus'), 'a refused steer never reaches the engine')
      await driver.interruptTurn()
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.unconfirmed, undefined, 'the engine confirmed this stop with its own result frame')
      assert.ok(readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').includes('{"control":"interrupt"}'))
    } finally { driver.dispose() }
  })
})

test('Qoder result frames settle done only on clean success and keep a failed turn\'s text', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const [frame, reason, error, text] of [
        [{ subtype: 'success', is_error: false, result: 'clean' }, 'done', undefined, 'clean'],
        [{ subtype: 'error_during_execution', is_error: true, result: 'partial answer', errors: ['Reached the maximum number of turns'] }, 'error', /Reached the maximum number of turns/, 'partial answer'],
        [{ subtype: 'future_result', is_error: true }, 'error', /future_result/, ''],
        [{ subtype: 'success', is_error: true, result: 'looks done' }, 'error', /\(success\)/, 'looks done'],
      ]) {
        events.length = 0
        await driver.sendTurn(`RESULT ${JSON.stringify(frame)}`)
        const end = await until(() => events.find(event => event.type === 'turn/end'))
        assert.equal(end.reason, reason, frame.subtype)
        if (error) assert.match(String(end.error), error)
        else assert.equal(end.error, undefined)
        assert.equal(texts(events).join(''), text, frame.subtype)
      }
    } finally { driver.dispose() }
  })
})

test('Qoder keeps a free route\'s occupancy separate from its reported token buckets', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn(`RESULT ${JSON.stringify({
        subtype: 'success', is_error: false, result: 'free',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
          credits: 0.049, original_credits: 0.049, billable: false, context_usage_ratio: 0.063635 },
        modelUsage: { qfmodel: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, contextWindow: 400000 } },
      })}`)
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(end.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextUsed: 25454, contextSize: 400000 },
        'the ratio estimates context occupancy and must never inflate cumulative token usage')
      events.length = 0
      await driver.sendTurn(`RESULT ${JSON.stringify({ subtype: 'success', usage: { context_usage_ratio: 0.063635 }, modelUsage: { qfmodel: { contextWindow: 400000 } } })}`)
      const unknown = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(unknown.usage, { contextUsed: 25454, contextSize: 400000 }, 'missing token counters stay unknown')
    } finally { driver.dispose() }
  })
})

test('Qoder reconnects with the last confirmed native session after process exit', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EXIT')
      await until(() => events.some(event => event.type === 'session' && event.state === 'closed'))
      assert.equal(driver.hasSession(), false)
      events.length = 0
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Hello world'])
      const spawns = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)
      assert.equal(spawns.length, 2)
      assert.equal(spawns[1].resume, 'fixture-qoder-session')
    } finally { driver.dispose() }
  })
})

test('Qoder ignores an old interrupt failure after the next turn starts', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('CANCEL_LATE')
      const stopping = driver.interruptTurn()
      await until(() => events.some(event => event.type === 'turn/end'))
      events.length = 0
      const next = await driver.sendTurn('WAIT')
      await stopping
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.turnId, next)
      assert.equal(end.reason, 'done')
      assert.equal(end.unconfirmed, undefined)
      assert.deepEqual(texts(events), ['Waited'])
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    } finally { driver.dispose() }
  })
})

test('Qoder recovers after a rejected or unconfirmed stop and sends duplicate interrupts only once', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const text of ['CANCEL_ERROR', 'CANCEL_SILENT']) {
        events.length = 0
        await driver.sendTurn(text)
        await until(() => existsSync(join(cwd, 'qoder-requests.jsonl')) && readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).some(entry => entry.user === text))
        await Promise.all([driver.interruptTurn(), driver.interruptTurn()])
        const ends = events.filter(event => event.type === 'turn/end')
        assert.equal(ends.length, 1)
        assert.equal(ends[0].reason, 'interrupted')
        assert.equal(ends[0].unconfirmed, true)
        assert.equal(driver.hasSession(), false)
        events.length = 0
        await driver.sendTurn('FIRST')
        await until(() => events.some(event => event.type === 'turn/end'))
        assert.deepEqual(texts(events), ['Hello world'])
      }
      const requests = readFileSync(join(cwd, 'qoder-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requests.filter(entry => entry.control === 'interrupt').length, 2)
      assert.ok(requests.filter(entry => entry.spawn).slice(1).every(entry => entry.resume === 'fixture-qoder-session'))
    } finally { driver.dispose() }
  })
})

test('Qoder excludes previous, unknown and foreign-session task events from the current turn', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('TASK_BACKGROUND')
      await until(() => events.some(event => event.type === 'turn/end'))
      events.length = 0
      const turnId = await driver.sendTurn('TASK_NEXT')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.deepEqual(events.filter(event => event.type === 'activity').map(event => [event.turnId, event.entityId, event.phase]),
        [[turnId, 'current-task', 'start'], [turnId, 'current-task', 'update'], [turnId, 'current-task', 'end']])
    } finally { driver.dispose() }
  })
})

test('Qoder rejects failed and malformed initialize responses in checks and scans', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const name of ['QODER_FIXTURE_INIT_ERROR', 'QODER_FIXTURE_INIT_MALFORMED']) {
      const previous = process.env[name]
      process.env[name] = '1'
      try {
        const result = await checkEngine({ engine: 'qoder', cwd, engineOptions: { bin } })
        assert.equal(result.ok, false)
        assert.equal(result.checks.find(check => check.label === 'Protocol').ok, false)
        const scan = await scanEngine('qoder', { cwd, engineOptions: { bin } })
        assert.equal(scan.source, 'Qoder scan failed')
        assert.deepEqual(scan.models, [])
        const commands = await scanEngineCommands('qoder', { cwd, engineOptions: { bin } })
        assert.deepEqual(commands.commands, [])
      } finally {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }
  })
})

test('Qoder identity rides the init frame and reports outside verified scope as unverified', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('qoder', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('Hello')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(driver.coverage.snapshot().identity, { transport: 'stream-json', protocolVersion: '1.5.0', cliVersion: '1.1.76-fixture' })
      const lines = driver.coverage.drain()
      assert.equal(lines.length, 1)
      assert.match(lines[0], /nodo coverage: qoder stream-json protocol 1\.5\.0 cli 1\.1\.76-fixture — unverified/)
    } finally { driver.dispose() }
  })
})

test('Qoder environment check uses the stream handshake; catalog and commands read the initialize tables', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'qoder', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'qoder-cli fixture')
    assert.equal((await checkEngine({ engine: 'qoder', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
    const catalog = await scanEngine('qoder', { engineOptions: { bin } })
    assert.equal(catalog.source, 'Qoder initialize response')
    assert.equal(catalog.defaultModel, 'qfmodel')
    assert.deepEqual(catalog.models.map(model => model.id), ['qfmodel', 'dfmodel', 'gmodel'])
    assert.equal(catalog.models[0].label, 'Qwen3.8-Flash')
    assert.equal(catalog.models[0].defaultThinking, 'medium')
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['xhigh', 'low', 'medium'])
    assert.equal(catalog.models[2].thinking, undefined)
    const commands = await scanEngineCommands('qoder', { engineOptions: { bin } })
    assert.equal(commands.source, 'Qoder initialize response')
    assert.deepEqual(commands.commands.map(command => command.id), ['compact', 'review'])
    process.env.QODER_FIXTURE_NO_MODELS = '1'
    try {
      const empty = await scanEngine('qoder', { engineOptions: { bin } })
      assert.deepEqual(empty.models, [])
      const bare = await scanEngineCommands('qoder', { engineOptions: { bin } })
      assert.deepEqual(bare.commands, [])
    } finally { delete process.env.QODER_FIXTURE_NO_MODELS }
    assert.throws(() => validateEngineOptions('qoder', { bin: 'qodercli --flag' }), /absolute path or a command/)
    assert.throws(() => validateEngineOptions('qoder', { args: ['--yolo'] }), /Unsupported/)
  })
})

test('Qoder discovery falls back to the desktop version directory for the bare command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-qoder-home-'))
  const dir = join(home, '.qoder/bin/qodercli')
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'qodercli-1.1.76')
  copyFileSync(new URL('./fixtures/qoder-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  const original = { path: process.env.PATH, home: process.env.HOME }
  try {
    process.env.PATH = ''
    process.env.HOME = home
    assert.equal(findQoderExecutable(), bin, 'an unconfigured profile finds the desktop install')
    assert.equal(findQoderExecutable('qodercli'), bin, 'the catalog lookup with the bare command finds it too')
    assert.equal(engineCatalog().find(item => item.id === 'qoder').executable, bin, 'the engine catalog detects the desktop install')
    assert.equal(findQoderExecutable(join(dir, 'qodercli-1.1.75')), undefined, 'an explicit path is used strictly')
  } finally {
    process.env.PATH = original.path
    process.env.HOME = original.home
    rmSync(home, { recursive: true, force: true })
  }
})

test('Qoder cards settle through the host approval pipeline', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Fixture', cwd })
    const profile = await api('profile-create', { name: 'Fixture', engine: 'qoder', workspace: workspace.id, engineOptions: { bin } })
    await api('send', { profile: profile.id, text: 'ASK_QUESTIONS' })
    const question = await until(async () => (await api('state')).approvals[0])
    assert.equal(question.kind, 'question')
    await api('approval-answer', { id: question.id, decision: 'answer', value: 'Blue' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.ok((await api('transcript', { profile: profile.id })).some(line => line.text === 'Answered Blue'))
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[profile.id].driverSessionId, 'fixture-qoder-session')
  }))
})
