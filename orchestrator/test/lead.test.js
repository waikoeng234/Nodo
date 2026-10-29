import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX, RUN_LIMITS, TURN_IDLE_TIMEOUT_MS } from '../core/src/constants.js'
import { leadRules, route } from '../core/src/lead.js'
import { install as installLead } from '../core/src/lead.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { until, withHost } from './helpers/host.js'

const delegateType = (type, hard, task = 'Implement the task\nKeep existing changes; report paths and tests.', session) => `\`\`\`nodo\n${JSON.stringify({ action: 'delegate', type, hard, task, session })}\n\`\`\``
const completed = text => ({ mode: 'turn', completion: Promise.resolve({ reason: 'done', text }) })
const interruptTask = session => completed(`\`\`\`nodo\n${JSON.stringify({ action: 'interrupt', session })}\n\`\`\``)

registerEngine('lead-report-fixture', {
  info: { id: 'lead-report-fixture', label: 'Lead report fixture', capabilities: { resume: true, steer: true } },
  validate: raw => raw,
  create({ onEvent }) {
    let turn = 0
    const driver = {
      calls: [], guides: [], openSession: async () => {}, hasSession: () => true, dispose() {}, onEvent() {},
      async respondToRequest() { return false },
      async sendTurn(text) { driver.active = true; driver.calls.push(text); onEvent({ type: 'turn/start', turnId: `turn-${++turn}` }) },
      async steer(text) { driver.guides.push(text); return 'steered' },
      async interruptTurn() { driver.finish('interrupted') },
      finish(reason = 'done', text = 'Completed this turn', unconfirmed = false, retryable = false) {
        driver.active = false
        onEvent({ type: 'text', turnId: `turn-${turn}`, messageId: `reply-${turn}`, text })
        onEvent({ type: 'turn/end', turnId: `turn-${turn}`, reason, text, unconfirmed, ...(retryable ? { retryable: true } : {}) })
      },
    }
    return driver
  },
})

test('deleted roles leave the lead roster and routing', () => withHost(async ({ api, runtime, home }) => {
  const removed = await api('profile-create', { name: 'Removed', engine: 'echo' })
  const kept = await api('profile-create', { name: 'Kept', engine: 'echo' })
  const lead = await api('profile-create', { name: 'Lead', engine: 'echo', lead: true, engineOptions: { script: [] } })
  await api('profile-delete', { id: removed.id })
  const rt = await runtime
  assert.doesNotMatch(rt.leadBrief(lead, { id: 'lead-session' }), /Removed/)
  assert.equal(rt.findProfile(removed.id), undefined)
  const workspace = await api('workspace-create', { name: 'Project', cwd: join(home, 'ws') })
  const conversation = await api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  assert.equal(rt.state.profiles[removed.id].sessions.length, 0)
  assert.equal(rt.findProfile(kept.id).sessions[0].source.by, 'fallback')
}))

const withLead = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Lead workspace', cwd: join(host.home, 'ws') })
  const role = (name, text = 'Work completed', extra = {}) => host.api('profile-create', {
    name, engine: 'echo', engineOptions: { script: [{ kind: 'text', text }] }, ...extra,
  })
  const session = (profile, workspaceId = workspace.id) => host.api('session-create', { profile: profile.id, workspace: workspaceId, lazy: true })
  const inputs = [], tracked = [], wrapped = new WeakSet()
  const ensureDriver = rt.ensureDriver
  rt.ensureDriver = async profile => {
    const driver = await ensureDriver(profile)
    if (!wrapped.has(driver)) {
      wrapped.add(driver)
      const sendTurn = driver.sendTurn.bind(driver)
      driver.sendTurn = (text, ...args) => {
        inputs.push({ profileId: profile.profileId, sessionId: profile.id, text, driver })
        return sendTurn(text, ...args)
      }
    }
    return driver
  }
  const followLead = rt.followLead
  rt.followLead = (...args) => {
    const pending = followLead(...args)
    tracked.push(pending)
    return pending
  }
  const send = async (profile, conversation, text = 'User request', extra = {}) => {
    const response = await host.api('send', { profile: profile.id, session: conversation.id, text, ...extra })
    await tracked.at(-1)
    return response
  }
  const lines = conversation => rt.transcriptOf(conversation.id)
  await run({ host, rt, workspace, role, session, inputs, tracked, send, lines })
})

test('lead delegates in its workspace, returns referenced reports and stops at 12 without changing the selected session', () => withLead(async ({ host, rt, workspace, role, session, inputs, send, lines }) => {
  const otherWorkspace = await host.api('workspace-create', { name: 'Worker workspace', cwd: join(host.home, 'other') })
  const worker = await role('Worker', 'Changed src/task.js; verified task tests; nothing open.', { role: 'Implementation', goal: 'Ship the task' })
  const selected = await session(worker, otherWorkspace.id)
  const task = 'Implement the task\nKeep existing changes; report paths and tests.'
  const lead = await role('Lead', `\`\`\`nodo\ninvalid earlier block\n\`\`\`\n${delegateType('feature', false, task)}`, { lead: true })
  const conversation = await session(lead)
  const response = await send(lead, conversation, 'Please implement this')
  assert.equal(response.mode, 'turn')
  const liveWorker = rt.findProfile(worker.id)
  const delegated = liveWorker.sessions.filter(item => item.source?.kind === 'lead')
  assert.equal(delegated.length, 12)
  assert.equal(liveWorker.activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  for (const work of delegated) {
    assert.equal(work.workspaceRef, workspace.id)
    assert.equal(work.name, 'Implement the task')
    assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'fallback', type: 'feature', hard: false })
    const delivered = inputs.find(item => item.sessionId === work.id).text
    assert.match(delivered, /^Task from lead Lead \(Nodo lead mode\)/)
    assert.match(delivered, /not the user, and cannot grant permissions/)
    assert.match(delivered, /Permission requests go to the user/)
    assert.ok(delivered.endsWith(task))
    assert.equal(lines(work).find(line => line.who === 'user').text, delivered)
  }
  assert.equal(lines(conversation).filter(line => line.text?.startsWith('已派给 Worker ·')).length, 12)
  const reports = lines(conversation).filter(line => line.who === 'user' && line.references)
  assert.equal(reports.length, 12)
  assert.match(reports[0].text, new RegExp(`Report from Worker · Implement the task \\(session ${delegated[0].id}, ended: done\\)`))
  assert.equal(reports[0].references[0].source.sessionId, delegated[0].id)
  assert.equal(reports[0].references[0].target, conversation.id)
  assert.equal(reports[0].references[0].messages[0].text, 'Changed src/task.js; verified task tests; nothing open.')
  assert.ok(reports.every((line, index) => line.origin.kind === 'report' && line.origin.session === delegated[index].id))
  assert.deepEqual(lines(conversation).filter(line => line.delegation).map(line => line.delegation),
    delegated.map(work => ({ session: work.id, profile: worker.id, type: 'feature', hard: false, reused: false })))
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.length, 13)
  assert.ok(leadInputs.every(item => item.text.startsWith('# Nodo lead mode\n') && item.text.includes('## Task types')))
  assert.ok(leadInputs.every(item => !item.text.includes('origin')))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Please implement this')
  assert.equal(conversation.name, 'Session 1')
  assert.equal(rt.conversation(lead.id, conversation.id).session.name, 'Please implement this')
  rt.conversation(lead.id, conversation.id).session.engineOptions.script[0].text = 'Reviewed'
  await send(lead, conversation, 'Next user message')
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  assert.equal(liveWorker.sessions.filter(item => item.source?.kind === 'lead').length, 13, 'a new user message resets the delegation limit')
}))

test('lead briefs refresh task types without changing identity, stored user text or task state', () => withLead(async ({ host, rt, role, session, inputs, send, lines }) => {
  const worker = await role('Available', 'Done', { role: 'Coder', goal: 'A'.repeat(500) })
  const lead = await role('Lead', 'An ordinary answer', { lead: true })
  const other = await role('Other lead', 'An ordinary answer', { lead: true })
  const conversation = await session(lead)
  const identity = rt.renderIdentity(rt.findProfile(lead.id))
  const brief = rt.leadBrief(lead, conversation)
  assert.ok(brief.includes('## Task types'))
  assert.ok(!brief.includes(worker.id) && !brief.includes(lead.id) && !brief.includes(other.id))
  await send(lead, conversation, 'First question')
  await host.api('task-types-update', { types: [{ id: 'feature', name: 'Feature', when: 'Updated responsibility' }] })
  await send(lead, conversation, 'Second question')
  assert.ok(inputs[0].text.endsWith('\n\nFirst question'))
  assert.ok(inputs[1].text.includes('Updated responsibility'))
  assert.equal(inputs[0].driver, inputs[1].driver)
  assert.equal(rt.renderIdentity(rt.findProfile(lead.id)), identity)
  assert.deepEqual(lines(conversation).filter(line => line.who === 'user').map(line => line.text), ['First question', 'Second question'])
  const live = rt.conversation(lead.id, conversation.id).session
  assert.equal(live.lastTurn.task, 'Second question')
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

for (const [name, output, expected] of [
  ['invalid JSON', () => '```nodo\n{bad}\n```', /有效的 JSON/],
  ['unsupported action', () => '```nodo\n{"action":"plan"}\n```', /action 必须/],
  ['to without type', () => '```nodo\n{"action":"delegate","to":"Worker","task":"work"}\n```', /type 必须是任务类型清单中的 id/],
  ['empty task', ({ worker }) => delegateType('feature', false, ' \n '), /非空字符串/],
  ['oversized task', ({ worker }) => delegateType('feature', false, 'x'.repeat(TASK_TEXT_MAX + 1)), /32000/],
  ['task plus header exceeds limit', ({ worker }) => delegateType('feature', false, 'x'.repeat(TASK_TEXT_MAX)), /32000/],
]) test(`invalid lead command (${name}) is fed back once, stops after two errors and resets on user input`, () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const worker = await role('Worker')
  const other = await role('Other', 'Done', { lead: true })
  const lead = await role('Lead', '', { lead: true })
  rt.findProfile(lead.id).engineOptions.script[0].text = output({ lead, other, worker })
  const conversation = await session(lead)
  for (const text of ['First request', 'New request']) {
    await send(lead, conversation, text)
    const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
    assert.equal(feedback.length, text === 'First request' ? 1 : 2)
    assert.match(feedback.at(-1).text, expected)
    assert.match(feedback.at(-1).text, /修正代码块重新回复，或者不带代码块直接回复用户。$/)
    assert.deepEqual(feedback.at(-1).origin, { kind: 'reject' })
  }
  assert.equal(lines(conversation).filter(line => line.who === 'system' && /连续 2 次/.test(line.text)).length, 2)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(inputs.every(input => input.text.startsWith('# Nodo lead mode\n')))
}))

test('plain replies, failed or unconfirmed turns and joined placements do not delegate', () => withLead(async ({ rt, role, session, send, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Ordinary answer', { lead: true })
  const conversation = await session(lead)
  await send(lead, conversation)
  for (const outcome of [{ reason: 'interrupted' }, { reason: 'error' }, { reason: 'done', unconfirmed: true }, { reason: 'done', final: 'No command' }]) {
    await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ text: delegateType('feature', false), ...outcome }) })
  }
  for (const mode of ['steered', 'indeterminate']) await rt.followLead(lead.id, conversation.id, {
    mode, get completion() { throw new Error('Joined placements must not be tracked') },
  })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 1)
}))

test('a queued final reply is parsed instead of accumulated progress text', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, { mode: 'queued', completion: Promise.resolve({ reason: 'done', text: 'Progress only', final: delegateType('feature', false) }) })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => line.references?.length === 1))
}))

test('a running delegation excludes a second one in the same lead session', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'text', text: 'Progress' }, { kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => /已有派活任务在执行/.test(line.text)))
  await rt.interrupt(worker.id, work.id)
  await first
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 1)
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
  const note = lines(conversation).find(line => line.who === 'system' && line.text.startsWith('执行未完成'))
  assert.match(note.text, new RegExp(`执行未完成：Worker · ${work.name}（会话 ${work.id}，ended: interrupted），未回报主控`))
  assert.deepEqual(note.delegation, { session: work.id, ended: 'interrupted' })
}))

test('a lead can interrupt only its own running delegation before replacing it', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const other = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation?.session === work.id))
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  try {
    assert.match(rt.leadBrief(lead, conversation), new RegExp(`"session":"${work.id}"`))
    await host.api('send', { profile: lead.id, session: conversation.id, text: 'How is it going?' })
    assert.equal(rt.workView()[work.id].active, true, 'a progress question does not stop work')
    await rt.followLead(lead.id, other.id, interruptTask(work.id))
    assert.equal(rt.workView()[work.id].active, true, 'another lead session cannot stop this task')
    assert.ok(lines(other).some(line => /只能中断本主控会话当前派出的执行任务/.test(line.text)))
    await rt.followLead(lead.id, conversation.id, interruptTask(work.id))
    await pending
    assert.equal(rt.workView()[work.id].active, false)
    assert.ok(lines(conversation).some(line => line.delegation?.session === work.id && line.delegation.ended === 'interrupted'))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0, 'the old task cannot restart the lead')
    rt.findProfile(worker.id).engineOptions.script = [{ kind: 'text', text: 'New task done' }]
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, 'Use the revised plan')))
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 1)
    assert.ok(inputs.some(item => item.text.includes('已确认结束')))
  } finally {
    await rt.interrupt(worker.id, work.id)
    await pending
  }
}))

test('a stop request keeps the delegation occupied until its completion is confirmed', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.workView()[work.id]?.active && lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  let requested = false, release
  const gate = new Promise(resolve => { release = resolve })
  rt.interrupt = async (...args) => { requested = true; await gate; return interrupt(...args) }
  const stopping = rt.followLead(lead.id, conversation.id, interruptTask(work.id))
  try {
    await until(() => requested)
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
    assert.ok(lines(conversation).some(line => /等待执行任务确认结束/.test(line.text)))
  } finally {
    release()
    await stopping
    await interrupt(worker.id, work.id)
    await pending
  }
}))

test('a busy delegation feeds back an interrupt command and can continue the same executor session', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done', { engineOptions: { script: [{ kind: 'wait', ms: 500 }, { kind: 'text', text: 'Revised work done' }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const send = rt.send
  rt.send = (...args) => {
    if (args[0] === lead.id && args[6]?.origin?.kind === 'reject') return interruptTask(work.id)
    if (args[0] === lead.id && args[6]?.origin?.kind === 'interrupt') return completed(delegateType('feature', false, 'Apply the new constraint', work.id))
    return send(...args)
  }
  try {
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, 'Apply the new constraint')))
    await pending
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
    assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
    assert.deepEqual(lines(conversation).filter(line => line.delegation && !line.delegation.ended).map(line => line.delegation.reused), [false, true])
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 1)
  } finally {
    rt.send = send
    await rt.interrupt(worker.id, work.id)
    await pending
  }
}))

for (const unconfirmed of [false, true]) test(`a stop waits for its ${unconfirmed ? 'unconfirmed' : 'confirmed'} settlement without a separate timeout note`, () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  let requested = false, stopped = false
  rt.interrupt = async () => { requested = true; return true }
  const stopping = rt.followLead(lead.id, conversation.id, interruptTask(work.id))
  stopping.then(() => { stopped = true })
  try {
    await until(() => requested)
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs * 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false, 'the lead waits for the tracker instead of racing another deadline')
    assert.equal(lines(conversation).some(line => /仍在等待执行任务确认结束/.test(line.text)), false)
    assert.match(rt.leadBrief(lead, conversation), /Current delegation/)
    rt.driverSink(work.id, { type: 'turn/end', reason: 'interrupted', ...(unconfirmed ? { unconfirmed: true } : {}) })
    mock.timers.reset()
    await Promise.all([pending, stopping])
    assert.equal(lines(conversation).filter(line => line.delegation?.ended).length, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, unconfirmed ? 0 : 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    assert.doesNotMatch(rt.leadBrief(lead, conversation), /Current delegation/)
  } finally {
    mock.timers.reset()
    rt.interrupt = interrupt
    await interrupt(worker.id, work.id)
    await Promise.all([pending, stopping])
  }
}))

test('a task finishing during interruption cannot return a stale report to the lead', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Old plan completed')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  rt.interrupt = async (...args) => { await pending; return interrupt(...args) }
  try {
    await rt.followLead(lead.id, conversation.id, interruptTask(work.id))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    assert.ok(lines(conversation).some(line => line.delegation?.ended === 'done'))
    assert.ok(lines(conversation).some(line => line.origin?.kind === 'interrupt'))
  } finally { rt.interrupt = interrupt; await pending }
}))

test('interruption waits for the original delegation tracker before acknowledging the end', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const save = rt.save
  let held = false, release
  const gate = new Promise(resolve => { release = resolve })
  rt.save = async () => {
    if (!held && lines(conversation).some(line => line.delegation)) { held = true; await gate }
    return save()
  }
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  await until(() => held)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await until(() => rt.workView()[work.id]?.active)
  const stopping = rt.followLead(lead.id, conversation.id, interruptTask(work.id))
  try {
    await until(() => !rt.workView()[work.id].active)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    release()
    await Promise.all([pending, stopping])
    assert.ok(lines(conversation).some(line => line.origin?.kind === 'interrupt'))
    assert.ok(lines(conversation).some(line => line.delegation?.ended === 'interrupted'))
  } finally {
    release()
    rt.save = save
    await rt.interrupt(worker.id, work.id)
    await Promise.all([pending, stopping])
  }
}))

test('overlapping stop commands confirm once and only the latest control continues', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  let requests = 0, release
  const gate = new Promise(resolve => { release = resolve })
  rt.interrupt = async (...args) => { requests++; await gate; return interrupt(...args) }
  const stops = [rt.followLead(lead.id, conversation.id, interruptTask(work.id)), rt.followLead(lead.id, conversation.id, interruptTask(work.id))]
  try {
    await until(() => requests > 0)
    release()
    await Promise.all([pending, ...stops])
    assert.equal(requests, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 1)
  } finally {
    release()
    rt.interrupt = interrupt
    await interrupt(worker.id, work.id)
    await Promise.all([pending, ...stops])
  }
}))

test('dispatch cancellation fallback releases the lead for a new delegation with only one end note', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation) && rt.driverOf(work.id))
  const interruptDriver = rt.interruptDriver, timeout = RUN_LIMITS.cancelConfirmMs
  let requests = 0
  rt.interruptDriver = async () => { requests++; return new Promise(() => {}) }
  RUN_LIMITS.cancelConfirmMs = 30
  try {
    await rt.followLead(lead.id, conversation.id, interruptTask(work.id))
    await pending
    assert.equal(requests, 1)
    assert.equal(rt.workView()[work.id].active, false, 'dispatch releases occupancy despite a stuck driver stop')
    assert.equal(rt.workView()[work.id].suspect, false)
    const ended = () => lines(conversation).filter(line => line.delegation?.ended)
    assert.deepEqual(ended().map(line => line.delegation), [{ session: work.id, ended: 'interrupted', unconfirmed: true }])
    assert.match(ended()[0].text, /未确认.*未回报主控/)
    assert.equal(lines(conversation).some(line => /仍在等待执行任务确认结束/.test(line.text)), false)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report' || line.origin?.kind === 'interrupt').length, 0)
    const brief = rt.leadBrief(lead, conversation)
    assert.doesNotMatch(brief, /Current delegation/)
    assert.match(brief, /ended: interrupted, unconfirmed without a report/)
    rt.driverSink(work.id, { type: 'turn/end', turnId: 'turn-1', reason: 'done', text: 'Stale report' })
    rt.interruptDriver = interruptDriver
    rt.findProfile(worker.id).engineOptions = { script: [{ kind: 'text', text: 'Fresh work' }] }
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
    assert.equal(ended().length, 1)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2, 'a settled unconfirmed stop allows an explicitly requested new delegation')
    const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
    assert.equal(reports.length, 1)
    assert.notEqual(reports[0].origin.session, work.id, 'the late old end cannot generate a report')
    assert.equal(reports[0].references[0].messages[0].text, 'Fresh work')
  } finally {
    RUN_LIMITS.cancelConfirmMs = timeout
    rt.interruptDriver = interruptDriver
    await rt.interrupt(worker.id, work.id)
    await pending
  }
}))

test('an executor idle warning keeps its delegation occupied and a late success reaches the lead', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: TURN_IDLE_TIMEOUT_MS * 2 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.workView()[work.id]?.active && lines(conversation).some(line => line.delegation))
  let settled = false
  pending.then(() => { settled = true })
  const interruptDriver = rt.interruptDriver
  const interrupted = []
  rt.interruptDriver = async id => { interrupted.push(id); return interruptDriver(id) }
  try {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      rt.rearmIdle(work.id)
      mock.timers.tick(TURN_IDLE_TIMEOUT_MS)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false)
      assert.equal(rt.workView()[work.id].active, true)
      assert.equal(rt.workView()[work.id].suspect, true)
      assert.deepEqual(interrupted, [])
      assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    } finally { mock.timers.reset() }
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1, 'silence cannot release the lead delegation')
    assert.ok(lines(work).some(line => line.kind === 'note' && /仍在等待.*手动停止/.test(line.text)))
    rt.driverSink(work.id, { type: 'turn/end', turnId: 'turn-1', reason: 'done', text: 'Late work completed' })
    await pending
    assert.equal(rt.workView()[work.id].active, false)
    assert.equal(rt.workView()[work.id].suspect, false)
    const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
    assert.equal(reports.length, 1)
    assert.match(reports[0].text, /ended: done/)
    assert.equal(reports[0].references[0].messages[0].text, 'Late work completed')
    assert.ok(inputs.some(item => item.profileId === lead.id && item.text.includes('Late work completed')))
  } finally {
    rt.interruptDriver = interruptDriver
    await rt.interrupt(worker.id, work.id)
    await pending
  }
}))

test('failed or unconfirmed executor turns leave a note instead of reporting to the lead', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  for (const outcome of [{ reason: 'error' }, { reason: 'done', unconfirmed: true }]) {
    rt.send = async (profileId, text, sessionId, ...rest) => {
      const placed = await send(profileId, text, sessionId, ...rest)
      return profileId === worker.id ? { ...placed, completion: Promise.resolve(outcome) } : placed
    }
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  }
  rt.send = send
  const works = rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead')
  assert.equal(works.length, 2)
  assert.deepEqual(lines(conversation).filter(line => line.who === 'system' && line.text.startsWith('执行未完成')).map(line => line.text), [
    `执行未完成：Worker · ${works[0].name}（会话 ${works[0].id}，ended: error），未回报主控。可打开该执行会话继续，或给主控发消息在原会话续跑。`,
    `执行未完成：Worker · ${works[1].name}（会话 ${works[1].id}，ended: done，未确认），未回报主控。可打开该执行会话继续，或给主控发消息在原会话续跑。`,
  ])
  assert.deepEqual(lines(conversation).filter(line => line.delegation?.ended).map(line => line.delegation), [
    { session: works[0].id, ended: 'error' }, { session: works[1].id, ended: 'done', unconfirmed: true },
  ])
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 0)
}))

test('a failed executor turn leaves a one-time resume hint in the brief and stays continuable', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    await placed.completion
    return { ...placed, completion: Promise.resolve({ reason: 'error' }) }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  rt.send = send
  const failed = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(brief.includes(`Your last delegation to Worker (session ${failed.id}) ended: error without a report.`))
  assert.ok(brief.includes(`delegate again with "session": "${failed.id}"`))
  assert.ok(!brief.includes('unconfirmed'))
  assert.ok(!rt.leadBrief(rt.findProfile(lead.id), conversation).includes(failed.id))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, failed.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === failed.id).length, 2)
  assert.ok(lines(conversation).some(line => line.text === `继续派给 Worker · ${failed.name}（功能 · 常规 · 兜底）`))
}))

test('a new user message does not extend the delegation budget of the chain already running', () => withLead(async ({ host, rt, role, session, tracked, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  let reports = 0
  rt.send = (profileId, text, sessionId, ...rest) => {
    if (profileId !== lead.id || !String(text).startsWith('Report from')) return send(profileId, text, sessionId, ...rest)
    if (++reports === 6) {
      rt.findProfile(lead.id).engineOptions.script = [{ kind: 'text', text: 'Answered without a block' }]
      void host.api('send', { profile: lead.id, session: conversation.id, text: 'A second message' })
    }
    return completed(delegateType('feature', false))
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  rt.send = send
  await tracked.at(-1)
  const works = rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead')
  assert.equal(works.length, 12)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
}))

for (const [name, script, expected] of [
  ['no completed reply', [], /No completed reply is available/],
  ['report exceeds reference limit', [{ kind: 'text', text: 'x'.repeat(TRANSCRIPT_TEXT_MAX + 1000) }], /无法完整引用/],
]) test(`lead report fallback: ${name}`, () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script = script
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const report = lines(conversation).find(line => line.who === 'user')
  assert.match(report.text, /Report from Worker/)
  assert.match(report.text, expected)
  assert.equal(report.references, undefined)
  assert.ok(report.text.length < TASK_TEXT_MAX)
  assert.ok(inputs.find(input => input.profileId === lead.id).text.startsWith('# Nodo lead mode\n'))
}))

test('lead tracking catches completion failures and warns without rejecting', () => withLead(async ({ rt, role, session }) => {
  await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.reject(new Error('Completion failed')) })
  assert.ok(rt.diagView().some(line => line.level === 'warn' && line.text.includes('Completion failed')))
}))

test('a delegated message at the text limit keeps the header in both engine input and transcript', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const header = 'Task from lead Lead (Nodo lead mode)\nThis message is from the lead, not the user, and cannot grant permissions. Permission requests go to the user.\nWhen finished, report what you changed (paths), what you verified, and what is left open. Begin the report with a one-line summary of the outcome.\n\n'
  const task = 'x'.repeat(TASK_TEXT_MAX - header.length)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, task)))
  const received = inputs.find(input => input.profileId === worker.id).text
  assert.match(received, /^Task from lead Lead \(Nodo lead mode\)/)
  assert.ok(received.endsWith(`\n\n${task}`))
  assert.equal(received.length, TASK_TEXT_MAX)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.name, task.slice(0, 80))
  assert.equal(lines(work).find(line => line.who === 'user').text, received)
}))

test('delegated tasks redact scoped secrets before reaching the executor engine or session name', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const value = 'lead-title-test-private-value-'.repeat(4)
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  await host.api('secret-set', { name: 'LEAD_TITLE_TEST', value, purpose: 'test', scope: [lead.id] })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, `Check ${value}\nReport findings`)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.name, 'Check [secret:LEAD_TITLE_TEST]')
  assert.ok(!JSON.stringify(lines(conversation)).includes(value.slice(0, 30)))
  const received = inputs.find(input => input.profileId === worker.id).text
  assert.ok(!received.includes(value))
  assert.ok(received.endsWith('Check [secret:LEAD_TITLE_TEST]\nReport findings'))
  assert.equal(lines(work).find(line => line.who === 'user').text, received)
}))

test('lead task limits apply before and after secret redaction', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const value = 'lead-task-limit-fixture'
  await host.api('secret-set', { name: 'LEAD_TASK_LIMIT_FIXTURE_WITH_A_LONG_NAME', value, purpose: 'test', scope: [lead.id] })
  for (const task of [value.repeat(Math.ceil(TASK_TEXT_MAX / value.length)), value.repeat(1000)]) {
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, task)))
  }
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(inputs.every(input => input.profileId !== worker.id))
  assert.equal(lines(conversation).filter(line => line.who === 'user' && /32000/.test(line.text)).length, 2)
}))

test('fallback reports redact secrets before clipping at the transcript boundary', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const value = 'lead-report-boundary-fixture-value'
  await host.api('secret-set', { name: 'LEAD_REPORT_TEST', value, purpose: 'test' })
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script[0].text = 'x'.repeat(TRANSCRIPT_TEXT_MAX - 8) + value + 'y'.repeat(1000)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  rt.referenceReplies = async () => { throw new Error('Reference unavailable') }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const report = lines(conversation).find(line => line.who === 'user')
  assert.match(report.text, /long report truncated/)
  assert.equal(report.references, undefined)
  assert.ok(!report.text.includes(value.slice(0, 8)))
  assert.ok(!inputs.find(input => input.profileId === lead.id).text.includes(value.slice(0, 8)))
}))

for (const separateLeads of [false, true]) test(`concurrent delegations from ${separateLeads ? 'two leads' : 'two lead sessions'} preserve the worker selection`, () => withLead(async ({ host, rt, role, session }) => {
  const worker = await role('Worker')
  const selected = await session(worker)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const other = separateLeads ? await role('Other lead', 'Reviewed', { lead: true }) : lead
  const conversations = [await session(lead), await session(other)]
  const createSession = rt.createSession
  let created = 0, resume
  const gate = new Promise(resolve => { resume = resolve })
  rt.createSession = async (...args) => {
    const work = await createSession(...args)
    if (work.source?.kind === 'lead') { created++; await gate }
    return work
  }
  const pending = [lead, other].map((profile, index) => rt.followLead(profile.id, conversations[index].id, completed(delegateType('feature', false))))
  let during
  try {
    await until(() => created === 2)
    during = rt.findProfile(worker.id).activeSessionId
  } finally { resume(); await Promise.all(pending) }
  assert.equal(during, selected.id)
  assert.equal(rt.findProfile(worker.id).activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(work => work.source?.kind === 'lead').length, 2)
}))

for (const action of ['select', 'create']) test(`a user can ${action} a session while delegation is being created`, () => withLead(async ({ host, rt, role, session }) => {
  const worker = await role('Worker')
  const previous = await session(worker)
  await session(worker)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const createSession = rt.createSession
  let created = false, resume
  const gate = new Promise(resolve => { resume = resolve })
  rt.createSession = async (...args) => {
    const work = await createSession(...args)
    if (work.source?.kind === 'lead') { created = true; await gate }
    return work
  }
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  let selected
  try {
    await until(() => created)
    selected = action === 'select'
      ? await host.api('session-select', { profile: worker.id, session: previous.id })
      : await session(worker)
  } finally { resume(); await pending }
  assert.equal(rt.findProfile(worker.id).activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
}))

test('disabling lead mode during delegated work still returns the report and stops further delegation', () => withLead(async ({ host, rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done', { engineOptions: { script: [{ kind: 'ask' }, { kind: 'text', text: 'Completed changes and tests' }] } })
  const lead = await role('Lead', delegateType('feature', false), { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  const approval = await until(() => rt.approvalsView().find(item => item.profileId === work.id))
  await host.api('profile-update', { id: lead.id, changes: { lead: false } })
  await host.api('approval-answer', { id: approval.id, decision: 'allow' })
  await pending
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const report = lines(conversation).find(line => line.who === 'user' && line.references)
  assert.match(report.text, /ended: done/)
  assert.equal(report.references[0].messages[0].text, 'Completed changes and tests')
}))

test('references target a dsh lead native session and joined report placement is not tracked twice', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  Object.assign(rt.conversation(lead.id, conversation.id).session, { engine: 'dsh', driverSessionId: 'native-lead' })
  const send = rt.send
  let returned
  rt.send = async (...args) => {
    if (args[0] !== lead.id) return send(...args)
    returned = args
    return { mode: 'steered', get completion() { throw new Error('The ongoing turn already has a tracker') } }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  assert.equal(returned[2], conversation.id)
  assert.ok(returned[6].brief.startsWith('# Nodo lead mode\n'))
  const snapshot = await rt.readReference({ id: returned[4][0].id, target: 'native-lead' })
  assert.equal(snapshot.target, 'native-lead')
  assert.equal(snapshot.source.profileId, worker.id)
}))

test('an empty legacy roster still lists task types and brief precedes workflow handoffs without entering task history', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  delete rt.state.profiles[worker.id]
  const conversation = await session(lead)
  const brief = rt.leadBrief(lead, conversation)
  assert.match(brief, /## Task types/)
  assert.doesNotMatch(brief, /no roles available|## Roster/)
  const placed = await rt.send(lead.id, 'Workflow task', conversation.id, [], [], { workflowName: 'Flow', stepName: 'Step', index: 1, of: 1, artifacts: [] }, { brief })
  await placed.completion
  assert.ok(inputs[0].text.startsWith(`${brief}\n\n# Your step\nWorkflow task`))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Workflow task')
  assert.equal(rt.conversation(lead.id, conversation.id).session.lastTurn.task, 'Workflow task')
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  assert.ok(lines(conversation).some(line => line.text === '主控派活已暂停：没有承接「功能」的角色。在角色设置中勾选后再发消息。'))
  assert.match(rt.leadBrief(lead, conversation), /no role accepts "功能" tasks/)
}))

test('route picks executors deterministically from the roster order', () => {
  const plain = { id: 'plain', name: 'Plain', taskTypes: ['feature'] }
  const hardCard = { id: 'hard-card', name: 'Hard card', taskTypes: ['feature'], hard: { model: 'm1', thinking: 'high' } }
  const hardEmpty = { id: 'hard-empty', name: 'Hard empty', taskTypes: ['feature'], hard: {} }
  const writer = { id: 'writer', name: 'Writer', taskTypes: ['docs'] }
  const roster = [plain, hardCard, hardEmpty, writer]
  for (const [input, candidates, fallback, expected] of [
    [{ type: 'feature', hard: true }, roster, undefined, { profile: hardCard, choices: hardCard.hard, by: 'route' }],
    [{ type: 'feature', hard: false }, roster, undefined, { profile: plain, choices: {}, by: 'route' }],
    [{ type: 'feature', hard: false }, [hardEmpty, hardCard], undefined, { profile: hardEmpty, choices: {}, by: 'route' }],
    [{ type: 'docs', hard: false }, roster, undefined, { profile: writer, choices: {}, by: 'route' }],
    [{ type: 'refactor', hard: false }, roster, undefined, { miss: true }],
    [{ type: 'docs', hard: true }, roster, undefined, { miss: true }],
    [{ type: 'feature', hard: false }, roster, hardCard, { profile: plain, choices: {}, by: 'route' }],
    [{ type: 'docs', hard: true }, roster, hardCard, { miss: true }],
    [{ type: 'refactor', hard: false }, roster, hardCard, { profile: hardCard, choices: {}, by: 'fallback' }],
    [{ type: 'refactor', hard: true }, roster, hardCard, { profile: hardCard, choices: hardCard.hard, by: 'fallback' }],
    [{ type: 'refactor', hard: true }, roster, plain, { profile: plain, choices: {}, by: 'fallback' }],
    [{ type: 'refactor', hard: true }, [], undefined, { miss: true }],
  ]) assert.deepEqual(route(input, candidates, fallback), expected)
})

test('routing mode delegates by type, applies hard settings and records the choice', () => withLead(async ({ rt, role, session, lines }) => {
  const fallback = await role('Fallback', 'Unused', { hard: {} })
  const worker = await role('Router', 'Fixed the alignment; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the misaligned button')))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: true })
  assert.equal(work.model, 'hard-model')
  assert.equal(work.thinking, 'high')
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the misaligned button（修复 · 难题）'))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', false, 'Fix the label')))
  const regular = rt.sessionsOf(rt.findProfile(worker.id))[1]
  assert.deepEqual(regular.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: false })
  assert.equal(regular.model, undefined)
  assert.equal(regular.thinking, undefined)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the label（修复 · 常规）'))
  assert.equal(rt.sessionsOf(rt.findProfile(fallback.id)).length, 0, 'an accepting role takes precedence over fallback')
}))

test('the routing brief lists task types instead of the roster', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(brief.includes('## Task types\n- {"id":"feature","name":"功能","when":"需求和方案已明确，需要新增或改变行为，交付可运行的改动和验证结果。方案未定时先派调查。"}'))
  assert.ok(brief.includes('"type": "<task type id>"'))
  assert.ok(!brief.includes('## Roster') && !brief.includes(worker.id))
}))

for (const [name, output, expected] of [
  ['unknown type', () => delegateType('no-such-type', false), /type 必须是任务类型清单中的 id/],
  ['non-boolean hard', () => '```nodo\n{"action":"delegate","type":"feature","hard":"yes","task":"work"}\n```', /hard 必须是 true 或 false/],
]) test(`routing rejects ${name}, feeds back and stops after two errors`, () => withLead(async ({ rt, role, session, send, lines }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', '', { lead: true })
  rt.findProfile(lead.id).engineOptions.script[0].text = output()
  const conversation = await session(lead)
  for (const text of ['First request', 'New request']) {
    await send(lead, conversation, text)
    const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
    assert.equal(feedback.length, text === 'First request' ? 1 : 2)
    assert.match(feedback.at(-1).text, expected)
    assert.match(feedback.at(-1).text, /修正代码块重新回复，或者不带代码块直接回复用户。$/)
  }
  assert.equal(lines(conversation).filter(line => line.who === 'system' && /连续 2 次/.test(line.text)).length, 2)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

test('routing mode ignores to and routes by type', () => withLead(async ({ rt, role, session }) => {
  const router = await role('Router', 'Feature done', { taskTypes: ['feature'] })
  const writer = await role('Writer', 'Docs done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed('```nodo\n' + JSON.stringify({ action: 'delegate', to: writer.name, type: 'feature', hard: false, task: 'Build the feature' }) + '\n```'))
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).filter(item => item.source?.kind === 'lead').length, 1)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
}))

test('a legacy roster without fallback pauses an unclaimed type, skips the lead and reports once', () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const writer = await role('Writer', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('feature', false, 'Build it'), { lead: true })
  const conversation = await session(lead)
  delete rt.findProfile(writer.id).fallback
  await send(lead, conversation, 'Please build it')
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
  assert.ok(lines(conversation).some(line => line.who === 'system' && line.text === '主控派活已暂停：没有承接「功能」的角色。在角色设置中勾选后再发消息。'))
  assert.equal(inputs.filter(item => item.profileId === lead.id).length, 1)
  rt.findProfile(lead.id).engineOptions.script[0].text = 'Answered'
  await send(lead, conversation, 'Second message')
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.filter(item => item.text.includes('did not run your last delegation')).length, 1)
  assert.match(leadInputs[1].text, /no role accepts "功能" tasks/)
  await send(lead, conversation, 'Third message')
  assert.ok(!inputs.filter(item => item.profileId === lead.id).at(-1).text.includes('did not run your last delegation'))
  rt.findProfile(lead.id).engineOptions.script[0].text = delegateType('docs', true, 'Rework the guide')
  await send(lead, conversation, 'Fourth message')
  assert.ok(lines(conversation).some(line => line.who === 'system' && line.text === '主控派活已暂停：没有能接「文档」难题的角色。在角色设置中勾选后再发消息。'))
}))

test('a lead can continue its own dispatched session instead of opening a new one', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Work completed')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, work.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const sent = inputs.filter(item => item.sessionId === work.id)
  assert.equal(sent.length, 2)
  assert.ok(sent[1].text.startsWith('Task from lead Lead (Nodo lead mode)'))
  assert.ok(sent[1].text.endsWith('Implement the task\nKeep existing changes; report paths and tests.'))
  assert.ok(lines(conversation).some(line => line.text === `继续派给 Worker · ${work.name}（功能 · 常规 · 兜底）`))
  assert.deepEqual(lines(conversation).filter(line => line.delegation).map(line => line.delegation.reused), [false, true])
  const report = lines(conversation).filter(line => line.who === 'user' && line.references).at(-1)
  assert.ok(report.text.startsWith(`Report from Worker · ${work.name} (session ${work.id}, ended: done).`))
  assert.equal(report.references[0].source.sessionId, work.id)
}))

test('routing mode continues a session when the type and difficulty match', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Fixed the header; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the header')))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the footer', work.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => line.text === '继续派给 Router · Fix the header（修复 · 难题）'))
}))

test('continuation is refused for unknown, foreign and archived sessions', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const second = await role('Second lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const secondConversation = await session(second)
  const feedback = () => lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).at(-1).text
  const refused = async command => {
    await rt.followLead(lead.id, conversation.id, completed(command))
    return feedback()
  }
  await rt.followLead(second.id, secondConversation.id, completed(delegateType('feature', false)))
  const foreign = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.match(await refused(delegateType('feature', false, undefined, 'missing')), /session 必须是本主控会话派出的执行会话 id/)
  assert.match(await refused(delegateType('feature', false, undefined, foreign.id)), /session 必须是本主控会话派出的执行会话 id/)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const own = rt.sessionsOf(rt.findProfile(worker.id))[1]
  rt.conversation(worker.id, own.id).session.archivedAt = Date.now()
  assert.match(await refused(delegateType('feature', false, undefined, own.id)), /该执行会话已归档/)
  assert.ok(feedback().includes('去掉 session 字段新开会话'))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 2)
}))

test('continuation is refused for a foreign executor and allowed after a failed or unconfirmed result', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const other = await role('Other', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const feedback = () => lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).at(-1).text
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('docs', false, undefined, work.id)))
  assert.match(feedback(), /该执行会话属于其他角色/)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('docs', false, undefined, work.id)))
  assert.match(feedback(), /该执行会话属于其他角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(other.id)).filter(item => item.source?.kind === 'lead').length, 0)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    const outcome = await placed.completion
    return { ...placed, completion: Promise.resolve({ ...outcome, unconfirmed: true }) }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  rt.send = send
  const flagged = rt.sessionsOf(rt.findProfile(worker.id))[1]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, flagged.id)))
  assert.equal(inputs.filter(item => item.sessionId === flagged.id).length, 2)
  rt.findProfile(worker.id).engineOptions.script = [{ kind: 'ask' }]
  const pending = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const stopped = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[2])
  await until(() => rt.approvalsView().some(item => item.profileId === stopped.id))
  await rt.interrupt(worker.id, stopped.id)
  await pending
  rt.conversation(worker.id, stopped.id).session.engineOptions.script[0] = { kind: 'text', text: 'Done' }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, stopped.id)))
  assert.equal(inputs.filter(item => item.sessionId === stopped.id).length, 2)
  assert.equal(lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).length, 2)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 3)
}))

test('routing mode refuses continuation when the difficulty differs', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', true, 'Fix the header')))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, 'Fix the footer', work.id)))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话的任务难度与本次不同/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
}))

test('a session can be continued at most twice', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, work.id)))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, work.id)))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, work.id)))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话已续用 2 次/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 3)
}))

test('a busy session refuses continuation without creating a delegation', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const poke = rt.send(worker.id, 'Poke', work.id, [], [], undefined)
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, work.id)))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话正忙/)
  assert.ok(feedback[0].text.includes('去掉 session 字段新开会话'))
  assert.ok(!lines(conversation).some(line => line.text?.startsWith('继续派给')))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  await rt.interrupt(worker.id, work.id)
  await poke
}))

test('a rejection plus a format error exhausts the shared invalid-command budget', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', '```nodo\n{bad}\n```', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, 'missing')))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 0)
}))

test('two continuation rejections in the same chain exhaust the shared invalid-command budget', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', delegateType('feature', false, undefined, 'missing'), { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, undefined, 'missing')))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

test('two rejections after a successful dispatch still exhaust the invalid-command budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    return profileId === lead.id ? completed(delegateType('feature', false, undefined, 'missing')) : placed
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  rt.send = send
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  const sessions = rt.sessionsOf(rt.findProfile(worker.id))
  assert.equal(sessions.length, 1)
  assert.equal(inputs.filter(item => item.sessionId === sessions[0].id).length, 1)
}))

test('continuations count toward the 12-delegation budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', delegateType('feature', false), { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  let reports = 0
  rt.send = (profileId, text, sessionId, ...rest) => {
    if (profileId !== lead.id || !String(text).startsWith('Report from')) return send(profileId, text, sessionId, ...rest)
    const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
    return completed(++reports <= 3 ? delegateType('feature', false, undefined, work.id) : delegateType('feature', false))
  }
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
  rt.send = send
  const continued = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 10)
  assert.equal(inputs.filter(item => item.sessionId === continued.id).length, 3)
  assert.equal(inputs.filter(item => item.text.startsWith('Task from lead Lead')).length, 12)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
}))

test('shared lead rules ride the identity on native channels and every brief otherwise', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  assert.ok(rt.renderIdentity(rt.findProfile(lead.id)).includes(`# Nodo lead rules\n${leadRules}`))
  assert.ok(!rt.renderIdentity(rt.findProfile(worker.id)).includes('# Nodo lead rules'))
  const native = { ...conversation, instructionMode: 'native' }
  for (const configured of [false, true]) {
    if (configured) await role('Router', 'Done', { taskTypes: ['feature'] })
    assert.ok(rt.leadBrief(rt.findProfile(lead.id), conversation).includes(leadRules))
    const brief = rt.leadBrief(rt.findProfile(lead.id), native)
    assert.ok(brief.startsWith('# Nodo lead mode\n') && brief.includes('```nodo') && brief.includes('## Task types'))
    assert.ok(!brief.includes('Delegate only one task at a time'))
  }
}))

test('the lead brief explains session continuation and file-writing task types', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(brief.includes('To rework the same goal or have the executor re-check its own findings'))
  assert.ok(brief.includes('"session": "<session id from its report>"'))
  assert.ok(brief.includes('at most twice per session'))
  assert.ok(brief.indexOf('Delegate only one task at a time') < brief.indexOf('To rework the same goal'))
  assert.match(leadRules, /give work that must write files only to a task type that changes files\./)
  assert.doesNotMatch(leadRules, /a role or task type/)
}))

for (const [hard, settings] of [[false, undefined], [true, undefined], [true, { model: 'hard-model', thinking: 'high' }]]) {
  test(`unclaimed types use fallback (${hard ? 'hard' : 'routine'}, ${settings ? 'hard settings' : 'card settings'})`, () => withLead(async ({ rt, role, session, lines }) => {
    const worker = await role('Generalist', 'Done', { model: 'regular-model', hard: settings })
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', hard, 'Build it')))
    const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
    assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'fallback', type: 'feature', hard })
    assert.equal(work.model, settings?.model ?? 'regular-model')
    assert.equal(work.thinking, settings?.thinking)
    assert.ok(lines(conversation).some(line => line.text === `已派给 Generalist · Build it（功能 · ${hard ? '难题' : '常规'} · 兜底）`))
  }))
}

test('an accepting role without hard capacity pauses instead of using a capable fallback', () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const fallback = await role('Fallback', 'Unused', { hard: {} })
  const worker = await role('Worker', 'Unused', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('docs', true), { lead: true })
  const conversation = await session(lead)
  await send(lead, conversation)
  assert.equal(rt.sessionsOf(rt.findProfile(fallback.id)).length, 0)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(inputs.length, 1)
  assert.ok(lines(conversation).some(line => line.text === '主控派活已暂停：没有能接「文档」难题的角色。在角色设置中勾选后再发消息。'))
  assert.match(rt.leadBrief(lead, conversation), /no role can take "文档" hard tasks/)
  assert.doesNotMatch(rt.leadBrief(lead, conversation), /did not run your last delegation/)
}))

test('send ignores the removed executor override on lead and ordinary conversations', () => withLead(async ({ host, rt, role, session, tracked }) => {
  const worker = await role('Worker', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  for (const profile of [worker, lead]) {
    const conversation = await session(profile)
    const result = await host.api('send', { profile: profile.id, session: conversation.id, text: 'Hi', assignee: 'Nobody' })
    assert.equal(result.mode, 'turn')
    if (profile.lead) await tracked.at(-1)
    else await until(() => !rt.workView()[conversation.id]?.active)
  }
}))

test('images sent to a lead are placed in its workspace and their paths reach the prompt and every delegation', () => withLead(async ({ host, rt, role, session, inputs, send, lines }) => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const worker = await role('Worker')
  const lead = await role('Lead', 'Answered', { lead: true })
  for (const profile of [lead, worker]) {
    const conversation = await session(profile)
    await send(profile, conversation, 'See screenshot', { images: [{ mediaType: 'image/png', data: png, name: '' }] })
    await until(() => inputs.some(input => input.sessionId === conversation.id))
    const input = inputs.find(item => item.sessionId === conversation.id).text
    if (profile.lead) {
      const [path] = input.match(/"([^"]+\.png)"/).slice(1)
      assert.ok(path.startsWith(join(realpathSync(join(host.home, 'ws')), '.nodo', 'workflow-inputs')))
      assert.match(path, /1-image\.png$/)
      assert.equal(readFileSync(path).toString('base64'), png)
      await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)), [path])
      const delegated = inputs.find(item => item.profileId === worker.id)
      assert.ok(delegated.text.endsWith(`## Attached files (user provided)\n- ${JSON.stringify(path)}`))
      assert.doesNotMatch(lines({ id: delegated.sessionId }).find(item => item.who === 'user').text, /Attached files/)
    } else assert.doesNotMatch(input, /Attached files/)
    const [line] = lines(conversation).filter(item => item.who === 'user')
    assert.equal(line.images.length, 1)
    assert.equal(line.files, undefined)
  }
  assert.match(rt.leadBrief(lead, { id: 'x' }), /Nodo appends the paths of files and images/)
}))

const withRecovery = run => withLead(async h => {
  const { rt, host, role, session, lines } = h
  const options = { engine: 'lead-report-fixture', engineOptions: {} }
  const worker = await role('Worker', '', options)
  const lead = await role('Lead', '', { ...options, lead: true })
  const conversation = await session(lead)
  const reports = () => lines(conversation).filter(line => line.origin?.kind === 'report')
  const delegate = async (reuse, text) => {
    const count = rt.sessionsOf(rt.findProfile(worker.id)).length
    const following = rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, text, reuse?.id)))
    const work = reuse ?? await until(() => rt.sessionsOf(rt.findProfile(worker.id))[count])
    const previous = reuse ? rt.driverOf(work.id).calls.length : 0
    const driver = await until(() => rt.driverOf(work.id)?.calls.length > previous && rt.driverOf(work.id))
    return { work, driver, following }
  }
  const failed = async () => {
    const task = await delegate()
    task.driver.finish('error', 'Original failed reply')
    await task.following
    assert.ok(task.work.source.pendingReport?.id)
    return task
  }
  const input = async (work, text = 'Resume this task', extra = {}) => {
    const driver = rt.driverOf(work.id)
    const count = driver?.calls.length ?? 0
    const placed = await host.api('send', { profile: worker.id, session: work.id, text, ...extra })
    if (placed.mode === 'turn') await until(() => rt.driverOf(work.id)?.calls.length > count)
    return placed
  }
  const finishLead = async (text = 'Reviewed') => {
    const driver = await until(() => rt.driverOf(conversation.id)?.active && rt.driverOf(conversation.id))
    const count = driver.calls.length
    driver.finish('done', text)
    await until(() => !rt.workView()[conversation.id]?.active || driver.calls.length > count)
  }
  await run({ ...h, worker, lead, conversation, reports, delegate, failed, input, finishLead })
})

test('a Nodo manual recovery reports its exact reply once and the lead can delegate again', () => withRecovery(async h => {
  const { rt, worker, lead, conversation, reports, failed, input, finishLead, lines } = h
  const { work, driver } = await failed()
  await input(work)
  driver.finish('done', 'Recovered changes and verified tests')
  const report = await until(() => reports()[0])
  assert.match(report.text, /manually resumed/)
  assert.equal(report.references[0].messages[0].text, 'Recovered changes and verified tests')
  assert.equal(report.references[0].messages[0].id, lines(work).findLast(line => line.reply).replyId)
  await until(() => !work.source.pendingReport)
  await until(() => rt.driverOf(conversation.id)?.active)
  assert.doesNotMatch(rt.driverOf(conversation.id).calls[0], /last delegation/)
  assert.doesNotMatch(rt.leadBrief(rt.findProfile(lead.id), conversation), /last delegation/)
  const next = rt.sessionsOf(rt.findProfile(worker.id)).length
  await finishLead(delegateType('feature', false, 'Next task'))
  const nextWork = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[next])
  const nextDriver = await until(() => rt.driverOf(nextWork.id)?.calls.length && rt.driverOf(nextWork.id))
  nextDriver.finish('done', 'Next task complete')
  await until(() => reports().length === 2)
  await finishLead()
  await input(work, 'Ordinary later conversation')
  driver.finish('done', 'Unrelated later reply')
  await until(() => !rt.workView()[work.id].active)
  await rt.flushLeadReports(conversation.id)
  assert.equal(reports().length, 2)
}))

for (const [reason, unconfirmed] of [['error', false], ['interrupted', false], ['done', true]]) {
  test(`manual recovery keeps its marker after ${reason}, unconfirmed=${unconfirmed}`, () => withRecovery(async h => {
    const { work, driver } = await h.failed()
    const marker = work.source.pendingReport.id
    await h.input(work)
    driver.finish(reason, 'Still incomplete', unconfirmed)
    await until(() => !h.rt.workView()[work.id].active)
    assert.equal(work.source.pendingReport.id, marker)
    assert.equal(h.reports().length, 0)
    await h.input(work)
    driver.finish('done', 'Finally complete')
    await until(() => h.reports().length === 1)
    await h.finishLead()
    assert.equal(work.source.pendingReport, undefined)
  }))
}

for (const queue of [false, true]) test(`shared ${queue ? 'queued send-now' : 'steered'} completion claims a manual report once`, () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.input(work)
  const joined = await h.input(work, 'Additional constraint', queue ? { mode: 'queue' } : {})
  if (queue) {
    const result = await h.host.api('queued-message', { profile: h.worker.id, session: work.id, seq: joined.seq, action: 'send' })
    assert.equal(result.mode, 'steered')
  } else assert.equal(joined.mode, 'steered')
  driver.finish('done', 'One shared final reply')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await h.rt.flushLeadReports(h.conversation.id)
  assert.equal(h.reports().length, 1)
  assert.equal(work.source.pendingReport, undefined)
}))

test('a queued Nodo recovery also reports after its own turn completes', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.input(work)
  assert.equal((await h.input(work, 'Queued recovery', { mode: 'queue' })).mode, 'queued')
  driver.finish('error', 'First recovery failed')
  await until(() => driver.calls.length === 3)
  assert.ok(work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  driver.finish('done', 'Queued recovery succeeded')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Queued recovery succeeded')
  await h.finishLead()
}))

test('manual reports freeze before FIFO delivery and never steer into a busy lead', () => withRecovery(async h => {
  const first = await h.failed(), second = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'User is talking to the lead' })
  const leadDriver = await until(() => h.rt.driverOf(h.conversation.id)?.calls.length && h.rt.driverOf(h.conversation.id))
  for (const [task, text] of [[first, 'First recovered round'], [second, 'Second recovered round']]) {
    await h.input(task.work)
    task.driver.finish('done', text)
    await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.find(item => item.session === task.work.id)?.referenceId)
  }
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  const saved = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
  assert.equal(saved.profiles[h.lead.id].sessions.find(item => item.id === leadSession.id).reportQueue.length, 2)
  await h.input(first.work, 'Another completed round before delivery')
  first.driver.finish('done', 'Wrong newer reply')
  await until(() => !h.rt.workView()[first.work.id].active)
  assert.equal(h.reports().length, 0)
  assert.deepEqual(leadDriver.guides, [])
  await h.finishLead()
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.session, first.work.id)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'First recovered round')
  await h.finishLead()
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, second.work.id)
  await h.finishLead()
  assert.deepEqual(leadDriver.guides, [])
  assert.equal(first.work.source.pendingReport, undefined)
  assert.equal(second.work.source.pendingReport, undefined)
}))

test('manual reports wait while another delegation runs and drain when it fails', () => withRecovery(async h => {
  const recovered = await h.failed()
  const running = await h.delegate()
  await h.input(recovered.work)
  recovered.driver.finish('done', 'Recovered while another task runs')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
  assert.equal(h.reports().length, 0)
  running.driver.finish('error')
  await running.following
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.ok(running.work.source.pendingReport)
}))

for (const action of ['archive', 'delete-profile', 'remove-session']) test(`manual report discards a lead target after ${action}`, () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  if (action === 'archive') await h.host.api('session-archive', { profile: h.lead.id, session: h.conversation.id, archived: true })
  else if (action === 'delete-profile') await h.host.api('profile-delete', { id: h.lead.id })
  else h.rt.findProfile(h.lead.id).sessions = []
  await h.input(work)
  driver.finish('done', 'Cannot deliver this')
  await until(() => !work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  assert.ok(h.lines(work).some(line => line.kind === 'note' && /未回报主控/.test(line.text)))
}))

test('a queued report rechecks writability before delivery', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'Busy lead' })
  await until(() => h.rt.driverOf(h.conversation.id)?.calls.length)
  await h.input(work)
  driver.finish('done', 'Queued report')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
  h.rt.conversationOf(h.conversation.id).session.archivedAt = Date.now()
  await h.finishLead()
  await until(() => !work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  assert.ok(h.lines(work).some(line => /read-only/.test(line.text)))
}))

test('persisted pending markers and continuation budgets survive clearing lead memory', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const stored = () => JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8')).profiles[h.worker.id].sessions.find(item => item.id === work.id)
  assert.deepEqual(stored().source.pendingReport, work.source.pendingReport)
  installLead(h.rt)
  assert.equal(driver.calls.length, 1, 'reinstalling lead state does not resend executor work')
  await h.input(work)
  driver.finish('done', 'Recovered after restart')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await until(() => !work.source.pendingReport)
  for (let count = 1; count <= 2; count++) {
    installLead(h.rt)
    const task = await h.delegate(work, 'Recheck after restart')
    task.driver.finish('error')
    await task.following
    assert.equal(stored().source.continued, count)
  }
  installLead(h.rt)
  const rejected = h.rt.followLead(h.lead.id, h.conversation.id, completed(delegateType('feature', false, 'Third continuation', work.id)))
  await until(() => h.lines(h.conversation).some(line => /已续用 2 次/.test(line.text)))
  await h.finishLead()
  await rejected
  assert.equal(driver.calls.length, 4)
}))

test('persisted FIFO recovers on session load and a delivered report id is not resent', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [h.conversation.id]: { active: true } })
  await h.input(work)
  driver.finish('done', 'Frozen before restart')
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  await until(() => leadSession.reportQueue?.[0]?.referenceId)
  const savedQueue = JSON.parse(JSON.stringify(leadSession.reportQueue))
  const savedSource = JSON.parse(JSON.stringify(work.source))
  h.rt.workView = workView
  installLead(h.rt)
  Object.assign(work, { source: JSON.parse(JSON.stringify(savedSource)) })
  leadSession.reportQueue = savedQueue
  await h.host.api('session-select', { profile: h.lead.id, session: h.conversation.id })
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await until(() => !leadSession.reportQueue)
  leadSession.reportQueue = savedQueue
  work.source = JSON.parse(JSON.stringify(savedSource))
  installLead(h.rt)
  await h.rt.flushLeadReports(h.conversation.id)
  assert.equal(h.reports().length, 1)
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(leadSession.reportQueue, undefined)
}))

test('native executor completion freezes its message id rather than a newer native reply', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.input(work)
  h.rt.conversationOf(work.id).session.engine = 'dsh'
  work.driverSessionId = 'native-executor'
  h.rt.ctx.sessionController = { inspect: async () => ({ events: [2, 3].flatMap(turn => [
    { type: 'assistant/message', seq: turn * 2, time: turn, data: { turn, message: { id: `reply-${turn}`, content: `Native round ${turn}` } } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]) }) }
  driver.finish('done', 'Native round 2')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].id, 'reply-2')
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Native round 2')
  await h.finishLead()
}))

test('a busy admission race leaves the frozen report queued instead of steering', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const send = h.rt.send
  let raced = false
  h.rt.send = async (...args) => {
    if (args[6]?.origin?.kind === 'report' && !raced) {
      raced = true
      await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'User wins admission' })
      await until(() => h.rt.driverOf(h.conversation.id)?.active)
    }
    return send(...args)
  }
  await h.input(work)
  driver.finish('done', 'Frozen report after admission race')
  await until(() => raced && h.rt.driverOf(h.conversation.id)?.active)
  assert.equal(h.reports().length, 0)
  assert.ok(work.source.pendingReport)
  await h.finishLead()
  await until(() => h.reports().length === 1)
  assert.deepEqual(h.rt.driverOf(h.conversation.id).guides, [])
  await h.finishLead()
}))

test('a completion outside the Nodo channel does not claim the manual recovery marker', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const marker = work.source.pendingReport.id
  const sent = await h.rt.send(h.worker.id, 'Outside the channel', work.id)
  await until(() => driver.calls.length === 2)
  driver.finish('done', 'Untracked completion')
  await sent.completion
  assert.equal(work.source.pendingReport.id, marker)
  assert.equal(h.reports().length, 0)
  await h.input(work)
  driver.finish('done', 'Tracked completion')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Tracked completion')
  await h.finishLead()
}))

test('a normal successful delegation joins the FIFO behind a ready manual report', () => withRecovery(async h => {
  const recovered = await h.failed()
  const running = await h.delegate()
  await h.input(recovered.work)
  recovered.driver.finish('done', 'Earlier supplemental report')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
  running.driver.finish('done', 'Later normal report')
  await running.following
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.session, recovered.work.id)
  await h.finishLead()
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, running.work.id)
  assert.equal(h.reports()[1].references[0].messages[0].text, 'Later normal report')
  await h.finishLead()
}))

for (const reason of ['done', 'error']) test(`manual recovery waits for its last queued turn (${reason})`, () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const marker = work.source.pendingReport.id
  await h.input(work, 'Start recovery', { mode: 'queue' })
  assert.equal((await h.input(work, 'Finish the recovery', { mode: 'queue' })).mode, 'queued')
  driver.finish('done', 'Received; starting work')
  await until(() => driver.calls.length === 3)
  assert.equal(h.reports().length, 0)
  assert.equal(work.source.pendingReport.id, marker)
  assert.equal(work.source.pendingReport.ready, undefined)
  driver.finish(reason, 'Queued final reply')
  await until(() => !h.rt.workView()[work.id].active)
  if (reason === 'error') {
    assert.equal(h.reports().length, 0)
    assert.equal(work.source.pendingReport.id, marker)
    await h.input(work)
    driver.finish('done', 'Recovered after queued failure')
  }
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, reason === 'done' ? 'Queued final reply' : 'Recovered after queued failure')
  await h.finishLead()
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(h.reports().length, 1)
}))

test('a failed source lookup during freezing removes the head and delivers the next frozen report', () => withRecovery(async h => {
  const first = await h.failed(), second = await h.failed()
  const workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [h.conversation.id]: { active: true } })
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  for (const task of [first, second]) {
    await h.input(task.work)
    task.driver.finish('done', `Report for ${task.work.id}`)
    await until(() => leadSession.reportQueue?.find(item => item.session === task.work.id)?.referenceId)
  }
  leadSession.reportQueue[0].result = { replyId: 'reply-before-freeze' }
  const conversation = h.rt.conversation
  h.rt.conversation = (profile, session) => {
    if (session === first.work.id) throw new Error('Executor session unavailable')
    return conversation(profile, session)
  }
  h.rt.workView = workView
  const flushing = h.rt.flushLeadReports(h.conversation.id)
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.session, second.work.id)
  assert.ok(h.lines(first.work).some(line => /未回报主控：Executor session unavailable/.test(line.text)))
  assert.equal(first.work.source.pendingReport, undefined)
  await h.finishLead()
  await flushing
  assert.equal(leadSession.reportQueue, undefined)
}))

test('a rejected report send preserves the failed delegation hint', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const send = h.rt.send
  h.rt.send = (...args) => {
    if (args[6]?.origin?.kind === 'report') throw new Error('Report send rejected')
    return send(...args)
  }
  await h.input(work)
  driver.finish('done', 'Recovered but not delivered')
  await until(() => !work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  assert.ok(h.lines(work).some(line => /未回报主控：Report send rejected/.test(line.text)))
  assert.match(h.rt.leadBrief(h.rt.findProfile(h.lead.id), h.conversation), /Your last delegation to Worker .*without a report/)
}))

test('a manual recovery completion without replyId reports inline without a reference', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const send = h.rt.send
  h.rt.send = async (...args) => {
    const placed = await send(...args)
    return args[0] === h.worker.id
      ? { ...placed, completion: placed.completion.then(({ replyId, ...result }) => result) } : placed
  }
  await h.input(work)
  driver.finish('done', 'Exact recovered result without a reply id')
  const report = await until(() => h.reports()[0])
  assert.equal(report.references, undefined)
  assert.match(report.text, /No reference attached: No completed reply is available/)
  assert.ok(report.text.endsWith('Exact recovered result without a reply id'))
  await h.finishLead()
  assert.equal(work.source.pendingReport, undefined)
}))

const retryUntil = async check => {
  for (let attempts = 0; attempts < 4000; attempts++) {
    const result = check()
    if (result) return result
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Retry state did not settle')
}

test('a stop during automatic send admission prevents that continuation', () => withRecovery(async h => {
  const task = await h.delegate()
  let release, admitting = false
  const saveImages = h.rt.saveImages
  h.rt.saveImages = async (...args) => {
    admitting = true
    await new Promise(resolve => { release = resolve })
    return saveImages(...args)
  }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    mock.timers.tick(30_000)
    await retryUntil(() => admitting)
    await h.host.api('interrupt', { profile: h.worker.id, session: task.work.id })
    release()
    await task.following
    assert.equal(task.driver.calls.length, 1)
    assert.ok(task.work.source.pendingReport)
    assert.ok(h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
  } finally { release?.(); mock.timers.reset() }
}))

test('a stop of the automatic turn prevents further retries and retains manual reporting', () => withRecovery(async h => {
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    mock.timers.tick(30_000)
    await retryUntil(() => task.driver.calls.length === 2)
    await h.host.api('interrupt', { profile: h.worker.id, session: task.work.id })
    await task.following
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 2)
    assert.ok(task.work.source.pendingReport)
  } finally { mock.timers.reset() }
  await h.input(task.work)
  task.driver.finish('done', 'Recovered after stopping automatic work')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.equal(task.work.source.pendingReport, undefined)
}))
const temporaryFailure = async (h, task, attempt = 1) => {
  task.driver.finish('error', 'Temporary outage', false, true)
  await retryUntil(() => h.rt.leadRetryWaiting(task.work.id) && h.lines(h.conversation).some(line => line.text?.includes(`自动继续（${attempt}/5）`)))
}

test('unloading lead cancels automatic continuation waits and preserves pending reporting', () => withRecovery(async h => {
  let cleanup
  const effect = h.rt.ctx.effect
  h.rt.ctx.effect = (factory, ...args) => effect(() => { cleanup = factory(); return cleanup }, ...args)
  try { installLead(h.rt) } finally { h.rt.ctx.effect = effect }
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    const marker = task.work.source.pendingReport.id
    cleanup()
    await task.following
    mock.timers.tick(30_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(task.driver.calls.length, 1)
    assert.equal(h.rt.leadRetryWaiting(task.work.id), false)
    assert.equal(task.work.source.pendingReport.id, marker)
    assert.equal(h.reports().length, 0)
  } finally { mock.timers.reset() }
}))

test('pending recovery survives losing an automatic wait on restart', () => withRecovery(async h => {
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    const saved = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    task.work.source = saved.profiles[h.worker.id].sessions.find(item => item.id === task.work.id).source
  } finally { mock.timers.reset() }
  installLead(h.rt)
  assert.equal(task.driver.calls.length, 1)
  await h.input(task.work)
  task.driver.finish('done', 'Recovered after losing the wait')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.equal(task.work.source.pendingReport, undefined)
}))

test('a user takeover completing during cancellation reports once', () => withRecovery(async h => {
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    await h.host.api('send', { profile: h.worker.id, session: task.work.id, text: 'Take over and finish' })
    await retryUntil(() => task.driver.calls.length === 2)
    task.driver.finish('done', 'Quick manual recovery')
    await task.following
  } finally { mock.timers.reset() }
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.equal(task.work.source.pendingReport, undefined)
  await h.rt.flushLeadReports(h.conversation.id)
  assert.equal(h.reports().length, 1)
}))

test('a transient delegation waits exactly 30s, continues its context and reports normally', () => withRecovery(async h => {
  const task = await h.delegate(undefined, 'Original unique task')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    const stored = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    assert.ok(stored.profiles[h.worker.id].sessions.find(item => item.id === task.work.id).source.pendingReport.id)
    assert.equal(h.rt.workView()[task.work.id].retryWaiting, true)
    assert.equal(h.rt.workView()[task.work.id].active, true)
    assert.match(h.rt.leadBrief(h.lead, h.conversation), /Current delegation/)
    assert.match(h.rt.leadBrief(h.lead, h.conversation), /"status":"waiting-retry"/)
    mock.timers.tick(29_999)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(task.driver.calls.length, 1)
    mock.timers.tick(1)
    await retryUntil(() => task.driver.calls.length === 2)
    assert.match(task.driver.calls[1], /^Task from lead/)
    assert.equal(h.lines(task.work).filter(line => line.who === 'user').at(-1).origin?.kind, 'retry')
    assert.match(h.rt.leadBrief(h.lead, h.conversation), /"status":"running"/)
    assert.match(task.driver.calls[1], /从中断处继续完成原任务/)
    assert.doesNotMatch(task.driver.calls[1], /Original unique task/)
    assert.equal(task.work.source.continued, undefined)
  } finally { mock.timers.reset() }
  task.driver.finish('done', 'Recovered automatically')
  await until(() => h.reports().length === 1)
  assert.doesNotMatch(h.reports()[0].text, /manually resumed/)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Recovered automatically')
  await h.finishLead()
  await task.following
  assert.equal(task.work.source.pendingReport, undefined)
  for (let count = 1; count <= 2; count++) {
    const reused = await h.delegate(task.work, 'Recheck')
    reused.driver.finish('error')
    await reused.following
    assert.equal(task.work.source.continued, count, 'automatic continuation does not spend reuse budget')
  }
}))

test('five automatic continuations exhaust the retry budget and retain the pending report', () => withRecovery(async h => {
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let marker
    for (let attempt = 1; attempt <= 5; attempt++) {
      await temporaryFailure(h, task, attempt)
      marker ??= task.work.source.pendingReport.id
      assert.equal(task.work.source.pendingReport.id, marker)
      mock.timers.tick(30_000)
      await retryUntil(() => task.driver.calls.length === attempt + 1)
    }
    task.driver.finish('error', 'Still overloaded', false, true)
    await task.following
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 6)
    assert.equal(task.work.source.pendingReport.id, marker)
    assert.ok(h.lines(h.conversation).some(line => /自动继续已用尽（5\/5）/.test(line.text)))
    assert.equal(h.reports().length, 0)
  } finally { mock.timers.reset() }
  await h.input(task.work)
  task.driver.finish('done', 'Manual recovery after exhaustion')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.equal(task.work.source.pendingReport, undefined)
}))

for (const action of ['lead-interrupt', 'user-stop', 'user-message', 'busy']) {
  test(`automatic continuation is cancelled by ${action}; manual completion reports once`, () => withRecovery(async h => {
    const task = await h.delegate()
    mock.timers.enable({ apis: ['setTimeout'] })
    let stopping
    try {
      await temporaryFailure(h, task)
      const marker = task.work.source.pendingReport.id
      if (action === 'lead-interrupt') {
        stopping = h.rt.followLead(h.lead.id, h.conversation.id, interruptTask(task.work.id))
      } else if (action === 'user-stop') {
        await h.host.api('interrupt', { profile: h.worker.id, session: task.work.id })
      } else if (action === 'user-message') {
        await h.host.api('send', { profile: h.worker.id, session: task.work.id, text: 'User takes over' })
        await retryUntil(() => task.driver.calls.length === 2)
      } else {
        const send = h.rt.send
        h.rt.send = (...args) => {
          if (args[0] === h.worker.id && args[6]?.exclusive) throw Object.assign(new Error('Busy'), { code: 'orch/busy' })
          return send(...args)
        }
        mock.timers.tick(30_000)
      }
      await task.following
      assert.equal(task.work.source.pendingReport.id, marker)
      assert.ok(h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
      mock.timers.tick(300_000)
      assert.equal(task.driver.calls.length, action === 'user-message' ? 2 : 1)
      assert.equal(h.reports().length, 0)
    } finally { mock.timers.reset() }
    if (stopping) { await h.finishLead(); await stopping }
    if (action !== 'user-message') await h.input(task.work)
    task.driver.finish('done', 'User completed the task')
    await until(() => h.reports().length === 1)
    await h.finishLead()
    await h.input(task.work, 'Later chat')
    task.driver.finish('done', 'Unrelated')
    await until(() => !h.rt.workView()[task.work.id].active)
    assert.equal(h.reports().length, 1)
    assert.equal(task.work.source.pendingReport, undefined)
  }))
}

for (const [reason, unconfirmed, retryable] of [['error', false, false], ['error', true, true], ['interrupted', false, true]]) {
  test(`delegation does not auto-continue ${reason}, unconfirmed=${unconfirmed}, retryable=${retryable}`, () => withRecovery(async h => {
    const task = await h.delegate()
    task.driver.finish(reason, 'Not eligible', unconfirmed, retryable)
    await task.following
    assert.equal(task.driver.calls.length, 1)
    assert.ok(task.work.source.pendingReport)
    assert.equal(h.rt.workView()[task.work.id].retryWaiting, undefined)
  }))
}

test('ordinary chat does not automatically continue a transient failure', () => withRecovery(async h => {
  const work = await h.session(h.worker)
  await h.input(work)
  const driver = h.rt.driverOf(work.id)
  driver.finish('error', 'Temporary failure', false, true)
  await until(() => !h.rt.workView()[work.id].active)
  assert.equal(driver.calls.length, 1)
  assert.equal(work.source, undefined)
  assert.equal(h.reports().length, 0)
}))

test('automatic continuations leave the 12 delegation budget intact', () => withLead(async h => {
  const worker = await h.role('Worker')
  const lead = await h.role('Lead', delegateType('feature', false), { lead: true })
  const conversation = await h.session(lead)
  const send = h.rt.send
  let calls = 0
  h.rt.send = (...args) => {
    if (args[0] === worker.id && ++calls <= 5) return Promise.resolve({ mode: 'turn', completion: Promise.resolve({ reason: 'error', retryable: true }) })
    return send(...args)
  }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const following = h.rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false)))
    for (let attempt = 1; attempt <= 5; attempt++) {
      await retryUntil(() => h.lines(conversation).some(line => line.text?.includes(`自动继续（${attempt}/5）`)))
      mock.timers.tick(30_000)
    }
    mock.timers.reset()
    await following
    assert.equal(calls, 17, '12 delegations plus 5 automatic continuations')
    assert.equal(h.rt.sessionsOf(h.rt.findProfile(worker.id)).length, 12)
    assert.ok(h.lines(conversation).some(line => /12 次派活上限/.test(line.text)))
  } finally { mock.timers.reset() }
}))
