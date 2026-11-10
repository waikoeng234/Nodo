import { routeUserTask, userRoute } from './helpers/route.js'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX, RUN_LIMITS, TURN_IDLE_TIMEOUT_MS } from '../core/src/constants.js'
import { leadRules } from '../core/src/lead-rules.js'
import { install as installLead } from '../core/src/lead.js'
import { route } from '../core/shared/route.js'
import defaultTaskTypes from '../core/shared/task-types.json' with { type: 'json' }
import { registerEngine } from '../agent-drivers/dist/index.js'
import { echoEntry, registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { boot, until, withHost } from './helpers/host.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { reviewDeliveredReports } from './helpers/report-review.js'

registerClaudeFixtureEngine()
registerEngine('lead-echo-final', { ...echoEntry, info: { ...echoEntry.info, id: 'lead-echo-final' }, create(options) {
  let final
  return echoEntry.create({ ...options, onEvent: event => {
    if (event.type === 'turn/start') final = undefined
    if (event.type === 'text') final = event.text
    options.onEvent({ ...event, ...(event.type === 'turn/end' && final !== undefined ? { text: final } : {}) })
  } })
} })

// The changes fixture emits the given snapshot bodies at each turn start, so a
// delegation records real change snapshots through the normal dispatch sinks.
registerEngine('lead-changes', { ...echoEntry, info: { ...echoEntry.info, id: 'lead-changes' }, validate: raw => raw, create(options) {
  const snapshots = options.changes ?? []
  return echoEntry.create({ ...options, onEvent: event => {
    options.onEvent(event)
    if (event.type === 'turn/start') for (const body of snapshots) options.onEvent({ type: 'changes', turnId: event.turnId,
      presentation: { version: 1, kind: 'changes', mode: 'snapshot', capture: body.capture ?? 'complete', body } })
  } })
} })

const delegateType = (type, hard, task = 'Implement the task\nKeep existing changes; report paths and tests.', extra = {}) => ({ type, hard, task, ...extra })
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
  const receipt = await (command.action ? rt.leadRoute(session, command) : routeUserTask(rt, session, command))
  await rt.followLead(session, completed('Dispatched'))
  await waitFor(() => !['queued', 'running'].includes(rt.state.executions[receipt.executionId].status))
  await waitFor(() => {
    const owner = rt.conversationOf(session).session
    return rt.transcriptOf(session).some(line => line.delegation?.executionId === receipt.executionId && ['done', 'interrupted'].includes(line.delegation.ended)) || owner.reportQueue?.some(item => item.executionId === receipt.executionId && item.text)
      || rt.transcriptOf(session).filter(line => line.origin?.kind === 'report').length > before
  })
  await rt.flushLeadReports(session)
  const owner = rt.conversationOf(session)
  if (!owner.session.archivedAt && owner.session.permission !== 'plan') await waitFor(() => !rt.conversationOf(session).session.reportQueue?.length)
  await waitFor(() => !rt.workView()[session]?.active)
  await reviewDeliveredReports(rt, session)
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
  const rt = await runtime
  await api('teams-update', { teams: [{ name: 'Team', lead: lead.id, members: [removed.id, kept.id], types: [{ id: 'feature', name: '功能', when: '' }], assign: { feature: { normal: { profile: removed.id } } } }] })
  await api('profile-delete', { id: removed.id })
  assert.deepEqual(rt.teams()[0].members, [kept.id])
  assert.deepEqual(rt.teams()[0].assign.feature.normal, {})
  await api('teams-update', { teams: [{ ...rt.teams()[0], assign: { feature: { normal: { profile: kept.id } } } }] })
  assert.doesNotMatch(rt.leadBrief(lead, { id: 'lead-session' }), /Removed/)
  assert.equal(rt.findProfile(removed.id), undefined)
  const workspace = await api('workspace-create', { name: 'Project', cwd: join(home, 'ws') })
  const conversation = await api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(rt.state.profiles[removed.id].sessions.length, 0)
  assert.equal(rt.findProfile(kept.id).sessions[0].source.type, 'feature')
}))

const withLead = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Lead workspace', cwd: join(host.home, 'ws') })
  // Teams replace the per-role task settings: roles declare the old shape and
  // sync() compiles it into the lead's team assignment table; every team keeps
  // the built-in catalog as its own types.
  const catalog = defaultTaskTypes.map(({ id, name, when }) => ({ id, name, when }))
  const legacy = new Map(), splits = new Set()
  const sync = async () => {
    const live = Object.values(rt.state.profiles).filter(profile => !profile.deletedAt)
    const roster = live.filter(profile => profile.lead !== true)
    await rt.updateTeams(live.filter(profile => profile.lead === true).map(lead => {
      const assign = {}
      for (const type of catalog) {
        const holders = roster.filter(item => legacy.get(item.id)?.taskTypes.includes(type.id))
        const hardOf = item => legacy.get(item.id).hard
        const normal = (splits.has(type.id) ? holders.find(item => hardOf(item) === undefined) : undefined) ?? holders[0]
        const hard = splits.has(type.id) ? holders.find(item => hardOf(item) !== undefined) : undefined
        if (!normal && !hard) continue
        assign[type.id] = { ...(normal ? { normal: { profile: normal.id } } : {}),
          ...(splits.has(type.id) ? { hard: hard ? { profile: hard.id, ...hardOf(hard) } : {} } : {}) }
      }
      return { id: lead.id, name: lead.name, lead: lead.id, members: roster.map(item => item.id), types: catalog.map(type => ({ ...type })), assign }
    }))
  }
  const split = async (type, on) => { if (on) splits.add(type); else splits.delete(type); await sync() }
  const role = async (name, text = 'Work completed', { taskTypes, hard, ...extra } = {}) => {
    const created = await host.api('profile-create', {
      name, engine: extra.lead === true ? 'claude' : 'lead-echo-final', engineOptions: { script: [{ kind: 'text', text: typeof text === 'string' ? text : 'Reviewed' }] }, ...extra,
    })
    legacy.set(created.id, { taskTypes: extra.lead === true ? [] : taskTypes ?? ['feature'], hard })
    await sync()
    return created
  }
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
  await run({ host, rt, workspace, role, split, session, inputs, tracked, send, lines, placements })
})

test('delegation waits for a successful lead turn before sending', () => withLead(async ({ rt, role, session, inputs }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const sends = [], send = rt.send
  rt.send = (...args) => { sends.push(args); return send(...args) }
  let finish
  const following = rt.followLead(conversation.id, { mode: 'turn', completion: new Promise(resolve => { finish = resolve }) })
  const receipt = await routeUserTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(sends.filter(args => args[0] === worker.id).length, 0)
  assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 0)
  assert.match(receipt.message, /受理.*本轮结束后发送/)
  finish({ reason: 'done' })
  await following
  await until(() => rt.delegationSummary(rt.conversationOf(receipt.session).session).status === 'done')
  await waitFor(() => !rt.workView()[conversation.id]?.active)
}))

for (const reason of ['interrupted', 'error', 'rejected']) {
  test(`unsent delegation is cancelled without reports when lead ends: ${reason}`, () => withLead(async ({ rt, role, session, inputs }) => {
    await role('Worker', 'Done')
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    const receipt = await routeUserTask(rt, conversation.id, delegateType('feature', false))
    await rt.followLead(conversation.id, { mode: 'turn', completion: reason === 'rejected' ? Promise.reject(new Error('failed')) : Promise.resolve({ reason }) })
    assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 0)
    assert.equal(rt.delegationSummary(rt.conversationOf(receipt.session).session).reason, 'cancelled')
    assert.equal(rt.conversationOf(conversation.id).session.reportQueue, undefined)
    const next = await routeUserTask(rt, conversation.id, delegateType('feature', false))
    assert.notEqual(next.session, receipt.session)
    await rt.followLead(conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  }))
}

test('restart cancels unsent delegations without reports or occupied slots', () => withLead(async ({ host, rt, role, session }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await routeUserTask(rt, conversation.id, delegateType('feature', false))
  const restartHome = join(host.home, 'restart')
  mkdirSync(restartHome)
  copyFileSync(join(host.home, 'state.json'), join(restartHome, 'state.json'))
  const restarted = boot(restartHome)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    await until(() => recovered.state.executions[receipt.executionId].status === 'cancelled')
    assert.equal(recovered.state.executions[receipt.executionId].reason, 'restart-unsent')
    assert.equal(recovered.state.tasks[receipt.taskId].status, 'stopped')
    assert.equal(recovered.conversationOf(conversation.id).session.reportQueue, undefined)
    assert.equal(recovered.driverOf(receipt.session), undefined)
    const next = await routeUserTask(recovered, conversation.id, { ...delegateType('feature', false), continues: receipt.taskId })
    assert.equal(next.session, receipt.session)
    await recovered.followLead(conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  } finally { await restarted.dispose() }
  await rt.followLead(conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
}))

test('lead delegates in its workspace, returns referenced reports and stops at 24 without changing the selected session', () => withLead(async ({ host, rt, workspace, role, session, inputs, send, lines }) => {
  const otherWorkspace = await host.api('workspace-create', { name: 'Worker workspace', cwd: join(host.home, 'other') })
  const worker = await role('Worker', 'Changed src/task.js; verified task tests; nothing open.', { role: 'Implementation', goal: 'Ship the task' })
  const selected = await session(worker, otherWorkspace.id)
  const task = 'Implement the task\nKeep existing changes; report paths and tests.'
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const response = await send(lead, conversation, 'Please implement this')
  assert.equal(response.mode, 'turn')
  for (let i = 0; i < 24; i++) {
    await toolTask(rt, conversation.id, delegateType('feature', false, task))
    await waitFor(() => rt.transcriptOf(conversation.id).filter(line => line.origin?.kind === 'report').length > i)
  }
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)), /24 次派活上限/)
  const liveWorker = rt.findProfile(worker.id)
  const delegated = liveWorker.sessions.filter(item => item.source?.kind === 'lead')
  assert.equal(delegated.length, 24)
  assert.equal(liveWorker.activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  for (const [index, work] of delegated.entries()) {
    assert.equal(work.workspaceRef, workspace.id)
    assert.equal(work.name, 'Implement the task')
    assert.equal(rt.delegationSummary(work).status, 'done')
    assert.deepEqual((({ dispatch, ...source }) => source)(work.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, type: 'feature', hard: false })
    const delivered = inputs.find(item => item.sessionId === work.id).text
    assert.match(delivered, /^# 本轮要求/)
    assert.match(delivered, /按上面的原话完成/)
    assert.doesNotMatch(delivered, /List changed files once at the end/)
    assert.ok(delivered.includes(task))
    if (index === 0) assert.ok(delivered.includes(task), 'the task body still rides inline')
    assert.equal(delivered.includes('--- 来源'), false, 'the default dispatch never inlines a user message')
    assert.equal(lines(work).find(line => line.who === 'user').text, delivered)
  }
  assert.equal(lines(conversation).filter(line => line.text?.startsWith('已受理 Worker ·')).length, 24)
  const reports = lines(conversation).filter(line => line.who === 'user' && line.origin?.kind === 'report')
  assert.equal(reports.length, 24)
  assert.ok(reports[0].text.startsWith('Report from Worker · Implement the task\nStatus: done'))
  assert.equal(rt.state.executions[reports[0].origin.executionId].sessionId, delegated[0].id)
  assert.equal(reports[0].references, undefined)
  assert.equal(rt.state.executions[reports[0].origin.executionId].result.text, 'Changed src/task.js; verified task tests; nothing open.')
  assert.ok(reports.every((line, index) => line.origin.kind === 'report' && line.origin.session === delegated[index].id))
  assert.deepEqual(lines(conversation).filter(line => line.delegation).map(line => line.delegation),
    delegated.map(work => ({ taskId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).taskId, executionId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).id, session: work.id, profile: worker.id, type: 'feature', hard: false, reused: false, deferred: true })))
  assert.equal(lines(conversation).filter(line => /主控派活已停止/.test(line.text)).length, 0)
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.length, 25)
  assert.ok(leadInputs.slice(1).every(item => item.text.includes('<nodo-status>') && item.text.includes('已完成')))
  assert.ok(leadInputs.every(item => !item.text.includes('## Task types') && !item.text.includes('```nodo')))
  assert.ok(leadInputs.every(item => !item.text.includes('"origin":')))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Please implement this')
  assert.equal(conversation.name, 'Session 1')
  assert.equal(rt.conversation(lead.id, conversation.id).session.name, 'Please implement this')
  rt.conversation(lead.id, conversation.id).session.engineOptions.script[0].text = 'Reviewed'
  await send(lead, conversation, 'Next user message')
  await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.equal(liveWorker.sessions.filter(item => item.source?.kind === 'lead').length, 25, 'a new user message resets the delegation limit')
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
  await host.api('teams-update', { teams: rt.teams().map(team => team.lead === lead.id
    ? { ...team, types: [{ id: 'feature', name: 'Feature', when: 'Updated responsibility' }] } : team) })
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
    await rt.followLead(conversation.id, completed(text))
  }
  for (const outcome of [{ reason: 'interrupted' }, { reason: 'error' }, { reason: 'done', unconfirmed: true }, { reason: 'done', final: 'No command' }]) {
    await rt.followLead(conversation.id, { mode: 'turn', completion: Promise.resolve({ text: delegateType('feature', false), ...outcome }) })
  }
  for (const mode of ['steered', 'indeterminate']) await rt.followLead(conversation.id, {
    mode, get completion() { throw new Error('Joined placements must not be tracked') },
  })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 1)
}))


test('a tool reuses the executor after an explicit stop and reports only the revised work', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done', { engineOptions: { script: [{ kind: 'wait', ms: 100 }, { kind: 'text', text: 'Revised work done' }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await routeUserTask(rt, conversation.id, delegateType('feature', false))
  await rt.followLead(conversation.id, completed('Dispatched'))
  await until(() => inputs.some(item => item.sessionId === receipt.session))
  await rt.leadDispatch.interrupt(conversation.id, { executionId: receipt.executionId })
  await toolTask(rt, conversation.id, delegateType('feature', false, 'Apply the new constraint', { continues: receipt.taskId }))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === receipt.session).length, 2)
  assert.deepEqual(lines(conversation).filter(line => line.delegation && !line.delegation.ended).map(line => line.delegation.reused), [false, true])
  const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
  assert.equal(reports.length, 1)
  assert.equal(rt.state.executions[reports[0].origin.executionId].result.text, 'Revised work done')
}))

test('overlapping interrupt tools share stop confirmation without sending another lead input', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await routeUserTask(rt, conversation.id, delegateType('feature', false))
  await rt.followLead(conversation.id, completed('Dispatched'))
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

test('a running delegation is left alone and a follow-up opens another session', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'text', text: 'Progress' }, { kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = toolTask(rt, conversation.id, delegateType('feature', false))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.approvalsView().some(item => item.sessionId === work.id))
  const second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Second change'))
  assert.equal(second.continued, false)
  assert.equal(second.reason, '没有接续来源任务')
  assert.notEqual(second.session, work.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
  await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId })
  await rt.interrupt(worker.id, work.id)
  await first
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 0)
  assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
  const note = lines(conversation).find(line => line.delegation?.ended === 'interrupted' && line.delegation.session === work.id)
  assert.equal(note.text, '')
  assert.deepEqual(note.delegation, { session: work.id, taskId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).taskId, executionId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).id, ended: 'interrupted', stoppedBy: 'user' })
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
  await until(() => rt.approvalsView().some(item => item.sessionId === work.id))
  try {
    assert.match(rt.leadSnapshot(conversation.id), new RegExp(work.id))
    await host.api('send', { profile: lead.id, session: conversation.id, text: 'How is it going?' })
    assert.equal(rt.workView()[work.id]?.active, true, 'a progress question does not stop work')
    await assert.rejects(rt.leadDispatch.interrupt(other.id, work.id), /只能中断本主控会话当前派出的执行任务/)
    assert.equal(rt.workView()[work.id]?.active, true, 'another lead session cannot stop this task')
    assert.equal(lines(other).filter(line => line.origin?.kind === 'reject').length, 0)
    await rt.leadDispatch.interrupt(conversation.id, work.id)
    await pending
    assert.equal(rt.workView()[work.id]?.active ?? false, false)
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
  let requested = false, release, second
  const gate = new Promise(resolve => { release = resolve })
  rt.interrupt = async (...args) => { requested = true; await gate; return interrupt(...args) }
  const stopping = rt.leadDispatch.interrupt(conversation.id, work.id)
  try {
    await until(() => requested)
    assert.equal(rt.workView()[work.id]?.stopping, true, 'a stop request shows in the live work view before the turn settles')
    second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Second change'))
    assert.equal(second.continued, false)
    assert.notEqual(second.session, work.id)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
    assert.equal(lines(conversation).filter(line => line.origin?.kind === 'reject').length, 0)
  } finally {
    release()
    await stopping
    await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId })
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
    if (args[0] === worker.id && !held) { await placed.turn; held = true; await gate }
    return placed
  }
  const pending = toolTask(rt, conversation.id, delegateType('feature', false))
  await until(() => held)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await until(() => rt.workView()[work.id]?.active)
  const stopping = rt.leadDispatch.interrupt(conversation.id, work.id)
  try {
    await until(() => rt.workView()[work.id]?.active !== true)
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
    assert.equal(rt.workView()[work.id]?.active ?? false, false, 'dispatch releases occupancy despite a stuck driver stop')
    assert.equal(rt.workView()[work.id]?.suspect ?? false, false)
    const ended = () => lines(conversation).filter(line => line.delegation?.ended)
    assert.deepEqual(ended().map(line => line.delegation), [{ session: work.id, taskId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).taskId, executionId: Object.values(rt.state.executions).find(item => item.sessionId === work.id).id, ended: 'interrupted', unconfirmed: true }])
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
    assert.equal(rt.state.executions[reports[1].origin.executionId].result.text, 'Fresh work')
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
  let settled = false, second
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
      assert.equal(rt.workView()[work.id]?.active, true)
      assert.equal(rt.workView()[work.id]?.suspect ?? false, true)
      assert.match(rt.leadSnapshot(conversation.id), /疑似卡住/)
      assert.deepEqual(interrupted, [])
      assert.equal(lines(conversation).filter(line => line.origin?.kind === 'report').length, 0)
    } finally { mock.timers.reset() }
    second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Second change'))
    assert.equal(second.continued, false)
    assert.notEqual(second.session, work.id)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2, 'silence cannot release the lead delegation')
    assert.ok(lines(work).some(line => line.kind === 'note' && /仍在等待.*手动停止/.test(line.text)))
    rt.driverSink(work.id, { type: 'turn/end', turnId: 'turn-1', reason: 'done', text: 'Late work completed' })
    await pending
    assert.equal(rt.workView()[work.id]?.active ?? false, false)
    assert.equal(rt.workView()[work.id]?.suspect ?? false, false)
    const reports = lines(conversation).filter(line => line.origin?.kind === 'report')
    assert.equal(reports.length, 1)
    assert.match(reports[0].text, /Status: done/)
    assert.equal(rt.state.executions[reports[0].origin.executionId].result.text, 'Late work completed')
    assert.ok(inputs.some(item => item.profileId === lead.id && item.text.includes('Late work completed')))
  } finally {
    rt.interruptDriver = interruptDriver
    await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId }).catch(() => {})
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
  assert.match(reports[0].text, /Status: failed · error/)
  assert.match(reports[1].text, /Status: unconfirmed · done/)
  assert.ok(reports.every(line => !line.references && !line.text.includes(line.origin.session) && line.text.includes('Report from Worker · Implement the task')))
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
  const taskId = Object.values(rt.state.executions).find(item => item.sessionId === failed.id).taskId
  const again = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { taskId }))
  assert.equal(again.session, failed.id)
  assert.equal(again.continued, true)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === failed.id).length, 2)
  assert.ok(lines(conversation).some(line => line.text === `继续受理 Worker · ${failed.name}（功能 · 常规）`))
}))

test('a new accepted user message resets the delegation budget of the running chain', () => withLead(async ({ host, rt, role, session, tracked, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  for (let i = 0; i < 6; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await host.api('send', { profile: lead.id, session: conversation.id, text: 'A second message' })
  await tracked.at(-1)
  for (let i = 0; i < 24; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)), /24 次派活上限/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 30)

}))

for (const [name, script, expected] of [
  ['no completed reply', [], /Completeness: unavailable \(missing-final\)/],
  ['oversized reply is archived whole without a reference', [{ kind: 'text', text: 'x'.repeat(TRANSCRIPT_TEXT_MAX + 1000) }], /Completeness: complete/],
]) test(`lead report fallback: ${name}`, () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script = script
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, delegateType('feature', false))
  const report = lines(conversation).find(line => line.origin?.kind === 'report')
  assert.match(report.text, /Report from Worker/)
  assert.match(report.text, expected)
  assert.equal(report.references, undefined)
  assert.ok(report.text.length < TASK_TEXT_MAX)
  const result = await rt.executionContext(conversation.id, { action: 'read', sourceId: `execution:${report.origin.executionId}:result` })
  assert.equal(result.length, script[0]?.text.length ?? 0)
  assert.ok(!inputs.find(input => input.profileId === lead.id).text.includes('```nodo'))
}))

test('lead tracking catches completion failures and warns without rejecting', () => withLead(async ({ rt, role, session }) => {
  await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(conversation.id, { mode: 'turn', completion: Promise.reject(new Error('Completion failed')) })
  assert.ok(rt.diagView().some(line => line.level === 'warn' && line.text.includes('Completion failed')))
}))

test('a delegated message at the text limit composes the worker input and echoes it into the transcript', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const padding = 'Task from lead Lead. Start your report with a one-line outcome summary, actual verification results and unresolved issues.\nCarry out the task as written. If something the task leaves open blocks you, list it in the report with the possible approaches.\nWrite the body as conclusions, marking file:line only after claims that need checking, such as defect root causes or review findings.\n\n'
  const task = 'x'.repeat(TASK_TEXT_MAX - padding.length)
  await toolTask(rt, conversation.id, delegateType('feature', false, task))
  const received = inputs.find(input => input.profileId === worker.id).text
  assert.match(received, /^# 本轮要求/)
  assert.ok(received.includes(`# 本轮要求（用户原话，逐字，唯一需求来源）\n${task}`))
  assert.ok(received.length > TASK_TEXT_MAX && received.length < 96_000)
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
  assert.ok(received.includes('Check [secret:LEAD_TITLE_TEST]\nReport findings'))
  assert.equal(lines(work).find(line => line.who === 'user').text, received)
}))

test('a delegation title names the new task and executor session, redacted and cut to one line', () => withLead(async ({ host, rt, role, session, inputs }) => {
  const value = 'lead-title-param-private-value'
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  await host.api('secret-set', { name: 'LEAD_TITLE_PARAM', value, purpose: 'test', scope: [lead.id] })
  const conversation = await session(lead)
  for (const title of ['', '  ', 3]) {
    await assert.rejects(routeUserTask(rt, conversation.id, { ...delegateType('feature', false), title }), /任务标题为空|title 必须是最多 80 字/)
  }
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  const brief = '1. 任务目标：实现团队运行树\n2. 完成标准：测试通过'
  const receipt = await toolTask(rt, conversation.id, { ...delegateType('feature', false, brief), title: `  团队运行树 ${value}\n第二行` })
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.name, '团队运行树 [secret:LEAD_TITLE_PARAM]')
  assert.equal(rt.state.tasks[receipt.taskId].title, work.name)
  assert.equal(rt.state.tasks[receipt.taskId].brief, brief)
  assert.ok(inputs.find(input => input.profileId === worker.id).text.includes(brief))
  await assert.rejects(routeUserTask(rt, conversation.id, { ...delegateType('feature', false), title: 'x'.repeat(100) }), { code: 'orch/title-empty' })
}))

test('route stores the redacted original with the trigger text cap', () => withLead(async ({ host, rt, role, session }) => {
  await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true }), conversation = await session(lead)
  const value = 'lead-task-limit-fixture'
  await host.api('secret-set', { name: 'LEAD_TASK_LIMIT_FIXTURE_WITH_A_LONG_NAME', value, purpose: 'test', scope: [lead.id] })
  const receipt = await toolTask(rt, conversation.id, delegateType('feature', false, value.repeat(1000)))
  const task = rt.state.tasks[receipt.taskId], trigger = rt.state.triggers[task.triggerId]
  assert.equal(task.brief, trigger.text)
  assert.ok(trigger.text.length <= TASK_TEXT_MAX)
  assert.equal(trigger.text.includes(value), false)
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
  const report = lines(conversation).find(line => line.origin?.kind === 'report')
  assert.match(report.text, /Result preview:/)
  assert.equal(report.references, undefined)
  assert.ok(!report.text.includes(value.slice(0, 8)))
  assert.ok(!inputs.find(input => input.profileId === lead.id).text.includes(value.slice(0, 8)))
  const archived = rt.state.executions[report.origin.executionId].result.text
  assert.ok(archived.includes('[secret:LEAD_REPORT_TEST]'))
  assert.ok(!archived.includes(value))
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
  const approval = await until(() => rt.approvalsView().find(item => item.sessionId === work.id))
  await host.api('profile-update', { id: lead.id, changes: { lead: false } })
  await host.api('approval-answer', { id: approval.id, decision: 'allow' })
  await pending
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const report = lines(conversation).find(line => line.who === 'user' && line.origin?.kind === 'report')
  assert.match(report.text, /Status: done/)
  assert.equal(rt.state.executions[report.origin.executionId].result.text, 'Completed changes and tests')
}))

test('a delegation to a dsh lead native session carries the result sourceId without references', () => withLead(async ({ rt, role, session }) => {
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
  assert.deepEqual(returned[4], [])
  const execution = rt.state.executions[returned[5].origin.executionId]
  assert.equal(execution.profileId, worker.id)
  assert.ok(returned[1].includes(`nodo_context read executionId ${execution.id}`))
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
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)), /没有承接「功能」的角色/)
  assert.equal(rt.leadBrief(lead, conversation), leadRules)
}))

test('route sends a type to its assigned role and hard work to the hard pick when there is one', () => {
  const assign = {
    feature: { normal: { profile: 'a' }, hard: { profile: 'b', model: 'm1', thinking: 'high' } },
    docs: { normal: { profile: 'c', model: 'm2' } },
    review: { normal: { profile: 'a' }, hard: {} },
    ops: { hard: { profile: 'b' } },
  }
  for (const [type, hard, expected] of [
    ['feature', false, { profile: 'a', choices: {} }],
    ['feature', true, { profile: 'b', choices: { model: 'm1', thinking: 'high' } }],
    ['docs', false, { profile: 'c', choices: { model: 'm2' } }],
    ['docs', true, { profile: 'c', choices: { model: 'm2' } }],
    ['review', false, { profile: 'a', choices: {} }],
    ['review', true, { miss: true }],
    ['ops', false, { miss: true }],
    ['ops', true, { profile: 'b', choices: {} }],
    ['refactor', false, { miss: true }],
  ]) assert.deepEqual(route(assign, type, hard), expected)
  assert.deepEqual(route(undefined, 'feature', false), { miss: true })
})

test('routing mode delegates by type, applies hard settings and records the choice', () => withLead(async ({ rt, split, role, session, lines }) => {
  const unrelated = await role('Other', 'Unused', { taskTypes: ['feature'], hard: {} })
  const worker = await role('Router', 'Fixed the alignment; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await split('bug-fix', true)
  await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the misaligned button'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(rt.delegationSummary(work).status, 'done')
  assert.deepEqual((({ dispatch, ...source }) => source)(work.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, type: 'bug-fix', hard: true })
  assert.equal(work.model, 'hard-model')
  assert.equal(work.thinking, 'high')
  assert.ok(lines(conversation).some(line => line.text === '已受理 Router · Fix the misaligned button（修复 · 难题）'))
  await toolTask(rt, conversation.id, delegateType('bug-fix', false, 'Fix the label'))
  const regular = rt.sessionsOf(rt.findProfile(worker.id))[1]
  assert.equal(rt.delegationSummary(regular).status, 'done')
  assert.deepEqual((({ dispatch, ...source }) => source)(regular.source), { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, type: 'bug-fix', hard: false })
  assert.equal(regular.model, undefined)
  assert.equal(regular.thinking, undefined)
  assert.ok(lines(conversation).some(line => line.text === '已受理 Router · Fix the label（修复 · 常规）'))
  await split('bug-fix', false)
  await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the spacing'))
  const merged = rt.sessionsOf(rt.findProfile(worker.id))[2]
  assert.equal(merged.source.hard, true)
  assert.equal(merged.model, undefined, 'a split-off type delegates hard work on the base settings')
  assert.equal(merged.thinking, undefined)
  assert.equal(rt.sessionsOf(rt.findProfile(unrelated.id)).length, 0, 'roles without the requested task type never receive work')
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
  ['empty title', { ...delegateType('feature', false), title: '' }, /标题为空/],
  ['oversized title', { ...delegateType('feature', false), title: 'x'.repeat(81) }, /最多 80 字/],
  ['unsupported task body', { ...delegateType('feature', false), context: {} }, /字段无效/],
]) test(`tool delegation rejects ${name} without feedback or work`, () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  for (let i = 0; i < 2; i++) await assert.rejects(routeUserTask(rt, conversation.id, command), expected)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who !== 'user').length, 0)
}))

test('a team without task types refuses delegation and asks for types first', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.updateTeams([{ ...rt.teamOf(lead.id), types: [], assign: {} }])
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)),
    { code: 'orch/unknown-type', message: 'type 必须是本团队任务类型清单中的 id' })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

test('routing mode uses the team type assignment', () => withLead(async ({ rt, role, session }) => {
  const router = await role('Router', 'Feature done', { taskTypes: ['feature'] })
  const writer = await role('Writer', 'Docs done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await toolTask(rt, conversation.id, { type: 'feature', hard: false, task: 'Build the feature' })
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).filter(item => item.source?.kind === 'lead').length, 1)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
}))

test('an unclaimed type pauses without creating executor work', () => withLead(async ({ rt, split, role, session, inputs, send, lines }) => {
  const writer = await role('Writer', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('feature', false, 'Build it'), { lead: true })
  const conversation = await session(lead)
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)), /没有承接「功能」的角色/)
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', true)), /没有承接「功能」的角色/)
  await split('docs', true)
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('docs', true)), /没有承接「文档」的角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who !== 'user').length, 0)
  await send(lead, conversation, 'Second message')
  assert.doesNotMatch(inputs.at(-1).text, /did not run your last delegation|```nodo/)

}))

test('a lead can continue its own dispatched session instead of opening a new one', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Work completed')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const second = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  assert.equal(second.session, work.id)
  assert.equal(second.continued, true)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const sent = inputs.filter(item => item.sessionId === work.id)
  assert.equal(sent.length, 2)
  assert.ok(sent[1].text.startsWith('# 本轮要求'))
  assert.ok(sent[1].text.includes('Implement the task\nKeep existing changes; report paths and tests.'))
  assert.ok(lines(conversation).some(line => line.text === `继续受理 Worker · ${work.name}（功能 · 常规）`))
  assert.deepEqual(lines(conversation).filter(line => line.delegation).map(line => line.delegation.reused), [false, true])
  const report = lines(conversation).filter(line => line.who === 'user' && line.origin?.kind === 'report').at(-1)
  assert.ok(report.text.startsWith(`Report from Worker · ${work.name}\nStatus: done`))
  assert.equal(rt.state.executions[report.origin.executionId].sessionId, work.id)
}))

test('routing mode continues a session when the type and difficulty match', () => withLead(async ({ rt, split, role, session, lines }) => {
  const worker = await role('Router', 'Fixed the header; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await split('bug-fix', true)
  const first = await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the header'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.model, 'hard-model')
  const second = await toolTask(rt, conversation.id, delegateType('bug-fix', true, 'Fix the footer', { continues: first.taskId }))
  assert.equal(second.session, work.id)
  assert.equal(second.continued, true)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(work.model, 'hard-model', 'a continued session keeps the model it was opened with')
  assert.ok(lines(conversation).some(line => line.text === '继续受理 Router · Fix the header（修复 · 难题）'))
}))

test('an archived candidate session falls back to a new session with the reason', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const own = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, own.id).session.archivedAt = Date.now()
  const second = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  assert.equal(second.continued, false)
  assert.equal(second.reason, '候选会话已归档')
  assert.notEqual(second.session, own.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 2)
}))

test('an unconfirmed candidate falls back to a new session with the reason', () => withLead(async ({ rt, role, session, inputs }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    const outcome = await placed.completion
    return { ...placed, completion: Promise.resolve({ ...outcome, unconfirmed: true }) }
  }
  const again = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  rt.send = send
  assert.equal(again.session, work.id)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  // The unconfirmed execution still occupies the task; a continues relation
  // reaches the candidate check and refuses to reuse the session.
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false, undefined, { taskId: again.taskId })), /pending execution/)
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false, 'Next change', { continues: again.taskId })), { code: 'orch/source-busy' })
}))

test('an interrupted candidate keeps continuing the same session', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Second change', { taskId: first.taskId }))
  assert.equal(second.session, work.id)
  await rt.followLead(conversation.id, completed('Dispatched'))
  await until(() => rt.approvalsView().some(item => item.sessionId === work.id))
  await rt.interrupt(worker.id, work.id)
  await until(() => rt.delegationSummary(work).status === 'interrupted-user')
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'text', text: 'Done' }
  const third = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  assert.equal(third.session, work.id)
  assert.equal(third.continued, true)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 3)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).length, 0)
}))

test('continues reuses the source session or hands over its last result', () => withLead(async ({ rt, role, session, inputs }) => {
  const worker = await role('Worker', 'Parser built and verified')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false, 'Build the parser'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const next = await toolTask(rt, conversation.id, delegateType('feature', false, 'Extend the parser', { continues: first.taskId }))
  assert.equal(next.session, work.id)
  assert.equal(next.continued, true)
  assert.notEqual(next.taskId, first.taskId)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const poke = rt.send(worker.id, 'Poke', work.id, [], [])
  await until(() => rt.approvalsView().some(item => item.sessionId === work.id))
  const third = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Rework the parser', { continues: first.taskId }))
  assert.equal(third.continued, false)
  assert.equal(third.reason, '候选会话正忙')
  assert.notEqual(third.session, work.id)
  await rt.followLead(conversation.id, completed('Dispatched'))
  const handover = await until(() => inputs.find(item => item.sessionId === third.session))
  assert.ok(handover.text.includes('Parser built and verified'), 'the last result is handed over as required context')
  await rt.leadDispatch.interrupt(conversation.id, { executionId: third.executionId })
  await rt.interrupt(worker.id, work.id)
  await poke
}))

test('routing mode opens a new session when the difficulty differs', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', true, 'Fix the header'))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const second = await toolTask(rt, conversation.id, delegateType('feature', false, 'Fix the footer', { continues: first.taskId }))
  assert.equal(second.continued, false)
  assert.equal(second.reason, '候选会话的难度与本次不一致')
  assert.notEqual(second.session, work.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
}))

for (const on of [true, false]) {
  test(`a difficulty change on the same role opens a new session with the current settings (split ${on ? 'on' : 'off'})`, () => withLead(async ({ rt, split, role, session }) => {
    const worker = await role('Dual', 'Done', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    await split('feature', on)
    const hard = await toolTask(rt, conversation.id, delegateType('feature', true, 'Deep rework'))
    assert.equal(rt.conversationOf(hard.session).session.model, on ? 'hard-model' : undefined)
    const denied = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Follow-up', { continues: hard.taskId }))
    assert.equal(denied.continued, false)
    assert.equal(denied.reason, '候选会话的难度与本次不一致')
    assert.notEqual(denied.session, hard.session)
    await rt.leadDispatch.interrupt(conversation.id, { executionId: denied.executionId })
    const routine = await toolTask(rt, conversation.id, delegateType('feature', false, 'Follow-up'))
    assert.notEqual(routine.session, hard.session)
    assert.equal(routine.reused, false)
    assert.equal(rt.conversationOf(routine.session).session.model, undefined)
    assert.equal(rt.conversationOf(routine.session).session.source.hard, false)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 3)
  }))
}

test('a session is continued while it has fewer than five executions', () => withLead(async ({ rt, role, session, inputs }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  for (let i = 0; i < 4; i++) {
    const receipt = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
    assert.equal(receipt.session, work.id)
    assert.equal(receipt.continued, true)
  }
  assert.equal(work.source.continued, 4)
  const fifth = await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  assert.equal(fifth.continued, false)
  assert.equal(fifth.reason, '候选会话承接的执行数已达上限')
  assert.notEqual(fifth.session, work.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 5)
}))

test('a busy candidate session falls back to a new session', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const poke = rt.send(worker.id, 'Poke', work.id, [], [])
  await until(() => rt.approvalsView().some(item => item.sessionId === work.id))
  const second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Second change', { taskId: first.taskId }))
  assert.equal(second.continued, false)
  assert.equal(second.reason, '候选会话正忙')
  assert.notEqual(second.session, work.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 2)
  await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId })
  assert.ok(!lines(conversation).some(line => line.text?.startsWith('继续受理')))
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  await rt.interrupt(worker.id, work.id)
  await poke
}))

test('continuations count toward the 24-delegation budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', delegateType('feature', false), { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const continued = rt.sessionsOf(rt.findProfile(worker.id))[0]
  for (let i = 0; i < 2; i++) await toolTask(rt, conversation.id, delegateType('feature', false, undefined, { continues: first.taskId }))
  for (let i = 0; i < 21; i++) await toolTask(rt, conversation.id, delegateType('feature', false))
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false)), /24 次派活上限/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 22)
  assert.equal(inputs.filter(item => item.sessionId === continued.id).length, 3)
  assert.equal(inputs.filter(item => item.text.startsWith('# 本轮要求')).length, 24)

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
    assert.equal(leadRules.split('\n').length, 10)
    for (const pattern of [/nodo_board, nodo_context, nodo_route, nodo_review/, /Never write task bodies/, /Missing facts go to an investigation worker/,
      /scope.quote as an exact substring/, /at most 100 UTF-16 units/, /reason and non-empty basis/, /1–5 questions/, /user accepts on a card/,
      /nodo_route ask requires questions and stopExecutionIds/, /Never ask the same question through native tools/]) assert.match(leadRules, pattern)
  }
}))


for (const [hard, settings] of [[false, undefined], [true, undefined], [true, { model: 'hard-model', thinking: 'high' }]]) {
  test(`unclaimed types stop without dispatch (${hard ? 'hard' : 'routine'}, ${settings ? 'hard settings' : 'card settings'})`, () => withLead(async ({ rt, role, session, lines }) => {
    const worker = await role('Generalist', 'Unused', { taskTypes: ['docs'], model: 'regular-model', hard: settings })
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', hard, 'Build it')), /没有承接「功能」的角色/)
    assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
    assert.equal(lines(conversation).filter(line => line.who !== 'user').length, 0)
    const valid = await routeUserTask(rt, conversation.id, delegateType('docs', false, 'Write docs'))
    assert.equal(valid.role, 'Generalist', 'a rejected delegation leaves the lead free to dispatch valid work')
    await rt.followLead(conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  }))
}

for (const [firstHard, nextHard] of [[true, false], [false, true]]) {
  test(`follow-up difficulty changes from ${firstHard ? 'hard' : 'routine'} to ${nextHard ? 'hard' : 'routine'} and selects a fresh executor`, () => withLead(async ({ rt, split, role, session, inputs }) => {
    const routine = await role('Routine', 'Routine work completed', { taskTypes: ['feature'] })
    const hard = await role('Hard', 'Hard work completed', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
    const lead = await role('Lead', 'Reviewed', { lead: true })
    const conversation = await session(lead)
    await split('feature', true)
    const first = await toolTask(rt, conversation.id, delegateType('feature', firstHard, 'Original task'))
    assert.equal(first.role, firstHard ? 'Hard' : 'Routine')
    const denied = await routeUserTask(rt, conversation.id, delegateType('feature', nextHard, 'Follow-up', { continues: first.taskId }))
    assert.equal(denied.continued, false)
    assert.match(denied.reason, /不一致/)
    await rt.leadDispatch.interrupt(conversation.id, { executionId: denied.executionId })
    const task = `Continue from session ${first.session}. Preserve existing changes and report; complete only the remaining work.`
    const next = await toolTask(rt, conversation.id, delegateType('feature', nextHard, task))
    assert.equal(next.role, nextHard ? 'Hard' : 'Routine')
    assert.notEqual(next.session, first.session)
    assert.equal(next.reused, false)
    const work = rt.conversationOf(next.session).session
    assert.equal(work.source.hard, nextHard)
    assert.equal(work.model, nextHard ? 'hard-model' : undefined)
    assert.equal(rt.sessionsOf(rt.findProfile(routine.id)).length, nextHard ? 1 : 2)
    assert.equal(rt.sessionsOf(rt.findProfile(hard.id)).length, nextHard ? 2 : 1)
    assert.ok(inputs.find(item => item.sessionId === next.session).text.includes(task))
  }))
}

test('a hard task stops when only an unrelated role has hard capacity', () => withLead(async ({ rt, split, role, session, inputs, send, lines }) => {
  const unrelated = await role('Other', 'Unused', { taskTypes: ['feature'], hard: {} })
  const worker = await role('Worker', 'Unused', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('docs', true), { lead: true })
  const conversation = await session(lead)
  await split('docs', true)
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('docs', true)), /没有承接「文档」的角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(unrelated.id)).length, 0)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who !== 'user').length, 0)
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
      await toolTask(rt, conversation.id, { action: 'new', type: 'feature', hard: false, scope: { quote: 'See screenshot' } })
      const delegated = inputs.find(item => item.profileId === worker.id)
      assert.match(delegated.text, /# 本轮要求[\s\S]*See screenshot/)
      assert.match(delegated.text, /图片 1 张/)
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
    const previous = Object.values(rt.state.executions).findLast(item => item.sessionId === reuse?.id)
    const receipt = await routeUserTask(rt, conversation.id, { ...delegateType('feature', false, text), ...(previous ? { taskId: previous.taskId } : {}) })
    await rt.followLead(conversation.id, completed('Dispatched'))
    const work = reuse ?? await until(() => rt.sessionsOf(rt.findProfile(worker.id))[count])
    const driver = await until(() => rt.driverOf(work.id)?.active && rt.driverOf(work.id))
    const following = h.placements.get(receipt.session).completion
    return { work, driver, following }
  }
  const failed = async () => {
    const task = await delegate()
    task.driver.finish('error', 'Original failed reply')
    const notification = await until(() => reports()[0])
    assert.match(notification.text, /Status: failed/)
    await finishLead()
    await task.following
    setupReports.add(notification.origin.reportId)
    assert.equal(rt.delegationSummary(task.work).status, 'failed')
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
    await reviewDeliveredReports(rt, conversation.id)
    driver.finish('done', text)
    await until(() => !rt.workView()[conversation.id]?.active || driver.calls.length > count)
  }
  await run({ ...h, worker, lead, conversation, reports, delegate, failed, input, finishLead })
    } finally { registerEngine('claude', echoEntry) }
  })
}

test('one lead turn starts both flights in order and each result arrives while the other is running', () => withRecovery(async h => {
  const { rt, lead, conversation } = h
  let finish
  const following = rt.followLead(conversation.id, { mode: 'turn', completion: new Promise(resolve => { finish = resolve }) })
  const first = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'A'))
  const second = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'B'))
  assert.equal(rt.driverOf(first.session), undefined)
  assert.equal(rt.driverOf(second.session), undefined)
  finish({ reason: 'done' })
  await following
  const a = await until(() => rt.driverOf(first.session)?.active && rt.driverOf(first.session))
  const b = await until(() => rt.driverOf(second.session)?.active && rt.driverOf(second.session))
  assert.deepEqual(h.inputs.filter(item => [first.session, second.session].includes(item.sessionId)).map(item => item.sessionId), [first.session, second.session])
  a.finish('done', 'A finished independently')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.executionId, first.executionId)
  assert.equal(rt.state.executions[second.executionId].status, 'running')
  assert.equal(b.active, true)
  await h.finishLead()
  const stopped = await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId })
  assert.equal(stopped.ended, 'interrupted')
  assert.equal(rt.state.executions[first.executionId].status, 'done')
  assert.equal(h.reports().length, 1)
  assert.equal(h.lines(conversation).filter(line => line.delegation?.executionId === second.executionId && line.delegation.ended).length, 1)
}))

test('a lead accepts B while A runs and stopping B leaves A active', () => withRecovery(async h => {
  const a = await h.delegate()
  const b = await h.delegate()
  await h.rt.leadDispatch.interrupt(h.conversation, b.work.id)
  assert.equal(b.driver.active, false)
  assert.equal(a.driver.active, true)
  assert.equal(h.rt.delegationSummary(a.work).status, 'running')
  a.driver.finish('done', 'A after stopping B')
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.session, a.work.id)
  await h.finishLead()
}))

test('unloading lead cancels every deferred flight once', () => withRecovery(async h => {
  const effects = []
  const rt = { ...h.rt, ctx: { effect(factory) { effects.push(factory()) } } }
  installLead(rt)
  const flights = []
  for (let index = 0; index < 2; index++) flights.push(await routeUserTask(rt, h.conversation.id, delegateType('feature', false)))
  for (const dispose of effects) dispose()
  await until(() => flights.every(item => rt.state.executions[item.executionId].status === 'cancelled'))
  await until(() => flights.every(item => h.lines(h.conversation).some(line => line.delegation?.executionId === item.executionId && line.delegation.ended)))
  for (const item of flights) assert.equal(h.lines(h.conversation).filter(line => line.delegation?.executionId === item.executionId && line.delegation.ended).length, 1)
}))

test('snapshot and board share live state without saving or changing dispatch summaries', () => withRecovery(async h => {
  const rt = h.rt
  const { work, driver, following } = await h.delegate()
  const summary = structuredClone(rt.delegationSummary(work))
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
  assert.deepEqual(rt.delegationSummary(work), summary)
  save.mock.restore()
  driver.finish('done')
  await h.finishLead()
  await following
  assert.equal(rt.delegationSummary(work).status, 'done')
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

test('snapshot lists every active delegation while parallel executions run', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const owner = await session(lead)
  const first = rt.conversationOf((await session(worker)).id).session
  first.source = { kind: 'lead', leadSessionId: owner.id, dispatch: { type: 'feature', task: 'First task', status: 'running', acceptedAt: Date.now() - 60000 } }
  const second = rt.conversationOf((await session(worker)).id).session
  second.source = { kind: 'lead', leadSessionId: owner.id, dispatch: { type: 'docs', task: 'Second task', status: 'queued', acceptedAt: Date.now() } }
  const snapshot = rt.leadSnapshot(owner.id)
  assert.match(snapshot, /First task/)
  assert.match(snapshot, /Second task/)
  assert.equal(snapshot.split('\n').filter(line => line.startsWith('|')).length, 4)
  first.source.dispatch.status = 'done'
  assert.doesNotMatch(rt.leadSnapshot(owner.id), /First task/)
  assert.match(rt.leadSnapshot(owner.id), /Second task/)
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
      dispatch: { type: 'feature', hard: true, task: `Task ${i}`, status: i === 12 ? 'running' : 'done', acceptedAt: i, endedAt: i } }
    records.push(work)
  }
  owner.reportQueue = [{ session: records[0].id }]
  const board = rt.leadDelegations(owner.id)
  assert.equal(board.split('\n').length, 14)
  for (const i of [0, 2, 11, 12]) assert.ok(board.includes(records[i].id))
  for (const i of [1, 13]) assert.ok(!board.includes(records[i].id))
  assert.match(board, /feature \/ 难题/)
  assert.match(board, /\| 2 \|/)
  assert.ok(rt.leadDelegations(owner.id, records[1].id).includes(records[1].id))
  assert.ok(!rt.leadDelegations(owner.id, records[13].id).includes(records[13].id))
}))

test('long task first lines are truncated in dispatch summaries, snapshots, boards and reports', () => withRecovery(async h => {
  const rt = h.rt
  const firstLine = 'Long task '.repeat(60)
  const task = `${firstLine}\nKeep all requirements in the executor input.`
  const { work, driver, following } = await h.delegate(undefined, task)
  const expected = `${firstLine.slice(0, 159)}…`
  assert.equal(rt.delegationSummary(work).task, expected)
  assert.ok(driver.calls[0].includes(task))
  for (const text of [h.rt.leadSnapshot(h.conversation.id), h.rt.leadDelegations(h.conversation.id)]) {
    assert.ok(text.includes(expected))
    assert.ok(!text.includes(firstLine))
  }
  driver.finish('done')
  const report = await until(() => h.reports()[0])
  assert.ok(report.text.startsWith(`Report from Worker · ${expected}\n`))
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

test('role board preserves settings order, columns, task types and routing rules and redacts secrets', () => withLead(async ({ rt, split, role, session, host }) => {
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
  assert.match(board, /角色 \| 身份 \| 职责/)
  assert.match(board, /First \| Coder identity \[redacted\] \| Build features/)
  assert.ok(board.indexOf('First') < board.indexOf('Second'))
  assert.doesNotMatch(board, /Removed|sensitive-marker|\| Lead \|/)
  assert.match(board, /id \| name \| when \| 常规任务 \| 难题 \| 独立视角/)
  assert.match(board, /feature \| 功能 \| [^|]* \| First \| 同常规任务/)
  assert.match(board, /docs \| 文档 \| [^|]* \| 无人承接 \| 同常规任务/)
  await split('review', true)
  const updated = rt.leadRoles(owner.id)
  assert.match(updated, /review \| 审查 \| [^|]* \| Second \| 无人承接/)
  for (const type of rt.teamOf(lead.id).types) assert.ok(updated.includes(type.when))
  assert.match(board, /没有承接角色就停止派活并说明缺口/)
  assert.match(board, /没有单独指定难题角色的类型，常规和难题都派给常规角色/)
  assert.match(board, /分配变更只影响之后的派活/)
  rt.redactDeepSecrets = redact
}))

for (const mode of ['ordinary', 'queued', 'insert']) test(`lead ${mode} input snapshots at engine delivery and stores only user text`, () => withRecovery(async h => {
  const rt = h.rt
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
    rt.state.tasks[Object.values(rt.state.executions).find(item => item.sessionId === work.id).taskId].brief = 'Changed while waiting to send'
    release()
    if (mode === 'queued') leadDriver.finish()
    await until(() => h.rt.driverOf(owner.id)?.calls.some(text => text.includes('Current user words')))
  }
  const actual = h.rt.driverOf(owner.id)
  const input = mode === 'insert' ? actual.guides.at(-1) : actual.calls.at(-1)
  assert.match(input, /<nodo-status>/)
  assert.ok(input.includes(mode === 'insert' ? rt.delegationSummary(work).task : 'Changed while waiting to send'))
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
  const rt = h.rt
  const { work, driver } = await h.failed()
  await h.input(work)
  const summary = structuredClone(rt.delegationSummary(work))
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
  assert.deepEqual(rt.delegationSummary(work), summary)
  driver.finish()
  await h.finishLead()
}))

for (const trigger of ['permission-answer', 'question-answer', 'request-closed', 'driver-ready']) {
  test(`queued results are delivered on ${trigger}`, () => withRecovery(async h => {
  const rt = h.rt
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
    await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.text)
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
  const rt = h.rt
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
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.text)
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
  const rt = h.rt
  const task = await h.delegate()
  installLead(h.rt)
  h.rt.recoverLeadDelegations()
  h.rt.recoverLeadDelegations()
  await until(() => h.reports().length === 1)
  assert.match(h.reports()[0].text, /Status: unconfirmed · restart/)
  assert.equal(h.rt.workView()[task.work.id]?.active, true)
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
  const rt = h.rt
  const task = await h.delegate()
  task.driver.finish('error', 'Final result', unconfirmed)
  const first = await until(() => h.reports()[0])
  await h.finishLead()
  await task.following
  assert.equal(task.work.source.pendingReport, undefined)
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
  } finally { await restarted.dispose() }
  await h.input(task.work)
  task.driver.finish('error', 'New manual result', unconfirmed)
  const next = await until(() => h.reports().find(line => line.origin.reportId !== first.origin.reportId))
  assert.notEqual(next.origin.reportId, first.origin.reportId)
  await h.finishLead()
}))

test('recovery reports rejected queue writes through a warning', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  installLead(h.rt)
  const save = h.rt.save
  h.rt.save = async () => { throw new Error('Recovery queue write failed') }
  try {
    h.rt.recoverLeadDelegations()
    await until(() => h.rt.diagView().some(line => line.level === 'warn' && /execution recovery failed.*Recovery queue write failed/.test(line.text)))
  } finally { h.rt.save = save }
  await h.rt.flushLeadReports(h.conversation.id)
  await until(() => h.reports().length === 1)
  await h.finishLead()
  task.driver.finish('interrupted')
  await task.following
}))

for (const action of ['interrupt', 'amend']) test(`confirmed lead ${action} leaves only a round marker and no resume hint`, () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  if (action === 'interrupt') await h.rt.leadDispatch.interrupt(h.conversation, { executionId: Object.values(h.rt.state.executions).findLast(item => item.sessionId === task.work.id).id })
  else {
    await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
    const taskId = Object.values(h.rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
    await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Changed requirement', continues: taskId })
    assert.equal(task.driver.active, false)
    assert.equal(task.driver.calls.length, 1)
    await h.rt.followLead(h.conversation.id, completed('Dispatched'))
    await until(() => task.driver.calls.length === 2 && task.driver.active)
    assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /last delegation|without a report/)
    await h.rt.leadDispatch.interrupt(h.conversation, { executionId: Object.values(h.rt.state.executions).findLast(item => item.sessionId === task.work.id).id })
  }
  await task.following
  const markers = h.lines(h.conversation).filter(line => line.delegation?.ended)
  assert.equal(markers.length, action === 'interrupt' ? 1 : 2)
  assert.ok(markers.every(line => line.text === '' && line.delegation.ended === 'interrupted'))
  assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /last delegation|without a report/)
  assert.equal(h.reports().length, 0)
}))

test('manual recovery leaves rules unchanged after an undelivered failure', () => withRecovery(async h => {
  const rt = h.rt
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
  const rt = h.rt
  const { work, driver } = await h.failed()
  const placed = await h.rt.send(h.worker.id, 'Manual recovery', work.id, [], [], { userInput: true })
  assert.ok(placed.leadFlight)
  const lead = h.rt.findProfile(h.lead.id), owner = h.rt.conversationOf(h.conversation.id).session
  lead.sessions = lead.sessions.filter(session => session.id !== owner.id)
  const following = h.rt.followLeadReport(work.id, placed, placed.leadFlight)
  await until(() => driver.calls.length === 2)
  driver.finish('done', 'Recovered without a lead')
  await following
  assert.equal(rt.delegationSummary(work).status, 'done')
  assert.equal(work.source.pendingReport, undefined)
  assert.ok(h.lines(work).some(line => /未回报主控：主控会话不存在/.test(line.text)))
  lead.sessions.push(owner)
  const next = await routeUserTask(h.rt, owner, { type: 'feature', hard: false, task: 'Next task' })
  await h.rt.followLead(h.conversation.id, completed('Dispatched'))
  await until(() => h.rt.driverOf(next.session)?.active)
  await h.rt.leadDispatch.interrupt(owner, next.session)
}))

test('manual recovery reports and recovered notifications share FIFO delivery', () => withRecovery(async h => {
  const rt = h.rt
  const { work, driver } = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'Hold the lead busy' })
  await h.input(work)
  driver.finish('done', 'First manual report')
  const owner = h.rt.conversationOf(h.conversation.id).session
  await until(() => owner.reportQueue?.[0]?.text)
  const orphan = h.rt.conversationOf((await h.session(h.worker)).id).session
  orphan.source = { ...work.source, dispatch: { ...rt.delegationSummary(work), status: 'running', task: 'Other recovered task' } }
  delete orphan.source.pendingReport
  h.rt.recoverLeadDelegations()
  await until(() => owner.reportQueue?.length === 2)
  assert.deepEqual(owner.reportQueue.map(item => item.session), [work.id, orphan.id])
  assert.equal(h.reports().length, 0)
  await h.finishLead()
  await until(() => h.reports().length === 1)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'First manual report')
  await h.finishLead()
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, orphan.id)
  assert.match(h.reports()[1].text, /Status: unconfirmed/)
  await h.finishLead()
  assert.equal(owner.reportQueue, undefined)
}))

test('queued user input runs before a pending result', () => withRecovery(async h => {
  const rt = h.rt
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
  const rt = h.rt
  const task = await h.failed()
  await h.input(task.work)
  task.driver.finish('done', 'First result')
  await until(() => h.reports().length === 1)
  await reviewDeliveredReports(rt, h.conversation.id)
  await routeUserTask(h.rt, h.conversation.id, delegateType('feature', false, 'Follow-up task'))
  await h.finishLead()
  const next = await until(() => h.rt.sessionsOf(h.rt.findProfile(h.worker.id)).find(session => session.id !== task.work.id))
  await until(() => h.rt.driverOf(next.id)?.active)
  const owner = h.rt.conversationOf(h.conversation.id).session
  owner.reportQueue = [{ id: 'another-result', profile: h.worker.id, session: task.work.id, status: 'failed', text: 'Another result' }]
  await h.rt.flushLeadReports(owner.id)
  await until(() => h.reports().length === 2)
  assert.equal(h.rt.workView()[next.id]?.active, true)
  await h.finishLead()
  await h.host.api('interrupt', { profile: h.worker.id, session: next.id })
  await until(() => !h.rt.workView()[next.id]?.active)
}))

test('a Nodo manual recovery reports its exact reply once and the lead can delegate again', () => withRecovery(async h => {
  const { rt, worker, lead, conversation, reports, failed, input, finishLead, lines } = h
  const { work, driver } = await failed()
  await input(work)
  driver.finish('done', 'Recovered changes and verified tests')
  const report = await until(() => reports()[0])
  assert.match(report.text, /manually resumed/)
  assert.equal(rt.state.executions[report.origin.executionId].result.text, 'Recovered changes and verified tests')
  assert.ok(report.text.includes(`nodo_context read executionId ${report.origin.executionId}`))
  await until(() => !work.source.pendingReport)
  await until(() => rt.driverOf(conversation.id)?.active)
  assert.doesNotMatch(rt.driverOf(conversation.id).calls[0], /last delegation/)
  assert.doesNotMatch(rt.leadBrief(rt.findProfile(lead.id), conversation), /last delegation/)
  const next = rt.sessionsOf(rt.findProfile(worker.id)).length
  await reviewDeliveredReports(rt, conversation.id)
  await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Next task'))
  await finishLead()
  const nextWork = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[next])
  const nextDriver = await until(() => rt.driverOf(nextWork.id)?.calls.length && rt.driverOf(nextWork.id))
  nextDriver.finish('done', 'Next task complete')
  await until(() => reports().length === 2)
  await finishLead()
  await input(work, 'Ordinary later conversation')
  driver.finish('done', 'Unrelated later reply')
  await until(() => rt.workView()[work.id]?.active !== true)
  await rt.flushLeadReports(conversation.id)
  assert.equal(reports().length, 2)
}))

for (const [reason, unconfirmed] of [['error', false], ['interrupted', false], ['done', true]]) {
  test(`manual recovery reports ${reason}, unconfirmed=${unconfirmed} and stays resumable`, () => withRecovery(async h => {
  const rt = h.rt
    const { work, driver } = await h.failed()
    await h.input(work)
    driver.finish(reason, 'Still incomplete', unconfirmed, true)
    await until(() => !h.rt.workView()[work.id]?.active)
    const notified = unconfirmed || reason !== 'interrupted'
    if (notified) {
      await until(() => h.reports().length === 1)
      assert.match(h.reports()[0].text, unconfirmed ? /Status: unconfirmed/ : /Status: failed/)
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
  const rt = h.rt
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
  const rt = h.rt
  const { work, driver } = await h.failed()
  await h.input(work)
  assert.equal((await h.input(work, 'Queued recovery', { mode: 'queue' })).mode, 'queued')
  driver.finish('error', 'First recovery failed')
  await until(() => driver.calls.length === 3)
  assert.ok(work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  driver.finish('done', 'Queued recovery succeeded')
  await until(() => h.reports().length === 1)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Queued recovery succeeded')
  await h.finishLead()
}))

test('manual reports freeze before FIFO delivery and never steer into a busy lead', () => withRecovery(async h => {
  const rt = h.rt
  const first = await h.failed(), second = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'User is talking to the lead' })
  const leadDriver = await until(() => h.rt.driverOf(h.conversation.id)?.calls.length && h.rt.driverOf(h.conversation.id))
  for (const [task, text] of [[first, 'First recovered round'], [second, 'Second recovered round']]) {
    await h.input(task.work)
    task.driver.finish('done', text)
    await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.find(item => item.session === task.work.id)?.text)
  }
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  await h.rt.save(false, true)
  const saved = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
  assert.equal(saved.profiles[h.lead.id].sessions.find(item => item.id === leadSession.id).reportQueue.length, 2)
  await h.input(first.work, 'Another completed round before delivery')
  first.driver.finish('done', 'Wrong newer reply')
  await until(() => !h.rt.workView()[first.work.id]?.active)
  assert.equal(h.reports().length, 0)
  assert.deepEqual(leadDriver.guides, [])
  await h.finishLead()
  await until(() => h.reports().length === 1)
  assert.equal(h.reports()[0].origin.session, first.work.id)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'First recovered round')
  await h.finishLead()
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, second.work.id)
  await h.finishLead()
  assert.deepEqual(leadDriver.guides, [])
  assert.equal(first.work.source.pendingReport, undefined)
  assert.equal(second.work.source.pendingReport, undefined)
}))

test('manual recovery runs alongside another active task and reports independently', () => withRecovery(async h => {
  const rt = h.rt
  const recovered = await h.failed()
  const running = await h.delegate()
  await h.input(recovered.work)
  assert.equal(rt.delegationSummary(recovered.work).status, 'running')
  recovered.driver.finish('done', 'Recovered while the other task is running')
  await until(() => h.reports().length === 1)
  assert.equal(rt.delegationSummary(running.work).status, 'running')
  assert.equal(running.driver.active, true)
  await h.finishLead()
  running.driver.finish('error')
  await until(() => h.reports().length === 2)
  await h.finishLead()
  await running.following
}))

test('manual recovery explains the team limit and can send after one flight ends', () => withRecovery(async h => {
  const recovered = await h.failed()
  const running = []
  for (let index = 0; index < 5; index++) running.push(await h.delegate())
  await assert.rejects(h.input(recovered.work), {
    code: 'orch/busy', message: '此主控会话已有 5 个任务在执行，请等一个结束后再发送',
  })
  assert.equal(recovered.driver.calls.length, 1)
  assert.equal(h.rt.delegationSummary(recovered.work).status, 'failed')
  assert.ok(running.every(item => item.driver.active))
  await h.rt.leadDispatch.interrupt(h.conversation, running[0].work.id)
  await h.input(recovered.work)
  assert.equal(h.rt.delegationSummary(recovered.work).status, 'running')
  recovered.driver.finish('done', 'Recovered after a flight ended')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  for (const item of running.slice(1)) await h.rt.leadDispatch.interrupt(h.conversation, item.work.id)
}))

for (const action of ['archive', 'delete-profile', 'remove-session']) test(`manual report discards a lead target after ${action}`, () => withRecovery(async h => {
  const rt = h.rt
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
  const rt = h.rt
  const { work, driver } = await h.failed()
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'Busy lead' })
  await until(() => h.rt.driverOf(h.conversation.id)?.calls.length)
  await h.input(work)
  driver.finish('done', 'Queued report')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.text)
  h.rt.conversationOf(h.conversation.id).session.archivedAt = Date.now()
  await h.finishLead()
  await until(() => !work.source.pendingReport)
  assert.equal(h.reports().length, 0)
  assert.ok(h.lines(work).some(line => /read-only/.test(line.text)))
}))

test('persisted lifecycle and continuation budgets survive clearing lead memory', () => withRecovery(async h => {
  const rt = h.rt
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
  // The preamble's manual resume already spent one execution; three reuses
  // reach the five-execution cap.
  for (let count = 1; count <= 3; count++) {
    installLead(h.rt)
    const task = await h.delegate(work, 'Recheck after restart')
    task.driver.finish('error')
    await h.finishLead()
    await task.following
    assert.equal(stored().source.continued, count)
  }
  installLead(h.rt)
  const previous = Object.values(rt.state.executions).findLast(item => item.sessionId === work.id)
  const denied = await routeUserTask(h.rt, h.conversation.id, { ...delegateType('feature', false, 'Fifth continuation'), taskId: previous.taskId })
  assert.equal(denied.continued, false)
  assert.equal(denied.reason, '候选会话承接的执行数已达上限')
  assert.notEqual(denied.session, work.id)
  await h.rt.leadDispatch.interrupt(h.conversation.id, { executionId: denied.executionId })
  assert.equal(driver.calls.length, 5)
}))

test('persisted FIFO recovers on session load and a delivered report id is not resent', () => withRecovery(async h => {
  const rt = h.rt
  const { work, driver } = await h.failed()
  const workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [h.conversation.id]: { active: true } })
  await h.input(work)
  driver.finish('done', 'Frozen before restart')
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  await until(() => leadSession.reportQueue?.[0]?.text)
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
  const rt = h.rt
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
  assert.ok(h.reports()[0].text.includes(`nodo_context read executionId ${h.reports()[0].origin.executionId}`))
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Native round 2')
  await h.finishLead()
}))

test('a busy admission race leaves the frozen report queued instead of steering', () => withRecovery(async h => {
  const rt = h.rt
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
  const rt = h.rt
  const { work, driver } = await h.failed()
  assert.equal(work.source.pendingReport, undefined)
  const sent = await h.rt.send(h.worker.id, 'Outside the channel', work.id)
  await until(() => driver.calls.length === 2)
  driver.finish('done', 'Untracked completion')
  await sent.completion
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(rt.delegationSummary(work).status, 'failed')
  assert.equal(h.reports().length, 0)
  await h.input(work)
  driver.finish('done', 'Tracked completion')
  await until(() => h.reports().length === 1)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Tracked completion')
  await h.finishLead()
}))

test('a completed manual report permits new delegation before delivery', () => withRecovery(async h => {
  const rt = h.rt
  const recovered = await h.failed()
  const leadInput = await h.rt.send(h.lead.id, 'Hold lead busy', h.conversation.id)
  await until(() => h.rt.driverOf(h.conversation.id)?.active)
  await h.input(recovered.work)
  recovered.driver.finish('done', 'Pending report')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.length)
  const next = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Next' })
  assert.equal(next.status, 'queued')
  await h.finishLead()
  await h.rt.followLead(h.conversation.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  await leadInput.completion
  await until(() => h.reports().length === 1)
  await h.finishLead()
}))

for (const reason of ['done', 'error']) test(`manual recovery waits for its last queued turn (${reason})`, () => withRecovery(async h => {
  const rt = h.rt
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
  await until(() => !h.rt.workView()[work.id]?.active)
  if (reason === 'error') {
    await until(() => h.reports().length === 1)
    assert.match(h.reports()[0].text, /Status: failed/)
    await h.finishLead()
    await h.input(work)
    driver.finish('done', 'Recovered after queued failure')
  }
  await until(() => h.reports().length === (reason === 'done' ? 1 : 2))
  assert.equal(h.rt.state.executions[h.reports().at(-1).origin.executionId].result.text, reason === 'done' ? 'Queued final reply' : 'Recovered after queued failure')
  await h.finishLead()
  assert.equal(work.source.pendingReport, undefined)
  assert.equal(h.reports().length, reason === 'done' ? 1 : 2)
}))

test('an unavailable executor session does not prevent archived results from being delivered in order', () => withRecovery(async h => {
  const rt = h.rt
  const first = await h.failed(), second = await h.failed()
  const workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [h.conversation.id]: { active: true } })
  const leadSession = h.rt.conversationOf(h.conversation.id).session
  for (const task of [first, second]) {
    await h.input(task.work)
    task.driver.finish('done', `Report for ${task.work.id}`)
    await until(() => leadSession.reportQueue?.find(item => item.session === task.work.id)?.text)
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
  assert.equal(h.reports()[0].origin.session, first.work.id)
  assert.equal(rt.state.executions[h.reports()[0].origin.executionId].result.text, `Report for ${first.work.id}`)
  assert.equal(first.work.source.pendingReport, undefined)
  await h.finishLead()
  await flushing
  await until(() => h.reports().length === 2)
  assert.equal(h.reports()[1].origin.session, second.work.id)
  await h.finishLead()
  assert.equal(leadSession.reportQueue, undefined)
}))

test('a rejected report send retains the result for a later retry', () => withRecovery(async h => {
  const rt = h.rt
  const { work, driver } = await h.failed()
  const send = h.rt.send
  h.rt.send = (...args) => {
    if (args[5]?.origin?.kind === 'report') throw new Error('Report send rejected')
    return send(...args)
  }
  await h.input(work)
  driver.finish('done', 'Recovered but not delivered')
  await until(() => h.rt.conversationOf(h.conversation.id).session.reportQueue?.[0]?.text)
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
  const rt = h.rt
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
  assert.match(report.text, /Result preview:/)
  assert.equal(rt.state.executions[report.origin.executionId].result.text, 'Exact recovered result without a reply id')
  await h.finishLead()
  assert.equal(work.source.pendingReport, undefined)
}))

// setTimeout is mocked around these waits, so they yield with setImmediate against a wall-clock deadline.
const retryUntil = async check => {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const result = check()
    if (result) return result
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Retry state did not settle')
}

test('a deferred reuse refused by independent work reports failure without claiming its reply', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  task.driver.finish('done', 'Original report')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
  await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Recheck', taskId })
  assert.equal(rt.delegationSummary(task.work).status, 'queued')
  await h.input(task.work, 'Independent task')
  await h.rt.followLead(h.conversation.id, completed('Dispatched'))
  await until(() => h.reports().length === 2)
  assert.equal(rt.delegationSummary(task.work).status, 'failed')
  assert.match(h.reports()[1].text, /Status: failed/)
  assert.equal(h.reports()[1].references, undefined)
  await h.finishLead()
  task.driver.finish('done', 'Independent reply')
  await until(() => !h.rt.workView()[task.work.id]?.active)
  assert.equal(h.reports().length, 2)
  assert.equal(rt.delegationSummary(task.work).status, 'failed')
}))

test('a deferred send failure reports once and releases the slot', () => withRecovery(async h => {
  const rt = h.rt
  const send = h.rt.send
  h.rt.send = async (...args) => {
    if (args[0] === h.worker.id) throw Object.assign(new Error('Not admitted'), { code: 'orch/busy' })
    return send(...args)
  }
  try {
    const receipt = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Accepted' })
    const work = h.rt.conversationOf(receipt.session).session
    assert.equal(rt.delegationSummary(work).status, 'queued')
    assert.equal(h.reports().length, 0)
    await h.rt.followLead(h.conversation.id, completed('Dispatch'))
    await until(() => h.reports().length === 1)
    assert.equal(rt.delegationSummary(work).status, 'failed')
    assert.match(h.reports()[0].text, /Not admitted/)
    await h.finishLead()
    assert.equal(h.reports().length, 1)
  } finally { h.rt.send = send }
  const next = await h.delegate()
  next.driver.finish('interrupted')
  await next.following
}))

for (const action of ['edit', 'delete']) test(`a ${action} of an unstarted supplement preserves the actual final report`, () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  const first = await h.input(task.work, 'Withdraw this', { mode: 'queue' })
  await h.host.api('queued-message', { profile: h.worker.id, session: task.work.id, seq: first.seq, action })
  const last = await h.input(task.work, 'Withdraw this too', { mode: 'queue' })
  await h.host.api('queued-message', { profile: h.worker.id, session: task.work.id, seq: last.seq, action })
  task.driver.finish('done', 'Actual completed work')
  await until(() => h.reports().length === 1)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Actual completed work')
  assert.equal(rt.delegationSummary(task.work).status, 'done')
  assert.equal(task.driver.calls.length, 1)
  await h.finishLead()
  await task.following
}))

test('delivered unconfirmed failures suppress stale hints and refuse session reuse', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  task.driver.finish('error', 'Unconfirmed failure', true)
  await until(() => h.reports().length === 1)
  assert.match(h.reports()[0].text, /Status: unconfirmed/)
  await h.finishLead()
  await task.following
  assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /without a report/)
  const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
  await assert.rejects(routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Reuse', taskId }), /pending execution/)
}))

test('store sync preserves active flights and marks orphaned running summaries unconfirmed', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate(), summary = { ...rt.delegationSummary(task.work) }
  const orphan = h.rt.conversationOf((await h.session(h.worker)).id).session
  orphan.source = { ...task.work.source, dispatch: structuredClone(summary) }
  await h.rt.save(false, true)
  const lockPath = join(h.host.home, 'state.lock'), lock = readFileSync(lockPath, 'utf8')
  try {
    writeFileSync(lockPath, JSON.stringify({ host: 'test-foreign-host', token: 'other-writer' }))
    await until(() => h.rt.readOnly() !== undefined)
    await h.rt.refresh()
    assert.deepEqual(h.rt.delegationSummary(h.rt.conversationOf(task.work.id).session), summary)
    assert.deepEqual(h.rt.delegationSummary(h.rt.conversationOf(orphan.id).session), summary)
    assert.equal(h.rt.conversationOf(orphan.id).session.source.pendingReport, undefined)
  } finally {
    writeFileSync(lockPath, lock)
    await h.rt.refresh()
  }
  assert.equal(h.rt.delegationSummary(h.rt.conversationOf(orphan.id).session).status, 'unconfirmed')
  assert.equal(h.rt.delegationSummary(h.rt.conversationOf(orphan.id).session).reason, 'restart')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  task.driver.finish('error')
  await until(() => h.reports().length === 2)
  await h.finishLead()
  await task.following
}))

test('an end after a mid-flight store restore writes the summary onto the current session', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  const lockPath = join(h.host.home, 'state.lock'), lock = readFileSync(lockPath, 'utf8')
  try {
    writeFileSync(lockPath, JSON.stringify({ host: 'test-foreign-host', token: 'other-writer' }))
    await until(() => h.rt.readOnly() !== undefined)
    await h.rt.refresh()
    assert.equal(h.rt.delegationSummary(h.rt.conversationOf(task.work.id).session).status, 'running')
  } finally {
    writeFileSync(lockPath, lock)
    await h.rt.refresh()
  }
  task.driver.finish('done', 'Reported after restore')
  await until(() => h.rt.delegationSummary(h.rt.conversationOf(task.work.id).session).status === 'done')
  await h.finishLead()
  await task.following
}))

test('a stop timeout after session removal still settles the stop and releases the slot', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  const sessions = h.rt.findProfile(h.worker.id).sessions
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  sessions.splice(sessions.indexOf(task.work), 1)
  try {
    const result = await h.rt.leadDispatch.interrupt(h.conversation, { executionId: Object.values(h.rt.state.executions).findLast(item => item.sessionId === task.work.id).id })
    assert.equal(result.unconfirmed, true)
    assert.equal(result.ended, 'interrupted')
    assert.doesNotMatch(h.rt.leadBrief(h.lead, h.conversation), /## Current delegation/)
    const replacement = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Replacement' })
    await h.rt.followLead(h.conversation.id, completed('Dispatched'))
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

test('a late interrupted end retains its stop owner and leaves another flight running', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  const other = await h.delegate()
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  try {
    const result = await h.rt.leadDispatch.interrupt(h.conversation, { executionId: Object.values(h.rt.state.executions).findLast(item => item.sessionId === task.work.id).id })
    assert.equal(result.unconfirmed, true)
    assert.equal(rt.delegationSummary(task.work).stoppedBy, 'lead')
    await h.rt.save(false, true)
    const saved = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    assert.equal(Object.values(saved.executions).find(item => item.sessionId === task.work.id).reason, 'interrupted-lead')
    task.driver.finish('interrupted')
    await task.following
    assert.equal(rt.delegationSummary(task.work).status, 'interrupted-lead')
    assert.equal(rt.delegationSummary(other.work).status, 'running')
    assert.equal(other.driver.active, true)
  } finally {
    h.rt.interrupt = interrupt
    RUN_LIMITS.cancelConfirmMs = limit
    await h.rt.leadDispatch.interrupt(h.conversation, other.work.id)
  }
}))

test('a busy candidate is not reused and the running executor is left alone', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.failed(), workView = h.rt.workView
  h.rt.workView = () => ({ ...workView(), [task.work.id]: { active: true } })
  try {
    const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
    const second = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Unsent requirement', taskId })
    assert.equal(second.continued, false)
    assert.equal(second.reason, '候选会话正忙')
    assert.notEqual(second.session, task.work.id)
    assert.equal(task.driver.calls.length, 1)
    assert.equal(rt.delegationSummary(task.work).status, 'failed')
    assert.equal(task.work.source.continued, undefined)
    await h.rt.leadDispatch.interrupt(h.conversation, { executionId: second.executionId })
  } finally { h.rt.workView = workView }
}))

test('queued lead attachments follow the user input that actually starts', () => withRecovery(async h => {
  const rt = h.rt
  const firstRefs = await rt.saveFiles(rt.admitFiles([{ name: 'first.txt', data: Buffer.from('first').toString('base64') }]))
  const secondRefs = await rt.saveFiles(rt.admitFiles([{ name: 'second.txt', data: Buffer.from('second').toString('base64') }]))
  const first = await h.rt.send(h.lead.id, 'First request', h.conversation.id, [], [], { userInput: true, files: { refs: firstRefs } })
  await until(() => h.rt.driverOf(h.conversation.id)?.active)
  const second = await h.rt.send(h.lead.id, 'Queued request', h.conversation.id, [], [], { userInput: true, queue: true, files: { refs: secondRefs } })
  assert.equal(second.mode, 'queued')
  const receipt = await rt.leadRoute(h.conversation.id, { action: 'new', type: 'feature', hard: false, scope: { note: 'First task' } })
  assert.equal(h.rt.driverOf(receipt.session), undefined)
  h.rt.driverOf(h.conversation.id).finish('done')
  await h.rt.followLead(h.conversation.id, first)
  const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
  assert.match(driver.calls[0], /first\.txt/)
  assert.doesNotMatch(driver.calls[0], /second\.txt/)
  await h.host.api('interrupt', { profile: h.worker.id, session: receipt.session })
  await until(() => h.rt.delegationSummary(h.rt.conversationOf(receipt.session).session).status === 'interrupted-user')
  await first.completion
  await until(() => h.rt.driverOf(h.conversation.id).calls.length === 2)
  const next = await rt.leadRoute(h.conversation.id, { action: 'new', type: 'feature', hard: false, scope: { note: 'Second task' } })
  await h.finishLead()
  await h.rt.followLead(h.conversation.id, second)
  const nextDriver = await until(() => h.rt.driverOf(next.session)?.active && h.rt.driverOf(next.session))
  assert.match(nextDriver.calls[0], /second\.txt/)
  assert.doesNotMatch(nextDriver.calls[0], /first\.txt/)
  nextDriver.finish('error')
  await second.completion
}))

test('MCP dispatch uses driver credentials and current user attachments', () => withRecovery(async h => {
  const rt = h.rt
  const refs = await rt.saveFiles(rt.admitFiles([{ name: 'current.txt', data: Buffer.from('current').toString('base64') }]))
  const placed = await h.rt.send(h.lead.id, 'User request', h.conversation.id, [], [], { userInput: true, files: { refs } })
  const leadDriver = await until(() => h.rt.driverOf(h.conversation.id)?.active && h.rt.driverOf(h.conversation.id))
  const [spec] = leadDriver.leadMcpServers
  const client = new Client({ name: 'lead-integration', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } }))
    const missing = await client.callTool({ name: 'nodo_board', arguments: { session: 'missing-session' } })
    assert.equal(missing.content[0].text, '没有该执行会话的派活记录')
    const invalidBoard = await client.callTool({ name: 'nodo_board', arguments: { table: 'roles', session: 'missing-session' } })
    assert.equal(invalidBoard.isError, true)
    for (const args of [{ type: 'bad', hard: false, task: 'Task' }, { type: 'feature', hard: 'false', task: 'Task' }, { type: 'feature', hard: false, task: '' }]) {
      assert.equal((await client.callTool({ name: 'nodo_route', arguments: { action: 'new', type: args.type, hard: args.hard, scope: { note: args.task } }})).isError, true)
      assert.equal(h.rt.sessionsOf(h.rt.findProfile(h.worker.id)).length, 0)
    }
    const response = await client.callTool({ name: 'nodo_route', arguments: { action: 'new', type: 'feature', hard: false, scope: { note: 'Implement' } }})
    const receipt = JSON.parse(response.content[0].text)
    assert.equal(h.rt.driverOf(receipt.session), undefined)
    leadDriver.finish('done')
    await h.rt.followLead(h.conversation.id, placed)
    const workerDriver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
    assert.equal(workerDriver.leadMcpServers, undefined)
    assert.match(workerDriver.calls[0], /current\.txt/)
    assert.deepEqual(receipt, { ok: true, flow: { status: 'running', stage: 'implement', round: 1 }, taskId: receipt.taskId, executionId: receipt.executionId, status: 'queued', session: receipt.session, role: 'Worker', type: 'feature', hard: false, reused: false, continued: false, reason: '没有接续来源任务', message: '已受理，本轮结束后发送' })
    workerDriver.interruptTurn = async () => workerDriver.finish('interrupted', 'Last output '.repeat(500))
    const stopped = await client.callTool({ name: 'nodo_route', arguments: { action: 'stop', executionIds: [receipt.executionId] } })
    assert.equal(JSON.parse(stopped.content[0].text).stopped[0].ended, 'interrupted')
    assert.match(JSON.parse(stopped.content[0].text).stopped[0].lastOutput, /truncated\)$/)
    await placed.completion
    h.rt.releaseDriver(h.conversation.id)
    await assert.rejects(client.callTool({ name: 'nodo_board', arguments: {} }), { code: 401 })
  } finally { await client.close() }
}))

test('dispatch service validates reuse, requires an explicit stop and returns an immediate receipt', () => withRecovery(async h => {
  const rt = h.rt
  const service = h.rt.leadDispatch
  await assert.rejects(routeUserTask(h.rt, h.worker, { type: 'feature', hard: false, task: 'Invalid owner' }), /有效主控/)
  const receipt = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Original\nContext' })
  await h.rt.followLead(h.conversation.id, completed('Dispatched'))
  assert.deepEqual(receipt, { ok: true, flow: { status: 'running', stage: 'implement', round: 1 }, taskId: receipt.taskId, executionId: receipt.executionId, status: 'queued', session: receipt.session, role: 'Worker', type: 'feature', hard: false, reused: false, continued: false, reason: '没有接续来源任务', message: '已受理，本轮结束后发送' })
  const work = h.rt.conversationOf(receipt.session).session
  const driver = await until(() => h.rt.driverOf(work.id)?.active && h.rt.driverOf(work.id))
  const summary = { ...rt.delegationSummary(work) }
  for (const command of [{ type: 'bad', hard: false, task: 'Next' }, { type: 'feature', hard: 'false', task: 'Next' }, { type: 'feature', hard: false, task: '' }]) {
    await assert.rejects(routeUserTask(h.rt, h.conversation, { ...command }))
    assert.equal(driver.active, true)
    assert.deepEqual(rt.delegationSummary(work), summary)
  }
  const supplement = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Updated', taskId: receipt.taskId })
  assert.equal(supplement.delivery.mode, 'steered')
  assert.equal(driver.active, true)
  assert.deepEqual(rt.delegationSummary(work), summary)
  await service.interrupt(h.conversation, { executionId: receipt.executionId })
  const amended = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Updated', continues: receipt.taskId })
  assert.equal(driver.active, false)
  assert.equal(driver.calls.length, 1)
  assert.equal(rt.delegationSummary(work).status, 'queued')
  await h.rt.followLead(h.conversation.id, completed('Dispatched'))
  assert.equal(amended.reused, true)
  assert.equal(amended.continued, true)
  await until(() => driver.calls.length === 2)
  assert.equal(work.source.continued, 1)
  assert.equal(rt.delegationSummary(work).task, 'Updated')
  assert.equal(rt.delegationSummary(work).status, 'running')
  const stopped = await service.interrupt(h.conversation, { executionId: amended.executionId })
  assert.equal(stopped.ended, 'interrupted')
  assert.equal(typeof stopped.lastOutput, 'string')
  assert.equal(rt.delegationSummary(work).status, 'interrupted-lead')
}))

test('a busy or running task falls back or refuses without touching the running execution', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  const interrupt = h.rt.interrupt
  h.rt.interrupt = async () => { task.driver.finish('done', 'Already finished'); return true }
  try {
    const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
    const attached = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Changed requirement', taskId })
    assert.equal(attached.delivery.mode, 'steered')
    assert.equal(task.driver.active, true)
    task.driver.finish('done', 'Already finished')
    assert.equal(task.driver.calls.length, 1)
    assert.equal(task.work.source.continued, undefined)
    await until(() => h.reports().length === 1)
    await h.finishLead()
    await task.following
  } finally { h.rt.interrupt = interrupt }
}))

test('accepted queued supplements retain the slot and freeze only their last result', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  const summary = { ...rt.delegationSummary(task.work) }
  await h.input(task.work, 'Queued requirement', { mode: 'queue' })
  assert.deepEqual(rt.delegationSummary(task.work), summary)
  task.driver.finish('done', 'First result')
  await until(() => task.driver.calls.length === 2)
  assert.equal(h.reports().length, 0)
  assert.deepEqual(rt.delegationSummary(task.work), summary)
  const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
  const attached = await routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Another', taskId })
  assert.equal(attached.delivery.mode, 'steered')
  task.driver.finish('done', 'Final supplemented result')
  await until(() => h.reports().length === 1)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Final supplemented result')
  await h.finishLead()
  await task.following
  const ended = { ...rt.delegationSummary(task.work) }
  await h.input(task.work, 'Independent work')
  task.driver.finish('done', 'Independent result')
  await until(() => !h.rt.workView()[task.work.id]?.active)
  assert.deepEqual(rt.delegationSummary(task.work), ended)
  assert.equal(h.reports().length, 1)
}))

test('recovered running summaries become unconfirmed and a late end records the actual result', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate()
  const summary = { ...rt.delegationSummary(task.work) }
  await h.rt.save()
  const restartHome = join(h.host.home, 'restart')
  mkdirSync(restartHome)
  copyFileSync(join(h.host.home, 'state.json'), join(restartHome, 'state.json'))
  const restarted = boot(restartHome)
  try {
    const rt = await restarted.runtime
    await rt.load()
    const restored = rt.conversationOf(task.work.id).session
    assert.equal(rt.delegationSummary(restored).status, 'unconfirmed')
    assert.equal(rt.delegationSummary(restored).acceptedAt, summary.acceptedAt)
    const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
    await assert.rejects(routeUserTask(rt, h.conversation, { type: 'feature', hard: false, task: 'Reuse', taskId }), /pending execution/)
    await rt.leadEnded(task.work.id, { reason: 'error' })
    assert.equal(rt.delegationSummary(restored).status, 'failed')
    const leadDriver = await until(() => rt.driverOf(h.conversation.id)?.active && rt.driverOf(h.conversation.id))
    leadDriver.finish('done', 'Reviewed restart notification')
    await until(() => !rt.workView()[h.conversation.id]?.active)
  } finally { await restarted.dispose() }
  task.driver.finish('error', 'Late failure')
  await until(() => h.reports().length === 1)
  await h.finishLead()
  await task.following
  assert.equal(rt.delegationSummary(task.work).status, 'failed')
}))

test('service budget spans calls and failures do not spend it; only accepted lead user input resets it', () => withRecovery(async h => {
  const rt = h.rt
  const service = h.rt.leadDispatch, command = { type: 'feature', hard: false, task: 'Budget test' }
  for (let count = 0; count < 24; count++) {
    await assert.rejects(routeUserTask(h.rt, h.conversation, { ...command, hard: null }), /hard 必须/)
    const receipt = await routeUserTask(h.rt, h.conversation, command)
    await h.rt.followLead(h.conversation.id, completed('Dispatched'))
    const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
    driver.finish('error')
    await until(() => h.reports().length === count + 1)
    await h.finishLead()
  }
  await assert.rejects(routeUserTask(h.rt, h.conversation, command), /24 次派活上限/)
  h.rt.leadBrief(h.lead, h.conversation)
  await assert.rejects(routeUserTask(h.rt, h.conversation, command), /24 次派活上限/)
  for (const origin of [{ kind: 'report', reportId: 'budget-report' }, { kind: 'reject' }]) {
    const placed = await h.rt.send(h.lead.id, 'Internal input', h.conversation.id, [], [], { origin })
    await h.finishLead()
    await placed.completion
    await assert.rejects(routeUserTask(h.rt, h.conversation, command), /24 次派活上限/)
  }
  await h.host.api('send', { profile: h.lead.id, session: h.conversation.id, text: 'New request' })
  await h.finishLead()
  const receipt = await routeUserTask(h.rt, h.conversation, command)
  await h.rt.followLead(h.conversation.id, completed('Dispatched'))
  const driver = await until(() => h.rt.driverOf(receipt.session)?.active && h.rt.driverOf(receipt.session))
  driver.finish('error')
}))

test('explicit stop timeout marks unconfirmed and refuses session reuse', () => withRecovery(async h => {
  const rt = h.rt
  const task = await h.delegate(), interrupt = h.rt.interrupt, limit = RUN_LIMITS.cancelConfirmMs
  h.rt.interrupt = async () => true
  RUN_LIMITS.cancelConfirmMs = 10
  try {
    const stopped = await h.rt.leadDispatch.interrupt(h.conversation, task.work.id)
    assert.equal(stopped.unconfirmed, true)
    await reviewDeliveredReports(rt, h.conversation.id)
    const taskId = Object.values(rt.state.executions).findLast(item => item.sessionId === task.work.id).taskId
    await assert.rejects(routeUserTask(h.rt, h.conversation, { type: 'feature', hard: false, task: 'Unsent change', taskId }), /pending execution/)
    assert.equal(rt.delegationSummary(task.work).status, 'unconfirmed')
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
  const rt = h.rt
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
  const rt = h.rt
  const task = await h.delegate()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    mock.timers.tick(30_000)
    await retryUntil(() => task.driver.calls.length === 2)
    await h.host.api('interrupt', { profile: h.worker.id, session: task.work.id })
    await task.following
    await retryUntil(() => rt.delegationSummary(task.work).status === 'interrupted-user')
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 2)
    assert.equal(h.rt.workView()[task.work.id]?.active ?? false, false)
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
  const rt = h.rt
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
  const rt = h.rt
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
  const rt = h.rt
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
  const rt = h.rt
  const task = await h.delegate(undefined, 'Original unique task')
  const summary = { ...rt.delegationSummary(task.work) }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    assert.deepEqual(rt.delegationSummary(task.work), summary)
    const stored = JSON.parse(readFileSync(join(h.host.home, 'state.json'), 'utf8'))
    assert.ok(stored.profiles[h.worker.id].sessions.find(item => item.id === task.work.id).source.pendingReport.id)
    assert.equal(h.rt.workView()[task.work.id]?.retryWaiting, true)
    assert.equal(h.rt.workView()[task.work.id]?.active, true)
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
    assert.match(task.driver.calls[1], /^# 本轮要求/)
    assert.equal(h.lines(task.work).filter(line => line.who === 'user').at(-1).origin?.kind, 'retry')
    assert.match(h.rt.leadSnapshot(h.conversation.id), /执行中/)
    assert.doesNotMatch(h.rt.leadSnapshot(h.conversation.id), /等待自动续跑/)
    assert.deepEqual(rt.delegationSummary(task.work), summary)
    assert.match(task.driver.calls[1], /Original unique task/)
    assert.match(task.driver.calls[1], /# 本轮要求[\s\S]*Original unique task/)
    assert.equal(task.work.source.continued, undefined)
  } finally { mock.timers.reset() }
  task.driver.finish('done', 'Recovered automatically')
  await until(() => h.reports().length === 1)
  assert.doesNotMatch(h.reports()[0].text, /manually resumed/)
  assert.equal(h.rt.state.executions[h.reports()[0].origin.executionId].result.text, 'Recovered automatically')
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
  const rt = h.rt
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
    assert.match(h.reports()[0].text, /Status: failed/)
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
  const rt = h.rt
  const task = await h.delegate(), summary = { ...rt.delegationSummary(task.work) }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await temporaryFailure(h, task)
    mock.timers.tick(30_000)
    await retryUntil(() => task.driver.calls.length === 2)
    await h.input(task.work, 'Additional user requirement')
    assert.deepEqual(rt.delegationSummary(task.work), summary)
    task.driver.finish('error', 'Still failed', false, true)
    await retryUntil(() => h.reports().length === 1)
    mock.timers.reset()
    await h.finishLead()
    await task.following
    mock.timers.enable({ apis: ['setTimeout'] })
    mock.timers.tick(300_000)
    assert.equal(task.driver.calls.length, 2)
    assert.equal(rt.delegationSummary(task.work).status, 'failed')
    assert.equal(task.work.source.pendingReport, undefined)
  } finally { mock.timers.reset() }
}))

for (const action of ['lead-interrupt', 'user-stop', 'user-message', 'busy']) {
  test(`automatic continuation is cancelled by ${action}; manual completion reports once`, () => withRecovery(async h => {
  const rt = h.rt
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
      if (action !== 'user-message') await retryUntil(() => rt.delegationSummary(task.work).status !== 'running')
      if (action === 'busy') assert.equal(task.work.source.pendingReport, undefined)
      else assert.equal(task.work.source.pendingReport.id, marker)
      if (action === 'user-stop') assert.equal(rt.delegationSummary(task.work).status, 'interrupted-user')
      assert.ok(h.lines(h.conversation).some(line => /已取消自动继续/.test(line.text)))
      mock.timers.tick(300_000)
      assert.equal(task.driver.calls.length, action === 'user-message' ? 2 : 1)
      if (action === 'lead-interrupt' || action === 'user-stop') assert.equal(h.rt.workView()[task.work.id]?.active ?? false, false)
      assert.equal(h.reports().length, action === 'busy' ? 1 : 0)
    } finally { mock.timers.reset() }
    if (stopping) await stopping
    if (action !== 'user-message') await h.input(task.work)
    h.rt.driverOf(task.work.id).finish('done', 'User completed the task')
    await until(() => h.reports().length === (action === 'busy' ? 2 : 1))
    await h.finishLead()
    await h.input(task.work, 'Later chat')
    h.rt.driverOf(task.work.id).finish('done', 'Unrelated')
    await until(() => !h.rt.workView()[task.work.id]?.active)
    assert.equal(h.reports().length, action === 'busy' ? 2 : 1)
    assert.equal(task.work.source.pendingReport, undefined)
  }))
}

for (const [reason, unconfirmed, retryable] of [['error', false, false], ['error', true, true], ['interrupted', false, true]]) {
  test(`delegation does not auto-continue ${reason}, unconfirmed=${unconfirmed}, retryable=${retryable}`, () => withRecovery(async h => {
  const rt = h.rt
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
    assert.equal(h.rt.workView()[task.work.id]?.retryWaiting, undefined)
  }))
}

test('ordinary chat does not automatically continue a transient failure', () => withRecovery(async h => {
  const rt = h.rt
  const work = await h.session(h.worker)
  await h.input(work)
  const driver = h.rt.driverOf(work.id)
  driver.finish('error', 'Temporary failure', false, true)
  await until(() => !h.rt.workView()[work.id]?.active)
  assert.equal(driver.calls.length, 1)
  assert.equal(work.source, undefined)
  assert.equal(h.reports().length, 0)
}))

test('automatic continuations leave the 24 delegation budget intact', () => withLead(async h => {
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
    for (let i = 0; i < 23; i++) await toolTask(h.rt, conversation.id, delegateType('feature', false))
    await assert.rejects(routeUserTask(h.rt, conversation.id, delegateType('feature', false)), /24 次派活上限/)
    assert.equal(calls, 29, '24 delegations plus 5 automatic continuations')
    assert.equal(h.rt.sessionsOf(h.rt.findProfile(worker.id)).length, 24)
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
  const earlier = rt.flushLeadReports(leadConversation.id)
  rt.state.profiles[lead.id].permission = 'workspace'
  rt.conversationOf(leadConversation.id).session.permission = 'workspace'
  await rt.flushLeadReports(leadConversation.id)
  assert.equal(queued(), undefined, 'a flush asked for during another settles once the change is delivered')
  await earlier
  assert.ok(lines(leadConversation).some(line => line.who === 'user' && line.origin?.kind === 'report'))
}))

test('a lead token that reaches recorded tool output is redacted', () => withLead(async ({ rt, role, session }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const binding = await rt.issueLeadMcp(conversation.id)
  const { token } = binding.servers[0]
  assert.match(rt.redactSecrets(`NODO_LEAD_TOKEN=${token}`), /\[secret:NODO_MCP_TOKEN\]/)
  rt.driverSink(conversation.id, { type: 'tool', name: 'bash', phase: 'end', outputText: `$ env\nNODO_LEAD_TOKEN=${token}` })
  const line = rt.transcriptOf(conversation.id).find(item => item.kind === 'tool' && item.name === 'bash')
  assert.equal(line.output.includes(token), false)
  assert.match(line.output, /\[secret:NODO_MCP_TOKEN\]/)
}))

test('a lead card chats 1:1 from the session view while Team sessions keep lead mode', () => withLead(async ({ host, rt, workspace, role, inputs, send }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const chat = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true, team: false })
  assert.equal(chat.leadMode, false)
  assert.equal(await rt.issueLeadMcp(chat.id), undefined, 'a chat session never mounts nodo_lead')
  assert.equal(rt.leadBrief(rt.findProfile(lead.id), chat), '')
  assert.ok(!rt.renderIdentity(await rt.prepareConversation(chat.id)).includes('# Nodo lead rules'), 'a chat session runs without lead rules in its identity')
  await assert.rejects(routeUserTask(rt, chat.id, delegateType('feature', false)), /主控会话/)
  await send(lead, chat, 'Just chatting')
  await until(() => inputs.some(item => item.sessionId === chat.id))
  assert.equal(inputs.find(item => item.sessionId === chat.id).text, 'Just chatting', 'no lead brief rides a chat turn')
  assert.equal((await host.api('session-update', { profile: lead.id, session: chat.id, changes: { permission: 'plan' } })).permission, 'plan', 'a chat session may use the plan tier')
  const team = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true, team: true })
  assert.equal(team.leadMode, true)
  assert.equal((await rt.issueLeadMcp(team.id)).servers[0].name, 'nodo_lead')
  assert.ok(rt.renderIdentity(await rt.prepareConversation(team.id)).includes('# Nodo lead rules'))
  await assert.rejects(host.api('session-update', { profile: lead.id, session: team.id, changes: { permission: 'plan' } }), /主控不能使用计划模式权限/)
  delete rt.conversationOf(team.id).session.leadMode
  assert.equal((await rt.issueLeadMcp(team.id)).servers[0].name, 'nodo_lead', 'a session saved before the flag keeps lead mode')
}))

test('a 1:1 chat lead session skips the per-turn lead machinery and the roles table', () => withLead(async ({ host, rt, workspace, role }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const chat = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true, team: false })
  const team = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true, team: true })
  const budget = [], started = []
  const reset = rt.resetLeadBudget, input = rt.leadInputStarted
  rt.resetLeadBudget = id => { budget.push(id); return reset(id) }
  rt.leadInputStarted = (id, ...args) => { started.push(id); return input(id, ...args) }
  await host.api('send', { profile: lead.id, session: chat.id, text: 'chat hello' })
  await host.api('send', { profile: lead.id, session: team.id, text: 'team hello' })
  assert.deepEqual(budget, [team.id], 'only the Team session resets the delegation budget')
  assert.deepEqual(started, [team.id], 'only the Team session registers lead input')
  assert.throws(() => rt.leadRoles(chat.id), /主控会话/)
  assert.match(rt.leadRoles(team.id), /\| 角色 \|/)
}))

test('a delegation records merged change files and surfaces them in reports and context', () => withLead(async ({ host, rt, role, session, lines }) => {
  const cwd = join(host.home, 'ws')
  const worker = await role('Editor', 'Edited and verified', { engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Edited and verified' }, { kind: 'wait', ms: 120 }], changes: [
    { scope: 'edit-tools', coverage: 'partial', cwd, files: [
      { path: join(cwd, 'a.ts'), edits: [{ operation: 'add' }] },
      { path: join(cwd, 'b.ts'), edits: [{ operation: 'update' }] },
      { path: join(cwd, 'c.ts'), edits: [{ operation: 'add' }] },
    ] },
    { scope: 'edit-tools', coverage: 'partial', cwd, files: [
      { path: join(cwd, 'a.ts'), edits: [{ operation: 'update' }] },
      { path: join(cwd, 'c.ts'), edits: [{ operation: 'delete' }] },
      { path: join(cwd, 'd.ts'), edits: [{ operation: 'move', fromPath: join(cwd, 'e.ts') }] },
    ] },
  ] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await toolTask(rt, conversation.id, delegateType('feature', false))
  const execution = rt.state.executions[receipt.executionId]
  assert.deepEqual(execution.files, { items: [
    { path: 'a.ts', op: 'add' },
    { path: 'b.ts', op: 'update' },
    { path: 'c.ts', op: 'delete' },
    { path: 'd.ts', op: 'move', from: 'e.ts' },
  ], total: 4, capture: 'complete', source: 'edit-tools' })
  const report = lines(conversation).filter(line => line.origin?.kind === 'report').at(-1)
  assert.match(report.text, /^Report from Editor · Implement the task · 改动 4 个文件\n/)
  const read = await rt.executionContext(conversation.id, { action: 'read', executionId: receipt.executionId })
  assert.match(read.text, /改动文件：4 个（编辑工具记录）\n- 新增 a\.ts\n- 修改 b\.ts\n- 删除 c\.ts\n- 移动 d\.ts（自 e\.ts）$/)
}))

test('partial snapshots and oversized change lists degrade capture', () => withLead(async ({ host, rt, role, session }) => {
  const cwd = join(host.home, 'ws')
  const worker = await role('Editor', 'Done', { engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Done' }, { kind: 'wait', ms: 120 }] } })
  const many = Array.from({ length: 205 }, (_, index) => ({ path: join(cwd, `f${String(index).padStart(3, '0')}.ts`), edits: [{ operation: 'update' }] }))
  rt.findProfile(worker.id).engineOptions.changes = [
    { scope: 'edit-tools', coverage: 'partial', cwd, capture: 'partial', files: many } ]
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await toolTask(rt, conversation.id, delegateType('feature', false))
  const files = rt.state.executions[receipt.executionId].files
  assert.equal(files.total, 205)
  assert.equal(files.items.length, 200)
  assert.equal(files.capture, 'partial')
  assert.equal(files.source, 'edit-tools')
}))

test('an unreadable change record still yields a partial capture', () => withLead(async ({ host, rt, role, session }) => {
  const cwd = join(host.home, 'ws')
  const worker = await role('Editor', 'Done', { engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Done' }, { kind: 'wait', ms: 120 }], changes: [
    { scope: 'edit-tools', coverage: 'partial', cwd, capture: 'partial', files: [{ path: join(cwd, 'x.ts'), edits: [{ operation: 'update' }] }] } ] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.deepEqual(rt.state.executions[receipt.executionId].files, { items: [{ path: 'x.ts', op: 'update' }], total: 1, capture: 'partial', source: 'edit-tools' })
}))

test('a continued session is told which later tasks touched its files', () => withLead(async ({ host, rt, role, session, inputs }) => {
  const cwd = join(host.home, 'ws')
  const editor = await role('Editor', 'Edited', { taskTypes: ['feature'], engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Edited' }, { kind: 'wait', ms: 120 }], changes: [
    { scope: 'edit-tools', coverage: 'partial', cwd, files: [{ path: join(cwd, 'a.ts'), edits: [{ operation: 'add' }] }] } ] } })
  await role('Later', 'Touched', { taskTypes: ['docs'], engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Touched' }, { kind: 'wait', ms: 120 }], changes: [
    { scope: 'edit-tools', coverage: 'partial', cwd, files: [
      { path: join(cwd, 'a.ts'), edits: [{ operation: 'update' }] },
      { path: join(cwd, 'z.ts'), edits: [{ operation: 'update' }] },
    ] } ] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false, 'Build the parser'))
  assert.equal(rt.sessionsOf(rt.findProfile(editor.id)).length, 1)
  await toolTask(rt, conversation.id, delegateType('docs', false, 'Update the docs'))
  const third = await toolTask(rt, conversation.id, delegateType('feature', false, 'Extend the parser', { taskId: first.taskId }))
  assert.equal(third.session, first.session)
  const sent = inputs.filter(item => item.sessionId === third.session).at(-1).text
  assert.match(sent, /# 原始要求[\s\S]*Build the parser/)
  assert.match(sent, /Extend the parser/)
  assert.match(sent, /# 你上次之后的文件变动\n自你上次执行结束后，以下任务改动了你改过的文件，修改前重新读取：\n- Update the docs · done · a\.ts/)
  assert.deepEqual(rt.state.executions[first.executionId].files.items, [{ path: 'a.ts', op: 'add' }])
}))

test('a workspace snapshot keeps unknown operations and says it may include other changes', () => withLead(async ({ host, rt, role, session, lines }) => {
  const cwd = join(host.home, 'ws')
  await role('Editor', 'Done', { engine: 'lead-changes', engineOptions: { script: [{ kind: 'text', text: 'Done' }, { kind: 'wait', ms: 120 }], changes: [
    { scope: 'workspace-snapshot', coverage: 'partial', cwd, files: [{ path: join(cwd, 'n.ts'), edits: [{ operation: 'unknown' }] }] } ] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const receipt = await toolTask(rt, conversation.id, delegateType('feature', false))
  assert.deepEqual(rt.state.executions[receipt.executionId].files, { items: [{ path: 'n.ts', op: 'unknown' }], total: 1, capture: 'complete', source: 'workspace-snapshot' })
  const report = lines(conversation).filter(line => line.origin?.kind === 'report').at(-1)
  assert.match(report.text, /改动 1 个文件（工作区快照，可能含其他改动）/)
  const read = await rt.executionContext(conversation.id, { action: 'read', executionId: receipt.executionId })
  assert.match(read.text, /改动文件：1 个（工作区快照，可能含其他改动）\n- 未知 n\.ts$/)
}))

test('an independent type does not reuse a session that ran other work', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done', { taskTypes: ['feature', 'review'] })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const team = rt.teams()[0]
  await rt.updateTeams([{ ...team, types: team.types.map(type => type.id === 'review' ? { ...type, independent: true } : type),
    assign: { ...team.assign, review: { normal: { profile: worker.id } } } }])
  const first = await toolTask(rt, conversation.id, delegateType('feature', false))
  const second = await routeUserTask(rt, conversation.id, delegateType('review', false, 'Recheck the change', { continues: first.taskId }))
  assert.equal(second.continued, false)
  assert.equal(second.reason, 'independent 类型不能沿用执行过其他类型的会话')
  assert.notEqual(second.session, first.session)
  await rt.leadDispatch.interrupt(conversation.id, { executionId: second.executionId })
}))

test('continues refuses a source task whose execution is still active', () => withLead(async ({ rt, role, session }) => {
  await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await routeUserTask(rt, conversation.id, delegateType('feature', false))
  await assert.rejects(routeUserTask(rt, conversation.id, delegateType('feature', false, 'Next step', { continues: first.taskId })),
    /接续来源任务最近一次执行尚未结束/)
  await rt.followLead(conversation.id, completed('Dispatched'))
  await until(() => !rt.workView()[first.session]?.active)
}))

test('an oversized continuation source stays readable by its handle with a bounded summary', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = await toolTask(rt, conversation.id, delegateType('feature', false, 'Build the parser'))
  Object.assign(rt.state.executions[first.executionId].result, { text: 'x'.repeat(95_000), length: 95_000, originalLength: 95_000 })
  rt.conversation(worker.id, first.session).session.archivedAt = Date.now()
  const next = await routeUserTask(rt, conversation.id, delegateType('feature', false, 'Extend the parser', { continues: first.taskId }))
  assert.equal(next.continued, false)
  assert.equal(next.reason, '候选会话已归档')
  const input = await rt.composeWorkerInput({ executionId: next.executionId })
  assert.ok(input.text.includes(`execution:${first.executionId}:result`))
  assert.ok(input.text.length < 96_000)
  assert.equal((await rt.executionContext(conversation.id, { action: 'read', executionId: first.executionId })).length, 95_000)
  await rt.leadDispatch.interrupt(conversation.id, { executionId: next.executionId })
}))
