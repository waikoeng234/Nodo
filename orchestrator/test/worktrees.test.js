import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until, withHost } from './helpers/host.js'

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const makeRepo = home => {
  const repo = join(home, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'nodo@example.test'])
  git(repo, ['config', 'user.name', 'Nodo Test'])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['branch', 'feat/login'])
  git(repo, ['tag', 'v1'])
  return repo
}

test('worktree refs and creation are host-level and engine-neutral', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const refs = await api('worktree-refs', { workspace: workspace.id })
    assert.equal(refs.head.name, 'main')
    assert.deepEqual(refs.branches.map(item => item.name), ['main', 'feat/login'])
    assert.deepEqual(refs.tags.map(item => item.name), ['v1'])
    assert.ok(refs.branches.find(item => item.name === 'main').checkedOutAt, 'the main checkout is reported as occupied')
    assert.equal(refs.branches.find(item => item.name === 'feat/login').checkedOutAt, undefined)
    assert.equal((await api('worktree-refs', { workspace: workspace.id, query: 'login' })).branches[0].name, 'feat/login')

    writeFileSync(join(repo, 'untracked.txt'), 'source only\n')
    const created = await api('worktree-create', {
      workspace: workspace.id, branch: 'nodo/test', from: 'feat/login', name: 'Task A',
    })
    assert.equal(created.workspace.name, 'Task A')
    assert.equal(created.workspace.cwd, realpathSync(join(repo, '.nodo', 'worktrees', 'nodo', 'test')))
    assert.deepEqual(created.workspace.worktree, {
      repositoryRoot: refs.repositoryRoot, branch: 'nodo/test', baseCommit: created.workspace.worktree.baseCommit, mode: 'new', sourceWorkspaceRef: workspace.id,
    })
    assert.equal(created.worktree.path, created.workspace.cwd)
    assert.equal(readFileSync(join(created.workspace.cwd, 'README.md'), 'utf8'), 'base\n')
    assert.equal(existsSync(join(created.workspace.cwd, 'untracked.txt')), false, 'untracked source files stay behind')
    assert.equal(git(repo, ['rev-parse', 'refs/heads/nodo/test']), git(repo, ['rev-parse', 'feat/login']))
    assert.equal(readFileSync(join(repo, '.nodo', 'worktrees', '.gitignore'), 'utf8'), '*\n')
    assert.equal(git(repo, ['status', '--porcelain', '--', '.nodo']), '', 'the worktree pool ignores itself')
    const after = await api('worktree-refs', { workspace: workspace.id })
    assert.equal(after.branches.find(item => item.name === 'nodo/test').checkedOutAt, created.workspace.cwd)

    const role = await api('profile-create', { name: 'Worktree coder', engine: 'echo' })
    const session = await api('session-create', { profile: role.id, workspace: created.workspace.id, lazy: true })
    assert.equal(session.workspaceRef, created.workspace.id, 'the same workspace is usable by any role/engine')
    const state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === created.workspace.id).worktree.branch, 'nodo/test')
  })
})

test('worktree validation refuses non-repositories, duplicate names and branches', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const outside = join(home, 'outside')
    mkdirSync(outside)
    const nonRepo = await api('workspace-create', { name: 'Plain', cwd: outside })
    await assert.rejects(api('worktree-refs', { workspace: nonRepo.id }), /不是 Git 工作区/)
    assert.equal((await api('workspace-create', { name: 'Forged', cwd: join(home, 'forged'),
      worktree: { branch: 'forged' } })).worktree, undefined, 'ordinary workspace creation cannot forge worktree metadata')

    await api('workspace-create', { name: 'Taken', cwd: join(home, 'taken') })
    await assert.rejects(api('worktree-create', {
      workspace: workspace.id, branch: 'nodo/conflict', from: 'HEAD', name: 'Taken',
    }), /already|已存在|占用/)
    assert.throws(() => git(repo, ['show-ref', '--verify', 'refs/heads/nodo/conflict']), 'name preflight happens before creating the branch')

    assert.throws(() => git(repo, ['show-ref', '--verify', 'refs/heads/nodo/bad']))
    await assert.rejects(api('worktree-create', { workspace: workspace.id, branch: 'nodo/bad..name', from: 'HEAD' }), /分支名/)
    await assert.rejects(api('worktree-create', { workspace: workspace.id, branch: 'main', from: 'HEAD' }), /分支已存在/)
    assert.throws(() => git(repo, ['show-ref', '--verify', 'refs/heads/nodo/bad']))

    mkdirSync(join(repo, '.nodo', 'worktrees', 'nodo', 'occupied'), { recursive: true })
    await assert.rejects(api('worktree-create', { workspace: workspace.id, branch: 'nodo/occupied', from: 'HEAD' }), /目录已存在/)
    assert.throws(() => git(repo, ['show-ref', '--verify', 'refs/heads/nodo/occupied']))
  })
})

test('existing-branch mode checks out a free branch and refuses occupied or unknown branches', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    git(repo, ['branch', 'feat/available'])
    const workspace = await api('workspace-create', { name: 'Existing', cwd: repo })
    const refs = await api('worktree-refs', { workspace: workspace.id })
    assert.ok(refs.branches.find(item => item.name === 'main').checkedOutAt)
    assert.equal(refs.branches.find(item => item.name === 'feat/available').checkedOutAt, undefined)

    await assert.rejects(api('worktree-create', {
      workspace: workspace.id, mode: 'existing', branch: 'main',
    }), /已在.*检出/)
    await assert.rejects(api('worktree-create', {
      workspace: workspace.id, mode: 'existing', branch: 'feat/missing',
    }), /分支不存在/)
    await assert.rejects(api('worktree-create', {
      workspace: workspace.id, mode: 'unknown', branch: 'feat/new',
    }), /模式/)

    const created = await api('worktree-create', {
      workspace: workspace.id, mode: 'existing', branch: 'feat/available',
    })
    assert.equal(created.worktree.mode, 'existing')
    assert.equal(git(created.workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/available')
    assert.equal(readFileSync(join(created.workspace.cwd, 'README.md'), 'utf8'), 'base\n')
    const after = await api('worktree-refs', { workspace: workspace.id })
    assert.equal(after.branches.find(item => item.name === 'feat/available').checkedOutAt, created.workspace.cwd)
    await assert.rejects(api('worktree-create', {
      workspace: workspace.id, mode: 'existing', branch: 'feat/available',
    }), /已在.*检出/)
  })
})

test('worktree checkout disables configured smudge filters', { skip: process.platform === 'win32' }, async () => {
  await withHost(async ({ api, home }) => {
    const repo = join(home, 'filtered')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'nodo@example.test'])
    git(repo, ['config', 'user.name', 'Nodo Test'])
    writeFileSync(join(repo, '.gitattributes'), '*.secret filter=evil\n')
    writeFileSync(join(repo, 'payload.secret'), 'payload\n')
    git(repo, ['config', 'filter.evil.clean', 'cat'])
    git(repo, ['config', 'filter.evil.smudge', 'sh -c "touch smudge-ran"'])
    git(repo, ['add', '.gitattributes', 'payload.secret'])
    git(repo, ['commit', '-qm', 'filtered'])
    const workspace = await api('workspace-create', { name: 'Filtered', cwd: repo })
    const created = await api('worktree-create', { workspace: workspace.id, branch: 'nodo/no-smudge', from: 'HEAD' })
    assert.equal(existsSync(join(created.workspace.cwd, 'smudge-ran')), false, 'the checkout must not execute repository filters')
    assert.equal(readFileSync(join(created.workspace.cwd, 'payload.secret'), 'utf8'), 'payload\n')
  })
})

test('a workspace inside an existing linked worktree still pools under the main checkout', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    const linked = join(home, 'linked')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'side', linked, 'main'])
    const workspace = await api('workspace-create', { name: 'Linked', cwd: linked })
    const refs = await api('worktree-refs', { workspace: workspace.id })
    assert.equal(refs.head.name, 'side')
    assert.equal(refs.branches.find(item => item.name === 'side').checkedOutAt, realpathSync(linked))
    const created = await api('worktree-create', { workspace: workspace.id, branch: 'nodo/nested' })
    assert.equal(created.workspace.cwd.startsWith(join(realpathSync(repo), '.nodo', 'worktrees')), true)
    assert.equal(created.worktree.baseCommit, git(repo, ['rev-parse', 'side']), 'HEAD means the calling worktree\'s HEAD')
  })
})

test('task worktrees branch from the source HEAD and removeWorktree undoes them fully', async () => {
  await withHost(async ({ api, home, runtime }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const rt = await runtime
    const created = await rt.createTaskWorktree({ workspaceRef: workspace.id })
    const branch = created.workspace.worktree.branch
    assert.match(branch, /^nodo\/task-[0-9a-f]{8}$/)
    assert.equal(created.workspace.cwd, realpathSync(join(repo, '.nodo', 'worktrees', 'nodo', branch.slice('nodo/'.length))))
    assert.deepEqual(created.workspace.worktree, {
      repositoryRoot: realpathSync(repo), branch, baseCommit: git(repo, ['rev-parse', 'HEAD']), mode: 'new', sourceWorkspaceRef: workspace.id,
    })
    assert.equal(created.worktree.path, created.workspace.cwd)
    assert.equal(readFileSync(join(created.workspace.cwd, 'README.md'), 'utf8'), 'base\n')
    assert.ok(git(repo, ['worktree', 'list', '--porcelain']).includes(created.workspace.cwd))

    const role = await api('profile-create', { name: 'Worktree worker', engine: 'echo' })
    const shared = await api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const isolated = await api('session-create', { profile: role.id, workspace: created.workspace.id, lazy: true })

    await rt.removeWorktree(created.workspace.id)
    const archived = rt.conversationOf(isolated.id).session
    assert.ok(archived.archivedAt)
    assert.equal(archived.cwd, created.workspace.cwd)
    assert.equal(archived.workspaceName, created.workspace.name)
    assert.equal(rt.conversationOf(shared.id).session.archivedAt, undefined)
    assert.equal(rt.state.profiles[role.id].activeSessionId, shared.id)
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(created.workspace.cwd), false)
    assert.throws(() => git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]), 'the generated branch is deleted')
    const state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === created.workspace.id), undefined)
    assert.equal(readFileSync(join(repo, '.nodo', 'worktrees', '.gitignore'), 'utf8'), '*\n', 'the pool .gitignore survives removal')
  })
})

test('worktrees display under their source project; legacy records resolve through the repository root', async () => {
  await withHost(async ({ api, home, runtime }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const rt = await runtime
    const manual = await api('worktree-create', { workspace: workspace.id, branch: 'nodo/manual' })
    const nested = await api('worktree-create', { workspace: manual.workspace.id, branch: 'nodo/nested' })
    let state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === manual.workspace.id).worktree.project, workspace.id)
    assert.equal(state.workspaces.find(item => item.id === nested.workspace.id).worktree.project, workspace.id,
      'a worktree cut from a worktree anchors at the top project')

    // Records saved before the source id existed resolve through the repository
    // root, covering the symlinked-path mismatch the root's realpath settles.
    for (const id of [manual.workspace.id, nested.workspace.id]) delete rt.state.workspaces[id].worktree.sourceWorkspaceRef
    state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === manual.workspace.id).worktree.project, workspace.id,
      'a legacy record matches its repository root against the project directory')
    assert.equal(state.workspaces.find(item => item.id === nested.workspace.id).worktree.project, workspace.id)

    // A dangling source id falls back the same way; nothing matching leaves the
    // worktree — and any chain through it — its own project again.
    rt.state.workspaces[manual.workspace.id].worktree.sourceWorkspaceRef = 'gone'
    rt.state.workspaces[nested.workspace.id].worktree.sourceWorkspaceRef = manual.workspace.id
    state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === manual.workspace.id).worktree.project, workspace.id)
    rt.state.workspaces[manual.workspace.id].worktree.repositoryRoot = join(home, 'moved-away')
    state = await api('state')
    assert.equal(state.workspaces.find(item => item.id === manual.workspace.id).worktree.project, null)
    assert.equal(state.workspaces.find(item => item.id === nested.workspace.id).worktree.project, null)

    // The fallback reads the one realpath table a view builds, not the filesystem.
    rt.state.workspaces[manual.workspace.id].worktree.repositoryRoot = workspace.cwd
    const record = rt.state.workspaces[manual.workspace.id]
    assert.equal(rt.worktreeProjectOf(record, new Map([[workspace.id, [workspace.cwd, workspace.cwd]]])), workspace.id,
      'the per-view realpath table drives the fallback')
    assert.equal(rt.worktreeProjectOf(record, new Map()), null, 'an empty table leaves the worktree unowned')
  })
})

test('deleting a project takes its worktrees: refused while their sessions run, archived when idle', async () => {
  await withHost(async ({ api, home, runtime }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const manual = await api('worktree-create', { workspace: workspace.id, branch: 'nodo/manual' })
    await runtime
    const role = await api('profile-create', { name: 'Worker', engine: 'echo', engineOptions: { script: [{ kind: 'ask' }] } })
    const shared = await api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const isolated = await api('session-create', { profile: role.id, workspace: manual.workspace.id, lazy: true })
    await api('send', { profile: role.id, session: isolated.id, text: 'Wait for permission' })
    await until(async () => (await api('state')).approvals.length > 0)
    await assert.rejects(api('workspace-delete', { id: workspace.id }), error => error.code === 'orch/busy',
      'a running worktree session blocks its project')
    await assert.rejects(api('workspace-delete', { id: manual.workspace.id }), error => error.code === 'orch/busy',
      'the running session blocks its own worktree too')
    await api('interrupt', { profile: role.id, session: isolated.id })
    await until(async () => !(await api('state')).work[isolated.id]?.active)
    assert.equal(await api('workspace-delete', { id: workspace.id }), true)
    const state = await api('state')
    assert.equal(state.workspaces.some(item => [workspace.id, manual.workspace.id].includes(item.id)), false,
      'the project and its worktree records are both gone')
    const profile = state.profiles.find(item => item.id === role.id)
    assert.ok(profile.sessions.find(item => item.id === isolated.id).archivedAt, 'the worktree session is archived with its project')
    assert.ok(profile.sessions.find(item => item.id === shared.id).archivedAt)
    assert.equal(profile.workspaceId, undefined)
    assert.ok(git(repo, ['worktree', 'list', '--porcelain']).includes(manual.workspace.cwd), 'the checkout itself is kept')
  })
})

test('task worktree rollback warnings do not replace the creation error', async () => {
  await withHost(async ({ api, home, runtime }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const rt = await runtime
    const create = rt.createWorkspace, save = rt.save
    const originalError = new Error('Registration failed')
    const warnings = []
    rt.warn = (...args) => warnings.push(args.join(' '))
    rt.createWorkspace = async () => { throw originalError }
    rt.save = async () => { throw new Error('Rollback save failed') }
    try {
      await assert.rejects(rt.createTaskWorktree({ workspaceRef: workspace.id }), error => error === originalError)
      assert.ok(warnings.some(message => message.includes('worktree rollback failed') && message.includes('Rollback save failed')))
      assert.equal(git(repo, ['branch', '--list', 'nodo/task-*']), '')
    } finally { rt.createWorkspace = create; rt.save = save }
  })
})

for (const phase of ['registration', 'save']) test(`task worktree ${phase} failure rolls back the checkout and branch`, async () => {
  await withHost(async ({ api, home, runtime }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    const rt = await runtime
    const method = phase === 'registration' ? 'createWorkspace' : 'save'
    const original = rt[method]
    let destination
    rt[method] = async (...args) => {
      destination ??= args[0]?.cwd ?? Object.values(rt.state.workspaces).find(item => item.worktree)?.cwd
      throw new Error(`${phase} failed`)
    }
    await assert.rejects(rt.createTaskWorktree({ workspaceRef: workspace.id }), new RegExp(`${phase} failed`))
    rt[method] = original
    assert.ok(destination)
    assert.equal(existsSync(destination), false)
    assert.equal(git(repo, ['branch', '--list', 'nodo/task-*']), '')
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).includes(destination), false)
    assert.equal(Object.values(rt.state.workspaces).some(item => item.cwd === destination), false)
  })
})

test('workspace git status reports the branch and diff size, and switching refuses unknown branches', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    const workspace = await api('workspace-create', { name: 'Repo', cwd: repo })
    assert.deepEqual(await api('workspace-git', { workspace: workspace.id }), {
      git: true, cwd: workspace.cwd, head: { name: 'main', commit: git(repo, ['rev-parse', '--short', 'HEAD']) }, files: 0, added: 0, removed: 0 })
    writeFileSync(join(repo, 'README.md'), 'base\nmore\nlines\n')
    writeFileSync(join(repo, 'new.txt'), 'untracked\n')
    const dirty = await api('workspace-git', { workspace: workspace.id })
    assert.deepEqual([dirty.files, dirty.added, dirty.removed], [1, 2, 0], 'files counts the tracked changes the line numbers describe, not untracked entries')
    const switched = await api('workspace-switch', { workspace: workspace.id, branch: 'feat/login' })
    assert.equal(switched.head.name, 'feat/login')
    assert.equal(git(repo, ['symbolic-ref', '--short', 'HEAD']), 'feat/login')
    await assert.rejects(api('workspace-switch', { workspace: workspace.id, branch: 'missing' }), /Git 命令失败/)
    const plain = await api('workspace-create', { name: 'Plain', cwd: home })
    assert.equal((await api('workspace-git', { workspace: plain.id })).git, false)
  })
})

test('workspace diff returns real patches for tracked and untracked files relative to the workspace and refuses unsafe paths', async () => {
  await withHost(async ({ api, home }) => {
    const repo = makeRepo(home)
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'a.txt'), 'one\ntwo\nthree\n')
    git(repo, ['add', 'sub/a.txt'])
    git(repo, ['commit', '-qm', 'sub'])
    const workspace = await api('workspace-create', { name: 'Sub', cwd: join(repo, 'sub') })
    writeFileSync(join(repo, 'sub', 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(repo, 'sub', 'new.txt'), 'fresh\n')
    writeFileSync(join(repo, 'sub', '说明 文档.md'), 'old\n')
    git(repo, ['add', 'sub/说明 文档.md'])
    git(repo, ['commit', '-qm', 'cjk'])
    writeFileSync(join(repo, 'sub', '说明 文档.md'), 'new\n')
    const { patch } = await api('workspace-diff', { workspace: workspace.id, paths: ['a.txt', 'new.txt', '说明 文档.md'] })
    assert.match(patch, /--- a\/说明 文档\.md\t?\n\+\+\+ b\/说明 文档\.md/, 'a tracked non-ASCII name diffs against HEAD with an unquoted header, not as a new file')
    assert.doesNotMatch(patch, /new file mode[^\n]*\n[^\n]*说明/)
    assert.match(patch, /--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,3 \+1,3 @@/, 'tracked files diff against HEAD with paths relative to the workspace and real line numbers')
    assert.match(patch, /-two\n\+TWO/)
    assert.match(patch, /\+\+\+ b\/new\.txt[\s\S]*\+fresh/, 'an untracked file shows as an addition')
    assert.equal((await api('workspace-diff', { workspace: workspace.id, paths: [] })).patch, '')
    for (const paths of [['../x'], ['/etc/passwd'], ['']]) await assert.rejects(api('workspace-diff', { workspace: workspace.id, paths }), /文件路径无效/)
    const plain = await api('workspace-create', { name: 'Plain', cwd: home })
    assert.equal((await api('workspace-diff', { workspace: plain.id, paths: ['x'] })).patch, '')
  })
})
