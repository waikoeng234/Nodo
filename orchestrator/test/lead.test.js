import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX, RUN_LIMITS, TURN_IDLE_TIMEOUT_MS } from '../core/src/constants.js'
import { leadRules, route } from '../core/src/lead.js'
import { install as installLead } from '../core/src/lead.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { echoEntry, registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { boot, until, withHost } from './helpers/host.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

registerClaudeFixtureEngine()

const delegateType = (type, hard, task = 'Implement the task\nKeep existing changes; report paths and tests.', session) => ({ type, hard, task, ...(session ? { session } : {}) })
const completed = text => ({ mode: 'turn', completion: Promise.resolve({ reason: 'done', text }) })
const waitFor = async check => {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('tool task did not settle')
    await new Promise(resolve => setImmediate(resolve))
  }
}
const toolTask = async (rt, session, command) => {
  const before = rt.transcriptOf(session).filter(line => line.origin?.kind === 'report').length
  const receipt = await rt.leadDispatch.delegate(session, command)
  await rt.followLead(rt.conversationOf(session).profile.id, session, completed('Dispatched'))
  await waitFor(() => rt.conversationOf(receipt.session).session.source.dispatch.status !== 'running')
  await waitFor(() => {
    const owner = rt.conversationOf(session).session
    const status = rt.conversationOf(receipt.session).session.source.dispatch.status
    return status.startsWith('interrupted') || rt.transcriptOf(session).some(line => line.delegation?.session === receipt.session && line.delegation.ended === 'done') || owner.reportQueue?.some(item => item.session === receipt.session && item.text)
      || rt.transcriptOf(session).filter(line => line.origin?.kind === 'report').length > before
  })
  await rt.flushLeadReports(session)
  const owner = rt.conversationOf(session)
  if (!owner.session.archivedAt && owner.session.permission !== 'plan') await waitFor(() => !rt.conversationOf(session).session.reportQueue?.length)
  await waitFor(() => !rt.workView()[session]?.active)
  return receipt
}

const leadReportEntry = {
  info: { id: 'lead-report-fixture', label: 'Lead report fixture', capabilities: { resume: true, steer: true } },
  validate: raw => raw,
  create({ onEvent, leadMcpServers }) {
    let turn = 0
    const driver = {
      calls: [], guides: [], leadMcpServers, openSession: async () => {}, hasSession: () => true, dispose() {}, onEvent() {},
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
}

registerEngine('lead-report-fixture', leadReportEntry)

test('deleted roles leave the lead roster and routing', () => withHost(async ({ api, runtime, home }) => {
  const removed = await api('profile-create', { name: 'Removed', engine: 'echo' })
  const kept = await api('profile-create', { name: 'Kept', engine: 'echo' })
  const lead = await api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await api('profile-delete', { id: removed.id })
  const rt = await runtime
  assert.doesNotMatch(rt.leadBrief(lead, { id: 'lead-session' }), /Removed/)
  assert.equal(rt.findProfile(removed.id), undefined)
  const workspace = await api('workspace-create', { name: 'Project', cwd: join(home, 'ws') })
  const conversation = await api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(rt.state.profiles[removed.id].sessions.length, 0)
  assert.equal(rt.findProfile(kept.id).sessions[0].source.by, 'fallback')
}))

const withLead = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Lead workspace', cwd: join(host.home, 'ws') })
  const role = (name, text = 'Work completed', extra = {}) => host.api('profile-create', {
    name, engine: extra.lead === true ? 'claude' : 'echo', engineOptions: { script: [{ kind: 'text', text: typeof text === 'string' ? text : 'Reviewed' }] }, ...extra,
  })
  const session = (profile, workspaceId = workspace.id) => host.api('session-create', { profile: profile.id, workspace: workspaceId, lazy: true })
  const placements = new Map()
  const originalSend = rt.send
  rt.send = async (...args) => {
    const placed = await originalSend(...args)
    placements.set(args[2], placed)
    return placed
  }
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
  await run({ host, rt, workspace, role, session, inputs, tracked, send, lines, placements })
})

test('delegation waits for a successful lead turn before sending', () => withLead(async ({ rt, role, session, inputs }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const sends = [], send = rt.send
  rt.send = (...args) => { sends.push(args); return send(...args) }
  let finish
  const following = rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: new Promise(resolve => { finish = resolve }) })
  const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
  assert.equal(sends.filter(args => args[0] === worker.id).length, 0)
  assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 0)
  assert.match(receipt.message, /受理.*本轮结束后发送/)
  finish({ reason: 'done' })
  await following
  await until(() => rt.conversationOf(receipt.session).session.source.dispatch.status === 'done')
  await waitFor(() => !rt.workView()[conversation.id]?.active)
}))

for (const reason of ['interrupted', 'error', 'rejected']) {
  test(`unsent delegation is cancelled without reports when lead ends: ${reason}`, () => withLead(async ({ rt, role, session, inputs }) => {
    await role('Worker', 'Done')
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
    await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: reason === 'rejected' ? Promise.reject(new Error('failed')) : Promise.resolve({ reason }) })
    assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 0)
    assert.equal(rt.conversationOf(receipt.session).session.source.dispatch.reason, 'cancelled')
    assert.equal(rt.conversationOf(conversation.id).session.reportQueue, undefined)
    const next = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
    assert.notEqual(next.session, receipt.session)
    await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  }))
}

test('restart cancels unsent delegations without reports or occupied slots', () => withLead(async ({ host, rt, role, session }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
  const restartHome = join(host.home, 'restart')
  mkdirSync(restartHome)
  copyFileSync(join(host.home, 'state.json'), join(restartHome, 'state.json'))
  const restarted = boot(restartHome)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    assert.equal(recovered.conversationOf(receipt.session).session.source.dispatch.status, 'cancelled')
    assert.equal(recovered.conversationOf(conversation.id).session.reportQueue, undefined)
    assert.equal(recovered.driverOf(receipt.session), undefined)
    const next = await recovered.leadDispatch.delegate(conversation.id, delegateType('feature', false))
    assert.notEqual(next.session, receipt.session)
    await recovered.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  } finally { restarted.dispose() }
  await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
}))

test('lead delegates in its workspace, returns referenced reports and stops at 12 without changing the selected session', () => withLead(async ({ host, rt, workspace, role, session, inputs, send, lines }) => {
  const otherWorkspace = await host.api('workspace-create', { name: 'Worker workspace', cwd: join(host.home, 'other') })
  const worker = await role('Worker', 'Changed src/task.js; verified task tests; nothing open.', { role: 'Implementation', goal: 'Ship the task' })
  const selected = await session(worker, otherWorkspace.id)
  const task = 'Implement the task\nKeep existing changes; report paths and tests.'
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const response = await send(lead, conversation, 'Please implement this')
  assert.equal(response.mode, 'turn')
  for (let i = 0; i < 12; i++) await toolTask(rt, conversation.id, delegateType('feature', false, task))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /12 次派活上限/)
  const liveWorker = rt.findProfile(worker.id)
  const delegated = liveWorker.sessions.filter(item => item.source?.kind === 'lead')
  assert.equal(delegated.length, 12)
  assert.equal(liveWorker.activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  for (const work of delegated) {
    assert.equal(work.workspaceRef, workspace.id)
    assert.equal(work.name, 'Implement the task')
    assert.equal(work.source.dispatch.status, 'done')
    assert.deepEqual((({ dispatch, ...source }) => source)(work.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'fallback', type: 'feature', hard: false })
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
    delegated.map(work => ({ session: work.id, profile: worker.id, type: 'feature', hard: false, reused: false, deferred: true })))
  assert.equal(lines(conversation).filter(line => /主控派活已停止/.test(line.text)).length, 0)
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.length, 13)
  assert.ok(leadInputs.slice(1).every(item => item.text.includes('<nodo-status>') && item.text.includes('已完成')))
  assert.ok(leadInputs.every(item => !item.text.includes('## Task types') && !item.text.includes('```nodo')))
  assert.ok(leadInputs.every(item => !item.text.includes('origin')))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Please implement this')
  assert.equal(conversation.name, 'Session 1')
  assert.equal(rt.conversation(lead.id, conversation.id).session.name, 'Please implement this')
  rt.conversation(lead.id, conversation.id).session.engineOptions.script[0].text = 'Reviewed'
  await send(lead, conversation, 'Next user message')
  await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(liveWorker.sessions.filter(item => item.source?.kind === 'lead').length, 13, 'a new user message resets the delegation limit')
}))

test('role boards refresh task types without changing identity, stored user text or task state', () => withLead(async ({ host, rt, role, session, inputs, send, lines }) => {
  const worker = await role('Available', 'Done', { role: 'Coder', goal: 'A'.repeat(500) })
  const lead = await role('Lead', 'An ordinary answer', { lead: true })
  const other = await role('Other lead', 'An ordinary answer', { lead: true })
  const conversation = await session(lead)
  const identity = rt.renderIdentity(rt.findProfile(lead.id))
  const brief = rt.leadBrief(lead, conversation)
  assert.equal(brief, leadRules)
  assert.ok(!brief.includes(worker.id) && !brief.includes(lead.id) && !brief.includes(other.id))
  await send(lead, conversation, 'First question')
  await host.api('task-types-update', { types: [{ id: 'feature', name: 'Feature', when: 'Updated responsibility' }] })
  await send(lead, conversation, 'Second question')
  assert.ok(inputs[0].text.endsWith('\n\nFirst question'))
  assert.match(rt.leadRoles(conversation.id), /Updated responsibility/)
  assert.ok(!inputs[1].text.includes('Updated responsibility'))
  assert.equal(inputs[0].driver, inputs[1].driver)
  assert.equal(rt.renderIdentity(rt.findProfile(lead.id)), identity)
  assert.deepEqual(lines(conversation).filter(line => line.who === 'user').map(line => line.text), ['First question', 'Second question'])
  const live = rt.conversation(lead.id, conversation.id).session
  assert.equal(live.lastTurn.task, 'Second question')
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

test('plain replies, historical blocks, failed turns and joined placements do not delegate', () => withLead(async ({ rt, role, session, send, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Ordinary answer', { lead: true })
  const conversation = await session(lead)
  await send(lead, conversation)
  for (const text of ['```nodo\n{bad}\n```', '```nodo\n' + JSON.stringify(delegateType('feature', false)) + '\n```', '```nodo\n{"action":"interrupt","session":"old"}\n```']) {
    await rt.followLead(lead.id, conversation.id, completed(text))
  }
  for (const outcome of [{ reason: 'interrupted' }, { reason: 'error' }, { reason: 'done', unconfirmed: true }, { reason: 'done', final: 'No command' }]) {
    await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ text: delegateType('feature', false), ...outcome }) })
  }
  for (const mode of ['steered', 'indeterminate']) await rt.followLead(lead.id, conversation.id, {
    mode, get completion() { throw new Error('Joined placements must not be tracked') },
  })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 1)
}))


test('a tool amendment continues the same executor session and reports only the revised work', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done', { engineOptions: { script: [{ kind: 'wait', ms: 100 }, { kind: 'text', text: 'Revised work done' }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
  await rt.followLead(lead.id, conversation.id, completed('Dispatched'))
  await until(() => inputs.some(item => item.sessionId === receipt.session))
  await toolTask(rt, conversation.id, delegateType('feature', false, 'Apply the new constraint', receipt.session))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 2)
  assert.deepEqual(lines(conversation).filter(line => line.delegation && !line.delegation.ended).map(line => line.delegation.reused), [false, true])
  const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].references[0].messages[0].text, 'Revised work done')
}))

test('overlapping interrupt tools share stop confirmation without sending another lead input', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false))
  await rt.followLead(lead.id, conversation.id, completed('Dispatched'))
  await until(() => rt.workView()[receipt.session]?.active)
  const interrupt = rt.interrupt
  let requests = 0, release
  const gate = new Promise(resolve => { release = resolve })
  rt.interrupt = async (...args) => { requests++; await gate; return interrupt(...args) }
  try {
    const stops = [rt.leadDispatch.interrupt(conversation.id, receipt.session), rt.leadDispatch.interrupt(conversation.id, receipt.session)]
    await until(() => requests > 0)
    release()
    const results = await Promise.all(stops)
    assert.equal(requests, 1)
    assert.ok(results.every(result => result.ended === 'interrupted'))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    await until(() => lines(conversation).some(line => line.delegation?.ended === 'interrupted'))
    assert.equal(lines(conversation).filter(line => line.delegation?.ended).length, 1)
  } finally { release(); rt.interrupt = interrupt; await interrupt(worker.id, receipt.session) }
}))

test('a running delegation excludes a second one in the same lead session', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'text', text: 'Progress' }, { kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /已有派活任务在执行/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  await rt.interrupt(worker.id, work.id)
  await first
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 0)
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
  const note = lines(conversation).find(line => line.delegation?.ended === 'interrupted')
  assert.equal(note.text, '')
  assert.deepEqual(note.delegation, { session: work.id, ended: 'interrupted' })
  assert.doesNotMatch(rt.leadBrief(lead, conversation), /To resume it with its context/)
}))

test('a lead can interrupt only its own running delegation before replacing it', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const other = await session(lead)
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation?.session === work.id))
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  try {
    assert.match(rt.leadSnapshot(conversation.id), new RegExp(work.id))
    await host.api('send', { profile: lead.id, session: conversation.id, text: 'How is it going?' })
    assert.equal(rt.workView()[work.id].active, true, 'a progress question does not stop work')
    await assert.rejects(rt.leadDispatch.interrupt(other.id, work.id), /只能中断本主控会话当前派出的执行任务/)
    assert.equal(rt.workView()[work.id].active, true, 'another lead session cannot stop this task')
    assert.equal(lines(other).filter(line => line.origin?.kind === 'reject').length, 0)
    await rt.leadDispatch.interrupt(conversation.id, work.id)
    await pending
    assert.equal(rt.workView()[work.id].active, false)
    assert.ok(lines(conversation).some(line => line.delegation?.session === work.id && line.delegation.ended === 'interrupted'))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0, 'the old task cannot restart the lead')
    rt.findProfile(worker.id).engineOptions.script = [{ kind: 'text', text: 'New task done' }]
    await toolTask(rt, conversation.id, delegateType('feature', false, 'Use the revised plan'))
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
  } finally {
    await rt.interrupt(worker.id, work.id)
    await pending
  }
}))

test('a stop request keeps the delegation occupied until its completion is confirmed', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.workView()[work.id]?.active && lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  let requested = false, release
  const gate = new Promise(resolve => { release = resolve })
  rt.interrupt = async (...args) => { requested = true; await gate; return interrupt(...args) }
  const stopping = rt.leadDispatch.interrupt(conversation.id, work.id)
  try {
    await until(() => requested)
    await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /已有派活任务在执行/)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 0)
  } finally {
    release()
    await stopping
    await interrupt(worker.id, work.id)
    await pending
  }
}))


for (const unconfirmed of [false, true]) test(`a stop waits for its ${unconfirmed ? 'unconfirmed' : 'confirmed'} settlement without a separate timeout note`, () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  let requested = false, stopped = false
  rt.interrupt = async () => { requested = true; return true }
  const stopping = rt.leadDispatch.interrupt(conversation.id, work.id)
  stopping.then(() => { stopped = true })
  try {
    await until(() => requested)
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(RUN_LIMITS.cancelConfirmMs * 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false, 'the lead waits for the tracker instead of racing another deadline')
    assert.equal(lines(conversation).some(line => /仍在等待执行任务确认结束/.test(line.text)), false)
    assert.match(rt.leadSnapshot(conversation.id), /停止中/)
    rt.driverSink(work.id, { type: 'turn/end', reason: 'interrupted', ...(unconfirmed ? { unconfirmed: true } : {}) })
    mock.timers.reset()
    await Promise.all([pending, stopping])
    assert.equal(lines(conversation).filter(line => line.delegation?.ended).length, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, unconfirmed ? 1 : 0)
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
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation))
  const interrupt = rt.interrupt
  rt.interrupt = async (...args) => { await pending; return interrupt(...args) }
  try {
    await rt.leadDispatch.interrupt(conversation.id, work.id)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    assert.ok(lines(conversation).some(line => line.delegation?.ended === 'done'))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
  } finally { rt.interrupt = interrupt; await pending }
}))

test('interruption waits for the original delegation tracker before acknowledging the end', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  let held = false, release
  const gate = new Promise(resolve => { release = resolve })
  rt.send = async (...args) => {
    const placed = await send(...args)
    if (args[0] === worker.id && !held) { held = true; await gate }
    return placed
  }
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  await until(() => held)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await until(() => rt.workView()[work.id]?.active)
  const stopping = rt.leadDispatch.interrupt(conversation.id, work.id)
  try {
    await until(() => !rt.workView()[work.id].active)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    release()
    await Promise.all([pending, stopping])
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    assert.ok(lines(conversation).some(line => line.delegation?.ended === 'interrupted'))
  } finally {
    release()
    rt.send = send
    await rt.interrupt(worker.id, work.id)
    await Promise.all([pending, stopping])
  }
}))


test('dispatch cancellation fallback releases the lead for a new delegation with only one end note', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => lines(conversation).some(line => line.delegation) && rt.driverOf(work.id))
  const interruptDriver = rt.interruptDriver, timeout = RUN_LIMITS.cancelConfirmMs
  let requests = 0
  rt.interruptDriver = async () => { requests++; return new Promise(() => {}) }
  RUN_LIMITS.cancelConfirmMs = 30
  try {
    await rt.leadDispatch.interrupt(conversation.id, work.id)
    await pending
    assert.equal(requests, 1)
    assert.equal(rt.workView()[work.id].active, false, 'dispatch releases occupancy despite a stuck driver stop')
    assert.equal(rt.workView()[work.id].suspect, false)
    const ended = () => lines(conversation).filter(line => line.delegation?.ended)
    assert.deepEqual(ended().map(line => line.delegation), [{ session: work.id, ended: 'interrupted', unconfirmed: true }])
    assert.equal(ended()[0].text, '')
    assert.equal(lines(conversation).some(line => /仍在等待执行任务确认结束/.test(line.text)), false)
    await until(() => lines(conversation).some(line => line.origin?.kind === 'report'))
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 1)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'interrupt').length, 0)
    const brief = rt.leadBrief(lead, conversation)
    assert.doesNotMatch(brief, /Current delegation/)
    assert.doesNotMatch(brief, /without a report/)
    rt.driverSink(work.id, { type: 'turn/end', turnId: 'turn-1', reason: 'done', text: 'Stale report' })
    rt.interruptDriver = interruptDriver
    rt.findProfile(worker.id).engineOptions = { script: [{ kind: 'text', text: 'Fresh work' }] }
    await toolTask(rt, conversation.id, delegateType('feature', false))
    assert.equal(ended().length, 1)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2, 'a settled unconfirmed stop allows an explicitly requested new delegation')
    const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
    assert.equal(reports.length, 2)
    assert.equal(reports[0].origin.session, work.id)
    assert.notEqual(reports[1].origin.session, work.id, 'the late old end cannot generate another report')
    assert.equal(reports[1].references[0].messages[0].text, 'Fresh work')
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
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
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
      assert.match(rt.leadSnapshot(conversation.id), /疑似卡住/)
      assert.deepEqual(interrupted, [])
      assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    } finally { mock.timers.reset() }
    await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /已有派活任务在执行/)
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

test('failed and unconfirmed executor results are delivered as notifications', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  for (const outcome of [{ reason: 'error' }, { reason: 'done', unconfirmed: true }]) {
    rt.send = async (profileId, ...args) => {
      const placed = await send(profileId, ...args)
      if (profileId !== worker.id) return placed
      await placed.completion
      return { ...placed, completion: Promise.resolve(outcome) }
    }
    await toolTask(rt, conversation.id, delegateType('feature', false))
  }
  const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
  assert.equal(reports.length, 2)
  assert.match(reports[0].text, /Result: failed. Reason: error/)
  assert.match(reports[1].text, /Result: unconfirmed. Reason: done/)
  assert.ok(reports.every(line => !line.references && line.text.includes(line.origin.session) && line.text.includes('Task: Implement the task')))
  const markers = lines(conversation).filter(line => line.delegation?.ended)
  assert.equal(markers.length, 2)
  assert.ok(markers.every(line => line.text === ''))
  assert.equal(conversation.reportQueue, undefined)
}))

test('a delivered failure removes the resume hint and stays continuable', () => withLead(async ({ rt, role, session, inputs, lines }) => {
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
  await toolTask(rt, conversation.id, delegateType('feature', false))
  rt.send = send
  const failed = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.doesNotMatch(brief, /without a report/)
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 1)
  assert.ok(!brief.includes('unconfirmed'))
  assert.ok(!rt.leadBrief(rt.findProfile(lead.id), conversation).includes(failed.id))
  await toolTask(rt, conversation.id, delegateType('feature', false, undefined, failed.id))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === failed.id).length, 2)
  assert.ok(lines(conversation).some(line => line.text === `继续派给 Worker · ${failed.name}（功能 · 常规 · 兜底）`))
}))

test('a new accepted user message resets the delegation budget of the running chain', () => withLead(async ({ host, rt, role, session, tracked, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  for (let i = 0; i < 6; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await host.api('send', { profile: lead.id, session: conversation.id, text: 'A second message' })
  await tracked.at(-1)
  for (let i = 0; i < 12; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /12 次派活上限/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 18)

}))

for (const [name, script, expected] of [
  ['no completed reply', [], /No completed reply is available/],
  ['report exceeds reference limit', [{ kind: 'text', text: 'x'.repeat(TRANSCRIPT_TEXT_MAX + 1000) }], /无法完整引用/],
]) test(`lead report fallback: ${name}`, () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script = script
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const report = lines(conversation).find(line => line.who === 'user')
  assert.match(report.text, /Report from Worker/)
  assert.match(report.text, expected)
  assert.equal(report.references, undefined)
  assert.ok(report.text.length < TASK_TEXT_MAX)
  assert.ok(!inputs.find(input => input.profileId === lead.id).text.includes('```nodo'))
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
  await toolTask(rt, conversation.id, delegateType('feature', false, task))
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
  await toolTask(rt, conversation.id, delegateType('feature', false, `Check ${value}\nReport findings`))
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
    await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, task)), /32000/)
  }
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(inputs.every(input => input.profileId !== worker.id))
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 0)
}))

test('fallback reports redact secrets before clipping at the transcript boundary', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const value = 'lead-report-boundary-fixture-value'
  await host.api('secret-set', { name: 'LEAD_REPORT_TEST', value, purpose: 'test' })
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script[0].text = 'x'.repeat(TRANSCRIPT_TEXT_MAX - 8) + value + 'y'.repeat(1000)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  rt.referenceReplies = async () => { throw new Error('Reference unavailable') }
  await toolTask(rt, conversation.id, delegateType('feature', false))
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
  const pending = [lead, other].map((profile, index) => toolTask(rt, conversations[index].id, delegateType('feature', false)))
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
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
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
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
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
  await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(returned[2], conversation.id)
  assert.equal(returned[5].brief, leadRules)
  const snapshot = await rt.readReference({ id: returned[4][0].id, target: 'native-lead' })
  assert.equal(snapshot.target, 'native-lead')
  assert.equal(snapshot.source.profileId, worker.id)
}))

test('an empty legacy role board still lists task types and brief precedes tasks without entering task history', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  delete rt.state.profiles[worker.id]
  const conversation = await session(lead)
  const brief = rt.leadBrief(lead, conversation)
  assert.equal(brief, leadRules)
  assert.match(rt.leadRoles(conversation.id), /feature/)
  assert.doesNotMatch(brief, /no roles available|## Roster/)
  const placed = await rt.send(lead.id, 'Assigned task', conversation.id, [], [], { brief })
  await placed.completion
  assert.ok(inputs[0].text.startsWith(`${brief}\n\nAssigned task`))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Assigned task')
  assert.equal(rt.conversation(lead.id, conversation.id).session.lastTurn.task, 'Assigned task')
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /没有承接「功能」的角色/)
  assert.equal(rt.leadBrief(lead, conversation), leadRules)
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
  await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the misaligned button'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.source.dispatch.status, 'done')
  assert.deepEqual((({ dispatch, ...source }) => source)(work.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: true })
  assert.equal(work.model, 'hard-model')
  assert.equal(work.thinking, 'high')
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the misaligned button（修复 · 难题）'))
  await toolTask(rt, conversation.id, delegateType('bug-fix', false, 'Fix the label'))
  const regular = rt.sessionsOf(rt.findProfile(worker.id))[1]
  assert.equal(regular.source.dispatch.status, 'done')
  assert.deepEqual((({ dispatch, ...source }) => source)(regular.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: false })
  assert.equal(regular.model, undefined)
  assert.equal(regular.thinking, undefined)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the label（修复 · 常规）'))
  assert.equal(rt.sessionsOf(rt.findProfile(fallback.id)).length, 0, 'an accepting role takes precedence over fallback')
}))

test('the role board lists task types and the brief contains only rules', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.equal(brief, leadRules)
  assert.match(rt.leadRoles(conversation.id), /需求和方案已明确/)
  assert.match(rt.leadRoles(conversation.id), new RegExp(worker.name))

}))

for (const [name, command, expected] of [
  ['unknown type', delegateType('no-such-type', false), /type 必须/],
  ['non-boolean hard', delegateType('feature', 'yes'), /hard 必须/],
  ['missing type', { hard: false, task: 'Work' }, /type 必须/],
  ['empty task', delegateType('feature', false, ' '), /非空字符串/],
  ['oversized task', delegateType('feature', false, 'x'.repeat(TASK_TEXT_MAX + 1)), /32000/],
  ['task plus header exceeds limit', delegateType('feature', false, 'x'.repeat(TASK_TEXT_MAX)), /32000/],
]) test(`tool delegation rejects ${name} without feedback or work`, () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  for (let i = 0; i < 2; i++) await assert.rejects(rt.leadDispatch.delegate(conversation.id, command), expected)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).length, 0)
}))

test('routing mode ignores to and routes by type', () => withLead(async ({ rt, role, session }) => {
  const router = await role('Router', 'Feature done', { taskTypes: ['feature'] })
  const writer = await role('Writer', 'Docs done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, { to: writer.name, type: 'feature', hard: false, task: 'Build the feature' })
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).filter(item => item.source?.kind === 'lead').length, 1)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
}))

test('a legacy roster without fallback pauses an unclaimed type, skips the lead and reports once', () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const writer = await role('Writer', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('feature', false, 'Build it'), { lead: true })
  const conversation = await session(lead)
  delete rt.findProfile(writer.id).fallback
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /没有承接「功能」的角色/)
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('docs', true)), /没有能接「文档」难题的角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
  assert.equal(lines(conversation).length, 0)
  await send(lead, conversation, 'Second message')
  assert.doesNotMatch(inputs.at(-1).text, /did not run your last delegation|```nodo/)

}))

test('a lead can continue its own dispatched session instead of opening a new one', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Work completed')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await toolTask(rt, conversation.id, delegateType('feature', false, undefined, work.id))
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
  await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the header'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the footer', work.id))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => line.text === '继续派给 Router · Fix the header（修复 · 难题）'))
}))

test('continuation is refused for unknown, foreign and archived sessions', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const second = await role('Second lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const secondConversation = await session(second)
  const refused = async command => {
    const error = await rt.leadDispatch.delegate(conversation.id, command).then(() => assert.fail('Expected refusal'), error => error)
    assert.match(error.message, /去掉 session 字段新开会话/)
    return error.message
  }
  await toolTask(rt, secondConversation.id, delegateType('feature', false))
  const foreign = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.match(await refused(delegateType('feature', false, undefined, 'missing')), /session 必须是本主控会话派出的执行会话 id/)
  assert.match(await refused(delegateType('feature', false, undefined, foreign.id)), /session 必须是本主控会话派出的执行会话 id/)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const own = rt.sessionsOf(rt.findProfile(worker.id))[1]
  rt.conversation(worker.id, own.id).session.archivedAt = Date.now()
  assert.match(await refused(delegateType('feature', false, undefined, own.id)), /该执行会话已归档/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 2)
}))

test('continuation refuses a foreign or unconfirmed executor and allows an interrupted result', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const other = await role('Other', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('docs', false, undefined, work.id)), /该执行会话属于其他角色/)
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('docs', false, undefined, work.id)), /该执行会话属于其他角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(other.id)).filter(item => item.source?.kind === 'lead').length, 0)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    const outcome = await placed.completion
    return { ...placed, completion: Promise.resolve({ ...outcome, unconfirmed: true }) }
  }
  await toolTask(rt, conversation.id, delegateType('feature', false))
  rt.send = send
  const flagged = rt.sessionsOf(rt.findProfile(worker.id))[1]
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, undefined, flagged.id)), /状态未确认/)
  assert.equal(inputs.filter(item => item.sessionId === flagged.id).length, 1)
  rt.findProfile(worker.id).engineOptions.script = [{ kind: 'ask' }]
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  const stopped = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[2])
  await until(() => rt.approvalsView().some(item => item.profileId === stopped.id))
  await rt.interrupt(worker.id, stopped.id)
  await pending
  rt.conversation(worker.id, stopped.id).session.engineOptions.script[0] = { kind: 'text', text: 'Done' }
  await toolTask(rt, conversation.id, delegateType('feature', false, undefined, stopped.id))
  assert.equal(inputs.filter(item => item.sessionId === stopped.id).length, 2)
  assert.equal(lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).length, 0)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 3)
}))

test('routing mode refuses continuation when the difficulty differs', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', true, 'Fix the header'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, 'Fix the footer', work.id)), /该执行会话的任务难度与本次不同/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
}))

test('a session can be continued at most twice', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await toolTask(rt, conversation.id, delegateType('feature', false, undefined, work.id))
  await toolTask(rt, conversation.id, delegateType('feature', false, undefined, work.id))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, undefined, work.id)), /该执行会话已续用 2 次/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 3)
}))

test('a busy session refuses continuation without creating a delegation', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const poke = rt.send(worker.id, 'Poke', work.id, [], [])
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, undefined, work.id)), /该执行会话正忙/)
  assert.ok(!lines(conversation).some(line => line.text?.startsWith('继续派给')))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  await rt.interrupt(worker.id, work.id)
  await poke
}))

test('continuations count toward the 12-delegation budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', delegateType('feature', false), { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const continued = rt.sessionsOf(rt.findProfile(worker.id))[0]
  for (let i = 0; i < 2; i++) await toolTask(rt, conversation.id, delegateType('feature', false, undefined, continued.id))
  for (let i = 0; i < 9; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /12 次派活上限/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 10)
  assert.equal(inputs.filter(item => item.sessionId === continued.id).length, 3)
  assert.equal(inputs.filter(item => item.text.startsWith('Task from lead Lead')).length, 12)

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
    assert.equal(brief, '')
    assert.equal(leadRules.split('\n').length, 3)
  }
}))


for (const [hard, settings] of [[false, undefined], [true, undefined], [true, { model: 'hard-model', thinking: 'high' }]]) {
  test(`unclaimed types use fallback (${hard ? 'hard' : 'routine'}, ${settings ? 'hard settings' : 'card settings'})`, () => withLead(async ({ rt, role, session, lines }) => {
    const worker = await role('Generalist', 'Done', { model: 'regular-model', hard: settings })
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    await toolTask(rt, conversation.id, delegateType('feature', hard, 'Build it'))
    const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
    assert.equal(work.source.dispatch.status, 'done')
    assert.deepEqual((({ dispatch, ...source }) => source)(work.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'fallback', type: 'feature', hard })
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
  await assert.rejects(rt.leadDispatch.delegate(conversation.id, delegateType('docs', true)), /没有能接「文档」难题的角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(fallback.id)).length, 0)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).length, 0)
  assert.equal(rt.leadBrief(lead, conversation), leadRules)

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
      await toolTask(rt, conversation.id, delegateType('feature', false))
      const delegated = inputs.find(item => item.profileId === worker.id)
      assert.ok(delegated.text.endsWith(`## Attached files (user provided)\n- ${JSON.stringify(path)}`))
      assert.doesNotMatch(lines({ id: delegated.sessionId }).find(item => item.who === 'user').text, /Attached files/)
    } else assert.doesNotMatch(input, /Attached files/)
    const [line] = lines(conversation).filter(item => item.who === 'user')
    assert.equal(line.images.length, 1)
    assert.equal(line.files, undefined)
  }
  assert.equal(rt.leadBrief(lead, { id: 'x' }), leadRules)
}))

const withRecovery = run => {
  // The recovery suite drives the lead through the report fixture's calls and
  // finishes, so the claude-id fixture stands in for it during the run.
  registerEngine('claude', leadReportEntry)
  return withLead(async h => {
    try {
      const { rt, host, role, session, lines } = h
      const options = { engine: 'lead-report-fixture', engineOptions: {} }
      const worker = await role('Worker', '', options)
      const lead = await role('Lead', '', { ...options, engine: 'claude', lead: true })
  const conversation = await session(lead)
  const setupReports = new Set()
  const reports = () => lines(conversation).filter(line => line.origin?.kind === 'report' && !setupReports.has(line.origin.reportId))
  const delegate = async (reuse, text) => {
    const count = rt.sessionsOf(rt.findProfile(worker.id)).length
    const receipt = await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, text, reuse?.id))
    await rt.followLead(lead.id, conversation.id, completed('Dispatched'))
    const work = reuse ?? await until(() => rt.sessionsOf(rt.findProfile(worker.id))[count])
    const driver = await until(() => rt.driverOf(work.id)?.active && rt.driverOf(work.id))
    const following = h.placements.get(receipt.session).completion
    return { work, driver, following }
  }
  const failed = async () => {
    const task = await delegate()
    task.driver.finish('error', 'Original failed reply')
    const notification = await until(() => reports()[0])
    assert.match(notification.text, /Result: failed/)
    await finishLead()
    await task.following
    setupReports.add(notification.origin.reportId)
    assert.equal(task.work.source.dispatch.status, 'failed')
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
    } finally { registerEngine('claude', echoEntry) }
  })
}

test('snapshot and board share live state without saving or changing dispatch summaries', () => withRecovery(async h => {
  const { work, driver, following } = await h.delegate()
  const summary = structuredClone(work.source.dispatch)
  const save = mock.method(h.rt, 'save', async () => {})
  const status = () => {
    const row = h.rt.delegationState(h.worker, work)
    assert.ok(h.rt.leadSnapshot(h.conversation.id).includes(row[4]))
    assert.ok(h.rt.leadDelegations(h.conversation.id).includes(row[4]))
    return row[4]
  }
  assert.match(status(), /执行中 · 已执行 \d+ 秒/)
  const awaiting = mock.method(h.rt, 'awaitingAnswer', id => id === work.id)
  assert.match(status(), /等待用户/)
  h.rt.driverSink(work.id, { type: 'lifecycle', kind: 'retry', phase: 'start' })
  assert.match(status(), /引擎重试中/)
  h.rt.driverSink(work.id, { type: 'lifecycle', kind: 'retry', phase: 'end' })
  assert.match(status(), /等待用户/)
  const live = mock.method(h.rt, 'dispatchWork', () => ({ suspect: true, retry: true }))
  assert.match(status(), /疑似卡住/)
  live.mock.restore()
  awaiting.mock.restore()
  // Lifecycle events save through dispatch; the following queries must not.
  const calls = save.mock.callCount()
  status()
  h.rt.leadRoles(h.conversation.id)
  assert.equal(save.mock.callCount(), calls)
  assert.deepEqual(work.source.dispatch, summary)
  save.mock.restore()
  driver.finish('done')
  await h.finishLead()
  await following
  assert.equal(work.source.dispatch.status, 'done')
}))

test('snapshot prefers running work then latest dispatch and retains every terminal status', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const owner = await session(lead)
  assert.equal(rt.leadSnapshot(owner.id), '')
  const liveOwner = rt.conversationOf(owner.id).session
  liveOwner.reportQueue = [{ session: 'missing' }]
  assert.match(rt.leadSnapshot(owner.id), /待送结果：1/)
  delete liveOwner.reportQueue
  const work = rt.conversationOf((await session(worker)).id).session
  work.source = { kind: 'lead', leadSessionId: owner.id, dispatch: { type: 'feature', task: 'Build it', status: 'running', acceptedAt: Date.now() - 60000 } }
  const newer = rt.conversationOf((await session(worker)).id).session
  newer.source = { kind: 'lead', leadSessionId: owner.id, dispatch: { type: 'docs', task: 'Newer task', status: 'done', acceptedAt: Date.now() } }
  assert.match(rt.leadSnapshot(owner.id), /Build it/)
  assert.doesNotMatch(rt.leadSnapshot(owner.id), /Newer task/)
  work.source.dispatch.status = 'done'
  for (const [status, label] of [['done', '已完成'], ['failed', '失败'], ['interrupted-lead', '已中断（主控）'], ['interrupted-user', '已中断（用户）'], ['unconfirmed', '未确认']]) {
    Object.assign(newer.source.dispatch, { status, reason: 'observed reason' })
    const snapshot = rt.leadSnapshot(owner.id)
    assert.ok(snapshot.includes(label))
    if (status === 'done') {
      assert.equal(rt.delegationState(worker, newer)[4], '已完成')
      assert.doesNotMatch(snapshot, /observed reason/)
      assert.doesNotMatch(rt.leadDelegations(owner.id), /observed reason/)
    } else assert.ok(snapshot.includes('observed reason'))
    assert.doesNotMatch(snapshot, /已执行/)
  }
}))

test('delegation board includes running, pending and ten recent ended sessions and scopes id lookup', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', '', { lead: true })
  const owner = rt.conversationOf((await session(lead)).id).session
  const other = await session(lead)
  const records = []
  for (let i = 0; i < 14; i++) {
    const work = rt.conversationOf((await session(worker)).id).session
    work.source = { kind: 'lead', leadSessionId: i === 13 ? other.id : owner.id, continued: 2,
      dispatch: { type: 'feature', hard: true, by: 'fallback', task: `Task ${i}`, status: i === 12 ? 'running' : 'done', acceptedAt: i, endedAt: i } }
    records.push(work)
  }
  owner.reportQueue = [{ session: records[0].id }]
  const board = rt.leadDelegations(owner.id)
  assert.equal(board.split('\n').length, 14)
  for (const i of [0, 2, 11, 12]) assert.ok(board.includes(records[i].id))
  for (const i of [1, 13]) assert.ok(!board.includes(records[i].id))
  assert.match(board, /feature \/ 难题 \/ 兜底/)
  assert.match(board, /\| 2 \|/)
  assert.ok(rt.leadDelegations(owner.id, records[1].id).includes(records[1].id))
  assert.ok(!rt.leadDelegations(owner.id, records[13].id).includes(records[13].id))
}))

test('long task first lines are truncated in dispatch summaries, snapshots, boards and reports', () => withRecovery(async h => {
  const firstLine = 'Long task '.repeat(60)
  const task = `${firstLine}\nKeep all requirements in the executor input.`
  const { work, driver, following } = await h.delegate(undefined, task)
  const expected = `${firstLine.slice(0, 159)}…`
  assert.equal(work.source.dispatch.task, expected)
  assert.ok(driver.calls[0].endsWith(task))
  for (const text of [h.rt.leadSnapshot(h.conversation.id), h.rt.leadDelegations(h.conversation.id)]) {
    assert.ok(text.includes(expected))
    assert.ok(!text.includes(firstLine))
  }
  driver.finish('done')
  const report = await until(() => h.reports()[0])
  assert.ok(report.text.includes(`Task: ${expected}.`))
  assert.ok(!report.text.includes(firstLine))
  await h.finishLead()
  await following
}))

test('role board rejects non-lead and missing caller sessions', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const conversation = await session(worker)
  for (const id of [conversation.id, 'missing-session']) {
    assert.throws(() => rt.leadRoles(id), { code: 'orch/invalid', message: '调用方必须是有效主控会话' })
  }
}))

test('role board preserves settings order, columns, task types and routing rules and redacts secrets', () => withLead(async ({ rt, role, session, host }) => {
  const first = await role('First', '', { identity: 'Coder identity', role: 'Build features', taskTypes: ['feature'], hard: {} })
  await role('Second', '', { role: 'Review changes', taskTypes: ['review'] })
  const removed = await role('Removed')
  await host.api('profile-delete', { id: removed.id })
  const lead = await role('Lead', '', { lead: true })
  const owner = await session(lead)
  rt.findProfile(first.id).identity = 'Coder identity sensitive-marker'
  const redact = rt.redactDeepSecrets
  rt.redactDeepSecrets = value => typeof value === 'string' ? redact(value).replaceAll('sensitive-marker', '[redacted]') : redact(value)
  const board = rt.leadRoles(owner.id)
  assert.match(board, /角色 \| 身份 \| 职责 \| 承接任务类型 \| 难题配置 \| 兜底/)
  assert.match(board, /First \| Coder identity \[redacted\] \| Build features \| feature \| 有/)
  assert.ok(board.indexOf('First') < board.indexOf('Second'))
  assert.doesNotMatch(board, /Removed|sensitive-marker|\| Lead \|/)
  assert.match(board, /id \| name \| when/)
  for (const type of rt.taskTypes()) assert.ok(board.includes(type.when))
  assert.match(board, /常规任务优先给不带难题配置/)
  assert.match(board, /难题只给带难题配置的角色，没有就报错/)
  assert.match(board, /无角色承接该类型时交给兜底角色/)
  rt.redactDeepSecrets = redact
}))

for (const mode of ['ordinary', 'queued', 'insert']) test(`lead ${mode} input snapshots at engine delivery and stores only user text`, () => withRecovery(async h => {
  const { work, driver, following } = await h.delegate()
  const owner = h.rt.conversationOf(h.conversation.id).session
  const leadSend = (text, extra = {}) => h.host.api('send', { profile: h.lead.id, session: owner.id, text, ...extra })
  if (mode !== 'ordinary') {
    await leadSend('Keep lead busy')
    await until(() => h.rt.driverOf(owner.id)?.calls.length)
  }
  let release
  const prepare = h.rt.prepareConversation
  const gate = new Promise(resolve => { release = resolve })
  if (mode === 'ordinary') h.rt.prepareConversation = async id => { if (id === owner.id) await gate; return prepare(id) }
  const placed = await leadSend('Current user words', mode === 'queued' ? { mode: 'queue' } : {})
  const leadDriver = h.rt.driverOf(owner.id)
  if (mode !== 'insert') {
    work.source.dispatch.task = 'Changed while waiting to send'
    release()
    if (mode === 'queued') leadDriver.finish()
    await until(() => h.rt.driverOf(owner.id)?.calls.some(text => text.includes('Current user words')))
  }
  const actual = h.rt.driverOf(owner.id)
  const input = mode === 'insert' ? actual.guides.at(-1) : actual.calls.at(-1)
  assert.match(input, /<nodo-status>/)
  assert.ok(input.includes(mode === 'insert' ? work.source.dispatch.task : 'Changed while waiting to send'))
  assert.match(input, /执行中的改动可能还没写进文件，不要据此判断任务没有执行。/)
  assert.equal(h.lines(owner).filter(line => line.who === 'user').at(-1).text, 'Current user words')
  assert.equal(placed.mode, mode === 'queued' ? 'queued' : mode === 'insert' ? 'steered' : 'turn')
  h.rt.prepareConversation = prepare
  await h.finishLead()
  driver.finish()
  await h.finishLead()
  await following
}))

test('manual recovery is running in snapshots; native waits require native observations', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.input(work)
  const summary = structuredClone(work.source.dispatch)
  assert.match(h.rt.leadSnapshot(h.conversation.id), /执行中/)
  const native = mock.method(h.rt, 'nativeWork', () => ({ status: 'waiting-question' }))
  const engine = work.engine
  work.engine = 'dsh'
  assert.match(h.rt.leadSnapshot(h.conversation.id), /等待用户/)
  native.mock.restore()
  const unavailable = mock.method(h.rt, 'nativeWork', () => null)
  assert.doesNotMatch(h.rt.leadSnapshot(h.conversation.id), /等待用户|引擎重试中|疑似卡住/)
  unavailable.mock.restore()
  work.engine = engine
  assert.deepEqual(work.source.dispatch, summary)
  driver.finish()
  await h.finishLead()
}))

for (const trigger of ['permission-answer', 'question-answer', 'request-closed', 'driver-ready']) {
  test(`queued results are delivered on ${trigger}`, () => withRecovery(async h => {
    const { work, driver } = await h.failed()
    const isCompacting = h.rt.isCompacting
    let compacting = false
    if (trigger === 'driver-ready') {
      compacting = true
      h.rt.isCompacting = id => id === h.conversation.id ? compacting : isCompacting(id)
    } else {
      h.rt.openApproval(h.conversation.id, { id: 'lead-request', kind: trigger === 'question-answer' ? 'question' : 'permission' })
    }
    await h.input(work)
    driver.finish('done', 'Result waiting for the lead')
    await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
    await h.rt.flushLeadReports(h.conversation.id)
    assert.equal(h.reports().length, 0)
    if (trigger.endsWith('-answer')) {
      h.rt.answerRequest = async () => true
      await h.rt.answerApproval('lead-request', trigger === 'question-answer' ? { decision: 'answer', value: 'Continue' } : { decision: 'allow' })
    } else if (trigger === 'request-closed') h.rt.driverSink(h.conversation.id, { type: 'request/closed', id: 'lead-request' })
    else {
      compacting = false
      h.rt.driverSink(h.conversation.id, { type: 'session', state: 'ready' })
    }
    await until(() => h.reports().length === 1)
    await h.finishLead()
    h.rt.isCompacting = isCompacting
    assert.equal(h.rt.conversationOf(h.conversation.id).session.reportQueue, undefined)
  }))
}

test('queued results are delivered once after the compaction command finishes', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  let release, started = false
  h.rt.driverOf(h.conversation.id).compact = () => {
    started = true
    return new Promise(resolve => { release = resolve })
  }
  const compacting = h.rt.compactDriver(h.conversation.id)
  await until(() => started)
  await h.input(work)
  driver.finish('done', 'Result waiting for compaction')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
  const flush = h.rt.flushLeadReports
  let checks = 0
  h.rt.flushLeadReports = (...args) => { checks++; return flush(...args) }
  try {
    h.rt.driverSink(h.conversation.id, { type: 'lifecycle', kind: 'compaction', phase: 'end' })
    assert.equal(checks, 0)
    assert.equal(h.reports().length, 0)
    release()
    await compacting
    assert.equal(checks, 1)
    await until(() => h.reports().length === 1)
    await h.finishLead()
  } finally { h.rt.flushLeadReports = flush; release(); await compacting }
}))

test('restart notifications queue once across repeated recovery and restore and ignore executor activity', () => withRecovery(async h => {
  const task = await h.delegate()
  installLead(h.rt)
  h.rt.recoverLeadDelegations()
  h.rt.recoverLeadDelegations()
  await until(() => h.reports().length === 1)
  assert.match(h.reports()[0].text, /Result: unconfirmed. Reason: restart/)
  assert.equal(h.rt.workView()[task.work.id].active, true)
  await until(() => !task.work.source.pendingReport)
  await h.finishLead()
  h.rt.recoverLeadDelegations()
  await h.rt.flushLeadReports(h.conversation.id)
  assert.equal(h.reports().length, 1)
  assert.equal(h.rt.conversationOf(h.conversation.id).session.reportQueue, undefined)
  task.driver.finish('interrupted')
  await task.following
}))

for (const unconfirmed of [false, true]) test(`delivered results survive transcript removal and restore without redelivery (unconfirmed=${unconfirmed})`, () => withRecovery(async h => {
  const task = await h.delegate()
  task.driver.finish('error', 'Final result', unconfirmed)
  const first = await until(() => h.reports()[0])
  await h.finishLead()
  await task.following
  assert.equal(task.work.source.pendingReport, undefined)
  h.rt.state.transcripts[h.conversation.id] = []
  await h.rt.save()
  const restartHome = join(h.host.home, 'restore-without-history')
  mkdirSync(restartHome)
  copyFileSync(join(h.host.home, 'state.json'), join(restartHome, 'state.json'))
  const restarted = boot(restartHome)
  try {
    const rt = await restarted.runtime
    await rt.load()
    rt.recoverLeadDelegations()
    await rt.flushLeadReports(h.conversation.id)
    assert.equal(rt.conversationOf(h.conversation.id).session.reportQueue, undefined)
    assert.equal(rt.transcriptOf(h.conversation.id).length, 0)
    assert.equal(rt.driverOf(h.conversation.id), undefined)
  } finally { restarted.dispose() }
  await h.input(task.work)
  task.driver.finish('error', 'New manual result', unconfirmed)
  const next = await until(() => h.reports()[0])
  assert.notEqual(next.origin.reportId, first.origin.reportId)
  await h.finishLead()
}))

test('recovery reports rejected queue writes through a warning', () => withRecovery(async h => {
  const task = await h.delegate()
  installLead(h.rt)
  const save = h.rt.save
  h.rt.save = async () => { throw new Error('Recovery queue write failed') }
  try {
    h.rt.recoverLeadDelegations()
    await until(() => h.rt.diagView().some(line => line.level === 'warn' && /lead report failed.*Recovery queue write failed/.test(line.text)))
  } finally { h.rt.save = save }
  await h.rt.flushLeadReports(h.conversation.id)
  await until(() => h.reports().length === 1)
  await h.finishLead()
  task.driver.finish('interrupted')
  await task.following
}))

for (const action of ['interrupt', 'amend']) test(`confirmed lead ${action} leaves only a round marker and no resume hint`, () => withRecovery(async h => {
  const task = await h.delegate()
  if (action === 'interrupt') await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
  else {
    await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Changed requirement', session: task.work.id })
    assert.equal(task.driver.active, false)
    assert.equal(task.driver.calls.length, 1)
    await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
    await until(() => task.driver.calls.length === 2 && task.driver.active)
    assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /last delegation|without a report/)
    await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
  }
  await task.following
  const markers = h.lines(h.conversation).filter(line => line.delegation?.ended)
  assert.equal(markers.length, action === 'interrupt' ? 1 : 2)
  assert.ok(markers.every(line => line.text === '' && line.delegation.ended === 'interrupted'))
  assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /last delegation|without a report/)
  assert.equal(h.reports().length, 0)
}))

test('manual recovery leaves rules unchanged after an undelivered failure', () => withRecovery(async h => {
  const task = await h.delegate()
  h.rt.conversationOf(h.conversation.id).session.archivedAt = Date.now()
  task.driver.finish('error', 'Failed while lead was archived')
  await task.following
  const owner = h.rt.conversationOf(h.conversation.id).session
  delete owner.archivedAt
  assert.doesNotMatch(h.rt.leadBrief(h.lead, owner), /last delegation/)
  await h.input(task.work)
  assert.doesNotMatch(h.rt.leadBrief(h.lead, owner), /last delegation/)
  task.driver.finish('done', 'Recovered result')
  await until(() => h.reports().length === 1)
  await h.finishLead()
}))

test('manual recovery releases its flight when the lead disappears after input admission', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const placed = await h.rt.send(h.worker.id, 'Manual recovery', work.id, [], [], { userInput: true })
  assert.ok(placed.leadFlight)
  const lead = h.rt.findProfile(h.lead.id), owner = h.rt.conversationOf(h.conversation.id).session
  lead.sessions = lead.sessions.filter(session => session.id !== owner.id)
  const following = h.rt.followLeadReport(work.id, placed, placed.leadFlight)
  await until(() => driver.calls.length === 2)
  driver.finish('done', 'Recovered without a lead')
  await following
  assert.equal(work.source.dispatch.status, 'done')
  assert.equal(work.source.pendingReport, undefined)
  assert.ok(h.lines(work).some(line => /未回报主控：主控会话不存在/.test(line.text)))
  lead.sessions.push(owner)
  const next = await h.rt.leadDispatch.delegate(owner, { type: 'feature', hard: false, task: 'Next task' })
  await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
  await until(() => h.rt.driverOf(next.session)?.active)
  await h.rt.leadDispatch.interrupt(owner, next.session)
}))

test('manual recovery reports and recovered notifications share FIFO delivery', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'Hold the lead busy' })
  await h.input(work)
  driver.finish('done', 'First manual report')
  const owner = h.rt.conversationOf(h.conversation.id).session
  await until(() => owner.reportQueue?.[0]?.referenceId)
  const orphan = h.rt.conversationOf((await h.session(h.worker)).id).session
  orphan.source = { ...work.source, dispatch: { ...work.source.dispatch, status: 'running', task: 'Other recovered task' } }
  delete orphan.source.pendingReport
  h.rt.recoverLeadDelegations()
  await until(() => owner.reportQueue?.length === 2)
  assert.deepEqual(owner.reportQueue.map(item => item.session), [work.id, orphan.id])
  assert.equal(h.reports().length, 0)
  await h.finishLead()
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'First manual report')
  await h.finishLead()
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, orphan.id)
  assert.match(h.reports()[1].text, /Result: unconfirmed/)
  await h.finishLead()
  assert.equal(owner.reportQueue, undefined)
}))

test('queued user input runs before a pending result', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'First user message' })
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'Queued user message', mode: 'queue' })
  await h.input(work)
  driver.finish('done', 'Queued result')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.length)
  await h.finishLead()
  assert.equal(h.reports().length, 0)
  await h.finishLead()
  await until(() => h.reports().length === 1)
  const userLines = h.lines(h.conversation).filter(line => line.who === 'user')
  assert.ok(userLines.findIndex(line => line.text === 'Queued user message') < userLines.findIndex(line => line.origin?.reportId === h.reports()[0].origin.reportId))
  await h.finishLead()
}))

test('tools dispatch during report replies and a running executor cannot block another result', () => withRecovery(async h => {
  const task = await h.failed()
  await h.input(task.work)
  task.driver.finish('done', 'First result')
  await until(() => h.reports().length === 1)
  await h.rt.leadDispatch.delegate(h.conversation.id, delegateType('feature', false, 'Follow-up task'))
  await h.finishLead()
  const next = await until(() => h.rt.sessionsOf(h.rt.findProfile(h.worker.id)).find(session => session.id !== task.work.id))
  await until(() => h.rt.driverOf(next.id)?.active)
  const owner = h.rt.conversationOf(h.conversation.id).session
  owner.reportQueue = [{ id: 'another-result', profile: h.worker.id, session: task.work.id, status: 'failed', text: 'Another result' }]
  await h.rt.flushLeadReports(owner.id)
  await until(() => h.reports().length === 2)
  assert.equal(h.rt.workView()[next.id].active, true)
  await h.finishLead()
  await h.host.api('interrupt', { profile: h.worker.id, session: next.id })
  await until(() => !h.rt.workView()[next.id].active)
}))

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
  await rt.leadDispatch.delegate(conversation.id, delegateType('feature', false, 'Next task'))
  await finishLead()
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
  test(`manual recovery reports ${reason}, unconfirmed=${unconfirmed} and stays resumable`, () => withRecovery(async h => {
    const { work, driver } = await h.failed()
    await h.input(work)
    driver.finish(reason, 'Still incomplete', unconfirmed, true)
    await until(() => !h.rt.workView()[work.id].active)
    const notified = unconfirmed || reason !== 'interrupted'
    if (notified) {
      await until(() => h.reports().length === 1)
      assert.match(h.reports()[0].text, unconfirmed ? /Result: unconfirmed/ : /Result: failed/)
      await h.finishLead()
    } else assert.equal(h.reports().length, 0)
    assert.equal(h.rt.leadRetryWaiting(work.id), false)
    await h.input(work)
    driver.finish('done', 'Finally complete')
    await until(() => h.reports().length === (notified ? 2 : 1))
    if (notified) assert.notEqual(h.reports()[0].origin.reportId, h.reports()[1].origin.reportId)
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

test('manual recovery refuses an occupied lead slot and can resume after it ends', () => withRecovery(async h => {
  const recovered = await h.failed()
  const running = await h.delegate()
  await assert.rejects(h.input(recovered.work), error => error.code === 'orch/invalid' && error.message.includes(running.work.id))
  assert.equal(recovered.driver.calls.length, 1)
  assert.equal(recovered.work.source.dispatch.status, 'failed')
  running.driver.finish('error')
  await h.finishLead()
  await running.following
  await h.input(recovered.work)
  assert.equal(recovered.work.source.dispatch.status, 'running')
  recovered.driver.finish('done', 'Recovered after the occupied task ended')
  await until(() => h.reports().length === 2)
  await h.finishLead()
}))

for (const action of ['archive', 'delete-profile', 'remove-session']) test(`manual report discards a lead target after ${action}`, () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  if (action === 'archive') await h.host.api('session-archive', { profile: h.lead.id, session: h.conversation.id, archived: true })
  else if (action === 'delete-profile') await h.host.api('profile-delete', { id: h.lead.id })
  else h.rt.findProfile(h.lead.id).sessions = []
  await h.input(work)
  driver.finish('done', 'Cannot deliver this')
  await until(() => h.lines(work).some(line => line.kind === 'note' && /未回报主控/.test(line.text)))
  assert.equal(work.source.pendingReport, undefined)
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

test('persisted lifecycle and continuation budgets survive clearing lead memory', () => withRecovery(async h => {
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
    await h.finishLead()
    await task.following
    assert.equal(stored().source.continued, count)
  }
  installLead(h.rt)
  await assert.rejects(h.rt.leadDispatch.delegate(h.conversation.id, delegateType('feature', false, 'Third continuation', work.id)), /已续用 2 次/)
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
    if (args[5]?.origin?.kind === 'report' && !raced) {
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
  assert.equal(work.source.pendingReport, undefined)
  const sent = await h.rt.send(h.worker.id, 'Outside the channel', work.id)
  await until(() => driver.calls.length === 2)
  driver.finish('done', 'Untracked completion')
  await sent.completion
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(work.source.dispatch.status, 'failed')
  assert.equal(h.reports().length, 0)
  await h.input(work)
  driver.finish('done', 'Tracked completion')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Tracked completion')
  await h.finishLead()
}))

test('a completed manual report blocks new delegation until delivery', () => withRecovery(async h => {
  const recovered = await h.failed()
  const leadInput = await h.rt.send(h.lead.id, 'Hold lead busy', h.conversation.id)
  await until(() => h.rt.driverOf(h.conversation.id)?.active)
  await h.input(recovered.work)
  recovered.driver.finish('done', 'Pending report')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.length)
  await assert.rejects(h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Next' }), /报告将在本轮结束后送达/)
  await h.finishLead()
  await leadInput.completion
  await until(() => h.reports().length === 1)
  await h.finishLead()
}))

for (const reason of ['done', 'error']) test(`manual recovery waits for its last queued turn (${reason})`, () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  await h.input(work, 'Start recovery', { mode: 'queue' })
  const marker = work.source.pendingReport.id
  assert.equal((await h.input(work, 'Finish the recovery', { mode: 'queue' })).mode, 'queued')
  driver.finish('done', 'Received; starting work')
  await until(() => driver.calls.length === 3)
  assert.equal(h.reports().length, 0)
  assert.equal(work.source.pendingReport.id, marker)
  assert.equal(work.source.pendingReport.ready, undefined)
  driver.finish(reason, 'Queued final reply')
  await until(() => !h.rt.workView()[work.id].active)
  if (reason === 'error') {
    await until(() => h.reports().length === 1)
    assert.match(h.reports()[0].text, /Result: failed/)
    await h.finishLead()
    await h.input(work)
    driver.finish('done', 'Recovered after queued failure')
  }
  await until(() => h.reports().length === (reason === 'done' ? 1 : 2))
  assert.equal(h.reports().at(-1).references[0].messages[0].text, reason === 'done' ? 'Queued final reply' : 'Recovered after queued failure')
  await h.finishLead()
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(h.reports().length, reason === 'done' ? 1 : 2)
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

test('a rejected report send retains the result for a later retry', () => withRecovery(async h => {
  const { work, driver } = await h.failed()
  const send = h.rt.send
  h.rt.send = (...args) => {
    if (args[5]?.origin?.kind === 'report') throw new Error('Report send rejected')
    return send(...args)
  }
  await h.input(work)
  driver.finish('done', 'Recovered but not delivered')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.referenceId)
  await h.rt.flushLeadReports(h.conversation.id)
  assert.equal(h.reports().length, 0)
  assert.equal(h.rt.conversationOf(h.conversation.id).session.reportQueue.length, 1)
  h.rt.send = send
  void h.rt.flushLeadReports(h.conversation.id)
  await until(() => h.reports().length === 1)
  await h.finishLead()
  assert.equal(h.rt.conversationOf(h.conversation.id).session.reportQueue, undefined)
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

test('a deferred reuse refused by independent work reports failure without claiming its reply', () => withRecovery(async h => {
  const task = await h.delegate()
  task.driver.finish('done', 'Original report')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Recheck', session: task.work.id })
  assert.equal(task.work.source.dispatch.status, 'queued')
  await h.input(task.work, 'Independent task')
  await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
  await until(() => h.reports().length === 2)
  assert.equal(task.work.source.dispatch.status, 'failed')
  assert.match(h.reports()[1].text, /Result: failed/)
  assert.equal(h.reports()[1].references, undefined)
  await h.finishLead()
  task.driver.finish('done', 'Independent reply')
  await until(() => !h.rt.workView()[task.work.id].active)
  assert.equal(h.reports().length, 2)
  assert.equal(task.work.source.dispatch.status, 'failed')
}))

test('a deferred send failure reports once and releases the slot', () => withRecovery(async h => {
  const send = h.rt.send
  h.rt.send = async (...args) => {
    if (args[0] === h.worker.id) throw Object.assign(new Error('Not admitted'), { code: 'orch/busy' })
    return send(...args)
  }
  try {
    const receipt = await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Accepted' })
    const work = h.rt.conversationOf(receipt.session).session
    assert.equal(work.source.dispatch.status, 'queued')
    assert.equal(h.reports().length, 0)
    await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatch'))
    await until(() => h.reports().length === 1)
    assert.equal(work.source.dispatch.status, 'failed')
    assert.match(h.reports()[0].text, /Not admitted/)
    await h.finishLead()
    assert.equal(h.reports().length, 1)
  } finally { h.rt.send = send }
  const next = await h.delegate()
  next.driver.finish('interrupted')
  await next.following
}))

for (const action of ['edit', 'delete']) test(`a ${action} of an unstarted supplement preserves the actual final report`, () => withRecovery(async h => {
  const task = await h.delegate()
  const first = await h.input(task.work, 'Withdraw this', { mode: 'queue' })
  await h.host.api('queued-message', { profile: h.worker.id, session: task.work.id, seq: first.seq, action })
  const last = await h.input(task.work, 'Withdraw this too', { mode: 'queue' })
  await h.host.api('queued-message', { profile: h.worker.id, session: task.work.id, seq: last.seq, action })
  task.driver.finish('done', 'Actual completed work')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Actual completed work')
  assert.equal(task.work.source.dispatch.status, 'done')
  assert.equal(task.driver.calls.length, 1)
  await h.finishLead()
  await task.following
}))

test('delivered unconfirmed failures suppress stale hints and refuse session reuse', () => withRecovery(async h => {
  const task = await h.delegate()
  task.driver.finish('error', 'Unconfirmed failure', true)
  await until(() => h.reports().length === 1)
  assert.match(h.reports()[0].text, /Result: unconfirmed/)
  await h.finishLead()
  await task.following
  assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /without a report/)
  await assert.rejects(h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Reuse', session: task.work.id }), /状态未确认/)
}))

test('store sync preserves active flights and marks orphaned running summaries unconfirmed', () => withRecovery(async h => {
  const task = await h.delegate(), summary = { ...task.work.source.dispatch }
  const orphan = h.rt.conversationOf((await h.session(h.worker)).id).session
  orphan.source = JSON.parse(JSON.stringify(task.work.source))
  await h.rt.save()
  const lockPath = join(h.host.home, 'state.lock'), lock = readFileSync(lockPath, 'utf8')
  try {
    writeFileSync(lockPath, JSON.stringify({ host: 'test-foreign-host', token: 'other-writer' }))
    await h.rt.refresh()
    assert.deepEqual(h.rt.conversationOf(task.work.id).session.source.dispatch, summary)
    assert.deepEqual(h.rt.conversationOf(orphan.id).session.source.dispatch, summary)
    assert.equal(h.rt.conversationOf(orphan.id).session.source.pendingReport, undefined)
  } finally {
    writeFileSync(lockPath, lock)
    await h.rt.refresh()
  }
  assert.equal(h.rt.conversationOf(orphan.id).session.source.dispatch.status, 'unconfirmed')
  assert.equal(h.rt.conversationOf(orphan.id).session.source.dispatch.reason, 'restart')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  task.driver.finish('error')
  await until(() => h.reports().length === 2)
  await h.finishLead()
  await task.following
}))

test('an end after a mid-flight store restore writes the summary onto the current session', () => withRecovery(async h => {
  const task = await h.delegate()
  const lockPath = join(h.host.home, 'state.lock'), lock = readFileSync(lockPath, 'utf8')
  try {
    writeFileSync(lockPath, JSON.stringify({ host: 'test-foreign-host', token: 'other-writer' }))
    await h.rt.refresh()
    assert.equal(h.rt.conversationOf(task.work.id).session.source.dispatch.status, 'running')
  } finally {
    writeFileSync(lockPath, lock)
    await h.rt.refresh()
  }
  task.driver.finish('done', 'Reported after restore')
  await until(() => h.rt.conversationOf(task.work.id).session.source.dispatch.status === 'done')
  await h.finishLead()
  await task.following
}))

test('a stop timeout after session removal still settles the stop and releases the slot', () => withRecovery(async h => {
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  const sessions = h.rt.findProfile(h.worker.id).sessions
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  sessions.splice(sessions.indexOf(task.work), 1)
  try {
    const result = await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
    assert.equal(result.unconfirmed, true)
    assert.equal(result.ended, 'interrupted')
    assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /## Current delegation/)
    const replacement = await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Replacement' })
    await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
    const driver = await until(() => h.rt.driverOf(replacement.session)?.active && h.rt.driverOf(replacement.session))
    driver.finish('error')
  } finally {
    sessions.push(task.work)
    h.rt.interrupt = interrupt
    RUN_LIMITS.cancelConfirmMs = limit
    task.driver.finish('interrupted')
    await task.following
  }
}))

test('a late interrupted end retains the lead as the stop owner', () => withRecovery(async h => {
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  try {
    const result = await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
    assert.equal(result.unconfirmed, true)
    assert.equal(task.work.source.dispatch.stoppedBy, 'lead')
    const saved = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    assert.equal(saved.profiles[h.worker.id].sessions.find(item => item.id === task.work.id).source.dispatch.stoppedBy, 'lead')
    task.driver.finish('interrupted')
    await task.following
    assert.equal(task.work.source.dispatch.status, 'interrupted-lead')
  } finally { h.rt.interrupt = interrupt; RUN_LIMITS.cancelConfirmMs = limit }
}))

test('an amendment that stops but remains busy explicitly says the new requirement was not sent', () => withRecovery(async h => {
  const task = await h.delegate(), workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [task.work.id]: { active: true } })
  try {
    await assert.rejects(h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Unsent requirement', session: task.work.id }), /原任务已停止，本次新要求尚未发送/)
    assert.equal(task.driver.calls.length, 1)
    assert.equal(task.work.source.dispatch.status, 'interrupted-lead')
    assert.equal(task.work.source.continued, undefined)
    await task.following
  } finally { h.rt.workView = workView }
}))

test('queued lead attachments follow the user input that actually starts', () => withRecovery(async h => {
  const first = await h.rt.send(h.lead.id, 'First request', h.conversation.id, [], [], { userInput: true, files: { paths: ['/first.txt'] } })
  await until(() => h.rt.driverOf(h.conversation.id)?.active)
  const second = await h.rt.send(h.lead.id, 'Queued request', h.conversation.id, [], [], { userInput: true, queue: true, files: { paths: ['/second.txt'] } })
  assert.equal(second.mode, 'queued')
  const receipt = await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'First task' })
  assert.equal(h.rt.driverOf(receipt.session), undefined)
  h.rt.driverOf(h.conversation.id).finish('done')
  await h.rt.followLead(h.lead.id, h.conversation.id, first)
  const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
  assert.match(driver.calls[0], /first\.txt/)
  assert.doesNotMatch(driver.calls[0], /second\.txt/)
  await h.host.api('interrupt', { profile: h.worker.id, session: receipt.session })
  await until(() => h.rt.conversationOf(receipt.session).session.source.dispatch.status === 'interrupted-user')
  await first.completion
  await until(() => h.rt.driverOf(h.conversation.id).calls.length === 2)
  const next = await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Second task' })
  await h.finishLead()
  await h.rt.followLead(h.lead.id, h.conversation.id, second)
  const nextDriver = await until(() => h.rt.driverOf(next.session)?.active && h.rt.driverOf(next.session))
  assert.match(nextDriver.calls[0], /second\.txt/)
  assert.doesNotMatch(nextDriver.calls[0], /first\.txt/)
  nextDriver.finish('error')
  await second.completion
}))

test('MCP dispatch uses driver credentials and current user attachments', () => withRecovery(async h => {
  const placed = await h.rt.send(h.lead.id, 'User request', h.conversation.id, [], [], { userInput: true, files: { paths: ['/current.txt'] } })
  const leadDriver = await until(() => h.rt.driverOf(h.conversation.id)?.active && h.rt.driverOf(h.conversation.id))
  const [spec] = leadDriver.leadMcpServers
  const client = new Client({ name: 'lead-integration', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: Object.fromEntries(spec.env.map(({ name, value }) => [name, value])), stderr: 'pipe' }))
    const missing = await client.callTool({ name: 'nodo_board', arguments: { session: 'missing-session' } })
    assert.equal(missing.content[0].text, '没有该执行会话的派活记录')
    const invalidBoard = await client.callTool({ name: 'nodo_board', arguments: { table: 'roles', session: 'missing-session' } })
    assert.equal(invalidBoard.isError, true)
    for (const args of [{ type: 'bad', hard: false, task: 'Task' }, { type: 'feature', hard: 'false', task: 'Task' }, { type: 'feature', hard: false, task: '' }]) {
      assert.equal((await client.callTool({ name: 'nodo_delegate', arguments: args })).isError, true)
      assert.equal(h.rt.sessionsOf(h.rt.findProfile(h.worker.id)).length, 0)
    }
    const response = await client.callTool({ name: 'nodo_delegate', arguments: { type: 'feature', hard: false, task: 'Implement' } })
    const receipt = JSON.parse(response.content[0].text)
    assert.equal(h.rt.driverOf(receipt.session), undefined)
    leadDriver.finish('done')
    await h.rt.followLead(h.lead.id, h.conversation.id, placed)
    const workerDriver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
    assert.equal(workerDriver.leadMcpServers, undefined)
    assert.match(workerDriver.calls[0], /current\.txt/)
    assert.deepEqual(receipt, { session: receipt.session, role: 'Worker', type: 'feature', hard: false, by: 'fallback', reused: false, message: '已受理，本轮结束后发送' })
    workerDriver.interruptTurn = async () => workerDriver.finish('interrupted', 'Last output '.repeat(500))
    const stopped = await client.callTool({ name: 'nodo_interrupt', arguments: { session: receipt.session } })
    assert.equal(JSON.parse(stopped.content[0].text).ended, 'interrupted')
    assert.match(JSON.parse(stopped.content[0].text).lastOutput, /truncated\)$/)
    await placed.completion
    h.rt.releaseDriver(h.conversation.id)
    assert.equal((await client.callTool({ name: 'nodo_board', arguments: {} })).isError, true)
  } finally { await client.close() }
}))

test('dispatch service validates amendments before stopping and returns an immediate receipt', () => withRecovery(async h => {
  const service = h.rt.leadDispatch
  await assert.rejects(service.delegate(h.worker, { type: 'feature', hard: false, task: 'Invalid owner' }), /有效主控/)
  const receipt = await service.delegate(h.conversation, { type: 'feature', hard: false, task: 'Original\nContext' })
  await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
  assert.deepEqual(receipt, { session: receipt.session, role: 'Worker', type: 'feature', hard: false, by: 'fallback', reused: false, message: '已受理，本轮结束后发送' })
  const work = h.rt.conversationOf(receipt.session).session
  const driver = await until(() => h.rt.driverOf(work.id)?.active && h.rt.driverOf(work.id))
  const summary = { ...work.source.dispatch }
  for (const command of [{ type: 'bad', hard: false, task: 'Next' }, { type: 'feature', hard: 'false', task: 'Next' }, { type: 'feature', hard: false, task: '' }]) {
    await assert.rejects(service.delegate(h.conversation, { ...command, session: work.id }), { code: 'orch/invalid' })
    assert.equal(driver.active, true)
    assert.deepEqual(work.source.dispatch, summary)
  }
  const amended = await service.delegate(h.conversation, { type: 'feature', hard: false, task: 'Updated', session: work.id })
  assert.equal(driver.active, false)
  assert.equal(driver.calls.length, 1)
  assert.equal(work.source.dispatch.status, 'queued')
  await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
  assert.equal(amended.reused, true)
  await until(() => driver.calls.length === 2)
  assert.equal(work.source.continued, 1)
  assert.equal(work.source.dispatch.task, 'Updated')
  assert.equal(work.source.dispatch.status, 'running')
  const stopped = await service.interrupt(h.conversation, work.id)
  assert.equal(stopped.ended, 'interrupted')
  assert.equal(typeof stopped.lastOutput, 'string')
  assert.equal(work.source.dispatch.status, 'interrupted-lead')
}))

test('an amendment finishing normally reports that the new requirement was not sent', () => withRecovery(async h => {
  const task = await h.delegate()
  const interrupt = h.rt.interrupt
  h.rt.interrupt = async () => { task.driver.finish('done', 'Already finished'); return true }
  try {
    const result = await h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Changed requirement', session: task.work.id })
    assert.equal(result.ended, 'done')
    assert.match(result.message, /新要求尚未发送/)
    assert.equal(task.driver.calls.length, 1)
    assert.equal(task.work.source.continued, undefined)
    await until(() => h.reports().length === 1)
    await h.finishLead()
    await task.following
  } finally { h.rt.interrupt = interrupt }
}))

test('accepted queued supplements retain the slot and freeze only their last result', () => withRecovery(async h => {
  const task = await h.delegate()
  const summary = { ...task.work.source.dispatch }
  await h.input(task.work, 'Queued requirement', { mode: 'queue' })
  assert.deepEqual(task.work.source.dispatch, summary)
  task.driver.finish('done', 'First result')
  await until(() => task.driver.calls.length === 2)
  assert.equal(h.reports().length, 0)
  assert.deepEqual(task.work.source.dispatch, summary)
  await assert.rejects(h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Another' }), /已有派活/)
  task.driver.finish('done', 'Final supplemented result')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].references[0].messages[0].text, 'Final supplemented result')
  await h.finishLead()
  await task.following
  const ended = { ...task.work.source.dispatch }
  await h.input(task.work, 'Independent work')
  task.driver.finish('done', 'Independent result')
  await until(() => !h.rt.workView()[task.work.id].active)
  assert.deepEqual(task.work.source.dispatch, ended)
  assert.equal(h.reports().length, 1)
}))

test('recovered running summaries become unconfirmed and a late end records the actual result', () => withRecovery(async h => {
  const task = await h.delegate()
  const summary = { ...task.work.source.dispatch }
  await h.rt.save()
  const restartHome = join(h.host.home, 'restart')
  mkdirSync(restartHome)
  copyFileSync(join(h.host.home, 'state.json'), join(restartHome, 'state.json'))
  const restarted = boot(restartHome)
  try {
    const rt = await restarted.runtime
    await rt.load()
    const restored = rt.conversationOf(task.work.id).session
    assert.equal(restored.source.dispatch.status, 'unconfirmed')
    assert.equal(restored.source.dispatch.acceptedAt, summary.acceptedAt)
    await assert.rejects(rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Reuse', session: task.work.id }), /状态未确认/)
    rt.leadEnded(task.work.id, { reason: 'error' })
    assert.equal(restored.source.dispatch.status, 'failed')
    const leadDriver = await until(() => rt.driverOf(h.conversation.id)?.active && rt.driverOf(h.conversation.id))
    leadDriver.finish('done', 'Reviewed restart notification')
    await until(() => !rt.workView()[h.conversation.id]?.active)
  } finally { restarted.dispose() }
  task.driver.finish('error', 'Late failure')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await task.following
  assert.equal(task.work.source.dispatch.status, 'failed')
}))

test('service budget spans calls and failures do not spend it; only accepted lead user input resets it', () => withRecovery(async h => {
  const service = h.rt.leadDispatch, command = { type: 'feature', hard: false, task: 'Budget test' }
  for (let count = 0; count < 12; count++) {
    await assert.rejects(service.delegate(h.conversation, { ...command, hard: null }), /hard 必须/)
    const receipt = await service.delegate(h.conversation, command)
    await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
    const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
    driver.finish('error')
    await until(() => h.reports().length === count + 1)
    await h.finishLead()
  }
  await assert.rejects(service.delegate(h.conversation, command), /12 次派活上限/)
  h.rt.leadBrief(h.lead, h.conversation)
  await assert.rejects(service.delegate(h.conversation, command), /12 次派活上限/)
  for (const origin of [{ kind: 'report', reportId: 'budget-report' }, { kind: 'reject' }]) {
    const placed = await h.rt.send(h.lead.id, 'Internal input', h.conversation.id, [], [], { origin })
    await h.finishLead()
    await placed.completion
    await assert.rejects(service.delegate(h.conversation, command), /12 次派活上限/)
  }
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'New request' })
  await h.finishLead()
  const receipt = await service.delegate(h.conversation, command)
  await h.rt.followLead(h.lead.id, h.conversation.id, completed('Dispatched'))
  const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
  driver.finish('error')
}))

test('amendment stop timeout marks unconfirmed and never sends the new requirement', () => withRecovery(async h => {
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  try {
    await assert.rejects(h.rt.leadDispatch.delegate(h.conversation, { type: 'feature', hard: false, task: 'Unsent change', session: task.work.id }), /停止尚未确认/)
    assert.equal(task.work.source.dispatch.status, 'unconfirmed')
    assert.equal(task.driver.calls.length, 1)
    assert.equal(task.work.source.continued, undefined)
  } finally {
    RUN_LIMITS.cancelConfirmMs = limit
    h.rt.interrupt = interrupt
    task.driver.finish('interrupted')
    await task.following
  }
}))

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
    await retryUntil(() => h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
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
    await retryUntil(() => task.work.source.dispatch.status === 'interrupted-user')
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 2)
    assert.equal(h.rt.workView()[task.work.id].active, false)
    assert.equal(h.reports().length, 0)
    assert.ok(task.work.source.pendingReport)
  } finally { mock.timers.reset() }
  await h.input(task.work)
  h.rt.driverOf(task.work.id).finish('done', 'Recovered after stopping automatic work')
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
    assert.ok(task.work.source.pendingReport.id)
    cleanup()
    await retryUntil(() => h.reports().length === 1)
    mock.timers.reset()
    await h.finishLead()
    await task.following
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(30_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(task.driver.calls.length, 1)
    assert.equal(h.rt.leadRetryWaiting(task.work.id), false)
    assert.equal(task.work.source.pendingReport, undefined)
    assert.equal(h.reports().length, 1)
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
  const summary = { ...task.work.source.dispatch }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    assert.deepEqual(task.work.source.dispatch, summary)
    const stored = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    assert.ok(stored.profiles[h.worker.id].sessions.find(item => item.id === task.work.id).source.pendingReport.id)
    assert.equal(h.rt.workView()[task.work.id].retryWaiting, true)
    assert.equal(h.rt.workView()[task.work.id].active, true)
    assert.match(h.rt.leadSnapshot(h.conversation.id), /执行中/)
    assert.match(h.rt.leadSnapshot(h.conversation.id), /等待自动续跑 1\/5/)
    const live = mock.method(h.rt, 'dispatchWork', () => ({ suspect: true, retry: true }))
    assert.match(h.rt.leadSnapshot(h.conversation.id), /等待自动续跑 1\/5/)
    live.mock.restore()
    mock.timers.tick(29_999)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(task.driver.calls.length, 1)
    mock.timers.tick(1)
    await retryUntil(() => task.driver.calls.length === 2)
    assert.match(task.driver.calls[1], /^Task from lead/)
    assert.equal(h.lines(task.work).filter(line => line.who === 'user').at(-1).origin?.kind, 'retry')
    assert.match(h.rt.leadSnapshot(h.conversation.id), /执行中/)
    assert.doesNotMatch(h.rt.leadSnapshot(h.conversation.id), /等待自动续跑/)
    assert.deepEqual(task.work.source.dispatch, summary)
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
    await h.finishLead()
    await reused.following
    assert.equal(task.work.source.continued, count, 'automatic continuation does not spend reuse budget')
  }
}))

test('five automatic continuations exhaust the retry budget and deliver a final failure', () => withRecovery(async h => {
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
    await retryUntil(() => h.reports().length === 1)
    mock.timers.reset()
    await h.finishLead()
    await task.following
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 6)
    assert.equal(task.work.source.pendingReport, undefined)
    assert.match(h.reports()[0].text, /Result: failed/)
    assert.ok(h.lines(h.conversation).some(line => /自动继续已用尽（5\/5）/.test(line.text)))
    assert.equal(h.reports().length, 1)
  } finally { mock.timers.reset() }
  await h.input(task.work)
  task.driver.finish('done', 'Manual recovery after exhaustion')
  await until(() => h.reports().length === 2)
  await h.finishLead()
  assert.equal(task.work.source.pendingReport, undefined)
}))

test('user input during an automatic turn keeps the execution summary and prevents further automatic retries', () => withRecovery(async h => {
  const task = await h.delegate(), summary = { ...task.work.source.dispatch }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    mock.timers.tick(30_000)
    await retryUntil(() => task.driver.calls.length === 2)
    await h.input(task.work, 'Additional user requirement')
    assert.deepEqual(task.work.source.dispatch, summary)
    task.driver.finish('error', 'Still failed', false, true)
    await retryUntil(() => h.reports().length === 1)
    mock.timers.reset()
    await h.finishLead()
    await task.following
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 2)
    assert.equal(task.work.source.dispatch.status, 'failed')
    assert.equal(task.work.source.pendingReport, undefined)
  } finally { mock.timers.reset() }
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
        stopping = h.rt.leadDispatch.interrupt(h.conversation.id, task.work.id)
      } else if (action === 'user-stop') {
        await h.host.api('interrupt', { profile: h.worker.id, session: task.work.id })
      } else if (action === 'user-message') {
        await h.host.api('send', { profile: h.worker.id, session: task.work.id, text: 'User takes over' })
        await retryUntil(() => task.driver.calls.length === 2)
      } else {
        const send = h.rt.send
        h.rt.send = (...args) => {
          if (args[0] === h.worker.id && args[5]?.exclusive) throw Object.assign(new Error('Busy'), { code: 'orch/busy' })
          return send(...args)
        }
        mock.timers.tick(30_000)
      }
      if (action === 'busy') {
        await retryUntil(() => h.reports().length === 1)
        mock.timers.reset()
        await h.finishLead()
        mock.timers.enable({ apis: ['setTimeout'] })
      }
      await task.following
      await retryUntil(() => h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
      if (stopping) await stopping
      if (action !== 'user-message') await retryUntil(() => task.work.source.dispatch.status !== 'running')
      if (action === 'busy') assert.equal(task.work.source.pendingReport, undefined)
      else assert.equal(task.work.source.pendingReport.id, marker)
      if (action === 'user-stop') assert.equal(task.work.source.dispatch.status, 'interrupted-user')
      assert.ok(h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
      mock.timers.tick(300_000)
      assert.equal(task.driver.calls.length, action === 'user-message' ? 2 : 1)
      if (action === 'lead-interrupt' || action === 'user-stop') assert.equal(h.rt.workView()[task.work.id].active, false)
      assert.equal(h.reports().length, action === 'busy' ? 1 : 0)
    } finally { mock.timers.reset() }
    if (stopping) await stopping
    if (action !== 'user-message') await h.input(task.work)
    h.rt.driverOf(task.work.id).finish('done', 'User completed the task')
    await until(() => h.reports().length === (action === 'busy' ? 2 : 1))
    await h.finishLead()
    await h.input(task.work, 'Later chat')
    h.rt.driverOf(task.work.id).finish('done', 'Unrelated')
    await until(() => !h.rt.workView()[task.work.id].active)
    assert.equal(h.reports().length, action === 'busy' ? 2 : 1)
    assert.equal(task.work.source.pendingReport, undefined)
  }))
}

for (const [reason, unconfirmed, retryable] of [['error', false, false], ['error', true, true], ['interrupted', false, true]]) {
  test(`delegation does not auto-continue ${reason}, unconfirmed=${unconfirmed}, retryable=${retryable}`, () => withRecovery(async h => {
    const task = await h.delegate()
    task.driver.finish(reason, 'Not eligible', unconfirmed, retryable)
    if (reason !== 'interrupted' || unconfirmed) await h.finishLead()
    await task.following
    assert.equal(task.driver.calls.length, 1)
    if (reason === 'interrupted' && !unconfirmed) {
      await until(() => task.work.source.pendingReport)
      assert.ok(task.work.source.pendingReport)
    }
    else assert.equal(task.work.source.pendingReport, undefined)
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
    const following = toolTask(h.rt, conversation.id, delegateType('feature', false))
    for (let attempt = 1; attempt <= 5; attempt++) {
      await retryUntil(() => h.lines(conversation).some(line => line.text?.includes(`自动继续（${attempt}/5）`)))
      mock.timers.tick(30_000)
    }
    mock.timers.reset()
    await following
    for (let i = 0; i < 11; i++) await toolTask(h.rt, conversation.id, delegateType('feature', false))
    await assert.rejects(h.rt.leadDispatch.delegate(conversation.id, delegateType('feature', false)), /12 次派活上限/)
    assert.equal(calls, 17, '12 delegations plus 5 automatic continuations')
    assert.equal(h.rt.sessionsOf(h.rt.findProfile(worker.id)).length, 12)
    assert.equal(h.lines(conversation).filter(line => /主控派活已停止/.test(line.text)).length, 0)
  } finally { mock.timers.reset() }
}))

test('a saved lead on the plan tier or outside the lead engines refuses sends; executors are unaffected', () => withLead(async ({ rt, role, session, send }) => {
  const worker = await role('Worker', 'Done', { permission: 'plan' })
  const lead = await role('Lead', 'Answered', { lead: true })
  const leadConversation = await session(lead)
  const workerConversation = await session(worker)
  // Saved data predates these rules and never migrates in place: the send is refused.
  rt.state.profiles[lead.id].permission = 'plan'
  const found = rt.conversationOf(leadConversation.id)
  found.session.permission = 'plan'
  await assert.rejects(send(lead, leadConversation, 'Hello'), { code: 'orch/lead-invalid', message: /计划模式/ })
  rt.state.profiles[lead.id].permission = 'workspace'
  found.session.permission = 'workspace'
  rt.state.profiles[lead.id].engine = 'echo'
  await assert.rejects(send(lead, leadConversation, 'Hello'), { code: 'orch/lead-invalid', message: /不支持主控/ })
  assert.equal((await send(worker, workerConversation, 'Hello')).mode, 'turn')
}))

test('a result for a non-compliant lead notes the executor session once and delivers after the lead is fixed', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Changed src/task.js; verified task tests; nothing open.')
  const lead = await role('Lead', 'Answered', { lead: true })
  const leadConversation = await session(lead)
  rt.state.profiles[lead.id].permission = 'plan'
  rt.conversationOf(leadConversation.id).session.permission = 'plan'
  await toolTask(rt, leadConversation.id, delegateType('feature', false))
  const delegated = rt.sessionsOf(rt.findProfile(worker.id)).at(-1)
  const queued = () => rt.conversationOf(leadConversation.id).session.reportQueue
  const notes = () => lines(delegated).filter(line => /未回报主控/.test(line.text ?? ''))
  await until(() => notes().length === 1)
  assert.equal(notes().length, 1)
  assert.match(notes()[0].text, /计划模式/)
  assert.equal(queued().length, 1)
  await rt.flushLeadReports(leadConversation.id)
  assert.equal(notes().length, 1, 'the same result never notes twice')
  rt.state.profiles[lead.id].permission = 'workspace'
  rt.conversationOf(leadConversation.id).session.permission = 'workspace'
  await rt.flushLeadReports(leadConversation.id)
  assert.equal(queued(), undefined)
  assert.ok(lines(leadConversation).some(line => line.who === 'user' && line.origin?.kind === 'report'))
}))

test('a lead token that reaches recorded tool output is redacted', () => withLead(async ({ rt, role, session }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const binding = await rt.issueLeadMcp(conversation.id)
  const token = binding.servers[0].env.find(({ name }) => name === 'NODO_LEAD_TOKEN').value
  assert.match(rt.redactSecrets(`NODO_LEAD_TOKEN=${token}`), /\[secret:NODO_LEAD_TOKEN\]/)
  rt.driverSink(conversation.id, { type: 'tool', name: 'bash', phase: 'end', outputText: `$ env\nNODO_LEAD_TOKEN=${token}` })
  const line = rt.transcriptOf(conversation.id).find(item => item.kind === 'tool' && item.name === 'bash')
  assert.equal(line.output.includes(token), false)
  assert.match(line.output, /\[secret:NODO_LEAD_TOKEN\]/)
}))
