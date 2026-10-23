import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineCheckPlan, runEngineChecks } from '../scripts/verify-engine.mjs'

test('new engine route includes the driver, all capability gates and handoff checks', () => {
  const plan = engineCheckPlan({ engine: 'zcode', route: 'new' })
  assert.ok(plan.tests.includes('test/zcode.test.js'))
  assert.ok(plan.tests.includes('test/zcode-instructions.test.js'))
  assert.ok(plan.tests.includes('test/adapter-input.test.js'))
  assert.ok(plan.tests.includes('test/workflows.test.js'))
  assert.deepEqual(plan.handoff, ['zcode'])
  assert.deepEqual(plan.engines, ['zcode'])
})

test('capability route scopes tests and includes the selected shared protocol', () => {
  const plan = engineCheckPlan({ engine: 'codebuddy', route: 'capability', capability: ['models'] })
  assert.ok(plan.tests.includes('test/codebuddy.test.js'))
  assert.ok(plan.tests.includes('test/acp.test.js'))
  assert.ok(plan.tests.includes('test/model-seat.test.js'))
  assert.ok(!plan.tests.includes('test/attachments.test.js'))
  assert.ok(!plan.tests.includes('test/workflows.test.js'))
  assert.deepEqual(plan.handoff, [])
})

test('changing the ACP core selects every registered consumer', () => {
  const plan = engineCheckPlan({ engine: 'opencode', route: 'capability', capability: ['interaction'], shared: ['acp'] })
  assert.deepEqual(plan.engines.sort(), ['codebuddy', 'dsh', 'opencode'])
  for (const id of plan.engines) assert.ok(plan.tests.includes(`test/${id}.test.js`))
  assert.ok(plan.tests.includes('test/dsh-native.test.js'))
})

test('invalid selections and missing tests fail instead of producing an empty pass', () => {
  for (const options of [
    { engine: 'absent', route: 'new' },
    { engine: 'codex', route: 'other' },
    { engine: 'codex', route: 'capability' },
    { engine: 'codex', route: 'capability', capability: ['typo'] },
    { engine: 'codex', route: 'new', capability: ['models'] },
    { engine: 'codex', route: 'new', shared: ['typo'] },
  ]) assert.throws(() => engineCheckPlan(options))
  const root = mkdtempSync(join(tmpdir(), 'nodo-engine-plan-'))
  try {
    mkdirSync(join(root, 'test'))
    assert.throws(() => engineCheckPlan({ engine: 'codex', route: 'new' }, root), /Required test is missing/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verification stops on a failing check and propagates exit and signal failures', () => {
  const plan = engineCheckPlan({ engine: 'codex', route: 'new' })
  const calls = []
  assert.equal(runEngineChecks(plan, (_bin, args) => { calls.push(args); return { status: 7 } }), 7)
  assert.equal(calls.length, 1)
  assert.equal(runEngineChecks(plan, () => ({ status: null, signal: 'SIGTERM' })), 1)
  assert.throws(() => runEngineChecks(plan, () => ({ error: new Error('spawn failed') })), /spawn failed/)
  calls.length = 0
  assert.equal(runEngineChecks(plan, (_bin, args) => { calls.push(args); return { status: 0 } }), 0)
  assert.deepEqual(calls.at(-2), ['scripts/check-handoff-capabilities.mjs', '--engine', 'codex'])
  assert.deepEqual(calls.at(-1), ['scripts/build-client.mjs', '--check'])
})

test('plan CLI does not execute tests and rejects unknown flags', () => {
  const script = new URL('../scripts/verify-engine.mjs', import.meta.url)
  const plan = spawnSync(process.execPath, [script.pathname, '--engine', 'codex', '--route', 'capability', '--capability', 'models', '--plan'], { encoding: 'utf8' })
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /project maintainer acceptance required/)
  assert.doesNotMatch(plan.stdout, /TAP version/)
  const invalid = spawnSync(process.execPath, [script.pathname, '--typo'], { encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Unknown option/)
})
