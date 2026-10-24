import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { loadClient } from './helpers/client-module.js'
import { engineMetadata, registerEngine } from '../agent-drivers/dist/index.js'
import { createEchoDriver, echoInfo, validateEchoOptions, checkEcho } from './helpers/echo-driver.js'

registerEngine('intake-fixture', {
  name: 'Intake fixture', shared: ['acp'],
  info: { ...echoInfo, id: 'intake-fixture', label: 'Fixture CLI' },
  create: createEchoDriver, validate: validateEchoOptions, check: checkEcho,
})

test('one registration supplies display metadata and shared-core membership', () => {
  const entry = engineMetadata().find(item => item.id === 'intake-fixture')
  assert.equal(entry.name, 'Intake fixture')
  entry.shared.push('changed')
  assert.deepEqual(engineMetadata().find(item => item.id === entry.id).shared, ['acp'])
})

test('the shipped client gets display names from registration and retains the generic fallback', async () => {
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const names = JSON.parse(bundle.match(/^var ENGINE_NAMES = (.+);$/m)[1])
  for (const entry of engineMetadata().filter(item => item.id !== 'intake-fixture')) assert.equal(names[entry.id], entry.name)
  const { engineDisplayName } = await loadClient('engine-logos.js')
  assert.equal(engineDisplayName({ id: 'zcode', label: 'ZCode CLI (native)' }), 'ZCode', 'registration names win over driver labels')
  assert.equal(engineDisplayName({ id: 'unknown', label: 'Unknown CLI' }), 'Unknown')
})
