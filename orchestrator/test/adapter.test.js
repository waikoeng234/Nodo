import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { newestUserPrompt, createPump } from '../src/host/adapter/pump.js'
import { createRecordTracker } from '../src/host/stream-records.js'
import { install as installSessionMap } from '../src/host/adapter/session-map.js'
import { MIRROR_TOOL_NAME, registerMirrorTool } from '../src/host/adapter/mirror-tools.js'
import { install as installRegistry, enginePermission } from '../src/host/adapter/registry.js'
import { apply as applyPreset } from '../src/host/adapter/preset.js'
import { answerQuestions } from '../src/host/adapter/questions.js'
import { SESSION_LOG } from '../src/host/adapter/preset-heal.js'
import { install as installSecrets, redactDeep, redactor } from '../src/host/secrets.js'
import { install as installPrompt } from '../src/host/prompt.js'

// The fake driver emits its scripted events during sendTurn, matching the real
// drivers: nothing is queued before the pump starts the turn.
const scriptedPump = (script, options = {}) => {
  const calls = []
  let pump
  const driver = {
    calls,
    sendTurn: async text => { calls.push(['sendTurn', text]); script(text) },
    interruptTurn: async () => { calls.push(['interrupt']) },
    respondToRequest: (id, payload) => { calls.push(['respond', id, payload?.decision]) },
    dispose() { calls.push(['dispose']) },
  }
  pump = createPump({ driver, ...options })
  return { pump, calls }
}

const collect = async (stream, options) => {
  const chunks = []
  for await (const chunk of stream(options)) chunks.push(chunk)
  return chunks
}

const request = (text, signal) => ({
  provider: 'nodo:codex',
  model: 'fixture-model',
  sessionId: 'session-1',
  signal,
  messages: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime snapshot' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skill reminder' }] },
  ],
})

test('engine file actions use the native pending tool row with their actual names and inputs', () => {
  let tool
  registerMirrorTool({ tools: { register: value => { tool = value } } }, () => {})
  assert.deepEqual(tool.presentCall({ name: 'Read', input: '/tmp/a' }), { card: 'generic', title: 'Read', kind: 'read', rawInput: '/tmp/a' })
  assert.equal(tool.presentCall({ name: 'Write', brief: 'a.txt' }).title, 'Write: a.txt')
  assert.equal(tool.presentCall({ name: 'Write' }).kind, 'edit')
})

test('pump preserves tool details and waits for the matching concurrent call', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'start', input: { path: '/tmp/a' } })
    pump.receive({ type: 'tool', callId: 'b', name: 'Read', phase: 'start', input: { path: '/tmp/b' } })
    pump.receive({ type: 'tool', callId: 'b', name: 'Read', phase: 'end', output: 'B' })
  })
  const first = await collect(pump.stream, request('RUN'))
  const call = first.find(chunk => chunk.type === 'block-end').block
  assert.equal(JSON.parse(call.arguments).input, '{\n  "path": "/tmp/a"\n}')
  const claim = pump.takeMirror()
  let settled = false
  claim.done.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'the other Read result must not settle this call')
  pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'end', output: [{ type: 'content', content: { type: 'text', text: 'A' } }] })
  assert.deepEqual(await claim.done, { status: 'done', detail: 'A' })
  const second = await collect(pump.stream, request('RUN'))
  assert.notEqual(second.find(chunk => chunk.block?.type === 'tool-call').block.id, call.id, 'native replay must distinguish mirror calls across stream boundaries')
  assert.deepEqual(await pump.takeMirror().done, { status: 'done', detail: 'B' })
  pump.dispose()
})

test('pump includes final tool arguments when streaming began with a placeholder', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'start', input: {} })
    pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'end', input: { path: '/tmp/a' }, output: 'file contents' })
    pump.receive({ type: 'turn/end', reason: 'done' })
  })
  await collect(pump.stream, request('RUN'))
  assert.deepEqual(await pump.takeMirror().done, { status: 'done', detail: '输入:\n{\n  "path": "/tmp/a"\n}\n\n输出:\nfile contents' })
  pump.dispose()
})

test('newestUserPrompt relays only the newest human message', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'snapshot' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skills' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second prompt' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'snapshot 2' }] },
  ]
  assert.equal(newestUserPrompt(messages), 'second prompt')
  assert.equal(newestUserPrompt([]), null)
  assert.equal(newestUserPrompt([{ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'x' }] }]), null)
})

test('pump splits a turn at the tool boundary and resumes after the mirror result', async () => {
  const { pump, calls } = scriptedPump(text => {
    if (text === 'NEXT') {
      pump.receive({ type: 'text', text: 'next reply' })
      pump.receive({ type: 'turn/end', turnId: 't2', reason: 'done' })
      return
    }
    pump.receive({ type: 'delta', text: 'hello ' })
    pump.receive({ type: 'text', text: 'world' })
    pump.receive({ type: 'thinking', text: 'deep thought' })
    pump.receive({ type: 'tool', name: 'commandExecution', phase: 'start', brief: 'echo one' })
  })
  const first = await collect(pump.stream, request('RUN'))
  assert.deepEqual(calls[0], ['sendTurn', 'RUN'])
  assert.deepEqual(first.map(chunk => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'block-start', 'reasoning-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'finish'])
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  assert.equal(call.name, MIRROR_TOOL_NAME)
  assert.deepEqual(JSON.parse(call.arguments), { kind: 'tool', name: 'commandExecution', brief: 'echo one' })

  // The engine may finish the item before the host executes the mirror tool.
  pump.receive({ type: 'tool', name: 'commandExecution', phase: 'end', brief: 'echo one' })
  const claim = pump.takeMirror()
  assert.ok(claim)
  assert.equal((await claim.done).status, 'done')

  pump.receive({ type: 'text', text: 'all finished' })
  pump.receive({ type: 'turn/end', turnId: 't1', reason: 'done', usage: { inputTokens: 300, outputTokens: 45, cacheReadTokens: 900 } })
  const second = await collect(pump.stream, request('RUN'))
  assert.equal(calls.length, 1, 'no second sendTurn inside one engine turn')
  assert.deepEqual(second.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(second.find(chunk => chunk.type === 'usage').usage, { inputTokens: 300, outputTokens: 45, cacheReadTokens: 900 })
  assert.equal(second.at(-1).reason.kind, 'stop')

  const third = await collect(pump.stream, request('NEXT'))
  assert.deepEqual(calls[1], ['sendTurn', 'NEXT'])
  assert.equal(third.at(-1).reason.kind, 'stop')
})

test('pump relays an approval ask and answers the engine after the native card', async () => {
  const { pump, calls } = scriptedPump(() => {
    pump.receive({ type: 'request/opened', id: 'codex:t:9:9', kind: 'permission', tool: 'commandExecution', reason: 'echo fixture-ask', detail: { command: 'echo fixture-ask' } })
  })
  const chunks = await collect(pump.stream, request('ASK'))
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  assert.deepEqual(JSON.parse(block.arguments), { kind: 'approval', name: 'commandExecution', brief: 'echo fixture-ask' })

  const claim = pump.takeMirror()
  pump.respondApproval(claim, 'allow')
  assert.deepEqual(calls.at(-1), ['respond', 'codex:t:9:9', 'allow'])
  pump.receive({ type: 'tool', name: 'commandExecution', phase: 'start', brief: 'echo fixture-ask' })
  pump.receive({ type: 'tool', name: 'commandExecution', phase: 'end', brief: 'echo fixture-ask' })
  assert.equal((await claim.done).status, 'done')
})

test('pump resolves a denied approval as denied when the engine interrupts', async () => {
  const { pump, calls } = scriptedPump(() => {
    pump.receive({ type: 'request/opened', id: 'codex:t:9:10', kind: 'permission', tool: 'commandExecution', reason: 'echo deny-me' })
  })
  await collect(pump.stream, request('ASK'))
  const claim = pump.takeMirror()
  pump.respondApproval(claim, 'deny')
  assert.deepEqual(calls.at(-1), ['respond', 'codex:t:9:10', 'deny'])
  pump.receive({ type: 'turn/end', turnId: 't', reason: 'interrupted' })
  assert.equal((await claim.done).status, 'denied')
  const next = await collect(pump.stream, request('ASK'))
  assert.deepEqual(next.map(chunk => chunk.type), ['finish'])
  assert.equal(next.at(-1).reason.kind, 'stop')
})

test('pump promotes a running mirror when approval arrives after item start', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', name: 'commandExecution', phase: 'start' })
  })
  await collect(pump.stream, request('RUN'))
  const claim = pump.takeMirror()
  pump.receive({ type: 'request/opened', kind: 'permission', id: 'late-approval' })
  assert.equal((await claim.requested).id, 'late-approval')
  pump.respondApproval(claim, 'allow')
  pump.receive({ type: 'tool', name: 'commandExecution', phase: 'end' })
  assert.equal((await claim.done).status, 'done')
  pump.receive({ type: 'turn/end', reason: 'done' })
  const rest = await collect(pump.stream, request('RUN'))
  assert.ok(!rest.some(chunk => chunk.blockType === 'tool-call'), 'the late request must not create a second unanswered mirror')
})

test('pump adopts an approval already queued behind item start', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', name: 'commandExecution', phase: 'start' })
    pump.receive({ type: 'request/opened', kind: 'permission', id: 'queued-approval' })
  })
  await collect(pump.stream, request('RUN'))
  assert.equal((await pump.takeMirror().requested).id, 'queued-approval')
})

test('pump forwards whatever token buckets a turn confirmed', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'text', text: 'partial figures' })
    pump.receive({ type: 'turn/end', turnId: 't', reason: 'done', usage: { outputTokens: 45, cacheReadTokens: 12 } })
  })
  const chunks = await collect(pump.stream, request('RUN'))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { outputTokens: 45, cacheReadTokens: 12 })
  pump.dispose()
})

test('a multi-call turn reports its prompt side as the engine context, keeping the cache share', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'turn/end', turnId: 't', reason: 'done', usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 0, contextUsed: 2000 } })
  })
  const chunks = await collect(pump.stream, request('RUN'))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 1800, cacheWriteTokens: 0 })
  pump.dispose()
})

test('pump sends no native usage chunk for a context-only report', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'turn/end', turnId: 't', reason: 'done', usage: { contextUsed: 500, contextSize: 8000 } })
  })
  const chunks = await collect(pump.stream, request('RUN'))
  assert.ok(!chunks.some(chunk => chunk.type === 'usage'), 'context has no field in the host usage shape')
  pump.dispose()
})

test('a failed turn hands its usage over before the stream fails', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'turn/end', turnId: 't', reason: 'error', error: 'boom', usage: { inputTokens: 10, outputTokens: 3 } })
  })
  const chunks = []
  await assert.rejects(async () => { for await (const chunk of pump.stream(request('RUN'))) chunks.push(chunk) }, /boom/)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 10, outputTokens: 3 })
})

test('pump settles back-to-back items whose ends queue across boundaries', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', name: 'c', phase: 'start', brief: 'one' })
    pump.receive({ type: 'tool', name: 'c', phase: 'end', brief: 'one' })
    pump.receive({ type: 'tool', name: 'c', phase: 'start', brief: 'two' })
    pump.receive({ type: 'tool', name: 'c', phase: 'end', brief: 'two' })
    setTimeout(() => {
      pump.receive({ type: 'turn/end', turnId: 't', reason: 'done', usage: { inputTokens: 1, outputTokens: 2 } })
    }, 5)
  })
  const first = await collect(pump.stream, request('RUN'))
  const one = pump.takeMirror()
  assert.equal((await one.done).status, 'done')
  const second = await collect(pump.stream, request('RUN'))
  assert.equal(second.at(-1).reason.kind, 'tool-calls', 'the second command must open its own boundary')
  const two = pump.takeMirror()
  const timer = setTimeout(() => { throw new Error('the second mirror never settled') }, 2000)
  assert.equal((await two.done).status, 'done')
  clearTimeout(timer)
  const third = await collect(pump.stream, request('RUN'))
  assert.deepEqual(third.map(chunk => chunk.type), ['usage', 'finish'])
})

test('buffered tool updates cannot hide the completed result behind a native boundary', async () => {
  for (const endBeforeConsume of [false, true]) {
    const { pump } = scriptedPump(() => {
      for (const id of ['a', 'b']) {
        pump.receive({ type: 'tool', callId: id, name: 'read', phase: 'start', input: {} })
        pump.receive({ type: 'tool', callId: id, name: 'read', phase: 'update', input: { path: `/tmp/${id}` } })
        pump.receive({ type: 'tool', callId: id, name: 'read', phase: 'end', input: { path: `/tmp/${id}` }, output: `contents ${id}` })
      }
      if (endBeforeConsume) pump.receive({ type: 'turn/end', reason: 'done' })
    })
    try {
      for (const id of ['a', 'b']) {
        await collect(pump.stream, request('READ'))
        if (id === 'a' && !endBeforeConsume) pump.receive({ type: 'turn/end', reason: 'done' })
        const claim = pump.takeMirror()
        assert.equal(claim.settled, true, 'a queued parameter update must not block the already queued result')
        assert.equal((await claim.done).status, 'done')
        assert.match((await claim.done).detail, new RegExp(`contents ${id}`))
      }
      const tail = await collect(pump.stream, request('READ'))
      assert.equal(tail.at(-1).reason.kind, 'stop')
    } finally { pump.dispose() }
  }
})

test('a turn ending done never upgrades a tool without its own end into a success', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', name: 'c', phase: 'start', brief: 'one' })
  })
  await collect(pump.stream, request('RUN'))
  const claim = pump.takeMirror()
  pump.receive({ type: 'turn/end', turnId: 't', reason: 'done', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.deepEqual(await claim.done, { status: 'error', detail: 'Agent 已结束本轮，但未回报该操作的执行结果' })
  pump.dispose()
})

test('an approved action the engine never starts does not count as done either', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'request/opened', id: 'ask', kind: 'permission', tool: 'Bash', reason: 'allow me' })
  })
  await collect(pump.stream, request('ASK'))
  const claim = pump.takeMirror()
  await pump.respondApproval(claim, 'allow')
  pump.receive({ type: 'turn/end', reason: 'done' })
  assert.equal((await claim.done).status, 'error')
  pump.dispose()
})

test('pump aborts with the request signal and interrupts the engine', async () => {
  const controller = new AbortController()
  const { pump, calls } = scriptedPump(() => {
    pump.receive({ type: 'delta', text: 'partial' })
  })
  const stream = pump.stream(request('HANG', controller.signal))
  assert.equal((await stream.next()).value.type, 'block-start')
  assert.equal((await stream.next()).value.type, 'text-delta')
  const rest = stream.next()
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(() => rest)
  assert.ok(calls.some(call => call[0] === 'interrupt'))
  assert.equal(pump.active, false)
})

test('pump answers auxiliary requests without touching the engine', async () => {
  const { pump, calls } = scriptedPump(() => {})
  const title = await collect(pump.stream, { purpose: 'session-title', messages: request('name my session').messages })
  assert.equal(title.at(-1).reason.kind, 'stop')
  const text = title.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'name my session')
  assert.equal(calls.length, 0)
  await assert.rejects(() => collect(pump.stream, { purpose: 'compaction', messages: [] }), /not relayed/)
})

test('a turn that ends without a consumer leaves the pump idle, so the next message reaches the engine', async () => {
  const { pump, calls } = scriptedPump(text => {
    if (text !== 'RUN') { pump.receive({ type: 'turn/end', turnId: 't2', reason: 'done' }); return }
    pump.receive({ type: 'delta', text: 'stalled' })
    pump.receive({ type: 'request/opened', id: 'stuck', kind: 'permission', tool: 'Bash', reason: 'needs allow' })
  })
  const chunks = await collect(pump.stream, request('RUN'))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const claim = pump.takeMirror()
  // The user stops the turn while the loop is away inside the mirror tool: no
  // stream() will come back to clear the flag in consume().
  pump.receive({ type: 'turn/end', turnId: 't1', reason: 'interrupted' })
  assert.equal((await claim.done).status, 'interrupted')
  assert.equal(pump.active, false, 'idleness must not wait for a consumer that never returns')
  const next = await collect(pump.stream, request('CONTINUE'))
  assert.deepEqual(calls[1], ['sendTurn', 'CONTINUE'], 'a fresh message must open a new engine turn, not replay the dead one')
  assert.equal(next.at(-1).reason.kind, 'stop')
})

test('a turn that ends between mirror steps relays its queued tail on the next stream', async () => {
  const { pump, calls } = scriptedPump(() => {
    pump.receive({ type: 'tool', name: 'c', phase: 'start', brief: 'one' })
  })
  await collect(pump.stream, request('RUN'))
  const claim = pump.takeMirror()
  pump.receive({ type: 'tool', name: 'c', phase: 'end', brief: 'one' })
  pump.receive({ type: 'text', text: 'final words' })
  pump.receive({ type: 'turn/end', turnId: 't1', reason: 'done', usage: { inputTokens: 7, outputTokens: 8 } })
  assert.equal(pump.active, false)
  const chunks = await collect(pump.stream, request('RUN'))
  assert.equal(calls.length, 1, 'the continuation must not open a duplicate engine turn')
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal((await claim.done).status, 'done')
})

test('an error between mirror steps reaches the native loop on continuation', async () => {
  const { pump } = scriptedPump(() => pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'start' }))
  await collect(pump.stream, request('RUN'))
  const claim = pump.takeMirror()
  pump.receive({ type: 'turn/end', reason: 'error', error: 'connection lost' })
  assert.deepEqual(await claim.done, { status: 'error', detail: 'connection lost' })
  await assert.rejects(collect(pump.stream, request('RUN')), /connection lost/)
  pump.dispose()
})

test('watchRequestClose fires when the engine settles an ask behind the card', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'request/opened', id: 'ask-1', kind: 'permission', tool: 'Bash', reason: 'gone' })
  })
  await collect(pump.stream, request('ASK'))
  const claim = pump.takeMirror()
  const closed = Promise.withResolvers()
  const unwatch = pump.watchRequestClose(claim.approvalId, () => closed.resolve())
  pump.receive({ type: 'request/closed', id: 'ask-1' })
  await closed.promise
  unwatch()
  pump.receive({ type: 'request/closed', id: 'ask-1' })
  assert.equal(claim.settled, false, 'the watcher only informs; the claim still waits for the engine outcome')
  pump.receive({ type: 'turn/end', reason: 'done' })
  assert.equal((await claim.done).status, 'done')
})

test('a silent running turn ends cleanly and stays out of the text feed', async () => {
  const { pump } = scriptedPump(() => {
    setTimeout(() => pump.receive({ type: 'turn/end', turnId: 't', reason: 'done' }), 60)
  })
  const chunks = await collect(pump.stream, request('SLOW'))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 0, 'silence rides the running dock, never the feed')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('engine health remains observable while the native host waits inside a tool boundary', async () => {
  const { pump } = scriptedPump(() => {
    pump.receive({ type: 'tool', callId: 'read', name: 'read', phase: 'start', input: {} })
  })
  try {
    assert.equal(pump.status, null)
    await collect(pump.stream, request('READ'))
    const claim = pump.takeMirror()
    assert.equal(pump.status.phase, 'tool')
    assert.equal(pump.status.tool, 'read')
    assert.ok(Number.isFinite(pump.status.lastEventAt))
    pump.receive({ type: 'request/opened', id: 'ask', kind: 'permission' })
    assert.equal(pump.status.phase, 'waiting-approval')
    pump.receive({ type: 'request/closed', id: 'ask' })
    assert.equal(pump.status.phase, 'tool')
    pump.receive({ type: 'tool', callId: 'read', phase: 'end', output: 'contents' })
    await claim.done
    pump.receive({ type: 'thinking', text: 'next' })
    assert.equal(pump.status.phase, 'thinking')
    pump.receive({ type: 'turn/end', reason: 'done' })
    assert.equal(pump.status, null)
  } finally { pump.dispose() }
})

test('session map persists native sessions to engine threads across reload', () => {
  const state = { version: 2 }
  const rt = { state, save: async () => {} }
  installSessionMap(rt)
  assert.equal(rt.adapterMap.of('s1'), null)
  rt.adapterMap.set('s1', 'fixture-thread')
  rt.adapterMap.set('s2', 'thread-two')
  rt.adapterMap.drop('s2')

  const reloaded = { state: JSON.parse(JSON.stringify(state)) }
  installSessionMap(reloaded)
  assert.equal(reloaded.adapterMap.of('s1').threadId, 'fixture-thread')
  assert.equal(reloaded.adapterMap.of('s2'), null)

  const broken = { state: { adapterSessions: 'garbage' } }
  installSessionMap(broken)
  assert.equal(broken.adapterMap.of('x'), null)
  assert.deepEqual(broken.state.adapterSessions, {})
})

test('native permission bundles map exactly and unknown approval policies fail closed', () => {
  for (const [sandbox, approval, expected] of [['read-only', 'ask', 'plan'], ['workspace-write', 'ask', 'workspace'], ['danger-full-access', 'never', 'full']]) {
    assert.equal(enginePermission({ current: () => 'selected', resolve: () => ({ sandbox, approval }) }, {}), expected)
  }
  for (const spec of [{ sandbox: 'workspace-write', approval: 'never' }, { sandbox: 'danger-full-access', approval: 'ask' }, { sandbox: 'unknown', approval: 'ask' }]) {
    assert.throws(() => enginePermission({ current: () => 'custom', resolve: () => spec }, {}), /no equivalent on this engine/)
  }
  // An engine without a tier refuses it even when the host preset maps cleanly.
  assert.throws(() => enginePermission({ current: () => 'full', resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }) }, {}, ['plan', 'workspace']), /no equivalent/)
})

test('preset restricts the live agent to the inherited mirror, preserving the preset tool', () => {
  let created, tool, command
  applyPreset({ tools: { register: value => { tool = value } }, commands: { register: value => { command = value } },
    on: (event, handler) => { assert.equal(event, 'agent/created'); created = handler }, nodoAdapter: {} })
  let restriction
  created({ agent: { ctx: { tools: { restrict: value => { restriction = value } } } } })
  assert.equal(tool.name, MIRROR_TOOL_NAME)
  assert.deepEqual(restriction, { allow: [MIRROR_TOOL_NAME] })
  assert.equal(command.name, 'compact')
  assert.equal(command.definitionId, '@deepseek-ai/dsh-command-compact', 'native compact controls discover the command by its public identity')
})

test('question bridge encodes all selected and custom answers for the engine SPI', async () => {
  const exec = { agent: {}, signal: new AbortController().signal }
  const ctx = { userQuestions: { ask: async input => ({
    answers: input.questions.filter(question => question.id !== 'missing').map(question => ({ id: question.id, ...(question.id === 'b' ? { custom: 'Typed answer' } : { selected: ['Blue'] }) })) }) } }
  const questions = [{ id: 'a', question: 'Color?' }, { id: 'b', question: 'Name?' }]
  assert.deepEqual(JSON.parse((await answerQuestions(ctx, { detail: { questions } }, exec)).value), { a: ['Blue'], b: ['Typed answer'] })
  assert.equal((await answerQuestions(ctx, { detail: { questions: questions.slice(1) } }, exec)).value, 'Typed answer')
  await assert.rejects(answerQuestions(ctx, { detail: { questions: [{ id: 'missing' }] } }, exec), /every engine question/)
  // A free-form ask without structured questions becomes one card built from prompt and choices.
  const freeform = await answerQuestions(ctx, { reason: 'Which path?', detail: { inputType: 'text', choices: ['src', { label: 'lib' }] } }, exec)
  assert.equal(freeform.value, 'Blue')
  await assert.rejects(answerQuestions(ctx, { detail: {} }, exec), /supplied no questions/)
})

const registryHarness = () => {
  let adapter, service
  const routes = new Map(['opencode', 'codex'].map(provider => [provider, { listModels: async () => [{ provider, id: 'native-model', name: 'Native model' }] }]))
  const drivers = []
  const sections = []
  const events = new Map()
  const agents = new Map([['session-1', { id: 'session-1', ctx: { systemPrompt: { section(section) {
    if (sections.some(item => item.name === section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
    sections.push(section)
    return () => { const at = sections.indexOf(section); if (at >= 0) sections.splice(at, 1) }
  } } }, session: {}, options: { model: 'fixture-model' }, status: 'idle' }]])
  let spec = { sandbox: 'workspace-write', approval: 'ask' }
  const rt = { state: {}, home: '/tmp/adapter-test', load: async () => {}, save: async () => {},
    secretEnv: () => ({}), secretStamp: () => '', conversationOf: () => null, enginePermissionModes: () => ['plan', 'workspace', 'full'],
    engineCatalogOf: () => ({ models: [{ id: 'fixture-model', thinking: [{ id: 'medium' }], defaultThinking: 'medium' }] }),
    ctx: { llm: {
      listProviders: () => [...routes.keys()].map(id => ({ id })),
      listModels: provider => routes.get(provider).listModels(provider),
      registerAdapter: (providers, value) => {
        adapter = value
        for (const provider of providers) { assert.equal(routes.has(provider), false, 'native provider routes must not be replaced'); routes.set(provider, value) }
        return () => { for (const provider of providers) routes.delete(provider) }
      },
    }, tools: { register() {} },
      agents: { get: id => agents.get(id) }, agentPresets: { composedPreset: () => 'role-preset' },
      permissionPresets: { current: () => 'current', resolve: () => spec },
      provide: (_name, value) => { service = value }, on: (name, listener) => events.set(name, listener), effect() {}, fiber: { await: async () => {} },
      approval: { request: async () => { throw new Error('unexpected native approval') } },
    },
    createEngineDriver: async (_engine, options) => {
      const driver = { options, disposed: false,
        sendTurn: async () => { options.onEvent({ type: 'session', sessionId: 'engine-thread' }); options.onEvent({ type: 'turn/end', reason: 'done' }) },
        compact: async () => {}, interruptTurn: async () => { options.onEvent({ type: 'turn/end', reason: 'interrupted' }) },
        dispose() { this.disposed = true },
      }
      drivers.push(driver)
      return driver
    },
  }
  installSessionMap(rt)
  rt.adapterMap.bind('session-1', { profileId: 'role', preset: 'role-preset', cwd: '/tmp/adapter-test', identity: 'Role identity', engine: 'codex', engineOptions: { bin: '/tmp/fixture' } })
  installRegistry(rt)
  return { rt, drivers, sections, events, get adapter() { return adapter }, get service() { return service }, setPermission: value => { spec = value } }
}

test('registry exposes per-session engine health across a pending native mirror execution', async () => {
  const h = registryHarness()
  const create = h.rt.createEngineDriver
  h.rt.createEngineDriver = async (engine, options) => {
    const driver = await create(engine, options)
    driver.sendTurn = async () => options.onEvent({ type: 'tool', callId: 'read', name: 'read', phase: 'start' })
    return driver
  }
  const chunks = await collect(h.adapter.stream.bind(h.adapter), request('READ'))
  assert.equal(h.rt.adapterWork('session-1').tool, 'read')
  assert.equal(h.rt.adapterWork('foreign'), null)
  const block = chunks.find(chunk => chunk.block?.type === 'tool-call').block
  const waiting = h.service.execute(JSON.parse(block.arguments), { agent: { id: 'session-1' } })
  assert.equal(h.rt.adapterWork('session-1').phase, 'tool')
  h.drivers[0].options.onEvent({ type: 'tool', callId: 'read', name: 'read', phase: 'end', output: 'contents' })
  assert.equal((await waiting).detail, 'contents')
  h.drivers[0].options.onEvent({ type: 'turn/end', reason: 'done' })
  assert.equal(h.rt.adapterWork('session-1'), null)
})

test('registry redacts reasoning and tool details before they reach native conversation blocks', async () => {
  const h = registryHarness()
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  h.rt.redactDeepSecrets = value => redactDeep(value, redact)
  const create = h.rt.createEngineDriver
  h.rt.createEngineDriver = async (engine, options) => {
    const driver = await create(engine, options)
    driver.sendTurn = async () => {
      options.onEvent({ type: 'thinking', text: 'fake-sensitive-fixture' })
      options.onEvent({ type: 'tool', name: 'Read', callId: 'a', phase: 'start', input: { path: 'fake-sensitive-fixture' } })
      options.onEvent({ type: 'tool', name: 'Read', callId: 'a', phase: 'end', output: 'fake-sensitive-fixture' })
      options.onEvent({ type: 'turn/end', reason: 'done' })
    }
    return driver
  }
  const chunks = await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.doesNotMatch(JSON.stringify(chunks), /fake-sensitive-fixture/)
  assert.equal(chunks.find(chunk => chunk.type === 'reasoning-delta').text, '[secret:FIXTURE]')
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  assert.match(JSON.parse(call.arguments).input, /\[secret:FIXTURE\]/)
  const result = await h.service.execute(JSON.parse(call.arguments), { agent: { id: 'session-1' } })
  assert.deepEqual(result, { status: 'done', detail: '[secret:FIXTURE]' })
})

test('registry propagates an identity edit to the binding, the persona section and the next driver', async () => {
  const h = registryHarness()
  const profile = { id: 'role', name: 'Rho', engine: 'codex', role: 'reviewer', instructions: 'be blunt', goal: '', env: [] }
  h.rt.sessionsOf = () => [{ id: 'conv-1', nativeSessionId: 'session-1', profileName: 'Rho', role: 'reviewer', instructions: 'be blunt', goal: '', env: [] }]
  h.rt.snapshotIdentity = (_profile, session) => { session.identityVersion = JSON.stringify([session.profileName, session.instructions]) }
  h.rt.renderIdentity = prepared => JSON.stringify([prepared.name, prepared.role, prepared.instructions])
  h.rt.prepareConversation = async () => ({ ...profile, name: profile.name })
  h.rt.adapterMap.bind('session-1', { persona: true })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.equal(h.drivers[0].options.instructions, 'Role identity')
  await h.rt.refreshAdapterBindings(profile)
  assert.match(h.rt.adapterMap.of('session-1').identity, /be blunt/)
  assert.equal(h.sections.length, 1)
  profile.instructions = 'be kinder'
  await h.rt.refreshAdapterBindings(profile)
  const identity = h.rt.adapterMap.of('session-1').identity
  assert.match(identity, /be kinder/)
  assert.deepEqual(h.sections.map(section => section.text), [identity])
  await collect(h.adapter.stream.bind(h.adapter), request('NEXT'))
  assert.equal(h.drivers[0].disposed, true)
  assert.equal(h.drivers[1].options.instructions, identity)
  assert.equal(h.drivers[1].options.driverSessionId, 'engine-thread')
})

test('registry leaves the identity snapshots of non-adapter roles alone', async () => {
  const h = registryHarness()
  const session = { id: 'conv-1', briefSent: true, profileName: 'Rho', role: '', instructions: 'old rules', goal: '' }
  h.rt.sessionsOf = () => [session]
  h.rt.snapshotIdentity = () => {}
  await h.rt.refreshAdapterBindings({ id: 'role', name: 'Rho', engine: 'dsh', role: '', instructions: 'new rules', goal: '' })
  assert.equal(session.instructions, 'old rules')
})

test('a key change rewrites the brief of the roles its scope reaches and the next driver gets the same keys', async () => {
  const h = registryHarness()
  const home = mkdtempSync(join(tmpdir(), 'orch-secret-brief-'))
  try {
    const profile = { id: 'role', name: 'Rho', engine: 'codex', role: '', instructions: '', goal: '' }
    h.rt.state.profiles = { role: profile, other: { id: 'other', name: 'Other', engine: 'codex', role: '', sessions: [] } }
    Object.assign(h.rt, { home, readOnly: () => undefined, warn() {} })
    h.rt.sessionsOf = item => item === profile ? [{ id: 'conv-1', nativeSessionId: 'session-1' }] : []
    h.rt.snapshotIdentity = () => {}
    h.rt.prepareConversation = async () => ({ ...profile, profileId: 'role' })
    installPrompt(h.rt)
    installSecrets(h.rt)
    await h.rt.secretSet({ name: 'API_TOKEN', value: 'fixture-token', purpose: 'call the API', scope: ['role'] })
    assert.match(h.rt.adapterMap.of('session-1').identity, /\$ORCH_SECRET_API_TOKEN \(call the API\)/)
    await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
    assert.deepEqual(h.drivers[0].options.env, { ORCH_SECRET_API_TOKEN: 'fixture-token' })
    await h.rt.secretSet({ name: 'API_TOKEN', scope: ['other'] })
    assert.doesNotMatch(h.rt.adapterMap.of('session-1').identity, /ORCH_SECRET_API_TOKEN/)
    await collect(h.adapter.stream.bind(h.adapter), request('NEXT'))
    assert.equal(h.drivers[0].disposed, true)
    assert.deepEqual(h.drivers[1].options.env, {})
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('registry keeps identity in the engine channel and resumes the mapped thread when native permission changes', async () => {
  const h = registryHarness()
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.equal(h.drivers[0].options.permission, 'workspace')
  assert.equal(h.drivers[0].options.instructions, 'Role identity')
  h.setPermission({ sandbox: 'danger-full-access', approval: 'never' })
  await collect(h.adapter.stream.bind(h.adapter), request('NEXT'))
  assert.equal(h.drivers[0].disposed, true)
  assert.equal(h.drivers[1].options.permission, 'full')
  assert.equal(h.drivers[1].options.driverSessionId, 'engine-thread')
  await assert.rejects(collect(h.adapter.stream.bind(h.adapter), { ...request('RUN'), sessionId: 'unbound' }), /Open a role/)
})

test('registry drives the bound engine and refuses tiers that engine does not offer', async () => {
  const h = registryHarness()
  h.rt.adapterMap.bind('session-1', { profileId: 'role', preset: 'role-preset', cwd: '/tmp/adapter-test', identity: 'Role identity', engine: 'opencode', engineOptions: {} })
  h.rt.enginePermissionModes = engine => engine === 'opencode' ? ['plan', 'workspace'] : ['plan', 'workspace', 'full']
  await collect(h.adapter.stream.bind(h.adapter), { ...request('RUN'), provider: 'nodo:opencode' })
  assert.equal(h.drivers[0].options.permission, 'workspace')
  h.rt.createEngineDriver = async () => { throw new Error('a driver must never be built for a missing tier') }
  h.setPermission({ sandbox: 'danger-full-access', approval: 'never' })
  await assert.rejects(collect(h.adapter.stream.bind(h.adapter), { ...request('RUN'), provider: 'nodo:opencode' }), /no equivalent on this engine/)
})

test('registry handles session titles without creating an external driver', async () => {
  const h = registryHarness()
  const chunks = await collect(h.adapter.stream.bind(h.adapter), { ...request('A title'), purpose: 'session-title' })
  assert.ok(chunks.some(chunk => chunk.text === 'A title'))
  assert.equal(h.drivers.length, 0)
})

test('a foreign model provider is refused before any engine is built', async () => {
  const h = registryHarness()
  await assert.rejects(collect(h.adapter.stream.bind(h.adapter), { ...request('RUN'), provider: 'opencode', model: 'foreign-model' }),
    /pick models from the Codex group/)
  assert.equal(h.drivers.length, 0)
  await collect(h.adapter.stream.bind(h.adapter), { ...request('RUN'), provider: 'nodo:codex' })
  assert.equal(h.drivers.length, 1)
})

test('opening a role never moves the deployment default', async () => {
  const h = registryHarness()
  h.rt.ctx.agentPresets.register = async () => () => {}
  let defaultSelection = { provider: 'deepseek-account', model: 'default-model' }
  h.rt.ctx.agentDefaultModel = {
    currentSelection: () => ({ ...defaultSelection }),
    saveSelection: async next => { defaultSelection = { ...next } },
  }
  const selections = []
  h.rt.ctx.sessionController = {
    create: async () => ({ sessionId: 'session-9' }),
    rename: async () => {},
    resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }),
    selectModel: async request => { selections.push(request); defaultSelection = { provider: request.provider, model: request.model }; return { selected: defaultSelection } },
  }
  h.rt.ctx.workspaceRegistry = { resolveByPath: async () => ({ id: 'ws' }) }
  h.rt.findProfile = () => h.rt.state.profiles.role
  h.rt.renderIdentity = () => 'Role identity'
  h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [] } }
  h.rt.createSession = async () => ({ id: 'conv-9', name: 'Session 1' })
  h.rt.prepareConversation = async () => ({ engine: 'codex', cwd: '/tmp/adapter-test', name: 'Rho', model: undefined, thinking: undefined, engineOptions: {} })
  const opened = await h.rt.openAdapterSession({ profile: 'role' })
  assert.equal(opened.sessionId, 'session-9')
  assert.deepEqual(selections, [{ sessionId: 'session-9', provider: 'nodo:codex', model: 'fixture-model' }])
  assert.deepEqual(defaultSelection, { provider: 'deepseek-account', model: 'default-model' },
    'a role model must never become the deployment default')
})

test('a dispatched conversation gets its native session without becoming the selected one', async () => {
  const h = registryHarness()
  h.rt.ctx.agentPresets.register = async () => () => {}
  const created = []
  h.rt.ctx.sessionController = {
    create: async request => { created.push(request); return { sessionId: 'session-1' } },
    rename: async () => {},
    resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }),
    selectModel: async request => ({ selected: { provider: request.provider, model: request.model } }),
  }
  h.rt.ctx.workspaceRegistry = { resolveByPath: async () => ({ id: 'ws' }) }
  h.rt.renderIdentity = () => 'Workflow role identity'
  const profile = { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [] }, session = { id: 'conv-wf', name: 'crd · 执行任务' }
  h.rt.conversationOf = id => id === 'conv-wf' ? { profile, session } : null
  h.rt.selectSession = async () => { throw new Error('a workflow step must not move the role selection') }
  h.rt.prepareConversation = async () => ({ engine: 'codex', cwd: '/tmp/adapter-test', name: 'Rho', model: undefined, thinking: undefined, engineOptions: {} })
  assert.equal(await h.rt.adapterSessionOf('conv-wf'), 'session-1')
  assert.deepEqual(created, [{ workspaceId: 'ws', agentPreset: 'nodo:codex:role' }])
  assert.equal(session.nativeSessionId, 'session-1')
  assert.equal(h.sections.at(-1).text, 'Workflow role identity', 'the role identity rides the native system prompt')
  assert.equal(await h.rt.adapterSessionOf('conv-wf'), 'session-1', 'a second turn reuses the same native session')
  assert.equal(created.length, 1)
})

test('codebuddy opens the adapter route under its own provider group', async () => {
  const h = registryHarness()
  h.rt.ctx.agentPresets.register = async () => () => {}
  const selections = []
  h.rt.ctx.sessionController = {
    create: async () => ({ sessionId: 'session-9' }),
    rename: async () => {},
    resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }),
    selectModel: async request => { selections.push(request); return { selected: { provider: request.provider, model: request.model } } },
  }
  h.rt.ctx.workspaceRegistry = { resolveByPath: async () => ({ id: 'ws' }) }
  h.rt.findProfile = () => h.rt.state.profiles.role
  h.rt.renderIdentity = () => 'Role identity'
  h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codebuddy', role: '', sessions: [] } }
  h.rt.createSession = async () => ({ id: 'conv-9', name: 'Session 1' })
  h.rt.prepareConversation = async () => ({ engine: 'codebuddy', cwd: '/tmp/adapter-test', name: 'Rho', engineOptions: {} })
  const opened = await h.rt.openAdapterSession({ profile: 'role' })
  assert.equal(opened.sessionId, 'session-9')
  assert.deepEqual(selections, [{ sessionId: 'session-9', provider: 'nodo:codebuddy', model: 'fixture-model' }])
  assert.equal(h.adapter.providerInfo('nodo:codebuddy').name, 'Nodo·CodeBuddy')
})

test('private model selection never exposes engine catalogs to concurrent native reads', async () => {
  const h = registryHarness()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const selected = { provider: 'nodo:codex', model: 'fixture-model', reasoningEffort: 'medium' }
  h.rt.ctx.sessionController = { resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }), selectModel: async request => {
    assert.deepEqual((await h.rt.ctx.llm.listModels(request.provider)).map(item => item.id), ['fixture-model'])
    entered.resolve()
    await release.promise
    return { selected }
  } }
  const publicGroups = async () => (await Promise.all(h.rt.ctx.llm.listProviders().map(async ({ id }) => ({ id, models: await h.rt.ctx.llm.listModels(id) })))).filter(group => group.models.length)
  assert.deepEqual((await publicGroups()).map(group => group.id), ['opencode', 'codex'], 'genuine native providers with engine-like names stay available')
  const pending = h.rt.selectAdapterModel({ sessionId: 'session-1', ...selected })
  await entered.promise
  assert.deepEqual((await publicGroups()).map(group => group.id), ['opencode', 'codex'], 'a simultaneous native catalog read must not inherit the private selection context')
  release.resolve()
  const catalog = await pending
  assert.deepEqual(catalog.current, selected)
  assert.deepEqual(catalog.groups.map(group => group.id), ['nodo:codex'])
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'medium')
  assert.deepEqual(await h.adapter.listModels('nodo:codex'), [], 'the catalog remains private after selection completes')
  assert.equal(await h.rt.adapterModels({ sessionId: 'ordinary-session' }), null)
  await assert.rejects(h.rt.selectAdapterModel({ sessionId: 'ordinary-session', ...selected }), /this Nodo role/)
  await assert.rejects(h.rt.selectAdapterModel({ sessionId: 'session-1', ...selected, provider: 'nodo:claude' }), /this Nodo role/)
  await assert.rejects(h.rt.selectAdapterModel({ sessionId: 'session-1', ...selected, model: 'missing-model' }), /does not offer/)
})

test('a model pick is written back to the conversation for the next one to inherit', async () => {
  const h = registryHarness()
  const conversation = {}
  h.rt.conversationOf = () => ({ session: conversation })
  h.rt.ctx.sessionController = { resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }),
    selectModel: async request => ({ selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } }) }
  await h.rt.selectAdapterModel({ sessionId: 'session-1', provider: 'nodo:codex', model: 'fixture-model', reasoningEffort: 'medium' })
  assert.equal(conversation.model, 'fixture-model')
  assert.equal(conversation.thinking, 'medium')
  await h.rt.selectAdapterModel({ sessionId: 'session-1', provider: 'nodo:codex', model: 'fixture-model' })
  assert.equal(conversation.thinking, undefined, 'picking the model default unpins the level')
})

test('the permission tier each turn runs under is remembered on the conversation', async () => {
  const h = registryHarness()
  const conversation = {}
  h.rt.conversationOf = () => ({ session: conversation })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.equal(conversation.permission, 'workspace')
  h.setPermission({ sandbox: 'danger-full-access', approval: 'never' })
  await collect(h.adapter.stream.bind(h.adapter), request('NEXT'))
  assert.equal(conversation.permission, 'full')
})

test('opening a conversation applies the permission tier the conversation remembered', async () => {
  const h = registryHarness()
  const applied = []
  const conversation = { id: 'conv-9', name: 'Session 1', permission: 'plan' }
  h.rt.ctx.agentPresets.register = async () => () => {}
  h.rt.ctx.permissionPresets = { names: ['plan-preset'], resolve: () => ({ sandbox: 'read-only', approval: 'ask' }),
    current: () => 'plan-preset', set: (session, name) => applied.push(name) }
  h.rt.ctx.sessionController = {
    create: async () => ({ sessionId: 'session-9' }),
    rename: async () => {},
    resolveAgent: async () => ({ agent: h.rt.ctx.agents.get('session-1') }),
    selectModel: async request => ({ selected: { provider: request.provider, model: request.model } }),
  }
  h.rt.ctx.workspaceRegistry = { resolveByPath: async () => undefined, create: async () => ({ id: 'ws' }) }
  h.rt.findProfile = () => h.rt.state.profiles.role
  h.rt.renderIdentity = () => 'Role identity'
  h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [conversation] } }
  h.rt.createSession = async () => conversation
  h.rt.prepareConversation = async () => ({ engine: 'codex', cwd: '/tmp/adapter-test', name: 'Rho', model: 'fixture-model', thinking: undefined, engineOptions: {}, permission: 'plan' })
  h.rt.conversationOf = () => ({ session: conversation })
  const opened = await h.rt.openAdapterSession({ profile: 'role' })
  assert.equal(opened.conversationId, 'conv-9')
  assert.deepEqual(applied, ['plan-preset'], 'the remembered tier is applied, not the card default')
  assert.equal(conversation.nativeReady, true)
})

test('cold role restoration adopts the private route without changing the engine model or effort', async () => {
  const h = registryHarness()
  const agent = h.rt.ctx.agents.get('session-1')
  agent.session.snapshotEvents = () => [{ type: 'model/selection', data: { provider: 'codex', model: 'fixture-model', reasoningEffort: 'medium' } }]
  const selected = []
  h.rt.ctx.sessionController = {
    resolveAgent: async () => ({ agent }),
    selectModel: async request => { const { sessionId, ...selection } = request; selected.push(selection); return { selected: selection } },
  }
  await h.events.get('agent/created')({ agent })
  assert.deepEqual(selected, [{ provider: 'nodo:codex', model: 'fixture-model', reasoningEffort: 'medium' }])
  assert.deepEqual(h.rt.adapterMap.of(agent.id).selection, selected[0])
  assert.deepEqual(await h.adapter.listModels('nodo:codex'), [])
})

test('only stale Nodo model choices are repaired, preserving configured native opencode', async () => {
  const h = registryHarness()
  let saved = { provider: 'codex', model: 'old-engine-model' }
  const writes = []
  const selections = []
  h.rt.ctx.agentDefaultModel = { currentSelection: () => saved, saveSelection: async value => { writes.push(value); saved = value } }
  h.rt.ctx.sessionController = {
    modelCatalog: async () => ({ groups: [{ id: 'deepseek-account', models: [{ id: 'native-model' }] }, { id: 'opencode', models: [{ id: 'configured-model' }] }] }),
    selectModel: async value => { selections.push(value); return { selected: value } },
  }
  const agent = { id: 'ordinary-session', session: { snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'codex', model: 'old-engine-model' } }] } }
  await h.events.get('agent/created')({ agent })
  assert.deepEqual(saved, { provider: 'deepseek-account', model: 'native-model' })
  assert.deepEqual(selections, [{ sessionId: agent.id, ...saved }])
  saved = { provider: 'opencode', model: 'configured-model' }
  agent.session.snapshotEvents = () => [{ type: 'model/selection', data: saved }]
  const count = writes.length
  await h.events.get('agent/created')({ agent })
  assert.equal(writes.length, count, 'a genuine opencode supplier must not be changed')
  assert.equal(selections.length, 1)
})

test('engine compact waits past RPC acknowledgement and propagates completion, errors and cancellation', async () => {
  const h = registryHarness()
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  const driver = h.drivers[0]
  let acknowledged
  driver.compact = async () => { acknowledged = true }
  let settled = false
  const compacted = h.service.compact('session-1').then(() => { settled = true })
  while (!acknowledged) await new Promise(resolve => setTimeout(resolve, 1))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(settled, false)
  driver.options.onEvent({ type: 'turn/end', reason: 'done' })
  await compacted
  driver.compact = async () => { driver.options.onEvent({ type: 'turn/end', reason: 'error', error: 'compact failure' }) }
  await assert.rejects(h.service.compact('session-1'), /compact failure/)
  const controller = new AbortController()
  driver.compact = async () => { controller.abort() }
  await assert.rejects(h.service.compact('session-1', controller.signal), /interrupted|abort/i)
})

test('full permission refuses an unexpected engine approval without displaying a fake native gate', async () => {
  const h = registryHarness()
  h.setPermission({ sandbox: 'danger-full-access', approval: 'never' })
  const start = h.rt.createEngineDriver
  let decision
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => { driver.options.onEvent({ type: 'request/opened', kind: 'permission', id: 'approval' }) }
    driver.respondToRequest = async (_id, answer) => { decision = answer.decision; driver.options.onEvent({ type: 'turn/end', reason: 'interrupted' }); return true }
    return driver
  }
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.equal((await h.service.execute({ name: 'command' }, { agent: { id: 'session-1' } })).status, 'denied')
  assert.equal(decision, 'deny')
})

test('a stale engine ask closes the native card and relays the real outcome instead of a forced deny', async () => {
  const h = registryHarness()
  let decided, closedCard = false
  const start = h.rt.createEngineDriver
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => { driver.options.onEvent({ type: 'request/opened', kind: 'permission', id: 'approval' }) }
    driver.respondToRequest = async () => { decided = 'answered'; return false }
    return driver
  }
  h.rt.ctx.approval.request = ({ signal }) => new Promise((resolve, reject) => {
    decided = true
    signal?.addEventListener('abort', () => { closedCard = true; reject(signal.reason) }, { once: true })
  })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  const executed = h.service.execute({ name: 'Bash' }, { agent: { id: 'session-1' }, callId: 'call-1' })
  while (decided !== true) await new Promise(resolve => setTimeout(resolve, 1))
  h.drivers[0].options.onEvent({ type: 'request/closed', id: 'approval' })
  h.drivers[0].options.onEvent({ type: 'turn/end', reason: 'done' })
  assert.deepEqual(await executed, { status: 'done' })
  assert.equal(closedCard, true, 'the dead ask must close the host card')
  assert.equal(decided, true, 'the engine request was already gone; no deny may be sent after the fact')
})

test('a lost approval reply retries once, then interrupts and says so', async () => {
  const h = registryHarness()
  let decided = false, responds = 0, interrupted = 0
  const warnings = []
  h.rt.warn = (...args) => warnings.push(args)
  const start = h.rt.createEngineDriver
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => { driver.options.onEvent({ type: 'request/opened', kind: 'permission', id: 'approval' }) }
    driver.respondToRequest = async () => { responds += 1; return false }
    driver.interruptTurn = async () => { interrupted += 1; driver.options.onEvent({ type: 'turn/end', reason: 'interrupted' }) }
    return driver
  }
  h.rt.ctx.approval.request = () => new Promise(resolve => { decided = true; resolve('allowed-once') })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  const executed = h.service.execute({ name: 'Bash' }, { agent: { id: 'session-1' }, callId: 'call-1' })
  while (!decided) await new Promise(resolve => setTimeout(resolve, 1))
  const result = await executed
  assert.equal(responds, 2, 'one retry after the first lost reply')
  assert.equal(interrupted, 1, 'the stuck turn is interrupted so neither side waits forever')
  assert.equal(result.status, 'error')
  assert.match(result.detail, /审批应答未送达 Agent/)
  assert.ok(warnings.some(args => String(args[0]).includes('never reached the engine')), 'the loss is logged for diagnosis')
})

test('a retried approval reply resumes the engine normally', async () => {
  const h = registryHarness()
  let decided = false, responds = 0
  const start = h.rt.createEngineDriver
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => { driver.options.onEvent({ type: 'request/opened', kind: 'permission', id: 'approval' }) }
    driver.respondToRequest = async () => {
      responds += 1
      if (responds < 2) return false
      driver.options.onEvent({ type: 'tool', name: 'Bash', phase: 'start' })
      driver.options.onEvent({ type: 'tool', name: 'Bash', phase: 'end' })
      return true
    }
    return driver
  }
  h.rt.ctx.approval.request = () => new Promise(resolve => { decided = true; resolve('allowed-once') })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  const executed = h.service.execute({ name: 'Bash' }, { agent: { id: 'session-1' }, callId: 'call-1' })
  while (!decided) await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(await executed, { status: 'done' })
  assert.equal(responds, 2)
})

test('parallel permissions are all answered before the engine can finish its first tool', { timeout: 2000 }, async () => {
  const h = registryHarness()
  const start = h.rt.createEngineDriver
  const replies = [], cards = []
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    const emit = driver.options.onEvent
    driver.sendTurn = async () => {
      emit({ type: 'tool', callId: 'a', name: 'Write', phase: 'start' })
      emit({ type: 'tool', callId: 'b', name: 'Bash', phase: 'start' })
      for (const callId of ['a', 'b']) emit({ type: 'request/opened', kind: 'permission', id: callId, callId, tool: callId === 'a' ? 'Write' : 'Bash', reason: callId })
    }
    driver.respondToRequest = async (id, answer) => {
      replies.push([id, answer.decision])
      emit({ type: 'request/closed', id })
      if (replies.length === 2) {
        for (const callId of ['b', 'a']) emit({ type: 'tool', callId, phase: 'end', output: callId })
        emit({ type: 'turn/end', reason: 'done' })
      }
      return true
    }
    return driver
  }
  h.rt.ctx.approval.request = async ({ toolName }) => { cards.push(toolName); return 'allowed-once' }
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.deepEqual(await h.service.execute({ name: 'Write' }, { agent: { id: 'session-1' }, callId: 'mirror-a' }), { status: 'done', detail: 'a' })
  assert.deepEqual(replies, [['a', 'allow'], ['b', 'allow']])
  assert.deepEqual(cards, ['Write', 'Bash'])
  await collect(h.adapter.stream.bind(h.adapter), request('RUN'))
  assert.deepEqual(await h.service.execute({ name: 'Bash' }, { agent: { id: 'session-1' }, callId: 'mirror-b' }), { status: 'done', detail: 'b' })
  assert.equal((await collect(h.adapter.stream.bind(h.adapter), request('RUN'))).at(-1).reason.kind, 'stop')
})

test('late approvals are watched after tool start and stopping closes the native card', { timeout: 2000 }, async () => {
  const h = registryHarness()
  const start = h.rt.createEngineDriver
  const waiting = Promise.withResolvers()
  const controller = new AbortController()
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => driver.options.onEvent({ type: 'tool', callId: 'a', name: 'Write', phase: 'start' })
    driver.respondToRequest = async () => assert.fail('a cancelled card must not send a reply')
    return driver
  }
  h.rt.ctx.approval.request = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    waiting.resolve()
  })
  await collect(h.adapter.stream.bind(h.adapter), request('RUN', controller.signal))
  const executed = h.service.execute({ name: 'Write' }, { agent: { id: 'session-1' }, callId: 'mirror-a', signal: controller.signal })
  h.drivers[0].options.onEvent({ type: 'request/opened', kind: 'permission', id: 'late', callId: 'a' })
  await waiting.promise
  controller.abort()
  assert.equal((await executed).status, 'interrupted')
})

test('stopping a native mirror settles it when the engine interrupt returns without an end event', { timeout: 2000 }, async () => {
  const h = registryHarness()
  const start = h.rt.createEngineDriver
  const controller = new AbortController()
  let interrupts = 0
  h.rt.createEngineDriver = async (...args) => {
    const driver = await start(...args)
    driver.sendTurn = async () => driver.options.onEvent({ type: 'tool', callId: 'a', name: 'read', phase: 'start' })
    driver.interruptTurn = async () => { interrupts++ }
    return driver
  }
  await collect(h.adapter.stream.bind(h.adapter), request('RUN', controller.signal))
  const executed = h.service.execute({ name: 'read' }, { agent: { id: 'session-1' }, signal: controller.signal })
  controller.abort()
  const result = await Promise.race([executed, new Promise(resolve => setTimeout(() => resolve(null), 100))])
  assert.equal(result?.status, 'interrupted', 'native cancellation must not wait for a new event from an idle engine')
  assert.equal(result?.unconfirmed, true)
  assert.equal(interrupts, 1, 'stream and tool cancellation share the same engine interrupt')
  assert.equal(h.rt.adapterWork('session-1'), null)
})

test('native stop cancels adapter preparation before an engine pump exists', async () => {
  const h = registryHarness()
  const creating = Promise.withResolvers()
  const release = Promise.withResolvers()
  const start = h.rt.createEngineDriver
  const controller = new AbortController()
  h.rt.createEngineDriver = async (...args) => {
    creating.resolve()
    await release.promise
    return start(...args)
  }
  const stream = h.adapter.stream(request('WAIT', controller.signal))
  const next = stream.next()
  const outcome = next.then(() => 'finished', () => 'cancelled')
  await creating.promise
  controller.abort(new Error('cancelled setup'))
  try {
    assert.equal(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('stuck'), 100))]), 'cancelled')
  } finally {
    release.resolve()
    await outcome
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(h.drivers[0].disposed, true, 'a driver arriving after cancellation must not be attached')
  assert.equal(h.rt.adapterWork('session-1'), null)
})

test('failed engine cancellation releases the native mirror with an explicit error', async () => {
  const failure = new Error('private diagnostic')
  const pump = createPump({ driver: {
    sendTurn: async () => pump.receive({ type: 'tool', callId: 'a', name: 'read', phase: 'start' }),
    interruptTurn: async () => { throw failure },
  } })
  try {
    await collect(pump.stream, request('READ'))
    const claim = pump.takeMirror()
    await assert.rejects(pump.interrupt(), error => error === failure)
    const result = await claim.done
    assert.equal(result.status, 'error')
    assert.match(result.detail, /Agent 取消失败/)
    assert.equal(result.unconfirmed, true)
    assert.doesNotMatch(result.detail, /private diagnostic/)
    assert.equal(pump.active, false)
  } finally { pump.dispose() }
})

test('a mirror call on a session without an engine relay names the missing attachment', async () => {
  const h = registryHarness()
  const result = await h.service.execute({ name: 'Bash' }, { agent: { id: 'plain-session' } })
  assert.deepEqual(result, { status: 'error', detail: 'No engine is attached to this session; its model is not a Nodo role engine' })
})

test('adapter engine groups are labeled with the Nodo prefix', async () => {
  const h = registryHarness()
  assert.equal(h.adapter.providerInfo('nodo:codex').name, 'Nodo·Codex')
  const catalog = await h.rt.adapterModels({ sessionId: 'session-1' })
  assert.equal(catalog.groups[0].name, 'Nodo·Codex')
})

test('initializeAdapters sweeps orphan bindings and re-registers only resumable presets', async () => {
  const h = registryHarness()
  const registered = []
  h.rt.ctx.agentPresets.register = async ({ id }) => { registered.push(id); return () => {} }
  h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [] } }
  h.rt.adapterMap.bind('session-1', { profileId: 'role', preset: 'nodo:codex:role', engine: 'codex' })
  h.rt.adapterMap.bind('ghost-session', { profileId: 'gone', preset: 'nodo:codex:gone', engine: 'codex' })
  let saved = 0
  const save = h.rt.save
  h.rt.save = async () => { saved += 1; await save() }
  await h.rt.initializeAdapters()
  assert.equal(h.rt.adapterMap.of('ghost-session'), null, 'a deleted role must not keep a binding')
  assert.equal(h.rt.adapterMap.of('session-1').profileId, 'role')
  assert.deepEqual(registered, ['nodo:codex:role'], 'a deleted role must not re-register its preset')
  assert.equal(saved, 1, 'the sweep must persist')
})

test('adapter presets mount an isolated engine catalog, including restored bindings', async () => {
  const h = registryHarness()
  const registered = []
  h.rt.ctx.agentPresets.register = async definition => { registered.push(definition); return () => {} }
  h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codex', sessions: [] } }
  h.rt.adapterMap.bind('legacy-session', { profileId: 'role', preset: 'nodo:claude:role', engine: 'claude' })
  await h.rt.initializeAdapters()
  for (const engine of ['codex', 'claude']) {
    const plugin = registered.find(item => item.id === `nodo:${engine}:role`).plugins.find(item => item.name.endsWith('/skills.js'))
    assert.deepEqual(plugin.isolate, { skills: true })
    assert.deepEqual(plugin.config, { engine })
  }
  let ready = false
  h.rt.driversReady = async () => { ready = true }
  h.rt.engineConfig = engine => { assert.equal(engine, 'claude'); return { engineOptions: { bin: '/tmp/claude' } } }
  h.rt.scanEngineCommands = async options => { assert.equal(ready, true); return options }
  assert.deepEqual(await h.service.commands({ engine: 'claude', cwd: '/tmp/workspace' }), {
    engine: 'claude', cwd: '/tmp/workspace', engineOptions: { bin: '/tmp/claude' },
  })
})

test('dropAdapterProfile removes bindings and presets under every engine the role once used', async () => {
  const h = registryHarness()
  const disposed = []
  h.rt.sessionsOf = () => [{ id: 'conv-1', nativeSessionId: 'session-1' }]
  h.rt.state.profiles = { role: { id: 'role', engine: 'codex', sessions: [] } }
  h.rt.adapterMap.bind('hidden-session', { profileId: 'role', preset: 'nodo:opencode:role', engine: 'opencode' })
  h.rt.ctx.agentPresets.register = async ({ id }) => { const seen = id; return () => disposed.push(seen) }
  await h.rt.syncAdapterPreset({ id: 'role', name: 'Rho', engine: 'codex', role: '' })
  await h.rt.dropAdapterProfile(h.rt.state.profiles.role)
  assert.equal(h.rt.adapterMap.of('session-1'), null)
  assert.equal(h.rt.adapterMap.of('hidden-session'), null)
  assert.deepEqual(disposed, ['nodo:codex:role'])
})

test('deleted-role repair waits for activation before querying presets and restores the fallback', { timeout: 5000 }, async () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'nodo-adapter-heal-'))
  try {
    const folder = join(sessionsRoot, 'sessions', '--tmp-workspace--', 'session-1')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, SESSION_LOG), zstdCompressSync(`${JSON.stringify({ type: 'session', version: 4, id: 'session-1', cwd: '/tmp/workspace', agentPreset: 'nodo:codex:gone' })}\n`))
    const h = registryHarness()
    h.rt.home = join(sessionsRoot, 'orchestrator')
    h.rt.state.profiles = { role: { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [] } }
    const registered = []
    const disposed = []
    const picked = []
    const activation = Promise.withResolvers()
    const repaired = Promise.withResolvers()
    let active = false
    let queries = 0
    h.rt.ctx.fiber = { await: () => activation.promise }
    h.rt.ctx.agentPresets = {
      composedPreset: () => 'role-preset',
      defaultId: 'standard',
      list: async () => { queries += 1; assert.equal(active, true, 'roster diagnostics must run after activation'); return [{ id: 'standard' }, { id: 'ptc' }, { id: 'nodo:codex:role', name: 'Rho' }] },
      resolve: async id => { queries += 1; assert.equal(active, true, 'preset diagnostics must run after activation'); if (id === 'nodo:codex:gone') throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' }); return { id } },
      register: async ({ id, name, description, plugins }) => { registered.push({ id, name, description, plugins }); return async () => { disposed.push(id); repaired.resolve() } },
      select: async (agent, preset) => { picked.push([agent.id, preset]); return preset },
    }
    h.rt.ctx.sessionController = { resolveAgent: async id => id === 'session-1' ? { agent: { id: 'session-1' } } : { error: new Error(`resume failed for session "${id}"`) } }
    h.rt.warn = (...args) => repaired.reject(new Error(String(args)))
    await h.rt.initializeAdapters()
    assert.equal(queries, 0, 'initialization must finish without waiting on the host roster')
    assert.deepEqual(picked, [])
    active = true
    activation.resolve()
    await repaired.promise
    assert.deepEqual(registered.filter(entry => entry.id.startsWith('nodo:')).map(entry => entry.id), ['nodo:codex:role', 'nodo:codex:gone'],
      'the live role keeps its preset and the dangling id gets a rescue definition')
    assert.deepEqual(registered.find(entry => entry.id === 'nodo:codex:gone'), {
      id: 'nodo:codex:gone', name: 'nodo:codex:gone', description: 'Deleted Nodo role: history only', plugins: [],
    }, 'the rescue must claim the id without mounting a composition of its own')
    assert.match(registered.find(entry => entry.id === 'nodo:codex:role').plugins[0].name, /preset\.js$/)
    assert.deepEqual(picked, [['session-1', 'standard']], 'the session is rewritten onto a preset that exists')
    assert.deepEqual(disposed, ['nodo:codex:gone'], 'the dangling id must not stay registered')
  } finally { rmSync(sessionsRoot, { recursive: true, force: true }) }
})

test('a role that cannot register its preset does not hold back the host or the other roles', async () => {
  const h = registryHarness()
  h.rt.state.profiles = {
    broken: { id: 'broken', name: 'Broken', engine: 'codex', role: '', sessions: [] },
    role: { id: 'role', name: 'Rho', engine: 'codex', role: '', sessions: [] },
  }
  const registered = []
  h.rt.ctx.agentPresets.register = async ({ id }) => {
    if (id.endsWith(':broken')) throw new Error('Duplicate agent preset: nodo:codex:broken')
    registered.push(id)
    return () => {}
  }
  const warnings = []
  h.rt.warn = (template, ...args) => warnings.push([template, ...args])
  await h.rt.initializeAdapters()
  assert.deepEqual(registered.filter(id => id.startsWith('nodo:')), ['nodo:codex:role'], 'the remaining roles still register')
  assert.deepEqual(warnings, [['nodo: role "%s" has no agent preset this run: %s', 'Broken', 'Duplicate agent preset: nodo:codex:broken']])
})

test('failed bound presets leave initialization running and preserve bindings for a later retry', async () => {
  const h = registryHarness()
  h.rt.state.profiles = {
    broken: { id: 'broken', name: 'Broken', engine: 'codex', sessions: [] },
    role: { id: 'role', name: 'Rho', engine: 'codex', sessions: [] },
  }
  h.rt.adapterMap.bind('session-1', { profileId: 'role', preset: 'nodo:codex:role', engine: 'codex' })
  h.rt.adapterMap.bind('broken-current', { profileId: 'broken', preset: 'nodo:codex:broken', engine: 'codex' })
  h.rt.adapterMap.bind('broken-legacy', { profileId: 'broken', preset: 'nodo:claude:broken', engine: 'claude' })
  h.rt.adapterMap.bind('healthy-legacy', { profileId: 'role', preset: 'nodo:claude:role', engine: 'claude' })
  const bindings = structuredClone(h.rt.state.adapterSessions)
  const registered = []
  let failing = true
  h.rt.ctx.agentPresets.register = async ({ id }) => {
    if (failing && id.endsWith(':broken')) throw new Error('Preset unavailable')
    registered.push(id)
    return () => {}
  }
  const warnings = []
  h.rt.warn = (template, ...args) => warnings.push([template, ...args])
  await h.rt.initializeAdapters()
  assert.deepEqual(registered, ['nodo:codex:role', 'nodo:claude:role'])
  assert.deepEqual(warnings.slice(1), [
    ['nodo: native session preset "%s" could not be restored: %s', 'nodo:codex:broken', 'Preset unavailable'],
    ['nodo: native session preset "%s" could not be restored: %s', 'nodo:claude:broken', 'Preset unavailable'],
  ])
  assert.deepEqual(h.rt.state.adapterSessions, bindings)
  failing = false
  await h.rt.initializeAdapters()
  assert.deepEqual(registered, ['nodo:codex:role', 'nodo:claude:role', 'nodo:codex:broken', 'nodo:claude:broken'])
  assert.equal(warnings.length, 3)
})

test('tool updates feed the running presentation without a second mirror boundary', async () => {
  const presentation = (body, revision) => ({ version: 1, kind: 'tool', mode: 'snapshot', body, revision })
  let pump
  pump = createPump({ createRecords: () => createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's' }),
    driver: { sendTurn: async () => {
      pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'start', input: { path: '/a' }, presentation: presentation({ inputText: '/a' }, 0) })
      pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'start', input: { path: '/a' } })
      pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'update', outputDelta: 'partial ' })
      pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'update', outputDelta: 'output', progress: { elapsedMs: 1200 } })
    } } })
  const chunks = await collect(pump.stream, request('RUN'))
  assert.equal(chunks.filter(chunk => chunk.block?.type === 'tool-call').length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const claim = pump.takeMirror()
  assert.equal(claim.presentation.body.outputText, 'partial output')
  assert.deepEqual(claim.presentation.body.progress, { elapsedMs: 1200 })
  assert.equal(pump.takeMirror(), null, 'an update must not create another mirror call')
  pump.receive({ type: 'tool', callId: 'a', name: 'Read', phase: 'end', output: 'final output' })
  pump.receive({ type: 'turn/end', reason: 'done' })
  const settled = await claim.done
  assert.equal(settled.presentation.body.outputText, 'final output')
  const rest = await collect(pump.stream, request('RUN'))
  assert.ok(!rest.some(chunk => chunk.block?.type === 'tool-call'), 'queued updates must never open another boundary')
  pump.dispose()
})

test('pump turns a finished subagent into one card row and keeps lifecycle notes plus the final plan row', async () => {
  const { pump } = scriptedPump(text => {
    if (text === 'NEXT') {
      pump.receive({ type: 'text', text: 'reply' })
      pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'compaction', phase: 'start' })
      pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'compaction', phase: 'end' })
      pump.receive({ type: 'activity', turnId: 't2', phase: 'start', entityId: 'task-1', name: 'task', title: 'Research' })
      pump.receive({ type: 'activity', turnId: 't2', phase: 'update', entityId: 'task-1', detail: 'noisy stream' })
      pump.receive({ type: 'activity', turnId: 't2', phase: 'end', entityId: 'task-1', isError: true, detail: 'child boom' })
      pump.receive({ type: 'plan', turnId: 't2', explanation: 'Fix it', steps: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }] })
      pump.receive({ type: 'plan', turnId: 't2', explanation: 'Fix it', steps: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'completed' }] })
      pump.receive({ type: 'turn/end', turnId: 't2', reason: 'done' })
      return
    }
    pump.receive({ type: 'text', text: 'first' })
    pump.receive({ type: 'turn/end', turnId: 't1', reason: 'done' })
  })
  await collect(pump.stream, request('RUN'))
  const second = await collect(pump.stream, request('NEXT'))
  const notes = second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.match(notes, /reply/)
  assert.ok(!notes.includes('压缩'), 'compaction rides the phase, never the text feed')
  assert.ok(!notes.includes('子任务') && !notes.includes('noisy stream'), 'subtask start/update never reach the text stream')
  // The finished subtask splits the stream once, as its own observation row
  // carrying the start-remembered title and the end summary.
  assert.equal(second.at(-1).reason.kind, 'tool-calls')
  const args = JSON.parse(second.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.arguments)
  assert.equal(args.name, '子任务：Research')
  assert.equal(args.brief, '子任务失败')
  assert.deepEqual(await pump.takeMirror().done, { status: 'error', detail: 'child boom' })
  const third = await collect(pump.stream, request('RUN'))
  // The plan still splits once, as its own observation row carrying the last
  // snapshot only; the queued turn end finishes right behind it.
  assert.equal(third.at(-1).reason.kind, 'tool-calls')
  const plan = JSON.parse(third.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.arguments)
  assert.equal(plan.name, '计划')
  assert.equal(plan.brief, '本轮执行计划（最终快照）')
  assert.deepEqual(await pump.takeMirror().done, { status: 'done', detail: 'Fix it\n[x] one\n[x] two' })
  const fourth = await collect(pump.stream, request('RUN'))
  assert.equal(fourth.at(-1).reason.kind, 'stop', 'the queued turn end settles after the plan row')
  pump.dispose()
})

test('pump reports retry waits and compaction as work phases, never as notes', async () => {
  const { pump } = scriptedPump(text => {
    if (text === 'FLAKY') {
      pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'retry', phase: 'start', detail: 'Reconnecting... 2/5' })
      pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'retry', phase: 'start', detail: 'Reconnecting... 3/5' })
      assert.equal(pump.status.phase, 'retrying', 'repeated waits keep one phase')
      assert.equal(pump.status.detail, 'Reconnecting... 3/5', 'the latest wait detail rides the phase')
      pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'retry', phase: 'end' })
      pump.receive({ type: 'delta', text: 'back' })
      assert.equal(pump.status.phase, 'responding', 'a wait ended by output leaves the phase')
      pump.receive({ type: 'tool', callId: 'w', name: 'Bash', phase: 'start', input: { command: 'ping' } })
      return
    }
    if (text === 'COMPACT') {
      pump.receive({ type: 'lifecycle', turnId: 't3', kind: 'compaction', phase: 'start' })
      assert.equal(pump.status.phase, 'compacting')
      pump.receive({ type: 'lifecycle', turnId: 't3', kind: 'compaction', phase: 'end' })
      assert.equal(pump.status.phase, 'running')
      pump.receive({ type: 'turn/end', turnId: 't3', reason: 'done' })
      return
    }
    pump.receive({ type: 'turn/end', turnId: 't1', reason: 'done' })
  })
  await collect(pump.stream, request('RUN'))
  const flaky = await collect(pump.stream, request('FLAKY'))
  assert.equal(flaky.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'back', 'retry waits never enter the text feed')
  assert.ok(!flaky.some(chunk => (chunk.text ?? '').includes('[Nodo]')), 'no status note reaches the feed')
  pump.receive({ type: 'lifecycle', turnId: 't2', kind: 'retry', phase: 'start', detail: 'waiting for network' })
  assert.equal(pump.status.phase, 'retrying', 'a wait after recovery reports again, above the running tool')
  pump.receive({ type: 'tool', callId: 'w', phase: 'end', output: 'done' })
  pump.receive({ type: 'turn/end', turnId: 't2', reason: 'done' })
  await pump.takeMirror().done
  const compact = await collect(pump.stream, request('COMPACT'))
  assert.equal(compact.filter(chunk => chunk.type === 'text-delta').length, 0, 'compaction never enters the text feed')
  pump.dispose()
})

test('pump preserves final plans on success, cancellation and failure without a dangling mirror', async () => {
  const { pump } = scriptedPump(text => {
    if (text === 'MARKDOWN') {
      pump.receive({ type: 'plan', turnId: 't2', text: '# Steps\n- one' })
      pump.receive({ type: 'turn/end', turnId: 't2', reason: 'done' })
      return
    }
    if (text === 'CANCELLED') {
      pump.receive({ type: 'plan', turnId: 't3', explanation: 'Fix it', steps: [{ text: 'one', status: 'in_progress' }] })
      pump.receive({ type: 'turn/end', turnId: 't3', reason: 'interrupted' })
      return
    }
    if (text === 'FAILED') {
      pump.receive({ type: 'plan', turnId: 't4', text: 'last failed plan' })
      pump.receive({ type: 'turn/end', turnId: 't4', reason: 'error', error: 'engine boom' })
      return
    }
    pump.receive({ type: 'text', text: 'first' })
    pump.receive({ type: 'turn/end', turnId: 't1', reason: 'done' })
  })
  await collect(pump.stream, request('RUN'))
  const markdown = await collect(pump.stream, request('MARKDOWN'))
  assert.equal(markdown.at(-1).reason.kind, 'tool-calls')
  const args = JSON.parse(markdown.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.arguments)
  assert.equal(args.name, '计划')
  assert.deepEqual(await pump.takeMirror().done, { status: 'done', detail: '# Steps\n- one' },
    'a markdown-form plan keeps its text instead of vanishing')
  await collect(pump.stream, request('RUN'))
  const cancelled = await collect(pump.stream, request('CANCELLED'))
  assert.equal(cancelled.at(-1).reason.kind, 'stop', 'a cancelled turn ends without a plan boundary')
  assert.equal(cancelled.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false,
    'no dangling mirror row is flushed after a cancel')
  assert.match(cancelled.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').block.text, /已停止.*快照[\s\S]*Fix it[\s\S]*one/)
  assert.equal(pump.takeMirror(), null)
  const failed = []
  await assert.rejects(async () => {
    for await (const chunk of pump.stream(request('FAILED'))) failed.push(chunk)
  }, /engine boom/)
  assert.match(failed.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').block.text, /失败.*快照[\s\S]*last failed plan/)
  assert.equal(pump.takeMirror(), null)
  pump.dispose()
})
