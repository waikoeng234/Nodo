import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPump, newestUserPrompt } from '../src/host/adapter/pump.js'
import { installSteering } from '../src/host/adapter/steering.js'

const message = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const flush = () => new Promise(resolve => setImmediate(resolve))

const harness = async steer => {
  const calls = []
  const listeners = new Map()
  const ctx = { on: (name, callback) => listeners.set(name, callback) }
  const pump = createPump({ driver: {
    sendTurn: async text => { calls.push(['send', text]); pump.receive({ type: 'tool', name: 'work', phase: 'start' }) },
    steer: async text => { calls.push(['steer', text]); return steer(text) },
  } })
  const entry = { pump }
  installSteering(ctx, id => id === 'native' ? entry : undefined)
  const agent = { id: 'native', status: 'running', inbox: { nextStep: [], nextTurn: [],
    remove(id) {
      const index = this.nextStep.findIndex(item => item.id === id)
      if (index < 0) return false
      const [removed] = this.nextStep.splice(index, 1)
      listeners.get('agent/inbox/discarded')({ agent, message: removed })
      return true
    },
  }, followup(item) { this.inbox.nextTurn.push(item) } }
  const insert = item => { agent.inbox.nextStep.push(item); listeners.get('agent/inbox/inserted')({ agent, message: item }) }
  const preStep = (messages, signal = new AbortController().signal) => listeners.get('agent/pre-step')({ agent, messages, signal }, async () => ({ kind: 'enter', messages }))
  const first = message('first', 'original')
  await collect(pump.stream({ messages: [first] }))
  return { agent, pump, calls, first, insert, preStep }
}

test('live native steering reaches the engine before the next model step and is never resent', async () => {
  const h = await harness(() => 'steered')
  try {
    const followup = message('followup', 'change focus', 'steering')
    h.insert(followup)
    await flush()
    assert.deepEqual(h.calls, [['send', 'original'], ['steer', 'change focus']])
    h.agent.inbox.nextStep.length = 0
    assert.deepEqual((await h.preStep([{ ...followup }])).messages, [followup])
    h.pump.receive({ type: 'tool', name: 'work', phase: 'end' })
    h.pump.receive({ type: 'turn/end', reason: 'done' })
    await collect(h.pump.stream({ messages: [h.first, followup] }))
    await collect(h.pump.stream({ messages: [h.first, followup] }))
    assert.equal(h.calls.filter(([kind]) => kind === 'send').length, 1)
    assert.equal(h.calls.filter(([kind]) => kind === 'steer').length, 1)
  } finally { h.pump.dispose() }
})

test('refused steering returns to native next-turn queue and remains available there', async () => {
  const h = await harness(() => 'refused')
  try {
    const followup = message('queued', 'later')
    h.insert(followup)
    await flush()
    assert.deepEqual(h.agent.inbox.nextStep, [])
    assert.deepEqual(h.agent.inbox.nextTurn, [followup])
    h.pump.receive({ type: 'turn/end', reason: 'done' })
    await collect(h.pump.stream({ messages: [h.first] }))
    assert.deepEqual((await h.preStep([followup])).messages, [followup])
    await collect(h.pump.stream({ messages: [h.first, followup] }))
    assert.deepEqual(h.calls.filter(([kind]) => kind === 'send'), [['send', 'original'], ['send', 'later']])
  } finally { h.pump.dispose() }
})

test('an unconfirmed steer is neither queued nor sent again, and the flow says so', async () => {
  const h = await harness(() => 'indeterminate')
  try {
    const followup = message('unsure', 'maybe delivered')
    h.insert(followup)
    await flush()
    assert.deepEqual(h.agent.inbox.nextTurn, [])
    assert.deepEqual((await h.preStep([followup])).messages, [followup])
    const done = collect(h.pump.stream({ messages: [h.first] }))
    await flush()
    h.pump.receive({ type: 'turn/end', reason: 'done' })
    const chunks = await done
    assert.ok(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.text?.startsWith('[Nodo] Agent 未在时限内确认插入的消息')))
    await collect(h.pump.stream({ messages: [h.first, followup] }))
    assert.deepEqual(h.calls, [['send', 'original'], ['steer', 'maybe delivered']])
  } finally { h.pump.dispose() }
})

test('a claimed input waits for steering acknowledgement and queues once on refusal', async () => {
  let resolve
  const h = await harness(() => new Promise(done => { resolve = done }))
  try {
    const followup = message('race', 'claimed during RPC')
    h.insert(followup)
    await flush()
    h.agent.inbox.nextStep.length = 0
    const step = h.preStep([{ ...followup }])
    resolve('refused')
    assert.deepEqual((await step).messages, [])
    assert.deepEqual(h.agent.inbox.nextTurn, [followup])
  } finally { h.pump.dispose() }
})

test('cancellation discards pending steering without waking a queued task', async () => {
  let resolve
  const h = await harness(() => new Promise(done => { resolve = done }))
  try {
    const followup = message('cancel', 'cancel me')
    h.insert(followup)
    await flush()
    h.agent.inbox.remove(followup.id)
    resolve('refused')
    await flush()
    assert.deepEqual(h.agent.inbox.nextTurn, [])
  } finally { h.pump.dispose() }
})

test('multiple native inputs preserve order when the engine rejects or throws', async () => {
  let resolve
  const h = await harness(text => text === 'one' ? new Promise(done => { resolve = done }) : Promise.reject(new Error('engine refused')))
  try {
    const one = message('one', 'one')
    const two = message('two', 'two')
    h.insert(one)
    h.insert(two)
    await flush()
    assert.deepEqual(h.calls.filter(([kind]) => kind === 'steer'), [['steer', 'one']])
    resolve('refused')
    await flush()
    assert.deepEqual(h.agent.inbox.nextTurn, [one, two])
  } finally { h.pump.dispose() }
})

test('non-text steering stays in the native queue and runtime context is not forwarded', async () => {
  const h = await harness(() => 'steered')
  try {
    const image = message('image', 'look')
    image.content.push({ type: 'image', mediaType: 'image/png', data: 'fixture' })
    const context = message('context', 'runtime context', 'runtime-context')
    h.insert(image)
    h.insert(context)
    await flush()
    assert.deepEqual(h.agent.inbox.nextTurn, [image])
    assert.deepEqual(h.agent.inbox.nextStep, [context])
    assert.equal(h.calls.some(([kind]) => kind === 'steer'), false)
    assert.equal(newestUserPrompt([message('s', 'steering text', 'steering')]), 'steering text')
  } finally { h.pump.dispose() }
})

test('refused image steering announces the queue fallback in the flow', async () => {
  const h = await harness(() => 'steered')
  try {
    const image = message('image', 'look')
    image.content.push({ type: 'image', mediaType: 'image/png', data: 'fixture' })
    h.insert(image)
    await flush()
    assert.deepEqual(h.agent.inbox.nextTurn, [image])
    assert.equal(h.calls.some(([kind]) => kind === 'steer'), false)
    const done = collect(h.pump.stream({ messages: [h.first] }))
    await flush()
    h.pump.receive({ type: 'turn/end', reason: 'done' })
    const chunks = await done
    assert.ok(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text'
      && chunk.block.text === '[Nodo] 消息含图片，无法插入本轮，已转为排队。'))
  } finally { h.pump.dispose() }
})
