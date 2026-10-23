import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, checkEngine, scanEngine, scanEngineCommands, validateEngineOptions } from '../agent-drivers/src/index.js'
import { until, withHost } from './helpers/host.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-pi-fixture-'))
  const bin = join(dir, 'pi')
  copyFileSync(new URL('./fixtures/pi-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const texts = events => events.filter(event => event.type === 'text').map(event => event.text)
const spawns = cwd => readFileSync(join(cwd, 'pi-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.spawn)

test('pi adapter streams real deltas and resumes the exact RPC session id', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('pi', { bin, cwd, model: 'fixture/fixture-model', thinking: 'high', instructions: 'Role rules', onEvent: event => events.push(event) })
    try {
      assert.equal(driver.instructionMode, 'none', 'instructions are native only after the session is up')
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-pi-session')
      assert.equal(driver.instructionMode, 'native')
      assert.ok(events.filter(event => event.type === 'delta').length > 0, 'the engine has a native partial-message channel')
      assert.deepEqual(texts(events), [], 'delta messages do not double as whole texts')
      assert.deepEqual(events.find(event => event.type === 'turn/end').usage,
        { inputTokens: 300, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 100, contextUsed: 1300, contextSize: 200000 },
        'per-request usage folds into the turn; the context window rides get_state')

      events.length = 0
      await driver.sendTurn('IMG', [{ mediaType: 'image/png', data: 'aGk=' }])
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Seen 1 image(s)'])
      driver.dispose()
      events.length = 0
      driver = createDriver('pi', { bin, cwd, driverSessionId: 'fixture-pi-session', instructions: 'Role rules', onEvent: event => events.push(event) })
      await driver.openSession()
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-pi-session')
    } finally { driver.dispose() }
    const [first, second] = spawns(cwd)
    assert.equal(first.mode, 'rpc')
    assert.equal(first.approve, 'no-approve', 'project-local .pi resources never load silently')
    assert.equal(first.model, 'fixture/fixture-model')
    assert.equal(first.thinking, 'high')
    assert.equal(first.instructions, 'Role rules')
    assert.equal(first.sessionId, undefined)
    assert.equal(second.sessionId, 'fixture-pi-session', 'the persisted session id reopens the same store entry')
  })
})

test('pi resumes the adopted session when the engine dies and reconnects in place', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('Hello')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-pi-session')
      const startedAt = Date.now()
      await assert.rejects(driver.sendTurn('DIE'), /pi exited/, 'an in-flight prompt settles on connection close, not on its 30s timeout')
      assert.ok(Date.now() - startedAt < 10_000)
      await until(() => events.find(event => event.type === 'session' && event.state === 'closed'))
      await driver.sendTurn('Again')
      await until(() => events.filter(event => event.type === 'turn/end').length >= 2)
      assert.deepEqual(events.filter(event => event.type === 'session' && event.state === 'ready').map(event => event.sessionId),
        ['fixture-pi-session', 'fixture-pi-session'], 'the in-place reconnect reopens the adopted session')
    } finally { driver.dispose() }
    const [, respawn] = spawns(cwd)
    assert.equal(respawn.sessionId, 'fixture-pi-session', 'the reconnect respawn carries --session-id')
  })
})

test('pi derives confirmed file changes from write and edit tool flows alone', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FILES')
      await until(() => events.some(event => event.type === 'turn/end'))
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => [event.callId, event.phase]), [['write-0', 'start'], ['write-0', 'update'], ['write-0', 'end'],
        ['write-1', 'start'], ['write-1', 'update'], ['write-1', 'end'], ['edit-2', 'start'], ['edit-2', 'update'], ['edit-2', 'end'],
        ['alien', 'start'], ['alien', 'update'], ['alien', 'end']], 'the streamed tool arguments ride along as input deltas')
      const changes = events.find(event => event.type === 'changes').presentation
      assert.equal(changes.kind, 'changes')
      assert.deepEqual(changes.body.files.map(file => [file.path.split('/').at(-1), file.edits.map(edit => edit.operation)]),
        [['created.txt', ['add']], ['updated.txt', ['update']], ['edited.txt', ['update']]], 'the existence check splits add from update; the alien path stays out')
      assert.deepEqual(changes.body.files.find(file => file.path.endsWith('created.txt')).edits[0], { operation: 'add', oldText: null, newText: 'new body' })
      assert.deepEqual(changes.body.files.find(file => file.path.endsWith('edited.txt')).edits[0], { operation: 'update', oldText: 'before', newText: 'after' })
    } finally { driver.dispose() }
  })
})

test('pi compaction rides the native channel and retry failure settles the turn as error', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.compact()
      const compacted = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(events.filter(event => event.type === 'lifecycle').map(event => [event.kind, event.phase]),
        [['compaction', 'start'], ['compaction', 'end']])
      assert.equal(compacted.reason, 'done')
      assert.equal(spawns(cwd).some(entry => entry.message === '/compact'), false, 'compaction uses the RPC command, not a prompt line')

      events.length = 0
      await driver.sendTurn('LIFECYCLE')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(events.filter(event => event.type === 'lifecycle').map(event => [event.kind, event.phase]),
        [['compaction', 'start'], ['compaction', 'end'], ['retry', 'start'], ['retry', 'end']])
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')

      events.length = 0
      await driver.sendTurn('FAILRETRY')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'error')
      assert.match(String(end.error), /529 overloaded/)
      assert.deepEqual(texts(events), ['partial answer'], 'a failed turn keeps the text it produced')
    } finally { driver.dispose() }
  })
})

test('pi steers the running turn and its abort settles as a confirmed stop', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      assert.equal(await driver.steer('change focus'), 'refused', 'no session, no steer')
      await driver.sendTurn('WAIT')
      await until(() => events.find(event => event.type === 'turn/start'))
      assert.equal(await driver.steer('change focus'), 'steered')
      await driver.interruptTurn()
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.unconfirmed, undefined, 'the engine confirmed this stop with its own settled frame')
      const log = readFileSync(join(cwd, 'pi-requests.jsonl'), 'utf8')
      assert.ok(log.includes('"steer":"change focus"'), 'the steer reached the engine')
      assert.ok(log.includes('"command":"abort"'))
      await driver.steer('late')
      assert.ok(!log.includes('"steer":"late"'), 'a refused steer never reaches the engine')
    } finally { driver.dispose() }
  })
})

test('pi extension dialogs surface as question cards and answer back through the sub-protocol', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('DIALOG')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(card.kind, 'question')
      assert.equal(card.reason, 'Pick one')
      assert.deepEqual(card.detail.options, ['Red', 'Blue'])
      await driver.respondToRequest(card.id, { decision: 'answer', value: 'Blue' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Answered Blue'])
      events.length = 0
      await driver.sendTurn('DIALOG')
      const second = await until(() => events.find(event => event.type === 'request/opened'))
      await driver.respondToRequest(second.id, { decision: 'deny' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(texts(events), ['Answered cancelled'], 'a denial cancels the dialog so the engine never stalls')
    } finally { driver.dispose() }
  })
})

test('pi identity rides its own version probe and reports outside verified scope as unverified', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('pi', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('Hello')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(driver.coverage.snapshot().identity, { transport: 'rpc', cliVersion: 'pi-cli fixture' })
      const lines = driver.coverage.drain()
      assert.equal(lines.length, 1)
      assert.match(lines[0], /nodo coverage: pi rpc cli pi-cli fixture — unverified/)
    } finally { driver.dispose() }
  })
})

test('pi environment check uses the RPC handshake; catalog and commands read the protocol tables', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'pi', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'pi-cli fixture')
    assert.ok(result.checks.some(check => check.label === 'Model' && check.ok === true), 'the configured default model is reported')
    assert.equal((await checkEngine({ engine: 'pi', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
    const catalog = await scanEngine('pi', { engineOptions: { bin }, cwd })
    assert.equal(catalog.source, 'pi get_available_models')
    assert.equal(catalog.defaultModel, 'fixture/fixture-model')
    assert.deepEqual(catalog.models.map(model => model.id), ['fixture/fixture-model', 'fixture/other-model', 'other/cross-model'])
    assert.equal(catalog.models[0].label, 'Fixture Model')
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['high', 'medium'])
    assert.equal(catalog.models[1].thinking, undefined)
    const commands = await scanEngineCommands('pi', { engineOptions: { bin }, cwd })
    assert.equal(commands.source, 'pi get_commands')
    assert.deepEqual(commands.commands.map(command => command.id), ['review', 'skill:demo'])
    assert.throws(() => validateEngineOptions('pi', { bin: 'pi --flag' }), /absolute path or a command/)
    assert.throws(() => validateEngineOptions('pi', { args: ['--yolo'] }), /Unsupported/)
    process.env.PI_FIXTURE_FAIL_STATE = '1'
    try {
      const refused = await checkEngine({ engine: 'pi', cwd, engineOptions: { bin } })
      assert.equal(refused.ok, false)
      assert.ok(refused.checks.some(check => check.label === 'Protocol' && check.ok === false), 'a failed get_state answer is a protocol failure, not a connected probe')
    } finally { delete process.env.PI_FIXTURE_FAIL_STATE }
  })
})

test('pi cards settle through the host approval pipeline', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Fixture', cwd })
    const profile = await api('profile-create', { name: 'Fixture', engine: 'pi', workspace: workspace.id, engineOptions: { bin } })
    await api('send', { profile: profile.id, text: 'DIALOG' })
    const question = await until(async () => (await api('state')).approvals[0])
    assert.equal(question.kind, 'question')
    await api('approval-answer', { id: question.id, decision: 'answer', value: 'Blue' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.ok((await api('transcript', { profile: profile.id })).some(line => line.text === 'Answered Blue'))
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[profile.id].driverSessionId, 'fixture-pi-session')
  }))
})
