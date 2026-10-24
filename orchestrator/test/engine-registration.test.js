import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
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

test('the shipped client gets display names from registration and retains the generic fallback', () => {
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const names = JSON.parse(bundle.match(/^const ENGINE_NAMES = (.+)$/m)[1])
  for (const entry of engineMetadata().filter(item => item.id !== 'intake-fixture')) assert.equal(names[entry.id], entry.name)
  const source = readFileSync(new URL('../src/client/engine-logos.js', import.meta.url), 'utf8')
  const displayName = runInNewContext(`${source}\nengineDisplayName`, { ENGINE_NAMES: { 'intake-fixture': 'Intake fixture' } })
  assert.equal(displayName({ id: 'intake-fixture', label: 'Fixture CLI' }), 'Intake fixture')
  assert.equal(displayName({ id: 'unknown', label: 'Unknown CLI' }), 'Unknown')
})
