import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withHost } from './helpers/host.js'
import presets from '../core/shared/role-presets.json' with { type: 'json' }

test('a new installation creates no roles, before or after onboarding', async () => {
  await withHost(async ({ api, home }) => {
    assert.deepEqual((await api('state')).profiles, [])
    await api('engine-enable-set', { engines: ['echo'] })
    assert.deepEqual((await api('state')).profiles, [])
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles, {})
  })
})

test('the role dialog offers three identity presets with duties, limits and deliverables', () => {
  assert.deepEqual(presets.map(item => item.name), ['decider', 'coder', 'reviewer'])
  for (const preset of presets) {
    assert.deepEqual(Object.keys(preset), ['name', 'role', 'instructions'], 'a preset carries identity only, never an engine')
    assert.match(preset.instructions, new RegExp(`你是 ${preset.name}`))
    for (const section of [/职责：/, /边界：/, /交付：/]) assert.match(preset.instructions, section)
  }
})
