import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, checkEngine, scanEngine, validateEngineOptions } from '../agent-drivers/dist/index.js'
import { boot, until, withHost } from './helpers/host.js'
import { opencodeInstructions } from '../agent-drivers/dist/opencode/instructions.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-opencode-fixture-'))
  const bin = join(dir, 'opencode')
  copyFileSync(new URL('./fixtures/opencode-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const deltas = events => events.filter(event => event.type === 'delta').map(event => event.text).join('')

test('OpenCode installs literal role instructions in both native modes, including resume', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const instructions = 'Role A {{literal}} {env:OTHER} {file:/unreadable} "quoted"\n继续执行'
    const config = { model: 'fixture/one', permission: { edit: 'ask' }, agent: { build: { prompt: 'Existing rule', temperature: 0.2 }, custom: { prompt: 'Keep custom' } } }
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
    for (const driverSessionId of [undefined, 'fixture-oc-session']) {
      const events = []
      const driver = createDriver('opencode', { bin, cwd, env, instructions, driverSessionId, permission: 'plan', onEvent: event => events.push(event) })
      try {
        assert.equal(driver.instructionMode, 'none', 'native mode is exposed only after startup')
        await driver.openSession()
        assert.equal(driver.instructionMode, 'native')
        for (const task of ['FIRST', 'SECOND']) {
          events.length = 0
          await driver.sendTurn(task)
          await until(() => events.some(event => event.type === 'turn/end'))
        }
      } finally { driver.dispose() }
    }
    assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(config))
    const requests = readFileSync(join(cwd, 'opencode-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const native = requests.filter(entry => entry.method === 'native/instructions')
    assert.equal(native.length, 4)
    for (const entry of native) {
      assert.equal(entry.prompt, entry.mode === 'build' ? `Existing rule\n\n${instructions}` : instructions)
      assert.deepEqual(entry.config.permission, config.permission)
      assert.deepEqual(entry.config.agent.custom, config.agent.custom)
      assert.equal(entry.config.agent.build.temperature, 0.2)
    }
    assert.deepEqual(requests.filter(entry => entry.method === 'session/prompt').map(entry => entry.text), ['FIRST', 'SECOND', 'FIRST', 'SECOND'])
  })
})

test('OpenCode rejects malformed native configuration without dropping identity', () => {
  for (const content of ['{', 'null', '[]', '{"agent":[]}', '{"agent":{"build":{"prompt":[]}}}']) {
    assert.throws(() => opencodeInstructions('Role', { OPENCODE_CONFIG_CONTENT: content }), /configuration/)
  }
  assert.equal(opencodeInstructions('', {}).mode, 'none')
})

test('OpenCode identity file is private and removed when its driver is released', () => {
  const instructions = 'Identity {{literal}} {env:UNSET} {file:/not-a-reference}'
  const identity = opencodeInstructions(instructions, {})
  const config = JSON.parse(identity.env.OPENCODE_CONFIG_CONTENT)
  const path = /^\{file:([^}]+)\}$/.exec(config.agent.build.prompt)[1]
  try {
    assert.equal(readFileSync(path, 'utf8'), instructions)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    assert.equal(identity.env.OPENCODE_CONFIG_CONTENT.includes(instructions), false)
    assert.equal(config.agent.plan.prompt, config.agent.build.prompt)
  } finally { identity.dispose() }
  assert.equal(existsSync(dirname(path)), false)
})

test('host sends OpenCode tasks without identity from the first turn and after restart', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Native role', cwd })
    const profile = await host.api('profile-create', { name: 'OpenCode native role', instructions: 'UNIQUE_BOUND_ROLE', engine: 'opencode', workspace: workspace.id, engineOptions: { bin } })
    await host.api('send', { profile: profile.id, text: 'FIRST_TASK' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    host.dispose()
    const reopened = boot(host.home)
    try {
      await reopened.api('send', { profile: profile.id, text: 'RESUMED_TASK' })
      await until(async () => !(await reopened.api('state')).work[profile.id].active)
      const entries = readFileSync(join(cwd, 'opencode-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const tasks = entries.filter(entry => entry.method === 'session/prompt')
      assert.equal(tasks.length, 2)
      assert.equal(tasks[0].text, 'FIRST_TASK')
      assert.ok(tasks[1].text.endsWith('RESUMED_TASK'))
      assert.ok(tasks.every(entry => !entry.text.includes('UNIQUE_BOUND_ROLE')))
      assert.ok(entries.some(entry => entry.method === 'session/load'))
      const native = entries.filter(entry => entry.method === 'native/instructions')
      assert.equal(native.length, 4)
      assert.ok(native.every(entry => entry.prompt.includes('UNIQUE_BOUND_ROLE')))
      assert.equal((await reopened.api('state')).profiles.find(entry => entry.id === profile.id).sessions[0].instructionMode, 'native')
    } finally { reopened.dispose() }
  }))
})

test('OpenCode adapter streams chunks, applies model and effort through config options and resumes', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('opencode', { bin, cwd, model: 'fixture/one', thinking: 'high', onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Hello world')
      assert.ok(events.some(event => event.type === 'thinking' && event.text === 'thinking'), 'reasoning chunks become thinking events')
      assert.ok(events.some(event => event.type === 'tool' && event.phase === 'start'))
      assert.ok(events.some(event => event.type === 'tool' && event.phase === 'end' && event.isError === false))
      const end = events.find(event => event.type === 'turn/end')
      assert.equal(end.reason, 'done')
      assert.deepEqual(end.usage, { inputTokens: 1, outputTokens: 2, contextUsed: 10, contextSize: 100 })
      assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-oc-session')
      driver.dispose()
      events.length = 0
      driver = createDriver('opencode', { bin, cwd, driverSessionId: 'fixture-oc-session', model: 'fixture/two', thinking: 'high', onEvent: event => events.push(event) })
      await driver.sendTurn('SECOND')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { driver.dispose() }
    const lines = readFileSync(join(cwd, 'opencode-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.find(entry => entry.method === 'session/load')?.sessionId, 'fixture-oc-session')
    assert.equal(lines.find(entry => entry.method === 'session/set_config_option' && entry.configId === 'model')?.value, 'fixture/two')
    assert.ok(lines.some(entry => entry.method === 'session/set_config_option' && entry.configId === 'effort' && entry.value === 'high'), 'the first boot pins the effort too')
  })
})

test('OpenCode approvals and question answers round-trip through the ACP requests', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('opencode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_PERMISSION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(card.kind, 'permission')
      assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), true)
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Approved')
      events.length = 0
      await driver.sendTurn('ASK_PERMISSION')
      const reject = await until(() => events.find(event => event.type === 'request/opened'))
      await driver.respondToRequest(reject.id, { decision: 'deny' })
      const ended = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(ended.reason, 'interrupted', 'a cancelled permission settles the turn as interrupted')
      events.length = 0
      await driver.sendTurn('ASK_QUESTIONS')
      const question = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(question.kind, 'question')
      assert.equal(question.detail.questions[0].id, 'q0')
      assert.deepEqual(question.detail.questions[0].options.map(option => option.label), ['Red', 'Blue'])
      await assert.rejects(driver.respondToRequest(question.id, { decision: 'answer', value: '   ' }), /Answer every question first/)
      await driver.respondToRequest(question.id, { decision: 'answer', value: 'Blue' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered Blue')
    } finally { driver.dispose() }
  })
})

test('OpenCode interrupt cancels the running prompt', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('opencode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      assert.equal(await driver.steer('change focus'), 'refused')
      await driver.sendTurn('WAIT')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
    } finally { driver.dispose() }
  })
})

test('OpenCode keeps the native session when a config option is rejected', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('opencode', { bin, cwd, model: 'fixture/bogus', onEvent: event => events.push(event) })
    await assert.rejects(driver.sendTurn('FIRST'), /ACPInvalidModelError/)
    assert.equal(events.find(event => event.type === 'session' && event.state === 'ready').sessionId, 'fixture-oc-session')
    driver.dispose()
    events.length = 0
    const retry = createDriver('opencode', { bin, cwd, driverSessionId: 'fixture-oc-session', onEvent: event => events.push(event) })
    try {
      await retry.sendTurn('SECOND')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { retry.dispose() }
    const lines = readFileSync(join(cwd, 'opencode-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(lines.filter(entry => entry.method === 'session/new').length, 1, 'the rejected boot leaves no second native session')
    assert.equal(lines.filter(entry => entry.method === 'session/load').length, 1)
  })
})

test('OpenCode environment check uses the ACP handshake and the scan reads session config', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'opencode', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'opencode fixture v2')
    assert.equal((await checkEngine({ engine: 'opencode', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
    const catalog = await scanEngine('opencode', { engineOptions: { bin }, cwd })
    assert.equal(catalog.source, 'OpenCode session config')
    assert.equal(catalog.defaultModel, 'fixture/one')
    assert.deepEqual(catalog.models.map(model => model.id), ['fixture/one', 'fixture/two', 'other/three'])
    assert.deepEqual(catalog.models.map(model => model.label), ['Model One', 'Model Two', 'Model Three'],
      'a row is the model name alone: the route prefix is the provider, not part of the name')
    assert.deepEqual(catalog.models.map(model => model.group), ['fixture', 'fixture', 'other'],
      'the provider in the route is the section the model sits under')
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['high'], "the engine's own 'default' choice stays out of the list")
    assert.equal(catalog.models[0].defaultThinking, undefined)
    assert.deepEqual(catalog.models[1].thinking.map(level => level.id), ['low', 'high', 'max'])
    assert.equal(catalog.models[1].defaultThinking, 'low', 'levels are read per selected model')
    assert.deepEqual((await scanEngine('opencode', { engineOptions: { bin: join(cwd, 'missing') }, cwd })).models, [], 'an unreachable CLI reports an empty list')
    assert.throws(() => validateEngineOptions('opencode', { bin: 'opencode --flag' }), /absolute path or a command/)
    assert.throws(() => validateEngineOptions('opencode', { args: ['--yolo'] }), /Unsupported/)
  })
})

test('OpenCode slash lines expand from command files before reaching the channel', async () => {
  await withFixture(async ({ bin, cwd }) => {
    mkdirSync(join(cwd, '.opencode', 'command'), { recursive: true })
    writeFileSync(join(cwd, '.opencode', 'command', 'probe.md'), '---\ndescription: probe\n---\nReply TOKEN.\n')
    mkdirSync(join(cwd, '.agents', 'skills', 'probe-skill'), { recursive: true })
    writeFileSync(join(cwd, '.agents', 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: Probe skill\n---\nReply SKILL.\n')
    const events = []
    const driver = createDriver('opencode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('/probe extra words')
      await until(() => events.find(event => event.type === 'turn/end'))
      await driver.sendTurn('/probe-skill')
      await until(() => events.filter(event => event.type === 'turn/end').length >= 2)
      await assert.rejects(driver.sendTurn('/nope'), /no command or skill "\/nope"/)
      events.length = 0
      await driver.sendTurn('/^\\d+/ matches digits')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { driver.dispose() }
    const lines = readFileSync(join(cwd, 'opencode-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const prompt = lines.filter(entry => entry.method === 'session/prompt').map(entry => entry.text)
    assert.deepEqual(prompt, ['Reply TOKEN.\n\nextra words', 'Reply SKILL.', '/^\\d+/ matches digits'])
  })
})
