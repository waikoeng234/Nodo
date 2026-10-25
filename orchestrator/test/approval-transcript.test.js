import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install as installDispatch } from '../core/src/dispatch.js'
import { install as installApprovals } from '../core/src/approvals.js'
import { redactDeep, redactor } from '../core/src/secrets.js'

const harness = answer => {
  const lines = [], saved = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = {
    ctx: { effect: effect => { cleanup = effect() } },
    state: { profiles: {} }, sessionsOf: () => [], conversationOf: () => ({ profile: { name: 'Fixture' } }),
    redactDeepSecrets: value => redactDeep(value, redact),
    appendLine: (_id, line) => { lines.push(line); return line },
    save: async () => { saved.push(JSON.parse(JSON.stringify(lines))) },
    answerRequest: (...args) => answer(rt, ...args),
    statsOutput() {}, statsTool() {}, statsEnd() {}, recordTaskOutcome() {}, isCompacting: () => false,
  }
  installDispatch(rt)
  installApprovals(rt)
  const emit = event => rt.driverSink('p', { turnId: 't', ...event })
  emit({ type: 'turn/start' })
  return { rt, emit, lines, saved, dispose: () => cleanup() }
}

for (const decision of ['allow', 'deny']) test(`${decision} survives a source close arriving before the answer RPC completes`, async () => {
  const h = harness(async rt => { rt.driverSink('p', { type: 'request/closed', id: 'ask' }); return true })
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission', reason: 'allow test' })
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission', reason: 'duplicate' })
    await h.rt.answerApproval('ask', { decision })
    assert.deepEqual(h.lines.map(line => line.phase), ['start', 'end'])
    assert.equal(h.lines[1].response.decision, decision)
    assert.equal(h.saved.at(-1)[1].response.decision, decision)
    assert.equal(h.rt.approvalsView().length, 0)
    h.emit({ type: 'request/closed', id: 'ask' })
    assert.equal(h.lines.length, 2, 'a later duplicate close does not append another status row')
  } finally { h.dispose() }
})

test('confirmed text replies are redacted, persisted, and stay in place when the close event arrives later', async () => {
  const h = harness(async () => true)
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'question', reason: 'which color' })
    await h.rt.answerApproval('ask', { decision: 'answer', value: 'Blue\nfake-sensitive-fixture' })
    assert.equal(h.lines[1].response.value, 'Blue\n[secret:FIXTURE]')
    h.emit({ type: 'delta', text: 'continuing' })
    h.emit({ type: 'request/closed', id: 'ask' })
    assert.deepEqual(h.lines.map(line => line.kind), ['request', 'request', 'text'])
    const restored = JSON.parse(JSON.stringify(h.saved.at(-1)))
    assert.equal(restored[1].response.value, 'Blue\n[secret:FIXTURE]')
    assert.doesNotMatch(JSON.stringify(h.saved), /fake-sensitive-fixture/)
  } finally { h.dispose() }
})

test('multi-question labels remain paired with the exact submitted values', async () => {
  const h = harness(async () => true)
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'question', detail: { questions: [
      { id: 'q1', header: '颜色', question: 'Which color?' }, { id: 'q2', question: 'Which drink?' },
    ] } })
    const value = JSON.stringify({ q1: 'Blue', q2: 'Tea' })
    await h.rt.answerApproval('ask', { decision: 'answer', value })
    assert.equal(h.lines[1].response.value, value)
    assert.deepEqual(h.lines[1].response.questions, [{ id: 'q1', label: '颜色' }, { id: 'q2', label: 'Which drink?' }])
  } finally { h.dispose() }
})

test('failed, stale and automatic cancellation responses never become confirmed user answers', async () => {
  for (const mode of ['failure', 'stale', 'closed-failure', 'cancel']) {
    const h = harness(async rt => {
      if (['closed-failure', 'cancel'].includes(mode)) rt.driverSink('p', { type: 'request/closed', id: 'ask' })
      if (['failure', 'closed-failure'].includes(mode)) throw new Error('transport down')
      return mode !== 'stale'
    })
    try {
      h.emit({ type: 'request/opened', id: 'ask', kind: 'permission' })
      if (mode === 'cancel') {
        h.rt.cancelApprovals('p')
        await new Promise(resolve => setImmediate(resolve))
      } else await assert.rejects(h.rt.answerApproval('ask', { decision: 'allow' }), /transport down|no longer active/)
      assert.ok(h.lines.every(line => !line.response))
      if (mode === 'failure') assert.equal(h.rt.approvalsView().length, 1)
    } finally { h.dispose() }
  }
})

test('late acknowledgement updates its original request instead of a reused id in a newer turn', async () => {
  let accept
  const h = harness(() => new Promise(resolve => { accept = resolve }))
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'question', reason: 'first' })
    const pending = h.rt.answerApproval('ask', { decision: 'answer', value: 'original answer' })
    h.emit({ type: 'request/closed', id: 'ask' })
    h.emit({ type: 'turn/start', turnId: 'second' })
    h.emit({ type: 'request/opened', id: 'ask', kind: 'question', reason: 'second' })
    accept(true)
    await pending
    assert.equal(h.lines[1].turnId, 't')
    assert.equal(h.lines[1].response.value, 'original answer')
    assert.equal(h.lines[2].turnId, 'second')
    assert.equal(h.lines[2].response, undefined)
    assert.equal(h.rt.approvalsView().length, 1, 'the newer request is still waiting')
  } finally { h.dispose() }
})

for (const kind of ['permission', 'question']) test(`cancelling a ${kind} closes history even without a driver acknowledgement`, async () => {
  const h = harness(async () => { throw new Error('driver disposed') })
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind })
    h.rt.cancelApprovals('p')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.rt.approvalsView().length, 0)
    assert.deepEqual(h.lines.map(line => line.phase), ['start', 'end'])
    assert.equal(h.lines[1].cancelled, true)
    assert.equal(h.lines[1].response, undefined)
    assert.equal(h.saved.at(-1)[1].cancelled, true)
    h.emit({ type: 'request/closed', id: 'ask' })
    assert.equal(h.lines.length, 2)
  } finally { h.dispose() }
})

test('cancelling an answer in flight does not restore its card or invent a confirmed user response', async () => {
  let reject
  const h = harness(() => new Promise((_resolve, no) => { reject = no }))
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission' })
    const answer = h.rt.answerApproval('ask', { decision: 'allow' })
    h.rt.cancelApprovals('p')
    reject(new Error('driver disposed'))
    await assert.rejects(answer, /driver disposed/)
    assert.equal(h.rt.approvalsView().length, 0)
    assert.equal(h.lines[1].cancelled, true)
    assert.equal(h.lines[1].response, undefined)
  } finally { h.dispose() }
})

test('a user denial that ends the turn before its RPC returns remains a confirmed denial', async () => {
  const h = harness(async rt => { rt.driverSink('p', { type: 'turn/end', turnId: 't', reason: 'interrupted' }); return true })
  try {
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission' })
    await h.rt.answerApproval('ask', { decision: 'deny' })
    assert.deepEqual(h.lines.map(line => line.phase), ['start', 'end'])
    assert.equal(h.lines[1].response.decision, 'deny')
    assert.equal(h.lines[1].cancelled, undefined)
    assert.equal(h.saved.at(-1)[1].response.decision, 'deny')
  } finally { h.dispose() }
})
