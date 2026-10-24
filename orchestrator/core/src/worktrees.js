// Worktrees: Nodo creates a separate Git checkout for one task and registers it
// as an ordinary workspace, so every engine can open its next conversation
// there through the same cwd path. The model-facing DSH worktree tool is not
// reused: it changes the calling agent's directory and is invisible to the
// external engines.
import { execFile } from 'node:child_process'
import { mkdir, lstat, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REFS_MAX = 200
const INVALID = 'orch/invalid'
const GIT_SCRUB = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' }
const HOOKS_OFF = process.platform === 'win32' ? 'NUL' : '/dev/null'

const invalid = message => Object.assign(new Error(message), { code: INVALID })
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

async function git(cwd, args, { env = {}, allowExit = [0] } = {}) {
  const childEnv = { ...process.env }
  for (const key of GIT_SCRUB) delete childEnv[key]
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete childEnv[key]
  }
  Object.assign(childEnv, GIT_ENV, env)
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd, env: childEnv, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const code = typeof error.code === 'number' ? error.code : null
    if (code !== null && allowExit.includes(code)) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code }
    }
    const detail = String(error.stderr ?? error.message ?? '').trim()
    if (error.code === 'ENOENT') throw invalid('本机没有可用的 git，无法创建工作树')
    throw invalid(`Git 命令失败${detail === '' ? '' : `：${detail}`}`)
  }
}

async function repositoryRoot(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowExit: [0, 128] })
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw invalid('当前项目不是 Git 工作区')
  const list = await git(cwd, ['worktree', 'list', '--porcelain'])
  const first = list.stdout.split('\n').find(line => line.startsWith('worktree '))
  const top = first === undefined
    ? (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim()
    : first.slice('worktree '.length)
  if (top === '') throw invalid('无法确定当前项目的 Git 根目录')
  return realpath(top)
}

async function headOf(cwd) {
  const name = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowExit: [0, 1] })
  const commit = await git(cwd, ['rev-parse', '--short', 'HEAD'], { allowExit: [0, 1, 128] })
  return {
    name: name.code === 0 ? name.stdout.trim() || null : null,
    commit: commit.code === 0 ? commit.stdout.trim() || null : null,
  }
}

async function branchWorktrees(root) {
  const list = await git(root, ['worktree', 'list', '--porcelain'])
  const occupied = new Map()
  let path
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path !== undefined) {
      occupied.set(line.slice('branch refs/heads/'.length), path)
    }
  }
  return occupied
}

function sortRefs(rows, head) {
  return [...rows].sort((a, b) => {
    if (a.name === head.name) return -1
    if (b.name === head.name) return 1
    return String(b.date ?? '').localeCompare(String(a.date ?? ''))
  })
}

function cleanBranch(raw) {
  const branch = text(raw, 200)
  if (branch === '') throw invalid('填写新分支名')
  if (branch.startsWith('-') || isAbsolute(branch) || branch.includes('\\') || branch.includes('\0')
    || !branch.split('/').every(part => part !== '' && part !== '.' && part !== '..')) {
    throw invalid('分支名必须是不含 .. 或反斜杠的相对 Git 分支名')
  }
  return branch
}

function cleanRevision(raw) {
  const revision = text(raw, 500) || 'HEAD'
  if (revision.startsWith('-') || revision.includes('\0') || /[\r\n]/.test(revision)) throw invalid('基准 revision 无效')
  return revision
}

async function ensurePool(pool) {
  await mkdir(dirname(pool), { recursive: true })
  try {
    await mkdir(pool)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!(await stat(pool)).isDirectory()) throw invalid('工作树目录路径已被占用')
  }
  try {
    await writeFile(join(pool, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

async function filterEnv(cwd) {
  const config = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { allowExit: [0, 1] })
  const drivers = new Set()
  for (const key of config.stdout.split('\0')) {
    if (key === '') continue
    const separator = key.lastIndexOf('.')
    if (separator <= 7) continue
    if (['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) drivers.add(key.slice(7, separator))
  }
  const env = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
  let index = 0
  for (const driver of drivers) for (const attribute of ['clean', 'smudge', 'process', 'required']) {
    env[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
    env[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
    index += 1
  }
  return env
}

export function install(rt) {
  const refs = async ({ workspace, query = '', limit = REFS_MAX } = {}) => {
    const target = rt.findWorkspace(workspace)
    if (target === undefined) throw invalid('选择有效的工作区')
    const root = await repositoryRoot(target.cwd)
    const head = await headOf(target.cwd)
    const occupied = await branchWorktrees(root)
    const raw = await git(root, ['for-each-ref', '--sort=-creatordate',
      '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(creatordate:iso-strict)',
      'refs/heads', 'refs/tags'])
    const rows = raw.stdout.split('\n').filter(Boolean).flatMap(line => {
      const [ref, name, commit, date] = line.split('\0')
      if (!ref || !name) return []
      return [{ ref, name, commit, date, tag: ref.startsWith('refs/tags/'),
        ...(ref.startsWith('refs/heads/') && occupied.has(name) ? { checkedOutAt: occupied.get(name) } : {}) }]
    })
    const wanted = text(query, 100).toLowerCase()
    const matches = row => wanted === '' || row.name.toLowerCase().includes(wanted)
    const cap = Math.min(Math.max(Number.isSafeInteger(Number(limit)) ? Number(limit) : REFS_MAX, 1), REFS_MAX)
    const branchesAll = sortRefs(rows.filter(row => !row.tag && matches(row)), head)
    const tagsAll = sortRefs(rows.filter(row => row.tag && matches(row)), head)
    return {
      repositoryRoot: root,
      head,
      branches: branchesAll.slice(0, cap),
      tags: tagsAll.slice(0, cap),
      truncated: branchesAll.length > cap || tagsAll.length > cap,
    }
  }

  const create = async ({ workspace, branch: rawBranch, from, name, mode: rawMode } = {}) => {
    await rt.load()
    const target = rt.findWorkspace(workspace)
    if (target === undefined) throw invalid('选择有效的工作区')
    const mode = text(rawMode, 20) || 'new'
    if (mode !== 'new' && mode !== 'existing') throw invalid('不支持的工作树模式')
    const branch = cleanBranch(rawBranch)
    const root = await repositoryRoot(target.cwd)
    const checked = await git(root, ['check-ref-format', '--branch', branch], { allowExit: [0, 1, 128] })
    if (checked.code !== 0) throw invalid(`分支名不合法：${branch}`)
    const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowExit: [0, 1] })
    let baseCommit
    if (mode === 'existing') {
      if (exists.code !== 0) throw invalid(`分支不存在：${branch}`)
      const checkedOutAt = (await branchWorktrees(root)).get(branch)
      if (checkedOutAt !== undefined) throw invalid(`分支已在 ${checkedOutAt} 检出，不能重复检出`)
      const resolved = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { allowExit: [0, 1, 128] })
      if (resolved.code !== 0) throw invalid(`无法解析分支：${branch}`)
      baseCommit = resolved.stdout.trim()
    } else {
      if (exists.code === 0) throw invalid(`分支已存在：${branch}`)
      const revision = cleanRevision(from)
      const resolved = await git(target.cwd, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { allowExit: [0, 1, 128] })
      if (resolved.code !== 0) throw invalid(`找不到基准 revision：${revision}`)
      baseCommit = resolved.stdout.trim()
    }
    // Validate the Nodo record name after the branch checks and before touching
    // the repository, so neither a bad branch nor a duplicate name leaves artifacts.
    const workspaceName = rt.cleanWorkspaceName(name === undefined || text(name, 80) === '' ? branch : name)
    const pool = join(root, '.nodo', 'worktrees')
    const destination = resolve(pool, branch)
    const inside = relative(pool, destination)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw invalid('工作树路径越界')
    if (await lstat(destination).then(() => true, () => false)) throw invalid(`工作树目录已存在：${destination}`)
    await ensurePool(pool)
    await mkdir(dirname(destination), { recursive: true })
    await git(root, ['-c', `core.hooksPath=${HOOKS_OFF}`, '-c', 'core.fsmonitor=false',
      'worktree', 'add', '--no-checkout', ...(mode === 'existing' ? [] : ['-b', branch]), '--', destination,
      mode === 'existing' ? branch : baseCommit])
    try {
      await git(destination, ['reset', '--hard', '--no-recurse-submodules', baseCommit],
        { env: await filterEnv(root) })
    } catch (error) {
      throw invalid(`${error.message}；工作树 ${destination} 已创建但未完成检出`)
    }
    const worktree = { repositoryRoot: root, branch, baseCommit, mode }
    let created
    try {
      created = await rt.createWorkspace({ name: workspaceName, cwd: destination, worktree })
    } catch (error) {
      throw invalid(`${error.message}；工作树已创建：${destination}`)
    }
    return { workspace: created, worktree: { ...worktree, path: destination } }
  }

  Object.assign(rt, { worktreeRefs: refs, createWorktree: create })
}
