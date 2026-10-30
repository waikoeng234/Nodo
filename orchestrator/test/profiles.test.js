import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, until, withHost } from './helpers/host.js'
import templates from '../core/shared/avatar-templates.json' with { type: 'json' }
import { MAX_PROFILES } from '../core/src/constants.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { createEchoDriver, echoInfo, registerClaudeFixtureEngine, validateEchoOptions } from './helpers/echo-driver.js'
import { loadClient } from './helpers/client-module.js'

registerClaudeFixtureEngine()

test('role permissions are explicit, validated atomically and persisted', () => withHost(async ({ api, post, home }) => {
  const card = await api('profile-create', { name: 'Planner', engine: 'echo', permission: 'plan' })
  assert.equal(card.permission, 'plan')
  assert.equal((await api('profile-create', { name: 'Workspace', engine: 'echo' })).permission, 'workspace')
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[card.id].permission, 'plan')
  for (const permission of ['', null, 'invented']) {
    assert.equal((await post('profile-create', { name: 'Invalid', engine: 'echo', permission })).error.code, 'orch/invalid')
    assert.equal((await post('profile-update', { id: card.id, changes: { name: 'Changed', permission } })).error.code, 'orch/invalid')
    const saved = (await api('state')).profiles.find(item => item.id === card.id)
    assert.equal(saved.name, 'Planner')
    assert.equal(saved.permission, 'plan')
  }
  assert.equal((await post('profile-create', { name: 'Unsupported full', engine: 'opencode', permission: 'full' })).error.code, 'orch/invalid')
  assert.equal((await api('profile-update', { id: card.id, changes: { permission: 'full' } })).permission, 'full')
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[card.id].permission, 'full')
}))

test('loading old cards fills declared permissions and leaves DSH without presets unset', async () => {
  registerEngine('permission-first', { info: { ...echoInfo, id: 'permission-first', capabilities: { ...echoInfo.capabilities, permissionModes: ['plan', 'full'] } },
    create: createEchoDriver, validate: validateEchoOptions, check: async () => ({ ok: true }) })
  const home = mkdtempSync(join(tmpdir(), 'orch-permission-migration-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, profiles: Object.fromEntries([
    { id: 'legacy', name: 'Legacy', engine: 'echo' },
    { id: 'empty', name: 'Empty', engine: 'echo', permission: '' },
    { id: 'first', name: 'First', engine: 'permission-first' },
    { id: 'stored', name: 'Stored', engine: 'permission-first', permission: 'workspace' },
    { id: 'native', name: 'Native', engine: 'dsh' },
    { id: 'held', name: 'Held', engine: 'echo', permission: 'full' },
  ].map(card => [card.id, { ...card, sessions: [] }])) }))
  let host = boot(home)
  try {
    const cards = (await host.api('state')).profiles
    for (const id of ['legacy', 'empty']) assert.equal(cards.find(card => card.id === id).permission, 'workspace')
    assert.equal(cards.find(card => card.id === 'first').permission, 'plan')
    assert.equal(cards.find(card => card.id === 'stored').permission, 'plan', 'a stored tier the engine no longer offers falls back to its first declared mode')
    assert.equal(cards.find(card => card.id === 'held').permission, 'full')
    assert.equal(Object.hasOwn(cards.find(card => card.id === 'native'), 'permission'), false)
    assert.equal((await host.api('profile-create', { name: 'No workspace mode', engine: 'permission-first' })).permission, 'plan')
    const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles
    assert.equal(persisted.legacy.permission, 'workspace')
    assert.equal(persisted.first.permission, 'plan')
    assert.equal(persisted.stored.permission, 'plan')
    assert.equal(Object.hasOwn(persisted.native, 'permission'), false)
    host.dispose()
    host = boot(home, { workspaceRegistry: {}, sessionController: {}, get: name => name === 'permissionPresets'
      ? { names: ['workspace-write'], resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set() {} } : undefined })
    assert.equal((await host.api('state')).profiles.find(card => card.id === 'native').permission, 'workspace')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a tier change keeps an implicit conversation current instead of opening an empty one', async () => {
  registerEngine('permission-first', { info: { ...echoInfo, id: 'permission-first', capabilities: { ...echoInfo.capabilities, permissionModes: ['plan', 'full'] } },
    create: createEchoDriver, validate: validateEchoOptions, check: async () => ({ ok: true }) })
  await withHost(async ({ api, runtime, home }) => {
    const rt = await runtime
    const workspace = await api('workspace-create', { name: 'Tier', cwd: join(home, 'ws') })
    const card = await api('profile-create', { name: 'Implicit', engine: 'permission-first', workspace: workspace.id, engineOptions: { script: [{ kind: 'text', text: 'Done' }] } })
    await api('send', { profile: card.id, text: 'Question' })
    await until(() => !rt.workView()[card.id]?.active && rt.conversation(card.id).session.briefSent)
    const before = (await api('state')).profiles.find(item => item.id === card.id)
    assert.equal(before.sessions.length, 1)
    assert.equal(before.activeSessionId, card.id, 'the implicit conversation is the current one')
    const edited = await api('profile-update', { id: card.id, changes: { permission: 'full' } })
    assert.equal(edited.sessions.length, before.sessions.length, 'no empty replacement conversation opens')
    assert.equal(edited.activeSessionId, before.activeSessionId)
    assert.equal(edited.sessions.find(item => item.id === card.id).permission, 'full', 'the new tier lands on the conversation in use')
  })
})

for (const native of [false, true]) test(`loading ${native ? 'reduced native' : 'ACP'} DSH permissions repairs stale roles and sessions`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-permission-repair-'))
  const permissionPresets = { names: ['read-only'], resolve: () => ({ sandbox: 'read-only', approval: 'ask' }), set() {} }
  const nativeHost = native ? { workspaceRegistry: {}, sessionController: {}, get: name => name === 'permissionPresets' ? permissionPresets : undefined } : {}
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2,
    workspaces: { ws: { id: 'ws', name: 'Project', cwd: home } },
    profiles: {
      dsh: { id: 'dsh', name: 'Native', engine: 'dsh', workspaceId: 'ws', activeSessionId: 'stale', permission: 'workspace',
        sessions: [{ id: 'stale', engine: 'dsh', workspaceRef: 'ws', permission: 'workspace' },
          { id: 'empty', engine: 'dsh', workspaceRef: 'ws', permission: '' },
          { id: 'plan', engine: 'dsh', workspaceRef: 'ws', permission: 'plan' }] },
      echo: { id: 'echo', name: 'Worker', engine: 'echo', permission: 'workspace',
        sessions: [{ id: 'echo-session', engine: 'echo', workspaceRef: 'ws', permission: '' }] },
    },
  }))
  const host = boot(home, nativeHost)
  try {
    const rt = await host.runtime
    const roles = (await host.api('state')).profiles
    const dsh = roles.find(role => role.id === 'dsh')
    assert.equal(dsh.permission, native ? 'plan' : undefined)
    for (const id of ['stale', 'empty']) assert.equal(Object.hasOwn(dsh.sessions.find(session => session.id === id), 'permission'), false)
    assert.equal(dsh.sessions.find(session => session.id === 'plan').permission, native ? 'plan' : undefined)
    const renamed = await host.api('profile-update', { id: 'dsh', changes: { name: 'Renamed', model: 'new-model' } })
    assert.equal(renamed.name, 'Renamed', 'a stale tier no longer blocks unrelated edits')
    if (!native) assert.equal(Object.hasOwn(rt.findProfile('dsh'), 'permission'), false, 'updates do not leave an undefined permission property')
    const created = await host.api('session-create', { profile: 'dsh', workspace: 'ws', lazy: true })
    assert.equal(created.permission, native ? 'plan' : undefined)
    assert.equal((await rt.prepareConversation(created.id)).permission, native ? 'plan' : undefined, 'only supported tiers reach driver preparation')
    const echo = roles.find(role => role.id === 'echo')
    assert.equal(Object.hasOwn(echo.sessions[0], 'permission'), false)
    const { PermissionMenu } = await loadClient('composer.js')
    const menu = PermissionMenu({ profile: { ...echo, ...echo.sessions[0] }, disabled: false, onChange() {} }).children.find(node => node.type === 'Menu')
    assert.ok(menu.props.anchor.props['aria-label'].includes('工作区内修改'), 'an old empty session tier has a normal composer label')
    const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles
    assert.equal(persisted.dsh.permission, native ? 'plan' : undefined)
    assert.equal(Object.hasOwn(persisted.echo.sessions[0], 'permission'), false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('state session views omit report queues while retaining their persisted contents', () => withHost(async ({ api, runtime, home }) => {
  const role = await api('profile-create', { name: 'Worker', engine: 'echo' })
  const workspace = await api('workspace-create', { name: 'Project', cwd: join(home, 'ws') })
  const session = await api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
  const rt = await runtime
  const queue = [{ id: 'pending-report', text: 'Frozen internal report', referenceId: 'reference-id' }]
  rt.conversation(role.id, session.id).session.reportQueue = queue
  await rt.save()
  const view = (await api('state')).profiles.find(profile => profile.id === role.id).sessions.find(item => item.id === session.id)
  assert.equal(Object.hasOwn(view, 'reportQueue'), false)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.profiles[role.id].sessions.find(item => item.id === session.id).reportQueue, queue)
}))

test('fallback is unique, transfers explicitly, survives ordering and passes on deletion', () => withHost(async ({ api, runtime }) => {
  const first = await api('profile-create', { name: 'First', engine: 'echo', fallback: false })
  const second = await api('profile-create', { name: 'Second', engine: 'echo', fallback: true })
  const third = await api('profile-create', { name: 'Third', engine: 'echo' })
  const rt = await runtime
  const holders = () => Object.values(rt.state.profiles).filter(profile => profile.fallback === true).map(profile => profile.id)
  assert.equal(first.fallback, true)
  assert.equal(Object.hasOwn(second, 'fallback'), false, 'create ignores caller fallback')
  await api('profile-update', { id: second.id, changes: { fallback: false } })
  assert.equal(Object.hasOwn(rt.findProfile(second.id), 'fallback'), false)
  for (const fallback of [false, null]) await assert.rejects(api('profile-update', { id: first.id, changes: { fallback } }), { code: 'orch/invalid', message: '兜底标记只能转移给其他角色' })
  await api('profile-update', { id: second.id, changes: { fallback: true } })
  assert.deepEqual(holders(), [second.id])
  assert.equal(Object.hasOwn(rt.findProfile(first.id), 'fallback'), false)
  await api('profile-order', { ids: [third.id, first.id, second.id] })
  assert.deepEqual(holders(), [second.id], 'reordering keeps the current fallback')
  await api('profile-delete', { id: second.id })
  assert.deepEqual(holders(), [third.id], 'the first remaining executor takes over')
  assert.equal(Object.hasOwn(rt.state.profiles[second.id], 'fallback'), false)
  await api('profile-delete', { id: third.id })
  await api('profile-delete', { id: first.id })
  assert.deepEqual(holders(), [])
}))

test('leads require an executor and cannot remove or promote the last one before host archival', () => withHost(async ({ api, runtime }) => {
  await assert.rejects(api('profile-create', { name: 'Lead', engine: 'echo', lead: true }), { code: 'orch/invalid', message: '主控至少需要一个执行角色' })
  const worker = await api('profile-create', { name: 'Worker', engine: 'claude' })
  await assert.rejects(api('profile-update', { id: worker.id, changes: { lead: true } }), { code: 'orch/invalid', message: '主控至少需要一个执行角色' })
  const lead = await api('profile-create', { name: 'Lead', engine: 'claude', lead: true, fallback: true })
  assert.equal(Object.hasOwn(lead, 'fallback'), false)
  const rt = await runtime
  let archived = false
  rt.archiveHostSessions = async () => { archived = true }
  await assert.rejects(api('profile-delete', { id: worker.id }), { code: 'orch/invalid', message: '主控至少需要一个执行角色' })
  assert.equal(archived, false)
  await assert.rejects(api('profile-update', { id: worker.id, changes: { lead: true, name: 'Refused' } }), { code: 'orch/invalid', message: '主控至少需要一个执行角色' })
  assert.equal(rt.findProfile(worker.id).name, 'Worker')
  await assert.rejects(api('profile-update', { id: lead.id, changes: { fallback: true } }), { code: 'orch/invalid', message: '兜底角色必须是执行角色' })
  await assert.rejects(api('task-types-update', { types: [] }), { code: 'orch/invalid', message: '至少保留一个任务类型' })
  const second = await api('profile-create', { name: 'Second', engine: 'echo' })
  await api('profile-update', { id: worker.id, changes: { lead: true } })
  assert.equal(rt.findProfile(second.id).fallback, true, 'promoting fallback hands it to the remaining executor')
  assert.equal(Object.hasOwn(rt.findProfile(worker.id), 'fallback'), false)
  await api('profile-delete', { id: lead.id })
  await api('profile-delete', { id: worker.id })
  await api('profile-delete', { id: second.id })
}))

test('lead roles are limited to whitelisted engines and never the plan tier', () => withHost(async ({ api }) => {
  const worker = await api('profile-create', { name: 'Worker', engine: 'echo' })
  await assert.rejects(api('profile-create', { name: 'Lead', engine: 'echo', lead: true }), { code: 'orch/invalid', message: '引擎 echo 暂不支持主控，主控请选择 claude、codex' })
  await assert.rejects(api('profile-create', { name: 'Lead', engine: 'claude', lead: true, permission: 'plan' }), { code: 'orch/invalid', message: '主控不能使用计划模式权限，请改选其他权限' })
  const codex = await api('profile-create', { name: 'Codex Lead', engine: 'codex', lead: true })
  assert.equal(codex.lead, true)
  await assert.rejects(api('profile-update', { id: codex.id, changes: { permission: 'plan' } }), { code: 'orch/invalid', message: '主控不能使用计划模式权限，请改选其他权限' })
  const lead = await api('profile-create', { name: 'Lead', engine: 'claude', lead: true })
  await api('profile-create', { name: 'Helper', engine: 'echo' })
  await assert.rejects(api('profile-update', { id: worker.id, changes: { lead: true } }), { code: 'orch/invalid', message: '引擎 echo 暂不支持主控；引擎创建后不能更换，请新建 claude、codex 的主控角色' })
  await assert.rejects(api('profile-update', { id: lead.id, changes: { permission: 'plan' } }), { code: 'orch/invalid', message: '主控不能使用计划模式权限，请改选其他权限' })
  // A whitelisted executor already on the plan tier cannot become the lead either.
  const planner = await api('profile-create', { name: 'Planner', engine: 'claude', permission: 'plan' })
  await assert.rejects(api('profile-update', { id: planner.id, changes: { lead: true } }), { code: 'orch/invalid', message: '主控不能使用计划模式权限，请改选其他权限' })
  await api('profile-update', { id: planner.id, changes: { lead: true, permission: 'workspace' } })
  assert.equal((await api('state')).profiles.find(item => item.id === planner.id).lead, true)
}))

for (const [label, profiles, holder] of [
  ['legacy', { a: { id: 'a' }, b: { id: 'b' } }, 'a'],
  ['invalid holders', { lead: { id: 'lead', lead: true, fallback: true }, removed: { id: 'removed', deletedAt: 1, fallback: true }, a: { id: 'a' }, b: { id: 'b', fallback: true }, c: { id: 'c', fallback: true } }, 'b'],
  ['empty roster', { lead: { id: 'lead', lead: true, fallback: true }, removed: { id: 'removed', deletedAt: 1, fallback: true } }, undefined],
]) test(`loading ${label} state repairs fallback in roster order`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-fallback-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, profiles }))
  const host = boot(home)
  try {
    const view = await host.api('state')
    assert.deepEqual(view.profiles.filter(profile => profile.fallback).map(profile => profile.id), holder ? [holder] : [])
    for (const profile of view.profiles.filter(profile => profile.id !== holder)) assert.equal(Object.hasOwn(profile, 'fallback'), false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('transferring fallback keeps the conversation, identity and driver', () => withHost(async ({ api, runtime, home }) => {
  const first = await api('profile-create', { name: 'First', engine: 'echo' })
  const second = await api('profile-create', { name: 'Second', engine: 'echo' })
  const workspace = await api('workspace-create', { name: 'Project', cwd: join(home, 'ws') })
  const session = await api('session-create', { profile: first.id, workspace: workspace.id, lazy: true })
  const rt = await runtime
  await (await rt.send(first.id, 'Question', session.id)).completion
  const before = (await api('state')).profiles.find(profile => profile.id === first.id)
  const driver = rt.driverOf(session.id), identity = rt.renderIdentity(before)
  await api('profile-update', { id: second.id, changes: { fallback: true } })
  const edited = (await api('state')).profiles.find(profile => profile.id === first.id)
  assert.deepEqual(edited.sessions, before.sessions)
  assert.equal(edited.activeSessionId, before.activeSessionId)
  assert.equal(rt.renderIdentity(edited), identity)
  assert.equal(await rt.ensureDriver(await rt.prepareConversation(session.id)), driver)
  await api('profile-update', { id: first.id, changes: { fallback: true } })
  assert.equal(await rt.ensureDriver(await rt.prepareConversation(session.id)), driver)
}))

test('deleting a role archives its sessions and preserves history, stats and references across restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-soft-delete-'))
  let host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Original project', cwd: join(home, 'ws') })
    const role = await host.api('profile-create', { name: 'Original role', engine: 'echo', engineOptions: { script: [{ kind: 'text', text: 'Saved answer' }] } })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    await host.api('send', { profile: role.id, session: session.id, text: 'Saved question' })
    const rt = await host.runtime
    await until(() => !rt.workView()[session.id]?.active)
    const history = await host.api('transcript', { profile: role.id, session: session.id })
    const reply = (await host.api('reference-replies', { profile: role.id, session: session.id })).messages[0]
    const target = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const reference = await host.api('reference-create', { target: target.id, profile: role.id, session: session.id, messageId: reply.id })
    const draft = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true, draft: true })
    const stats = structuredClone(rt.state.stats)
    let dropped = false
    rt.dropStreamDetails = async () => { dropped = true }
    assert.ok(rt.driverOf(session.id))
    await host.api('profile-delete', { id: role.id })
    assert.equal(rt.driverOf(session.id), undefined)
    assert.equal(dropped, false)
    assert.deepEqual(rt.state.stats, stats)
    const archivedHistory = await host.api('transcript', { profile: role.id, session: session.id })
    assert.deepEqual(archivedHistory.slice(0, history.length), history)
    assert.deepEqual(archivedHistory.slice(history.length).map(({ at, ...line }) => line), [{ who: 'system', kind: 'note', text: 'engine session closed' }])
    assert.equal((await host.api('reference-read', { id: reference.id, target: target.id })).messages[0].text, 'Saved answer')
    const saved = rt.state.profiles[role.id]
    assert.ok(saved.deletedAt)
    assert.ok(saved.sessions[0].archivedAt)
    assert.equal(saved.sessions[0].workspaceName, workspace.name)
    assert.equal(saved.sessions[0].profileName, role.name)
    assert.equal(saved.activeSessionId, undefined)
    assert.ok(saved.sessions.find(item => item.id === draft.id).archivedAt)
    assert.ok(saved.sessions.find(item => item.id === draft.id).draftedAt)
    assert.equal(saved.sessions.find(item => item.id === draft.id).briefSent, false)
    assert.equal(rt.findProfile(role.id), undefined)
    assert.equal(rt.findProfile(role.name), undefined)
    for (const [endpoint, payload] of [
      ['send', { profile: role.id, session: session.id, text: 'Refused' }],
      ['session-create', { profile: role.id, workspace: workspace.id, lazy: true }],
      ['session-open', { profile: role.id, session: session.id }],
      ['session-archive', { profile: role.id, session: session.id, archived: false }],
      ['profile-update', { id: role.id, changes: { name: 'Changed' } }],
    ]) assert.equal((await host.post(endpoint, payload)).ok, false, endpoint)
    await assert.rejects(rt.send(role.id, 'Refused', session.id), /read-only/)
    await assert.rejects(rt.createSession(role.id, undefined, workspace.id, true), /No such profile/)
    host.dispose()
    host = boot(home)
    const restored = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.ok(restored.deletedAt && restored.sessions[0].archivedAt)
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: session.id }), archivedHistory)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('deleted roles do not consume names, quota or roster order', () => withHost(async ({ api, post, runtime }) => {
  const removed = await api('profile-create', { name: 'Reusable', engine: 'echo' })
  await api('profile-delete', { id: removed.id })
  const roles = []
  for (let n = 0; n < MAX_PROFILES; n++) roles.push(await api('profile-create', { name: n ? `Role ${n}` : 'Reusable', engine: 'echo' }))
  assert.equal((await post('profile-create', { name: 'Over quota', engine: 'echo' })).error.code, 'orch/invalid')
  const ids = roles.map(role => role.id).reverse()
  await api('profile-order', { ids })
  const rt = await runtime
  assert.deepEqual(rt.activeProfiles().map(role => role.id), ids)
  assert.ok(rt.state.profiles[removed.id].deletedAt)
  assert.equal(rt.findProfile('Reusable').id, roles[0].id)
  assert.equal((await post('profile-order', { ids: [removed.id, ...ids.slice(1)] })).error.code, 'orch/invalid')
}))

test('display identities trim, truncate, clear and persist without migrating old cards', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-identities-'))
  let host = boot(home)
  try {
    const legacy = await host.api('profile-create', { name: 'Legacy', engine: 'echo' })
    assert.equal(Object.hasOwn(legacy, 'identity'), false)
    const card = await host.api('profile-create', { name: 'Coder', engine: 'echo', identity: '  coder  ' })
    assert.equal(card.identity, 'coder')
    const long = '身'.repeat(45)
    const created = await host.api('profile-create', { name: 'Long', engine: 'echo', identity: ` ${long} ` })
    assert.equal(created.identity, long.slice(0, 40))
    assert.equal((await host.api('profile-update', { id: card.id, changes: { identity: ` ${long} ` } })).identity, long.slice(0, 40))
    host.dispose()
    host = boot(home)
    const restored = (await host.api('state')).profiles
    assert.equal(restored.find(item => item.id === card.id).identity, long.slice(0, 40))
    assert.equal(Object.hasOwn(restored.find(item => item.id === legacy.id), 'identity'), false)
    for (const identity of ['', '   ']) {
      await host.api('profile-update', { id: card.id, changes: { identity: ' reviewer ' } })
      const cleared = await host.api('profile-update', { id: card.id, changes: { identity } })
      assert.equal(Object.hasOwn(cleared, 'identity'), false)
      assert.equal(Object.hasOwn((await host.runtime).findProfile(card.id), 'identity'), false)
    }
    const empty = await host.api('profile-create', { name: 'Empty', engine: 'echo', identity: '  ' })
    assert.equal(Object.hasOwn(empty, 'identity'), false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('editing display identity leaves prompts, conversations and the running driver unchanged', () => withHost(async ({ api, runtime, home }) => {
  const rt = await runtime
  const workspace = await api('workspace-create', { name: 'Identity', cwd: join(home, 'ws') })
  const card = await api('profile-create', { name: 'Worker', engine: 'echo', identity: 'display-only-sentinel',
    engineOptions: { script: [{ kind: 'text', text: 'Done' }] } })
  const prompt = rt.renderIdentity(card)
  assert.doesNotMatch(prompt, /display-only-sentinel/)
  const session = await api('session-create', { profile: card.id, workspace: workspace.id, lazy: true })
  await api('send', { profile: card.id, session: session.id, text: 'Question' })
  await until(() => !rt.workView()[session.id]?.active && rt.conversation(card.id, session.id).session.briefSent)
  const driver = rt.driverOf(session.id)
  const before = (await api('state')).profiles.find(item => item.id === card.id)
  for (const identity of ['reviewer', '']) {
    const edited = await api('profile-update', { id: card.id, changes: { identity } })
    assert.equal(rt.renderIdentity(edited), prompt)
    assert.deepEqual(edited.sessions, before.sessions)
    assert.equal(edited.activeSessionId, session.id)
    assert.equal(await rt.ensureDriver(await rt.prepareConversation(session.id)), driver)
  }
}))

test('lead flags normalize, persist only when true, keep the existing conversation and respawn the driver only when the flag flips', () => withHost(async ({ api, runtime, home }) => {
  const rt = await runtime
  const workspace = await api('workspace-create', { name: 'Lead flag', cwd: join(home, 'ws') })
  await api('profile-create', { name: 'Executor', engine: 'echo' })
  const profile = await api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [{ kind: 'text', text: 'Done' }] } })
  assert.equal(profile.lead, true)
  const session = await api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
  await api('send', { profile: profile.id, session: session.id, text: 'Question' })
  await until(() => !rt.workView()[session.id]?.active && rt.conversation(profile.id, session.id).session.briefSent)
  let driver = rt.driverOf(session.id), wasLead = true
  const before = (await api('state')).profiles.find(item => item.id === profile.id)
  for (const lead of [false, 1, 'yes', 'false', true, null]) {
    const edited = await api('profile-update', { id: profile.id, changes: { lead } })
    assert.equal(edited.lead, lead === true ? true : undefined)
    assert.equal(Object.hasOwn(rt.findProfile(profile.id), 'lead'), lead === true)
    assert.deepEqual(edited.sessions.map(({ updatedAt, ...item }) => item), before.sessions.map(({ updatedAt, ...item }) => item))
    assert.equal(edited.activeSessionId, session.id)
    const next = await rt.ensureDriver(await rt.prepareConversation(session.id))
    assert.equal(next === driver, (lead === true) === wasLead)
    driver = next
    wasLead = lead === true
  }
  for (const lead of [false, 1, 'yes', 'false', null]) {
    const ordinary = await api('profile-create', { name: `Ordinary ${typeof lead} ${lead}`, engine: 'echo', lead })
    assert.equal(Object.hasOwn(ordinary, 'lead'), false)
  }
}))

test('task type and hard settings persist, validate and keep the existing conversation and driver', () => withHost(async ({ api, runtime, home }) => {
  const rt = await runtime
  const workspace = await api('workspace-create', { name: 'Routing card', cwd: join(home, 'ws') })
  await assert.rejects(api('profile-create', { name: 'Router', engine: 'echo', taskTypes: ['docs', 'feature', 'docs'], hard: { model: ' hard-model ', thinking: 'high', extra: 1 } }), { code: 'orch/invalid' })
  const card = await api('profile-create', { name: 'Router', engine: 'echo', taskTypes: ['docs', 'feature', 'docs'], hard: { model: ' hard-model ', thinking: 'high' } })
  assert.deepEqual(card.taskTypes, ['docs', 'feature'])
  assert.deepEqual(card.hard, { model: 'hard-model', thinking: 'high' })
  const session = await api('session-create', { profile: card.id, workspace: workspace.id, lazy: true })
  await api('send', { profile: card.id, session: session.id, text: 'Question' })
  await until(() => !rt.workView()[session.id]?.active && rt.conversation(card.id, session.id).session.briefSent)
  const driver = rt.driverOf(session.id)
  for (const [changes, expected] of [
    [{ taskTypes: ['bug-fix'] }, { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } }],
    [{ hard: {} }, { taskTypes: ['bug-fix'], hard: {} }],
    [{ hard: null }, { taskTypes: ['bug-fix'] }],
    [{ taskTypes: null }, {}],
    [{ taskTypes: ['docs'], hard: { thinking: 'low' } }, { taskTypes: ['docs'], hard: { thinking: 'low' } }],
  ]) {
    const edited = await api('profile-update', { id: card.id, changes })
    assert.deepEqual([edited.taskTypes, edited.hard], [expected.taskTypes, expected.hard])
    assert.equal(await rt.ensureDriver(await rt.prepareConversation(session.id)), driver)
  }
  await assert.rejects(api('profile-update', { id: card.id, changes: { taskTypes: ['no-such-type'] } }), { code: 'orch/invalid' })
  await assert.rejects(api('profile-update', { id: card.id, changes: { taskTypes: 'docs' } }), { code: 'orch/invalid' })
  await assert.rejects(api('profile-update', { id: card.id, changes: { hard: { engine: 'echo' } } }), { code: 'orch/invalid' })
  await assert.rejects(api('profile-update', { id: card.id, changes: { hard: 'yes' } }), { code: 'orch/invalid' })
}))

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

test('direct roles adopt identity edits in an unsent conversation and never change engine', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Direct', cwd: join(home, 'direct-ws') })
    const profile = await api('profile-create', { name: 'Direct', engine: 'codex' })
    const session = await api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const edited = await api('profile-update', { id: profile.id, changes: { instructions: 'Standards to keep' } })
    assert.equal(edited.sessions.length, 1)
    assert.equal(edited.activeSessionId, session.id)
    assert.equal(edited.sessions[0].instructions, 'Standards to keep')
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

test('profile-order takes every id exactly once, reorders in place and persists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-order-'))
  let host = boot(home)
  try {
    const created = []
    for (const name of ['A', 'B', 'C']) created.push(await host.api('profile-create', { name, engine: 'echo' }))
    const [a, b, c] = created.map(item => item.id)
    await assert.rejects(host.api('profile-order', { ids: [a, b] }), { code: 'orch/invalid' })
    await assert.rejects(host.api('profile-order', { ids: [a, b, a] }), { code: 'orch/invalid' })
    await assert.rejects(host.api('profile-order', { ids: [a, b, 'nope'] }), { code: 'orch/invalid' })
    await assert.rejects(host.api('profile-order', { ids: 'abc' }), { code: 'orch/invalid' })
    for (const inherited of ['__proto__', 'constructor']) {
      await assert.rejects(host.api('profile-order', { ids: [inherited, b, c] }), { code: 'orch/invalid' })
    }
    assert.deepEqual((await host.api('state')).profiles.map(item => item.id), [a, b, c], 'an inherited key cannot displace a card')
    const rt = await host.runtime
    const container = rt.state.profiles
    const view = await host.api('profile-order', { ids: [c, a, b] })
    assert.deepEqual(view.map(item => item.id), [c, a, b])
    assert.equal(rt.state.profiles, container, 'the live container keeps its reference')
    assert.deepEqual(Object.keys(container), [c, a, b])
    assert.equal(container[a], rt.profilesView().find(item => item.id === a) && rt.findProfile(a), 'cards keep their identity')
    host.dispose()
    host = boot(home)
    assert.deepEqual((await host.api('state')).profiles.map(item => item.id), [c, a, b], 'the order survives a restart')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})
