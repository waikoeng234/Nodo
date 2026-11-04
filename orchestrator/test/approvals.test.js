import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/approvals.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const harness = answerRequest => {
  const rearmed = []
  const rt = { state: { executions: {}, tasks: {} }, conversationOf: () => ({ profile: { name: 'Rho' } }), answerRequest, rearmIdle: id => rearmed.push(id) }
  install(rt)
  return { rt, rearmed }
}

test('only an accepted ExitPlanMode approval returns Claude and CodeBuddy sessions to workspace', async () => {
  for (const engine of ['claude', 'codebuddy', 'codex']) {
    for (const decision of ['allow', 'deny']) {
      const { rt } = harness(async () => true)
      const session = { engine, permission: 'plan' }
      let saves = 0
      rt.conversationOf = () => ({ profile: { name: 'Rho' }, session })
      rt.save = async () => { saves++ }
      rt.openApproval('session', { id: 'exit', tool: 'ExitPlanMode', kind: 'permission' })
      await rt.answerApproval('exit', { decision })
      const approved = decision === 'allow' && engine !== 'codex'
      assert.equal(session.permission, approved ? 'workspace' : 'plan')
      assert.equal(saves, approved ? 1 : 0)
    }
  }
  const { rt } = harness(async () => false)
  const session = { engine: 'claude', permission: 'plan' }
  rt.conversationOf = () => ({ profile: { name: 'Rho' }, session })
  rt.openApproval('session', { id: 'exit', tool: 'ExitPlanMode', kind: 'permission' })
  await assert.rejects(rt.answerApproval('exit', { decision: 'allow' }), /no longer active/)
  assert.equal(session.permission, 'plan')
})

test('a card the engine closes while its answer fails stays closed, and the watchdog resumes', async () => {
  let fail
  const { rt, rearmed } = harness(() => new Promise((_, reject) => { fail = reject }))
  rt.openApproval('profile', { id: 'req', kind: 'permission' })
  assert.equal(rt.awaitingAnswer('profile'), true)
  const answer = rt.answerApproval('req', { decision: 'allow' })
  assert.equal(rt.awaitingAnswer('profile'), false)
  rt.closeApproval('req')
  fail(new Error('transport down'))
  await assert.rejects(answer, /transport down/)
  assert.deepEqual(rt.approvalsView(), [])
  assert.deepEqual(rearmed, ['profile'])
})

test('an undeliverable answer brings the card back while it is still open', async () => {
  const { rt } = harness(async () => { throw new Error('transport down') })
  rt.openApproval('profile', { id: 'req', kind: 'permission' })
  await assert.rejects(rt.answerApproval('req', { decision: 'allow' }), /transport down/)
  assert.equal(rt.awaitingAnswer('profile'), true)
})

test('cancelling a question whose engine is gone settles without an unhandled rejection', async () => {
  const unhandled = []
  const record = error => unhandled.push(error)
  process.on('unhandledRejection', record)
  try {
    const { rt } = harness(async () => false)
    rt.openApproval('profile', { id: 'ask', kind: 'question' })
    rt.cancelApprovals('profile')
    await tick(); await tick()
    assert.deepEqual(unhandled, [])
    assert.deepEqual(rt.approvalsView(), [])
  } finally { process.off('unhandledRejection', record) }
})

test('cards carry the latest execution per session as taskId, and nothing without one', async () => {
  const { rt } = harness(async () => true)
  rt.state.executions = {
    old: { id: 'old', taskId: 't1', sessionId: 'e1', status: 'done' },
    new: { id: 'new', taskId: 't2', sessionId: 'e1', status: 'running' },
  }
  rt.openApproval('e1', { id: 'run', kind: 'permission' })
  rt.openApproval('idle', { id: 'bare', kind: 'permission' })
  assert.deepEqual(rt.approvalsView().map(card => ({ id: card.id, ...(card.taskId ? { taskId: card.taskId } : {}) })), [
    { id: 'run', taskId: 't2' },
    { id: 'bare' },
  ])
})
