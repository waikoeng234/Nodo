import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/dispatch.js'
import { createMessageStream } from '../core/src/message-stream.js'
import { transcriptReplies } from '../core/src/session-references.js'
import { redactDeep, redactor } from '../core/src/secrets.js'

const harness = () => {
  const lines = [], reports = [], images = [], saves = []
  let cleanup
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const rt = {
    ctx: { effect: factory => { cleanup = factory() } },
    redactDeepSecrets: value => redactDeep(value, redact), save: async () => { saves.push(JSON.parse(JSON.stringify(lines))) },
    statsOutput() {}, statsTool() {}, statsEnd() {}, isCompacting: () => false,
    state: { profiles: {} }, sessionsOf: () => [], openApproval() {}, closeApproval() {},
    recordTaskOutcome: (_id, _task, reason, text) => reports.push({ reason, text }),
    saveReplyImages: async (_id, text) => { images.push(text); return [] },
    appendLine: (_id, line) => { const saved = { at: lines.length, ...line }; lines.push(saved); return saved },
  }
  install(rt)
  return { lines, reports, images, saves, rt, emit: event => rt.driverSink('fixture', { turnId: 'turn', ...event }), dispose: () => cleanup() }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('live and restored transcripts preserve commentary, reasoning, calls and final answers in arrival order', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'delta', messageId: 'intro', text: '先检查。' })
    h.emit({ type: 'delta', messageId: 'intro', text: '', channel: 'commentary', boundary: 'end' })
    h.emit({ type: 'thinking', messageId: 'reason', blockIndex: 0, text: '读取文件。' })
    h.emit({ type: 'tool', name: 'Read', callId: 'read', phase: 'start', input: 'fixture.ts' })
    h.emit({ type: 'tool', name: 'Read', callId: 'read', phase: 'end', output: 'file body' })
    h.emit({ type: 'delta', messageId: 'final', text: '已经确认。' })
    assert.deepEqual(h.lines.map(line => [line.kind, line.text ?? line.phase]), [
      ['text', '先检查。'], ['thinking', '读取文件。'], ['tool', 'start'], ['tool', 'end'], ['text', '已经确认。'],
    ])
    assert.equal(h.rt.workView().fixture.timeline, true)
    assert.equal(h.lines.at(-1).open, true)
    h.emit({ type: 'delta', messageId: 'final', text: '', channel: 'final_answer', boundary: 'end' })
    h.emit({ type: 'turn/end', reason: 'done', text: '已经确认。' })
    await tick()
    const restored = JSON.parse(JSON.stringify(h.lines))
    assert.deepEqual(restored.map(line => line.kind), ['text', 'thinking', 'tool', 'tool', 'text'])
    assert.deepEqual(restored.filter(line => line.kind === 'text').map(line => [line.messageId, line.channel, line.reply, line.open]), [
      ['intro', 'commentary', false, false], ['final', 'final_answer', true, false],
    ])
    assert.equal(transcriptReplies(restored).length, 1)
    assert.equal(transcriptReplies(restored)[0].text, '已经确认。')
    assert.deepEqual(h.reports, [{ reason: 'done', text: '已经确认。' }])
    assert.deepEqual(h.images, ['先检查。', '已经确认。'])
  } finally { h.dispose() }
})

test('source identity and block indices distinguish adjacent messages and let a final snapshot correct one item', () => {
  const lines = []
  const stream = createMessageStream({ append: line => { lines.push(line); return line }, redact: value => value })
  stream.accept({ type: 'delta', messageId: 'a', blockIndex: 0, text: 'partial' })
  stream.accept({ type: 'delta', messageId: 'b', blockIndex: 0, text: 'second' })
  stream.accept({ type: 'text', messageId: 'a', blockIndex: 0, text: 'corrected', channel: 'commentary' })
  assert.equal(lines[1].open, true, 'a late snapshot does not close a different live item')
  stream.accept({ type: 'text', messageId: 'b', blockIndex: 1, text: 'another block' })
  assert.deepEqual(lines.map(line => [line.messageId, line.blockIndex, line.text]), [
    ['a', 0, 'corrected'], ['b', 0, 'second'], ['b', 1, 'another block'],
  ])
  stream.finish('done')
  assert.equal(lines.filter(line => line.reply).length, 1)
  assert.equal(lines.at(-1).reply, true)
})

test('an empty source start preserves its announced phase for the first live delta without creating a phantom message', () => {
  const lines = []
  const stream = createMessageStream({ append: line => { lines.push(line); return line }, redact: value => value })
  stream.accept({ type: 'delta', messageId: 'answer', channel: 'final_answer', text: '', boundary: 'start' })
  assert.equal(lines.length, 0)
  stream.accept({ type: 'delta', messageId: 'answer', text: 'live answer', channel: undefined })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].channel, 'final_answer')
  assert.equal(lines[0].open, true)
})

test('parent attribution announced at completion attaches to the same source identity instead of leaking into the parent report', () => {
  const lines = []
  const stream = createMessageStream({ append: line => { lines.push(line); return line }, redact: value => value })
  stream.accept({ type: 'text', messageId: 'parent', text: 'parent' })
  stream.accept({ type: 'delta', messageId: 'child', text: 'child' })
  stream.accept({ type: 'delta', messageId: 'child', parentCallId: 'call', text: '', boundary: 'end' })
  stream.finish('done')
  assert.equal(lines.length, 2)
  assert.equal(lines[1].parentCallId, 'call')
  assert.equal(lines[1].reply, false)
  assert.equal(stream.text(), 'parent')
})

test('unidentified chunks use known lifecycle boundaries without being assigned another message identity', () => {
  const lines = []
  const stream = createMessageStream({ append: line => { lines.push(line); return line }, redact: value => value })
  stream.accept({ type: 'delta', messageId: 'known', text: 'known' })
  stream.accept({ type: 'delta', text: 'unknown' })
  stream.accept({ type: 'delta', text: '', boundary: 'end' })
  stream.accept({ type: 'delta', text: '', boundary: 'start' })
  stream.accept({ type: 'delta', text: 'next' })
  stream.close()
  stream.accept({ type: 'delta', text: 'after tool' })
  assert.deepEqual(lines.map(line => line.text), ['known', 'unknown', 'next', 'after tool'])
  assert.ok(lines.slice(1).every(line => line.messageId === undefined && line.channel === undefined))
  assert.equal(stream.text(), 'known\nunknown\nnext\nafter tool')
})

test('child messages retain parent attribution and cannot become the parent reply or workflow report', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'text', messageId: 'parent', text: 'parent output' })
    h.emit({ type: 'text', messageId: 'child', parentCallId: 'call', text: 'child output' })
    h.emit({ type: 'turn/end', reason: 'done' })
    await tick()
    assert.equal(h.lines[1].parentCallId, 'call')
    assert.equal(h.lines[1].reply, false)
    assert.equal(h.reports[0].text, 'parent output')
    assert.deepEqual(transcriptReplies(h.lines).map(line => line.text), ['parent output'])
  } finally { h.dispose() }
})

test('message deltas remain redacted across chunk boundaries and stopped turns close every block without exporting a reply', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'delta', messageId: 'a', text: 'fake-sensitive-' })
    h.emit({ type: 'delta', messageId: 'a', text: 'fixture' })
    h.emit({ type: 'thinking', messageId: 'b', text: 'still working' })
    h.emit({ type: 'turn/end', reason: 'interrupted' })
    await tick()
    assert.equal(h.lines[0].text, '[secret:FIXTURE]')
    assert.ok(h.lines.every(line => !line.open))
    assert.equal(transcriptReplies(h.lines).length, 0)
    const before = JSON.stringify(h.lines)
    h.emit({ type: 'delta', messageId: 'a', text: 'late content' })
    assert.equal(JSON.stringify(h.lines), before)
  } finally { h.dispose() }
})

test('approval and retry lifecycle events keep their positions without inventing the approval decision', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'delta', text: 'before' })
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission', reason: 'allow write' })
    h.emit({ type: 'request/closed', id: 'ask' })
    h.emit({ type: 'lifecycle', kind: 'retry', phase: 'start', detail: 'retry source' })
    h.emit({ type: 'delta', text: 'after' })
    h.emit({ type: 'turn/end', reason: 'done', text: 'after' })
    await tick()
    assert.deepEqual(h.lines.map(line => line.kind), ['text', 'request', 'request', 'lifecycle', 'text', 'lifecycle'])
    assert.deepEqual(h.lines.filter(line => line.kind === 'request').map(line => [line.requestId, line.phase]), [['ask', 'start'], ['ask', 'end']])
    assert.ok(!h.lines.some(line => Object.hasOwn(line, 'decision')))
  } finally { h.dispose() }
})

for (const blocks of [false, true]) test(`final text already represented by ${blocks ? 'multiple source blocks' : 'a delta with trailing whitespace differences'} is not appended again`, async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'text', messageId: 'intro', text: 'commentary' })
    if (blocks) {
      h.emit({ type: 'text', messageId: 'answer', blockIndex: 1, text: 'Part B' })
      h.emit({ type: 'text', messageId: 'answer', blockIndex: 0, text: 'Part A' })
    } else h.emit({ type: 'delta', messageId: 'answer', text: 'Hello' })
    const final = blocks ? 'Part APart B' : 'Hello\n'
    h.emit({ type: 'turn/end', reason: 'done', text: final })
    await tick()
    assert.equal(h.lines.length, blocks ? 3 : 2)
    assert.equal(h.lines.filter(line => line.reply).length, 1)
    assert.equal(h.lines.at(-1).final, final)
    assert.equal(transcriptReplies(h.lines)[0].text, final)
    assert.equal(h.reports[0].text, final)
    assert.equal(h.saves.at(-1).at(-1).final, final)
  } finally { h.dispose() }
})

test('a genuinely new final is retained and legacy task reports keep every parent message', async () => {
  for (const final of [undefined, 'new final']) {
    const h = harness()
    try {
      h.emit({ type: 'turn/start' })
      h.emit({ type: 'text', text: 'first' })
      h.emit({ type: 'text', text: 'second' })
      h.emit({ type: 'turn/end', reason: 'done', text: final })
      await tick()
      assert.deepEqual(h.lines.map(line => line.text), final ? ['first', 'second', final] : ['first', 'second'])
      assert.equal(h.reports[0].text, final ?? 'first\nsecond')
    } finally { h.dispose() }
  }
})

test('long delta streams stay live without saving or rebuilding the full turn for every chunk', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'delta', messageId: 'answer', text: 'H' })
    assert.equal(h.saves.length, 1)
    for (let i = 0; i < 1000; i++) h.emit({ type: 'delta', messageId: 'answer', text: 'i' })
    assert.equal(h.saves.length, 1)
    assert.equal(h.rt.workView().fixture.buffer, `H${'i'.repeat(1000)}`)
    assert.equal(h.lines[0].text, `H${'i'.repeat(1000)}`)
    h.emit({ type: 'delta', messageId: 'answer', text: '', boundary: 'end' })
    assert.equal(h.saves.length, 2)
    assert.equal(h.saves.at(-1)[0].open, false)
    h.emit({ type: 'turn/end', reason: 'done' })
    await tick()
    assert.equal(h.saves.at(-1)[0].reply, true)
  } finally { h.dispose() }
})

test('request and lifecycle source text is redacted and bounded', () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    const text = `fake-sensitive-fixture ${'x'.repeat(10000)}`
    h.emit({ type: 'request/opened', id: 'reason', kind: 'question', reason: text })
    h.emit({ type: 'request/opened', id: 'tool', kind: 'permission', tool: text })
    h.emit({ type: 'lifecycle', kind: 'retry', phase: 'start', detail: text })
    assert.ok(h.lines.every(line => line.text.length < 2100 && line.text.startsWith('[secret:FIXTURE]')))
    assert.doesNotMatch(JSON.stringify(h.saves), /fake-sensitive-fixture/)
  } finally { h.dispose() }
})

for (const reason of ['done', 'interrupted', 'error']) test(`open lifecycle and request records close on turn ${reason}`, async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'lifecycle', kind: 'retry', phase: 'start', entityId: 'retry-1' })
    h.emit({ type: 'request/opened', id: 'ask', kind: 'permission' })
    h.emit({ type: 'turn/end', reason })
    await tick()
    assert.deepEqual(h.lines.filter(line => line.kind === 'request').map(line => line.phase), ['start', 'end'])
    const retries = h.lines.filter(line => line.kind === 'lifecycle')
    assert.deepEqual(retries.map(line => line.phase), ['start', 'end'])
    assert.equal(retries[1].entityId, 'retry-1')
    assert.equal(retries[1].cancelled === true, reason === 'interrupted')
    assert.equal(retries[1].isError === true, reason === 'error')
    h.emit({ type: 'request/closed', id: 'ask' })
    assert.equal(h.lines.filter(line => line.kind === 'request').length, 2)
  } finally { h.dispose() }
})

test('an explicitly completed lifecycle is not closed a second time at turn end', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'lifecycle', kind: 'retry', phase: 'start' })
    h.emit({ type: 'lifecycle', kind: 'retry', phase: 'end' })
    h.emit({ type: 'turn/end', reason: 'done' })
    await tick()
    assert.deepEqual(h.lines.map(line => line.phase), ['start', 'end'])
  } finally { h.dispose() }
})

test('independent source plan identities update and clear only their own snapshot', async () => {
  const h = harness()
  try {
    h.emit({ type: 'turn/start' })
    h.emit({ type: 'plan', entityId: 'first', steps: [{ text: 'one', status: 'pending' }] })
    h.emit({ type: 'text', messageId: 'comment', text: 'between plans' })
    h.emit({ type: 'plan', entityId: 'second', steps: [{ text: 'two', status: 'pending' }] })
    h.emit({ type: 'plan', entityId: 'first', steps: [{ text: 'one', status: 'completed' }] })
    assert.equal(h.lines[0].steps[0].status, 'completed')
    assert.equal(h.lines[2].steps[0].status, 'pending')
    assert.deepEqual(h.lines.map(line => line.entityId ?? line.messageId), ['first', 'comment', 'second'])
    h.emit({ type: 'plan', entityId: 'first', steps: [], removed: true })
    assert.equal(h.lines[0].removed, true)
    assert.equal(h.lines[2].removed, undefined)
    h.emit({ type: 'turn/end', reason: 'done' })
    await tick()
  } finally { h.dispose() }
})
