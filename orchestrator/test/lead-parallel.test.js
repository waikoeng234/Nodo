import { routeUserTask, userRoute } from './helpers/route.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { withHost, until } from './helpers/host.js'
import { flowSettled } from './helpers/route.js'
import { reportFixtureCompletions } from './helpers/flow.js'

// End-to-end acceptance matrix for S3 parallel delegation. The flight fixture
// is a scripted driver whose turns only settle when the test calls finish(),
// so flights can be held, failed and completed independently. The lead
// whitelist admits only engine id claude, so the fixture registers under that
// id too; each test file runs in its own node --test process.
const flightEntry = {
  info: { id: 'flight-fixture', label: 'Flight fixture', capabilities: { resume: true, steer: true } },
  validate: raw => raw,
  create({ onEvent, cwd }) {
    let turn = 0
    const driver = {
      calls: [], steers: [], active: false, cwd,
      openSession: async () => {}, hasSession: () => true, dispose() {}, onEvent() {},
      async respondToRequest() { return false },
      async sendTurn(text) { driver.active = true; driver.calls.push(text); onEvent({ type: 'turn/start', turnId: `turn-${++turn}` }) },
      async steer(text) { driver.steers.push(text); return 'steered' },
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
registerEngine('flight-fixture', flightEntry)
registerEngine('claude', flightEntry)

const withFlights = (run, repository = false) => withHost(async host => {
  const rt = await host.runtime
  // Flights report through nodo_report, so every result is structured and needs
  // no independent re-review; reviewFlags are all false and every verification
  // passes, which is what lets the flow reach the acceptance card.
  reportFixtureCompletions(rt)
  let cwd = host.home
  if (repository) {
    cwd = join(host.home, 'repo')
    mkdirSync(cwd)
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'nodo@example.test')
    git('config', 'user.name', 'Nodo Test')
    writeFileSync(join(cwd, 'base.txt'), 'base\n')
    git('add', 'base.txt')
    git('commit', '-qm', 'base')
  }
  const workspace = await host.api('workspace-create', { name: 'Parallel', cwd })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'flight-fixture', engineOptions: {} })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: {} })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id],
    types: [{ id: 'feature', name: 'Feature', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const reports = id => rt.transcriptOf(id).filter(line => line.origin?.kind === 'report')
  const ended = id => rt.transcriptOf(id).filter(line => line.delegation?.ended)
  const lines = id => rt.transcriptOf(id)
  const turn = (reason = 'done') => ({ mode: 'turn', completion: Promise.resolve({ reason }) })
  const delegate = (overrides = {}, ownerId = owner.id) => routeUserTask(rt, ownerId,
    { type: 'feature', hard: false, task: 'Implement and verify\nPreserve existing changes.', ...overrides })
  const finishLead = async id => {
    const driver = await until(() => rt.driverOf(id)?.active && rt.driverOf(id))
    const count = driver.calls.length
    await flowSettled(rt, id)
    driver.finish('done', 'Reviewed')
    await until(() => !rt.workView()[id]?.active || driver.calls.length > count)
  }
  const stopFlight = async (ownerId, flight) => {
    if (['queued', 'running'].includes(rt.state.executions[flight.executionId].status)) {
      await rt.leadDispatch.interrupt(ownerId, { executionId: flight.executionId })
    }
  }
  await run({ host, rt, workspace, worker, lead, owner, reports, ended, lines, turn, delegate, finishLead, stopFlight })
})

test('stopped dependencies and done parents are refused without using slots, budget, work or sessions', () => withFlights(async ({ rt, workspace, worker, owner, delegate, turn }) => {
  const dependency = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Prerequisite', brief: 'Stopped before it finished', source: { kind: 'lead' } })
  rt.state.tasks[dependency.id].flow = { status: 'stopped' }
  const parent = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Accepted goal', brief: 'Reopen before new work', source: { kind: 'lead' } })
  rt.state.tasks[parent.id].status = 'done'
  for (let index = 0; index < 28; index++) {
    await assert.rejects(delegate({ dependsOn: [dependency.id] }), { code: 'orch/invalid', message: '依赖任务 Prerequisite 已停止，不能再依赖它' })
    await assert.rejects(delegate({ parentId: parent.id }), { code: 'orch/invalid', message: '父任务已验收' })
    assert.deepEqual(rt.state.executions, {})
    assert.equal(rt.state.profiles[worker.id].sessions.length, 0)
    assert.equal(Object.keys(rt.state.tasks).length, 2)
  }
  await rt.reopenTask(parent.id)
  for (let index = 0; index < 5; index++) await delegate({ task: `Slot ${index}`, parentId: parent.id })
  await assert.rejects(delegate(), /最多同时派活 5 个任务/)
  await rt.followLead(owner.id, turn('interrupted'))
  for (let index = 5; index < 24; index++) {
    await delegate({ task: `Budget ${index}` })
    await rt.followLead(owner.id, turn('interrupted'))
  }
  await assert.rejects(delegate(), /本轮已达到 24 次派活上限/)
  assert.equal(Object.values(rt.state.executions).length, 24)
  assert.ok(Object.values(rt.state.executions).every(item => item.status === 'cancelled'))
}))

test('a two-step goal runs both steps in order without another user message or leader turn', () => withFlights(async ({ rt, worker, owner, delegate, turn }) => {
  const first = await delegate({ task: 'Step one\nInvestigate first' })
  const second = await delegate({ task: 'Step two\nBuild on step one', dependsOn: [first.taskId] })
  assert.equal(second.status, 'pending')
  assert.deepEqual(second.flow, { status: 'pending', route: { type: 'feature', hard: false } })
  assert.equal(Object.values(rt.state.executions).length, 1, 'the waiting step has no execution')
  assert.equal(rt.state.profiles[worker.id].sessions.length, 1, 'nor a session')
  await rt.followLead(owner.id, turn('done'))
  const one = await until(() => rt.driverOf(first.session)?.active && rt.driverOf(first.session))
  one.finish('done', 'Step one done')
  const execution = await until(() => Object.values(rt.state.executions).find(item => item.taskId === second.taskId && item.status === 'running'))
  assert.equal(rt.state.tasks[first.taskId].flow.status, 'done')
  const two = await until(() => rt.driverOf(execution.sessionId)?.active && rt.driverOf(execution.sessionId))
  assert.match(two.calls[0], /Step two/)
  two.finish('done', 'Step two done')
  await until(() => rt.state.tasks[second.taskId].flow.status === 'done')
  assert.equal(rt.driverOf(owner.id), undefined, 'the leader never ran a turn')
  assert.deepEqual(Object.values(rt.state.cards).filter(card => card.status === 'open').map(card => card.taskId).sort(), [first.taskId, second.taskId].sort())
}))

test('M1 parallel flights stay independent across a taskId supplement and a stop', () => withFlights(async ({ rt, owner, delegate, turn, stopFlight, reports, ended }) => {
  const a = await delegate({ task: 'Flight A\nRun beside another task' })
  const b = await delegate({ task: 'Flight B\nRun beside flight A' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(a.session)?.active && rt.driverOf(b.session)?.active)
  const da = rt.driverOf(a.session), db = rt.driverOf(b.session)
  assert.equal(rt.state.executions[a.executionId].status, 'running')
  assert.equal(rt.state.executions[b.executionId].status, 'running')
  const deliveredSupplement = await delegate({ taskId: a.taskId, task: '补充 A\nExtra requirement for flight A' })
  assert.equal(deliveredSupplement.executionId, a.executionId)
  assert.equal(deliveredSupplement.delivery.mode, 'steered')
  assert.deepEqual(Object.values(rt.state.executions).map(item => item.status), ['running', 'running'])
  const stopped = await rt.leadDispatch.interrupt(owner.id, { executionId: b.executionId })
  assert.equal(stopped.ended, 'interrupted')
  await until(() => rt.state.executions[b.executionId].status === 'interrupted')
  assert.equal(rt.state.executions[b.executionId].reason, 'interrupted-lead')
  assert.equal(db.active, false)
  assert.equal(da.active, true, 'stopping B leaves A running')
  da.finish('done', 'Flight A completed on its own')
  await until(() => rt.state.tasks[a.taskId].flow.status === 'done')
  assert.equal(rt.state.executions[a.executionId].reportData.structured, true, 'the flight reported through nodo_report')
  assert.equal(rt.state.tasks[b.taskId].flow.status, 'stopped')
  assert.deepEqual(ended(owner.id).map(line => [line.delegation.executionId, line.delegation.ended]),
    [[b.executionId, 'interrupted'], [a.executionId, 'done']], 'the lead only receives status notes, in the order the flights ended')
  assert.equal(reports(owner.id).length, 0)
  const sourceId = `execution:${a.executionId}:result`
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId })).text, 'Flight A completed on its own')
  const record = rt.state.executions[a.executionId]
  assert.equal(record.status, 'done')
  assert.equal(record.sessionId, a.session)
  assert.deepEqual(record.references, [])
  const originalResult = structuredClone(record.result)
  // with no pending execution left on task A, the taskId supplement is accepted
  const supplement = await delegate({ taskId: a.taskId, task: '补充 A\nExtra requirement for flight A' })
  assert.equal(supplement.status, 'queued')
  assert.equal(supplement.taskId, a.taskId)
  assert.equal(supplement.delivery.mode, 'withdrew-card', 'a supplement on a task awaiting acceptance withdraws its acceptance card')
  assert.equal(rt.state.executions[supplement.executionId].stage, 'rework', 'the supplement continues the flow as a rework')
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(supplement.session)?.active)
  assert.notEqual(a.taskId, b.taskId, 'same-round flights are independent tasks')
  assert.deepEqual((await rt.taskView(a.taskId)).executions.map(item => item.id).sort(), [a.executionId, supplement.executionId].sort())
  assert.deepEqual((await rt.taskView(b.taskId)).executions.map(item => item.id), [b.executionId])
  assert.equal(rt.state.executions[b.executionId].status, 'interrupted', 'the ended record of B is untouched by the supplement')
  assert.deepEqual(rt.state.executions[a.executionId].result, originalResult)
  assert.deepEqual(rt.state.executions[a.executionId].references, [])
  await stopFlight(owner.id, supplement)
  assert.equal(reports(owner.id).length, 0)
}))

test('M2 two lead sessions keep snapshots, boards, status notes and task records isolated', () => withFlights(async ({ host, rt, workspace, lead, owner, delegate, turn, finishLead, ended }) => {
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const first = await delegate({ task: 'Session one task' })
  const second = await delegate({ task: 'Session two task' }, other.id)
  await rt.followLead(owner.id, turn('done'))
  await rt.followLead(other.id, turn('done'))
  await until(() => rt.driverOf(first.session)?.active && rt.driverOf(second.session)?.active)
  await host.api('send', { profile: lead.id, session: other.id, text: 'Second round for session two' })
  await until(() => rt.workView()[other.id]?.active)
  rt.driverOf(first.session).finish('done', 'One done')
  await until(() => rt.state.tasks[first.taskId].flow.status === 'done')
  assert.equal(ended(other.id).length, 0, 'the result of session one never lands in session two')
  for (const [id, present, absent] of [[owner.id, 'Session one task', 'Session two task'], [other.id, 'Session two task', 'Session one task']]) {
    const snapshot = rt.leadSnapshot(id)
    assert.ok(snapshot.includes(present) && !snapshot.includes(absent), 'the snapshot only shows own delegations')
    assert.ok(rt.leadDelegations(id).includes(id === owner.id ? first.session : second.session))
    assert.ok(!rt.leadDelegations(id).includes(id === owner.id ? second.session : first.session))
    assert.deepEqual((await rt.leadTasks(id)).map(item => item.id), [id === owner.id ? first.taskId : second.taskId])
  }
  assert.equal(rt.state.tasks[first.taskId].coordinatorSessionId, owner.id)
  assert.equal(rt.state.tasks[second.taskId].coordinatorSessionId, other.id)
  assert.equal(rt.state.executions[first.executionId].taskId, first.taskId)
  assert.equal(rt.state.executions[second.executionId].taskId, second.taskId)
  rt.driverOf(second.session).finish('done', 'Two done')
  await until(() => rt.state.tasks[second.taskId].flow.status === 'done')
  assert.deepEqual(ended(owner.id).map(line => line.delegation.session), [first.session])
  assert.deepEqual(ended(other.id).map(line => line.delegation.session), [second.session])
  assert.equal(rt.driverOf(owner.id), undefined)
  await finishLead(other.id)
}))

test('M3 an engine failure among five active flights frees its slot while the others finish', () => withFlights(async ({ rt, owner, delegate, turn, stopFlight, reports, ended }) => {
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await delegate({ task: `Flight ${index}` }))
  await assert.rejects(delegate({ task: 'One too many' }), /此主控会话最多同时派活 5 个任务，请等一个结束后再派/)
  await rt.followLead(owner.id, turn('done'))
  await until(() => flights.every(flight => rt.driverOf(flight.session)?.active))
  const drivers = Object.fromEntries(flights.map(flight => [flight.executionId, rt.driverOf(flight.session)]))
  drivers[flights[0].executionId].finish('error', 'Engine crashed')
  await until(() => rt.state.tasks[flights[0].taskId].flow.status === 'stalled')
  assert.equal(rt.state.executions[flights[0].executionId].status, 'failed')
  assert.equal(rt.state.executions[flights[0].executionId].reason, 'error')
  const sixth = await delegate({ task: 'Flight six' })
  assert.equal(sixth.status, 'queued', 'the failed flight released its active slot')
  assert.equal(rt.state.executions[flights[1].executionId].status, 'running', 'the sibling flight keeps running')
  drivers[flights[1].executionId].finish('done', 'Flight one completed cleanly')
  await until(() => rt.state.tasks[flights[1].taskId].flow.status === 'done')
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: `execution:${flights[1].executionId}:result` })).text, 'Flight one completed cleanly')
  assert.deepEqual(rt.state.executions[flights[1].executionId].references, [])
  assert.deepEqual(ended(owner.id).map(line => [line.delegation.executionId, line.delegation.ended]), [[flights[0].executionId, 'error'], [flights[1].executionId, 'done']])
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(sixth.session)?.active)
  await stopFlight(owner.id, sixth)
  for (const flight of flights.slice(2)) await stopFlight(owner.id, flight)
  assert.equal(reports(owner.id).length, 0)
  assert.equal(rt.driverOf(owner.id), undefined)
}))

test('M4 results finishing during a lead round advance their flows without touching the round', () => withFlights(async ({ host, rt, lead, owner, delegate, turn, reports }) => {
  const a = await delegate({ task: 'Report A' })
  const b = await delegate({ task: 'Report B' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(a.session)?.active && rt.driverOf(b.session)?.active)
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Busy round' })
  const leadDriver = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  rt.driverOf(a.session).finish('done', 'A finished during the round')
  rt.driverOf(b.session).finish('done', 'B finished during the round')
  await until(() => [a, b].every(item => rt.state.tasks[item.taskId].flow.status === 'done'))
  const reportId = rt.state.executions[a.executionId].reportData.id
  rt.driverOf(a.session).finish('done', 'A late extra round')
  await until(() => !rt.workView()[a.session]?.active)
  assert.equal(rt.state.executions[a.executionId].reportData.id, reportId, 'a repeated turn end never replaces the saved report')
  assert.deepEqual(leadDriver.steers, [], 'nothing steers into the busy lead')
  assert.equal(leadDriver.calls.length, 1)
  assert.equal(rt.workView()[owner.id]?.queued ?? 0, 0, 'nothing queues behind the round')
  leadDriver.finish('done', 'Round complete')
  await until(() => !rt.workView()[owner.id]?.active)
  assert.equal(leadDriver.calls.length, 1)
  assert.equal(reports(owner.id).length, 0)
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: `execution:${a.executionId}:result` })).text, 'A finished during the round')
}))

test('M5 the sixth active dispatch is refused in Chinese and accepted after one flight ends', () => withFlights(async ({ rt, owner, delegate, turn, stopFlight }) => {
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await delegate({ task: `Flight ${index}` }))
  await assert.rejects(delegate({ task: 'One too many' }),
    { code: 'orch/busy', message: '此主控会话最多同时派活 5 个任务，请等一个结束后再派' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => flights.every(flight => rt.driverOf(flight.session)?.active))
  rt.driverOf(flights[0].session).finish('done', 'First finished')
  await until(() => rt.state.tasks[flights[0].taskId].flow.status === 'done')
  assert.equal(rt.state.executions[flights[0].executionId].status, 'done')
  const sixth = await delegate({ task: 'Flight six' })
  assert.equal(sixth.status, 'queued', 'a finished flight frees a slot for the next dispatch')
  await assert.rejects(delegate({ task: 'Flight seven' }), /最多同时派活 5 个任务/)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(sixth.session)?.active)
  await rt.leadDispatch.interrupt(owner.id, { executionId: sixth.executionId })
  for (const flight of flights.slice(1)) await stopFlight(owner.id, flight)
}))

test('M7 parallel shared and isolated tasks keep their directories and continue by taskId', () => withFlights(async ({ rt, workspace, owner, delegate, turn, stopFlight, reports }) => {
  const shared = await delegate({ task: 'Shared work in the main checkout' })
  const iso = await delegate({ task: 'Isolated work in its own directory', worktree: true })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(shared.session)?.active && rt.driverOf(iso.session)?.active)
  const isolated = rt.findWorkspace(rt.state.executions[iso.executionId].workspaceRef)
  assert.ok(isolated?.worktree, 'the isolated execution runs in a task worktree')
  assert.match(isolated.worktree.branch, /^nodo\/task-/)
  assert.equal(rt.state.executions[shared.executionId].workspaceRef, workspace.id)
  assert.equal(rt.conversationOf(shared.session).session.workspaceRef, workspace.id)
  assert.equal(rt.conversationOf(iso.session).session.workspaceRef, isolated.id)
  assert.equal(rt.driverOf(shared.session).cwd, realpathSync(workspace.cwd))
  assert.equal(rt.driverOf(iso.session).cwd, isolated.cwd)
  assert.ok(!rt.driverOf(shared.session).calls[0].includes('执行目录'))
  assert.ok(rt.driverOf(iso.session).calls[0].includes(`执行目录：${isolated.cwd}`))
  rt.driverOf(shared.session).finish('done', 'Shared done')
  rt.driverOf(iso.session).finish('done', 'Isolated done')
  await until(() => [shared, iso].every(item => rt.state.tasks[item.taskId].flow.status === 'done'))
  for (const [flight, expected] of [[shared, 'Shared done'], [iso, 'Isolated done']]) {
    assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: `execution:${flight.executionId}:result` })).text, expected)
    assert.deepEqual(rt.state.executions[flight.executionId].references, [])
  }
  assert.equal(reports(owner.id).length, 0)
  // once the isolated task has no pending execution, its taskId supplement reuses the locked directory
  const again = await delegate({ taskId: iso.taskId, task: '继续隔离任务' })
  assert.equal(again.delivery.mode, 'withdrew-card')
  assert.equal(rt.state.executions[again.executionId].stage, 'rework')
  await assert.rejects(delegate({ taskId: iso.taskId, task: 'Mismatched isolation', worktree: false }), /字段无效/)
  await assert.rejects(delegate({ taskId: shared.taskId, task: 'Mismatched sharing', worktree: true }), /字段无效/)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(again.session)?.active)
  assert.equal(rt.state.executions[again.executionId].workspaceRef, isolated.id, 'the taskId supplement reuses the locked directory')
  assert.equal(rt.driverOf(again.session).cwd, isolated.cwd)
  await stopFlight(owner.id, again)
}, true))

test('a task planned for later dependencies costs one route, not two', () => withFlights(async ({ rt, owner, delegate, turn }) => {
  const first = await delegate({ task: 'Step one' })
  const second = await delegate({ task: 'Step two', dependsOn: [first.taskId] })
  assert.equal(second.status, 'pending')
  await rt.followLead(owner.id, turn('done'))
  const one = await until(() => rt.driverOf(first.session)?.active && rt.driverOf(first.session))
  one.finish('done', 'Step one done')
  await until(() => rt.state.tasks[second.taskId].flow.status === 'running')
  let accepted = 0, failure
  for (let index = 0; index < 30; index++) {
    try { await delegate({ task: `Filler ${index}` }) } catch (error) { failure = error; break }
    accepted++
    await rt.followLead(owner.id, turn('interrupted'))
  }
  assert.equal(accepted, 22, 'the planned route and its scheduled start share one budget slot')
  assert.match(failure.message, /24 次派活上限/)
}))
