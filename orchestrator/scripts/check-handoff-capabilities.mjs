import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createDriver, listEngines } from '../agent-drivers/src/index.js'
import { createNativeDshDriver } from '../agent-drivers/src/dsh/native.js'
import { install } from '../src/host/dispatch.js'
import { createPump } from '../src/host/adapter/pump.js'
import { until } from '../test/helpers/host.js'

const { values } = parseArgs({ options: { engine: { type: 'string' } } })
const engines = listEngines()
if (values.engine && !engines.includes(values.engine)) throw new Error(`Unknown engine: ${values.engine}`)

const withFixture = async (engine, run) => {
  const cwd = mkdtempSync(join(tmpdir(), `nodo-handoff-${engine}-`))
  const bin = join(cwd, engine)
  copyFileSync(new URL(`../test/fixtures/${engine}-cli.cjs`, import.meta.url), bin)
  chmodSync(bin, 0o755)
  const events = []
  const driver = createDriver(engine, { bin, cwd, storageDir: join(cwd, 'storage'), onEvent: event => events.push(event) })
  try { await run(driver, events) }
  finally { driver.dispose(); rmSync(cwd, { recursive: true, force: true }) }
}
const ended = events => events.find(event => event.type === 'turn/end')
const reply = events => {
  const end = ended(events)
  if (typeof end?.text === 'string') return end.text
  const complete = events.filter(event => event.type === 'text')
  if (complete.length) return complete.at(-1).text
  return events.filter(event => event.type === 'delta').map(event => event.text).join('')
}

for (const engine of values.engine ? [values.engine] : engines) {
  test(`${engine}: serial rounds keep distinct IDs, failure text never implies success, cancellation ends the owning round`, { timeout: 15000 }, async () => {
    await withFixture(engine, async (driver, events) => {
      let previous
      for (const [tag, outcome] of [['one', 'done'], ['two', 'done'], ['done', 'error']]) {
        events.length = 0
        const id = await driver.sendTurn(`HANDOFF ${tag} ${outcome}`)
        const end = await until(() => ended(events))
        assert.notEqual(id, previous)
        assert.equal(events.find(event => event.type === 'turn/start').turnId, id)
        assert.equal(end.turnId, id)
        assert.equal(end.reason, outcome)
        assert.match(reply(events), new RegExp(`Final ${tag}$`))
        assert.doesNotMatch(reply(events), /Final (?:one|two)(?!$)/)
        previous = id
      }
      events.length = 0
      const id = await driver.sendTurn('WAIT')
      await driver.interruptTurn()
      const end = await until(() => ended(events))
      assert.equal(end.turnId, id)
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.unconfirmed, undefined, 'the engine confirmed this stop')
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    })
  })

  test(`${engine}: required turn text keeps every message of the round and nothing from earlier rounds`, { timeout: 10000 }, async () => {
    await withFixture(engine, async (driver, events) => {
      await driver.sendTurn('HANDOFF one done')
      await until(() => ended(events))
      events.length = 0
      const id = await driver.sendTurn('HANDOFF result done')
      await until(() => ended(events))
      const own = events.filter(event => ['delta', 'text'].includes(event.type))
      assert.ok(own.every(event => event.turnId === undefined || event.turnId === id))
      const text = own.map(event => event.text).join('')
      assert.match(text, /Progress result/)
      assert.match(text, /Final result$/)
      assert.doesNotMatch(text, /Final one/)
    })
  })

  test(`${engine}: optional final message is the round's last assistant message alone`, { timeout: 10000 }, async () => {
    await withFixture(engine, async (driver, events) => {
      await driver.sendTurn('HANDOFF one done')
      await until(() => ended(events))
      events.length = 0
      await driver.sendTurn('HANDOFF result done')
      assert.equal((await until(() => ended(events))).text, 'Final result')
    })
  })
}

const nativeHarness = () => {
  const listeners = new Map()
  const events = []
  const agent = { status: 'idle', session: { id: 'native-fixture', header: { cwd: '/tmp' } }, ctx: {}, whenIdle: async () => {} }
  const host = {
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    get: () => undefined,
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace' }) },
    sessionController: {
      create: async () => ({ sessionId: agent.session.id }), rename: async () => {},
      resolveAgent: async () => ({ agent }), prompt: async () => {}, cancel: async () => {},
    },
  }
  const driver = createNativeDshDriver({ nativeHost: host, cwd: '/tmp', onEvent: event => events.push(event) })
  const emit = (type, data, session = agent.session) => listeners.get('session/event')(session, { type, data })
  return { driver, events, emit, agent }
}

test('DSH native services: complete message boundary exposes final text and native turn reference filters late events', { skip: values.engine && values.engine !== 'dsh' }, async () => {
  const { driver, events, emit, agent } = nativeHarness()
  try {
    for (const kind of ['completed', 'error', 'aborted']) {
      events.length = 0
      const id = await driver.sendTurn('task')
      emit('turn/start', { turn: kind })
      emit('assistant/message', { turn: 'old', message: { content: [{ type: 'text', text: 'OLD' }] } })
      emit('assistant/message', { turn: kind, message: { content: [{ type: 'text', text: 'FOREIGN' }] } }, { id: 'other' })
      for (const name of ['Progress', 'Final']) emit('assistant/message', { turn: kind, message: { content: [{ type: 'text', text: `${name} result` }] } })
      emit('turn/end', { turn: 'old', reason: { kind: 'completed' } })
      assert.equal(ended(events), undefined)
      emit('turn/end', { turn: kind, reason: { kind } })
      assert.equal(ended(events).turnId, id)
      assert.equal(ended(events).reason, kind === 'completed' ? 'done' : kind === 'aborted' ? 'interrupted' : 'error')
      assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.text), ['Progress result', 'Final result'])
      assert.equal(reply(events), 'Final result')
      assert.equal(ended(events).text, 'Final result')
    }
    events.length = 0
    const id = await driver.sendTurn('cancel')
    let release
    agent.whenIdle = () => new Promise(resolve => { release = resolve })
    const stopped = driver.interruptTurn()
    await until(() => release)
    assert.equal(ended(events), undefined, 'cancel acknowledgement alone is insufficient')
    release()
    await stopped
    assert.equal(ended(events).turnId, id)
    assert.equal(ended(events).reason, 'interrupted')
  } finally { driver.dispose() }
})

const dispatchHarness = () => {
  let cleanup
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const session = { id: 'conversation', name: 'fixture', profileName: 'Fixture', briefSent: true }
  const conversation = { profile: { id: 'profile' }, session }
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    conversation: () => conversation, conversationOf: () => conversation,
    prepareConversation: async () => conversation.profile,
    ensureDriver: async () => driver,
    admitImages: () => [], saveImages: async () => [], isCompacting: () => false,
    renderTask: text => text, renderIdentity: () => '', renderAssignment: (_identity, text) => text,
    redactDeepSecrets: value => value, appendLine: (_id, line) => line,
    save: async () => {}, statsRound() {}, statsOutput() {}, statsEnd() {}, recordTaskOutcome() {},
  }
  const driver = {
    instructionMode: 'native', hasSession: () => true, openSession: async () => {},
    sendTurn: async () => { rt.driverSink(session.id, { type: 'turn/start', turnId: 'current' }); markStarted(); return 'current' },
  }
  install(rt)
  return { rt, started, sink: event => rt.driverSink(session.id, event), dispose: () => cleanup() }
}

test('legacy dispatch: required completion text is the whole round in arrival order', async () => {
  const { rt, started, sink, dispose } = dispatchHarness()
  try {
    const placed = await rt.send('profile', 'task')
    await started
    for (const text of ['Progress result', 'Final result']) sink({ type: 'text', turnId: 'current', text })
    sink({ type: 'turn/end', turnId: 'current', reason: 'done' })
    assert.equal((await placed.completion).text, 'Progress result\nFinal result')
  } finally { dispose() }
})

test('dispatch: the engine last message rides beside the whole round, which stays the text', async () => {
  const { rt, started, sink, dispose } = dispatchHarness()
  try {
    const placed = await rt.send('profile', 'task')
    await started
    for (const text of ['Progress result', 'Final result']) sink({ type: 'text', turnId: 'current', text })
    sink({ type: 'turn/end', turnId: 'current', reason: 'done', text: 'Final result' })
    const outcome = await placed.completion
    assert.deepEqual([outcome.text, outcome.final], ['Progress result\nFinal result', 'Final result'])
  } finally { dispose() }
})

test('legacy dispatch: required stale delta rejection protects the current completion', async () => {
  const { rt, started, sink, dispose } = dispatchHarness()
  try {
    const placed = await rt.send('profile', 'task')
    await started
    sink({ type: 'delta', turnId: 'old', text: 'OLD' })
    sink({ type: 'text', turnId: 'current', text: 'Final result' })
    sink({ type: 'turn/end', turnId: 'current', reason: 'done' })
    assert.equal((await placed.completion).text, 'Final result')
  } finally { dispose() }
})

test('legacy dispatch: required stale end rejection leaves the current round running', async () => {
  const { rt, started, sink, dispose } = dispatchHarness()
  try {
    const placed = await rt.send('profile', 'task')
    await started
    let settled = false
    placed.completion.then(() => { settled = true })
    sink({ type: 'turn/end', turnId: 'old', reason: 'done', text: 'OLD' })
    await new Promise(resolve => setImmediate(resolve))
    const settledByOld = settled
    sink({ type: 'turn/end', turnId: 'current', reason: 'done', text: 'Final result' })
    await placed.completion
    assert.equal(settledByOld, false, 'old completion must not settle the current waiter')
  } finally { dispose() }
})

test('native mirror: a stop settled without an engine end is marked unconfirmed', async () => {
  let pump
  pump = createPump({ driver: {
    sendTurn: async () => pump.receive({ type: 'tool', callId: 'read', name: 'Read', phase: 'start' }),
    interruptTurn: async () => {},
  } })
  try {
    for await (const _chunk of pump.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] })) {}
    const claim = pump.takeMirror()
    await pump.interrupt()
    const result = await claim.done
    assert.equal(result.status, 'interrupted')
    assert.equal(result.unconfirmed, true, 'no engine end event or idle confirmation was received')
  } finally { pump.dispose() }
})
