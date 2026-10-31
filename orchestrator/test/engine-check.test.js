// The engine-check route resolves the probed working directory itself: the
// settings page checks engines with no workspace open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { withHost } from './helpers/host.js'
import { echoEntry, echoInfo } from './helpers/echo-driver.js'
import { registerEngine } from '../agent-drivers/dist/index.js'

registerEngine('cwdspy', { ...echoEntry, info: { ...echoInfo, id: 'cwdspy', label: 'CwdSpy (test)' },
  check: ({ cwd }) => ({ engine: 'cwdspy', ok: cwd !== undefined, checks: [{ label: 'Working directory', ok: cwd !== undefined, message: String(cwd) }] }) })

test('engine check probes the requested, first or home directory in that order', async () => {
  await withHost(async ({ api, home }) => {
    assert.equal((await api('engine-check', { engine: 'cwdspy' })).checks[0].message, home)
    const workspace = await api('workspace-create', { name: 'Site', cwd: join(home, 'site') })
    assert.equal((await api('engine-check', { engine: 'cwdspy' })).checks[0].message, join(home, 'site'), 'the first workspace is probed when the page has none open')
    assert.equal((await api('engine-check', { engine: 'cwdspy', cwd: join(home, 'other') })).checks[0].message, join(home, 'other'), 'an explicitly passed directory wins')
    await api('workspace-delete', { id: workspace.id })
  })
})
