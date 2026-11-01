import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install as installDispatch } from '../core/src/dispatch.js'

const harness = () => {
  const lines = []
  const rt = {
    ctx: { effect: () => {} },
    state: { profiles: {} }, sessionsOf: () => [], conversationOf: () => ({ profile: { name: 'Fixture' } }),
    redactDeepSecrets: value => value,
    appendLine: (_id, line) => { lines.push(line); return line },
    save: async () => {},
    statsOutput() {}, statsTool() {}, statsEnd() {}, recordTaskOutcome() {}, isCompacting: () => false,
  }
  installDispatch(rt)
  return { rt, lines }
}

test('an event whose type names an Object.prototype member is dropped instead of calling an inherited sink', () => {
  const h = harness()
  for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) h.rt.driverSink('p', { type })
  assert.deepEqual(h.lines, [])
})
