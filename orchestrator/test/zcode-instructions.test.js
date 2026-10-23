import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zcodeInstructions } from '../agent-drivers/dist/zcode/instructions.js'
import { opencodeInstructions } from '../agent-drivers/dist/opencode/instructions.js'
import { createIdentityFiles } from '../agent-drivers/dist/identity-files.js'
import { zcodeMcpServers } from '../agent-drivers/dist/zcode/mcp.js'

const fixture = async run => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-zcode-role-test-'))
  const home = join(root, 'user')
  mkdirSync(join(home, '.zcode'), { recursive: true })
  const options = { instructions: 'ROLE {{literal}} {env:UNSET} {file:/literal}', version: '0.16.9', env: { HOME: home, SHELL: '/bin/bash', ZCODE_STORAGE_DIR: join(home, '.zcode') } }
  try { await run({ root, home, options }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('ZCode and OpenCode share complete identity versions without changing the user environment', () => fixture(async ({ root, home, options }) => {
  writeFileSync(join(home, '.zcode/AGENTS.md'), 'USER_GLOBAL_RULE')
  const files = createIdentityFiles(join(root, 'identities'))
  const first = zcodeInstructions({ ...options, identityFiles: files, identityOwner: 'one' })
  const second = zcodeInstructions({ ...options, identityFiles: files, identityOwner: 'two' })
  const opencode = opencodeInstructions(options.instructions, {}, undefined, files, 'three')
  try {
    assert.equal(first.env, options.env)
    assert.equal(first.path, second.path)
    assert.notEqual(first.readyFile, second.readyFile)
    assert.ok(opencode.env.OPENCODE_CONFIG_CONTENT.includes(first.path))
    assert.equal(readFileSync(first.path, 'utf8'), options.instructions)
    first.dispose()
    assert.equal(existsSync(first.path), true)
    assert.equal(readFileSync(join(home, '.zcode/AGENTS.md'), 'utf8'), 'USER_GLOBAL_RULE')
  } finally { first.dispose(); second.dispose(); opencode.dispose() }
}))

test('ZCode requires a matching discovered tool catalog before exposing native identity', () => fixture(async ({ options }) => {
  const identity = zcodeInstructions(options)
  try {
    assert.equal(identity.mode, 'none')
    const pending = identity.install()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(identity.mode, 'none')
    writeFileSync(identity.readyFile, JSON.stringify({ version: identity.version }))
    await pending
    assert.equal(identity.mode, 'native')
    assert.equal(identity.target, 'tool-schema')
    const oldReceipt = identity.readyFile
    identity.reset()
    assert.equal(identity.mode, 'none')
    assert.notEqual(identity.readyFile, oldReceipt)
    assert.equal(existsSync(oldReceipt), false)
    writeFileSync(identity.readyFile, JSON.stringify({ version: 'other-role' }))
    await assert.rejects(identity.install(), /different identity/)
  } finally { identity.dispose() }
}))

test('ZCode preserves expressible user MCP settings and refuses overrides that would drop configuration', () => fixture(async ({ root, home, options }) => {
  const path = join(home, '.zcode/cli/config.json')
  mkdirSync(join(home, '.zcode/cli'))
  const servers = {
    existing: { type: 'stdio', command: 'node', args: ['tool.js'], env: { FIXTURE_VALUE: 'literal ${NOT_EXPANDED}' }, timeoutMs: 12000, protocolVersion: 'legacy' },
    remote: { type: 'http', url: 'https://fixture.invalid/mcp', headers: { 'X-Fixture': 'local-placeholder' } },
    disabled: { type: 'stdio', command: 'never-run', enabled: false },
  }
  const contents = JSON.stringify({ mcp: { servers }, plugins: { enabledPlugins: { existing: true } } })
  writeFileSync(path, contents)
  assert.deepEqual(zcodeMcpServers({ cwd: root, env: options.env }), [
    { name: 'existing', command: 'node', args: ['tool.js'], env: [{ name: 'FIXTURE_VALUE', value: 'literal ${NOT_EXPANDED}' }], timeoutMs: 12000, protocolVersion: 'legacy' },
    { name: 'remote', type: 'http', url: 'https://fixture.invalid/mcp', headers: [{ name: 'X-Fixture', value: 'local-placeholder' }] },
  ])
  assert.equal(readFileSync(path, 'utf8'), contents)
  for (const config of [{ mcp: { servers: { existing: { ...servers.existing, cwd: root } } } }, { features: { mcp: false } }, { mcp: { servers: { nodo_role: servers.existing } } }]) {
    writeFileSync(path, JSON.stringify(config))
    assert.equal(zcodeMcpServers({ cwd: root, env: options.env }), undefined)
  }
  writeFileSync(path, contents)
  writeFileSync(join(root, 'zcode.json'), JSON.stringify({ mcp: { servers: { project: servers.existing } } }))
  assert.equal(zcodeMcpServers({ cwd: root, env: options.env }), undefined)
}))

test('ZCode stays without native identity for unknown versions or missing discovery, including long identities', () => fixture(async ({ options }) => {
  for (const changes of [{ version: '0.17.0' }, { instructions: '角色'.repeat(60000) }]) {
    const identity = zcodeInstructions({ ...options, ...changes })
    try {
      await identity.install(0)
      assert.equal(identity.mode, 'none')
      assert.equal(identity.env, options.env)
      assert.equal(readFileSync(identity.path, 'utf8'), changes.instructions ?? options.instructions)
    } finally { identity.dispose() }
  }
  const identity = zcodeInstructions(options)
  const pending = identity.install()
  identity.dispose()
  await assert.rejects(pending, /disposed/)
}))
