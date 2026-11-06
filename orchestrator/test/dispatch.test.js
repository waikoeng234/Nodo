import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { install as installDispatch } from '../core/src/dispatch.js'
import { until, withHost } from './helpers/host.js'

const harness = () => {
  const lines = []
  const rt = {
    ctx: { effect: () => {} },
    state: { profiles: {} }, sessionsOf: () => [], conversationOf: () => ({ profile: { name: 'Fixture' } }),
    redactDeepSecrets: value => value,
    appendLine: (_id, line) => { lines.push(line); return line },
    save: async () => {},
    statsOutput() {}, statsTool() {}, statsEnd() {}, statsLive() {}, recordTaskOutcome() {}, isCompacting: () => false,
  }
  installDispatch(rt)
  return { rt, lines }
}

test('an event whose type names an Object.prototype member is dropped instead of calling an inherited sink', () => {
  const h = harness()
  for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) h.rt.driverSink('p', { type })
  assert.deepEqual(h.lines, [])
})

for (const mode of ['open', 'event', 'twice', 'other', 'no-note']) test(`resume handoff keeps the dispatch completion and input (${mode})`, () => withHost(async ({ api, runtime, home }) => {
  const workspace = await api('workspace-create', { name: 'Fixture', cwd: home })
  const role = await api('profile-create', { name: 'Fixture', engine: 'echo', workspace: workspace.id })
  const rt = await runtime
  if (mode === 'no-note') delete rt.sessionNote
  const { profile, session } = rt.conversation(role.id, role.id)
  profile.driverSessionId = session.driverSessionId = 'old-id'
  session.lastTurn = { task: 'Previous task', report: 'Previous result', reason: 'done' }
  const previous = structuredClone(session.lastTurn)
  const images = [{ mediaType: 'image/png', data: 'fixture-image' }]
  rt.admitImages = () => images
  rt.saveImages = async () => []
  let created = 0, released = 0, rounds = 0
  const inputs = [], outcomes = []
  rt.statsRound = () => { rounds++ }
  const record = rt.recordTaskOutcome
  rt.recordTaskOutcome = (...args) => { outcomes.push(args); return record(...args) }
  rt.releaseDriver = () => { released++ }
  rt.ensureDriver = async prepared => {
    const attempt = ++created
    assert.equal(prepared.driverSessionId, attempt === 1 ? 'old-id' : undefined)
    const fail = () => Object.assign(new Error('Fixture failure'), mode === 'other' ? {} : { errorKind: 'resume-failed' })
    return {
      hasSession: () => attempt === 1,
      async openSession() {
        if (attempt === 2 && mode === 'twice') await rt.saveSessionEvent(session.id, { sessionId: 'replacement-id' })
        if (mode !== 'event' && (attempt === 1 || mode === 'twice')) throw fail()
      },
      async sendTurn(text, receivedImages) {
        inputs.push(text)
        assert.equal(receivedImages, images)
        rt.driverSink(session.id, { type: 'turn/start', turnId: `turn-${attempt}` })
        if (attempt === 1) {
          setImmediate(() => rt.driverSink(session.id, { type: 'turn/end', turnId: `turn-${attempt}`, reason: 'error', errorKind: 'resume-failed' }))
          return
        }
        assert.deepEqual(session.lastTurn, previous, 'the failed resume must not overwrite recovery data')
        assert.equal(session.restoreContext, true)
        rt.driverSink(session.id, { type: 'turn/end', turnId: `turn-${attempt}`, reason: 'done', text: 'Recovered' })
      },
    }
  }
  const placed = await rt.send(role.id, 'Original input', session.id, images)
  const result = await placed.completion
  assert.equal(result.reason, ['twice', 'other'].includes(mode) ? 'error' : 'done')
  assert.equal(created, mode === 'other' ? 1 : 2)
  assert.equal(released, mode === 'other' ? 0 : 1)
  assert.equal(rounds, 1)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0][1], 'Original input')
  const expectedId = mode === 'other' ? 'old-id' : mode === 'twice' ? 'replacement-id' : undefined
  assert.equal(profile.driverSessionId, expectedId)
  assert.equal(session.driverSessionId, expectedId)
  const lines = rt.transcriptOf(session.id)
  assert.equal(lines.filter(line => line.who === 'user').length, 1)
  assert.equal(lines.filter(line => line.kind === 'note' && line.text.includes('旧引擎历史')).length, ['other', 'no-note'].includes(mode) ? 0 : 1)
  if (result.reason === 'done') {
    assert.match(inputs.at(-1), /Previous result/)
    assert.match(inputs.at(-1), /# Current task\nOriginal input$/)
    assert.equal(await placed.turn, mode === 'event' ? 'turn-1' : 'turn-2')
  }
}))

for (const ended of [false, true]) for (const existingRecovery of [false, true]) test(`interrupt before handoff resend preserves only prior recovery (ended=${ended}, existing=${existingRecovery})`, () => withHost(async ({ api, runtime, home }) => {
  const workspace = await api('workspace-create', { name: 'Fixture', cwd: home })
  const role = await api('profile-create', { name: 'Fixture', engine: 'echo', workspace: workspace.id })
  const rt = await runtime
  const { session } = rt.conversation(role.id, role.id)
  session.driverSessionId = 'old-id'
  if (existingRecovery) session.restoreContext = true
  let opening, unblock
  const opened = new Promise(resolve => { opening = resolve })
  const blocked = new Promise(resolve => { unblock = resolve })
  let attempts = 0, sent = 0
  rt.releaseDriver = () => {}
  rt.ensureDriver = async () => {
    const attempt = ++attempts
    return {
      hasSession: () => false,
      async openSession() {
        if (attempt === 1) throw Object.assign(new Error('Missing session'), { errorKind: 'resume-failed' })
        opening()
        await blocked
      },
      async sendTurn() { sent++ },
    }
  }
  rt.interruptDriver = async () => {
    if (ended) rt.driverSink(session.id, { type: 'turn/end', reason: 'interrupted' })
    return true
  }
  const placed = await rt.send(role.id, 'Continue', session.id)
  await opened
  assert.equal(session.restoreContext, true)
  await rt.interrupt(role.id, session.id)
  if (ended) await placed.completion
  unblock()
  assert.equal((await placed.completion).reason, 'interrupted')
  await new Promise(resolve => setImmediate(resolve))
  await until(() => {
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[role.id].sessions[0]
    return saved.restoreContext === (existingRecovery ? true : undefined)
  })
  assert.equal(session.restoreContext, existingRecovery ? true : undefined)
  assert.equal(attempts, 2)
  assert.equal(sent, 0)
  assert.equal(rt.workView()[session.id]?.active ?? false, false)
}))
