import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { withHost, until } from './helpers/host.js'

registerEngine('queue-fixture', {
  info: { id: 'queue-fixture', label: 'Queue fixture', capabilities: { resume: true, steer: true } },
  validate: raw => raw,
  create({ onEvent }) {
    let turn = 0
    const driver = {
      calls: [], guides: [], outcome: 'steered',
      openSession: async () => {}, hasSession: () => true, onEvent() {}, dispose() {},
      async sendTurn(text, images) {
        driver.calls.push({ text, images })
        onEvent({ type: 'turn/start', turnId: `turn-${++turn}` })
      },
      async steer(text) { driver.guides.push(text); return driver.outcome },
      async interruptTurn() { driver.finish() },
      async respondToRequest() { return false },
      finish() { onEvent({ type: 'turn/end', turnId: `turn-${turn}`, reason: 'done', text: 'Done' }) },
    }
    return driver
  },
})

const withQueue = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Queue', cwd: host.home })
  const role = await host.api('profile-create', { name: 'Queue', engine: 'queue-fixture', workspace: workspace.id })
  await host.api('send', { profile: role.id, text: 'First', mode: 'queue' })
  await until(() => rt.driverOf(role.id)?.calls.length === 1)
  const driver = rt.driverOf(role.id)
  const enqueue = (text, extra = {}) => host.api('send', { profile: role.id, session: role.id, text, mode: 'queue', ...extra })
  const action = (seq, action) => host.api('queued-message', { profile: role.id, session: role.id, seq, action })
  const work = async () => (await host.api('state')).work[role.id]
  const lines = () => host.api('transcript', { profile: role.id, session: role.id })
  await run({ host, rt, role, workspace, driver, enqueue, action, work, lines })
})

test('running UI messages queue without steering or entering history, then run in order', () => withQueue(async h => {
  await h.enqueue('Second')
  await h.enqueue('Third')
  assert.deepEqual(h.driver.guides, [])
  assert.deepEqual((await h.work()).pending.map(item => item.text), ['Second', 'Third'])
  assert.deepEqual((await h.lines()).filter(line => line.who === 'user').map(line => line.text), ['First'])
  h.driver.finish()
  await until(() => h.driver.calls.length === 2)
  assert.equal(h.driver.calls[1].text, 'Second')
  assert.deepEqual((await h.work()).pending.map(item => item.text), ['Third'])
  h.driver.finish()
  await until(() => h.driver.calls.length === 3)
  assert.equal(h.driver.calls[2].text, 'Third')
  assert.deepEqual((await h.lines()).filter(line => line.who === 'user').map(line => line.text), ['First', 'Second', 'Third'])
}))

test('edit retrieves queued text and images, deletion cancels delivery, and other sessions cannot access the item', () => withQueue(async h => {
  const images = [{ mediaType: 'image/png', data: 'AQID', name: 'fixture.png' }]
  const edited = await h.enqueue('Edit me', { images })
  const removed = await h.enqueue('Delete me')
  const other = await h.host.api('session-create', { profile: h.role.id, workspace: h.workspace.id, lazy: true })
  await assert.rejects(h.host.api('queued-message', { profile: h.role.id, session: other.id, seq: edited.seq, action: 'delete' }))
  assert.deepEqual(await h.action(edited.seq, 'edit'), { text: 'Edit me', images })
  await h.action(removed.seq, 'delete')
  assert.equal((await h.work()).pending.length, 0)
  await assert.rejects(h.action(removed.seq, 'send'))
  h.driver.finish()
  await until(async () => !(await h.work()).active)
  assert.equal(h.driver.calls.length, 1)
  assert.ok(!(await h.lines()).some(line => ['Edit me', 'Delete me'].includes(line.text)))
}))

test('send now steers only the selected queued message and removes it without a duplicate turn', () => withQueue(async h => {
  await h.enqueue('Later')
  const now = await h.enqueue('Now')
  assert.equal((await h.action(now.seq, 'send')).mode, 'steered')
  assert.deepEqual(h.driver.guides, ['Now'])
  assert.deepEqual((await h.work()).pending.map(item => item.text), ['Later'])
  assert.equal(h.driver.calls.length, 1)
  assert.deepEqual((await h.lines()).filter(line => line.who === 'user').map(line => line.text), ['First', 'Now'])
  h.driver.finish()
  await until(() => h.driver.calls.length === 2)
  assert.equal(h.driver.calls[1].text, 'Later')
}))

test('refused steering stays queued while an indeterminate delivery is never resent', () => withQueue(async h => {
  const refused = await h.enqueue('Refuse')
  h.driver.outcome = 'refused'
  assert.equal((await h.action(refused.seq, 'send')).mode, 'queued')
  assert.equal((await h.work()).pending.length, 1)
  assert.ok(!(await h.lines()).some(line => line.text === 'Refuse'))
  h.driver.outcome = 'indeterminate'
  assert.equal((await h.action(refused.seq, 'send')).mode, 'indeterminate')
  assert.equal((await h.work()).pending.length, 0)
  h.driver.finish()
  await until(async () => !(await h.work()).active)
  assert.equal(h.driver.calls.length, 1)
}))

test('a turn ending during send now cannot drain or resend that message before its receipt', () => withQueue(async h => {
  const queued = await h.enqueue('Race')
  const receipt = Promise.withResolvers()
  h.driver.outcome = receipt.promise
  const sending = h.action(queued.seq, 'send')
  await until(() => h.driver.guides.length === 1)
  await assert.rejects(h.action(queued.seq, 'delete'))
  h.driver.finish()
  await until(async () => !(await h.work()).active)
  assert.equal(h.driver.calls.length, 1)
  receipt.resolve('steered')
  assert.equal((await sending).mode, 'steered')
  assert.equal((await h.work()).pending.length, 0)
  assert.equal(h.driver.calls.length, 1)
  assert.equal((await h.lines()).filter(line => line.text === 'Race').length, 1)
}))

test('interrupt cancels pending input even if a late steering receipt arrives', () => withQueue(async h => {
  const queued = await h.enqueue('Cancelled')
  const receipt = Promise.withResolvers()
  h.driver.outcome = receipt.promise
  const sending = h.action(queued.seq, 'send')
  await until(() => h.driver.guides.length === 1)
  await h.host.api('interrupt', { profile: h.role.id })
  receipt.resolve('refused')
  assert.equal((await sending).mode, 'cancelled')
  assert.equal((await h.work()).pending.length, 0)
  assert.equal(h.driver.calls.length, 1)
  assert.ok(!(await h.lines()).some(line => line.text === 'Cancelled'))
}))
