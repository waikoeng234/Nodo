import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { withHost, until } from './helpers/host.js'

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
  const lines = id => rt.transcriptOf(id)
  const turn = (reason = 'done') => ({ mode: 'turn', completion: Promise.resolve({ reason }) })
  const delegate = (overrides = {}, ownerId = owner.id) => rt.leadDispatch.delegate(ownerId,
    { type: 'feature', hard: false, task: 'Implement and verify\nPreserve existing changes.', ...overrides })
  const finishLead = async id => {
    const driver = await until(() => rt.driverOf(id)?.active && rt.driverOf(id))
    const count = driver.calls.length
    driver.finish('done', 'Reviewed')
    await until(() => !rt.workView()[id]?.active || driver.calls.length > count)
  }
  const stopFlight = async (ownerId, flight) => {
    if (['queued', 'running'].includes(rt.state.executions[flight.executionId].status)) {
      await rt.leadDispatch.interrupt(ownerId, { executionId: flight.executionId })
    }
  }
  await run({ host, rt, workspace, worker, lead, owner, reports, lines, turn, delegate, finishLead, stopFlight })
})

test('dependency and done-parent rejections leave all five slots and all 24 dispatches available without queued work or sessions', () => withFlights(async ({ rt, workspace, worker, owner, delegate, turn }) => {
  const dependency = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Prerequisite', brief: 'Must be accepted first', source: { kind: 'lead' } })
  const parent = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Accepted goal', brief: 'Reopen before new work', source: { kind: 'lead' } })
  rt.state.tasks[parent.id].status = 'done'
  const statuses = ['open', 'review', 'blocked', 'stopped']
  for (let index = 0; index < 28; index++) {
    rt.state.tasks[dependency.id].status = statuses[index % statuses.length]
    await assert.rejects(delegate({ dependsOn: [dependency.id] }), { code: 'orch/invalid', message: '依赖任务 Prerequisite 尚未验收，先完成它再派活' })
    await assert.rejects(delegate({ parentId: parent.id }), { code: 'orch/invalid', message: '父任务已验收，请先 reopen 父任务' })
    assert.deepEqual(rt.state.executions, {})
    assert.equal(rt.state.profiles[worker.id].sessions.length, 0)
    assert.equal(Object.keys(rt.state.tasks).length, 2)
  }
  await rt.leadTask(owner.id, { taskId: parent.id, action: 'reopen' })
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

test('M1 parallel flights stay independent across a taskId supplement and a stop', () => withFlights(async ({ rt, owner, delegate, turn, finishLead, stopFlight, reports, lines }) => {
  const a = await delegate({ task: 'Flight A\nRun beside another task' })
  const b = await delegate({ task: 'Flight B\nRun beside flight A' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(a.session)?.active && rt.driverOf(b.session)?.active)
  const da = rt.driverOf(a.session), db = rt.driverOf(b.session)
  assert.equal(rt.state.executions[a.executionId].status, 'running')
  assert.equal(rt.state.executions[b.executionId].status, 'running')
  // A task keeps one pending execution: while A runs, its taskId cannot take a supplement
  await assert.rejects(delegate({ taskId: a.taskId, task: '补充 A\nExtra requirement for flight A' }),
    { code: 'orch/busy', message: 'Task or session already has a pending execution' })
  assert.deepEqual(Object.values(rt.state.executions).map(item => item.status), ['running', 'running'])
  assert.equal(reports(owner.id).length, 0, 'the refused supplement leaves no report or corrupted state')
  const stopped = await rt.leadDispatch.interrupt(owner.id, { executionId: b.executionId })
  assert.equal(stopped.ended, 'interrupted')
  await until(() => rt.state.executions[b.executionId].status === 'interrupted')
  assert.equal(rt.state.executions[b.executionId].reason, 'interrupted-lead')
  assert.equal(db.active, false)
  assert.equal(da.active, true, 'stopping B leaves A running')
  da.finish('done', 'Flight A completed on its own')
  await until(() => reports(owner.id).length === 1)
  await finishLead(owner.id)
  const transcript = lines(owner.id)
  const delivered = transcript.filter(line => line.origin?.kind === 'report')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].origin.executionId, a.executionId)
  assert.equal(delivered[0].references[0].messages[0].text, 'Flight A completed on its own')
  const stopNote = transcript.findIndex(line => line.delegation?.executionId === b.executionId && line.delegation.ended === 'interrupted')
  assert.ok(stopNote >= 0 && stopNote < transcript.indexOf(delivered[0]), 'the stop status of B reaches the lead before the report of A')
  const record = rt.state.executions[a.executionId]
  assert.equal(record.status, 'done')
  assert.equal(record.sessionId, a.session)
  assert.equal(record.references.length, 1)
  // with no pending execution left on task A, the taskId supplement is accepted
  const supplement = await delegate({ taskId: a.taskId, task: '补充 A\nExtra requirement for flight A' })
  assert.equal(supplement.status, 'queued')
  assert.equal(supplement.taskId, a.taskId)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(supplement.session)?.active)
  assert.notEqual(a.taskId, b.taskId, 'same-round flights are independent tasks')
  assert.deepEqual((await rt.taskView(a.taskId)).executions.map(item => item.id).sort(), [a.executionId, supplement.executionId].sort())
  assert.deepEqual((await rt.taskView(b.taskId)).executions.map(item => item.id), [b.executionId])
  assert.equal(rt.state.executions[b.executionId].status, 'interrupted', 'the ended record of B is untouched by the supplement')
  assert.equal(rt.state.executions[a.executionId].references.length, 1)
  await stopFlight(owner.id, supplement)
  assert.equal(reports(owner.id).length, 1, 'a confirmed stop never produces a report')
}))

test('M2 two lead sessions keep snapshots, boards, report queues and task records isolated', () => withFlights(async ({ host, rt, workspace, lead, owner, delegate, turn, finishLead, reports }) => {
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const first = await delegate({ task: 'Session one task' })
  const second = await delegate({ task: 'Session two task' }, other.id)
  await rt.followLead(owner.id, turn('done'))
  await rt.followLead(other.id, turn('done'))
  await until(() => rt.driverOf(first.session)?.active && rt.driverOf(second.session)?.active)
  await host.api('send', { profile: lead.id, session: other.id, text: 'Second round for session two' })
  await until(() => rt.workView()[other.id]?.active)
  rt.driverOf(first.session).finish('done', 'One done')
  await until(() => reports(owner.id).length === 1)
  assert.equal(reports(other.id).length, 0, 'the report of session one never lands in session two')
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
  await until(() => rt.conversationOf(other.id).session.reportQueue?.length === 1)
  assert.equal(rt.conversationOf(other.id).session.reportQueue[0].session, second.session)
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined, 'the queue of session one stays empty')
  await finishLead(owner.id)
  await finishLead(other.id)
  await until(() => reports(other.id).length === 1)
  assert.equal(reports(other.id)[0].origin.session, second.session)
  await finishLead(other.id)
  assert.equal(rt.conversationOf(other.id).session.reportQueue, undefined)
  assert.equal(reports(owner.id).length, 1)
  assert.equal(reports(other.id).length, 1)
}))

test('M3 an engine failure among five active flights frees its slot while the others report', () => withFlights(async ({ rt, owner, delegate, turn, finishLead, stopFlight, reports }) => {
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await delegate({ task: `Flight ${index}` }))
  await assert.rejects(delegate({ task: 'One too many' }), /此主控会话最多同时派活 5 个任务，请等一个结束后再派/)
  await rt.followLead(owner.id, turn('done'))
  await until(() => flights.every(flight => rt.driverOf(flight.session)?.active))
  const drivers = Object.fromEntries(flights.map(flight => [flight.executionId, rt.driverOf(flight.session)]))
  drivers[flights[0].executionId].finish('error', 'Engine crashed')
  // The report is attached after the status settles.
  await until(() => typeof rt.state.executions[flights[0].executionId].report === 'string')
  assert.equal(rt.state.executions[flights[0].executionId].status, 'failed')
  assert.equal(rt.state.executions[flights[0].executionId].reason, 'error')
  const sixth = await delegate({ task: 'Flight six' })
  assert.equal(sixth.status, 'queued', 'the failed flight released its active slot')
  assert.equal(rt.state.executions[flights[1].executionId].status, 'running', 'the sibling flight keeps running')
  drivers[flights[1].executionId].finish('done', 'Flight one completed cleanly')
  await until(() => rt.state.executions[flights[1].executionId].references.length === 1)
  await until(() => reports(owner.id).some(line => line.origin.executionId === flights[0].executionId))
  assert.match(reports(owner.id).find(line => line.origin.executionId === flights[0].executionId).text, /Result: failed\. Reason: error\./)
  await finishLead(owner.id)
  await finishLead(owner.id)
  await until(() => rt.driverOf(sixth.session)?.active)
  await until(() => reports(owner.id).some(line => line.origin.executionId === flights[1].executionId))
  await stopFlight(owner.id, sixth)
  for (const flight of flights.slice(2)) await stopFlight(owner.id, flight)
  assert.equal(reports(owner.id).length, 2)
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined)
}))

test('M4 results finishing during a lead round queue up and flush once in FIFO order', () => withFlights(async ({ host, rt, lead, owner, delegate, turn, finishLead, reports, lines }) => {
  const a = await delegate({ task: 'Report A' })
  const b = await delegate({ task: 'Report B' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(a.session)?.active && rt.driverOf(b.session)?.active)
  // The user round already runs when the executions end, so both results queue behind it;
  // freezing the first result pins the FIFO order before the second one enters the queue.
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Busy round' })
  const leadDriver = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  const queue = () => rt.conversationOf(owner.id).session.reportQueue
  rt.driverOf(a.session).finish('done', 'A finished during the round')
  await until(() => queue()?.[0]?.session === a.session && queue()[0].referenceId)
  rt.driverOf(b.session).finish('done', 'B finished during the round')
  await until(() => queue()?.length === 2)
  assert.deepEqual(queue().map(item => item.session), [a.session, b.session])
  assert.equal(reports(owner.id).length, 0, 'queued reports do not interrupt the running round')
  rt.driverOf(a.session).finish('done', 'A late extra round')
  await until(() => !rt.workView()[a.session]?.active)
  assert.equal(reports(owner.id).length, 0)
  assert.deepEqual(leadDriver.steers, [], 'nothing steers into the busy lead')
  leadDriver.finish('done', 'Round complete')
  await until(() => reports(owner.id).length === 1)
  assert.equal(reports(owner.id)[0].origin.session, a.session)
  assert.equal(reports(owner.id)[0].references[0].messages[0].text, 'A finished during the round')
  await finishLead(owner.id)
  await until(() => reports(owner.id).length === 2)
  assert.equal(reports(owner.id)[1].origin.session, b.session)
  await finishLead(owner.id)
  const transcript = lines(owner.id)
  const delivered = transcript.filter(line => line.origin?.kind === 'report')
  assert.equal(delivered.length, 2)
  for (const line of delivered) assert.equal(transcript.filter(item => item.origin?.reportId === line.origin.reportId).length, 1)
  assert.equal(rt.state.executions[a.executionId].status, 'done')
  assert.equal(rt.state.executions[b.executionId].status, 'done')
  assert.equal(queue(), undefined, 'no report is lost or duplicated')
}))

test('M5 the sixth active dispatch is refused in Chinese and accepted after one flight ends', () => withFlights(async ({ rt, owner, delegate, turn, finishLead, stopFlight, reports }) => {
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await delegate({ task: `Flight ${index}` }))
  await assert.rejects(delegate({ task: 'One too many' }),
    { code: 'orch/invalid', message: '此主控会话最多同时派活 5 个任务，请等一个结束后再派' })
  await rt.followLead(owner.id, turn('done'))
  await until(() => flights.every(flight => rt.driverOf(flight.session)?.active))
  rt.driverOf(flights[0].session).finish('done', 'First finished')
  // The end save settles before the slot is released; the report snapshot is attached after that.
  await until(() => typeof rt.state.executions[flights[0].executionId].report === 'string')
  assert.equal(rt.state.executions[flights[0].executionId].status, 'done')
  const sixth = await delegate({ task: 'Flight six' })
  assert.equal(sixth.status, 'queued', 'a finished flight frees a slot for the next dispatch')
  await assert.rejects(delegate({ task: 'Flight seven' }), /最多同时派活 5 个任务/)
  await until(() => reports(owner.id).length === 1)
  await finishLead(owner.id)
  await until(() => rt.driverOf(sixth.session)?.active)
  await rt.leadDispatch.interrupt(owner.id, { executionId: sixth.executionId })
  for (const flight of flights.slice(1)) await stopFlight(owner.id, flight)
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined)
}))

test('M7 parallel shared and isolated tasks keep their directories and continue by taskId', () => withFlights(async ({ rt, workspace, owner, delegate, turn, finishLead, stopFlight, reports }) => {
  const shared = await delegate({ task: 'Shared work in the main checkout' })
  const iso = await delegate({ task: 'Isolated work in its own directory', worktree: true })
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(shared.session)?.active && rt.driverOf(iso.session)?.active)
  const isolated = rt.findWorkspace(rt.state.executions[iso.executionId].workspaceRef)
  assert.ok(isolated?.worktree, 'the isolated execution runs in a task worktree')
  assert.match(isolated.worktree.branch, /^nodo\/task-/)
  assert.equal(rt.state.executions[shared.executionId].workspaceRef, undefined)
  assert.equal(rt.conversationOf(shared.session).session.workspaceRef, workspace.id)
  assert.equal(rt.conversationOf(iso.session).session.workspaceRef, isolated.id)
  assert.equal(rt.driverOf(shared.session).cwd, realpathSync(workspace.cwd))
  assert.equal(rt.driverOf(iso.session).cwd, isolated.cwd)
  assert.ok(!rt.driverOf(shared.session).calls[0].includes('执行目录'))
  assert.ok(rt.driverOf(iso.session).calls[0].includes(`执行目录：${isolated.cwd}`))
  rt.driverOf(shared.session).finish('done', 'Shared done')
  rt.driverOf(iso.session).finish('done', 'Isolated done')
  await until(() => rt.state.executions[shared.executionId].references.length === 1 && rt.state.executions[iso.executionId].references.length === 1)
  await finishLead(owner.id)
  await finishLead(owner.id)
  assert.equal(reports(owner.id).length, 2)
  // once the isolated task has no pending execution, its taskId supplement reuses the locked directory
  const again = await delegate({ taskId: iso.taskId, task: '继续隔离任务', worktree: true })
  await assert.rejects(delegate({ taskId: iso.taskId, task: 'Mismatched isolation', worktree: false }), /执行目录不一致/)
  await assert.rejects(delegate({ taskId: shared.taskId, task: 'Mismatched sharing', worktree: true }), /执行目录不一致/)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.driverOf(again.session)?.active)
  assert.equal(rt.state.executions[again.executionId].workspaceRef, isolated.id, 'the taskId supplement reuses the locked directory')
  assert.equal(rt.driverOf(again.session).cwd, isolated.cwd)
  await stopFlight(owner.id, again)
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined)
}, true))
