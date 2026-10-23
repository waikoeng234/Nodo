import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, checkEngine, scanEngine, validateEngineOptions } from '../agent-drivers/src/index.js'
import { until } from './helpers/host.js'
import { createPump } from '../src/host/adapter/pump.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-codebuddy-fixture-'))
  const bin = join(dir, 'codebuddy')
  copyFileSync(new URL('./fixtures/codebuddy-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const wire = cwd => readFileSync(join(cwd, 'codebuddy-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const deltas = events => events.filter(event => event.type === 'delta').map(event => event.text).join('')

test('CodeBuddy declares the question capability, applies mode/model/thought and resumes via load', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('codebuddy', { bin, cwd, model: 'fixture/one', thinking: 'high', permission: 'plan', onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.deepEqual(deltas(events), 'Hello world')
      assert.deepEqual(end.usage, { contextUsed: 0, contextSize: 0 }, 'no token buckets exist to mirror')
      driver.dispose()
      events.length = 0
      driver = createDriver('codebuddy', { bin, cwd, driverSessionId: 'fixture-cb-session', onEvent: event => events.push(event) })
      await driver.sendTurn('SECOND')
      await until(() => events.find(event => event.type === 'turn/end'))
    } finally { driver.dispose() }
    const lines = wire(cwd)
    const initialize = lines.find(entry => entry.method === 'initialize')
    assert.equal(initialize.clientCapabilities._meta['codebuddy.ai'].question, true)
    assert.deepEqual(initialize.clientCapabilities.elicitation, { form: {} })
    assert.deepEqual(lines.filter(entry => entry.method === 'session/set_config_option' && entry.configId === 'mode').map(entry => entry.value), ['plan', 'auto'],
      'each boot pins its autonomy tier; a bare driver defaults to auto (the host supplies workspace)')
    assert.equal(lines.find(entry => entry.method === 'session/set_config_option' && entry.configId === 'model')?.value, 'fixture/one')
    assert.equal(lines.find(entry => entry.method === 'session/set_config_option' && entry.configId === 'thought_level')?.value, 'high',
      'the effort follows the model it belongs to')
    assert.equal(lines.find(entry => entry.method === 'session/load')?.sessionId, 'fixture-cb-session')
  })
})

test('CodeBuddy installs role instructions through --append-system-prompt and keeps tasks unwrapped', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const instructions = 'Role rules\n{{literal}}'
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, instructions, onEvent: event => events.push(event) })
    try {
      assert.equal(driver.instructionMode, 'none', 'native mode is exposed only after startup')
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(driver.instructionMode, 'native')
    } finally { driver.dispose() }
    const lines = wire(cwd)
    assert.deepEqual(lines.find(entry => entry.method === 'initialize').args, ['--acp', '--append-system-prompt', instructions])
    assert.equal(lines.find(entry => entry.method === 'session/prompt').text, 'FIRST')
  })
})

test('CodeBuddy turns the gated question call into a question card and returns the answers through resolveInterruption', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_QUESTION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(card.kind, 'question')
      assert.equal(card.detail.questions[0].id, 'q_0')
      assert.equal(card.detail.questions[0].question, '今晚吃什么？')
      assert.deepEqual(card.detail.questions[0].options.map(option => option.label), ['面条', '饺子'])
      await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: '   ' }), /Answer every question first/)
      assert.ok(!events.some(event => event.type === 'request/closed'), 'a failed answer keeps the card open')
      assert.equal(await driver.respondToRequest(card.id, { decision: 'answer', value: '饺子' }), true)
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered 饺子')
      events.length = 0
      await driver.sendTurn('ASK_PERMISSION')
      const approval = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(approval.kind, 'permission')
      assert.equal(approval.tool, 'bash', 'the gate names no tool, so the streamed call does')
      await driver.respondToRequest(approval.id, { decision: 'deny' })
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
    } finally { driver.dispose() }
    const lines = wire(cwd)
    const interruption = lines.find(entry => entry.method === '_codebuddy.ai/resolveInterruption')
    assert.equal(interruption.sessionId, 'fixture-cb-session')
    assert.equal(interruption.decision, 'allow')
    assert.deepEqual(interruption.answers, { q_0: '饺子' })
    const gate = lines.find(entry => entry.method === 'permission-reply')
    assert.deepEqual(gate.result.outcome, { outcome: 'selected', optionId: 'once' }, 'the ACP gate opens with the once-allow')
  })
})

test('CodeBuddy environment check handshakes and the scan reads per-model thought levels', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'codebuddy', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'CodeBuddy fixture v1')
    assert.equal((await checkEngine({ engine: 'codebuddy', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
    const catalog = await scanEngine('codebuddy', { engineOptions: { bin }, cwd })
    assert.equal(catalog.source, 'CodeBuddy session config')
    assert.equal(catalog.defaultModel, 'default-model')
    assert.deepEqual(catalog.models.map(model => model.id), ['default-model', 'fixture/one', 'fixture/two'])
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['enabled', 'high'])
    assert.equal(catalog.models[0].defaultThinking, 'enabled')
    assert.deepEqual(catalog.models[1].thinking.map(level => level.id), ['low', 'high', 'max'], 'levels are recomputed per selected model')
    assert.deepEqual(catalog.models[2].defaultThinking, 'disabled')
    assert.deepEqual((await scanEngine('codebuddy', { engineOptions: { bin: join(cwd, 'missing') }, cwd })).models, [], 'an unreachable CLI reports an empty list')
    assert.throws(() => validateEngineOptions('codebuddy', { bin: 'codebuddy --flag' }), /absolute path or a command/)
    assert.throws(() => validateEngineOptions('codebuddy', { args: ['--yolo'] }), /Unsupported/)
  })
})

test('CodeBuddy answers multiple questions through one interruption and keeps non-ask tools as permissions', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_QUESTIONS')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.deepEqual(card.detail.questions.map(question => question.id), ['q_0', 'q_1'])
      await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: JSON.stringify({ q_0: 'red' }) }), /Answer every question first/)
      await driver.respondToRequest(card.id, { decision: 'answer', value: JSON.stringify({ q_0: 'red', q_1: 'tea' }) })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered red,tea')
      events.length = 0
      await driver.sendTurn('ASK_OTHER')
      const approval = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(approval.kind, 'permission', 'a questions-shaped input on another tool stays a permission')
      assert.equal(approval.tool, 'write')
      await driver.respondToRequest(approval.id, { decision: 'allow' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Approved')
    } finally { driver.dispose() }
    assert.deepEqual(wire(cwd).find(entry => entry.method === '_codebuddy.ai/resolveInterruption').answers, { q_0: 'red', q_1: 'tea' })
  })
})

test('CodeBuddy closes an open question on interrupt with the cancelled gate reply and recovers', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_QUESTION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
      assert.deepEqual(events.filter(event => event.type === 'request/closed').map(event => event.id), [card.id])
      events.length = 0
      await driver.sendTurn('AGAIN')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Hello world')
    } finally { driver.dispose() }
    assert.deepEqual(wire(cwd).find(entry => entry.method === 'permission-reply').result.outcome, { outcome: 'cancelled' })
  })
})

test('CodeBuddy retries the answers when the interruption resolution fails once', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FAIL_QUESTION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: 'blue' }), /ask service busy/)
      assert.ok(!events.some(event => event.type === 'request/closed'), 'the failed answer keeps the card open')
      await driver.respondToRequest(card.id, { decision: 'answer', value: 'red' })
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered red')
    } finally { driver.dispose() }
    assert.equal(wire(cwd).filter(entry => entry.method === 'permission-reply').length, 1, 'the gate opens once across retries')
  })
})

test('CodeBuddy cancel after a failed answer leaves the answered gate at one result', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FAIL_QUESTION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: 'blue' }), /ask service busy/)
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
      assert.deepEqual(events.filter(event => event.type === 'request/closed').map(event => event.id), [card.id])
    } finally { driver.dispose() }
    const replies = wire(cwd).filter(entry => entry.method === 'permission-reply')
    assert.equal(replies.length, 1, 'the answered gate takes no cancel result on close')
    assert.deepEqual(replies[0].result.outcome, { outcome: 'selected', optionId: 'once' })
  })
})

test('CodeBuddy racing answers resolve the interruption once', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_QUESTION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      const [first, second] = await Promise.all([
        driver.respondToRequest(card.id, { decision: 'answer', value: '饺子' }),
        driver.respondToRequest(card.id, { decision: 'answer', value: '面条' }),
      ])
      assert.equal(first, true)
      assert.equal(second, false, 'a racing answer finds the card already answering')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(deltas(events), 'Answered 饺子')
    } finally { driver.dispose() }
    assert.equal(wire(cwd).filter(entry => entry.method === '_codebuddy.ai/resolveInterruption').length, 1)
    assert.equal(events.filter(event => event.type === 'request/closed').length, 1)
  })
})

test('CodeBuddy pins the full autonomy tier to bypassPermissions', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const driver = createDriver('codebuddy', { bin, cwd, permission: 'full' })
    try { await driver.openSession() } finally { driver.dispose() }
    assert.equal(wire(cwd).find(entry => entry.method === 'session/set_config_option' && entry.configId === 'mode').value, 'bypassPermissions')
  })
})

test('CodeBuddy member history, thoughts and tools never become the parent reply', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const task of ['MEMBER_CHUNKS', 'MEMBER_UNBOUNDED']) {
        events.length = 0
        await driver.sendTurn(task)
        const end = await until(() => events.find(event => event.type === 'turn/end'))
        assert.equal(end.reason, 'done')
        assert.equal(deltas(events), 'Parent final')
        assert.equal(end.text, 'Parent final')
        assert.ok(!events.some(event => ['tool', 'thinking'].includes(event.type)))
      }
    } finally { driver.dispose() }
  })
})

test('CodeBuddy retains unanswered cards on negative or missing interruption confirmation', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const task of ['UNRESOLVED_QUESTION', 'UNKNOWN_QUESTION']) {
        events.length = 0
        await driver.sendTurn(task)
        const card = await until(() => events.find(event => event.type === 'request/opened'))
        await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: 'blue' }), /did not confirm/)
        assert.ok(!events.some(event => ['request/closed', 'turn/end'].includes(event.type)))
        assert.equal(await driver.respondToRequest(card.id, { decision: 'answer', value: 'red' }), true)
        await until(() => events.find(event => event.type === 'turn/end'))
        assert.equal(deltas(events), 'Answered red')
        assert.equal(events.filter(event => event.type === 'request/closed').length, 1)
      }
    } finally { driver.dispose() }
    assert.equal(wire(cwd).filter(entry => entry.method === 'permission-reply').length, 2)
  })
})

test('CodeBuddy rejects new and restored Multitask sessions before configuring or prompting', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const configId of ['multitask', '_codebuddy.ai/multitask']) {
      for (const driverSessionId of [undefined, 'fixture-cb-session']) {
        const driver = createDriver('codebuddy', { bin, cwd, driverSessionId, env: { CB_MULTITASK: '1', CB_MULTITASK_ID: configId } })
        try { await assert.rejects(driver.sendTurn('FIRST'), /not support.*Multitask/) }
        finally { driver.dispose() }
      }
    }
    assert.ok(!wire(cwd).some(entry => ['session/prompt', 'session/set_config_option'].includes(entry.method)))
  })
})

test('CodeBuddy rejects the Multitask command without sending it or breaking ordinary turns', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (const command of ['/multitask', '  /multitask on\n']) await assert.rejects(driver.sendTurn(command), /not support.*Multitask/)
      await driver.sendTurn('AGAIN')
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'done')
    } finally { driver.dispose() }
    assert.deepEqual(wire(cwd).filter(entry => entry.method === 'session/prompt').map(entry => entry.text), ['AGAIN'])
  })
})

test('CodeBuddy reports live background work as an unconfirmed failure', async () => {
  for (const task of ['ENABLE_MULTITASK', 'WORKER_DURING_TURN']) await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn(task)
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'error')
      assert.match(end.error, /not support.*Multitask/)
      assert.equal(end.unconfirmed, true)
      assert.equal(deltas(events), '')
      assert.ok(!wire(cwd).some(entry => entry.method === 'permission-reply'))
      await assert.rejects(driver.sendTurn('AGAIN'), /not support.*Multitask/)
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    } finally { driver.dispose() }
  })
})

test('CodeBuddy reports and disconnects on idle worker questions and drain turns', async () => {
  for (const task of ['WORKER_AFTER_END', 'DRAIN_AFTER_END']) await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn(task)
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'done')
      await until(() => events.find(event => event.type === 'note' && /not support.*Multitask/.test(event.text)))
      assert.equal(driver.hasSession(), false)
      assert.ok(!events.some(event => event.type === 'request/opened'))
      assert.equal(deltas(events), '')
      assert.ok(!wire(cwd).some(entry => entry.method === 'permission-reply'), 'disconnect never pretends the worker request was answered')
      await assert.rejects(driver.sendTurn('AGAIN'), /not support.*Multitask/)
    } finally { driver.dispose() }
    assert.equal(wire(cwd).filter(entry => entry.method === 'session/prompt').length, 1)
  })
})

test('CodeBuddy capabilities and parent-only replies survive the native pump boundary', async () => {
  await withFixture(async ({ bin, cwd }) => {
    let pump
    const driver = createDriver('codebuddy', { bin, cwd, onEvent: event => pump.receive(event) })
    pump = createPump({ driver })
    const input = text => ({ messages: [{ id: text, role: 'user', content: [{ type: 'text', text }] }] })
    const collect = async text => {
      const chunks = []
      for await (const chunk of pump.stream(input(text))) chunks.push(chunk)
      return chunks
    }
    try {
      await assert.rejects(collect('/multitask'), /not support.*Multitask/)
      const chunks = await collect('MEMBER_CHUNKS')
      assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Parent final')
      assert.equal(pump.active, false)
      await assert.rejects(collect('ENABLE_MULTITASK'), /not support.*Multitask/)
      assert.equal(pump.active, false)
      await assert.rejects(collect('AGAIN'), /not support.*Multitask/)
    } finally { driver.dispose(); pump.dispose() }
  })
})
