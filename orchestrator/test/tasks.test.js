import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/tasks.js'
import { install as installTeams } from '../core/src/teams.js'

const scope = { workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: 'Build', brief: 'Build and verify', source: { kind: 'user', messageId: 'm' } }
const route = { profileId: 'worker', sessionId: 's', type: 'code', hard: false, model: 'model', thinking: 'high' }
const result = { report: 'Implemented and tested', references: ['ref-1'] }
const fixture = () => {
  const sessions = { lead: { profile: { id: 'leader', lead: true }, session: { id: 'lead', workspaceRef: 'w' } },
    s: { profile: { id: 'worker' }, session: { id: 's', workspaceRef: 'w' } },
    s2: { profile: { id: 'worker' }, session: { id: 's2', workspaceRef: 'w' } },
    s3: { profile: { id: 'worker' }, session: { id: 's3', workspaceRef: 'w2' } } }
  const rt = { state: { tasks: {}, executions: {}, profiles: { leader: sessions.lead.profile, worker: sessions.s.profile },
    workspaces: { w: { id: 'w' }, w2: { id: 'w2' } }, prefs: { teams: [{ id: 't', lead: 'leader', members: ['worker'] }] } },
    load: async () => {}, readOnly: () => undefined, saveStrict: async () => {}, notifyLive: () => {},
    conversationOf: id => sessions[id], sessionWorkspace: (_profile, session) => rt.state.workspaces[session.workspaceRef],
    assertSessionWritable: () => {} }
  installTeams(rt)
  install(rt)
  return rt
}
const accepted = async rt => {
  const task = await rt.createTask(scope)
  return { task, execution: await rt.acceptExecution(task.id, route) }
}

test('task relationships stay within the coordinator and revise can replace or clear them', async () => {
  const rt = fixture()
  const parent = await rt.createTask(scope), dependency = await rt.createTask(scope)
  const empty = await rt.createTask({ ...scope, dependsOn: [] })
  assert.equal(Object.hasOwn(empty, 'dependsOn'), false)
  assert.equal(Object.hasOwn(rt.state.tasks[empty.id], 'dependsOn'), false)
  rt.state.tasks.foreign = { ...parent, id: 'foreign', coordinatorSessionId: 'other-lead' }
  const child = await rt.createTask({ ...scope, parentId: parent.id, dependsOn: [dependency.id] })
  assert.equal(child.parentId, parent.id)
  assert.deepEqual(child.dependsOn, [dependency.id])
  const before = structuredClone(rt.state.tasks)
  for (const id of ['missing', 'foreign']) for (const changes of [{ parentId: id }, { dependsOn: [id] }]) {
    await assert.rejects(rt.createTask({ ...scope, ...changes }), { code: 'orch/invalid', message: '关联任务不存在或不属于本主控会话' })
    await assert.rejects(rt.reviseTask(child.id, changes), { code: 'orch/invalid' })
  }
  await assert.rejects(rt.reviseTask(child.id, { status: 'done', dependsOn: [] }), { code: 'orch/invalid' })
  assert.deepEqual(rt.state.tasks, before)
  const revised = await rt.reviseTask(child.id, { parentId: dependency.id, dependsOn: [parent.id] })
  assert.equal(revised.parentId, dependency.id)
  assert.deepEqual(revised.dependsOn, [parent.id])
  revised.dependsOn.push('changed')
  assert.deepEqual((await rt.taskView(child.id)).dependsOn, [parent.id])
  const cleared = await rt.reviseTask(child.id, { parentId: '', dependsOn: [] })
  assert.equal(Object.hasOwn(cleared, 'parentId'), false)
  assert.equal(Object.hasOwn(cleared, 'dependsOn'), false)
  assert.equal(Object.hasOwn(rt.state.tasks[child.id], 'dependsOn'), false)
})

test('revise rejects self references, parent loops and dependencies on children or descendants', async () => {
  const rt = fixture()
  const parent = await rt.createTask(scope)
  const child = await rt.createTask({ ...scope, parentId: parent.id })
  const grandchild = await rt.createTask({ ...scope, parentId: child.id })
  const before = structuredClone(rt.state.tasks)
  for (const changes of [{ parentId: parent.id }, { dependsOn: [parent.id] }]) {
    await assert.rejects(rt.reviseTask(parent.id, changes), { code: 'orch/invalid', message: '任务不能以自己为父任务或依赖任务' })
  }
  for (const id of [child.id, grandchild.id]) {
    await assert.rejects(rt.reviseTask(parent.id, { parentId: id }), { code: 'orch/invalid', message: '父子关系成环' })
    await assert.rejects(rt.reviseTask(parent.id, { dependsOn: [id] }), { code: 'orch/invalid', message: '任务不能依赖自己的子孙任务' })
  }
  assert.deepEqual(rt.state.tasks, before)
})

test('create and revise terminate and reject an existing cyclic parent chain', async () => {
  const rt = fixture()
  const first = await rt.createTask(scope)
  const second = await rt.createTask({ ...scope, parentId: first.id })
  const other = await rt.createTask(scope)
  rt.state.tasks[first.id].parentId = second.id
  const before = structuredClone(rt.state.tasks)
  await assert.rejects(rt.createTask({ ...scope, parentId: first.id }), { code: 'orch/invalid', message: '父子关系成环' })
  await assert.rejects(rt.createTask({ ...scope, dependsOn: [second.id] }), { code: 'orch/invalid', message: '父子关系成环' })
  await assert.rejects(rt.reviseTask(other.id, { parentId: first.id }), { code: 'orch/invalid', message: '父子关系成环' })
  assert.deepEqual(rt.state.tasks, before)
})

test('create and revise reject attaching to a done parent until it is reopened', async () => {
  const rt = fixture()
  const { task: parent, execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  await rt.finishExecution(execution.id, result)
  await rt.completeTask(parent.id, { reason: 'Checked', references: result.references })
  const child = await rt.createTask(scope)
  const before = structuredClone(rt.state.tasks)
  await assert.rejects(rt.createTask({ ...scope, parentId: parent.id }), { code: 'orch/invalid', message: '父任务已验收，请先 reopen 父任务' })
  await assert.rejects(rt.reviseTask(child.id, { parentId: parent.id }), { code: 'orch/invalid', message: '父任务已验收，请先 reopen 父任务' })
  assert.deepEqual(rt.state.tasks, before)
  await rt.reopenTask(parent.id)
  assert.equal((await rt.reviseTask(child.id, { parentId: parent.id })).parentId, parent.id)
  assert.equal((await rt.createTask({ ...scope, parentId: parent.id })).parentId, parent.id)
})

test('parent acceptance requires all children done and still needs its own execution evidence', async () => {
  const rt = fixture()
  const parent = await rt.createTask(scope)
  const child = await rt.createTask({ ...scope, parentId: parent.id })
  await assert.rejects(rt.completeTask(parent.id, { reason: 'Too early', references: ['child-result'] }),
    { code: 'orch/invalid', message: '还有 1 个子任务未验收，先完成它们再验收本任务' })
  const childExecution = await rt.acceptExecution(child.id, route)
  await rt.startExecution(childExecution.id)
  await rt.finishExecution(childExecution.id, result)
  await rt.completeTask(child.id, { reason: 'Checked child', references: result.references })
  await assert.rejects(rt.completeTask(parent.id, { reason: 'No integration', references: result.references }),
    { code: 'orch/invalid', message: 'Acceptance evidence must reference task execution results' })
  const integration = await rt.acceptExecution(parent.id, route)
  await rt.startExecution(integration.id)
  await rt.finishExecution(integration.id, { report: 'Integrated', references: ['integration'] })
  const acceptance = { reason: 'Verified integration', references: ['integration'] }
  const sibling = await rt.createTask({ ...scope, parentId: parent.id })
  await rt.reopenTask(child.id)
  await assert.rejects(rt.completeTask(parent.id, acceptance), { code: 'orch/invalid', message: '还有 2 个子任务未验收，先完成它们再验收本任务' })
  await rt.completeTask(child.id, { reason: 'Checked again', references: result.references })
  const siblingExecution = await rt.acceptExecution(sibling.id, route)
  await rt.startExecution(siblingExecution.id)
  await rt.finishExecution(siblingExecution.id, result)
  await assert.rejects(rt.completeTask(parent.id, acceptance), { code: 'orch/invalid', message: '还有 1 个子任务未验收，先完成它们再验收本任务' })
  await rt.completeTask(sibling.id, { reason: 'Checked sibling', references: result.references })
  rt.state.tasks.foreign = { ...sibling, id: 'foreign', coordinatorSessionId: 'another-lead', status: 'open' }
  assert.equal((await rt.completeTask(parent.id, acceptance)).status, 'done')
  await rt.reopenTask(child.id)
  assert.equal((await rt.taskView(parent.id)).status, 'done', 'reopening a child never propagates status')
})

test('accept, start, waiting, finish, rework, complete and reopen follow the task lifecycle', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  assert.equal(task.status, 'open')
  assert.equal(execution.status, 'queued')
  assert.deepEqual([execution.type, execution.hard, execution.model, execution.thinking], ['code', false, 'model', 'high'])
  assert.ok(execution.createdAt > 0)
  assert.equal((await rt.startExecution(execution.id)).status, 'running')
  assert.equal((await rt.taskView(task.id)).status, 'open', 'waiting on an external approval does not change persistent status')
  assert.equal((await rt.finishExecution(execution.id, result)).status, 'done')
  assert.equal((await rt.taskView(task.id)).status, 'review')
  const second = await rt.acceptExecution(task.id, route)
  assert.notEqual(second.id, execution.id)
  assert.equal((await rt.taskView(task.id)).status, 'open')
  await rt.startExecution(second.id)
  await rt.finishExecution(second.id, { report: 'Reworked', references: ['ref-2'] })
  const done = await rt.completeTask(task.id, { reason: 'Verified', references: ['ref-2'] })
  assert.equal(done.status, 'done')
  assert.deepEqual(done.acceptances[0].executionIds, [second.id])
  assert.equal(done.executions[0].report, result.report)
  assert.ok(done.executions.every(item => item.startedAt >= item.createdAt && item.endedAt >= item.startedAt))
  const reopened = await rt.reopenTask(task.id)
  assert.equal(reopened.status, 'open')
  assert.deepEqual(reopened.acceptances, done.acceptances)
  const revised = await rt.reviseTask(task.id, { title: 'New title', brief: 'New scope' })
  assert.equal(revised.brief, 'New scope')
  assert.deepEqual(revised.source, scope.source)
  assert.deepEqual(revised.acceptances, done.acceptances)
  revised.source.messageId = 'changed'
  revised.executions[0].references.push('changed')
  assert.deepEqual((await rt.taskView(task.id)).source, scope.source, 'views cannot mutate records')
  assert.deepEqual((await rt.taskView(task.id)).executions[0].references, result.references)
})

for (const [method, allowed, status, taskStatus] of [
  ['startExecution', ['queued'], 'running', 'open'],
  ['finishExecution', ['running', 'unconfirmed'], 'done', 'review'],
  ['failExecution', ['queued', 'running', 'unconfirmed'], 'failed', 'blocked'],
  ['interruptExecution', ['running', 'unconfirmed'], 'interrupted', 'stopped'],
  ['cancelExecution', ['queued'], 'cancelled', 'stopped'],
  ['unconfirmExecution', ['queued', 'running'], 'unconfirmed', 'blocked'],
]) test(`${method} accepts only its defined source states`, async () => {
  for (const from of ['queued', 'running', 'done', 'failed', 'interrupted', 'cancelled', 'unconfirmed']) {
    const rt = fixture()
    const { task, execution } = await accepted(rt)
    rt.state.executions[execution.id].status = from
    rt.state.tasks[task.id].status = from === 'unconfirmed' ? 'blocked' : 'open'
    const before = structuredClone(rt.state)
    if (allowed.includes(from)) {
      const ended = await rt[method](execution.id, result)
      assert.equal(ended.status, status)
      assert.equal((await rt.taskView(task.id)).status, from === 'unconfirmed' ? 'blocked' : taskStatus)
    } else {
      await assert.rejects(rt[method](execution.id, result), { code: 'orch/invalid' })
      assert.deepEqual(rt.state, before)
    }
  }
})

test('stop request is runtime-only; engine confirmation or uncertainty determines persisted state', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  await assert.rejects(rt.requestExecutionStop(execution.id), { code: 'orch/invalid' })
  await rt.startExecution(execution.id)
  assert.equal((await rt.requestExecutionStop(execution.id)).stopping, true)
  assert.equal((await rt.taskView(task.id)).executions[0].stopping, true)
  const table = rt.state.executions
  let scans = 0
  rt.state.executions = new Proxy(table, { ownKeys: target => { scans++; return Reflect.ownKeys(target) } })
  assert.equal(rt.executionStopping(execution.sessionId), true)
  assert.equal(rt.executionStopping('s2'), false)
  assert.equal(scans, 0, 'executionStopping reads the stop table, never the execution table')
  assert.equal(rt.state.executions[execution.id].stopping, undefined)
  assert.equal(rt.state.executions[execution.id].status, 'running')
  assert.equal(rt.state.tasks[task.id].status, 'open')
  await rt.unconfirmExecution(execution.id, { reason: 'Stop not confirmed' })
  assert.equal((await rt.taskView(task.id)).executions[0].stopping, undefined)
  assert.equal(rt.executionStopping(execution.sessionId), false)
  assert.equal(rt.state.tasks[task.id].status, 'blocked')
})

test('cancel stops a first execution, while cancellation with history keeps the task open', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  await rt.cancelExecution(execution.id)
  assert.equal((await rt.taskView(task.id)).status, 'stopped')
  await rt.reopenTask(task.id)
  const next = await rt.acceptExecution(task.id, route)
  await rt.cancelExecution(next.id)
  assert.equal((await rt.taskView(task.id)).status, 'open')
})

test('pending executions reserve both task and session, including unconfirmed work', async () => {
  for (const status of ['queued', 'running', 'unconfirmed']) {
    const rt = fixture()
    const { task, execution } = await accepted(rt)
    if (status === 'running') await rt.startExecution(execution.id)
    if (status === 'unconfirmed') await rt.unconfirmExecution(execution.id)
    const other = await rt.createTask(scope)
    await assert.rejects(rt.acceptExecution(task.id, { ...route, sessionId: 's2' }), { code: 'orch/busy' })
    await assert.rejects(rt.acceptExecution(other.id, route), { code: 'orch/busy' })
    assert.equal((await rt.acceptExecution(other.id, { ...route, sessionId: 's2' })).status, 'queued')
  }
  const rt = fixture()
  const task = await rt.createTask(scope)
  const attempts = await Promise.allSettled([rt.acceptExecution(task.id, route), rt.acceptExecution(task.id, route)])
  assert.deepEqual(attempts.map(item => item.status), ['fulfilled', 'rejected'])
})

test('an execution may bind its own workspace only when its session lives there', async () => {
  const rt = fixture()
  const task = await rt.createTask(scope)
  const execution = await rt.acceptExecution(task.id, { ...route, sessionId: 's3', workspaceRef: 'w2' })
  assert.equal(execution.workspaceRef, 'w2', 'a differing execution workspace is recorded')
  await rt.startExecution(execution.id)
  await rt.finishExecution(execution.id)
  for (const changes of [{ sessionId: 's3' }, { sessionId: 's3', workspaceRef: 'missing' }, { sessionId: 's3', workspaceRef: '' }]) {
    await assert.rejects(rt.acceptExecution(task.id, { ...route, ...changes }), { code: 'orch/invalid' })
  }
  const plain = await rt.acceptExecution(task.id, route)
  assert.equal(plain.workspaceRef, undefined)
  assert.equal('workspaceRef' in rt.state.executions[plain.id], false, 'the task workspace stays implicit')
  await rt.startExecution(plain.id)
  await rt.finishExecution(plain.id)
  assert.equal((await rt.acceptExecution(task.id, { ...route, workspaceRef: 'w' })).workspaceRef, undefined)
})

test('complete requires resolved execution results and linked evidence with a reason', async () => {
  const rt = fixture()
  const task = await rt.createTask(scope)
  const acceptance = { reason: 'Verified', references: ['ref-1'] }
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  const execution = await rt.acceptExecution(task.id, route)
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.startExecution(execution.id)
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.unconfirmExecution(execution.id, result)
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.finishExecution(execution.id)
  for (const bad of [{ ...acceptance, reason: '' }, { ...acceptance, references: [] }, { ...acceptance, references: ['unrelated'] }]) {
    await assert.rejects(rt.completeTask(task.id, bad), { code: 'orch/invalid' })
  }
  assert.equal((await rt.completeTask(task.id, acceptance)).status, 'done')
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/invalid' })
  await rt.reopenTask(task.id)
  await assert.rejects(rt.reopenTask(task.id), { code: 'orch/invalid' })
  const next = await rt.acceptExecution(task.id, route)
  await rt.startExecution(next.id)
  await rt.finishExecution(next.id)
  assert.equal((await rt.completeTask(task.id, acceptance)).acceptances.length, 2)

  const empty = fixture()
  const acceptedEmpty = await accepted(empty)
  await empty.startExecution(acceptedEmpty.execution.id)
  await empty.finishExecution(acceptedEmpty.execution.id)
  await assert.rejects(empty.completeTask(acceptedEmpty.task.id, acceptance), { code: 'orch/invalid' })
})

test('late results only update the bound execution, including after reuse and acceptance', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  await assert.rejects(rt.recordExecutionResult(execution.id, result), { code: 'orch/invalid' })
  await rt.startExecution(execution.id)
  await rt.unconfirmExecution(execution.id)
  const blocked = structuredClone(rt.state.tasks[task.id])
  await rt.finishExecution(execution.id, result)
  assert.deepEqual(rt.state.tasks[task.id], blocked)
  const next = await rt.acceptExecution(task.id, route)
  const before = structuredClone(rt.state)
  await rt.recordExecutionResult(execution.id, { report: 'Late report', references: ['late-ref'] })
  assert.deepEqual(rt.state.tasks, before.tasks)
  assert.deepEqual(rt.state.executions[next.id], before.executions[next.id])
  assert.equal(rt.state.executions[execution.id].status, 'done')
  assert.equal(rt.state.executions[execution.id].report, result.report)
  assert.deepEqual(rt.state.executions[execution.id].references, ['ref-1', 'late-ref'])
  await rt.startExecution(next.id)
  await rt.finishExecution(next.id, result)
  await rt.completeTask(task.id, { reason: 'Checked', references: ['ref-1'] })
  const completed = structuredClone(rt.state.tasks[task.id])
  await rt.recordExecutionResult(execution.id, { report: 'Even later' })
  assert.deepEqual(rt.state.tasks[task.id], completed)
})

test('identity, ownership, field validation and read-only errors leave records unchanged', async () => {
  const rt = fixture()
  for (const changes of [{ workspaceRef: 'missing' }, { teamId: 'missing' }, { coordinatorSessionId: 's' }, { title: '' }, { source: null }]) {
    await assert.rejects(rt.createTask({ ...scope, ...changes }), { code: 'orch/invalid' })
  }
  const task = await rt.createTask(scope)
  for (const changes of [{ profileId: 'leader' }, { sessionId: 'lead' }, { sessionId: 'missing' }, { hard: 'false' }, { model: '' }, { type: '' }]) {
    await assert.rejects(rt.acceptExecution(task.id, { ...route, ...changes }), { code: 'orch/invalid' })
  }
  assert.deepEqual(rt.state.executions, {})
  const before = structuredClone(rt.state)
  for (const changes of [{ status: 'done' }, { teamId: 'other' }, { brief: '' }]) await assert.rejects(rt.reviseTask(task.id, changes), { code: 'orch/invalid' })
  assert.deepEqual(rt.state, before)
  await assert.rejects(rt.taskView('missing'), { code: 'orch/not-found' })
  await assert.rejects(rt.startExecution('missing'), { code: 'orch/not-found' })
  rt.readOnly = () => 'Read only'
  await assert.rejects(rt.reviseTask(task.id, { title: 'Changed' }), { code: 'orch/read-only' })
  assert.deepEqual(rt.state, before)
  rt.readOnly = () => undefined
  rt.saveStrict = async () => { throw Object.assign(new Error('Write failed'), { code: 'EIO' }) }
  await assert.rejects(rt.reviseTask(task.id, { title: 'Retained for retry' }), { code: 'EIO' })
  assert.equal(rt.state.tasks[task.id].title, 'Retained for retry')
})

test('accept, complete and reopen validate every task source state', async () => {
  for (const status of ['open', 'review', 'blocked', 'done', 'stopped']) {
    for (const [method, allowed] of [
      ['acceptExecution', ['open', 'review', 'blocked']],
      ['completeTask', ['open', 'review', 'blocked']],
      ['reopenTask', ['done', 'stopped']],
      ['reviseTask', ['open', 'review', 'blocked']],
    ]) {
      const rt = fixture()
      const { task, execution } = await accepted(rt)
      await rt.startExecution(execution.id)
      await rt.finishExecution(execution.id, result)
      rt.state.tasks[task.id].status = status
      const before = structuredClone(rt.state)
      const input = method === 'acceptExecution' ? route : method === 'reviseTask' ? { title: 'Changed' } : { reason: 'Verified', references: ['ref-1'] }
      if (allowed.includes(status)) await rt[method](task.id, input)
      else {
        await assert.rejects(rt[method](task.id, input), { code: 'orch/invalid' })
        assert.deepEqual(rt.state, before)
      }
    }
  }
})

test('invalid result fields and dangling task associations are rejected before mutation', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  const before = structuredClone(rt.state)
  for (const input of [{ report: '' }, { references: [''] }, { references: 'ref' }, { reason: '' }]) {
    await assert.rejects(rt.finishExecution(execution.id, input), { code: 'orch/invalid' })
    assert.deepEqual(rt.state, before)
  }
  await assert.rejects(rt.acceptExecution('missing', route), { code: 'orch/not-found' })
  delete rt.state.tasks[task.id]
  await assert.rejects(rt.finishExecution(execution.id, result), { code: 'orch/not-found' })
  assert.deepEqual(rt.state.executions, before.executions)
})

test('missing or archived owners refuse new work while historical views retain their scope', async () => {
  const rt = fixture()
  const task = await rt.createTask(scope)
  const before = await rt.taskView(task.id)
  rt.assertSessionWritable = () => { throw Object.assign(new Error('Archived'), { code: 'orch/refused' }) }
  await assert.rejects(rt.createTask(scope), { code: 'orch/refused' })
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/refused' })
  rt.state.prefs.teams = []
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/invalid' })
  delete rt.state.workspaces.w
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/invalid' })
  assert.deepEqual(await rt.taskView(task.id), before)
})

test('creating and accepting use the team accessor before any state read', async () => {
  const rt = fixture()
  delete rt.state.prefs.teams
  const teams = rt.teams
  let reads = 0
  rt.teams = () => {
    reads++
    const derived = teams()
    derived[0].id = scope.teamId
    return derived
  }
  const task = await rt.createTask(scope)
  assert.equal(reads, 1)
  assert.equal(rt.state.prefs.teams[0].lead, 'leader')
  delete rt.state.prefs.teams
  await rt.acceptExecution(task.id, route)
  assert.equal(reads, 2)
})

test('missing team members produce a domain validation error', async () => {
  const rt = fixture()
  const task = await rt.createTask(scope)
  delete rt.state.prefs.teams[0].members
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/invalid' })
  assert.deepEqual(rt.state.executions, {})
})

test('source shape and clone failures produce domain validation errors before creating records', async () => {
  const rt = fixture()
  for (const source of [null, [], 'message', { nested: { callback() {} } }, { value: Symbol('source') }]) {
    await assert.rejects(rt.createTask({ ...scope, source }), { code: 'orch/invalid' })
    assert.deepEqual(rt.state.tasks, {})
  }
})

test('accepted reports and evidence remain linked when late results append references', async () => {
  const rt = fixture()
  const { task, execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  await rt.unconfirmExecution(execution.id, result)
  await rt.finishExecution(execution.id, { report: 'Replacement', references: ['ref-1', 'ref-2', 'ref-2'] })
  const done = await rt.completeTask(task.id, { reason: 'Checked', references: ['ref-1', 'ref-2'] })
  rt.state.executions[execution.id].references.push('ref-2')
  const late = await rt.recordExecutionResult(execution.id, { report: 'Another replacement', references: ['ref-2', 'ref-3', 'ref-3'] })
  assert.equal(late.report, result.report)
  assert.deepEqual(late.references, ['ref-1', 'ref-2', 'ref-3'])
  assert.ok(done.acceptances[0].references.every(ref => late.references.includes(ref)))
  assert.deepEqual(rt.state.tasks[task.id].acceptances, done.acceptances)
  let saves = 0
  rt.saveStrict = async () => { saves++ }
  const before = structuredClone(rt.state)
  for (const input of [undefined, {}, { references: [] }, { references: ['ref-1'] }, { report: 'Ignored' }]) {
    assert.deepEqual(await rt.recordExecutionResult(execution.id, input), late)
  }
  assert.equal(saves, 0)
  assert.deepEqual(rt.state, before)
})

const unavailableScopes = [
  ['deleted workspace', rt => { delete rt.state.workspaces.w }],
  ['workspace marked deletedAt', rt => { rt.state.workspaces.w.deletedAt = Date.now() }],
  ['missing team', rt => { rt.state.prefs.teams = [] }],
]

for (const [label, removeScope] of unavailableScopes) test(`${label} refuses task writes but retains execution results`, async () => {
  for (const method of ['reviseTask', 'completeTask', 'reopenTask', 'acceptExecution']) {
    const rt = fixture()
    const { task, execution } = await accepted(rt)
    await rt.startExecution(execution.id)
    await rt.finishExecution(execution.id, result)
    if (method === 'reopenTask') await rt.completeTask(task.id, { reason: 'Checked', references: result.references })
    removeScope(rt)
    const before = structuredClone(rt.state)
    const input = method === 'reviseTask' ? { title: 'Changed' }
      : method === 'acceptExecution' ? route : { reason: 'Checked', references: result.references }
    await assert.rejects(rt[method](task.id, input), { code: 'orch/invalid' })
    assert.deepEqual(rt.state, before)
    assert.equal((await rt.taskView(task.id)).workspaceRef, scope.workspaceRef)
  }
  for (const method of ['finishExecution', 'failExecution', 'interruptExecution', 'cancelExecution', 'unconfirmExecution', 'recordExecutionResult']) {
    const rt = fixture()
    const { task, execution } = await accepted(rt)
    if (method !== 'cancelExecution') await rt.startExecution(execution.id)
    if (method === 'recordExecutionResult') await rt.finishExecution(execution.id)
    removeScope(rt)
    const ended = await rt[method](execution.id, result)
    assert.equal(ended.report, result.report)
    assert.deepEqual(ended.references, result.references)
    assert.equal((await rt.taskView(task.id)).executions[0].report, result.report)
  }
})

test('failed acceptance saves retain the queued task and session reservations for S1 recovery', async () => {
  const rt = fixture()
  const task = await rt.createTask(scope)
  const other = await rt.createTask(scope)
  rt.saveStrict = async () => { throw Object.assign(new Error('Write failed'), { code: 'EIO' }) }
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'EIO' })
  const execution = Object.values(rt.state.executions)[0]
  assert.equal(execution.status, 'queued')
  rt.saveStrict = async () => {}
  await assert.rejects(rt.acceptExecution(task.id, route), { code: 'orch/busy' })
  await assert.rejects(rt.acceptExecution(task.id, { ...route, sessionId: 's2' }), { code: 'orch/busy' })
  await assert.rejects(rt.acceptExecution(other.id, route), { code: 'orch/busy' })
  assert.equal(Object.keys(rt.state.executions).length, 1)
})
