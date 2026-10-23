import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

test('the repository root packs a discoverable DSH bundle with working host and client entries', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'nodo-git-package-'))
  const consumer = join(home, 'consumer')
  const target = join(consumer, 'node_modules', 'dsh-plugin-nodo')
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, 'dsh'), npm_config_cache: join(home, 'cache') }
  try {
    const original = JSON.parse(readFileSync(join(root, 'orchestrator/package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const field of ['name', 'version', 'type', 'dependencies']) assert.deepEqual(manifest[field], original[field], field)
    assert.deepEqual(manifest.dsh.client, original.dsh.client)
    const pack = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: root, env, encoding: 'utf8', timeout: 30000 })
    assert.equal(pack.status, 0, pack.error?.message ?? pack.stderr)
    const report = JSON.parse(pack.stdout)
    const archive = Array.isArray(report) ? report[0] : report[manifest.name]
    const files = new Set(archive.files.map(file => file.path))
    assert.equal(archive.name, manifest.name)
    for (const entry of [manifest.main, manifest.exports['.'], manifest.exports['./client'], manifest.exports['./package.json'], manifest.dsh.bundle.patch]) {
      assert.ok(files.has(entry.replace(/^\.\//, '')), `package is missing ${entry}`)
    }
    for (const entry of original.files) {
      const path = `orchestrator/${entry}`
      assert.ok(entry.endsWith('/') ? [...files].some(file => file.startsWith(path)) : files.has(path), `package is missing ${path}`)
    }
    assert.ok(![...files].some(file => /(^|\/)(node_modules|test|scripts)\//.test(file)))
    mkdirSync(target, { recursive: true })
    const unpack = spawnSync('tar', ['-xzf', join(home, archive.filename), '--strip-components=1', '-C', target], { env, encoding: 'utf8' })
    assert.equal(unpack.status, 0, unpack.error?.message ?? unpack.stderr)
    const entry = join(consumer, 'check.mjs')
    writeFileSync(entry, `
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      import { createRequire } from 'node:module'
      import { dirname, resolve } from 'node:path'
      import { Script } from 'node:vm'
      import { name, apply, createRuntime } from 'dsh-plugin-nodo'
      const require = createRequire(import.meta.url)
      const manifestPath = require.resolve('dsh-plugin-nodo/package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.equal(name, 'nodo')
      assert.equal(typeof apply, 'function')
      assert.equal(typeof createRuntime, 'function')
      const patch = readFileSync(resolve(dirname(manifestPath), manifest.dsh.bundle.patch), 'utf8')
      assert.ok(patch.includes('name: ' + manifest.name))
      const client = readFileSync(require.resolve('dsh-plugin-nodo/client'), 'utf8')
      new Script(client)
      const calls = []
      new Script(client).runInNewContext({ window: { __ModuleLoader__: { load: value => calls.push(value) } } })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].id, manifest.name)
    `)
    const loaded = spawnSync(process.execPath, [entry], { cwd: consumer, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(loaded.status, 0, loaded.error?.message ?? loaded.stderr)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

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
