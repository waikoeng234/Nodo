import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../core/src/drivers.js'

const harness = () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-drivers-'))
  const rt = { home, ctx: { effect() {} }, warn() {}, renderIdentity: () => 'Role identity',
    secretEnv: () => ({}), secretStamp: () => '', saveSessionEvent: async () => {} }
  install(rt)
  return { rt, dispose: () => rmSync(home, { recursive: true, force: true }) }
}
const conversation = extra => ({ id: 'conv-1', engine: 'zcode', cwd: '/tmp/ws', name: 'Coder', sessionName: 'Step', env: [], engineOptions: {}, model: 'p$m', permission: 'workspace', ...extra })

test('external conversations create their own engine driver and ignore stale native pointers', async () => {
  const h = harness()
  try {
    for (const engine of ['codex', 'claude', 'qoder', 'pi', 'zcode', 'opencode', 'codebuddy']) {
      const profile = conversation({ engine, model: undefined, nativeSessionId: 'stale-native' })
      const driver = await h.rt.ensureDriver(profile)
      assert.notEqual(driver.watchdog, false, engine)
      assert.equal(await h.rt.ensureDriver(profile), driver, 'unchanged settings keep the same driver')
      h.rt.releaseDriver(profile.id)
    }
  } finally { h.dispose() }
})

test('a conversation that already holds a direct engine thread keeps its engine driver', async () => {
  const h = harness()
  try {
    const driver = await h.rt.ensureDriver(conversation({ driverSessionId: 'zcode-thread' }))
    assert.equal(driver.instructionMode, 'none', 'a direct engine reports its own channel until it connects')
    driver.dispose()
  } finally { h.dispose() }
})

test('driver bindings are issued once and revoked on replacement and release', async () => {
  const h = harness(), revoked = []
  let issued = 0
  h.rt.issueLeadMcp = async () => { const id = ++issued; return { servers: [], revoke: () => revoked.push(id) } }
  try {
    const profile = conversation({ lead: true })
    await h.rt.ensureDriver(profile)
    await h.rt.ensureDriver(profile)
    assert.equal(issued, 1)
    await h.rt.ensureDriver({ ...profile, model: 'different' })
    assert.deepEqual(revoked, [1])
    h.rt.releaseDriver(profile.id)
    assert.deepEqual(revoked, [1, 2])
    await h.rt.ensureDriver(profile)
    h.rt.releaseDriver(profile.id)
    assert.deepEqual(revoked, [1, 2, 3])
    await assert.rejects(h.rt.ensureDriver({ ...profile, engine: 'missing-engine' }), /Unknown engine/)
    assert.deepEqual(revoked, [1, 2, 3, 4])
  } finally { h.dispose() }
})

test('an idle engine driver is released after two minutes, a busy one is kept', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(), work = {}
  h.rt.workView = () => work
  try {
    const driver = await h.rt.ensureDriver(conversation())
    work['conv-1'] = { active: true, queued: 0 }
    t.mock.timers.tick(120_000)
    assert.equal(h.rt.driverOf('conv-1'), driver, 'a running turn keeps its engine')
    work['conv-1'] = { active: false, queued: 0 }
    t.mock.timers.tick(119_999)
    assert.equal(h.rt.driverOf('conv-1'), driver)
    t.mock.timers.tick(1)
    assert.equal(h.rt.driverOf('conv-1'), undefined)
    assert.notEqual(await h.rt.ensureDriver(conversation()), driver, 'the next turn starts a fresh engine')
    h.rt.releaseDriver('conv-1')
  } finally { h.dispose() }
})
