import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/approvals.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const harness = answerRequest => {
  const rearmed = []
  const rt = { conversationOf: () => ({ profile: { name: 'Rho' } }), answerRequest, rearmIdle: id => rearmed.push(id) }
  install(rt)
  return { rt, rearmed }
}

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

test('workflow questions retain their existing exit and note payload without using the engine reply path', async () => {
  const requests = []
  const { rt } = harness(() => { throw new Error('workflow decisions must not answer an engine request') })
  rt.answerRunRequest = async (id, value) => { requests.push({ id, value }); return true }
  rt.holdQuestion({ id: 'gate', name: 'Review', question: 'Continue?', detail: { exits: [] } })
  await rt.answerApproval('gate', { decision: 'answer', exit: 'continue', value: 'keep this note' })
  assert.deepEqual(requests, [{ id: 'gate', value: { exit: 'continue', text: 'keep this note' } }])
})
