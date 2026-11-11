import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withFlow, reportOf } from './helpers/flow.js'
import { until } from './helpers/host.js'

test('M5a regression 1: a busy dispatch leaves the execution for the next schedule pass', () => withFlow(async ({ rt, owner, create, start, review, assertState }) => {
  const execution = await create(); await start(execution)
  const dispatch = rt.dispatchFlowExecution
  let first = true
  rt.dispatchFlowExecution = async (...args) => {
    if (first) { first = false; throw Object.assign(new Error('Busy fixture'), { code: 'orch/busy' }) }
    return dispatch(...args)
  }
  await rt.workerReport(execution, reportOf({ verified: [] }))
  rt.driverOf(execution.sessionId).finish()
  await until(() => !first && execution.endedAt != null)
  await rt.scheduleFlow(owner.id)
  const audit = await review(execution)
  assert.equal(audit.stage, 'review'); assertState(audit, 'reviewing', 'review')
  assert.equal(execution.flowContinued, true)
}))

for (const active of ['queued', 'running']) test(`M5a regression 2: a schedule pass cannot advance an old execution past a newer ${active} rework`, () => withFlow(async ({ rt, owner, create, finish, start, trigger, card, assertState }) => {
  const execution = await create(); await finish(execution)
  trigger('Supplement after completion')
  const receipt = await rt.leadRoute(owner.id, { action: 'attach', taskId: execution.taskId, scope: { quote: 'Supplement' } })
  const rework = rt.state.executions[receipt.executionId]
  if (active === 'running') await start(rework)
  await rt.scheduleFlow(owner.id)
  assert.equal(card(execution.taskId), undefined)
  assertState(rework, 'running', 'open'); assert.equal(rework.status, active)
}))

test('M5a regression 4: a failed rework retry retains R4 independent review', () => withFlow(async ({ rt, create, finish, review, card, answer }) => {
  const execution = await create(); await finish(execution, reportOf({ verified: [] }))
  const audit = await review(execution)
  await finish(audit, reportOf({ verdict: 'fail', findings: [{ category: 'other', severity: 'high', text: 'Fix the bug' }] }))
  const rework = await review(audit)
  await finish(rework, reportOf({ outcome: 'failed' }), 'Failed rework', 'error')
  await answer(card(execution.taskId), 'retry')
  const retry = Object.values(rt.state.executions).at(-1)
  await finish(retry)
  const next = await review(retry)
  assert.equal(next.stage, 'review'); assert.equal(next.sourceExecutionId, retry.id)
}))

for (const code of ['orch/busy', 'orch/no-holder']) test(`M5a regression 5: acceptance return ${code} leaves its card open and no trigger`, () => withFlow(async ({ rt, create, finish, review, card, answer, assertState }) => {
  const execution = await create(); await finish(execution); await review(execution)
  const item = card(execution.taskId), before = structuredClone(item), triggers = structuredClone(rt.state.triggers)
  const dispatch = rt.dispatchFlowExecution
  rt.dispatchFlowExecution = async () => { throw Object.assign(new Error('Return dispatch failed'), { code }) }
  await assert.rejects(answer(item, 'return', 'Return verbatim'), { code })
  assert.deepEqual(item, before); assert.deepEqual(rt.state.triggers, triggers)
  assertState(execution, 'done', 'review')
  rt.dispatchFlowExecution = dispatch
  await answer(item, 'return', 'Return verbatim')
  assert.equal(item.status, 'rejected')
  const rework = Object.values(rt.state.executions).at(-1)
  assert.equal(rework.stage, 'rework'); assert.equal(rt.state.triggers[rework.triggerId].text, 'Return verbatim')
}))

test('M5a regression 6: review fail with supplement carries findings and review-fail stage wording', () => withFlow(async ({ rt, owner, create, finish, review, start, trigger }) => {
  const execution = await create(); await finish(execution, reportOf({ verified: [] }))
  const audit = await review(execution); await start(audit)
  const supplement = trigger('Supplement to review failure')
  await rt.leadRoute(owner.id, { action: 'attach', taskId: execution.taskId, scope: { quote: 'Supplement' } })
  await finish(audit, reportOf({ verdict: 'fail', findings: [{ category: 'security', severity: 'high', text: 'Check card ownership' }] }))
  const rework = await review(audit)
  assert.equal(rework.triggerId, supplement.id); assert.equal(rework.sourceExecutionId, audit.id)
  const input = await rt.composeWorkerInput({ executionId: rework.id })
  assert.match(input.text, /# 前序结论[\s\S]*Check card ownership/)
  assert.match(input.text, /返工第 1 次（上限 2）/)
  assert.equal(rt.state.tasks[rework.taskId].flow.rework, undefined)
}))

for (const stage of ['implement', 'review']) test(`M5a regression 7: ${stage} verification fail never recommends acceptance`, () => withFlow(async ({ create, finish, review, card }) => {
  const execution = await create()
  await finish(execution, reportOf({ verified: [{ result: stage === 'implement' ? 'fail' : 'pass' }], reviewFlags: undefined }))
  const audit = await review(execution)
  await finish(audit, reportOf({ verdict: 'pass', verified: [{ result: stage === 'review' ? 'fail' : 'pass' }] }))
  await review(audit)
  const item = card(execution.taskId)
  assert.equal(item.kind, 'acceptance'); assert.equal(item.payload.recommendAccept, false)
  assert.equal(item.question.recommendation, undefined)
}))

test('M5a coverage 8: the real eighth completed execution transitions to hard-cap', () => withFlow(async ({ rt, owner, create, finish, review, trigger, card }) => {
  let execution = await create()
  for (let count = 1; count <= 8; count++) {
    await finish(execution); await review(execution)
    if (count < 8) {
      trigger(`Supplement ${count}`)
      const receipt = await rt.leadRoute(owner.id, { action: 'attach', taskId: execution.taskId, scope: { quote: 'Supplement' } })
      execution = rt.state.executions[receipt.executionId]
    }
  }
  assert.equal(Object.values(rt.state.executions).length, 8)
  assert.equal(card(execution.taskId).payload.reason, 'hard-cap')
  assert.deepEqual(card(execution.taskId).question.options, ['stop'])
}))

for (const reason of ['interrupted', 'error']) test(`M5a minor 1: a leader turn ending ${reason} leaves flow tasks as they are`, () => withFlow(async ({ rt, owner, create, finish, card, assertState }) => {
  const execution = await create(); await finish(execution)
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason }) })
  assertState(execution, 'done', 'review'); assert.equal(card(execution.taskId).kind, 'acceptance')
}))

test('M5a minor 2: direct worker input while awaiting acceptance is stored as supplement origin', () => withFlow(async ({ host, rt, worker, create, finish, review }) => {
  const execution = await create(); await finish(execution); await review(execution)
  await host.api('send', { profile: worker.id, session: execution.sessionId, text: 'Direct accepting supplement' })
  const line = rt.transcriptOf(execution.sessionId).find(item => item.text === 'Direct accepting supplement')
  assert.equal(line.origin?.kind, 'supplement')
}))
