import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { withHost, until } from './helpers/host.js'
import { registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { reviewDeliveredReports } from './helpers/report-review.js'

registerClaudeFixtureEngine()
registerEngine('route-fixture', {
  info: { id: 'route-fixture', label: 'Route fixture', capabilities: { resume: true, steer: false } }, validate: raw => raw,
  create({ onEvent }) {
    let turn = 0
    const driver = { calls: [], guides: [], outcome: 'steered', hasSession: () => true, openSession: async () => {}, respondToRequest: async () => false, dispose() {}, onEvent() {},
      sendTurn: async text => { driver.calls.push(text); onEvent({ type: 'turn/start', turnId: `t${++turn}` }) },
      steer: async text => { driver.guides.push(text); return driver.outcome },
      interruptTurn: async () => driver.finish('interrupted'),
      finish(reason = 'done') { onEvent({ type: 'turn/end', turnId: `t${turn}`, reason, text: 'Verified result' }) },
    }
    return driver
  },
})
const turn = { mode: 'turn', completion: Promise.resolve({ reason: 'done' }) }
const withRoute = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Route', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'route-fixture' })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const trigger = text => {
    const line = rt.appendLine(owner.id, { who: 'user', kind: 'text', text })
    return rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: owner.id, line }))
  }
  const create = (extra = {}) => rt.leadRoute(owner.id, { action: 'new', type: 'feature', hard: false, scope: { quote: 'Original' }, ...extra })
  const attach = taskId => rt.leadRoute(owner.id, { action: 'attach', taskId, scope: { quote: 'Supplement' } })
  const start = async () => {
    const execution = Object.values(rt.state.executions).at(-1)
    const calls = rt.driverOf(execution.sessionId)?.calls.length ?? 0
    await rt.followLead(owner.id, turn)
    await until(() => {
      if (!['queued', 'running'].includes(rt.state.executions[execution.id].status)) throw new Error(JSON.stringify(rt.transcriptOf(execution.sessionId)))
      return (rt.driverOf(execution.sessionId)?.calls.length ?? 0) > calls
    })
  }
  const finish = async receipt => {
    rt.driverOf(receipt.session).finish()
    await until(() => rt.state.executions[receipt.executionId].reports?.length && !rt.workView()[owner.id]?.active)
  }
  const binding = await rt.issueLeadMcp(owner.id), spec = binding.servers[0]
  const client = new Client({ name: 'route', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } }))
  try { await run({ host, rt, workspace, worker, lead, owner, other, trigger, create, attach, start, finish, client }) }
  finally { await client.close(); binding.revoke() }
})

test('route rejects invalid scopes, absent triggers, unknown types, missing holders and empty titles with stable codes', () => withRoute(async ({ rt, owner, trigger, create, client }) => {
  const refuse = async (changes, code, retry) => {
    const result = await client.callTool({ name: 'nodo_route', arguments: { action: 'new', type: 'feature', hard: false, scope: { quote: 'Original' }, ...changes } })
    assert.equal(result.isError, true)
    const error = JSON.parse(result.content[0].text)
    assert.equal(error.ok, false); assert.equal(error.code, code); assert.equal(error.retry, retry)
  }
  await refuse({}, 'orch/no-trigger', 'ask-user')
  trigger('Original\nCase sensitive   spacing')
  for (const scope of [undefined, {}, { quote: 'Original', note: 'Original' }]) await refuse({ scope }, 'orch/scope-missing', 'quote-or-note')
  for (const quote of ['original', 'sensitive spacing']) await refuse({ scope: { quote } }, 'orch/scope-not-quote', 'quote-or-note')
  for (const note of ['x'.repeat(101), 'x\ny', '😀'.repeat(51)]) await refuse({ scope: { note } }, 'orch/scope-note-too-long', 'shorten')
  await refuse({ title: '  ' }, 'orch/title-empty', 'quote-or-note')
  await refuse({ type: 'missing' }, 'orch/unknown-type', 'pick-type')
  const team = rt.teams()[0]
  await rt.updateTeams([{ ...team, assign: { feature: { normal: {} } } }])
  await refuse({}, 'orch/no-holder', undefined)
  assert.equal(Object.keys(rt.state.tasks).length, 0)
  assert.equal(Object.keys(rt.state.triggers).length, 0)
  await rt.updateTeams([team])
  const receipt = await create({ scope: { note: 'One line scope' } })
  assert.equal(rt.state.tasks[receipt.taskId].title, 'One line scope')
  assert.deepEqual(receipt.flow, { status: 'running', stage: 'implement', round: 1 })
}))

test('new binds originals and excludes leader title, review reason and basis from worker input', () => withRoute(async ({ rt, owner, trigger, create, start, finish }) => {
  trigger('Original exact wording\nDo only this.')
  const receipt = await create({ title: 'PRIVATE_TITLE' })
  const task = rt.state.tasks[receipt.taskId], execution = rt.state.executions[receipt.executionId]
  assert.equal(task.brief, 'Original exact wording\nDo only this.')
  assert.equal(execution.triggerId, task.triggerId)
  assert.equal(execution.workspaceRef, task.workspaceRef)
  await start()
  const input = rt.driverOf(receipt.session).calls[0]
  assert.match(input, /Original exact wording\nDo only this\./)
  assert.doesNotMatch(input, /PRIVATE_TITLE/)
  await finish(receipt)
  await assert.rejects(create(), { code: 'orch/no-trigger' })
  trigger('Original next task')
  await assert.rejects(create(), { code: 'orch/report-unreviewed' })
  await rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'continue', reason: 'PRIVATE_REASON', basis: ['PRIVATE_BASIS'] })
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
  await assert.rejects(rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'investigate', reason: 'Again', basis: ['Report'], questions: ['Again?'] }), /已复核/)
  const next = await create({ continues: receipt.taskId, hard: true })
  assert.equal(rt.state.tasks[next.taskId].source.continuesTaskId, receipt.taskId)
  assert.equal(rt.state.executions[next.executionId].workspaceRef, task.workspaceRef)
  assert.doesNotMatch((await rt.composeWorkerInput({ executionId: next.executionId })).text, /PRIVATE_TITLE|PRIVATE_REASON|PRIVATE_BASIS/)
}))

test('attach A1 merges into the first composed input, preserving task scope and quota', () => withRoute(async ({ rt, trigger, create, attach, start }) => {
  trigger('Original task')
  const receipt = await create()
  const supplement = trigger('Supplement verbatim')
  const added = await attach(receipt.taskId)
  assert.equal(added.delivery.mode, 'merged')
  assert.equal(added.executionId, receipt.executionId)
  assert.deepEqual(rt.state.executions[receipt.executionId].supplements, [supplement.id])
  assert.deepEqual(rt.state.tasks[receipt.taskId].scope, { quote: 'Original' })
  await start()
  assert.match(rt.driverOf(receipt.session).calls[0], /Supplement verbatim/)
}))

for (const outcome of ['steered', 'refused', 'indeterminate']) test(`attach A2 uses actual steer outcome ${outcome}, and archives after the final queued turn`, () => withRoute(async ({ rt, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start()
  const driver = rt.driverOf(receipt.session); driver.outcome = outcome
  trigger('Supplement exact')
  assert.equal((await attach(receipt.taskId)).delivery.mode, outcome === 'refused' ? 'queued' : 'steered')
  assert.equal(driver.guides.length, 1, 'capabilities.steer=false does not suppress a steer attempt')
  if (outcome === 'refused') {
    driver.finish()
    await until(() => driver.calls.length === 2)
    assert.equal(rt.state.executions[receipt.executionId].status, 'running')
  }
  if (outcome === 'indeterminate') assert.match(JSON.stringify(rt.transcriptOf(receipt.session)), /未在时限内确认/)
  await finish(receipt)
}))

test('a restored queued supplement recomposes only up to itself; later ones still deliver once', () => withRoute(async ({ rt, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start()
  const driver = rt.driverOf(receipt.session); driver.outcome = 'refused'
  trigger('Supplement A verbatim')
  assert.equal((await attach(receipt.taskId)).delivery.mode, 'queued')
  trigger('Supplement B verbatim')
  assert.equal((await attach(receipt.taskId)).delivery.mode, 'queued')
  driver.hasSession = () => false
  driver.finish()
  await until(() => driver.calls.length === 2)
  assert.match(driver.calls[1], /Supplement A verbatim/)
  assert.doesNotMatch(driver.calls[1], /Supplement B verbatim/, 'the restore recomposition stops at its own trigger')
  driver.finish()
  await until(() => driver.calls.length === 3)
  const received = driver.calls.join('\n---\n')
  assert.equal(received.split('Supplement B verbatim').length - 1, 1, 'B arrives exactly once, in its own input')
  assert.match(driver.calls[2], /Supplement B verbatim/)
  await finish(receipt)
}))

test('attach A3 only queues during review and A4 opens rework when no execution is active', () => withRoute(async ({ rt, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start()
  rt.state.tasks[receipt.taskId].flow.status = 'reviewing'
  trigger('Supplement during review')
  assert.equal((await attach(receipt.taskId)).delivery.mode, 'queued')
  assert.equal(rt.driverOf(receipt.session).guides.length, 0)
  await finish(receipt)
  trigger('Supplement after review')
  const next = await attach(receipt.taskId)
  assert.equal(next.delivery.mode, 'rework')
  assert.notEqual(next.executionId, receipt.executionId)
  assert.equal(rt.state.executions[next.executionId].stage, 'rework')
  assert.equal(rt.state.tasks[next.taskId].flow.supplementReworks, 1)
  assert.match((await rt.composeWorkerInput({ executionId: next.executionId })).text, /Supplement during review[\s\S]*Supplement after review|Supplement after review[\s\S]*Supplement during review/)
}))

test('attach A5 withdraws only its acceptance card; A6/A7 reject stalled, ended and legacy tasks', () => withRoute(async ({ rt, owner, other, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start(); await finish(receipt)
  const task = rt.state.tasks[receipt.taskId]
  rt.state.cards.own = { id: 'own', coordinatorSessionId: owner.id, taskId: task.id, status: 'open', kind: 'acceptance' }
  rt.state.cards.foreign = { id: 'foreign', coordinatorSessionId: other.id, taskId: 'another', status: 'open', kind: 'stall' }
  for (const status of ['stalled', 'accepted', 'stopped', 'frozen']) {
    task.flow.status = status; trigger('Supplement')
    await assert.rejects(attach(task.id), { code: status === 'stalled' ? 'orch/task-stalled' : 'orch/frozen' })
  }
  const flow = task.flow; delete task.flow
  await assert.rejects(attach(task.id), { code: 'orch/frozen' })
  await assert.rejects(rt.leadRoute(owner.id, { action: 'stop', taskIds: [task.id] }), { code: 'orch/frozen' })
  await rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'continue', reason: 'Checked legacy report', basis: ['Report'] })
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
  task.flow = flow
  task.flow.status = 'accepting'
  const next = await attach(task.id)
  assert.equal(next.delivery.mode, 'withdrew-card')
  assert.equal(rt.state.cards.own.status, 'resolved')
  assert.equal(rt.state.cards.own.answer, 'supplement')
  assert.equal(rt.state.cards.foreign.status, 'open')
}))

test('continues rejects active sources and conflicting worktree without creating resources', () => withRoute(async ({ rt, owner, trigger, create, start, finish }) => {
  trigger('Original'); const receipt = await create()
  await assert.rejects(create({ continues: receipt.taskId }), { code: 'orch/source-busy' })
  await start(); await finish(receipt); await reviewDeliveredReports(rt, owner.id); trigger('Original next')
  await assert.rejects(create({ continues: receipt.taskId, worktree: true }), { code: 'orch/worktree-mismatch' })
  await assert.rejects(create({ continues: receipt.taskId, dependsOn: [] }), /互斥/)
  assert.equal(Object.keys(rt.state.tasks).length, 1)
}))

test('investigate sends bounded questions to the current executor and continue clears both report cards', () => withRoute(async ({ host, rt, worker, owner, trigger, create, start, finish }) => {
  trigger('Original'); const receipt = await create(); await start(); await finish(receipt)
  const command = { executionId: receipt.executionId, disposition: 'investigate', reason: 'PRIVATE_REASON', basis: ['PRIVATE_BASIS'], questions: ['Which verification ran?'] }
  for (const questions of [undefined, [], Array(6).fill('x'), ['x'.repeat(201)]]) await assert.rejects(rt.leadReview(owner.id, { ...command, questions }))
  const replacement = await host.api('profile-create', { name: 'Replacement', engine: 'route-fixture' })
  const team = rt.teams()[0]
  await rt.updateTeams([{ ...team, members: [worker.id, replacement.id], assign: { feature: { normal: { profile: replacement.id } } } }])
  const answer = await rt.leadReview(owner.id, command)
  const execution = rt.state.executions[answer.executionId]
  assert.equal(execution.stage, 'answer'); assert.equal(execution.profileId, rt.state.executions[receipt.executionId].profileId)
  assert.equal(execution.sourceReportId, rt.state.executions[receipt.executionId].reports[0].id)
  assert.equal(rt.state.executions[receipt.executionId].status, 'done')
  assert.equal(rt.reportReviewBlockReason(owner.id).code, 'orch/report-unreviewed')
  await start()
  const input = rt.driverOf(answer.session).calls.at(-1)
  assert.match(input, /Which verification ran\?/); assert.doesNotMatch(input, /PRIVATE_REASON|PRIVATE_BASIS/)
  await finish(answer)
  await rt.leadReview(owner.id, { executionId: answer.executionId, disposition: 'continue', reason: 'Checked', basis: ['Answers'] })
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
  assert.equal(rt.state.executions[receipt.executionId].reports[0].review.answeredBy, answer.executionId)
}))

test('attach after a review execution reworks with the implementation type and holder', () => withRoute(async ({ host, rt, worker, owner, workspace, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start(); await finish(receipt)
  const reviewer = await host.api('profile-create', { name: 'Reviewer', engine: 'route-fixture' })
  const reviewSession = await host.api('session-create', { profile: reviewer.id, workspace: workspace.id, lazy: true })
  const team = rt.teams()[0]
  await rt.updateTeams([{ ...team, members: [worker.id, reviewer.id], types: [...team.types, { id: 'review', name: 'Review', when: '' }],
    assign: { ...team.assign, review: { normal: { profile: reviewer.id } } } }])
  const review = await rt.acceptExecution(rt.state.tasks[receipt.taskId].id, { profileId: reviewer.id, sessionId: reviewSession.id,
    type: 'review', hard: false, stage: 'review', triggerId: rt.state.tasks[receipt.taskId].triggerId, scope: { quote: 'Original task' }, sourceExecutionId: receipt.executionId })
  await rt.startExecution(review.id)
  await rt.finishExecution(review.id, { final: '审查报告文本', report: '审查' })
  trigger('Supplement rework')
  const next = await attach(receipt.taskId)
  assert.equal(next.delivery.mode, 'rework')
  assert.equal(next.type, 'feature', 'the rework rides the last implementation, not the review execution')
  assert.equal(rt.state.executions[next.executionId].profileId, worker.id)
  assert.equal(rt.state.executions[next.executionId].stage, 'rework')
  const input = await rt.composeWorkerInput({ executionId: next.executionId })
  assert.doesNotMatch(input.text, /审查报告文本/, 'the review execution only feeds verdict and findings')
  assert.match(input.text, /上一执行：Verified result/)
  await rt.leadDispatch.interrupt(owner.id, { executionId: next.executionId })
}))

test('a pending decision blocks rework attach and investigate but leaves running supplements open', () => withRoute(async ({ rt, owner, trigger, create, attach, start, finish }) => {
  trigger('Original task'); const receipt = await create(); await start(); await finish(receipt)
  await rt.leadRoute(owner.id, { action: 'ask', stopExecutionIds: [], questions: [{ id: 'q', question: 'Which?', whyUser: 'Preference' }] })
  trigger('Supplement rework')
  await assert.rejects(attach(receipt.taskId), { code: 'orch/decision-pending' })
  await assert.rejects(rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] }), { code: 'orch/decision-pending' })
}))

test('investigate questions are redacted before storage and worker input', () => withRoute(async ({ host, rt, lead, owner, trigger, create, start, finish }) => {
  const value = 'investigate-question-secret-value-'.repeat(3)
  await host.api('secret-set', { name: 'INVESTIGATE_Q', value, purpose: 'test', scope: [lead.id] })
  trigger('Original'); const receipt = await create(); await start(); await finish(receipt)
  const answer = await rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: [`Did you verify ${value}?`] })
  const execution = rt.state.executions[answer.executionId]
  assert.equal(execution.questions.includes(value), false)
  assert.match(execution.questions[0], /\[secret:INVESTIGATE_Q\]/)
  assert.equal(JSON.stringify(rt.state.executions[receipt.executionId].reports.at(-1).review).includes(value), false)
  await start()
  const input = rt.driverOf(answer.session).calls.at(-1)
  assert.match(input, /\[secret:INVESTIGATE_Q\]/); assert.equal(input.includes(value), false)
  await finish(answer)
}))

test('an answer continue clears every awaiting report of the source execution', () => withRoute(async ({ rt, owner, trigger, create, start, finish }) => {
  trigger('Original'); const receipt = await create(); await start(); await finish(receipt)
  const execution = rt.state.executions[receipt.executionId]
  await rt.registerDeliveredReport({ executionId: receipt.executionId, id: 'extra-report', session: receipt.session, summary: 'Second report', status: 'done' }, Date.now())
  assert.equal(execution.reports.length, 2)
  const answer = await rt.leadReview(owner.id, { executionId: receipt.executionId, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] })
  for (const report of execution.reports) assert.equal(report.review.awaitingAnswer, true)
  await start(); await finish(answer)
  await rt.leadReview(owner.id, { executionId: answer.executionId, disposition: 'continue', reason: 'Checked', basis: ['Answers'] })
  for (const report of execution.reports) {
    assert.equal(report.review.awaitingAnswer, false)
    assert.equal(report.review.answeredBy, answer.executionId)
  }
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
}))

test('cards-only snapshots stay visible and report/evidence handles enforce coordinator ownership', () => withRoute(async ({ rt, owner, other, trigger, create }) => {
  rt.state.cards.card = { id: 'card', coordinatorSessionId: owner.id, taskId: 'task', kind: 'stall', status: 'open', question: { question: 'Retry?' } }
  assert.match(rt.leadSnapshot(owner.id), /card/)
  assert.equal(rt.leadCards(other.id).length, 0)
  trigger('Original'); const receipt = await create()
  const execution = rt.state.executions[receipt.executionId]
  execution.reportData = { id: 'report', summary: 'Structured' }; execution.evidence = { branch: 'test' }
  for (const sourceId of ['report:report', `evidence:${execution.id}`]) {
    assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId })).completeness, 'complete')
    await assert.rejects(rt.executionContext(other.id, { action: 'read', sourceId }), /不属于/)
  }
  delete execution.evidence
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: `evidence:${execution.id}` })).completeness, 'unavailable')
}))

test('stop is owned and remains available while decisions, report gates and route budget block new work', () => withRoute(async ({ rt, owner, other, trigger, create, attach, start }) => {
  trigger('Original'); const receipt = await create(); await start()
  await assert.rejects(rt.leadRoute(other.id, { action: 'stop', executionIds: [receipt.executionId] }), /不属于/)
  await rt.leadRoute(owner.id, { action: 'ask', stopExecutionIds: [], questions: [{ id: 'q', question: 'Which?', whyUser: 'Preference' }] })
  trigger('Original'); await assert.rejects(create(), { code: 'orch/decision-pending' })
  trigger('Supplement during wait')
  const steered = await attach(receipt.taskId)
  assert.equal(steered.delivery.mode, 'steered', 'a supplement into a running execution stays available while a decision waits')
  const stopped = await rt.leadRoute(owner.id, { action: 'stop', taskIds: [receipt.taskId] })
  assert.equal(stopped.ok, true); assert.equal(rt.state.tasks[receipt.taskId].flow.status, 'stopped')
  assert.equal(Object.keys(rt.state.triggers).length, 0)
}))

test('trigger quota refuses both new and attach with the fixed message', () => withRoute(async ({ rt, owner, trigger, create, attach }) => {
  trigger('Original'); const receipt = await create()
  rt.state.triggers.full = { coordinatorSessionId: owner.id, text: 'x'.repeat(200_000) }
  trigger('Supplement')
  for (const operation of [() => create({ scope: { note: 'New' } }), () => attach(receipt.taskId)]) await assert.rejects(operation(), { code: 'orch/trigger-full', message: '触发消息存储已满。请清理停滞或已结束的任务，再派新活。' })
}))

test('real fixture user turns bind originals and system report turns clear pending', () => withRoute(async ({ host, rt, lead, owner, create }) => {
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Original user line' })
  await until(() => !rt.workView()[owner.id]?.active)
  const receipt = await create()
  assert.equal(rt.state.triggers[rt.state.tasks[receipt.taskId].triggerId].text, 'Original user line')
  await rt.send(lead.id, 'System report', owner.id, [], [], { origin: { kind: 'report' } })
  await until(() => !rt.workView()[owner.id]?.active)
  await assert.rejects(create(), { code: 'orch/no-trigger' })
}))
