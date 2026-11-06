import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install, executionResultView } from '../core/src/tasks.js'
import { install as installTeams } from '../core/src/teams.js'
import { install as installContext } from '../core/src/context.js'
import { RESULT_PREVIEW_MAX, RESULT_TEXT_MAX, RESULTS_TEXT_MAX, CONTEXT_PAGE_MAX } from '../core/src/constants.js'

const scope = { workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: 'Build', brief: 'Build and verify', source: { kind: 'user', messageId: 'm' } }
const route = { profileId: 'worker', sessionId: 's', type: 'code', hard: false, model: 'model', thinking: 'high' }
const result = { report: 'Implemented and tested', references: ['ref-1'] }
const fixture = () => {
  const sessions = { lead: { profile: { id: 'leader', lead: true }, session: { id: 'lead', workspaceRef: 'w' } },
    s: { profile: { id: 'worker' }, session: { id: 's', workspaceRef: 'w' } },
    s2: { profile: { id: 'worker' }, session: { id: 's2', workspaceRef: 'w' } },
    s3: { profile: { id: 'worker' }, session: { id: 's3', workspaceRef: 'w2' } } }
  const rt = { state: { tasks: {}, executions: {}, decisions: {}, streamDetails: {}, profiles: { leader: sessions.lead.profile, worker: sessions.s.profile },
    workspaces: { w: { id: 'w' }, w2: { id: 'w2' } }, prefs: { teams: [{ id: 't', lead: 'leader', members: ['worker'] }] } },
    load: async () => {}, readOnly: () => undefined, saveStrict: async () => {}, notifyLive: () => {},
    conversationOf: id => sessions[id], sessionWorkspace: (_profile, session) => rt.state.workspaces[session.workspaceRef],
    transcriptOf: () => [], readStreamDetail: async () => { throw new Error('No tool details') },
    assertSessionWritable: () => {}, redactDeepSecrets: value => value, readReference: async () => { throw new Error('No retained reference') } }
  installTeams(rt)
  installContext(rt)
  install(rt)
  return rt
}
const accepted = async rt => {
  const task = await rt.createTask(scope)
  return { task, execution: await rt.acceptExecution(task.id, route) }
}

test('results archive the redacted final once and default task views omit the body', async () => {
  const rt = fixture(), { task, execution } = await accepted(rt)
  rt.redactDeepSecrets = value => value.replaceAll('fixture-private', '[redacted]')
  const final = 'Result fixture-private\n' + '正文🙂\n'.repeat(10000)
  await rt.startExecution(execution.id)
  const ended = await rt.finishExecution(execution.id, { final })
  const saved = structuredClone(rt.state.executions[execution.id].result)
  assert.equal(saved.text, final.replaceAll('fixture-private', '[redacted]'))
  assert.equal(saved.completeness, 'complete')
  assert.equal(saved.preview.length, RESULT_PREVIEW_MAX)
  assert.equal(saved.originalLength, saved.text.length)
  assert.equal(ended.result.text, undefined)
  const view = await rt.taskView(task.id)
  assert.deepEqual(view.executions[0].result, ended.result)
  assert.equal(view.executions[0].result.sourceId, `execution:${execution.id}:result`)
  await rt.recordExecutionResult(execution.id, { final: 'replacement', report: 'summary', references: ['ref'] })
  assert.deepEqual(rt.state.executions[execution.id].result, saved)
  let body = '', offset = 0
  do {
    const page = await rt.executionContext('lead', { action: 'read', sourceId: ended.result.sourceId, offset, limit: 777 })
    body += page.text
    offset = page.nextOffset
    assert.equal(page.status, 'done')
    assert.equal(page.length, saved.text.length)
  } while (offset !== null)
  assert.equal(body, saved.text)
  const beyond = await rt.executionContext('lead', { action: 'read', sourceId: ended.result.sourceId, offset: saved.text.length + 1 })
  assert.equal(beyond.text, '')
  assert.equal(beyond.nextOffset, null)
})

test('failed, interrupted, unconfirmed and missing finals retain real execution status', async () => {
  for (const [method, status, final] of [['failExecution', 'failed', '成功'], ['interruptExecution', 'interrupted', '成功'],
    ['unconfirmExecution', 'unconfirmed', '成功'], ['finishExecution', 'done', undefined]]) {
    const rt = fixture(), { execution } = await accepted(rt)
    await rt.startExecution(execution.id)
    await rt[method](execution.id, { final, reason: 'driver-reason', report: 'A summary is not a final reply' })
    const read = await rt.executionContext('lead', { action: 'read', sourceId: `execution:${execution.id}:result` })
    assert.equal(read.status, status)
    assert.equal(read.executionReason, 'driver-reason')
    assert.equal(read.text, final ?? '')
    assert.equal(read.completeness, final ? 'partial' : 'unavailable')
    assert.equal(read.reason, final ? 'capture-incomplete' : 'missing-final')
    if (status === 'unconfirmed') {
      const saved = structuredClone(rt.state.executions[execution.id].result)
      await rt.finishExecution(execution.id, { final: 'Late reply' })
      assert.deepEqual(rt.state.executions[execution.id].result, saved, 'late confirmation does not rewrite archived output')
      assert.equal((await rt.executionContext('lead', { action: 'read', sourceId: read.sourceId })).status, 'done')
    }
  }
  const rt = fixture(), { execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  await rt.finishExecution(execution.id, { final: 'available fragment', finalCapture: 'partial' })
  assert.equal(rt.state.executions[execution.id].result.completeness, 'partial')
})

test('late confirmation fills only an unavailable missing final when a final is provided', async () => {
  for (const final of [undefined, 'Confirmed final']) {
    const rt = fixture(), { execution } = await accepted(rt)
    await rt.startExecution(execution.id)
    await rt.unconfirmExecution(execution.id, { reason: 'cancel-timeout' })
    const original = structuredClone(rt.state.executions[execution.id].result)
    assert.equal(original.completeness, 'unavailable')
    assert.equal(original.reason, 'missing-final')
    await rt.finishExecution(execution.id, { final })
    const saved = rt.state.executions[execution.id].result
    if (final) {
      assert.equal(saved.text, final)
      assert.equal(saved.completeness, 'complete')
      await rt.recordExecutionResult(execution.id, { final: 'replacement', report: 'Summary' })
      assert.deepEqual(rt.state.executions[execution.id].result, saved)
    } else assert.deepEqual(saved, original)
  }
  for (const result of [{ text: 'Original complete', completeness: 'complete', reason: null },
    { text: 'Original partial', completeness: 'partial', reason: 'capture-incomplete' },
    { text: '', completeness: 'unavailable', reason: 'storage-limit' }]) {
    const rt = fixture(), { execution } = await accepted(rt)
    await rt.startExecution(execution.id)
    await rt.unconfirmExecution(execution.id)
    Object.assign(rt.state.executions[execution.id].result, result)
    const original = structuredClone(rt.state.executions[execution.id].result)
    await rt.finishExecution(execution.id, { final: 'Cannot replace an archived result' })
    assert.deepEqual(rt.state.executions[execution.id].result, original)
  }
})

test('queued cancellation and confirmed-unsent cancellation archive readable results', async () => {
  for (const [method, running] of [['cancelExecution', false], ['cancelUnsentExecution', false], ['cancelUnsentExecution', true]]) {
    for (const final of [undefined, 'Cancelled with available output']) {
      const rt = fixture(), { execution } = await accepted(rt)
      if (running) await rt.startExecution(execution.id)
      await rt[method](execution.id, { final, reason: 'not-sent' })
      const read = await rt.executionContext('lead', { action: 'read', sourceId: `execution:${execution.id}:result` })
      assert.equal(read.status, 'cancelled')
      assert.equal(read.executionReason, 'not-sent')
      assert.equal(read.text, final ?? '')
      assert.equal(read.completeness, final ? 'partial' : 'unavailable')
      assert.equal(read.reason, final ? 'capture-incomplete' : 'missing-final')
      assert.equal(rt.state.executions[execution.id].startedAt, null)
    }
  }
})

test('per-result and aggregate storage limits retain a marked prefix without evicting older results', async () => {
  const rt = fixture(), { execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  await rt.finishExecution(execution.id, { final: 'x'.repeat(RESULT_TEXT_MAX + 1) })
  const saved = rt.state.executions[execution.id].result
  assert.equal(saved.text.length, RESULT_TEXT_MAX)
  assert.equal(saved.originalLength, RESULT_TEXT_MAX + 1)
  assert.equal(saved.reason, 'storage-limit')
  assert.equal(saved.completeness, 'partial')
  for (let index = 1; index < RESULTS_TEXT_MAX / RESULT_TEXT_MAX; index++) rt.state.executions[`quota-${index}`] = { result: { text: 'x'.repeat(RESULT_TEXT_MAX) } }
  rt.state.executions['quota-1'].result.text = 'x'.repeat(RESULT_TEXT_MAX - 3)
  const second = await rt.acceptExecution(execution.taskId, route)
  await rt.startExecution(second.id)
  await rt.finishExecution(second.id, { final: 'abcdef' })
  assert.equal(rt.state.executions[second.id].result.text, 'abc')
  assert.equal(rt.state.executions[second.id].result.reason, 'storage-limit')
  const third = await rt.acceptExecution(execution.taskId, route)
  await rt.startExecution(third.id)
  await rt.finishExecution(third.id, { final: 'abcdef' })
  assert.equal(rt.state.executions[third.id].result.completeness, 'unavailable')
  assert.equal(rt.state.executions[third.id].result.reason, 'storage-limit')
  assert.equal(rt.state.executions[execution.id].result, saved)
})

test('legacy snapshots and summaries are read without rewriting records or manufacturing missing originals', async () => {
  const rt = fixture(), { execution } = await accepted(rt)
  const legacy = rt.state.executions[execution.id]
  Object.assign(legacy, { status: 'done', report: 'retained summary', references: ['lost', 'kept'] })
  delete legacy.result
  rt.readReference = async ({ id, target }) => {
    assert.equal(target, 'lead')
    if (id === 'lost') throw new Error('unavailable')
    return { messages: [{ text: 'retained original' }] }
  }
  const args = { action: 'read', sourceId: `execution:${execution.id}:result` }
  const check = async (reason, completeness, text) => {
    const read = await rt.executionContext('lead', args)
    const detail = (await rt.taskView(execution.taskId)).executions[0].result
    const directory = (await rt.executionContext('lead', { action: 'list' })).items[0]
    for (const metadata of [read, detail, directory, await executionResultView(legacy, rt)]) {
      assert.equal(metadata.reason, reason)
      assert.equal(metadata.completeness, completeness)
    }
    assert.equal(read.text, text)
    assert.equal(detail.text, undefined)
    assert.equal(directory.text, undefined)
  }
  const before = structuredClone(legacy)
  await check('legacy-reference', 'partial', 'retained original')
  assert.deepEqual(legacy, before)
  legacy.references = ['lost']
  await check('legacy-report', 'partial', 'retained summary')
  legacy.report = null
  await check('legacy-unavailable', 'unavailable', '')
  legacy.references = []
  await check('legacy-unavailable', 'unavailable', '')
})

test('context rejects invalid pagination and actions at the boundary', async () => {
  const rt = fixture(), { execution } = await accepted(rt)
  const args = { action: 'read', sourceId: `execution:${execution.id}:result` }
  assert.equal((await rt.executionContext('lead', args)).reason, 'not-archived')
  for (const extra of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 },
    { limit: CONTEXT_PAGE_MAX + 1 }, { limit: '20' }, { sourceId: 'execution:invalid' }, { taskId: execution.taskId }]) {
    await assert.rejects(rt.executionContext('lead', { ...args, ...extra }), { code: 'orch/invalid' })
  }
  for (const extra of [{ query: 'x'.repeat(201) }, { cursor: '-1' }, { cursor: '01' }, { cursor: '9007199254740992' }, { limit: 1 }]) {
    await assert.rejects(rt.executionContext('lead', { action: 'list', ...extra }), { code: 'orch/invalid' })
  }
  await assert.rejects(rt.executionContext('lead', { action: 'write' }), { code: 'orch/invalid' })
  await assert.rejects(rt.executionContext('s', args), { code: 'orch/invalid' })
})

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
  await rt.completeTask(parent.id, { reason: 'Checked', executionIds: [execution.id], basis: ['Verified result'] })
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
  await rt.completeTask(child.id, { reason: 'Checked child', executionIds: [childExecution.id], basis: ['Verified child'] })
  await assert.rejects(rt.completeTask(parent.id, { reason: 'No integration', executionIds: [childExecution.id], basis: ['Child is not integration'] }),
    { code: 'orch/invalid', message: 'Acceptance executions must belong to this task and have archived results' })
  const integration = await rt.acceptExecution(parent.id, route)
  await rt.startExecution(integration.id)
  await rt.finishExecution(integration.id, { report: 'Integrated', references: ['integration'] })
  const acceptance = { reason: 'Verified integration', executionIds: [integration.id], basis: ['Verified integration'] }
  const sibling = await rt.createTask({ ...scope, parentId: parent.id })
  await rt.reopenTask(child.id)
  await assert.rejects(rt.completeTask(parent.id, acceptance), { code: 'orch/invalid', message: '还有 2 个子任务未验收，先完成它们再验收本任务' })
  await rt.completeTask(child.id, { reason: 'Checked again', executionIds: [childExecution.id], basis: ['Verified child again'] })
  const siblingExecution = await rt.acceptExecution(sibling.id, route)
  await rt.startExecution(siblingExecution.id)
  await rt.finishExecution(siblingExecution.id, result)
  await assert.rejects(rt.completeTask(parent.id, acceptance), { code: 'orch/invalid', message: '还有 1 个子任务未验收，先完成它们再验收本任务' })
  await rt.completeTask(sibling.id, { reason: 'Checked sibling', executionIds: [siblingExecution.id], basis: ['Verified sibling'] })
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
  const done = await rt.completeTask(task.id, { reason: 'Verified', executionIds: [second.id], basis: ['Verified rework'] })
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
  const acceptance = { reason: 'Verified', executionIds: ['missing'], basis: ['Verified result'] }
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  const execution = await rt.acceptExecution(task.id, route)
  acceptance.executionIds = [execution.id]
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.startExecution(execution.id)
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.unconfirmExecution(execution.id, result)
  await assert.rejects(rt.completeTask(task.id, acceptance), { code: 'orch/invalid' })
  await rt.finishExecution(execution.id)
  for (const bad of [{ ...acceptance, reason: '' }, { ...acceptance, executionIds: [] }, { ...acceptance, executionIds: ['unrelated'] }, { ...acceptance, basis: [] }, { ...acceptance, basis: [' '] }]) {
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
  await rt.completeTask(task.id, { reason: 'Checked', executionIds: [execution.id], basis: ['Verified result'] })
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
      const input = method === 'acceptExecution' ? route : method === 'reviseTask' ? { title: 'Changed' } : { reason: 'Verified', executionIds: [execution.id], basis: ['Verified result'] }
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
  delete rt.state.executions[execution.id].result
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
    if (method === 'reopenTask') await rt.completeTask(task.id, { reason: 'Checked', executionIds: [execution.id], basis: ['Verified result'] })
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

test('acceptance distinguishes archived executions, cross-task results and purely legacy references', async () => {
  const rt = fixture(), { task, execution } = await accepted(rt)
  await rt.startExecution(execution.id)
  await rt.finishExecution(execution.id, { final: 'Verified result', references: ['manual-ref'] })
  const acceptance = { executionIds: [execution.id], reason: 'Checked files and tests', basis: ['result paragraph and test command'] }
  const foreign = await rt.createTask(scope)
  await assert.rejects(rt.completeTask(foreign.id, acceptance), /belong to this task/)
  for (const input of [{ reason: 'Checked', references: ['manual-ref'] }, { ...acceptance, references: ['manual-ref'] },
    { reason: 'Checked', executionIds: [execution.id] }, { ...acceptance, basis: [' '] }]) {
    await assert.rejects(rt.completeTask(task.id, input), { code: 'orch/invalid' })
  }
  const archived = rt.state.executions[execution.id].result
  rt.state.executions[execution.id].result = null
  await assert.rejects(rt.completeTask(task.id, acceptance), /archived results/)
  rt.state.executions[execution.id].result = archived
  assert.equal((await rt.completeTask(task.id, acceptance)).status, 'done')
  await rt.reopenTask(task.id)
  delete rt.state.executions[execution.id].result
  const old = await rt.completeTask(task.id, { reason: 'Legacy acceptance', references: ['manual-ref'] })
  assert.deepEqual(old.acceptances[1].references, ['manual-ref'])
  assert.deepEqual(old.acceptances[0].basis, acceptance.basis)
  await rt.reopenTask(task.id)
  const next = await rt.acceptExecution(task.id, route)
  await rt.startExecution(next.id)
  await rt.finishExecution(next.id, { final: 'New result' })
  await assert.rejects(rt.completeTask(task.id, { reason: 'Cannot bypass new result', references: ['manual-ref'] }), /New execution results/)
})
