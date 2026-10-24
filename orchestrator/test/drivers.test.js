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
