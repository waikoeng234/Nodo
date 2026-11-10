import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowOf } from '../core/src/flow.js'
import { withFlow, flags, reportOf } from './helpers/flow.js'
import { boot, until } from './helpers/host.js'

test('flowOf is the single default and custom review policy resolver', () => {
  assert.deepEqual(flowOf(undefined), { reviewType: 'review', maxRework: 2 })
  assert.deepEqual(flowOf({}), { reviewType: 'review', maxRework: 2 })
  assert.deepEqual(flowOf({ flow: { reviewType: 'audit', maxRework: 0 } }), { reviewType: 'audit', maxRework: 0 })
})

test('R1-R5 review predicates cover positive and negative conditions', () => withFlow(async ({ rt }) => {
  const execution = { stage: 'implement', reportData: reportOf() }
  assert.equal(rt.needsFlowReview(execution), false)
  for (const flag of Object.keys(flags)) {
    execution.reportData = reportOf({ reviewFlags: { ...flags, [flag]: true } })
    assert.equal(rt.needsFlowReview(execution), true, `R1 ${flag}`)
  }
  for (const verified of [[], [{ result: 'not-run' }], [{ result: 'fail' }]]) {
    execution.reportData = reportOf({ verified }); assert.equal(rt.needsFlowReview(execution), true, 'R2')
  }
  execution.reportData = reportOf({ reviewFlags: undefined }); assert.equal(rt.needsFlowReview(execution), true, 'R3')
  execution.reportData = undefined; assert.equal(rt.needsFlowReview(execution), true, 'R3 unavailable report')
  execution.stage = 'rework'; execution.sourceExecutionId = 'review'
  rt.state.executions.review = { stage: 'review', reportData: { verdict: 'fail' } }
  execution.reportData = reportOf(); assert.equal(rt.needsFlowReview(execution), true, 'R4')
  rt.state.executions.review.reportData.verdict = 'pass'; assert.equal(rt.needsFlowReview(execution), false, 'R4 negative')
  execution.stage = 'review'; execution.reportData = reportOf({ verified: [], reviewFlags: undefined })
  assert.equal(rt.needsFlowReview(execution), false, 'R5 review never recursively reviews')
  delete rt.state.executions.review
}))

test('done waits for continue; acceptance uses completeTask and records user evidence atomically', () => withFlow(async ({ host, rt, owner, lead, create, finish, review, card, answer, assertState }) => {
  const execution = await create(); await finish(execution)
  assertState(execution, 'running', 'open'); assert.equal(card(execution.taskId), undefined)
  await review(execution); assertState(execution, 'accepting', 'blocked')
  const item = card(execution.taskId)
  assert.deepEqual(item.payload.scope, { quote: 'Original' })
  assert.equal(item.payload.trigger.summary, 'Original exact requirement')
  assert.equal(item.payload.stages[0].outcome, 'done'); assert.equal(item.question.recommendation, 'accept')
  assert.equal(rt.sessionBlockReason(owner.id), undefined)
  const completeTask = rt.completeTask; let called = false
  rt.completeTask = async (...args) => { called = true; return completeTask(...args) }
  await answer(item, 'accept', 'Checked the result')
  assert.equal(called, true); assertState(execution, 'accepted', 'done')
  const acceptance = rt.state.tasks[execution.taskId].acceptances[0]
  assert.equal(acceptance.cardId, item.id); assert.equal(acceptance.reason, 'Checked the result')
  assert.deepEqual(acceptance.executionIds, [execution.id]); assert.equal(acceptance.answer.action, 'accept')
  assert.deepEqual(acceptance.basis, [`evidence:${execution.id}`])
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).tasks[execution.taskId]
  assert.equal(saved.flow.status, 'accepted'); assert.equal(saved.status, 'done')
  assert.equal(Object.keys(rt.state.triggers).length, 0)
  await assert.rejects(answer(item, 'accept'), /已作答/)
  assert.equal((await host.api('card-list', { profile: lead.id, session: owner.id }))[0].status, 'accepted')
}))

test('review fail requires continue, reworks with the original holder and directory, then R4 forces review', () => withFlow(async ({ rt, worker, reviewer, team, create, finish, review, card, assertState }) => {
  const implement = await create({ worktree: true })
  await finish(implement, reportOf({ reviewFlags: undefined }))
  const audit = await review(implement)
  assertState(implement, 'reviewing', 'review'); assert.equal(audit.stage, 'review'); assert.equal(audit.profileId, reviewer.id)
  assert.equal(audit.workspaceRef, implement.workspaceRef); assert.equal(audit.triggerId, implement.triggerId)
  assert.deepEqual(audit.scope, implement.scope)
  await finish(audit, reportOf({ verdict: 'fail', findings: [{ category: 'security', severity: 'high', text: 'Missing ownership check' }] }))
  assertState(audit, 'reviewing', 'review'); assert.equal(card(audit.taskId), undefined)
  await rt.updateTeams([{ ...team, assign: { ...team.assign, feature: { normal: { profile: reviewer.id } } } }])
  const rework = await review(audit)
  assertState(rework, 'running', 'open'); assert.equal(rework.stage, 'rework'); assert.equal(rework.profileId, worker.id)
  assert.equal(rework.type, implement.type); assert.equal(rework.workspaceRef, implement.workspaceRef)
  assert.equal(rework.sourceExecutionId, audit.id); assert.equal(rt.state.tasks[rework.taskId].flow.rework, 1)
  await finish(rework)
  const secondAudit = await review(rework)
  assert.equal(secondAudit.stage, 'review'); assert.equal(secondAudit.workspaceRef, implement.workspaceRef)
  await finish(secondAudit, reportOf({ verdict: 'pass' })); await review(secondAudit)
  assertState(implement, 'accepting', 'blocked')
  assert.deepEqual(card(implement.taskId).payload.missedFlags, ['security'])
  assert.equal(card(implement.taskId).payload.missedFlagsCount, 1)
  assert.equal(card(implement.taskId).question.recommendation, 'accept')
}, true))

for (const missing of ['type', 'independent', 'holder']) test(`unavailable review ${missing} stalls and retries after assignment is fixed`, () => withFlow(async ({ rt, team, create, finish, review, card, answer, assertState }) => {
  await rt.updateTeams([{ ...team, ...(missing === 'type' ? { types: team.types.slice(0, 1), assign: { feature: team.assign.feature } }
    : missing === 'independent' ? { types: team.types.map(type => ({ ...type, independent: false })) }
      : { assign: { feature: team.assign.feature } }) }])
  const execution = await create(); await finish(execution, reportOf({ verified: [] })); await review(execution)
  assertState(execution, 'stalled', 'blocked'); assert.equal(card(execution.taskId).payload.reason, 'review-unavailable')
  await rt.updateTeams([team]); await answer(card(execution.taskId), 'retry')
  const next = Object.values(rt.state.executions).at(-1)
  assert.equal(next.stage, 'review'); assertState(next, 'reviewing', 'review')
  await finish(next, reportOf({ verdict: 'pass' })); await review(next)
  assertState(next, 'accepting', 'blocked')
}))

for (const final of ['结论:通过', '# 结论：通过', '* - ** 结论:不通过', '  **结论：不通过', '正文\n结论：通过']) test(`fallback review first line drives flow: ${JSON.stringify(final)}`, () => withFlow(async ({ rt, create, finish, review, card, assertState }) => {
  const execution = await create(); await finish(execution, null)
  const audit = await review(execution); await finish(audit, null, final); await review(audit)
  if (final.startsWith('正文')) {
    assertState(audit, 'stalled', 'blocked'); assert.equal(card(audit.taskId).payload.reason, 'verdict-unreadable')
  } else if (final.includes('不通过')) {
    assertState(audit, 'running', 'open'); assert.equal(Object.values(rt.state.executions).at(-1).stage, 'rework')
  } else assertState(audit, 'accepting', 'blocked')
}))

test('investigate and answer completion preserve the phase; only answer continue advances it', () => withFlow(async ({ rt, owner, create, finish, review, card, assertState }) => {
  const execution = await create(); await finish(execution)
  const receipt = await rt.leadReview(owner.id, { executionId: execution.id, disposition: 'investigate', reason: 'Need evidence', basis: ['Report'], questions: ['Which check ran?'] })
  const answer = rt.state.executions[receipt.executionId]
  assert.equal(answer.triggerId, execution.triggerId); assert.equal(answer.workspaceRef, execution.workspaceRef)
  assertState(execution, 'running', 'open'); assert.equal(card(execution.taskId), undefined)
  await finish(answer, reportOf({ answers: [{ n: 1, text: 'fixture check' }] }))
  assertState(execution, 'running', 'open'); assert.equal(card(execution.taskId), undefined)
  await review(answer); assertState(answer, 'accepting', 'blocked')
  assert.equal(execution.reports[0].review.answeredBy, answer.id)
}))

for (const stage of ['implement', 'review']) for (const failure of ['blocked', 'failed', 'unconfirmed']) test(`${stage} ${failure} stalls only its task`, () => withFlow(async ({ rt, create, finish, review, card, assertState }) => {
  let execution = await create()
  if (stage === 'review') { await finish(execution, reportOf({ verified: [] })); execution = await review(execution) }
  if (failure === 'unconfirmed') await rt.unconfirmExecution(execution.id, { reason: 'restart' })
  else {
    await finish(execution, reportOf({ outcome: failure, ...(stage === 'review' ? { verdict: 'pass' } : {}) }), 'Incomplete', failure === 'failed' ? 'error' : 'done')
    await review(execution)
  }
  assertState(execution, 'stalled', 'blocked'); assert.equal(card(execution.taskId).payload.reason, 'execution-failed')
}))

test('program cancellation stalls; explicit user and leader stops resolve cards and end flow', () => withFlow(async ({ rt, owner, create, card, assertState }) => {
  const execution = await create(); await rt.cancelUnsentExecution(execution.id, { reason: 'restart-unsent' })
  assertState(execution, 'stalled', 'blocked'); assert.equal(card(execution.taskId).payload.reason, 'execution-failed')
  await rt.leadRoute(owner.id, { action: 'stop', taskIds: [execution.taskId] })
  assertState(execution, 'stopped', 'stopped'); assert.equal(card(execution.taskId), undefined)
  const second = await create(); await rt.leadRoute(owner.id, { action: 'stop', executionIds: [second.id] })
  assertState(second, 'stopped', 'stopped')
}))

test('review rework limit is a count stall without retry', () => withFlow(async ({ rt, team, create, finish, review, card, answer, assertState }) => {
  await rt.updateTeams([{ ...team, types: team.types.map(type => type.id === 'feature' ? { ...type, flow: { reviewType: 'review', maxRework: 0 } } : type) }])
  const execution = await create(); await finish(execution, reportOf({ verified: [] }))
  const audit = await review(execution); await finish(audit, reportOf({ verdict: 'fail', findings: [{ category: 'other', severity: 'low', text: 'Fix' }] })); await review(audit)
  assertState(audit, 'stalled', 'blocked'); const item = card(audit.taskId)
  assert.equal(item.payload.reason, 'rework-limit'); assert.equal(item.payload.retryAction, null)
  assert.deepEqual(item.question.options, ['stop', 'change-scope']); await assert.rejects(answer(item, 'retry'), /不支持/)
}))

test('hard execution cap and same-stage round cap stall before creating another execution', () => withFlow(async ({ rt, owner, create, finish, review, card, answer }) => {
  const execution = await create(); await finish(execution); await review(execution)
  for (let index = 1; index < 8; index++) rt.state.executions[`old-${index}`] = { ...execution, id: `old-${index}`, stage: index % 2 ? 'rework' : 'review' }
  assert.equal(rt.checkFlowCapacity(rt.state.tasks[execution.taskId], 'answer', execution), false)
  assert.equal(card(execution.taskId).payload.reason, 'hard-cap'); assert.equal(card(execution.taskId).payload.retryAction, null)
  for (let index = 1; index < 8; index++) delete rt.state.executions[`old-${index}`]
  await answer(card(execution.taskId), 'stop')
  const second = await create(); await finish(second)
  let latest = second
  for (let index = 0; index < 2; index++) {
    const receipt = await rt.leadReview(owner.id, { executionId: latest.id, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] })
    latest = rt.state.executions[receipt.executionId]; await finish(latest, reportOf({ answers: [{ n: 1, text: 'Evidence' }] }))
  }
  await rt.leadReview(owner.id, { executionId: latest.id, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] })
  assert.equal(card(second.taskId).payload.reason, 'stage-rounds'); assert.equal(card(second.taskId).payload.retryAction, null)
  assert.equal(Object.values(rt.state.executions).filter(item => item.taskId === second.taskId).length, 3)
}))

test('delivery failure three and lead error each stall a report only once; retry preserves counts', () => withFlow(async ({ rt, owner, create, finish, card, answer, assertState }) => {
  const execution = await create(); await finish(execution)
  const report = execution.reports[0]
  for (let index = 0; index < 2; index++) { await rt.flowReportDeliveryFailed(execution, report); assert.equal(card(execution.taskId), undefined) }
  await rt.flowReportDeliveryFailed(execution, report)
  const item = card(execution.taskId); assert.equal(item.payload.reason, 'delivery-failed')
  await rt.flowReportDeliveryFailed(execution, report); assert.equal(card(execution.taskId).id, item.id)
  await answer(item, 'retry'); assert.equal(report.deliveryFailures, 4)
  assertState(execution, 'running', 'open')
  await until(() => !rt.workView()[owner.id]?.active)
  const fresh = execution.reports.at(-1)
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'error' }) })
  assert.equal(card(execution.taskId).payload.reason, 'lead-error')
  const leadCard = card(execution.taskId)
  await rt.flowLeadFailed(owner.id); assert.equal(card(execution.taskId).id, leadCard.id); assert.equal(fresh.flowStalled, true)
}))

test('accept-blocked lists invariant gaps, remains blocked, and retries completeTask after child acceptance', () => withFlow(async ({ rt, create, finish, review, card, answer, assertState }) => {
  const parent = await create(); await finish(parent); await review(parent)
  const child = await create({ parentId: parent.taskId }); await finish(child); await review(child)
  const acceptance = card(parent.taskId); await answer(acceptance, 'accept')
  assertState(parent, 'stalled', 'blocked')
  const stall = card(parent.taskId)
  assert.equal(stall.payload.reason, 'accept-blocked'); assert.match(stall.payload.gaps[0], /子任务未验收/)
  assert.equal(acceptance.status, 'resolved')
  await answer(card(child.taskId), 'accept'); await answer(stall, 'retry', 'Verified child and parent')
  assertState(parent, 'accepted', 'done')
  assert.equal(rt.state.tasks[parent.taskId].acceptances[0].cardId, stall.id)
}))

test('return bypasses leader, uses verbatim trigger and original implementation holder, and rejects only its card', () => withFlow(async ({ rt, worker, team, reviewer, create, finish, review, card, answer, assertState }) => {
  const execution = await create(); await finish(execution); await review(execution)
  const item = card(execution.taskId)
  await rt.updateTeams([{ ...team, assign: { ...team.assign, feature: { normal: { profile: reviewer.id } } } }])
  await answer(item, 'return', 'Return verbatim: preserve  spacing')
  const rework = Object.values(rt.state.executions).at(-1)
  assertState(rework, 'running', 'open'); assert.equal(item.status, 'rejected')
  assert.equal(rework.profileId, worker.id); assert.equal(rework.workspaceRef, execution.workspaceRef)
  const trigger = rt.state.triggers[rework.triggerId]
  assert.equal(trigger.text, 'Return verbatim: preserve  spacing'); assert.equal(trigger.cardId, item.id); assert.equal(trigger.handle, undefined)
  await until(() => rt.driverOf(rework.sessionId).calls.at(-1)?.includes('Return verbatim: preserve  spacing'))
  await finish(rework); await review(rework); assertState(rework, 'accepting', 'blocked')
}))

test('A3 supplements override pass on continue; A4/A5 reworks do not consume the review rework counter', () => withFlow(async ({ rt, owner, trigger, create, finish, review, start, card, assertState }) => {
  const execution = await create(); await finish(execution, reportOf({ verified: [] })); const audit = await review(execution)
  await start(audit)
  const first = trigger('Supplement one'), last = trigger('Supplement last')
  for (const supplement of [first, last]) {
    rt.setPendingTrigger(supplement)
    const receipt = await rt.leadRoute(owner.id, { action: 'attach', taskId: audit.taskId, scope: { quote: 'Supplement' } })
    assert.equal(receipt.delivery.mode, 'queued')
  }
  assert.equal(rt.driverOf(audit.sessionId).guides.length, 0)
  await finish(audit, reportOf({ verdict: 'pass' })); const rework = await review(audit)
  assert.equal(rework.stage, 'rework'); assert.equal(rework.triggerId, last.id); assert.deepEqual(rework.supplements, [first.id])
  assert.equal(rt.state.tasks[rework.taskId].flow.supplementReworks, 1); assert.equal(rt.state.tasks[rework.taskId].flow.rework, undefined)
  await finish(rework); await review(rework); assertState(rework, 'accepting', 'blocked')
  const acceptance = card(rework.taskId)
  trigger('Supplement after acceptance')
  const receipt = await rt.leadRoute(owner.id, { action: 'attach', taskId: rework.taskId, scope: { quote: 'Supplement' } })
  assert.equal(receipt.delivery.mode, 'withdrew-card'); assert.equal(acceptance.status, 'resolved'); assert.equal(acceptance.answer, 'supplement')
  assert.equal(rt.state.tasks[rework.taskId].flow.supplementReworks, 2); assert.equal(rt.state.tasks[rework.taskId].flow.rework, undefined)
}))

test('direct worker input is a task supplement and acceptance return with a worker message handle', () => withFlow(async ({ host, rt, worker, owner, create, finish, review, card, assertState }) => {
  const execution = await create(); await finish(execution); await review(execution)
  const acceptance = card(execution.taskId)
  await host.api('send', { profile: worker.id, session: execution.sessionId, text: 'Direct user supplement' })
  const rework = Object.values(rt.state.executions).at(-1)
  assert.notEqual(rework.id, execution.id); assert.equal(rework.stage, 'rework'); assert.equal(acceptance.status, 'resolved')
  assertState(rework, 'running', 'open')
  const trigger = rt.state.triggers[rework.triggerId]
  assert.equal(trigger.coordinatorSessionId, owner.id); assert.equal(trigger.text, 'Direct user supplement')
  assert.match(trigger.handle, new RegExp(execution.sessionId))
  await until(() => rt.driverOf(rework.sessionId).calls.at(-1)?.includes('Direct user supplement'))
}))

test('card host APIs enforce coordinator ownership for reads and every answer action', () => withFlow(async ({ host, rt, lead, owner, other, create, finish, review, card }) => {
  const execution = await create(); await finish(execution); await review(execution)
  const item = card(execution.taskId), saved = structuredClone(item)
  for (const endpoint of ['card-get', 'card-answer']) for (const action of ['accept', 'return', 'retry', 'stop', 'change-scope']) {
    await assert.rejects(host.api(endpoint, { profile: lead.id, session: other.id, cardId: item.id, action, reason: 'Foreign answer' }), /不属于/)
  }
  assert.deepEqual(item, saved); assert.deepEqual(await host.api('card-list', { profile: lead.id, session: other.id }), [])
  assert.deepEqual(await host.api('card-get', { profile: lead.id, session: owner.id, cardId: item.id }), item)
  assert.match(rt.leadSnapshot(owner.id), new RegExp(item.id))
}))

test('two tasks keep independent cards across restart and recovery recreates a missing card', () => withFlow(async ({ host, rt, lead, owner, create, finish, review, card, answer }) => {
  const first = await create(); await finish(first); await review(first)
  const second = await create(); await finish(second); await review(second)
  assert.equal(rt.leadCards(owner.id).length, 2); assert.equal(rt.sessionBlockReason(owner.id), undefined)
  const firstCard = card(first.taskId), secondCard = card(second.taskId)
  await answer(firstCard, 'accept'); assert.equal(secondCard.status, 'open')
  await rt.saveStrict(); await host.dispose()
  const reopened = boot(host.home)
  try {
    const restored = await reopened.runtime
    const list = await reopened.api('card-list', { profile: lead.id, session: owner.id })
    assert.equal(list.find(item => item.id === firstCard.id).status, 'accepted')
    assert.deepEqual(list.find(item => item.id === secondCard.id).payload, secondCard.payload)
    delete restored.state.cards[secondCard.id]; restored.recoverFlowCards()
    const rebuilt = restored.leadCards(owner.id)
    assert.equal(rebuilt.length, 1); assert.equal(rebuilt[0].taskId, second.taskId)
    await restored.saveStrict()
  } finally { await reopened.dispose() }
}))

test('custom review type permits exactly two review-driven reworks before rework-limit', () => withFlow(async ({ rt, team, create, finish, review, card }) => {
  await rt.updateTeams([{ ...team, types: [
    { ...team.types[0], flow: { reviewType: 'audit', maxRework: 2 } }, { ...team.types[1], id: 'audit' }],
    assign: { feature: team.assign.feature, audit: team.assign.review } }])
  let execution = await create()
  for (let round = 0; round < 3; round++) {
    await finish(execution, reportOf({ verified: round === 0 ? [] : [{ result: 'pass' }] }))
    const audit = await review(execution)
    assert.equal(audit.type, 'audit')
    await finish(audit, reportOf({ verdict: 'fail', findings: [{ category: 'other', severity: 'low', text: 'Fix only this' }] }))
    execution = await review(audit)
  }
  assert.equal(card(execution.taskId).payload.reason, 'rework-limit')
  assert.equal(rt.state.tasks[execution.taskId].flow.rework, 2)
  assert.equal(Object.values(rt.state.executions).length, 6)
}))

for (const stage of ['implement', 'review', 'answer']) test(`execution-failed retry restarts ${stage} with its source and directory`, () => withFlow(async ({ rt, owner, create, finish, review, card, answer, assertState }) => {
  let execution = await create()
  if (stage === 'review') { await finish(execution, reportOf({ verified: [] })); execution = await review(execution) }
  else if (stage === 'answer') {
    await finish(execution)
    const receipt = await rt.leadReview(owner.id, { executionId: execution.id, disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] })
    execution = rt.state.executions[receipt.executionId]
  }
  await rt.unconfirmExecution(execution.id, { reason: 'restart' })
  const stall = card(execution.taskId)
  await answer(stall, 'retry')
  const retry = Object.values(rt.state.executions).at(-1)
  assert.equal(stall.answer.action, 'retry')
  assert.equal(execution.status, 'interrupted'); assert.equal(retry.stage, stage)
  assert.equal(retry.profileId, execution.profileId); assert.equal(retry.workspaceRef, execution.workspaceRef)
  assert.equal(retry.triggerId, execution.triggerId); assert.deepEqual(retry.scope, execution.scope)
  if (stage === 'review' || stage === 'answer') assert.equal(retry.sourceExecutionId, execution.sourceExecutionId)
  if (stage === 'answer') assert.deepEqual(retry.questions, execution.questions)
  assertState(retry, stage === 'review' ? 'reviewing' : 'running', stage === 'review' ? 'review' : 'open')
}))

test('verdict-unreadable retry reviews the implementation again and can pass acceptance', () => withFlow(async ({ rt, create, finish, review, card, answer, assertState }) => {
  const execution = await create(); await finish(execution, reportOf({ verified: [] }))
  const audit = await review(execution); await finish(audit, null, 'Cannot parse verdict'); await review(audit)
  await answer(card(execution.taskId), 'retry')
  const retry = Object.values(rt.state.executions).at(-1)
  assert.equal(retry.sourceExecutionId, execution.id)
  await finish(retry, reportOf({ verdict: 'pass' })); await review(retry)
  assertState(retry, 'accepting', 'blocked'); assert.equal(card(retry.taskId).question.recommendation, 'accept')
}))

test('four supplement reworks bypass maxRework and stage-rounds without resetting total executions', () => withFlow(async ({ rt, owner, trigger, team, create, finish, review, card }) => {
  await rt.updateTeams([{ ...team, types: team.types.map(type => type.id === 'feature' ? { ...type, flow: { reviewType: 'review', maxRework: 0 } } : type) }])
  let execution = await create(); await finish(execution); await review(execution)
  for (let count = 1; count <= 4; count++) {
    trigger(`Supplement ${count}`)
    const receipt = await rt.leadRoute(owner.id, { action: 'attach', taskId: execution.taskId, scope: { quote: 'Supplement' } })
    execution = rt.state.executions[receipt.executionId]
    await finish(execution); await review(execution)
    assert.equal(card(execution.taskId).kind, 'acceptance')
    assert.equal(rt.state.tasks[execution.taskId].flow.supplementReworks, count)
  }
  assert.equal(Object.values(rt.state.executions).length, 5)
  assert.equal(rt.state.tasks[execution.taskId].flow.rework, undefined)
}))

test('direct worker supplements merge while queued and wait for continue while reviewing', () => withFlow(async ({ host, rt, worker, reviewer, create, start, finish, review }) => {
  const execution = await create()
  await host.api('send', { profile: worker.id, session: execution.sessionId, text: 'Queued direct supplement' })
  assert.equal(rt.driverOf(execution.sessionId), undefined)
  assert.equal(execution.supplements.length, 1)
  await finish(execution, reportOf({ verified: [] }))
  assert.match(rt.driverOf(execution.sessionId).calls[0], /Queued direct supplement/)
  const audit = await review(execution); await start(audit)
  await host.api('send', { profile: reviewer.id, session: audit.sessionId, text: 'Review supplement' })
  assert.equal(rt.driverOf(audit.sessionId).guides.length, 0)
  assert.equal(rt.workView()[audit.sessionId].queued, 0)
  await finish(audit, reportOf({ verdict: 'pass' })); const rework = await review(audit)
  assert.equal(rework.stage, 'rework'); assert.equal(rt.state.triggers[rework.triggerId].text, 'Review supplement')
}))

test('stalled and stopped worker direct input is rejected without writing or starting new work', () => withFlow(async ({ host, rt, worker, owner, create, card, answer }) => {
  const execution = await create(); await rt.cancelUnsentExecution(execution.id, { reason: 'restart' })
  const count = Object.keys(rt.state.executions).length, before = rt.transcriptOf(execution.sessionId).length
  await assert.rejects(host.api('send', { profile: worker.id, session: execution.sessionId, text: 'Bypass retry card' }), { code: 'orch/task-stalled' })
  await answer(card(execution.taskId), 'stop')
  await assert.rejects(host.api('send', { profile: worker.id, session: execution.sessionId, text: 'Bypass stop' }), { code: 'orch/frozen' })
  assert.equal(rt.transcriptOf(execution.sessionId).length, before)
  assert.equal(Object.keys(rt.state.executions).length, count)
  assert.equal(rt.sessionBlockReason(owner.id), undefined)
}))

test('change-scope stays an unimplemented contract and leaves the card and task intact', () => withFlow(async ({ rt, create, card, answer }) => {
  const execution = await create(); await rt.cancelUnsentExecution(execution.id, { reason: 'restart' })
  const item = card(execution.taskId), before = structuredClone(item)
  await assert.rejects(answer(item, 'change-scope', 'Different scope'), { code: 'orch/not-supported' })
  assert.deepEqual(item, before); assert.equal(rt.state.tasks[execution.taskId].flow.status, 'stalled')
}))
