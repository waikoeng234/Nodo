import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPump } from '../src/host/adapter/pump.js'

const image = { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', name: 'shot.png' } }
const user = (id, content) => ({ id, role: 'user', source: { kind: 'user' }, content })
const text = text => ({ type: 'text', text })
const collect = async stream => { for await (const chunk of stream) {} }
const harness = () => {
  const calls = [], reads = []
  const attachments = {
    readImage: async (ref, signal) => { reads.push(ref); signal?.throwIfAborted(); return { ref, data: Uint8Array.of(1, 2, 3) } },
    imageHostPath: () => '/fixture/normalized.png',
  }
  const pump = createPump({ attachments, driver: { sendTurn: async (...input) => { calls.push(input); pump.receive({ type: 'turn/end', reason: 'done' }) } } })
  return { pump, calls, reads, attachments }
}

test('native images are resolved and relayed with text and session references, once per turn', async () => {
  const h = harness()
  const messages = [user('first', [text('look'), image]),
    { role: 'user', source: { kind: 'session-reference' }, content: [text('prior result')] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [text('do not forward')] }]
  await collect(h.pump.stream({ messages }))
  await collect(h.pump.stream({ messages }))
  assert.deepEqual(h.reads, [image.attachment])
  assert.deepEqual(h.calls, [['prior result\n\n# Current task\nlook', [{ mediaType: 'image/png', name: 'shot.png', data: 'AQID' }]]])
  messages.push(user('second', [image]))
  await collect(h.pump.stream({ messages }))
  assert.equal(h.calls[1][0], '')
  assert.deepEqual(h.calls[1][1], h.calls[0][1])
})

test('an image-only initial message never falls back to an earlier text task', async () => {
  const h = harness()
  await collect(h.pump.stream({ messages: [user('old', [text('old task')]), user('new', [image])] }))
  assert.equal(h.calls[0][0], '')
  assert.equal(h.calls[0][1].length, 1)
})

test('multiple queued inputs retain each image and host-projected file handle', async () => {
  const h = harness()
  const messages = [user('first', [text('first')])]
  await collect(h.pump.stream({ messages }))
  const file = '[File "report.pdf": verbatim read-only copy saved at "/fixture/report.pdf".]'
  messages.push(user('file', [text(file)]), user('image', [text('inspect'), image, image]))
  await collect(h.pump.stream({ messages }))
  assert.equal(h.calls[1][0], `${file}\n\ninspect`)
  assert.equal(h.calls[1][1].length, 2)
  assert.equal(h.reads.length, 2)
})

test('offloaded images retain a read path without reloading image bytes', async () => {
  const h = harness()
  await collect(h.pump.stream({ messages: [user('offloaded', [{ ...image, offloaded: true }])] }))
  assert.match(h.calls[0][0], /normalized.png/)
  assert.deepEqual(h.calls[0][1], [])
  assert.deepEqual(h.reads, [])
})

test('missing or broken attachment storage and unsupported blocks fail before sending', async () => {
  const h = harness()
  h.attachments.readImage = async () => { throw new Error('Attachment missing') }
  await assert.rejects(collect(h.pump.stream({ messages: [user('bad', [image])] })), /Attachment missing/)
  await assert.rejects(collect(h.pump.stream({ messages: [user('audio', [{ type: 'audio' }])] })), /Unsupported user content block: audio/)
  const pump = createPump({ driver: { sendTurn() { assert.fail('must not send') } } })
  await assert.rejects(collect(pump.stream({ messages: [user('image', [image])] })), /storage is unavailable/)
  assert.deepEqual(h.calls, [])
})

test('driver capability errors remain visible and failed inputs can be retried', async () => {
  let sends = 0
  const pump = createPump({ driver: { sendTurn: async () => { sends++; throw new Error('OpenCode does not accept images') } }, attachments: harness().attachments })
  const options = { messages: [user('image', [image])] }
  await assert.rejects(collect(pump.stream(options)), /OpenCode does not accept images/)
  await assert.rejects(collect(pump.stream(options)), /OpenCode does not accept images/)
  assert.equal(sends, 2)
  assert.equal(pump.active, false)
})

test('ordinary startup errors stay private even when they claim a capability error name', async () => {
  const pump = createPump({ driver: { sendTurn: async () => { throw Object.assign(new Error('private fixture diagnostic'), { name: 'UnsupportedCapabilityError' }) } } })
  try {
    await assert.rejects(collect(pump.stream({ messages: [user('task', [text('task')])] })), error => error.message === 'engine session failed to start')
    assert.equal(pump.active, false)
  } finally { pump.dispose() }
})

test('cancellation during attachment reads never sends a late engine turn', async () => {
  const h = harness()
  const controller = new AbortController()
  h.attachments.readImage = async ref => { controller.abort(new Error('cancelled')); return { ref, data: Uint8Array.of(1) } }
  await assert.rejects(collect(h.pump.stream({ messages: [user('image', [image])], signal: controller.signal })), /cancelled/)
  assert.deepEqual(h.calls, [])
  assert.equal(h.pump.active, false)
})

test('disposing the engine session ends a stream still waiting for engine events', async () => {
  const pump = createPump({ driver: { sendTurn: async () => {} } })
  const stream = collect(pump.stream({ messages: [user('task', [text('task')])] }))
  await new Promise(resolve => setImmediate(resolve))
  pump.dispose()
  await assert.rejects(stream, /engine session disposed/)
})
