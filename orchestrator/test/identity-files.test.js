import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createIdentityFiles } from '../agent-drivers/dist/identity-files.js'
import { until, withHost } from './helpers/host.js'

test('identity files share immutable complete content, retain old versions and collect only unreferenced versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-identities-test-'))
  try {
    const files = createIdentityFiles(root)
    const first = files.bind('session-a', 'Coder {{literal}}\ncwd=/one')
    const shared = files.bind('session-b', 'Coder {{literal}}\ncwd=/one')
    assert.deepEqual(first, shared)
    assert.equal(statSync(first.path).mode & 0o777, 0o444)
    assert.equal(statSync(join(root, 'versions')).mode & 0o777, 0o700)
    const changed = files.bind('session-a', 'Coder {{literal}}\ncwd=/two')
    assert.notEqual(changed.version, first.version)
    assert.equal(readFileSync(first.path, 'utf8'), 'Coder {{literal}}\ncwd=/one')
    files.collect(['session-a', 'session-b'])
    assert.equal(existsSync(first.path), true)
    const reopened = createIdentityFiles(root)
    assert.deepEqual(reopened.bind('session-b', 'Coder {{literal}}\ncwd=/one'), first)
    reopened.collect(['session-a'])
    assert.equal(existsSync(first.path), false)
    assert.equal(existsSync(changed.path), true)
    reopened.collect([])
    assert.deepEqual(readdirSync(join(root, 'versions')), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('identity files reject tampered versions instead of replacing existing content', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-identities-test-'))
  try {
    const files = createIdentityFiles(root)
    const identity = files.bind('../owner', 'Original')
    chmodSync(identity.path, 0o600)
    writeFileSync(identity.path, 'Changed')
    assert.throws(() => files.bind('../owner', 'Original'), /does not match/)
    assert.equal(readFileSync(identity.path, 'utf8'), 'Changed')
    assert.equal(readdirSync(join(root, 'references')).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('starting an engine collects identity versions no session references', async () => {
  await withHost(async host => {
    const files = createIdentityFiles(join(host.home, 'identities'))
    const workspace = await host.api('workspace-create', { name: 'Identity start', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Identity start fixture', engine: 'echo', workspace: workspace.id })
    const orphan = files.bind('removed-session', 'Orphaned identity')
    const kept = files.bind(profile.id, 'Kept identity')
    await host.api('send', { profile: profile.id, text: 'Start' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.equal(existsSync(orphan.path), false)
    assert.equal(existsSync(kept.path), true)
  })
})

test('host deletion collects identity versions while archived sessions retain references', async () => {
  await withHost(async host => {
    const files = createIdentityFiles(join(host.home, 'identities'))
    const workspace = await host.api('workspace-create', { name: 'Identity resources', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Identity cleanup fixture', engine: 'echo', workspace: workspace.id })
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const first = files.bind(profile.id, 'Shared identity')
    files.bind(session.id, 'Shared identity')
    await host.api('session-archive', { profile: profile.id, session: session.id, archived: true })
    assert.equal(existsSync(first.path), true)
    await host.api('profile-delete', { id: profile.id })
    assert.equal(existsSync(first.path), false)
  })
})
