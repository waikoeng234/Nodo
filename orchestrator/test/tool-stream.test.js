import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/dispatch.js'
import { TURN_IDLE_TIMEOUT_MS } from '../core/src/constants.js'
import { toolText } from '../core/src/text.js'
import { redactDeep, redactor } from '../core/src/secrets.js'

test('tool transcript retains bounded, redacted input and output with call identity', () => {
  const lines = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => redactDeep(value, redact), save: async () => {},
    statsTool() {}, appendLine: (_id, line) => { lines.push(line); return line },
  }
  install(rt)
  try {
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Read', phase: 'start', input: { path: 'fake-sensitive-fixture' } })
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Read', phase: 'end', output: [{ type: 'text', text: 'fake-sensitive-fixture\n' + 'x'.repeat(17000) }], isError: true })
    assert.equal(lines[0].callId, 'a')
    assert.match(lines[0].input, /\[secret:FIXTURE\]/)
    assert.match(lines[1].output, /^\[secret:FIXTURE\]\n/)
    assert.ok(lines[1].output.length < 16100)
    assert.equal(lines[1].isError, true)
    assert.doesNotMatch(JSON.stringify(lines), /fake-sensitive-fixture/)
    assert.equal(toolText([{ type: 'content', content: { type: 'text', text: 'first' } }, { type: 'resource', resource: { text: 'second' } }]), 'first\nsecond')
  } finally { cleanup() }
})

test('a key split across deltas, an update brief and the live reply are redacted', () => {
  const lines = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => redactDeep(value, redact), save: async () => {}, statsTool() {}, statsOutput() {},
    isCompacting: () => false, state: { profiles: {} }, sessionsOf: () => [],
    appendLine: (_id, line) => { lines.push(line); return line },
  }
  install(rt)
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't' })
    rt.driverSink('profile', { type: 'tool', turnId: 't', callId: 'a', name: 'Bash', phase: 'start' })
    rt.driverSink('profile', { type: 'tool', turnId: 't', callId: 'a', phase: 'update', inputDelta: 'echo fake-sens', outputDelta: 'fake-sensitive-' })
    rt.driverSink('profile', { type: 'tool', turnId: 't', callId: 'a', phase: 'update', inputDelta: 'itive-fixture', outputDelta: 'fixture\n', brief: 'run fake-sensitive-fixture' })
    rt.driverSink('profile', { type: 'delta', turnId: 't', text: 'the key is fake-sensitive-fixture' })
    assert.equal(lines[0].input, 'echo [secret:FIXTURE]')
    assert.equal(lines[0].output, '[secret:FIXTURE]\n')
    assert.equal(lines[0].brief, 'run [secret:FIXTURE]')
    assert.equal(rt.workView().profile.buffer, 'the key is [secret:FIXTURE]')
  } finally { cleanup() }
})

test('thinking rows append repeated incremental text instead of mistaking it for a snapshot', () => {
  const lines = []
  let cleanup
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => value, save: async () => {}, statsOutput() {},
    appendLine: (_id, line) => { lines.push(line); return line },
  }
  install(rt)
  try {
    rt.driverSink('profile', { type: 'thinking', text: 'ha' })
    rt.driverSink('profile', { type: 'thinking', text: 'ha' })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text, 'haha')
  } finally { cleanup() }
})

test('engine health and retry notes reach the legacy feed with redaction', () => {
  const lines = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = { ctx: { effect: factory => { cleanup = factory() } }, save: async () => {},
    redactDeepSecrets: value => redactDeep(value, redact), appendLine: (_id, line) => lines.push(line) }
  install(rt)
  try {
    rt.driverSink('profile', { type: 'note', text: 'ZCode retry fake-sensitive-fixture' })
    assert.deepEqual(lines, [{ who: 'system', kind: 'note', text: 'ZCode retry [secret:FIXTURE]' }])
  } finally { cleanup() }
})

// A compact dispatch harness: turn/end settles asynchronously, so callers tick
// before starting the next turn when they need the state reset.
const harness = () => {
  const lines = []
  const stats = []
  const approvals = []
  const closed = []
  let cleanup
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => value, save: async () => {},
    statsTool: (_id, phase) => stats.push(phase),
    statsEnd() {}, recordTaskOutcome() {}, isCompacting: () => false,
    openApproval: (_id, event) => approvals.push(event), closeApproval: id => closed.push(id),
    appendLine: (_id, line) => { lines.push(line); return line },
  }
  install(rt)
  return { rt, lines, stats, approvals, closed, cleanup }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('tool updates merge into the running row without adding a tool or a line', async () => {
  const { rt, lines, stats, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'start', input: { command: 'echo one' } })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'update', outputDelta: 'one' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'update', outputDelta: ' two', progress: { elapsedMs: 1200, stdoutBytes: 6 } })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].output, 'one two')
    assert.deepEqual(lines[0].progress, { elapsedMs: 1200, stdoutBytes: 6 })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'end', output: 'one two!', isError: false })
    assert.equal(lines.length, 2)
    assert.equal(lines[0].output, 'one two')
    assert.equal(lines[1].phase, 'end')
    assert.equal(lines[1].output, 'one two!')
    assert.deepEqual(stats, ['start', 'end'])
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('concurrent same-name tools keep their own updates and terminal state', async () => {
  const { rt, lines, stats, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'start', input: { path: '/a' } })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'b', name: 'Read', phase: 'start', input: { path: '/b' } })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'update', outputDelta: 'A1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'b', name: 'Read', phase: 'update', outputDelta: 'B1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'b', name: 'Read', phase: 'end', output: 'B-final' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'update', outputDelta: 'A2' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'end', output: 'A-final' })
    // Missing and foreign identities cannot attach to an open tool.
    rt.driverSink('profile', { type: 'tool', turnId: 't1', phase: 'update', outputDelta: 'ghost' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'c', name: 'Read', phase: 'update', outputDelta: 'ghost' })
    // Terminal protection: updates, starts and second ends stay ignored.
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'update', outputDelta: 'LATE' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'start', input: 'again' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Read', phase: 'end', output: 'again' })
    const starts = lines.filter(line => line.phase === 'start')
    const ends = lines.filter(line => line.phase === 'end')
    assert.equal(starts.length, 2)
    assert.equal(ends.length, 2)
    assert.equal(starts[0].output, 'A1A2')
    assert.equal(starts[1].output, 'B1')
    assert.equal(starts[0].input, toolText({ path: '/a' }))
    assert.equal(starts[1].input, toolText({ path: '/b' }))
    assert.deepEqual(ends.map(line => [line.callId, line.output]), [['b', 'B-final'], ['a', 'A-final']])
    assert.deepEqual(stats, ['start', 'start', 'end', 'end'])
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('a new turn isolates late events and may reuse the same call id', async () => {
  const { rt, lines, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'same', name: 'Bash', phase: 'start' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'same', name: 'Bash', phase: 'end', output: 'first' })
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
    rt.driverSink('profile', { type: 'turn/start', turnId: 't2' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'same', name: 'Bash', phase: 'update', outputDelta: 'old' })
    rt.driverSink('profile', { type: 'tool', turnId: 't2', callId: 'same', name: 'Bash', phase: 'start', input: 'second' })
    rt.driverSink('profile', { type: 'tool', turnId: 't2', callId: 'same', name: 'Bash', phase: 'update', outputDelta: 'new' })
    const second = lines.findLast(line => line.phase === 'start' && line.callId === 'same')
    assert.equal(second.input, 'second')
    assert.equal(second.output, 'new')
    assert.ok(!lines.some(line => line.output === 'old'))
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('an approval for tool B is not blocked by tool A updates', async () => {
  const { rt, lines, approvals, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'start', input: 'sleep 10' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'a', name: 'Bash', phase: 'update', outputDelta: 'working' })
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'b', name: 'Write', phase: 'start', input: '{"path":"b"}' })
    rt.driverSink('profile', { type: 'request/opened', id: 'ask-b', kind: 'permission', tool: 'Write', reason: 'allow b' })
    const b = lines.find(line => line.callId === 'b')
    assert.equal(b.output, undefined)
    assert.equal(approvals.length, 1)
    rt.driverSink('profile', { type: 'tool', turnId: 't1', callId: 'b', name: 'Write', phase: 'update', outputDelta: 'b-progress' })
    assert.equal(b.output, 'b-progress')
    assert.equal(lines.find(line => line.callId === 'a').output, 'working')
    rt.driverSink('profile', { type: 'request/closed', id: 'ask-b' })
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('updates stay redacted and bounded while the final end remains authoritative', () => {
  const lines = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => redactDeep(value, redact), save: async () => {},
    statsTool() {}, appendLine: (_id, line) => { lines.push(line); return line },
  }
  install(rt)
  try {
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Bash', phase: 'start' })
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Bash', phase: 'update', outputDelta: 'fake-sensitive-fixture' })
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Bash', phase: 'update', outputDelta: 'x'.repeat(20000) })
    assert.match(lines[0].output, /^\[secret:FIXTURE\]/)
    assert.ok(lines[0].output.length < 16100)
    assert.doesNotMatch(JSON.stringify(lines), /fake-sensitive-fixture/)
    rt.driverSink('profile', { type: 'tool', callId: 'a', name: 'Bash', phase: 'end', output: 'ok' })
    assert.equal(lines[1].output, 'ok')
  } finally { cleanup() }
})

test('the same call id in two sessions never shares updates', () => {
  const { rt, lines, cleanup } = harness()
  try {
    for (const profile of ['one', 'two']) {
      rt.driverSink(profile, { type: 'turn/start', turnId: 't' })
      rt.driverSink(profile, { type: 'tool', turnId: 't', callId: 'same', name: 'Read', phase: 'start' })
    }
    rt.driverSink('one', { type: 'tool', turnId: 't', callId: 'same', name: 'Read', phase: 'update', outputDelta: 'owner-one' })
    const one = lines.filter(line => line.output === 'owner-one')
    const two = lines.filter(line => line.callId === 'same' && line.output === undefined)
    assert.equal(one.length, 1)
    assert.equal(two.length, 1)
    assert.notEqual(one[0], two[0])
  } finally { cleanup() }
})

test('plan updates replace the one plan row and a removed plan leaves nothing behind', async () => {
  const { rt, lines, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'plan', turnId: 't1', explanation: 'Fix it', steps: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }] })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].kind, 'plan')
    assert.deepEqual(lines[0].steps, [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }])
    rt.driverSink('profile', { type: 'plan', turnId: 't1', explanation: 'Fix it', steps: [{ text: 'one', status: 'completed' }] })
    assert.equal(lines.length, 1, 'a plan update replaces the row instead of appending')
    assert.equal(lines[0].steps.length, 1)
    rt.driverSink('profile', { type: 'plan', turnId: 't2', steps: [{ text: 'ghost', status: 'pending' }] })
    assert.equal(lines[0].steps.length, 1, 'a foreign turn cannot rewrite the row')
    rt.driverSink('profile', { type: 'plan', turnId: 't1', steps: [], removed: true })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].removed, true)
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
    rt.driverSink('profile', { type: 'turn/start', turnId: 't2' })
    rt.driverSink('profile', { type: 'plan', turnId: 't2', steps: [{ text: 'fresh', status: 'pending' }] })
    assert.equal(lines.length, 2)
    assert.equal(lines[1].steps[0].text, 'fresh')
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('subagent activity merges into one row per entity and never becomes turn state', async () => {
  const { rt, lines, stats, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'activity', turnId: 't1', phase: 'start', entityId: 'task-1', name: 'task', title: 'Research',
      parentId: 'run-1', childId: 'child-9', toolCallId: 'tu_1' })
    rt.driverSink('profile', { type: 'activity', turnId: 't1', phase: 'update', entityId: 'task-1', detail: 'found files' })
    rt.driverSink('profile', { type: 'activity', turnId: 't1', phase: 'end', entityId: 'task-1', isError: true, detail: 'child boom' })
    const rows = lines.filter(line => line.kind === 'tool')
    assert.equal(rows.length, 2, 'start and end stay one merged row')
    assert.equal(rows[0].name, 'task')
    assert.equal(rows[0].brief, 'Research')
    assert.equal(rows[0].output, 'found files', 'updates replace the running row like tool updates do')
    assert.equal(rows[0].parentCallId, 'run-1', 'the source parent id stays on the row')
    assert.equal(rows[0].childId, 'child-9')
    assert.equal(rows[0].toolCallId, 'tu_1')
    assert.equal(rows[0].activity, true)
    assert.equal(rows[1].activity, true)
    assert.equal(rows[1].output, 'child boom', 'the end line stays the authoritative result')
    assert.equal(rows[1].isError, true)
    assert.deepEqual(stats, [], 'an activity row is a status, never a counted tool step')
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
    // A member settling after the turn must not revive the finished turn…
    rt.driverSink('profile', { type: 'activity', turnId: 't1', phase: 'end', entityId: 'task-2' })
    assert.equal(lines.filter(line => line.callId === 'task-2').length, 0)
    // …and the next turn owns its own members again.
    rt.driverSink('profile', { type: 'turn/start', turnId: 't2' })
    rt.driverSink('profile', { type: 'activity', turnId: 't2', phase: 'start', entityId: 'task-3', name: 'task' })
    assert.equal(lines.filter(line => line.callId === 'task-3').length, 1)
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
  } finally { cleanup() }
})

test('compaction and retry statuses never write transcript lines', async () => {
  const { rt, lines, cleanup } = harness()
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 't1' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't1', kind: 'retry', phase: 'start', detail: 'rate limited' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't1', kind: 'retry', phase: 'end' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't1', kind: 'compaction', phase: 'start' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't1', kind: 'compaction', phase: 'end', isError: true, detail: 'boom' })
    rt.driverSink('profile', { type: 'lifecycle', kind: 'compaction', phase: 'start' })
    rt.driverSink('profile', { type: 'turn/end', reason: 'interrupted' })
    await tick()
    rt.driverSink('profile', { type: 'lifecycle', kind: 'compaction', phase: 'end', cancelled: true })
    // A stale turn's status cannot disturb the next one either.
    rt.driverSink('profile', { type: 'turn/start', turnId: 't2' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't2', kind: 'retry', phase: 'start', detail: 'rate limited' })
    rt.driverSink('profile', { type: 'lifecycle', turnId: 't1', kind: 'compaction', phase: 'start' })
    rt.driverSink('profile', { type: 'turn/end', reason: 'done' })
    await tick()
    assert.equal(lines.length, 0, 'statuses ride the running animation, not the transcript')
  } finally { cleanup() }
})

test('a silent turn fails at the idle limit unless its driver leaves liveness to the host', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const [watchdog, failed] of [[undefined, true], [false, false]]) {
      const { rt, cleanup } = harness()
      const session = { id: 'profile', name: 'Step', briefSent: true }
      const driver = { watchdog, instructionMode: 'native', hasSession: () => true, openSession: async () => {}, sendTurn: async () => {} }
      Object.assign(rt, { conversation: () => ({ session }), conversationOf: () => ({ session }), admitImages: () => [], renderTask: text => text,
        saveImages: async () => [], prepareConversation: async () => session, ensureDriver: async () => driver, statsRound() {} })
      try {
        const { completion } = await rt.send('profile', 'TASK')
        let outcome
        completion.then(value => { outcome = value })
        await tick()
        mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
        await tick(); await tick()
        assert.equal(outcome?.reason === 'error', failed, watchdog === false ? 'a long native model call is not silence' : 'a dead engine still fails the turn')
      } finally { cleanup() }
    }
  } finally { mock.timers.reset() }
})

const turnHarness = sendTurn => {
  const h = harness()
  const session = { id: 'profile', name: 'Step', briefSent: true }
  const driver = { instructionMode: 'native', hasSession: () => true, openSession: async () => {}, sendTurn }
  Object.assign(h.rt, { conversation: () => ({ session }), conversationOf: () => ({ session }), admitImages: () => [], renderTask: text => text,
    saveImages: async () => [], prepareConversation: async () => session, ensureDriver: async () => driver, statsRound() {}, statsOutput() {},
    state: { profiles: {} }, sessionsOf: () => [] })
  return h
}

test('an open card holds the idle watchdog, and a silent turn it fails stops its engine', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const interrupted = []
    let open = false
    const { rt, cleanup } = turnHarness(async () => {
      rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
      open = true
      rt.driverSink('profile', { type: 'request/opened', id: 'req', kind: 'permission' })
    })
    Object.assign(rt, { awaitingAnswer: () => open, interruptDriver: async id => { interrupted.push(id) } })
    try {
      const { completion } = await rt.send('profile', 'TASK')
      let outcome
      completion.then(value => { outcome = value })
      await tick()
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS * 2)
      await tick(); await tick()
      assert.equal(outcome, undefined, 'a card waiting on the user is not engine silence')
      open = false
      rt.rearmIdle('profile')
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome?.reason, 'error')
      assert.deepEqual(interrupted, ['profile'])
    } finally { cleanup() }
  } finally { mock.timers.reset() }
})

test('a turn that ended here keeps its late engine events out of the next turn', async () => {
  let release
  const { rt, lines, cleanup } = turnHarness(() => new Promise(resolve => { release = resolve }))
  let ends = 0
  rt.statsEnd = () => { ends++ }
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
    rt.driverSink('profile', { type: 'turn/end', reason: 'error', unconfirmed: true })
    await tick()
    const { completion } = await rt.send('profile', 'NEXT')
    let outcome
    completion.then(value => { outcome = value })
    await tick()
    rt.driverSink('profile', { type: 'thinking', turnId: 'T1', text: 'old' })
    rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'old' })
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'old' })
    await tick(); await tick()
    assert.equal(outcome, undefined)
    assert.equal(ends, 1)
    assert.equal(rt.workView().profile.buffer, null)
    assert.ok(!lines.some(line => line.text === 'old'))
    release()
  } finally { cleanup() }
})
