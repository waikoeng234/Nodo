import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, copyFileSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withHost, until, boot } from './helpers/host.js'
import { echoEntry, registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { TASK_TEXT_MAX } from '../core/src/constants.js'

registerClaudeFixtureEngine()
registerEngine('worktree-fixture', { ...echoEntry, info: { ...echoEntry.info, id: 'worktree-fixture', name: 'Worktree fixture' }, create(options) {
  const driver = echoEntry.create(options), send = driver.sendTurn
  return Object.assign(driver, { cwd: options.cwd, calls: [], sendTurn(text) { driver.calls.push(text); return send(text) } })
} })
const command = { type: 'feature', hard: false, task: 'Implement and verify\nPreserve existing changes.' }
const turn = reason => ({ mode: 'turn', completion: Promise.resolve({ reason }) })
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const withTasks = (run, repository = false) => withHost(async host => {
  const rt = await host.runtime
  const cwd = repository ? join(host.home, 'repo') : host.home
  if (repository) {
    mkdirSync(cwd)
    git(cwd, 'init', '-q', '-b', 'main')
    git(cwd, 'config', 'user.email', 'nodo@example.test')
    git(cwd, 'config', 'user.name', 'Nodo Test')
    writeFileSync(join(cwd, 'base.txt'), 'base\n')
    git(cwd, 'add', 'base.txt')
    git(cwd, 'commit', '-qm', 'base')
  }
  const workspace = await host.api('workspace-create', { name: 'Tasks', cwd })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'echo', engineOptions: { script: [{ kind: 'text', text: 'Implemented and verified' }] } })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const clients = [], bindings = []
  const client = async session => {
    const binding = await rt.issueLeadMcp(session.id), spec = binding.servers[0]
    bindings.push(binding)
    const value = new Client({ name: 'task-test', version: '1' })
    clients.push(value)
    await value.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } }))
    return value
  }
  const call = async (value, name, args) => {
    const response = await value.callTool({ name, arguments: args })
    assert.equal(response.isError, undefined, response.content[0].text)
    return JSON.parse(response.content[0].text)
  }
  const finish = async receipt => {
    await rt.followLead(owner.id, turn('done'))
    await until(() => rt.state.executions[receipt.executionId].references.length && rt.transcriptOf(owner.id).some(line => line.origin?.executionId === receipt.executionId))
    await until(() => !rt.workView()[owner.id]?.active)
  }
  try { await run({ host, rt, workspace, worker, lead, owner, other, client, call, finish }) }
  finally { for (const value of clients) await value.close(); for (const binding of bindings) binding.revoke() }
})

test('isolated delegation locks its directory, copies attachments and reports its branch', () => withTasks(async ({ host, rt, workspace, worker, owner, client, call, finish }) => {
  rt.state.profiles[worker.id].engine = 'worktree-fixture'
  const alias = join(host.home, 'repo-alias')
  symlinkSync(workspace.cwd, alias, 'dir')
  rt.conversationOf(owner.id).session.cwd = alias
  writeFileSync(join(workspace.cwd, 'base.txt'), 'uncommitted\n')
  const refs = await rt.saveFiles(rt.admitFiles([{ name: 'context.txt', data: Buffer.from('task context').toString('base64') }]))
  const attached = await rt.materializeFiles(refs, workspace.cwd)
  rt.leadInputStarted(owner.id, attached)
  const primary = await client(owner)
  const first = await call(primary, 'nodo_delegate', { ...command, worktree: true })
  const execution = rt.state.executions[first.executionId]
  const isolated = rt.findWorkspace(execution.workspaceRef)
  const session = rt.conversationOf(first.session).session
  assert.notEqual(isolated.id, workspace.id)
  assert.equal(session.workspaceRef, isolated.id)
  assert.equal(rt.sessionWorkspace(rt.conversationOf(first.session).profile, session).cwd, isolated.cwd)
  assert.equal(rt.state.tasks[first.taskId].workspaceRef, workspace.id)
  assert.equal(readFileSync(join(isolated.cwd, 'base.txt'), 'utf8'), 'base\n')
  assert.equal(rt.transcriptOf(owner.id).find(line => line.delegation)?.delegation.branch, isolated.worktree.branch)
  for (const shown of [rt.leadDelegations(owner.id), rt.leadSnapshot(owner.id)]) {
    const rows = shown.split('\n').filter(line => line.startsWith('|'))
    assert.match(rows[0], /已续用 \| 目录/)
    assert.ok(rows.every(line => line.split('|').length === rows[0].split('|').length))
    assert.match(shown, new RegExp(isolated.worktree.branch))
  }
  const send = rt.send
  let sent
  rt.send = async (...args) => {
    if (args[5]?.origin?.kind === 'delegation') sent = args
    return send(...args)
  }
  await finish(first)
  assert.equal(rt.driverOf(first.session).cwd, isolated.cwd)
  const [copied] = sent[5].files.paths
  assert.ok(realpathSync(copied).startsWith(`${realpathSync(isolated.cwd)}${sep}`), 'the attachment stays inside the isolated checkout despite the cwd alias')
  assert.equal(basename(copied), basename(attached[0]))
  assert.equal(readFileSync(copied, 'utf8'), 'task context')
  assert.deepEqual(sent[5].files.paths, [copied])
  assert.ok(rt.driverOf(first.session).calls[0].includes(copied))
  assert.ok(sent[1].endsWith(`执行目录：${isolated.cwd}\n分支：${isolated.worktree.branch}\n基准 commit：${isolated.worktree.baseCommit}\n主检出的未提交改动和依赖不在此目录。Nodo 不会自动合并。报告须回传分支、执行目录、改动文件，以及是否已提交；已提交的给出 sha。`))
  await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, worktree: false }), /执行目录不一致/)
  for (const worktree of [true, false]) await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, session: first.session, worktree }), /续用 session 时不能传 worktree/)
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, worktree: true })
  assert.equal(rt.state.executions[next.executionId].workspaceRef, isolated.id)
  assert.equal(rt.conversationOf(next.session).session.workspaceRef, isolated.id)
  await rt.followLead(owner.id, turn('interrupted'))
  assert.ok(existsSync(isolated.cwd), 'a previously sent task keeps its worktree when rework is cancelled')
  const reused = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, session: first.session })
  assert.equal(rt.state.executions[reused.executionId].workspaceRef, isolated.id)
  await rt.followLead(owner.id, turn('interrupted'))
  assert.ok(existsSync(isolated.cwd))
}, true))

test('worktree validation rejects non-booleans and switching a started shared task to isolation', () => withTasks(async ({ rt, owner, client, call, finish }) => {
  const primary = await client(owner)
  for (const worktree of ['true', 1, null]) {
    const response = await primary.callTool({ name: 'nodo_delegate', arguments: { ...command, worktree } })
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /worktree 必须是 true 或 false/)
  }
  const first = await call(primary, 'nodo_delegate', { ...command, worktree: false })
  assert.equal(rt.state.executions[first.executionId].workspaceRef, undefined)
  assert.match(rt.leadDelegations(owner.id), /\| 共享 \|/)
  await finish(first)
  await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, worktree: true }), /执行目录不一致/)
}))

for (const removal of ['automatic', 'user']) for (const worktree of [undefined, true, false]) test(`taskId can be dispatched again after ${removal} workspace deletion (worktree=${worktree})`, () => withTasks(async ({ rt, workspace, owner, finish }) => {
  const first = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const isolated = rt.findWorkspace(rt.state.executions[first.executionId].workspaceRef)
  if (removal === 'automatic') await rt.followLead(owner.id, turn('interrupted'))
  else {
    await finish(first)
    await rt.deleteWorkspace(isolated.id)
  }
  assert.equal(rt.findWorkspace(isolated.id), undefined)
  assert.ok(rt.conversationOf(first.session).session.archivedAt)
  assert.match(rt.leadDelegations(owner.id), /\| 已删除 \|/)
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, ...(worktree === undefined ? {} : { worktree }) })
  assert.equal(next.taskId, first.taskId)
  assert.match(next.message, /原隔离目录已删除.*重新选择执行目录/)
  const execution = rt.state.executions[next.executionId]
  if (worktree) {
    assert.notEqual(execution.workspaceRef, isolated.id)
    assert.ok(rt.findWorkspace(execution.workspaceRef).worktree)
  } else {
    assert.equal(execution.workspaceRef, undefined)
    assert.equal(rt.conversationOf(next.session).session.workspaceRef, workspace.id)
  }
  await rt.followLead(owner.id, turn('interrupted'))
}, true))

test('a shared execution that never started does not lock the task directory', () => withTasks(async ({ rt, owner }) => {
  const first = await rt.leadDispatch.delegate(owner.id, command)
  await rt.followLead(owner.id, turn('interrupted'))
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId, worktree: true })
  assert.ok(rt.findWorkspace(rt.state.executions[next.executionId].workspaceRef).worktree)
  await rt.followLead(owner.id, turn('interrupted'))
}, true))

for (const phase of ['session', 'acceptance', 'receipt']) test(`isolated ${phase} failure removes the worktree and branch and refunds capacity and budget`, () => withTasks(async ({ rt, workspace, owner }) => {
  const method = { session: 'createSession', acceptance: 'saveStrict', receipt: 'save' }[phase]
  const original = rt[method]
  let isolated
  rt[method] = async (...args) => {
    isolated ??= Object.values(rt.state.workspaces).find(item => item.worktree)
    if (isolated && (phase === 'session' || Object.values(rt.state.executions).some(item => item.status === 'queued'))) throw new Error(`${phase} failed`)
    return original(...args)
  }
  for (let index = 0; index < 25; index++) {
    isolated = undefined
    await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, worktree: true }), new RegExp(`${phase} failed`))
    assert.ok(isolated)
    assert.equal(existsSync(isolated.cwd), false)
    assert.equal(rt.findWorkspace(isolated.id), undefined)
    assert.throws(() => git(workspace.cwd, 'show-ref', '--verify', `refs/heads/${isolated.worktree.branch}`))
    assert.equal(git(workspace.cwd, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
  }
  rt[method] = original
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await rt.leadDispatch.delegate(owner.id, command))
  await rt.followLead(owner.id, turn('interrupted'))
  assert.ok(flights.every(item => rt.state.executions[item.executionId].status === 'cancelled'))
}, true))

for (const reason of ['interrupted', 'error']) test(`a lead turn ending with ${reason} removes all unsent isolated worktrees`, () => withTasks(async ({ rt, workspace, owner }) => {
  const queued = []
  for (let index = 0; index < 2; index++) {
    const receipt = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
    queued.push({ receipt, workspace: rt.findWorkspace(rt.state.executions[receipt.executionId].workspaceRef) })
  }
  await rt.followLead(owner.id, turn(reason))
  for (const item of queued) {
    assert.equal(rt.state.executions[item.receipt.executionId].status, 'cancelled')
    assert.equal(existsSync(item.workspace.cwd), false)
    assert.throws(() => git(workspace.cwd, 'show-ref', '--verify', `refs/heads/${item.workspace.worktree.branch}`))
  }
}, true))

test('interrupting an unsent isolated execution removes its worktree', () => withTasks(async ({ rt, owner }) => {
  const receipt = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const isolated = rt.findWorkspace(rt.state.executions[receipt.executionId].workspaceRef)
  await rt.leadDispatch.interrupt(owner.id, { executionId: receipt.executionId })
  assert.equal(existsSync(isolated.cwd), false)
  assert.equal(rt.findWorkspace(isolated.id), undefined)
}, true))

test('a lead error removes queued isolation and preserves the already sent worktree', () => withTasks(async ({ rt, owner, worker }) => {
  rt.state.profiles[worker.id].engineOptions.script = [{ kind: 'wait', ms: 10_000 }]
  const sent = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const kept = rt.findWorkspace(rt.state.executions[sent.executionId].workspaceRef)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.workView()[sent.session]?.active)
  const queued = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const removed = rt.findWorkspace(rt.state.executions[queued.executionId].workspaceRef)
  await rt.followLead(owner.id, turn('error'))
  assert.equal(existsSync(removed.cwd), false)
  assert.equal(existsSync(kept.cwd), true)
  assert.equal(rt.state.executions[sent.executionId].status, 'running')
  await rt.leadDispatch.interrupt(owner.id, { executionId: sent.executionId })
  assert.equal(existsSync(kept.cwd), true)
}, true))

test('restart removes never-sent isolation but keeps a rework directory that ran before', () => withTasks(async ({ host, rt, owner, finish }) => {
  const sent = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const kept = rt.findWorkspace(rt.state.executions[sent.executionId].workspaceRef)
  await finish(sent)
  const rework = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: sent.taskId })
  const queued = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const removed = rt.findWorkspace(rt.state.executions[queued.executionId].workspaceRef)
  const directory = join(host.home, 'isolated-restart')
  mkdirSync(directory)
  copyFileSync(join(host.home, 'state.json'), join(directory, 'state.json'))
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    await until(() => recovered.state.executions[queued.executionId].status === 'cancelled' && !recovered.state.workspaces[removed.id])
    assert.equal(existsSync(removed.cwd), false)
    await until(() => recovered.state.executions[rework.executionId].status === 'cancelled')
    assert.equal(existsSync(kept.cwd), true)
    assert.ok(recovered.state.workspaces[kept.id])
  } finally {
    await restarted.dispose()
    await rt.followLead(owner.id, turn('interrupted'))
  }
}, true))

for (const phase of ['copy', 'start', 'start-save', 'send']) test(`isolated ${phase} failure retains the worktree only if execution started`, () => withTasks(async ({ rt, owner }) => {
  if (phase === 'copy') rt.leadInputStarted(owner.id, ['/missing/workflow-input'])
  const receipt = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  const isolated = rt.findWorkspace(rt.state.executions[receipt.executionId].workspaceRef)
  const method = phase === 'start-save' ? 'saveStrict' : phase === 'start' ? 'startExecution' : 'send'
  const original = rt[method]
  if (phase !== 'copy') rt[method] = async () => { throw new Error(`${phase} failed`) }
  await rt.followLead(owner.id, turn('done'))
  rt[method] = original
  const started = rt.state.executions[receipt.executionId].startedAt !== null
  assert.equal(started, phase === 'send' || phase === 'start-save')
  assert.equal(existsSync(isolated.cwd), started)
  assert.equal(!!rt.findWorkspace(isolated.id), started)
  assert.equal(rt.state.executions[receipt.executionId].status, 'failed')
}, true))

for (const phase of ['acceptance', 'cancellation']) test(`worktree cleanup failure preserves the original ${phase} error`, () => withTasks(async ({ rt, owner }) => {
  const warnings = []
  rt.warn = (...args) => warnings.push(args.join(' '))
  const remove = rt.removeWorktree
  const originalError = new Error(`${phase} original failure`)
  const method = phase === 'acceptance' ? 'createSession' : 'cancelExecution'
  const original = rt[method]
  let receipt
  if (phase === 'cancellation') receipt = await rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
  rt[method] = async () => { throw originalError }
  rt.removeWorktree = async () => { throw new Error('Cleanup failed') }
  try {
    await assert.rejects(phase === 'acceptance'
      ? rt.leadDispatch.delegate(owner.id, { ...command, worktree: true })
      : rt.leadDispatch.interrupt(owner.id, { executionId: receipt.executionId }), error => error === originalError)
    assert.ok(warnings.some(message => message.includes('worktree cleanup failed') && message.includes('Cleanup failed')))
  } finally {
    rt[method] = original
    rt.removeWorktree = remove
    if (receipt) await rt.cancelUnsentExecution(receipt.executionId)
    for (const workspace of Object.values(rt.state.workspaces).filter(item => item.worktree)) await remove(workspace.id)
  }
}, true))

test('non-git and unavailable-git errors return isError and refund the reservation', () => withTasks(async ({ rt, owner, client }) => {
  const primary = await client(owner)
  const response = await primary.callTool({ name: 'nodo_delegate', arguments: { ...command, worktree: true } })
  assert.equal(response.isError, true)
  assert.match(response.content[0].text, /当前项目不是 Git 工作区/)
  const path = process.env.PATH
  try {
    process.env.PATH = '/nodo-test-no-git'
    await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, worktree: true }), /本机没有可用的 git/)
  } finally { process.env.PATH = path }
  for (let index = 0; index < 5; index++) await rt.leadDispatch.delegate(owner.id, command)
  await rt.followLead(owner.id, turn('interrupted'))
}))

test('task tools close the loop, preserve three results on one session and enforce coordinator credentials', () => withTasks(async ({ host, rt, lead, owner, other, client, call, finish }) => {
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Original user request' })
  await until(() => !rt.workView()[owner.id]?.active)
  const primary = await client(owner), foreign = await client(other)
  const send = rt.send
  rt.send = async (...args) => {
    const origin = args[5]?.origin
    if (origin?.kind === 'report') {
      const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[origin.executionId]
      assert.ok(saved.report)
      assert.ok(saved.references.includes(args[4][0].id))
    }
    return send(...args)
  }
  const first = await call(primary, 'nodo_delegate', command)
  assert.equal(first.status, 'queued')
  assert.equal(rt.driverOf(first.session), undefined)
  assert.equal(rt.conversationOf(first.session).session.source.dispatch, undefined)
  assert.equal(rt.state.tasks[first.taskId].source.request.text, 'Original user request')
  assert.equal(rt.state.tasks[first.taskId].title, 'Implement and verify')
  for (const [name, args] of [
    ['nodo_delegate', { ...command, taskId: first.taskId }],
    ['nodo_board', { taskId: first.taskId }],
    ['nodo_task', { taskId: first.taskId, action: 'reopen' }],
    ['nodo_interrupt', { executionId: first.executionId }],
  ]) assert.equal((await foreign.callTool({ name, arguments: args })).isError, true)
  await finish(first)
  const original = structuredClone(rt.state.executions[first.executionId])
  for (let index = 0; index < 2; index++) {
    const next = await call(primary, 'nodo_delegate', { ...command, taskId: first.taskId, session: first.session, task: `Follow-up ${index}` })
    assert.notEqual(next.executionId, first.executionId)
    await finish(next)
  }
  assert.deepEqual(rt.state.executions[first.executionId], original)
  assert.equal(rt.conversationOf(first.session).session.source.dispatch, undefined)
  const task = await call(primary, 'nodo_board', { taskId: first.taskId })
  assert.equal(task.executions.length, 3)
  assert.equal(new Set(task.executions.flatMap(item => item.references)).size, 3)
  assert.deepEqual(await call(primary, 'nodo_board', { table: 'tasks' }), [{ id: first.taskId, title: task.title,
    status: 'review', teamId: 'team', executionCount: 3, latestExecutionStatus: 'done', references: task.executions.flatMap(item => item.references) }])
  assert.deepEqual(await call(foreign, 'nodo_board', { table: 'tasks' }), [])
  assert.ok(rt.transcriptOf(first.session).filter(line => line.origin?.kind === 'delegation').every(line => line.origin.taskId === first.taskId && line.origin.executionId))
  const done = await call(primary, 'nodo_task', { taskId: first.taskId, action: 'complete', reason: 'Checked all results', references: task.executions.at(-1).references })
  assert.equal(done.status, 'done')
  assert.equal((await call(primary, 'nodo_task', { taskId: first.taskId, action: 'reopen' })).status, 'open')
}))

test('task revise updates title or brief and refuses foreign, finished, oversized and empty edits', () => withTasks(async ({ host, rt, lead, owner, other, client, call, finish }) => {
  // The secret must exist before the lead driver mounts, or the stamp change
  // would rebuild the driver and rotate the MCP credential mid-test.
  const secret = 'revise-brief-registered-value-'.repeat(4)
  await host.api('secret-set', { name: 'REVISE_BRIEF_SECRET', value: secret, purpose: 'test', scope: [lead.id] })
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Original user request' })
  await until(() => !rt.workView()[owner.id]?.active)
  const primary = await client(owner), foreign = await client(other)
  const first = await call(primary, 'nodo_delegate', command)
  const renamed = await call(primary, 'nodo_task', { taskId: first.taskId, action: 'revise', title: `  Renamed goal\nsecond line ${'x'.repeat(100)}` })
  assert.equal(renamed.title, 'Renamed goal', 'title keeps the first line only, clipped at 80 characters')
  assert.equal(renamed.brief, command.task)
  assert.equal((await call(primary, 'nodo_task', { taskId: first.taskId, action: 'revise', brief: 'Revised scope' })).brief, 'Revised scope')
  const masked = await call(primary, 'nodo_task', { taskId: first.taskId, action: 'revise', brief: `Scope covers ${secret} end to end` })
  assert.equal(masked.brief.includes(secret), false)
  assert.ok(masked.brief.includes('[secret:REVISE_BRIEF_SECRET]'))
  assert.equal(rt.state.tasks[first.taskId].brief.includes(secret), false, 'stored brief is redacted')
  assert.equal((await foreign.callTool({ name: 'nodo_task', arguments: { taskId: first.taskId, action: 'revise', title: 'Hijack' } })).isError, true)
  assert.equal(rt.state.tasks[first.taskId].title, 'Renamed goal')
  const empty = await primary.callTool({ name: 'nodo_task', arguments: { taskId: first.taskId, action: 'revise' } })
  assert.equal(empty.isError, true)
  assert.match(empty.content[0].text, /title 或 brief/)
  const oversized = await primary.callTool({ name: 'nodo_task', arguments: { taskId: first.taskId, action: 'revise', brief: 'x'.repeat(TASK_TEXT_MAX + 1) } })
  assert.equal(oversized.isError, true)
  assert.match(oversized.content[0].text, /不能超过/)
  assert.equal(rt.state.tasks[first.taskId].brief.length, masked.brief.length, 'an oversized brief leaves the stored brief unchanged')
  const { profile: leadProfile, session: leadSession } = rt.conversationOf(owner.id)
  assert.match(rt.leadBrief(leadProfile, leadSession), /reopened before revising/)
  await finish(first)
  await call(primary, 'nodo_task', { taskId: first.taskId, action: 'complete', reason: 'Checked all results', references: rt.state.executions[first.executionId].references })
  const finished = await primary.callTool({ name: 'nodo_task', arguments: { taskId: first.taskId, action: 'revise', title: 'After done' } })
  assert.equal(finished.isError, true)
  assert.match(finished.content[0].text, /Task cannot transition from done/)
  assert.equal(rt.state.tasks[first.taskId].title, 'Renamed goal')
  assert.equal((await call(primary, 'nodo_task', { taskId: first.taskId, action: 'reopen' })).status, 'open')
  assert.equal((await call(primary, 'nodo_task', { taskId: first.taskId, action: 'revise', brief: 'Reopened scope' })).status, 'open')
}))

test('archiving a coordinator waits for undelivered reports and live executions; unconfirmed work does not block', () => withTasks(async ({ rt, workspace, worker, lead, owner }) => {
  const session = () => rt.conversationOf(owner.id).session
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  await assert.rejects(rt.archiveSession(lead.id, owner.id, true), { code: 'orch/busy', message: /排队或执行中/ })
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[receipt.executionId].status, 'cancelled')
  session().reportQueue = [{ id: 'pending-report' }]
  await assert.rejects(rt.archiveSession(lead.id, owner.id, true), { code: 'orch/busy', message: /未送出/ })
  delete session().reportQueue
  const task = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id, title: 'Unconfirmed', brief: 'Unconfirmed', source: { kind: 'lead', sessionId: owner.id } })
  const executor = await rt.createSession(worker.id, 'Executor', workspace.id, true, false, {}, { kind: 'lead', leadSessionId: owner.id, leadProfileId: lead.id, type: 'feature', hard: false })
  const execution = await rt.acceptExecution(task.id, { profileId: worker.id, sessionId: executor.id, type: 'feature', hard: false })
  await rt.startExecution(execution.id)
  await assert.rejects(rt.archiveSession(lead.id, owner.id, true), { code: 'orch/busy', message: /排队或执行中/ })
  await rt.unconfirmExecution(execution.id, { reason: 'restart' })
  assert.equal(typeof (await rt.archiveSession(lead.id, owner.id, true)).archivedAt, 'number')
  assert.equal((await rt.archiveSession(lead.id, owner.id, false)).archivedAt, undefined)
}))

test('failed acceptance saves cancel unsent executions even when the cancellation save also fails', () => withTasks(async ({ rt, owner }) => {
  const save = rt.saveStrict
  let failing = false
  rt.saveStrict = async () => {
    failing ||= Object.values(rt.state.executions).some(item => item.status === 'queued')
    if (failing) throw new Error('Acceptance save failed')
    return save()
  }
  await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /Acceptance save failed/)
  const execution = Object.values(rt.state.executions)[0]
  assert.equal(execution.status, 'cancelled')
  assert.match(execution.reason, /保存失败.*Acceptance save failed/)
  assert.equal(rt.driverOf(execution.sessionId), undefined)
  assert.equal(rt.transcriptOf(owner.id).some(line => line.delegation), false)
  rt.saveStrict = save
  assert.equal(rt.conversationOf(execution.sessionId), undefined)
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: execution.taskId })
  assert.notEqual(next.session, execution.sessionId)
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[next.executionId].status, 'cancelled')
}))

test('a busy taskId re-delegation removes the session it created and keeps the pending execution', () => withTasks(async ({ rt, worker, owner }) => {
  const first = await rt.leadDispatch.delegate(owner.id, command)
  const count = () => rt.state.profiles[worker.id].sessions.length
  const before = count()
  await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, taskId: first.taskId }), { code: 'orch/busy' })
  assert.equal(count(), before)
  assert.equal(rt.state.executions[first.executionId].status, 'queued')
  assert.ok(rt.conversationOf(first.session))
  await rt.followLead(owner.id, turn('interrupted'))
}))

test('send failures and round cancellation preserve true execution status and release reservations', () => withTasks(async ({ rt, worker, lead, owner }) => {
  const cancelled = await rt.leadDispatch.delegate(owner.id, command)
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[cancelled.executionId].status, 'cancelled')
  assert.equal(rt.driverOf(cancelled.session), undefined)
  const send = rt.send
  rt.send = (...args) => args[0] === worker.id ? Promise.reject(new Error('Send failed')) : send(...args)
  const failed = await rt.leadDispatch.delegate(owner.id, command)
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.state.executions[failed.executionId].report)
  assert.equal(rt.state.executions[failed.executionId].status, 'failed')
  assert.equal(rt.state.tasks[failed.taskId].status, 'blocked')
  await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: failed.taskId })
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[next.executionId].status, 'cancelled')
}))

for (const reason of ['error', 'interrupted', 'unconfirmed', 'rejected']) test(`a failed lead round cancels both accepted flights exactly once (${reason})`, () => withTasks(async ({ rt, lead, owner }) => {
  const flights = []
  for (let index = 0; index < 2; index++) flights.push(await rt.leadDispatch.delegate(owner.id, command))
  await rt.followLead(owner.id, { mode: 'turn', completion: reason === 'rejected' ? Promise.reject(new Error('Lead failed'))
    : Promise.resolve(reason === 'unconfirmed' ? { reason: 'done', unconfirmed: true } : { reason }) })
  await rt.followLead(owner.id, turn('error'))
  for (const item of flights) {
    assert.equal(rt.state.executions[item.executionId].status, 'cancelled')
    assert.equal(rt.driverOf(item.session), undefined)
    assert.equal(rt.transcriptOf(owner.id).filter(line => line.delegation?.executionId === item.executionId && line.delegation.ended).length, 1)
  }
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined)
}))

test('a failed first send does not prevent the second flight from starting and reporting', () => withTasks(async ({ rt, worker, lead, owner }) => {
  const first = await rt.leadDispatch.delegate(owner.id, { ...command, task: 'A' })
  const second = await rt.leadDispatch.delegate(owner.id, { ...command, task: 'B' })
  const send = rt.send, sent = []
  rt.send = (...args) => {
    if (args[0] === worker.id) sent.push(args[2])
    return args[2] === first.session ? Promise.reject(new Error('A send failed')) : send(...args)
  }
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.transcriptOf(owner.id).some(line => line.origin?.executionId === second.executionId))
  assert.deepEqual(sent, [first.session, second.session])
  assert.equal(rt.state.executions[first.executionId].status, 'failed')
  assert.equal(rt.state.executions[second.executionId].status, 'done')
  assert.ok(rt.state.executions[second.executionId].references.length)
  for (const item of [first, second]) assert.equal(rt.transcriptOf(owner.id).filter(line => line.origin?.executionId === item.executionId).length, 1)
  await until(() => !rt.workView()[owner.id]?.active)
}))

test('five active flights include reservations and failed creation releases its own slot', () => withTasks(async ({ rt, lead, owner, other }) => {
  const create = rt.createSession
  let release, entered = 0
  const gate = new Promise(resolve => { release = resolve })
  rt.createSession = async (...args) => {
    const index = entered++
    await gate
    if (index === 0) throw new Error('Creation failed')
    return create(...args)
  }
  const pending = Array.from({ length: 5 }, () => rt.leadDispatch.delegate(owner.id, command))
  const settled = Promise.allSettled(pending)
  try {
    await until(() => entered === 5)
    await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /最多同时派活 5 个任务，请等一个结束后再派/)
    rt.createSession = create
    const foreign = await rt.leadDispatch.delegate(other.id, command)
    assert.equal(foreign.status, 'queued')
    release()
    const results = await settled
    assert.equal(results.filter(item => item.status === 'rejected').length, 1)
    assert.match(results[0].reason.message, /Creation failed/)
    const fifth = await rt.leadDispatch.delegate(owner.id, command)
    assert.equal(fifth.status, 'queued')
    await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /最多同时派活 5 个任务/)
    const active = Object.values(rt.state.executions).filter(item => rt.state.tasks[item.taskId].coordinatorSessionId === owner.id)
    assert.equal(active.length, 5)
    assert.ok(active.every(item => item.status === 'queued'))
  } finally {
    release()
    rt.createSession = create
    await settled
    await rt.followLead(owner.id, turn('interrupted'))
    await rt.followLead(other.id, turn('interrupted'))
  }
}))

for (const phase of ['acceptance', 'receipt']) test(`failed ${phase} rolls back without leaking any of the five flight slots`, () => withTasks(async ({ rt, lead, owner }) => {
  const method = phase === 'acceptance' ? 'saveStrict' : 'save'
  const save = rt[method]
  rt[method] = async (...args) => {
    if (Object.values(rt.state.executions).some(item => item.status === 'queued')) throw new Error(`${phase} failed`)
    return save(...args)
  }
  await assert.rejects(rt.leadDispatch.delegate(owner.id, command), new RegExp(`${phase} failed`))
  rt[method] = save
  const flights = []
  for (let index = 0; index < 5; index++) flights.push(await rt.leadDispatch.delegate(owner.id, command))
  await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /最多同时派活 5 个任务/)
  assert.equal(Object.values(rt.state.executions).filter(item => item.status === 'queued').length, 5)
  await rt.followLead(owner.id, turn('interrupted'))
  assert.ok(flights.every(item => rt.state.executions[item.executionId].status === 'cancelled'))
}))

test('acceptance losing write access still cancels its unsent in-memory reservation', () => withTasks(async ({ rt, owner }) => {
  const save = rt.saveStrict, readOnly = rt.readOnly
  rt.saveStrict = async () => {
    if (Object.values(rt.state.executions).some(item => item.status === 'queued')) {
      rt.readOnly = () => 'Write lock lost'
      throw new Error('Write lock lost')
    }
    return save()
  }
  await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /Write lock lost/)
  assert.equal(Object.values(rt.state.executions)[0].status, 'cancelled')
  assert.equal(rt.transcriptOf(owner.id).some(line => line.delegation), false)
  rt.readOnly = readOnly
  rt.saveStrict = save
  await rt.saveStrict()
}))

test('failed startup saves release the runtime slot without sending a worker command', () => withTasks(async ({ rt, owner, lead }) => {
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  const save = rt.saveStrict
  rt.saveStrict = async () => { throw new Error('Startup save failed') }
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.state.executions[receipt.executionId].status === 'failed')
  assert.equal(rt.driverOf(receipt.session), undefined)
  rt.saveStrict = save
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: receipt.taskId })
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[next.executionId].status, 'cancelled')
}))

test('receipt failure after deferred dispatch starts leaves completion tracking in charge', () => withTasks(async ({ rt, owner, lead }) => {
  const save = rt.save
  let injected = false, execution
  rt.save = async (...args) => {
    execution ??= Object.values(rt.state.executions).find(item => item.status === 'queued')
    if (!injected && execution && rt.transcriptOf(owner.id).some(line => line.delegation?.executionId === execution.id)) {
      injected = true
      await rt.followLead(owner.id, turn('done'))
      await until(() => rt.workView()[execution.sessionId]?.active)
      throw new Error('Receipt save failed after dispatch started')
    }
    return save(...args)
  }
  await assert.rejects(rt.leadDispatch.delegate(owner.id, command), /Receipt save failed after dispatch started/)
  await until(() => rt.transcriptOf(owner.id).some(line => line.origin?.executionId === execution.id))
  assert.equal(execution.status, 'done')
  assert.ok(execution.references.length)
  await until(() => !rt.workView()[owner.id]?.active)
  const next = await rt.leadDispatch.delegate(owner.id, { ...command, taskId: execution.taskId, session: execution.sessionId })
  await rt.followLead(owner.id, turn('interrupted'))
  assert.equal(rt.state.executions[next.executionId].status, 'cancelled')
}))

for (const fallback of [false, true]) test(`execution records retain a short summary and report references (inline=${fallback})`, () => withTasks(async ({ host, rt, owner, lead, worker }) => {
  const text = 'Completed work. '.repeat(60) + 'UNIQUE_FULL_REPORT_TAIL'
  rt.state.profiles[worker.id].engineOptions.script = [{ kind: 'text', text }]
  if (fallback) rt.createReference = async () => { throw new Error('Reference unavailable') }
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  await rt.followLead(owner.id, turn('done'))
  const report = await until(() => rt.transcriptOf(owner.id).find(line => line.origin?.executionId === receipt.executionId))
  await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
  await rt.saveStrict()
  const stored = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[receipt.executionId]
  assert.ok(stored.report.length <= 200)
  assert.equal(stored.report.includes('UNIQUE_FULL_REPORT_TAIL'), false)
  if (fallback) {
    assert.deepEqual(stored.references, [])
    assert.ok(report.text.includes(text))
  } else {
    assert.deepEqual(stored.references, [report.references[0].id])
    assert.equal(report.references[0].messages[0].text, text)
  }
}))

test('report delivery waits for execution evidence to save and retries without replacing results', () => withTasks(async ({ host, rt, lead, owner }) => {
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  const save = rt.saveStrict
  rt.saveStrict = async () => {
    if (rt.state.executions[receipt.executionId].references.length) throw new Error('Evidence save failed')
    return save()
  }
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.conversationOf(owner.id).session.reportQueue?.[0]?.referenceId)
  assert.equal(rt.transcriptOf(owner.id).some(line => line.origin?.kind === 'report'), false)
  const original = rt.state.executions[receipt.executionId].report
  rt.saveStrict = save
  await rt.flushLeadReports(owner.id)
  await until(() => rt.transcriptOf(owner.id).some(line => line.origin?.executionId === receipt.executionId))
  const stored = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[receipt.executionId]
  assert.equal(stored.report, original)
  assert.ok(stored.references.length)
  assert.equal(rt.transcriptOf(owner.id).filter(line => line.origin?.executionId === receipt.executionId).length, 1)
  await until(() => !rt.workView()[owner.id]?.active)
}))

test('late confirmed results append evidence to the original unconfirmed execution', () => withTasks(async ({ rt, owner, worker, workspace, lead }) => {
  const task = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id, title: 'Late work', brief: 'Recover evidence', source: { sessionId: owner.id } })
  const session = await rt.createSession(worker.id, 'Executor', workspace.id, true, false, {}, { kind: 'lead', leadSessionId: owner.id, leadProfileId: lead.id, type: 'feature', hard: false })
  const execution = await rt.acceptExecution(task.id, { profileId: worker.id, sessionId: session.id, type: 'feature', hard: false })
  await rt.startExecution(execution.id)
  await rt.unconfirmExecution(execution.id, { reason: 'restart', report: 'Original unconfirmed report' })
  rt.appendLine(session.id, { who: 'agent', kind: 'text', text: 'Late completed result', reply: true, replyId: 'late-reply' })
  await rt.leadEnded(session.id, { reason: 'done', text: 'Late completed result', replyId: 'late-reply' })
  const result = (await rt.taskView(task.id)).executions[0]
  assert.equal(result.status, 'done')
  assert.equal(result.report, 'Original unconfirmed report')
  assert.equal(result.references.length, 1)
  assert.equal((await rt.readReference({ id: result.references[0], target: owner.id })).messages[0].text, 'Late completed result')
  assert.equal((await rt.taskView(task.id)).status, 'blocked')
}))

test('interrupt validates exclusive arguments and resolves a reused session to its active execution', () => withTasks(async ({ rt, owner, client, call }) => {
  const primary = await client(owner)
  const first = await call(primary, 'nodo_delegate', command)
  assert.equal((await primary.callTool({ name: 'nodo_interrupt', arguments: { session: first.session, executionId: first.executionId } })).isError, true)
  assert.equal((await call(primary, 'nodo_interrupt', { session: first.session })).ended, 'cancelled')
  assert.equal(rt.state.executions[first.executionId].status, 'cancelled')
  await assert.rejects(rt.leadDispatch.delegate(owner.id, { ...command, session: first.session }), { message: '带上 taskId 重试以续用该会话' })
  const next = await call(primary, 'nodo_delegate', { ...command, taskId: first.taskId, session: first.session })
  assert.equal((await primary.callTool({ name: 'nodo_interrupt', arguments: { executionId: first.executionId } })).isError, true)
  assert.equal((await call(primary, 'nodo_interrupt', { session: next.session })).executionId, next.executionId)
  const exact = await call(primary, 'nodo_delegate', { ...command, taskId: first.taskId, session: first.session })
  assert.equal((await call(primary, 'nodo_interrupt', { executionId: exact.executionId })).executionId, exact.executionId)
  assert.equal(rt.state.executions[next.executionId].status, 'cancelled')
}))

test('restart cancels queued executions without reports and permits session reuse', () => withTasks(async ({ host, rt, owner }) => {
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  const directory = join(host.home, 'restart')
  mkdirSync(directory)
  copyFileSync(join(host.home, 'state.json'), join(directory, 'state.json'))
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    await until(() => recovered.state.executions[receipt.executionId].status === 'cancelled')
    recovered.recoverLeadDelegations()
    assert.equal(recovered.state.executions[receipt.executionId].reason, 'restart-unsent')
    assert.equal(recovered.driverOf(receipt.session), undefined)
    assert.equal(recovered.state.tasks[receipt.taskId].status, 'stopped')
    assert.equal(recovered.conversationOf(owner.id).session.reportQueue, undefined)
    assert.equal(recovered.driverOf(owner.id), undefined)
    const next = await recovered.leadDispatch.delegate(owner.id, { ...command, taskId: receipt.taskId, session: receipt.session })
    assert.equal(next.session, receipt.session)
    await recovered.followLead(owner.id, turn('interrupted'))
  } finally {
    await restarted.dispose()
    await rt.followLead(owner.id, turn('interrupted'))
  }
}))

test('restart recovers multiple queued and running executions without duplicate delivery', () => withTasks(async ({ host, rt, owner }) => {
  const flights = []
  for (let index = 0; index < 4; index++) flights.push(await rt.leadDispatch.delegate(owner.id, { ...command, task: `Task ${index}` }))
  for (const item of flights.slice(2)) await rt.startExecution(item.executionId)
  const directory = join(host.home, 'parallel-restart')
  mkdirSync(directory)
  copyFileSync(join(host.home, 'state.json'), join(directory, 'state.json'))
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    recovered.recoverLeadDelegations()
    recovered.recoverLeadDelegations()
    await until(() => flights.every((item, index) => recovered.state.executions[item.executionId].status === (index < 2 ? 'cancelled' : 'unconfirmed')))
    await until(() => recovered.transcriptOf(owner.id).filter(line => line.origin?.kind === 'report').length === 2)
    await until(() => !recovered.workView()[owner.id]?.active && !recovered.conversationOf(owner.id).session.reportQueue)
    recovered.recoverLeadDelegations()
    await recovered.flushLeadReports(owner.id)
    for (const [index, item] of flights.entries()) {
      assert.equal(recovered.state.executions[item.executionId].reason, index < 2 ? 'restart-unsent' : 'restart')
      assert.equal(recovered.driverOf(item.session), undefined)
      assert.equal(recovered.transcriptOf(owner.id).filter(line => line.origin?.executionId === item.executionId).length, index < 2 ? 0 : 1)
      assert.equal(recovered.transcriptOf(owner.id).filter(line => line.delegation?.executionId === item.executionId && line.delegation.ended).length, index < 2 ? 0 : 1)
    }
  } finally {
    await restarted.dispose()
    await rt.followLead(owner.id, turn('interrupted'))
  }
}))

test('restart leaves persisted running executions unconfirmed without resending', () => withTasks(async ({ host, rt, owner }) => {
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  await rt.startExecution(receipt.executionId)
  const directory = join(host.home, 'running-restart')
  mkdirSync(directory)
  copyFileSync(join(host.home, 'state.json'), join(directory, 'state.json'))
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    await until(() => recovered.state.executions[receipt.executionId].status === 'unconfirmed')
    assert.equal(recovered.state.executions[receipt.executionId].reason, 'restart')
    assert.equal(recovered.state.tasks[receipt.taskId].status, 'blocked')
    assert.equal(recovered.driverOf(receipt.session), undefined)
    await until(() => recovered.state.executions[receipt.executionId].report && !recovered.workView()[owner.id]?.active && !recovered.conversationOf(owner.id).session.reportQueue)
    await assert.rejects(recovered.leadDispatch.delegate(owner.id, { ...command, taskId: receipt.taskId }), /pending execution/)
  } finally {
    await restarted.dispose()
    await rt.failExecution(receipt.executionId, { reason: 'fixture-cleanup' })
    await rt.followLead(owner.id, turn('interrupted'))
  }
}))

test('send rejects supplements for a missing task or another coordinator session without writing', () => withTasks(async ({ host, rt, workspace, lead, owner, other }) => {
  const task = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Owned task', brief: 'Owned', source: { kind: 'lead', sessionId: owner.id } })
  const linesOf = session => host.api('transcript', { profile: lead.id, session }).then(lines => lines.length)
  const before = await linesOf(owner.id)
  await assert.rejects(host.api('send', { profile: lead.id, session: owner.id, text: 'Supplement', taskId: 'missing' }), /No such task/)
  await assert.rejects(host.api('send', { profile: lead.id, session: other.id, text: 'Supplement', taskId: task.id }), /任务不属于本主控会话/)
  await assert.rejects(host.api('send', { profile: lead.id, session: owner.id, text: 'Supplement', taskId: '   ' }))
  assert.equal(await linesOf(owner.id), before)
  assert.equal(await linesOf(other.id), 0)
  assert.deepEqual(Object.values(rt.state.executions), [])
  const send = rt.send
  let brief
  rt.send = async (...args) => { brief = args[5]?.brief; return send(...args) }
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Supplement', taskId: task.id })
  await until(() => !rt.workView()[owner.id]?.active)
  const line = rt.transcriptOf(owner.id).find(line => line.text === 'Supplement')
  assert.equal(line.origin.taskId, task.id)
  assert.equal(line.text.includes('补充任务'), false)
  assert.match(brief, new RegExp(`补充任务 ${task.id} · Owned task`))
  assert.match(brief, /Delegation status comes from Nodo/)
}))

test('a task-origin supplement counts as the newest user request for a task created later', () => withTasks(async ({ host, rt, workspace, lead, owner }) => {
  const old = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Old task', brief: 'Old', source: { kind: 'lead', sessionId: owner.id } })
  await host.api('send', { profile: lead.id, session: owner.id, text: 'First user request' })
  await until(() => !rt.workView()[owner.id]?.active)
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Keep going on the old work', taskId: old.id })
  await until(() => !rt.workView()[owner.id]?.active)
  const fresh = await rt.leadDispatch.delegate(owner.id, command)
  const request = rt.state.tasks[fresh.taskId].source.request
  assert.equal(request.text, 'Keep going on the old work')
  assert.equal(request.references, undefined)
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'interrupted' }) })
  assert.equal(rt.state.executions[fresh.executionId].status, 'cancelled')
}))

test('task reads include initial state, scoped lists, polling updates and live structure refreshes', () => withTasks(async ({ host, rt, owner, workspace, lead }) => {
  const initial = await host.api('state')
  assert.deepEqual(initial.tasks, [])
  const abort = new AbortController()
  const route = host.routes.find(item => item.path === '/api/nodo/live')
  const reader = (await route.fetch(new Request(`http://test/api/nodo/live?struct=${initial.struct}`, { signal: abort.signal }))).body.getReader()
  const frame = async type => {
    while (true) {
      const value = JSON.parse(new TextDecoder().decode((await reader.read()).value))
      if (value.type === type) return value
    }
  }
  await frame('live')
  const receipt = await rt.leadDispatch.delegate(owner.id, command)
  await frame('structure')
  const fresh = await host.api('state')
  assert.equal(fresh.tasks[0].id, receipt.taskId)
  assert.equal((await host.api('state', { since: { struct: initial.struct } })).tasks[0].id, receipt.taskId)
  const detail = await host.api('task-get', { taskId: receipt.taskId, workspace: workspace.id, teamId: 'team' })
  assert.equal(detail.executions[0].id, receipt.executionId)
  assert.equal((await host.api('task-list', { workspace: workspace.id, teamId: 'team' })).length, 1)
  assert.deepEqual(await host.api('task-list', { teamId: 'other-team' }), [])
  await assert.rejects(host.api('task-get', { taskId: receipt.taskId, teamId: 'other-team' }), /outside/)
  await rt.followLead(owner.id, turn('interrupted'))
  const updated = await host.api('state', { since: { struct: fresh.struct } })
  assert.equal(updated.tasks[0].status, 'stopped')
  assert.equal((await host.api('task-get', { taskId: receipt.taskId })).executions[0].status, 'cancelled')
  const readOnly = rt.readOnly
  rt.readOnly = () => 'Read-only fixture'
  try {
    assert.equal((await host.api('task-get', { taskId: receipt.taskId })).id, receipt.taskId)
    assert.equal((await host.api('task-list', { workspace: workspace.id })).length, 1)
  } finally { rt.readOnly = readOnly }
  abort.abort()
  while (!(await reader.read()).done) {}
}))
