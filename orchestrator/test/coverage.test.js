import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAcpDriver } from '../agent-drivers/dist/acp/core.js'
import { CATEGORIES, DECLARED, STATUS, createCoverage } from '../agent-drivers/dist/coverage.js'
import { jsonRpcProcess } from '../agent-drivers/dist/json-rpc-process.js'
import { until } from './helpers/host.js'

const fixture = fileURLToPath(new URL('./fixtures/acp-cli.cjs', import.meta.url))

test('every declared branch carries a conclusion and the counts match the reviewed baseline', () => {
  for (const [scope, entry] of Object.entries(DECLARED)) {
    assert.ok(entry.revision.length > 0, scope)
    assert.equal(typeof entry.closureOpen, 'boolean', scope)
    for (const channel of ['notifications', 'requests', 'variants'])
      for (const [name, status] of Object.entries(entry[channel]))
        assert.ok(STATUS.includes(status), `${scope} ${channel} ${name} has no conclusion`)
  }
  assert.equal(Object.keys(DECLARED.codex.notifications).length, 83)
  assert.equal(Object.keys(DECLARED.zcode.variants).length, 25)
  assert.equal(Object.keys(DECLARED['dsh-native'].notifications).length, 62)
  assert.equal(Object.keys(DECLARED.acp.variants).length, 15)
  assert.equal(DECLARED.codex.notifications['turn/diff/updated'], 'partial')
  assert.equal(DECLARED.acp.variants.usage_update, 'partial')
  assert.equal(DECLARED.claude.notifications.result, 'partial')
  assert.equal(DECLARED.zcode.variants['turn.completed'], 'partial')
  assert.equal(DECLARED['dsh-native'].notifications['workspace/changes'], 'partial')
})

test('unknown counters report identity once and stay at one line per category per drain', () => {
  const coverage = createCoverage('fixture', 'acp')
  coverage.setIdentity({ transport: 'test', protocolVersion: 1 })
  const first = coverage.drain()
  assert.equal(first.length, 1)
  assert.match(first[0], /fixture test protocol 1 cli unknown/)
  assert.deepEqual(coverage.drain(), [])
  for (let i = 0; i < 120; i++) coverage.count('unknown-notification')
  coverage.count('unknown-variant')
  coverage.count('not-a-category')
  const lines = coverage.drain()
  assert.equal(lines.length, 2)
  assert.match(lines[0], /unknown-notification total 120/)
  assert.match(lines[1], /unknown-variant total 1/)
  assert.deepEqual(coverage.drain(), [])
  assert.deepEqual(coverage.snapshot().counts, { 'unknown-notification': 120, 'unknown-variant': 1 })
  assert.deepEqual([...CATEGORIES], ['unknown-notification', 'unknown-request', 'unknown-variant'])
})

test('unknown engine traffic counts by category and never leaks names or payloads', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-coverage-'))
  const events = []
  const driver = createAcpDriver({ cwd, onEvent: event => events.push(event) }, {
    id: 'fixture', label: 'Fixture',
    connect: callbacks => jsonRpcProcess({ bin: process.execPath, args: [fixture], cwd, jsonrpc: '2.0', ...callbacks }),
  })
  try {
    await driver.sendTurn('NOISE 5 s3cret-sentinel')
    await until(() => events.find(event => event.type === 'turn/end'))
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done', 'unknown traffic must not disturb the turn')
    const snapshot = driver.coverage.snapshot()
    assert.equal(snapshot.counts['unknown-notification'], 5)
    assert.equal(snapshot.counts['unknown-variant'], 1)
    assert.equal(snapshot.closureOpen, true)
    const leak = JSON.stringify({ snapshot, lines: driver.coverage.drain(), events })
    assert.ok(!leak.includes('s3cret-sentinel'), 'no payload value may surface')
    assert.ok(!leak.includes('future/broadcast'), 'no unknown method name may surface')
    assert.ok(!leak.includes('hologram_display'), 'no unknown variant name may surface')
  } finally { driver.dispose(); rmSync(cwd, { recursive: true, force: true }) }
})
