import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAcpDriver } from '../agent-drivers/src/acp/core.js'
import { formElicitation } from '../agent-drivers/src/acp/elicitation.js'
import { jsonRpcProcess } from '../agent-drivers/src/json-rpc-process.js'
import { until } from './helpers/host.js'

const fixture = fileURLToPath(new URL('./fixtures/acp-cli.cjs', import.meta.url))
const withDriver = async (run, { env = {}, driverSessionId } = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-acp-core-'))
  const events = []
  const driver = createAcpDriver({ cwd, driverSessionId, onEvent: event => events.push(event) }, {
    id: 'fixture', label: 'Fixture', question: formElicitation,
    connect: callbacks => jsonRpcProcess({ bin: process.execPath, args: [fixture], cwd, env, jsonrpc: '2.0', ...callbacks }),
  })
  const wire = () => readFileSync(join(cwd, 'acp-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  try { await run({ driver, events, wire }) }
  finally { driver.dispose(); rmSync(cwd, { recursive: true, force: true }) }
}
const ended = events => events.find(event => event.type === 'turn/end')

test('ACP transport reaps an unresponsive owned process and settles pending work once', async () => {
  const ready = Promise.withResolvers()
  let closed = 0
  const peer = jsonRpcProcess({ bin: process.execPath, args: ['-e', `
    process.on('SIGTERM', () => {})
    process.stdin.resume()
    setInterval(() => {}, 1000)
    process.stdout.write(JSON.stringify({ method: 'ready', params: { pid: process.pid } }) + '\\n')
  `], onNotification: message => ready.resolve(message.params.pid), onClose: () => { closed++ } })
  const pid = await ready.promise
  const alive = () => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  try {
    const pending = peer.request('never-answered', {}, null)
    const rejected = assert.rejects(pending, /disposed/)
    peer.dispose()
    peer.dispose()
    await rejected
    await until(() => !alive(), 4000)
    assert.equal(closed, 1)
    await assert.rejects(peer.request('after-disposal'), /closed/)
  } finally { peer.dispose(); if (alive()) process.kill(pid, 'SIGKILL') }
})

test('ACP retains tool content alongside metadata and falls back to raw output when content is cleared', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('READ_OUTPUT')
    await until(() => ended(events))
    const tools = events.filter(event => event.type === 'tool' && event.phase === 'end')
    assert.deepEqual(tools[0].input, { path: '/tmp/fixture' })
    assert.equal(tools[0].output[0].content.text, 'actual file contents')
    assert.equal(tools[1].isError, true)
    assert.equal(tools[1].output[0].content.text, 'Error: tool call aborted')
    assert.deepEqual(tools[2].output, { result: 'raw only' })
  })
})

test('ACP sends pasted images only when the agent declares image prompts', async () => {
  const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
  await withDriver(async ({ driver }) => {
    await assert.rejects(driver.sendTurn('LOOK', [image]), /does not accept images/)
  })
  await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('LOOK', [image])
    await until(() => ended(events))
    assert.deepEqual(wire().find(message => message.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'LOOK' }, { type: 'image', mimeType: 'image/png', data: image.data }])
  }, { env: { ACP_IMAGES: '1' } })
})

test('ACP keeps media-bearing tool content and its accompanying rawOutput text', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('MEDIA')
    await until(() => ended(events))
    const result = events.find(event => event.type === 'tool' && event.phase === 'end' && event.callId === 'media')
    assert.deepEqual(result.output.map(block => block.content?.type ?? block.type), ['image', 'resource_link', 'text'])
    assert.equal(result.output[0].content.data, 'iVBORw0KGgo=')
    assert.equal(result.output[2].text, 'MEDIA_RAW_OUTPUT_DONE', 'a later rawOutput-only update keeps both the media and its text')
  })
})

test('ACP shares session flow, filters replay and keeps tool lifecycles isolated per turn', async () => {
  await withDriver(async ({ driver, events, wire }) => {
    for (const text of ['FIRST', 'SECOND']) {
      events.length = 0
      await driver.sendTurn(text)
      await until(() => ended(events))
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), `${text}\ntail`)
      assert.deepEqual(events.filter(event => event.type === 'tool').map(event => [event.name, event.phase]), [['Read', 'start'], ['Read', 'update'], ['Read', 'end']])
      const update = events.find(event => event.type === 'tool' && event.phase === 'update')
      assert.deepEqual(update.output, [{ type: 'content', content: { type: 'text', text: 'file contents' } }])
      const result = events.find(event => event.type === 'tool' && event.phase === 'end')
      assert.equal(result.callId, 'tool')
      assert.deepEqual(result.input, { path: '/tmp/fixture' })
      assert.deepEqual(result.output, [{ type: 'content', content: { type: 'text', text: 'file contents' } }])
      assert.deepEqual(ended(events).usage,
        { inputTokens: 1245, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30 },
        'ACP usage buckets are disjoint: inputTokens is already the uncached side')
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    }
    assert.equal(wire().filter(message => message.method === 'session/new').length, 1)
    assert.equal(wire().filter(message => message.method === 'session/prompt').length, 2)
  })
  for (const env of [{}, { ACP_RESUME: '1' }]) await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('RESUMED')
    await until(() => ended(events))
    assert.equal(events.find(event => event.state === 'ready').sessionId, 'saved-session')
    assert.ok(wire().some(message => message.method === (env.ACP_RESUME ? 'session/resume' : 'session/load')))
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'RESUMED\ntail')
  }, { env, driverSessionId: 'saved-session' })
})

test('ACP names the last message only when every text chunk carries a messageId', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('FIRST')
    assert.equal((await until(() => ended(events))).text, 'tail')
    events.length = 0
    await driver.sendTurn('UNBOUNDED')
    const end = await until(() => ended(events))
    assert.equal(end.text, undefined)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Progress Final')
  })
})

test('ACP refuses unsupported versions, unavailable resume and changed session identity before prompting', async () => {
  for (const [env, driverSessionId, error] of [
    [{ ACP_BAD_VERSION: '1' }, undefined, /protocol version/],
    [{ ACP_NO_RESUME: '1' }, 'saved-session', /cannot restore/],
    [{ ACP_WRONG_SESSION: '1' }, 'saved-session', /different session/],
  ]) await withDriver(async ({ driver, wire }) => {
    await assert.rejects(driver.sendTurn('NEVER SENT'), error)
    assert.equal(driver.hasSession(), false)
    assert.ok(!wire().some(message => message.method === 'session/prompt'))
    if (driverSessionId) assert.ok(!wire().some(message => message.method === 'session/new'))
  }, { env, driverSessionId })
})

test('ACP permissions preserve typed ids, reject other sessions and require an explicit allow kind', async () => {
  await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('PERMISSION')
    await until(() => events.filter(event => event.type === 'request/opened').length === 2)
    const cards = events.filter(event => event.type === 'request/opened')
    assert.notEqual(cards[0].id, cards[1].id)
    await assert.rejects(driver.respondToRequest(cards[0].id, { decision: 'allow' }), /did not offer/)
    assert.equal(await driver.respondToRequest(cards[0].id, { decision: 'allow', always: true }), true)
    assert.equal(await driver.respondToRequest(cards[1].id, { decision: 'deny' }), true)
    await until(() => ended(events))
    await until(() => wire().filter(message => !message.method && message.id === 7).length === 2)
    const numeric = wire().filter(message => !message.method && message.id === 7)
    assert.ok(numeric[0].error, 'a foreign session request gets an error')
    assert.equal(numeric[1].result.outcome.optionId, 'always')
    assert.equal(wire().find(message => !message.method && message.id === '7').result.outcome.optionId, 'reject')
    assert.equal(events.filter(event => event.type === 'request/closed').length, 2)
  })
})

test('ACP invalid form answers retain the request and interruption cancels it', async () => {
  await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('QUESTION')
    const card = await until(() => events.find(event => event.type === 'request/opened'))
    assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), false)
    await assert.rejects(driver.respondToRequest(card.id, { decision: 'answer', value: '' }), /Answer every/)
    assert.ok(!events.some(event => event.type === 'request/closed'))
    await driver.interruptTurn()
    assert.equal(ended(events).reason, 'interrupted')
    await until(() => wire().some(message => message.id === 9 && message.result?.action === 'cancel'))
    assert.equal(events.filter(event => event.type === 'request/closed').length, 1)
  })
})

test('ACP cancellation during startup and process death settle once and allow reconnection', async () => {
  await withDriver(async ({ driver, events }) => {
    const starting = driver.sendTurn('HANG')
    await driver.interruptTurn()
    await starting
    assert.equal(ended(events).reason, 'interrupted')
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    events.length = 0
    await driver.sendTurn('EXIT')
    await until(() => ended(events))
    assert.equal(ended(events).reason, 'error')
    events.length = 0
    await driver.sendTurn('RECOVERED')
    await until(() => ended(events))
    assert.equal(ended(events).reason, 'done')
  }, { env: { ACP_SLOW_BOOT: '1' } })
})

test('ACP ends done only on an explicit end_turn; limits, refusals and unknown stops are errors', async () => {
  for (const [text, stop, expected] of [
    ['STOP end_turn', 'end_turn', 'done'],
    ['STOP cancelled', 'cancelled', 'interrupted'],
    ['STOP max_tokens', 'max_tokens', 'error'],
    ['STOP max_turn_requests', 'max_turn_requests', 'error'],
    ['STOP refusal', 'refusal', 'error'],
    ['STOP mystery', 'mystery', 'error'],
    ['STOP', undefined, 'error'],
  ]) await withDriver(async ({ driver, events }) => {
    await driver.sendTurn(text)
    const end = await until(() => ended(events))
    assert.equal(end.reason, expected, stop)
    if (expected === 'error') assert.match(end.error, new RegExp(`stopped: ${stop ?? 'unknown reason'}`))
  })
})

test('ACP unanswered cancel closes only its connection and resumes on the next turn', async () => {
  await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('HANG')
    await driver.interruptTurn()
    assert.equal(ended(events).reason, 'interrupted')
    assert.equal(ended(events).unconfirmed, true)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    assert.equal(driver.hasSession(), false)
    events.length = 0
    await driver.sendTurn('RECOVERED')
    await until(() => ended(events))
    assert.equal(ended(events).reason, 'done')
    assert.ok(wire().some(message => message.method === 'session/load' && message.params.sessionId === 'acp-session'))
  }, { env: { ACP_IGNORE_CANCEL: '1' } })
})

test('ACP plans replace as snapshots and compaction plus retry statuses close themselves', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('PLAN')
    await until(() => ended(events))
    const plans = events.filter(event => event.type === 'plan')
    assert.deepEqual(plans.map(event => event.steps), [
      [{ text: 'step one', status: 'completed' }, { text: 'step two', status: 'in_progress' }],
      [{ text: 'step one', status: 'completed' }, { text: 'step two edited', status: 'in_progress' }],
      [],
    ], 'the removed plan clears the row instead of leaving stale steps')
    const lifecycle = events.filter(event => event.type === 'lifecycle')
    assert.deepEqual(lifecycle.map(event => [event.kind, event.phase, event.isError === true]),
      [['compaction', 'start', false], ['compaction', 'end', true], ['retry', 'start', false], ['retry', 'end', false]])
    assert.equal(lifecycle[0].entityId, 'c1')
    assert.equal(lifecycle[1].detail, 'compaction boom')
    assert.equal(lifecycle[2].detail, 'rate limited')
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
  })
})

test('media retains an opaque raw-output companion without guessing its fields', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('MEDIA_OPAQUE_OUTPUT')
    await until(() => ended(events))
    const result = events.find(event => event.type === 'tool' && event.phase === 'end')
    assert.deepEqual(result.output, [{ type: 'resource_link', uri: 'file:///fixture.png', mimeType: 'image/png' }, { stdout: 'opaque companion text' }])
  })
})

test('retry errors retain readable messages without stringifying unknown objects', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('RETRY_OBJECT')
    await until(() => ended(events))
    const statuses = events.filter(event => event.type === 'lifecycle')
    assert.deepEqual(statuses.map(event => event.detail), [undefined, 'wait for server', 'rate limited', undefined])
    assert.equal(ended(events).reason, 'done')
  })
})

test('OpenCode compaction channels distinguish cancelled from failed on both negotiated and degraded paths', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('COMPACT')
    await until(() => ended(events))
    const lifecycle = events.filter(event => event.type === 'lifecycle')
    // Negotiated compaction_update: in_progress → start, cancelled → a real
    // cancellation, not a success and not a failure.
    assert.deepEqual(lifecycle.slice(0, 2).map(event => [event.phase, event.isError === true, event.cancelled === true]),
      [['start', false, false], ['end', false, true]], 'a cancelled compaction is neither completed nor failed')
    // Degraded _meta channel: started/completed/failed, with the reducer's
    // aborted error type folded into failed meaning cancelled.
    assert.deepEqual(lifecycle.slice(2).map(event => [event.phase, event.isError === true, event.cancelled === true]),
      [['start', false, false], ['end', false, false], ['end', false, true], ['end', true, false]])
    assert.equal(lifecycle.at(-1).detail, 'disk full', 'a real failure keeps its message, not [object Object]')
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
  })
})

test('OpenCode child-session ownership becomes attributed activity instead of main-reply text', async () => {
  await withDriver(async ({ driver, events }) => {
    await driver.sendTurn('CHILD')
    await until(() => ended(events))
    const activity = events.filter(event => event.type === 'activity')
    assert.equal(activity[0].entityId, 'child-1')
    assert.equal(activity[0].phase, 'start')
    assert.equal(activity[0].title, 'Researcher')
    assert.equal(activity[0].detail, 'child says')
    assert.equal(activity[0].parentId, 'acp-session')
    assert.deepEqual(activity.slice(1).map(event => [event.entityId, event.phase, event.isError === true]),
      [['child-1/ct', 'start', false], ['child-1/ct', 'end', true]])
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'main',
      'child-owned chunks never fold into the main reply')
  })
})

test('ACP drops malformed fields from one message without closing the connection', async () => {
  await withDriver(async ({ driver, events, wire }) => {
    await driver.sendTurn('BAD_FIELDS')
    await until(() => ended(events))
    assert.equal(ended(events).reason, 'done')
    assert.equal(ended(events).text, 'still here')
    assert.ok(!events.some(event => event.type === 'session' && event.state === 'closed'))
    await until(() => wire().some(message => !message.method && message.id === 11))
    assert.ok(wire().find(message => !message.method && message.id === 11).error, 'a request with null params gets an error reply')
  })
})

test('ACP ends the turn when the CLI exits while a descendant still holds its stdout', async () => {
  await withDriver(async ({ driver, events }) => {
    const started = Date.now()
    await driver.sendTurn('ORPHAN')
    await until(() => ended(events))
    assert.equal(ended(events).reason, 'error')
    assert.match(ended(events).error, /CLI exited \(3\)/)
    assert.ok(Date.now() - started < 2500, 'exit is detected before the descendant releases stdout')
  })
})

test('ACP emits no turn after an interrupt that lands while the prompt hook is pending', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-acp-core-'))
  const events = []
  let release
  const driver = createAcpDriver({ cwd, onEvent: event => events.push(event) }, {
    id: 'fixture', label: 'Fixture', expandPrompt: text => new Promise(resolve => { release = () => resolve(text) }),
    connect: callbacks => jsonRpcProcess({ bin: process.execPath, args: [fixture], cwd, jsonrpc: '2.0', ...callbacks }),
  })
  try {
    await driver.openSession()
    const sending = driver.sendTurn('LATE')
    await until(() => release)
    await driver.interruptTurn()
    release()
    await sending
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!events.some(event => event.type === 'turn/start'), 'an ended turn never starts')
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
  } finally { driver.dispose(); rmSync(cwd, { recursive: true, force: true }) }
})

test('form elicitation honors required, integer and plain enum fields', () => {
  const form = formElicitation({ method: 'elicitation/create', params: { mode: 'form', requestedSchema: {
    properties: { count: { type: 'integer', title: 'Count?' }, size: { type: 'string', title: 'Size?', enum: ['s', 'm'], enumNames: ['Small', 'Medium'] }, note: { type: 'string', title: 'Note?' } },
    required: ['count', 'size'],
  } } })
  assert.deepEqual(form.card.detail.questions.map(question => [question.id, question.options.map(option => option.label), question.optional === true]),
    [['count', [], false], ['size', ['Small', 'Medium'], false], ['note', [], true]])
  assert.deepEqual(form.answer(JSON.stringify({ count: '3', size: 'Medium', note: '' })), { action: 'accept', content: { count: 3, size: 'm' } })
  assert.throws(() => form.answer(JSON.stringify({ count: '2.5', size: 's' })), /whole number/)
  assert.throws(() => form.answer(JSON.stringify({ count: '1', size: 'large' })), /Choose an option/)
  assert.throws(() => form.answer(JSON.stringify({ size: 's' })), /Answer every/)
})
