import { routeUserTask, userRoute } from './helpers/route.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewDeliveredReports } from './helpers/report-review.js'
import { withHost, until } from './helpers/host.js'
import { registerClaudeFixtureEngine } from './helpers/echo-driver.js'

registerClaudeFixtureEngine()

test('fixture review waits for visible report registration and removal from the delivery queue', async () => {
  const report = { id: 'report' }, session = { id: 'lead', reportQueue: [report] }
  const execution = { id: 'execution', taskId: 'task' }, calls = []
  let inspected
  const registered = new Promise(resolve => { inspected = resolve })
  const rt = {
    state: { tasks: { task: { coordinatorSessionId: session.id } }, executions: { execution } },
    conversationOf: () => ({ profile: { lead: true }, session }),
    transcriptOf: () => {
      if (execution.reports) inspected()
      return [{ origin: { kind: 'report', reviewRequired: true, executionId: execution.id, reportId: report.id } }]
    },
    leadReview: async (...args) => { calls.push(args); report.review = { disposition: 'continue' } },
  }
  let reviewed = false
  const reviewing = reviewDeliveredReports(rt, session.id).then(() => { reviewed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reviewed, false, 'a visible transcript row does not prove report registration')
  execution.reports = [report]
  await registered
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reviewed, false, 'registration is followed by saving and removing the queue entry')
  session.reportQueue = []
  await reviewing
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].executionId, execution.id)
  assert.deepEqual(calls[0][1].basis, [report.id])
  assert.equal(report.review.disposition, 'continue')
})

test('fixture review does not wait for or approve reports still queued behind the leader', async () => {
  const session = { id: 'lead', reportQueue: [{ id: 'undelivered', executionId: 'execution' }] }
  const rt = {
    state: { tasks: { task: { coordinatorSessionId: session.id } }, executions: { execution: { id: 'execution', taskId: 'task' } } },
    conversationOf: () => ({ profile: { lead: true }, session }),
    transcriptOf: () => [],
    leadReview: async () => { assert.fail('an undelivered report cannot be reviewed') },
  }
  await reviewDeliveredReports(rt, session.id)
  assert.equal(session.reportQueue.length, 1)
})

test('a visible report can precede registration, but the actual leader turn starts behind the review gate', () => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Reports', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'echo', engineOptions: { script: [{ kind: 'text', text: 'Completed' }] } })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }],
    assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  let entered, release, atLeaderStart
  const admitting = new Promise(resolve => { entered = resolve })
  const admission = new Promise(resolve => { release = resolve })
  const save = rt.save, ensure = rt.ensureDriver
  let held = false
  rt.save = async (...args) => {
    if (!held && !args[0] && rt.transcriptOf(owner.id).some(line => line.origin?.kind === 'report')) {
      held = true
      entered()
      await admission
    }
    return save(...args)
  }
  rt.ensureDriver = async profile => {
    const driver = await ensure(profile)
    if (profile.id === owner.id) {
      const send = driver.sendTurn
      driver.sendTurn = (...args) => { atLeaderStart = rt.reportReviewBlockReason(owner.id); return send(...args) }
    }
    return driver
  }
  const receipt = await routeUserTask(rt, owner.id, { type: 'feature', hard: false, task: 'Implement and verify' })
  const execution = rt.state.executions[receipt.executionId]
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'done' }) })
  assert.equal(execution.reports, undefined, 'followLead returns before worker completion and report delivery')
  await admitting
  try {
    assert.equal(execution.reports, undefined)
    assert.equal(rt.workView()[owner.id]?.active ?? false, false)
    assert.ok(rt.conversationOf(owner.id).session.reportQueue.length)
    assert.equal(atLeaderStart, undefined, 'the report input has not reached leader processing')
  } finally { release(); rt.save = save }
  await until(() => atLeaderStart)
  assert.equal(atLeaderStart.code, 'orch/report-unreviewed')
  await assert.rejects(routeUserTask(rt, owner.id, { type: 'feature', hard: false, task: 'Unauthorized continuation' }), { code: 'orch/report-unreviewed' })
  await reviewDeliveredReports(rt, owner.id)
  assert.equal(execution.reports[0].review.disposition, 'continue')
  await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
  await rt.saveStrict()
}))
