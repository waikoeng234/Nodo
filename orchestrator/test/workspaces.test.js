// Legacy workspace-bound profiles remain readable; new roles can be global.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { boot, until, withHost } from './helpers/host.js'
import { IMAGE_BYTES_MAX } from '../core/src/constants.js'

test('workspace lifecycle: deletion keeps roles, conversation history and the directory', async () => {
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

    assert.equal((await post('workspace-delete', { id: 'missing' })).error.code, 'orch/not-found')
    await api('send', { profile: profile.id, text: 'build' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.equal(existsSync(join(home, 'site')), true, 'the workspace directory is created on first use')
    const history = await api('transcript', { profile: profile.id })
    assert.equal(await api('workspace-delete', { id: workspace.id }), true)
    const view = await api('state')
    assert.equal(view.workspaces.some(item => item.id === workspace.id), false)
    assert.equal(view.profiles.find(item => item.id === profile.id).workspaceId, undefined)
    assert.deepEqual(await api('transcript', { profile: profile.id }), history)
    assert.equal(existsSync(workspace.cwd), true)
  })
})

test('deleting a workspace preserves drafts and archived sessions without moving them to another workspace', async () => {
  await withHost(async ({ api, post, home, runtime }) => {
    const a = await api('workspace-create', { name: 'A', cwd: join(home, 'a') })
    const alias = await api('workspace-create', { name: 'Same directory', cwd: a.cwd })
    const b = await api('workspace-create', { name: 'B', cwd: join(home, 'b') })
    mkdirSync(a.cwd)
    writeFileSync(join(a.cwd, 'note.md'), 'Original directory')
    const role = await api('profile-create', { name: 'Shared', engine: 'echo', instructions: 'Keep this identity' })
    const first = await api('session-create', { profile: role.id, workspace: a.id, lazy: true })
    await api('session-archive', { profile: role.id, session: first.id, archived: true })
    const second = await api('session-create', { profile: role.id, workspace: b.id, lazy: true })
    const legacy = await api('profile-create', { name: 'Legacy', engine: 'echo', workspace: a.id })
    const elsewhere = await api('profile-create', { name: 'Bound to B', engine: 'echo', workspace: b.id })
    const third = await api('session-create', { profile: elsewhere.id, workspace: a.id, lazy: true })
    const rt = await runtime
    const original = rt.state.profiles[elsewhere.id].sessions.find(item => item.id === third.id)
    original.driverSessionId = 'native-thread'
    original.workspaceId = 'native-workspace'
    const unrelated = await rt.createRun({ workflowId: 'other', workflowName: 'Other', graph: { nodes: [], edges: [] }, input: { workspaceId: b.id } })
    assert.equal(await api('workspace-delete', { id: a.id }), true)
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.workspaces[a.id], undefined, 'the workspace record is actually deleted')
    assert.equal(Object.keys(saved.profiles).length, 3)
    assert.equal(saved.profiles[legacy.id].workspaceId, undefined)
    assert.equal(saved.profiles[elsewhere.id].workspaceId, b.id)
    assert.equal(saved.profiles[role.id].instructions, 'Keep this identity')
    assert.equal(saved.profiles[role.id].sessions.find(item => item.id === first.id).archivedAt > 0, true)
    assert.equal(saved.profiles[role.id].sessions.find(item => item.id === second.id).workspaceRef, b.id)
    assert.equal(original.driverSessionId, 'native-thread')
    assert.equal(original.workspaceId, 'native-workspace')
    for (const profile of [rt.state.profiles[role.id], rt.state.profiles[legacy.id], rt.state.profiles[elsewhere.id]]) {
      const session = rt.sessionsOf(profile).find(item => item.workspaceRef === a.id)
      assert.ok(session.archivedAt)
      assert.equal(session.workspaceName, a.name)
      assert.equal(session.cwd, a.cwd, 'even an unsent session keeps its original directory')
      assert.equal(rt.sessionWorkspace(profile, session).id, a.id)
      assert.notEqual(rt.sessionWorkspace(profile, session).id, alias.id)
    }
    assert.equal(rt.state.profiles[elsewhere.id].activeSessionId, elsewhere.id, 'the retained legacy conversation in B becomes active')
    assert.equal(rt.state.profiles[role.id].activeSessionId, second.id)
    assert.equal(rt.state.profiles[role.id].sessions.find(item => item.id === second.id).archivedAt, undefined)
    for (const endpoint of ['send', 'session-open', 'session-archive', 'session-update', 'session-compact']) {
      assert.equal((await post(endpoint, { profile: elsewhere.id, session: third.id, text: 'Read-only', archived: false, changes: { model: 'blocked' } })).ok, false, endpoint)
    }
    assert.equal((await rt.prepareConversation(third.id)).cwd, realpathSync(a.cwd))
    assert.equal((await api('workspace-file', { profile: elsewhere.id, session: third.id, path: 'note.md' })).text, 'Original directory')
    assert.equal((await post('session-create', { profile: elsewhere.id, workspace: a.id, lazy: true })).ok, false, 'a new conversation cannot use the deleted workspace')
    assert.equal((await post('workspace-delete', { id: a.id })).error.code, 'orch/not-found')
    assert.equal((await rt.loadRun(unrelated.id)).status, 'running')
    assert.equal(existsSync(join(a.cwd, 'note.md')), true)
  })
})

test('workspace deletion refuses running tasks without changing role bindings', async () => {
  await withHost(async ({ api, post, home, runtime }) => {
    const workspace = await api('workspace-create', { name: 'Busy', cwd: join(home, 'busy') })
    const role = await api('profile-create', { name: 'Waiting', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'ask' }] } })
    await api('send', { profile: role.id, text: 'Wait for permission' })
    await until(async () => (await api('state')).approvals.length > 0)
    assert.equal((await post('workspace-delete', { id: workspace.id })).error.code, 'orch/busy')
    const rt = await runtime
    assert.equal(rt.state.profiles[role.id].workspaceId, workspace.id)
    await api('interrupt', { profile: role.id })
    await until(async () => !(await api('state')).work[role.id]?.active)
    assert.equal(await api('workspace-delete', { id: workspace.id }), true)
    assert.ok(rt.state.profiles[role.id])
  })
})

for (const reference of ['pinned', 'session', 'role']) {
  test(`workspace deletion waits for an unfinished workflow using its ${reference}`, async () => {
    await withHost(async ({ api, post, home, runtime }) => {
      const workspace = await api('workspace-create', { name: 'Flow', cwd: join(home, 'flow') })
      const role = await api('profile-create', { name: 'Flow role', engine: 'echo' })
      const session = await api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
      const rt = await runtime
      const run = await rt.createRun({ workflowId: 'fixture', workflowName: 'Fixture', graph: { nodes: [], edges: [] },
        profiles: reference === 'role' ? { [role.id]: {} } : {}, input: reference === 'pinned' ? { workspaceId: workspace.id } : {} })
      if (reference === 'session') await rt.commit(run.id, draft => { draft.attempts.first = { sessionId: session.id } })
      assert.equal((await post('workspace-delete', { id: workspace.id })).error.code, 'orch/busy')
      await rt.commit(run.id, draft => { draft.status = 'needs_reconcile' })
      assert.equal((await post('workspace-delete', { id: workspace.id })).error.code, 'orch/busy')
      await rt.commit(run.id, draft => { draft.status = 'cancelled' })
      assert.equal(await api('workspace-delete', { id: workspace.id }), true)
      assert.ok(rt.state.profiles[role.id])
      assert.equal((await rt.loadRun(run.id)).status, 'cancelled')
    })
  })
}

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

test('workspace-dir lists one sorted level including dotfiles and node_modules, confines links and truncates at 1000', async () => {
  await withHost(async ({ api, post, home }) => {
    const root = join(home, 'browse')
    mkdirSync(root)
    for (const name of ['z-dir', 'a-dir', '.git', 'node_modules']) mkdirSync(join(root, name))
    for (const name of ['z.txt', 'a.txt', '.env']) writeFileSync(join(root, name), name)
    writeFileSync(join(root, 'a-dir', 'nested.txt'), 'nested')
    writeFileSync(join(home, 'outside.txt'), 'outside')
    symlinkSync(join(root, 'a-dir'), join(root, 'linked-dir'))
    symlinkSync(join(root, 'a.txt'), join(root, 'linked.txt'))
    symlinkSync(home, join(root, 'escape-dir'))
    symlinkSync(join(home, 'outside.txt'), join(root, 'escape.txt'))
    symlinkSync(join(root, 'gone'), join(root, 'broken'))
    const workspace = await api('workspace-create', { name: 'Browse', cwd: root })
    const profile = await api('profile-create', { name: 'Browser', engine: 'echo', workspace: workspace.id })
    const request = { profile: profile.id, path: '' }
    assert.deepEqual(await api('workspace-dir', request), { entries: [
      { name: 'a-dir', kind: 'dir' }, { name: 'linked-dir', kind: 'dir' }, { name: 'node_modules', kind: 'dir' }, { name: 'z-dir', kind: 'dir' },
      { name: '.env', kind: 'file' }, { name: 'a.txt', kind: 'file' }, { name: 'linked.txt', kind: 'file' }, { name: 'z.txt', kind: 'file' },
    ] })
    assert.deepEqual((await api('workspace-dir', { ...request, path: 'linked-dir' })).entries, [{ name: 'nested.txt', kind: 'file' }])
    for (const path of ['..', '../browse-other', 'escape-dir']) assert.equal((await post('workspace-dir', { ...request, path })).error.code, 'orch/invalid')
    assert.equal((await post('workspace-dir', { ...request, path: 'gone' })).error.code, 'orch/not-found')
    assert.equal((await post('workspace-dir', { ...request, path: 'a.txt' })).error.code, 'orch/not-found')
    for (let i = 0; i < 1001; i++) writeFileSync(join(root, 'a-dir', `file-${String(i).padStart(4, '0')}`), '')
    const large = await api('workspace-dir', { ...request, path: 'a-dir' })
    assert.equal(large.entries.length, 1000)
    assert.equal(large.truncated, true)
    assert.deepEqual(large.entries[0], { name: 'file-0000', kind: 'file' })
    assert.deepEqual(large.entries.at(-1), { name: 'file-0999', kind: 'file' })
  })
})

test('workspace-dir and workspace-file use the selected session cwd and worktree even on a read-only host', async () => {
  await withHost(async ({ api, home, runtime }) => {
    const rt = await runtime
    const roots = ['main', 'worktree', 'session-cwd'].map(name => join(home, name))
    for (const root of roots) { mkdirSync(root); writeFileSync(join(root, 'note.txt'), root) }
    const main = await api('workspace-create', { name: 'Main', cwd: roots[0] })
    const branch = await rt.createWorkspace({ name: 'Branch', cwd: roots[1], worktree: { parent: main.id } })
    const role = await api('profile-create', { name: 'Reader', engine: 'echo', workspace: main.id })
    const session = await api('session-create', { profile: role.id, workspace: branch.id, lazy: true })
    const request = { profile: role.id, session: session.id }
    assert.equal((await api('workspace-file', { ...request, path: 'note.txt' })).text, roots[1])
    const record = rt.state.profiles[role.id].sessions.find(item => item.id === session.id)
    record.cwd = roots[2]
    await rt.save()
    writeFileSync(join(roots[2], 'session-only.txt'), 'own')
    rt.readOnly = () => 'Fixture read-only'
    assert.deepEqual((await api('workspace-dir', { ...request, path: '' })).entries.map(item => item.name), ['note.txt', 'session-only.txt'])
    assert.equal((await api('workspace-file', { ...request, path: 'note.txt' })).text, roots[2])
  })
})

test('workspace-dir maps permission errors to a path-free refusal without recording an internal diagnostic', async () => {
  await withHost(async ({ api, post, home }) => {
    const root = join(home, 'restricted')
    const locked = join(root, 'locked')
    mkdirSync(join(locked, 'nested'), { recursive: true })
    const workspace = await api('workspace-create', { name: 'Restricted', cwd: root })
    const profile = await api('profile-create', { name: 'Reader', engine: 'echo', workspace: workspace.id })
    const before = await api('diag')
    chmodSync(locked, 0o000)
    try {
      for (const path of ['locked', 'locked/nested']) {
        const result = await post('workspace-dir', { profile: profile.id, path })
        assert.equal(result.ok, false)
        assert.deepEqual(result.error, { code: 'orch/invalid', message: '目录不可读', details: {} })
        assert.equal(JSON.stringify(result).includes(root), false)
      }
      assert.deepEqual(await api('diag'), before)
    } finally { chmodSync(locked, 0o755) }
    assert.deepEqual((await api('workspace-dir', { profile: profile.id, path: 'locked' })).entries, [{ name: 'nested', kind: 'dir' }])
  })
})

test('workspace directory and file paths reject null bytes before touching the filesystem', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Null path', cwd: join(home, 'null-path') })
    const profile = await api('profile-create', { name: 'Reader', engine: 'echo', workspace: workspace.id })
    const before = await api('diag')
    for (const endpoint of ['workspace-dir', 'workspace-file']) {
      const result = await post(endpoint, { profile: profile.id, path: 'bad\0path' })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'orch/invalid')
      assert.equal(JSON.stringify(result).includes(home), false)
    }
    assert.deepEqual(await api('diag'), before)
  })
})

test('workspace-file returns common images as data URLs through IMAGE_BYTES_MAX and larger images as binary', async () => {
  await withHost(async ({ api, home }) => {
    const root = join(home, 'images')
    mkdirSync(root)
    const workspace = await api('workspace-create', { name: 'Images', cwd: root })
    const profile = await api('profile-create', { name: 'Viewer', engine: 'echo', workspace: workspace.id })
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
    const bytes = Buffer.from([0x89, 0, 0x50, 0x4e, 0x47])
    for (const [extension, mediaType] of Object.entries(types)) {
      const path = `image.${extension.toUpperCase()}`
      writeFileSync(join(root, path), bytes)
      const read = await api('workspace-file', { profile: profile.id, path })
      assert.deepEqual(read.image, { mediaType, dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}` })
      assert.equal(read.text, undefined)
    }
    writeFileSync(join(root, 'limit.png'), Buffer.alloc(IMAGE_BYTES_MAX))
    assert.equal((await api('workspace-file', { profile: profile.id, path: 'limit.png' })).image.dataUrl.length, 'data:image/png;base64,'.length + Math.ceil(IMAGE_BYTES_MAX / 3) * 4)
    writeFileSync(join(root, 'large.png'), Buffer.alloc(IMAGE_BYTES_MAX + 1))
    assert.deepEqual(await api('workspace-file', { profile: profile.id, path: 'large.png' }), { path: join(root, 'large.png'), binary: true })
  })
})
