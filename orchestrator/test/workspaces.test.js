// Legacy workspace-bound profiles remain readable; new roles can be global.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { boot, until, withHost } from './helpers/host.js'

test('workspace lifecycle: create validates, rename to same name, profiles pin it, empty deletes', async () => {
  await withHost(async ({ api, post, home }) => {
    assert.equal((await post('workspace-create', { name: 'Bad', cwd: '.' })).error.code, 'orch/invalid')
    const workspace = await api('workspace-create', { name: 'Site', cwd: join(home, 'site') })
    assert.equal((await post('workspace-create', { name: 'site', cwd: join(home, 'other') })).error.code, 'orch/invalid')
    assert.equal((await api('workspace-update', { id: workspace.id, changes: { name: 'Site' } })).name, 'Site')

    const globalRole = await api('profile-create', { name: 'NoDesk', engine: 'echo' })
    assert.equal(globalRole.workspaceId, undefined)
    assert.deepEqual(globalRole.sessions, [])
    assert.equal((await post('profile-create', { name: 'Ghost', engine: 'echo', workspace: 'ghost' })).error.code, 'orch/invalid')
    const profile = await api('profile-create', { name: 'Fixture Coder', engine: 'echo', workspace: 'site' })
    assert.equal(profile.workspaceId, workspace.id)
    assert.equal(profile.cwd, workspace.cwd)

    assert.equal((await post('workspace-delete', { id: workspace.id })).error.code, 'orch/busy')
    await api('send', { profile: profile.id, text: 'build' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.equal(existsSync(join(home, 'site')), true, 'the workspace directory is created on first use')
    await api('profile-delete', { id: profile.id })
    assert.equal(await api('workspace-delete', { id: workspace.id }), true)
  })
})

test('editing a workspace cwd moves its roles and restarts their conversations', async () => {
  await withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Mover', cwd: join(home, 'before') })
    const profile = await api('profile-create', { name: 'Fixture Coder', engine: 'echo', workspace: workspace.id })
    await api('send', { profile: profile.id, text: 'first' })
    await until(async () => !(await api('state')).work[profile.id].active)
    const moved = await api('workspace-update', { id: workspace.id, changes: { cwd: join(home, 'after') } })
    assert.equal(moved.cwd, join(home, 'after'))
    const view = (await api('state')).profiles.find(item => item.id === profile.id)
    assert.equal(view.cwd, join(home, 'after'), 'the role follows its workspace')
    assert.equal(view.sessions.at(-1).cwd, undefined, 'a fresh conversation has no directory of its own yet')
  })
})

test('the @-context search lists workspace files relative to its directory', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Files', cwd: join(home, 'tree') })
    mkdirSync(join(home, 'tree', 'src', 'deep'), { recursive: true })
    mkdirSync(join(home, 'tree', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(home, 'tree', 'README.md'), 'x')
    writeFileSync(join(home, 'tree', 'src', 'main.js'), 'x')
    writeFileSync(join(home, 'tree', 'src', 'deep', 'needle.txt'), 'x')
    writeFileSync(join(home, 'tree', 'node_modules', 'pkg', 'index.js'), 'x')
    const all = (await api('workspace-files', { workspace: workspace.id, query: '' })).files
    assert.deepEqual([...all], ['README.md', 'src/deep/needle.txt', 'src/main.js'], 'dependencies and dot entries stay out')
    assert.equal((await api('workspace-files', { workspace: workspace.id, query: 'NEEDLE' })).files[0], 'src/deep/needle.txt')
    assert.equal((await post('workspace-files', { workspace: 'ghost' })).error.code, 'orch/invalid')
  })
})

test('v1 state migrates: shared cwds become one workspace, cwd-less profiles keep a private one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-migrate-'))
  const shared = join(home, 'shared')
  const v1 = {
    version: 1,
    profiles: {
      a: { id: 'a', name: 'Coder', role: '', engine: 'echo', cwd: shared, env: [], engineOptions: {}, instructions: '', createdAt: 1, updatedAt: 1 },
      b: { id: 'b', name: 'Reviewer', role: '', engine: 'echo', cwd: shared, env: [], engineOptions: {}, instructions: '', createdAt: 1, updatedAt: 1 },
      c: { id: 'c', name: 'Solo', role: '', engine: 'echo', env: [], engineOptions: {}, instructions: '', createdAt: 1, updatedAt: 1 },
    },
    transcripts: {}, workflows: {}, prefs: {}, probe: null, revision: 1,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(v1))
  const host = boot(home)
  try {
    const state = await host.api('state')
    assert.equal(state.workspaces.length, 2)
    const [coder, reviewer, solo] = ['a', 'b', 'c'].map(id => state.profiles.find(item => item.id === id))
    assert.equal(coder.workspaceId, reviewer.workspaceId, 'profiles that shared a cwd share a workspace')
    assert.equal(coder.cwd, shared)
    assert.notEqual(solo.workspaceId, coder.workspaceId)
    assert.equal(solo.cwd, join(home, 'workspaces', 'c'), 'a cwd-less profile keeps its private directory')
    const soloWorkspace = state.workspaces.find(item => item.id === solo.workspaceId)
    assert.equal(soloWorkspace.name, 'Solo')
    await host.api('workspace-create', { name: 'Extra', cwd: join(home, 'extra') }) // forces a save
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.version, 2)
    assert.ok(saved.workspaces[solo.workspaceId] !== undefined)
    for (const profile of Object.values(saved.profiles)) assert.equal('cwd' in profile, false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('workspace-file reads one conversation file inside the workspace, bounded and contained', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Reader', cwd: join(home, 'reader') })
    const profile = await api('profile-create', { name: 'Fixture Coder', engine: 'echo', workspace: workspace.id })
    mkdirSync(join(home, 'reader'), { recursive: true })
    writeFileSync(join(home, 'reader', 'note.md'), 'body line')
    writeFileSync(join(home, 'reader', 'blob.bin'), Buffer.from([0x62, 0, 0x64]))
    writeFileSync(join(home, 'reader', 'big.txt'), 'x'.repeat(512 * 1024 + 10))
    await api('send', { profile: profile.id, text: 'first' })
    await until(async () => !(await api('state')).work[profile.id].active)
    const state = await api('state')
    const session = state.profiles.find(item => item.id === profile.id).sessions.at(-1).id
    const read = await api('workspace-file', { profile: profile.id, session, path: 'note.md' })
    assert.equal(read.text, 'body line')
    assert.equal(read.truncated, undefined)
    assert.equal((await api('workspace-file', { profile: profile.id, session, path: 'blob.bin' })).binary, true)
    const big = await api('workspace-file', { profile: profile.id, session, path: 'big.txt' })
    assert.equal(big.truncated, true)
    assert.equal(big.text.length, 512 * 1024)
    assert.equal((await api('workspace-file', { profile: profile.id, session, path: 'ghost.md' })).missing, true)
    assert.equal((await api('workspace-file', { target: session, path: 'note.md' })).text, 'body line', 'the native session id resolves to the same conversation')
    assert.equal((await post('workspace-file', { profile: profile.id, session, path: '../outside.txt' })).error.code, 'orch/invalid')
    assert.equal((await post('workspace-file', { profile: profile.id, session })).error.code, 'orch/invalid')
    assert.equal((await post('workspace-file', { target: 'no-such-native', path: 'note.md' })).error.code, 'orch/not-found')
  })
})

test('workspace-file follows links only inside the workspace and redacts saved keys', async () => {
  await withHost(async ({ api, post, home }) => {
    await api('secret-set', { name: 'FIXTURE_KEY', value: 'fake-workspace-value-01' })
    const root = join(home, 'linked')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(home, 'outside.txt'), 'outside')
    writeFileSync(join(root, '..note.md'), 'key fake-workspace-value-01')
    symlinkSync(join(home, 'outside.txt'), join(root, 'escape.txt'))
    symlinkSync(join(root, '..note.md'), join(root, 'alias.md'))
    const workspace = await api('workspace-create', { name: 'Linked', cwd: root })
    const profile = await api('profile-create', { name: 'Fixture Reader', engine: 'echo', workspace: workspace.id })
    assert.equal((await post('workspace-file', { profile: profile.id, path: 'escape.txt' })).error.code, 'orch/invalid')
    assert.equal((await api('workspace-file', { profile: profile.id, path: '..note.md' })).text, 'key [secret:FIXTURE_KEY]')
    assert.equal((await api('workspace-file', { profile: profile.id, path: 'alias.md' })).text, 'key [secret:FIXTURE_KEY]')
  })
})
