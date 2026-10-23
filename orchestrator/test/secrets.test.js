import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { createEchoDriver, echoInfo, validateEchoOptions, checkEcho } from './helpers/echo-driver.js'
import { boot, until, withHost } from './helpers/host.js'

const OLD = 'fake-old-value-AAAA1111', NEW = 'fake-new-value-BBBB2222'

test('a rotated key reaches a rebuilt driver, and both values stay redacted', async () => {
  await withHost(async ({ api, runtime, home }) => {
    const envs = []
    registerEngine('echo', { create: options => { envs.push(options.env?.ORCH_SECRET_FIXTURE_KEY); return createEchoDriver(options) }, info: echoInfo, validate: validateEchoOptions, check: checkEcho })
    await api('secret-set', { name: 'FIXTURE_KEY', value: OLD })
    const workspace = await api('workspace-create', { name: 'Keys', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Fixture', engine: 'echo', workspace: workspace.id })
    const turn = async text => {
      await api('send', { profile: profile.id, text })
      await until(async () => (await api('state', { since: -1 })).work[profile.id]?.active === false)
    }
    await turn(`one ${OLD}`)
    await api('secret-set', { name: 'FIXTURE_KEY', value: NEW })
    await turn('two')
    assert.deepEqual(envs, [OLD, NEW])
    const rt = await runtime
    assert.equal(rt.redactSecrets(`${OLD} ${NEW}`), '[secret:FIXTURE_KEY] [secret:FIXTURE_KEY]')
    assert.doesNotMatch(JSON.stringify((await api('state', { since: -1 })).profiles), /fake-/)
    assert.doesNotMatch(readFileSync(join(home, 'state.json'), 'utf8'), /fake-/)
  })
})

test('an unreadable secrets file is left untouched instead of being replaced', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-secrets-'))
  const file = join(home, 'secrets.json')
  const broken = '{"version":1,"secrets":[{"name":"FIXTURE_A","value":"fake-value-aaaa","scope":"all"}'
  writeFileSync(file, broken, { mode: 0o600 })
  const host = boot(home)
  try {
    await assert.rejects(host.api('secret-set', { name: 'FIXTURE_B', value: 'fake-value-bbbb' }), /could not be read/)
    assert.equal(readFileSync(file, 'utf8'), broken)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})
