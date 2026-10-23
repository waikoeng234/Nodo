import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const withConsumer = run => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-package-test-'))
  const consumer = join(root, 'consumer')
  const driver = join(consumer, 'node_modules/agent-drivers')
  const cwd = join(root, 'workspace')
  const home = join(root, 'home')
  const dsh = join(root, 'dsh')
  try {
    for (const dir of [driver, cwd, home, dsh]) mkdirSync(dir, { recursive: true })
    copyFileSync(new URL('../agent-drivers/package.json', import.meta.url), join(driver, 'package.json'))
    cpSync(new URL('../agent-drivers/src', import.meta.url), join(driver, 'src'), { recursive: true })
    run({ consumer, cwd, dsh, execute(source) {
      const entry = join(consumer, 'check.mjs')
      writeFileSync(entry, source)
      const result = spawnSync(process.execPath, [entry], { cwd, env: { ...process.env, HOME: home, DSH_HOME: dsh }, encoding: 'utf8' })
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    } })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const provideWebSocket = (root, location) => {
  const directory = join(root, 'node_modules/ws')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'ws', main: 'index.cjs' }))
  writeFileSync(join(directory, 'index.cjs'), `module.exports = class WebSocket {}; module.exports.location = ${JSON.stringify(location)}`)
}

for (const location of ['consumer', 'workspace', 'dsh']) {
  test(`Codex resolves the ${location} WebSocket provider from an unrelated working directory`, () => {
    withConsumer(({ consumer, cwd, dsh, execute }) => {
      if (location === 'consumer') provideWebSocket(consumer, 'consumer')
      if (location !== 'dsh') provideWebSocket(cwd, 'workspace')
      provideWebSocket(join(dsh, 'profiles'), 'dsh')
      execute(`
        import assert from 'node:assert/strict'
        import { hostWebSocket } from './node_modules/agent-drivers/src/websocket.js'
        assert.equal(hostWebSocket().location, ${JSON.stringify(location)})
      `)
    })
  })
}

test('an independent consumer imports and reopens identity storage through the public package entry', () => {
  withConsumer(({ execute }) => execute(`
    import assert from 'node:assert/strict'
    import { readFileSync, existsSync } from 'node:fs'
    import { createIdentityFiles } from 'agent-drivers'
    import { PRIMITIVES } from 'agent-drivers/spi'
    import { probeSpawn } from 'agent-drivers/probe'
    const first = createIdentityFiles('./identities').bind('session', 'Fixture role')
    assert.equal(readFileSync(first.path, 'utf8'), 'Fixture role')
    const reopened = createIdentityFiles('./identities')
    assert.deepEqual(reopened.bind('session', 'Fixture role'), first)
    reopened.collect([])
    assert.equal(existsSync(first.path), false)
    assert.equal(PRIMITIVES.length, 8)
    assert.equal(typeof probeSpawn, 'function')
  `))
})
