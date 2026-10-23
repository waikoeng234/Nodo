import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/drivers.js'

const harness = () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-drivers-'))
  const listeners = new Map(), prompts = [], events = []
  const agent = { id: 'native-1', status: 'idle', session: { header: { cwd: '/tmp/ws' } }, ctx: {}, whenIdle: async () => {} }
  const ctx = {
    on: (name, handler) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => {} },
    get: () => undefined,
    effect() {},
    workspaceRegistry: { resolveByPath: async cwd => ({ id: 'w1', cwd }) },
    sessionController: { create: async () => { throw new Error('the adapter route owns session creation') }, rename: async () => {},
      resolveAgent: async () => ({ agent }), selectModel: async () => { throw new Error('the native session keeps its model') }, prompt: async request => { prompts.push(request) } },
  }
  const hosted = []
  const rt = { ctx, home, warn() {}, renderIdentity: () => 'Role identity', secretEnv: () => ({}), secretStamp: () => '', saveSessionEvent: async () => {},
    adapterSessionOf: async id => { hosted.push(id); return 'native-1' }, driverSink: (_id, event) => events.push(event) }
  install(rt)
  const emit = (name, ...args) => (listeners.get(name) ?? []).map(handler => handler(...args)).at(-1)
  return { rt, hosted, prompts, events, agent, emit, dispose: () => rmSync(home, { recursive: true, force: true }) }
}
const conversation = extra => ({ id: 'conv-1', engine: 'zcode', cwd: '/tmp/ws', name: 'Coder', sessionName: 'Step', env: [], engineOptions: {}, model: 'p$m', permission: 'workspace', ...extra })

test('an adapter-route conversation runs its turn in the native host session, with its approvals as Nodo cards', async () => {
  const h = harness()
  try {
    const driver = await h.rt.ensureDriver(conversation())
    assert.deepEqual(h.hosted, ['conv-1'])
    assert.equal(driver.instructionMode, 'native', 'the native session preset carries the role identity')
    assert.equal(driver.watchdog, false, 'the native session reports whole messages, so a long model call is not silence')
    await driver.sendTurn('TASK')
    assert.equal(h.prompts[0].sessionId, 'native-1')
    assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'TASK' }])
    const decided = h.emit('approval/request', { agent: h.agent, toolName: 'bash', reason: 'run tests' }, () => 'host card')
    const opened = h.events.find(event => event.type === 'request/opened')
    assert.equal(opened.kind, 'permission')
    assert.equal(await driver.respondToRequest(opened.id, { decision: 'allow' }), true)
    assert.equal(await decided, 'allowed-once')
    h.emit('session/event', { id: 'native-1' }, { type: 'turn/start', data: { turn: 1 } })
    h.emit('session/event', { id: 'native-1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'REPORT' }] } } })
    h.emit('session/event', { id: 'native-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(h.events.find(event => event.type === 'turn/end')?.text, 'REPORT')
    assert.equal(await h.rt.ensureDriver(conversation({ nativeSessionId: 'native-1' })), driver, 'unchanged settings keep the same driver')
  } finally { h.dispose() }
})

test('a conversation that already holds a direct engine thread keeps its engine driver', async () => {
  const h = harness()
  try {
    const driver = await h.rt.ensureDriver(conversation({ driverSessionId: 'zcode-thread' }))
    assert.deepEqual(h.hosted, [])
    assert.equal(driver.instructionMode, 'none', 'a direct engine reports its own channel until it connects')
    driver.dispose()
  } finally { h.dispose() }
})
