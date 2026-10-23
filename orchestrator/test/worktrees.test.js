import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withHost } from './helpers/host.js'

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
      repositoryRoot: refs.repositoryRoot, branch: 'nodo/test', baseCommit: created.workspace.worktree.baseCommit, mode: 'new',
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
