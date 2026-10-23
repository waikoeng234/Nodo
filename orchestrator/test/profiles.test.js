import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, withHost } from './helpers/host.js'
import templates from '../src/shared/avatar-templates.json' with { type: 'json' }

test('avatar selections persist across restart and an avatar-only edit keeps conversations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-avatars-'))
  let host = boot(home)
  try {
    const profiles = []
    for (const template of templates) profiles.push(await host.api('profile-create', {
      name: template.label, engine: 'echo', avatarTemplate: template.id,
    }))
    const workspace = await host.api('workspace-create', { name: 'Avatar test', cwd: join(home, 'workspace') })
    const profile = profiles[0]
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const before = (await host.api('state')).profiles.find(item => item.id === profile.id)
    const edited = await host.api('profile-update', { id: profile.id, changes: { avatarTemplate: 'peach' } })
    assert.equal(edited.avatarTemplate, 'peach')
    assert.deepEqual(edited.sessions, before.sessions)
    assert.equal(edited.activeSessionId, session.id)
    host.dispose()
    host = boot(home)
    const restored = (await host.api('state')).profiles.filter(item => profiles.some(profile => profile.id === item.id))
    assert.deepEqual(restored.map(item => item.avatarTemplate), ['peach', ...templates.slice(1).map(item => item.id)])
    assert.deepEqual(restored[0].sessions, before.sessions)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('role responsibilities retain the goal field and appear in the role identity', async () => {
  await withHost(async ({ api, runtime }) => {
    const profile = await api('profile-create', { name: 'Goaled', engine: 'echo', goal: 'Ship the migration' })
    assert.equal(profile.goal, 'Ship the migration')
    const saved = await api('profile-update', { id: profile.id, changes: { goal: '  Port the tests  ' } })
    assert.equal(saved.goal, '  Port the tests  ')
    assert.equal((await api('state')).profiles.find(item => item.id === profile.id).goal, '  Port the tests  ')
    const identity = (await runtime).renderIdentity(saved)
    assert.ok(identity.includes(`Role responsibilities: ${saved.goal}`))
    assert.doesNotMatch(identity, /long-term goal/)
  })
})

test('adapter roles keep their conversation on an identity edit and never change engine', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Adapter', cwd: join(home, 'adapter-ws') })
    const profile = await api('profile-create', { name: 'Adapter', engine: 'codex' })
    const session = await api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const edited = await api('profile-update', { id: profile.id, changes: { instructions: 'Standards to keep' } })
    assert.equal(edited.sessions.length, 1)
    assert.equal(edited.activeSessionId, session.id)
    const refused = await post('profile-update', { id: profile.id, changes: { engine: 'dsh' } })
    assert.equal(refused.error.code, 'orch/invalid')
    assert.match(refused.error.message, /fixed once a role is created/)
    assert.equal((await api('profile-update', { id: profile.id, changes: { name: 'Renamed' } })).name, 'Renamed')
  })
})

test('roles without a pick take dango avatars in turn and wrap around after six', async () => {
  await withHost(async ({ api }) => {
    const start = (await api('state')).profiles.length
    const created = []
    for (let n = 0; n <= templates.length; n += 1) created.push(await api('profile-create', { name: `轮转${n}`, engine: 'echo' }))
    assert.deepEqual(created.map(item => item.avatarTemplate),
      [...templates, ...templates].slice(start, start + templates.length + 1).map(item => item.id))
  })
})

test('invalid avatar templates fail atomically and old profiles remain editable', async () => {
  await withHost(async ({ api, post }) => {
    const start = (await api('state')).profiles.length
    const profile = await api('profile-create', { name: 'Legacy', engine: 'echo' })
    assert.equal(profile.avatarTemplate, templates[start % templates.length].id)
    const count = (await api('state')).profiles.length
    for (const avatarTemplate of ['missing', {}, 3]) {
      const created = await post('profile-create', { name: 'Invalid', engine: 'echo', avatarTemplate })
      assert.equal(created.error.code, 'orch/invalid')
      const edited = await post('profile-update', { id: profile.id, changes: { name: 'Renamed', avatarTemplate } })
      assert.equal(edited.error.code, 'orch/invalid')
    }
    const state = await api('state')
    assert.equal(state.profiles.length, count)
    assert.equal(state.profiles.find(item => item.id === profile.id).name, 'Legacy')
    assert.equal((await api('profile-update', { id: profile.id, changes: { role: 'Existing role' } })).avatarTemplate, templates[start % templates.length].id)
    assert.equal((await api('profile-update', { id: profile.id, changes: { avatarTemplate: 'mint' } })).avatarTemplate, 'mint')
  })
})

test('saved identities ride prefs, survive the role, and are deletable', async () => {
  await withHost(async ({ api, post }) => {
    const saved = await api('role-preset-save', { name: '审查员', role: '独立审查实现与风险', instructions: '你是审查员。' })
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, '审查员')
    assert.deepEqual((await api('state')).prefs.rolePresets, saved)
    const updated = await api('role-preset-save', { name: ' 审查员 ', role: '改过的身份', instructions: '改过的信息' })
    assert.equal(updated.length, 1, 'saving over a name updates that entry')
    assert.equal(updated[0].role, '改过的身份')
    const clash = await post('role-preset-save', { name: 'Coder', role: 'x', instructions: 'y' })
    assert.equal(clash.error.code, 'orch/invalid')
    assert.match(clash.error.message, /built-in/)
    assert.equal((await post('role-preset-save', { name: '   ' })).error.code, 'orch/invalid')
    const profile = await api('profile-create', { name: '持有者', engine: 'echo', role: '改过的身份', instructions: '改过的信息' })
    await api('profile-delete', { id: profile.id })
    assert.equal((await api('state')).prefs.rolePresets.length, 1, 'deleting the role keeps the saved identity')
    const missing = await post('role-preset-delete', { name: '不存在' })
    assert.equal(missing.error.code, 'orch/not-found')
    assert.deepEqual(await api('role-preset-delete', { name: '审查员' }), [])
    assert.deepEqual((await api('state')).prefs.rolePresets, [])
  })
})
