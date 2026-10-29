import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/dispatch.js'
import { TURN_IDLE_TIMEOUT_MS, RETRY_IDLE_TIMEOUT_MS, RUN_LIMITS } from '../core/src/constants.js'
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

test('compaction and retry retain their source lifecycle order while stale turn events stay excluded', async () => {
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
    assert.deepEqual(lines.map(line => [line.event, line.phase, line.turnId]), [
      ['retry', 'start', 't1'], ['retry', 'end', 't1'], ['compaction', 'start', 't1'], ['compaction', 'end', 't1'],
      ['compaction', 'start', undefined], ['compaction', 'end', undefined], ['retry', 'start', 't2'], ['retry', 'end', 't2'],
    ])
    assert.equal(lines[3].isError, true)
    assert.equal(lines[5].cancelled, true)
  } finally { cleanup() }
})

test('a silent startup only warns unless its driver leaves liveness to the host', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const watchdog of [undefined, false]) {
      const { rt, lines, cleanup } = harness()
      const session = { id: 'profile', name: 'Step', briefSent: true }
      const driver = { watchdog, instructionMode: 'native', hasSession: () => true, openSession: async () => {}, sendTurn: async () => {} }
      Object.assign(rt, { conversation: () => ({ profile: {}, session }), conversationOf: () => ({ profile: {}, session }), admitImages: () => [], renderTask: text => text,
        saveImages: async () => [], prepareConversation: async () => session, ensureDriver: async () => driver, statsRound() {},
        state: { profiles: {} }, sessionsOf: () => [] })
      let interrupted = 0
      rt.interruptDriver = async () => { interrupted++ }
      try {
        const { completion } = await rt.send('profile', 'TASK')
        let outcome
        completion.then(value => { outcome = value })
        await tick()
        mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
        await tick(); await tick()
        assert.equal(outcome, undefined, 'silence must not settle startup')
        assert.equal(rt.workView().profile.active, true)
        assert.equal(rt.workView().profile.suspect, watchdog !== false)
        assert.equal(lines.filter(line => line.text?.includes('疑似卡住')).length, watchdog === false ? 0 : 1)
        mock.timers.tick(TURN_IDLE_TIMEOUT_MS * 3)
        assert.equal(lines.filter(line => line.text?.includes('疑似卡住')).length, watchdog === false ? 0 : 1)
        assert.equal(interrupted, 0)
      } finally { cleanup() }
    }
  } finally { mock.timers.reset() }
})

const turnHarness = sendTurn => {
  const h = harness()
  const session = { id: 'profile', name: 'Step', briefSent: true }
  const driver = { instructionMode: 'native', hasSession: () => true, openSession: async () => {}, sendTurn }
  Object.assign(h.rt, { conversation: () => ({ profile: {}, session }), conversationOf: () => ({ profile: {}, session }), admitImages: () => [], renderTask: text => text,
    saveImages: async () => [], prepareConversation: async () => session, ensureDriver: async () => driver, statsRound() {}, statsOutput() {},
    state: { profiles: {} }, sessionsOf: () => [] })
  return { ...h, driver }
}

test('dispatch forwards retryable only on error completions', async () => {
  const { rt, cleanup } = turnHarness(async () => {})
  try {
    for (const reason of ['error', 'interrupted', 'done']) {
      const placed = await rt.send('profile', 'TASK')
      await tick()
      rt.driverSink('profile', { type: 'turn/end', reason, retryable: true })
      assert.equal((await placed.completion).retryable, reason === 'error' ? true : undefined)
    }
  } finally { cleanup() }
})

test('a late turn start after a startup warning binds and completes the waiting sequence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, lines, cleanup } = turnHarness(async () => {})
  let ends = 0
  rt.statsEnd = () => { ends++ }
  try {
    const first = await rt.send('profile', 'TASK')
    let outcome, turn
    first.completion.then(value => { outcome = value })
    first.turn.then(value => { turn = value })
    await tick()
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    await tick()
    assert.equal(rt.workView().profile.suspect, true)
    assert.equal(outcome, undefined)
    assert.equal(turn, undefined)
    await assert.rejects(rt.send('profile', 'OTHER', undefined, [], [], { exclusive: true }), { code: 'orch/busy' })
    rt.driverSink('profile', { type: 'turn/start', turnId: 'late' })
    assert.equal(await first.turn, 'late')
    assert.equal(rt.workView().profile.suspect, false)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'late', reason: 'done', text: 'Recovered startup' })
    assert.deepEqual(await first.completion, { reason: 'done', text: 'Recovered startup', final: 'Recovered startup', replyId: lines.findLast(line => line.reply).replyId })
    assert.equal(rt.workView().profile.active, false)
    assert.equal(ends, 1)
  } finally { cleanup(); mock.timers.reset() }
})

test('session events cannot clear suspicion or repeat the warning during continuous silence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, lines, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' }))
  try {
    const { completion } = await rt.send('profile', 'TASK')
    await tick()
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    for (const state of ['closed', 'ready']) {
      rt.driverSink('profile', { type: 'session', state })
      assert.equal(rt.workView().profile.suspect, true)
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS * 2)
      assert.equal(lines.filter(line => line.text?.includes('疑似卡住')).length, 1)
    }
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done' })
    assert.equal((await completion).reason, 'done')
  } finally { cleanup(); mock.timers.reset() }
})

for (const starting of [false, true]) test(`an explicit stop settles an unresponsive ${starting ? 'starting' : 'active'} turn at the cancellation deadline`, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let sends = 0, ends = 0
  const { rt, lines, cleanup } = turnHarness(() => {
    sends++
    if (!starting || sends > 1) rt.driverSink('profile', { type: 'turn/start', turnId: `T${sends}` })
  })
  rt.statsEnd = () => { ends++ }
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'TASK')
    let outcome
    first.completion.then(value => { outcome = value })
    await tick()
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    assert.equal(rt.workView().profile.suspect, true)
    const queued = await rt.send('profile', 'QUEUED', undefined, [], [], { queue: true })
    await rt.interrupt('profile')
    assert.equal((await queued.completion).reason, 'interrupted')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs - 1)
    await tick()
    assert.equal(outcome, undefined)
    assert.equal(rt.workView().profile.active, true)
    await rt.interrupt('profile')
    mock.timers.tick(1)
    const result = await first.completion
    assert.equal(result.reason, 'interrupted')
    assert.equal(result.unconfirmed, true)
    assert.equal(await first.turn, starting ? null : 'T1')
    assert.equal(rt.workView().profile.active, false)
    assert.equal(rt.workView().profile.suspect, false)
    assert.equal(ends, 1, 'repeated stops keep the original deadline and settle once')
    const count = lines.length
    const late = () => {
      rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'stale' })
      rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'stale' })
    }
    if (!starting) { late(); await tick(); assert.equal(lines.length, count) }
    const next = await rt.send('profile', 'NEXT', undefined, [], [], { exclusive: true })
    await tick()
    late()
    await tick()
    assert.equal(ends, 1)
    assert.equal(rt.workView().profile.buffer, null)
    assert.equal(rt.workView().profile.active, true)
    assert.equal(lines.some(line => line.text === 'stale'), false)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T2', reason: 'done' })
    assert.equal((await next.completion).reason, 'done')
  } finally { cleanup(); mock.timers.reset() }
})

for (const cancellation of ['deadline', 'driver confirmation']) test(`a cancelled startup never sends while ${cancellation} waits for persistence`, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let open, releaseSave, saving = false, sends = 0, ends = 0
  const saved = new Promise(resolve => { releaseSave = resolve })
  const { rt, driver, cleanup } = turnHarness(() => { sends++ })
  driver.openSession = () => new Promise(resolve => { open = resolve })
  rt.save = () => { saving = true; return saved }
  rt.statsEnd = () => { ends++ }
  rt.interruptDriver = async () => {
    if (cancellation === 'driver confirmation') rt.driverSink('profile', { type: 'turn/end', reason: 'interrupted' })
  }
  try {
    const placed = await rt.send('profile', 'CANCELLED')
    await tick()
    assert.equal(typeof open, 'function')
    await rt.interrupt('profile')
    if (cancellation === 'deadline') mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    await tick()
    assert.equal(saving, true)
    assert.equal(rt.workView().profile.active, true)
    open()
    await tick()
    assert.equal(sends, 0, 'initialization must not send while cancellation is being saved')
    releaseSave()
    const outcome = await placed.completion
    assert.equal(outcome.reason, 'interrupted')
    assert.equal(outcome.unconfirmed, cancellation === 'deadline' ? true : undefined)
    assert.equal(await placed.turn, null)
    assert.equal(rt.workView().profile.active, false)
    assert.equal(ends, 1)
  } finally { releaseSave(); cleanup(); mock.timers.reset() }
})

test('a cancelled startup ignores late starts and keeps the next sequence bound to its own turn', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let sends = 0
  const { rt, lines, cleanup } = turnHarness(() => {
    if (++sends === 2) rt.driverSink('profile', { type: 'turn/start', turnId: 'T2' })
  })
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'TASK')
    await tick()
    await rt.interrupt('profile')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    assert.equal((await first.completion).unconfirmed, true)
    assert.equal(await first.turn, null)
    const count = lines.length
    rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
    rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'Ghost reply' })
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'Ghost reply' })
    await tick()
    assert.equal(rt.workView().profile.active, false)
    assert.equal(lines.length, count, 'a late start cannot revive the cancelled startup or its reply')
    const next = await rt.send('profile', 'NEXT', undefined, [], [], { exclusive: true })
    assert.equal(await next.turn, 'T2')
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T2', reason: 'done', text: 'New reply' })
    assert.equal((await next.completion).text, 'New reply')
  } finally { cleanup(); mock.timers.reset() }
})

test('a late end without a known turn id after startup fallback cannot settle or write a reply again', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, lines, cleanup } = turnHarness(async () => {})
  const outcomes = []
  let ends = 0
  rt.recordTaskOutcome = (...args) => outcomes.push(args)
  rt.statsEnd = () => { ends++ }
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'TASK')
    await tick()
    await rt.interrupt('profile')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    assert.equal((await first.completion).reason, 'interrupted')
    const count = lines.length
    for (const turnId of ['late-unknown', undefined]) {
      rt.driverSink('profile', { type: 'turn/end', turnId, reason: 'done', text: 'Stale result' })
      await tick()
    }
    assert.equal(lines.length, count)
    assert.equal(ends, 1)
    assert.deepEqual(outcomes, [['profile', 'TASK', 'interrupted', '']], 'only the fallback records a task outcome')
    assert.equal(rt.workView().profile.active, false)
  } finally { cleanup(); mock.timers.reset() }
})

test('startup cancellation has no previous reply in its completion or task outcome', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let sends = 0
  const { rt, lines, cleanup } = turnHarness(() => {
    if (++sends !== 1) return
    rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
    rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'Previous reply' })
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done' })
  })
  const outcomes = []
  rt.recordTaskOutcome = (...args) => outcomes.push(args)
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'FIRST')
    assert.equal((await first.completion).text, 'Previous reply')
    const previous = lines.find(line => line.text === 'Previous reply')
    const next = await rt.send('profile', 'NEXT')
    await tick()
    assert.equal(rt.workView().profile.buffer, null, 'a new startup does not expose the last reply')
    await rt.interrupt('profile')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    assert.deepEqual(await next.completion, { reason: 'interrupted', text: undefined, unconfirmed: true })
    assert.deepEqual(outcomes.at(-1), ['profile', 'NEXT', 'interrupted', ''])
    assert.equal(previous.reason, 'done', 'startup cancellation must not rewrite the previous reply')
    assert.equal(lines.filter(line => line.text === 'Previous reply').length, 1)
  } finally { cleanup(); mock.timers.reset() }
})

test('a cancelled startup still permits an idle compaction turn to start and end', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, lines, cleanup } = turnHarness(async () => {})
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'TASK')
    await tick()
    await rt.interrupt('profile')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    await first.completion
    rt.isCompacting = () => true
    rt.driverSink('profile', { type: 'turn/start', turnId: 'compact' })
    rt.driverSink('profile', { type: 'delta', turnId: 'compact', text: 'Compacted' })
    rt.driverSink('profile', { type: 'turn/end', turnId: 'compact', reason: 'done' })
    rt.isCompacting = () => false
    await tick()
    assert.equal(rt.workView().profile.active, false)
    assert.equal(lines.find(line => line.text === 'Compacted')?.reason, 'done')
  } finally { cleanup(); mock.timers.reset() }
})

test('a driver end before the cancellation deadline wins once and cannot stop the next sequence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let sends = 0, ends = 0
  const { rt, lines, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: `T${++sends}` }))
  rt.statsEnd = () => { ends++ }
  rt.interruptDriver = async () => {}
  try {
    const first = await rt.send('profile', 'TASK')
    await tick()
    await rt.interrupt('profile')
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs - 1)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'Real result' })
    assert.deepEqual(await first.completion, { reason: 'done', text: 'Real result', final: 'Real result', replyId: lines.findLast(line => line.reply).replyId })
    const next = await rt.send('profile', 'NEXT')
    await tick()
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs)
    assert.equal(ends, 1)
    assert.equal(rt.workView().profile.active, true)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T2', reason: 'done' })
    assert.equal((await next.completion).reason, 'done')
  } finally { cleanup(); mock.timers.reset() }
})

test('an unresponsive driver stop cannot keep the interrupt request pending after completion', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' }))
  rt.interruptDriver = () => new Promise(() => {})
  try {
    const { completion } = await rt.send('profile', 'TASK')
    await tick()
    const stopping = rt.interrupt('profile')
    let stopped = false
    stopping.then(() => { stopped = true })
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs - 1)
    await tick()
    assert.equal(stopped, false)
    mock.timers.tick(1)
    assert.equal((await completion).unconfirmed, true)
    assert.equal(await stopping, true)
    assert.equal(rt.workView().profile.active, false)
  } finally { cleanup(); mock.timers.reset() }
})

test('an idle warning keeps completion, queued messages and exclusive occupancy until the real end', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const sent = [], interrupted = []
  const { rt, lines, cleanup } = turnHarness(text => {
    sent.push(text)
    rt.driverSink('profile', { type: 'turn/start', turnId: `T${sent.length}` })
  })
  rt.interruptDriver = async id => { interrupted.push(id) }
  let ends = 0
  rt.statsEnd = () => { ends++ }
  try {
    const first = await rt.send('profile', 'TASK', undefined, [], [], { exclusive: true })
    let outcome, queuedOutcome
    first.completion.then(value => { outcome = value })
    await tick()
    const queued = await rt.send('profile', 'NEXT', undefined, [], [], { queue: true })
    queued.completion.then(value => { queuedOutcome = value })
    assert.equal(queued.mode, 'queued')
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    await tick()
    assert.equal(outcome, undefined)
    assert.equal(queuedOutcome, undefined)
    assert.deepEqual(interrupted, [])
    assert.equal(ends, 0)
    assert.equal(rt.workView().profile.active, true)
    assert.equal(rt.workView().profile.suspect, true)
    assert.equal(rt.workView().profile.queued, 1)
    assert.equal(rt.workView().profile.pending.length, 1)
    assert.deepEqual(sent, ['TASK'])
    await assert.rejects(rt.send('profile', 'EXCLUSIVE', undefined, [], [], { exclusive: true }), { code: 'orch/busy' })
    const warnings = () => lines.filter(line => line.who === 'system' && line.kind === 'note' && line.text.includes('疑似卡住'))
    assert.equal(warnings().length, 1)
    assert.match(warnings()[0].text, /120 秒.*仍在等待.*手动停止/)
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS * 3)
    await tick()
    assert.equal(warnings().length, 1, 'one continuous silence produces only one warning')
    assert.equal(outcome, undefined)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'Late success' })
    assert.deepEqual(await first.completion, { reason: 'done', text: 'Late success', final: 'Late success', replyId: lines.findLast(line => line.reply).replyId })
    await tick()
    assert.deepEqual(sent, ['TASK', 'NEXT'], 'only the real end drains the queue')
    assert.equal(rt.workView().profile.suspect, false)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T2', reason: 'done', text: 'Next done' })
    assert.equal((await queued.completion).reason, 'done')
    assert.equal(rt.workView().profile.active, false)
    assert.deepEqual(interrupted, [])
  } finally { cleanup(); mock.timers.reset() }
})

test('a native driver leaves active turn liveness to its host without warning', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, driver, lines, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' }))
  driver.watchdog = false
  try {
    const { completion } = await rt.send('profile', 'TASK')
    let outcome
    completion.then(value => { outcome = value })
    await tick()
    mock.timers.tick(RETRY_IDLE_TIMEOUT_MS)
    await tick()
    assert.equal(outcome, undefined)
    assert.equal(rt.workView().profile.suspect, false)
    assert.equal(lines.some(line => line.text?.includes('疑似卡住')), false)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done' })
    assert.equal((await completion).reason, 'done')
  } finally { cleanup(); mock.timers.reset() }
})

test('an open card holds the idle watchdog, and later silence only warns', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const interrupted = []
    let open = false
    const { rt, lines, cleanup } = turnHarness(async () => {
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
      assert.equal(rt.workView().profile.suspect, false)
      assert.equal(lines.some(line => line.text?.includes('疑似卡住')), false)
      open = false
      rt.rearmIdle('profile')
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome, undefined)
      assert.equal(rt.workView().profile.suspect, true)
      assert.deepEqual(interrupted, [])
    } finally { cleanup() }
  } finally { mock.timers.reset() }
})

test('an announced retry delays the idle warning and still accepts a late success', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { rt, lines, cleanup } = turnHarness(() => {
      rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
      rt.driverSink('profile', { type: 'lifecycle', turnId: 'T1', kind: 'retry', phase: 'start', entityId: 'retry-1', detail: '第 1/5 次，等待 120 秒' })
    })
    try {
      const { completion } = await rt.send('profile', 'TASK')
      let outcome
      completion.then(value => { outcome = value })
      await tick()
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome, undefined, 'the retry backoff outlasts the ordinary idle window')
      assert.equal(rt.workView().profile.suspect, false)
      mock.timers.tick(RETRY_IDLE_TIMEOUT_MS - TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome, undefined)
      assert.equal(rt.workView().profile.suspect, true)
      assert.match(lines.find(line => line.kind === 'note').text, /600 秒.*仍在等待/)
      rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'Recovered' })
      assert.equal((await completion).reason, 'done')
      assert.equal(rt.workView().profile.suspect, false)
    } finally { cleanup() }
  } finally { mock.timers.reset() }
})

test('an ordinary event after a retry returns the turn to the ordinary idle window', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let resume
    const { rt, lines, cleanup } = turnHarness(() => new Promise(resolve => {
      rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
      rt.driverSink('profile', { type: 'lifecycle', turnId: 'T1', kind: 'retry', phase: 'start', entityId: 'retry-1' })
      resume = () => { rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'back online' }); resolve() }
    }))
    try {
      const { completion } = await rt.send('profile', 'TASK')
      let outcome
      completion.then(value => { outcome = value })
      await tick()
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome, undefined, 'the retry window still holds')
      resume()
      await tick()
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await tick(); await tick()
      assert.equal(outcome, undefined)
      assert.equal(rt.workView().profile.suspect, true)
      assert.match(lines.find(line => line.kind === 'note').text, /120 秒.*仍在等待/)
    } finally { cleanup() }
  } finally { mock.timers.reset() }
})

test('any current-turn engine activity clears suspicion and rearms one warning per silence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, lines, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' }))
  try {
    const { completion } = await rt.send('profile', 'TASK')
    let outcome
    completion.then(value => { outcome = value })
    await tick()
    const warnings = () => lines.filter(line => line.text?.includes('疑似卡住')).length
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    const events = [
      { type: 'thinking', text: 'Thinking' }, { type: 'delta', text: 'Working' }, { type: 'text', text: 'Online' },
      { type: 'changes', presentation: { version: 1, kind: 'changes', mode: 'snapshot', body: { scope: 'edit-tools', coverage: 'partial', files: [] } } },
      { type: 'plan', steps: [] }, { type: 'activity', entityId: 'child', phase: 'update' },
      { type: 'lifecycle', kind: 'compaction', phase: 'end' },
      { type: 'tool', callId: 'a', phase: 'start' }, { type: 'tool', callId: 'a', phase: 'start' },
      { type: 'tool', callId: 'a', phase: 'update' }, { type: 'tool', callId: 'a', phase: 'end' },
      { type: 'tool', callId: 'a', phase: 'end' },
      { type: 'request/opened', id: 'req', kind: 'permission' }, { type: 'request/closed', id: 'req' },
      { type: 'note', text: 'Reconnected' },
    ]
    for (const event of events) {
      assert.equal(rt.workView().profile.suspect, true)
      rt.driverSink('profile', { ...event, turnId: 'old' })
      assert.equal(rt.workView().profile.suspect, true, 'foreign activity cannot clear suspicion')
      const before = warnings()
      rt.driverSink('profile', { ...event, turnId: 'T1' })
      assert.equal(rt.workView().profile.suspect, false, event.type)
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS - 1)
      assert.equal(rt.workView().profile.suspect, false)
      assert.equal(warnings(), before)
      mock.timers.tick(1)
      assert.equal(rt.workView().profile.suspect, true)
      assert.equal(warnings(), before + 1)
    }
    await tick()
    assert.equal(outcome, undefined)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done' })
    assert.equal((await completion).reason, 'done')
    assert.equal(rt.workView().profile.suspect, false)
  } finally { cleanup(); mock.timers.reset() }
})

for (const reason of ['error', 'interrupted']) test(`an idle warning preserves the engine's eventual ${reason} outcome`, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, cleanup } = turnHarness(() => rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' }))
  try {
    const { completion } = await rt.send('profile', 'TASK')
    await tick()
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    assert.equal(rt.workView().profile.suspect, true)
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason })
    assert.equal((await completion).reason, reason)
    assert.equal(rt.workView().profile.suspect, false)
    assert.equal(rt.workView().profile.active, false)
  } finally { cleanup(); mock.timers.reset() }
})

test('an explicit interrupt after an idle warning keeps late events out between turns and in the next turn', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const { rt, lines, cleanup } = turnHarness(() => new Promise(resolve => {
    rt.driverSink('profile', { type: 'turn/start', turnId: 'T2' })
    release = resolve
  }))
  let ends = 0
  const interrupted = []
  rt.statsEnd = () => { ends++ }
  rt.interruptDriver = async id => {
    interrupted.push(id)
    rt.driverSink(id, { type: 'turn/end', turnId: 'T1', reason: 'interrupted' })
  }
  const late = () => {
    rt.driverSink('profile', { type: 'thinking', turnId: 'T1', text: 'old' })
    rt.driverSink('profile', { type: 'delta', turnId: 'T1', text: 'old' })
    rt.driverSink('profile', { type: 'turn/end', turnId: 'T1', reason: 'done', text: 'old' })
  }
  try {
    rt.driverSink('profile', { type: 'turn/start', turnId: 'T1' })
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    assert.equal(rt.workView().profile.suspect, true)
    await rt.interrupt('profile')
    await tick()
    assert.deepEqual(interrupted, ['profile'])
    assert.equal(rt.workView().profile.suspect, false)
    late()
    await tick()
    assert.equal(rt.workView().profile.active, false)
    assert.equal(ends, 1)
    const { completion } = await rt.send('profile', 'NEXT')
    let outcome
    completion.then(value => { outcome = value })
    await tick()
    mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
    late()
    await tick(); await tick()
    assert.equal(outcome, undefined)
    assert.equal(ends, 1)
    assert.equal(rt.workView().profile.buffer, null)
    assert.equal(rt.workView().profile.suspect, true, 'old events cannot reset the next turn watchdog')
    assert.ok(!lines.some(line => line.text === 'old'))
    release()
  } finally { cleanup(); mock.timers.reset() }
})
