// The DSH Desktop adapter reports the host's own session projections — the token
// usage, context pressure and wall times the native statistics row shows — and
// falls back to the per-message TokenUsage when a host has no projection service.
// No dsh process is needed: the host is a stub shaped like the real services.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeDshDriver } from '../agent-drivers/src/dsh/native.js'
import { createDriver, engineCatalog, enginePermissionModes } from '../agent-drivers/src/index.js'
import { nativeDshChanges } from '../agent-drivers/src/dsh/native-changes.js'

const totals = () => ({
  tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  contextPressure: { pressureTokens: undefined, contextWindow: undefined },
  sessionStats: { ttftMs: 0, ttftSteps: 0, llmMs: 0, toolMs: 0, decodeMs: 0, decodeTokens: 0 },
})

const harness = ({ projected = true, services = {}, permission, instructions } = {}) => {
  const listeners = new Map()
  const on = (name, handler) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {} }
  const emitTo = (name, ...args) => (listeners.get(name) ?? []).map(handler => handler(...args)).at(-1)
  const projection = totals()
  const agent = { status: 'idle', session: { id: 'dsh-native-1', header: { cwd: '/tmp/ws' } }, ctx: {}, whenIdle: async () => {} }
  const host = {
    on,
    get: name => (projected && name === 'sessionProjections'
      ? { snapshot: () => ({ values: structuredClone(projection) }) }
      : services[name]),
    workspaceRegistry: { resolveByPath: async cwd => ({ id: 'w1', cwd }), create: async cwd => ({ id: 'w1', cwd }) },
    sessionController: {
      create: async () => ({ sessionId: 'dsh-native-1' }),
      rename: async () => {},
      resolveAgent: async () => ({ agent }),
      selectModel: async () => {},
      prompt: async () => {},
      cancel: async () => {},
    },
  }
  const events = []
  const driver = createNativeDshDriver({ nativeHost: host, cwd: '/tmp/ws', name: 'Coder', sessionName: 'Session 1', permission, instructions, onEvent: event => events.push(event) })
  return { host, agent, events, driver, projection, emitTo }
}

// One host turn: the native window's own start event, an assembled message and
// the end event the driver matches by turn reference.
const turn = (agent, emitTo, id, message = {}) => {
  const reference = { id }
  emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: reference } })
  if (message.usage || message.content) {
    emitTo('session/event', agent.session, { type: 'assistant/message', data: { turn: reference, message: { content: message.content ?? [{ type: 'text', text: 'ok' }] }, usage: message.usage } })
  }
  emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: reference, reason: { kind: 'completed' } } })
  return reference
}

test('native DSH applies a thinking-only choice to the session model before the host default', async () => {
  const { host, agent } = harness({ services: { agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default-model' }) } } })
  const selections = []
  host.sessionController.selectModel = async request => { selections.push(request) }
  agent.session.snapshotEvents = () => [
    { type: 'model/selection', data: { provider: 'old', model: 'old-model' } },
    { type: 'request/header', data: { header: { config: { provider: 'session', model: 'session-model' } } } },
  ]
  for (const [model, expected] of [[undefined, ['session', 'session-model']], ['["explicit","explicit-model"]', ['explicit', 'explicit-model']]]) {
    const driver = createNativeDshDriver({ nativeHost: host, cwd: '/tmp/ws', driverSessionId: agent.session.id, model, thinking: 'high' })
    try {
      await driver.openSession()
      assert.deepEqual(selections.at(-1), { sessionId: agent.session.id, provider: expected[0], model: expected[1], reasoningEffort: 'high' })
    } finally { driver.dispose() }
  }
})

test('native DSH uses the host default for a new thinking-only session and still rejects an absent model', async () => {
  for (const selection of [{ provider: 'default', model: 'default-model' }, undefined]) {
    const { host } = harness({ services: { agentDefaultModel: { currentSelection: () => selection } } })
    const selections = []
    host.sessionController.selectModel = async request => { selections.push(request) }
    const driver = createNativeDshDriver({ nativeHost: host, cwd: '/tmp/ws', thinking: 'high' })
    try {
      if (selection) {
        await driver.openSession()
        assert.deepEqual(selections, [{ sessionId: 'dsh-native-1', ...selection, reasoningEffort: 'high' }])
      } else {
        await assert.rejects(driver.openSession(), /Choose a DSH model/)
        assert.equal(selections.length, 0)
      }
    } finally { driver.dispose() }
  }
})

test('native DSH queries only its announced session and event seq, retaining workspace snapshot attribution', async () => {
  const queried = []
  const summary = { turn: 8, cwd: '/tmp/ws', total: 13, files: Array.from({ length: 10 }, (_, i) => ({ path: `file-${i}`, ...(i === 1 ? { binary: true } : i === 2 ? { oversized: true } : {}) })) }
  const workspaceChanges = {
    summary: (session, seq) => { queried.push([session, seq]); return summary },
    diff: async (session, seq, index) => {
      assert.equal(session, 'dsh-native-1'); assert.equal(seq, 203)
      if (index === 3) return undefined
      if (index === 4) throw new Error('disposed source')
      return { kind: 'text', path: `file-${index}`, coarse: index === 5, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }] }
    },
  }
  const { agent, driver, events, emitTo } = harness({ services: { workspaceChanges } })
  try {
    await driver.sendTurn('changes')
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 8 } })
    emitTo('session/event', { id: 'foreign-session' }, { type: 'workspace/changes', seq: 90, data: { turn: 8 } })
    emitTo('session/event', agent.session, { type: 'workspace/changes', seq: 91, data: { turn: 7 } })
    emitTo('session/event', agent.session, { type: 'workspace/changes', seq: 202, data: { turn: 8 } })
    emitTo('session/event', agent.session, { type: 'workspace/changes', seq: 203, data: { turn: 8 } })
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(queried, [['dsh-native-1', 203]])
    const snapshot = events.find(event => event.type === 'changes').presentation
    assert.equal(snapshot.body.scope, 'workspace-snapshot')
    assert.equal(snapshot.body.coverage, 'partial')
    assert.equal(snapshot.body.fileCount, 13)
    assert.equal(snapshot.body.files.length, 10)
    assert.equal(snapshot.capture, 'partial')
    assert.match(snapshot.body.files[0].edits[0].diffText, /@@ -1,1 \+1,1 @@\n-before\n\+after/)
    assert.equal(snapshot.body.files[1].edits[0].availability, 'binary')
    assert.equal(snapshot.body.files[2].edits[0].availability, 'oversized')
    assert.equal(snapshot.body.files[3].edits[0].availability, 'unavailable')
    assert.equal(snapshot.body.files[4].edits[0].availability, 'unavailable')
    assert.equal(snapshot.body.files[5].edits[0].availability, 'coarse')
    assert.ok(events.findIndex(event => event.type === 'changes') < events.findIndex(event => event.type === 'turn/end'))
  } finally { driver.dispose() }
})

test('native DSH service absence and disposed summaries do not invent an empty edit set', async () => {
  assert.equal(nativeDshChanges({ get: () => undefined }, 'session', 20, 1, 'turn'), null)
  assert.equal(nativeDshChanges({ get: () => ({ summary: () => undefined }) }, 'session', 20, 1, 'turn'), null)
  assert.equal(nativeDshChanges({ get: () => ({ summary: () => ({ turn: 2, cwd: '/x', files: [] }) }) }, 'session', 20, 1, 'turn'), null)
  const { agent, driver, events, emitTo } = harness()
  try {
    await driver.sendTurn('no source')
    turn(agent, emitTo, 1)
    assert.equal(events.filter(event => event.type === 'changes').length, 0)
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
  } finally { driver.dispose() }
})

test('native DSH preserves summary indices across malformed entries and cannot hang on an unresponsive diff', async () => {
  const indices = []
  const keepAlive = setTimeout(() => {}, 3000)
  try {
    const snapshot = await nativeDshChanges({ get: () => ({
      summary: () => ({ turn: 1, cwd: '/x', total: 2, files: [null, { path: 'kept' }] }),
      diff: (_session, _seq, index) => { indices.push(index); return new Promise(() => {}) },
    }) }, 'session', 99, 1, 'turn')
    assert.deepEqual(indices, [1])
    assert.equal(snapshot.presentation.body.files[0].edits[0].availability, 'unavailable')
    assert.equal(snapshot.presentation.body.fileCount, 2)
  } finally { clearTimeout(keepAlive) }
})

test('native DSH relays images with and without text through host admission', async () => {
  const { host, agent, driver, emitTo } = harness()
  const prompts = []
  host.sessionController.prompt = async request => { prompts.push(request) }
  const images = [{ mediaType: 'image/png', data: 'AQID', name: 'shot.png' }]
  try {
    await driver.sendTurn('look', images)
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AQID' }])
    turn(agent, emitTo, 'first')
    await driver.sendTurn('', images)
    assert.deepEqual(prompts[1].content, [{ type: 'image', mediaType: 'image/png', data: 'AQID' }])
  } finally { driver.dispose() }
})

test('native DSH steering uses the owning session without creating a new turn', async () => {
  const { host, agent, driver, events } = harness()
  const prompts = []
  host.sessionController.prompt = async request => { prompts.push(request) }
  assert.equal(await driver.steer('too early'), 'refused')
  await driver.sendTurn('first')
  agent.status = 'running'
  assert.equal(await driver.steer('follow-up'), 'steered')
  assert.equal(prompts[1].sessionId, 'dsh-native-1')
  assert.equal(prompts[1].mode, 'steer')
  assert.deepEqual(prompts[1].content, [{ type: 'text', text: 'follow-up' }])
  assert.notEqual(prompts[1].requestId, prompts[0].requestId)
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
  host.sessionController.prompt = async () => { throw new Error('not accepted') }
  assert.equal(await driver.steer('refused'), 'refused')
  driver.dispose()
})

test('native DSH reserves the turn during startup and cancels before admission', async () => {
  const { host, driver, events } = harness()
  const opening = Promise.withResolvers()
  host.workspaceRegistry.resolveByPath = () => opening.promise
  let prompts = 0
  host.sessionController.prompt = async () => { prompts++ }
  try {
    const sending = driver.sendTurn('first')
    await assert.rejects(driver.sendTurn('overlap'), /running turn/)
    const stopping = driver.interruptTurn()
    opening.resolve({ id: 'w1' })
    await Promise.all([sending, stopping])
    assert.equal(prompts, 0)
    assert.equal(events.filter(event => event.type === 'turn/start').length, 0)
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
  } finally { opening.resolve({ id: 'w1' }); driver.dispose() }
})

test('native DSH cancels admitted work only after pending admission settles', async () => {
  const { host, agent, driver, events, emitTo } = harness()
  const admission = Promise.withResolvers(), entered = Promise.withResolvers()
  let signal, cancelled = 0
  host.sessionController.prompt = async (_request, current) => {
    signal = current
    entered.resolve()
    await admission.promise
    agent.status = 'running'
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
  }
  host.sessionController.cancel = async () => {
    cancelled++
    agent.status = 'idle'
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  }
  try {
    const sending = driver.sendTurn('first')
    await entered.promise
    const stopping = driver.interruptTurn()
    assert.equal(signal.aborted, true)
    assert.equal(events.some(event => event.type === 'turn/end'), false)
    await assert.rejects(driver.sendTurn('retry too early'), /running turn/)
    admission.resolve()
    await Promise.all([sending, stopping])
    assert.equal(cancelled, 1)
    assert.equal(agent.status, 'idle')
    const ended = events.filter(event => event.type === 'turn/end')
    assert.equal(ended.length, 1)
    assert.equal(ended[0].unconfirmed, undefined)
    host.sessionController.prompt = async () => {}
    const retry = await driver.sendTurn('retry')
    turn(agent, emitTo, 2, { content: [{ type: 'text', text: 'retry reply' }] })
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).turnId, retry)
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).text, 'retry reply')
  } finally { admission.resolve(); driver.dispose() }
})

test('native DSH late admission failure and idle completion cannot settle a retry', async () => {
  const { host, agent, driver, events, emitTo } = harness()
  const admission = Promise.withResolvers(), entered = Promise.withResolvers(), idle = Promise.withResolvers()
  host.sessionController.prompt = async () => { entered.resolve(); await admission.promise }
  agent.whenIdle = () => idle.promise
  try {
    const sending = driver.sendTurn('first')
    await entered.promise
    const stopping = driver.interruptTurn()
    admission.reject(new Error('late admission failure'))
    await sending
    await assert.rejects(driver.sendTurn('overlap'), /running turn/)
    idle.resolve()
    await stopping
    host.sessionController.prompt = async () => {}
    const retry = await driver.sendTurn('retry')
    turn(agent, emitTo, 2)
    assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.reason), ['interrupted', 'done'])
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).turnId, retry)
  } finally { admission.resolve(); idle.resolve(); driver.dispose() }
})

test('native DSH stop timeout is unconfirmed and holds retries until native idle', async t => {
  const { host, agent, driver, events, emitTo } = harness()
  const idle = Promise.withResolvers(), cancelling = Promise.withResolvers()
  host.sessionController.cancel = async () => { cancelling.resolve() }
  agent.whenIdle = () => idle.promise
  try {
    await driver.sendTurn('first')
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const stopping = driver.interruptTurn()
    await cancelling.promise
    t.mock.timers.tick(5000)
    await stopping
    assert.equal(events.find(event => event.type === 'turn/end').unconfirmed, true)
    await assert.rejects(driver.sendTurn('unsafe retry'), /still stopping/)
    idle.resolve()
    await new Promise(resolve => setImmediate(resolve))
    const retry = await driver.sendTurn('retry')
    turn(agent, emitTo, 2)
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).turnId, retry)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
  } finally { idle.resolve(); t.mock.timers.reset(); driver.dispose() }
})

test('native DSH disposal reports an unconfirmed stop and cleans identity after late admission', async () => {
  const { host, agent, driver, events } = harness({ instructions: 'identity' })
  const admission = Promise.withResolvers(), entered = Promise.withResolvers(), cancelled = Promise.withResolvers()
  let removed = 0, signal
  agent.ctx.systemPrompt = { section: () => () => { removed++ } }
  host.sessionController.prompt = async (_request, current) => {
    signal = current
    entered.resolve()
    await admission.promise
    agent.status = 'running'
  }
  host.sessionController.cancel = async () => { agent.status = 'idle'; cancelled.resolve() }
  try {
    const sending = driver.sendTurn('first')
    await entered.promise
    driver.dispose()
    assert.equal(signal.aborted, true)
    assert.equal(events.find(event => event.type === 'turn/end').unconfirmed, true)
    assert.equal(removed, 0)
    admission.resolve()
    await sending
    await cancelled.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(agent.status, 'idle')
    assert.equal(removed, 1)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    await assert.rejects(driver.sendTurn('after disposal'), /disposed/)
  } finally { admission.resolve(); driver.dispose() }
})

test('native DSH delegates multiselect batches to the host without changing their answers', async () => {
  const { agent, driver, events, emitTo } = harness()
  const answers = { answers: [{ id: 'q', selected: ['A', 'B'], custom: 'note' }] }
  try {
    await driver.sendTurn('question')
    const questions = [{ id: 'q', question: 'choose', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]
    assert.equal(await emitTo('user-questions/request', { agent, questions }, async () => answers), answers)
    assert.equal(events.some(event => event.type === 'request/opened'), false)
    const answer = emitTo('user-questions/request', { agent, questions: [{ id: 'single', question: 'choose', options: [{ label: 'A' }] }] }, () => assert.fail('single choice must remain a Nodo card'))
    const card = events.find(event => event.type === 'request/opened')
    assert.equal(await driver.respondToRequest(card.id, { decision: 'answer', value: 'A' }), true)
    assert.deepEqual(await answer, { answers: [{ id: 'single', selected: ['A'] }] })
  } finally { driver.dispose() }
})

test('native DSH cancellation closes approval cards once and refuses late answers', async () => {
  const { host, agent, driver, events, emitTo } = harness()
  const idle = Promise.withResolvers(), cancelling = Promise.withResolvers()
  agent.whenIdle = () => idle.promise
  host.sessionController.cancel = async () => { cancelling.resolve() }
  try {
    await driver.sendTurn('permission')
    const result = emitTo('approval/request', { agent, toolName: 'bash' }, () => assert.fail('own approval'))
    const card = events.find(event => event.type === 'request/opened')
    const stopping = driver.interruptTurn()
    assert.equal(await result, 'cancelled')
    assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), false)
    assert.equal(events.filter(event => event.type === 'request/closed' && event.id === card.id).length, 1)
    assert.equal(emitTo('approval/request', { agent, toolName: 'late' }, () => assert.fail('cancelled approval')), 'cancelled')
    await cancelling.promise
    idle.resolve()
    await stopping
    assert.equal(events.filter(event => event.type === 'request/closed').length, 1)
  } finally { idle.resolve(); driver.dispose() }
})

test('native DSH cancellation waits for steering admission and isolates late errors', async () => {
  const { host, agent, driver, events, emitTo } = harness()
  const admission = Promise.withResolvers(), entered = Promise.withResolvers()
  const idle = Promise.withResolvers(), cancelling = Promise.withResolvers()
  host.sessionController.cancel = async () => { cancelling.resolve(); agent.status = 'idle' }
  agent.whenIdle = () => idle.promise
  try {
    await driver.sendTurn('first')
    agent.status = 'running'
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    host.sessionController.prompt = async () => { entered.resolve(); await admission.promise }
    const steering = driver.steer('follow-up')
    await entered.promise
    const stopping = driver.interruptTurn()
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    assert.equal(events.some(event => event.type === 'turn/end'), false)
    admission.resolve()
    await steering
    await cancelling.promise
    await assert.rejects(driver.sendTurn('overlap'), /running turn/)
    idle.resolve()
    await stopping
    host.sessionController.prompt = async () => {}
    const retry = await driver.sendTurn('retry')
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
    emitTo('agent/error', { agent, turn: 1, error: new Error('old error') })
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).turnId, retry)
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).reason, 'done')
  } finally { admission.resolve(); idle.resolve(); driver.dispose() }
})

test('a Desktop turn reports the host projections as its own usage and timing', async () => {
  const { agent, events, driver, projection, emitTo } = harness()
  await driver.openSession()
  await driver.sendTurn('do it')
  projection.tokenUsage = { uncachedInputTokens: 120, outputTokens: 45, cacheReadTokens: 800, cacheWriteTokens: 30 }
  projection.contextPressure = { pressureTokens: 950, contextWindow: 8000 }
  projection.sessionStats = { ttftMs: 420, ttftSteps: 3, llmMs: 2100, toolMs: 300, decodeMs: 1500, decodeTokens: 40 }
  turn(agent, emitTo, 't1')

  const end = events.find(event => event.type === 'turn/end')
  assert.deepEqual(end.usage,
    { inputTokens: 120, outputTokens: 45, cacheReadTokens: 800, cacheWriteTokens: 30, contextUsed: 950, contextSize: 8000 },
    'the projection delta and the context pressure become the turn usage')
  assert.deepEqual(end.timing, { ttftMs: 420, ttftSteps: 3, llmMs: 2100, toolMs: 300, decodeMs: 1500, decodeTokens: 40 },
    'the host wall times ride along so the plugin never re-measures them')

  // The projections are cumulative: a second turn reports only what grew.
  await driver.sendTurn('again')
  projection.sessionStats = { ...projection.sessionStats, ttftMs: 500, llmMs: 2600, decodeMs: 1900, decodeTokens: 55 }
  turn(agent, emitTo, 't2')
  const second = events.filter(event => event.type === 'turn/end').at(-1)
  assert.deepEqual(second.usage,
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextUsed: 950, contextSize: 8000 },
    'a turn that reports no new tokens folds to zero, and context stays last-wins')
  assert.equal(second.timing.llmMs, 500, 'timing is the delta, not the cumulative total')
  driver.dispose()
})

test('a host without the projection service falls back to the per-message usage', async () => {
  const { agent, events, driver, emitTo } = harness({ projected: false })
  await driver.openSession()
  await driver.sendTurn('hi')
  turn(agent, emitTo, 't1', {
    content: [{ type: 'text', text: 'ok' }],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
  })
  const end = events.find(event => event.type === 'turn/end')
  assert.deepEqual(end.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, contextUsed: 12 },
    'message usage is summed and the prompt side becomes the context occupancy')
  assert.equal(end.timing, undefined, 'no projection means no wall times to report')
  driver.dispose()
})

test('reasoning blocks of one message keep their paragraph breaks', async () => {
  const { agent, events, driver, emitTo } = harness({ projected: false })
  await driver.openSession()
  await driver.sendTurn('think')
  turn(agent, emitTo, 't1', {
    content: [
      { type: 'reasoning', text: '先确认链路。' },
      { type: 'text', text: '好的' },
      { type: 'reasoning', text: '再改字段。' },
    ],
  })
  assert.deepEqual(events.filter(event => event.type === 'thinking').map(event => event.text), ['先确认链路。\n\n再改字段。'])
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.text), ['好的'])
  driver.dispose()
})

const permissionService = () => {
  const presets = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const selected = new Map()
  const writes = []
  return { names: Object.keys(presets), resolve: name => presets[name],
    current: session => selected.get(session.id) ?? 'workspace-write',
    set(session, preset) { selected.set(session.id, preset); writes.push({ sessionId: session.id, preset }) },
    writes,
  }
}

test('native DSH forwards tool call ids, arguments and result content', async () => {
  const { agent, events, driver, emitTo } = harness({ projected: false })
  try {
    await driver.sendTurn('read')
    emitTo('session/event', agent.session, { type: 'tool/call', data: { callId: 'read-1', name: 'Read', arguments: '{"path":"/tmp/fixture"}' } })
    const image = { type: 'image', attachment: { attachmentId: 'attachment-fixture', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }
    emitTo('session/event', agent.session, { type: 'tool/result', data: { message: { toolCallId: 'read-1', content: [{ type: 'text', text: 'file contents' }, image], isError: false } } })
    const tools = events.filter(event => event.type === 'tool')
    assert.deepEqual(tools.map(event => [event.callId, event.name, event.phase]), [['read-1', 'Read', 'start'], ['read-1', 'Read', 'end']])
    assert.equal(tools[0].input, '{"path":"/tmp/fixture"}')
    assert.deepEqual(tools[1].output, [{ type: 'text', text: 'file contents' }, image])
  } finally { driver.dispose() }
})

test('native capabilities follow available host services without widening ACP capabilities', () => {
  const permissionPresets = permissionService()
  const { host, driver } = harness({ services: { permissionPresets, compaction: { compactNow() {} } } })
  try {
    const native = engineCatalog(host).find(item => item.id === 'dsh')
    assert.deepEqual(native.capabilities.permissionModes, ['workspace', 'full'])
    assert.equal(native.capabilities.compact, true)
    assert.equal(native.capabilities.steer, true)
    assert.equal(engineCatalog().find(item => item.id === 'dsh').capabilities.steer, false)
    assert.deepEqual(enginePermissionModes('dsh', host), ['workspace', 'full'])
    assert.deepEqual(enginePermissionModes('dsh'), [])
    assert.equal(engineCatalog().find(item => item.id === 'dsh').capabilities.compact, undefined)
    const registered = createDriver('dsh', { nativeHost: host, cwd: '/tmp/ws' })
    assert.equal(typeof registered.compact, 'function')
    registered.dispose()
    permissionPresets.names.pop()
    assert.deepEqual(enginePermissionModes('dsh', host), ['workspace'])
  } finally { driver.dispose() }
})

test('native permissions target the resolved session and preserve later native selections', async () => {
  const permissionPresets = permissionService()
  const { agent, driver, emitTo } = harness({ services: { permissionPresets }, permission: 'full' })
  try {
    await driver.openSession()
    assert.deepEqual(permissionPresets.writes, [{ sessionId: agent.session.id, preset: 'danger-full-access' }])
    permissionPresets.set(agent.session, 'workspace-write')
    await driver.sendTurn('use the current native selection')
    turn(agent, emitTo, 'native-permissions')
    assert.equal(permissionPresets.current(agent.session), 'workspace-write')
    assert.equal(permissionPresets.writes.length, 2, 'a cached driver must not reset a native UI selection every turn')
  } finally { driver.dispose() }
  const unspecified = harness({ services: { permissionPresets } })
  try {
    await unspecified.driver.openSession()
    assert.equal(permissionPresets.writes.length, 2, 'an unset profile permission leaves the host selection intact')
  } finally { unspecified.driver.dispose() }
})

test('native permissions reject unavailable tiers and active native sessions', async () => {
  const unavailable = harness({ permission: 'full' })
  try { await assert.rejects(unavailable.driver.openSession(), /does not offer permission tier/) }
  finally { unavailable.driver.dispose() }
  const busy = harness({ permission: 'full', services: { permissionPresets: permissionService() } })
  busy.agent.status = 'running'
  try { await assert.rejects(busy.driver.openSession(), /busy in its native window/) }
  finally { busy.driver.dispose() }
})

test('native compact uses the owning agent, preserves identity and propagates failures', async () => {
  const calls = []
  const compaction = { async compactNow(agent, signal) { calls.push({ agent, signal }); return { summarySeq: 42 } } }
  const { agent, driver } = harness({ services: { compaction }, instructions: 'ROLE_IDENTITY' })
  const sections = []
  agent.ctx.systemPrompt = { section(spec) { sections.push(spec); return () => sections.pop() } }
  try {
    assert.deepEqual(await driver.compact(), { summarySeq: 42 })
    assert.equal(calls[0].agent, agent)
    assert.equal(calls[0].signal.aborted, false)
    assert.equal(driver.instructionMode, 'native')
    assert.equal(sections[0].text, 'ROLE_IDENTITY')
    compaction.compactNow = async () => null
    assert.equal(await driver.compact(), null, 'no compactable history remains a native no-op')
    compaction.compactNow = async () => { throw new Error('summary failed') }
    await assert.rejects(driver.compact(), /summary failed/)
    agent.status = 'running'
    await assert.rejects(driver.compact(), /Stop or finish/)
  } finally { driver.dispose() }
})

test('native compact blocks overlapping work and is cancelled on interrupt or disposal', async () => {
  for (const action of ['interruptTurn', 'dispose']) {
    let signal
    const started = Promise.withResolvers()
    const { driver } = harness({ services: { compaction: {
      compactNow(agent, current) {
        signal = current
        started.resolve()
        return new Promise((resolve, reject) => current.addEventListener('abort', () => reject(current.reason), { once: true }))
      },
    } } })
    try {
      const operation = driver.compact()
      const rejected = assert.rejects(operation, { name: 'AbortError' })
      await started.promise
      await assert.rejects(driver.compact(), /Stop or finish/)
      await assert.rejects(driver.sendTurn('overlap'), /running turn or compaction/)
      await driver[action]()
      await rejected
      assert.equal(signal.aborted, true)
    } finally { driver.dispose() }
  }
})

test('native compact resolves the target agent preset and never falls back across its isolation', async () => {
  let selected
  const calls = []
  const global = { compactNow() { throw new Error('wrong global compaction service') } }
  const scoped = { async compactNow(agent) { calls.push(agent); return null } }
  const { agent, driver } = harness({ services: { compaction: global, agentPresets: {
    serviceFor(target, name) { assert.equal(name, 'compaction'); selected = target; return scoped },
  } } })
  try {
    await driver.compact()
    assert.equal(selected, agent)
    assert.deepEqual(calls, [agent])
    scoped.compactNow = undefined
    await assert.rejects(driver.compact(), /preset has no native compaction service/)
  } finally { driver.dispose() }
})

test('native DSH maps compaction lifetimes, retry waits and todo snapshots onto status events', async () => {
  const { agent, driver, events, emitTo } = harness()
  try {
    await driver.openSession()
    // Host-initiated compaction runs outside any turn and keeps its own identity.
    emitTo('session/event', agent.session, { type: 'compaction/start', data: { compactionId: 'c-9', turn: null } })
    emitTo('session/event', agent.session, { type: 'compaction/end', data: { compactionId: 'c-9', turn: null, error: 'compaction boom' } })
    emitTo('session/event', { id: 'foreign-session' }, { type: 'compaction/start', data: { compactionId: 'foreign' } })
    await driver.sendTurn('work')
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 5 } })
    emitTo('session/event', agent.session, { type: 'llm/retry', data: { retryId: 'r-1', turn: 5, step: 1, provider: 'fixture', mode: 'normal', policyKey: 'k',
      retry: 2, maxRetries: 5, delayMs: 8000, failure: { message: 'rate limited', code: 'rate' } } })
    emitTo('session/event', agent.session, { type: 'llm/retry-started', data: { retryId: 'r-1', turn: 5 } })
    emitTo('session/event', agent.session, { type: 'todo/write', data: { todos: [{ content: 'first', status: 'completed' }, { content: 'second', status: 'in_progress' }, { content: 'broken', status: 'mystery' }, null] } })
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    const lifecycle = events.filter(event => event.type === 'lifecycle')
    assert.deepEqual(lifecycle.map(event => [event.kind, event.phase, event.isError === true]),
      [['compaction', 'start', false], ['compaction', 'end', true], ['retry', 'start', false], ['retry', 'end', false]])
    assert.equal(lifecycle[0].turnId, undefined)
    assert.equal(lifecycle[0].entityId, 'c-9')
    assert.equal(lifecycle[1].detail, 'compaction boom')
    assert.equal(lifecycle[2].entityId, 'r-1')
    assert.equal(lifecycle[2].detail, '第 2/5 次，等待 8 秒，rate limited')
    assert.deepEqual(events.find(event => event.type === 'plan').steps,
      [{ text: 'first', status: 'completed' }, { text: 'second', status: 'in_progress' }, { text: 'broken', status: 'pending' }],
      'an off-enum status falls back to pending and malformed rows drop')
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
  } finally { driver.dispose() }
})

test('native DSH workflow runs become attributed member activity with neutral terminals', async () => {
  const { agent, driver, events, emitTo } = harness()
  try {
    await driver.sendTurn('workflow')
    emitTo('session/event', agent.session, { type: 'turn/start', data: { turn: 3 } })
    emitTo('session/event', agent.session, { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'Parallel research' } })
    emitTo('session/event', agent.session, { type: 'tool-workflow/agent-start', data: { runId: 'run-1', seq: 0, label: 'Scout', phase: 'running', childId: 'child-9' } })
    emitTo('session/event', agent.session, { type: 'tool-workflow/agent-end', data: { runId: 'run-1', seq: 0, outcome: 'success' } })
    emitTo('session/event', agent.session, { type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' } })
    emitTo('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    const activity = events.filter(event => event.type === 'activity')
    assert.deepEqual(activity.map(event => [event.entityId, event.phase]),
      [['run-1', 'start'], ['run-1/0', 'start'], ['run-1/0', 'end'], ['run-1', 'end']])
    assert.equal(activity[0].name, 'workflow')
    assert.equal(activity[0].title, 'Parallel research')
    assert.equal(activity[1].parentId, 'run-1', 'members keep their run container as the parent id')
    assert.equal(activity[1].name, 'subagent')
    assert.equal(activity[1].title, 'Scout')
    assert.equal(activity[1].childId, 'child-9')
    assert.equal(activity.every(event => event.isError !== true), true,
      'outcome/stopReason enums are undeclared, so terminals stay neutral')
  } finally { driver.dispose() }
})
