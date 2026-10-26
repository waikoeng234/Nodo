import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withHost } from './helpers/host.js'

test('saves made before a write starts share it, and a change during a write lands in the next one', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    await rt.save()
    const stringify = JSON.stringify
    let writes = 0
    JSON.stringify = function (value, ...rest) {
      if (value === rt.state) writes += 1
      return stringify.call(this, value, ...rest)
    }
    try {
      await Promise.all(Array.from({ length: 100 }, () => rt.save()))
      assert.equal(writes, 1, 'a burst of saves is one write')

      const first = rt.save()
      await new Promise(resolve => setImmediate(resolve))
      rt.state.prefs.marker = 'late'
      await Promise.all([first, rt.save()])
      assert.equal(writes, 3, 'a save during a write queues the next one')
    } finally { JSON.stringify = stringify }
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.prefs.marker, 'late')
    assert.equal(saved.revision, rt.state.revision)
  })
})
