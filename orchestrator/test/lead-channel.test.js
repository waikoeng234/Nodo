import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../core/src/lead.js'

const harness = () => {
  const owner = { id: 'lead', engine: 'claude' }
  const lead = { id: 'leader', lead: true, sessions: [owner] }
  const worker = { id: 'worker', name: 'Worker', sessions: [] }
  const rt = { state: { profiles: { leader: lead, worker }, tasks: {}, executions: {}, workspaces: {} },
    ctx: { effect() {} }, load: async () => {}, assertSessionWritable() {},
    conversationOf: id => id === owner.id ? { profile: lead, session: owner } : undefined,
    redactDeepSecrets: value => value, workView: () => ({}), readReference: async () => { throw new Error('Snapshot unavailable') } }
  install(rt)
  return { rt, owner, worker }
}

test('task board returns bounded summaries, retaining active executions', async () => {
  const { rt, owner } = harness()
  for (let index = 0; index < 20; index++) {
    const id = `task-${index}`
    rt.state.tasks[id] = { id, title: `Task ${index}`, brief: 'Private full brief', status: 'review', teamId: 'team', coordinatorSessionId: owner.id, updatedAt: index }
    rt.state.executions[id] = { id, taskId: id, sessionId: id, status: 'done', references: [`ref-${index}`], report: 'Private report' }
  }
  for (const [index, status] of [[0, 'running'], [1, 'queued'], [2, 'unconfirmed']]) rt.state.executions[`task-${index}`].status = status
  rt.state.tasks['task-19'].parentId = 'task-18'
  rt.state.tasks['task-19'].dependsOn = ['task-17']
  rt.state.executions.followup = { id: 'followup', taskId: 'task-19', sessionId: 'another', status: 'done', references: ['ref-19', 'new-ref'] }
  rt.state.tasks.foreign = { id: 'foreign', coordinatorSessionId: 'another-lead', updatedAt: 100 }
  rt.taskView = async () => { throw new Error('List must not load full task views') }
  const rows = await rt.leadTasks(owner.id)
  assert.equal(rows.length, 13)
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([0, 1, 2, ...Array.from({ length: 10 }, (_, index) => index + 10)].map(index => `task-${index}`)))
  assert.deepEqual(rows[0], { id: 'task-19', title: 'Task 19', status: 'review', teamId: 'team', parentId: 'task-18', dependsOn: ['task-17'], executionCount: 2, latestExecutionStatus: 'done', references: ['ref-19', 'new-ref'],
    latestResult: { sourceId: 'execution:followup:result', completeness: 'unavailable', reason: 'legacy-unavailable', preview: '', length: 0 } })
  rows[0].dependsOn.push('changed')
  assert.deepEqual(rt.state.tasks['task-19'].dependsOn, ['task-17'])
  assert.ok(rows.every(row => !('brief' in row) && !('executions' in row) && !('report' in row)))
  const detail = { ...rt.state.tasks['task-19'], executions: [rt.state.executions.followup] }
  rt.taskView = async () => detail
  assert.deepEqual(await rt.leadTasks(owner.id, 'task-19'), detail)
})

test('task board exposes only the latest result preview and handle', async () => {
  const { rt, owner } = harness()
  rt.state.tasks.task = { id: 'task', title: 'Task', coordinatorSessionId: owner.id, updatedAt: 1 }
  rt.state.executions.first = { id: 'first', taskId: 'task', status: 'done', references: [], result: { text: 'old body', preview: 'old preview' } }
  rt.state.executions.second = { id: 'second', taskId: 'task', status: 'failed', references: [],
    result: { text: 'long body'.repeat(10000), preview: 'short preview', completeness: 'partial', length: 90000, reason: 'capture-incomplete' } }
  const [summary] = await rt.leadTasks(owner.id)
  assert.equal(summary.latestResult.sourceId, 'execution:second:result')
  assert.equal(summary.latestResult.preview, 'short preview')
  assert.equal(summary.latestResult.text, undefined)
  assert.equal(JSON.stringify(summary).includes('long body'), false)
})

test('legacy task board resolves retained snapshots, report summaries and missing originals consistently', async () => {
  const { rt, owner } = harness()
  rt.state.tasks.task = { id: 'task', title: 'Task', coordinatorSessionId: owner.id, updatedAt: 1 }
  const execution = rt.state.executions.legacy = { id: 'legacy', taskId: 'task', status: 'done', references: ['old'], report: 'summary' }
  rt.readReference = async () => ({ messages: [{ text: 'retained snapshot' }] })
  let result = (await rt.leadTasks(owner.id))[0].latestResult
  assert.equal(result.sourceId, 'execution:legacy:result')
  assert.equal(result.reason, 'legacy-reference')
  assert.equal(result.completeness, 'partial')
  assert.equal(result.text, undefined)
  rt.readReference = async () => { throw new Error('Snapshot unavailable') }
  result = (await rt.leadTasks(owner.id))[0].latestResult
  assert.equal(result.reason, 'legacy-report')
  assert.equal(result.completeness, 'partial')
  execution.report = null
  result = (await rt.leadTasks(owner.id))[0].latestResult
  assert.equal(result.reason, 'legacy-unavailable')
  assert.equal(result.completeness, 'unavailable')
  assert.equal(execution.result, undefined)
})

test('snapshots and delegation boards enumerate executions once for 2000 sessions', () => {
  const { rt, owner, worker } = harness()
  const executions = {}
  for (let index = 0; index < 2000; index++) {
    const id = `session-${index}`, taskId = `task-${index}`
    worker.sessions.push({ id, name: id, source: { kind: 'lead', leadSessionId: owner.id } })
    rt.state.tasks[taskId] = { brief: `Task ${index}` }
    executions[id] = { id, taskId, sessionId: id, type: 'feature', hard: false, status: 'done', createdAt: index + 1, endedAt: index + 2, reason: 'done' }
  }
  executions.latest = { ...executions['session-0'], id: 'latest', createdAt: 3000, endedAt: null, status: 'running' }
  let scans = 0
  rt.state.executions = new Proxy(executions, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  assert.match(rt.leadSnapshot(owner.id), /Task 0.*执行中/)
  assert.equal(scans, 1)
  scans = 0
  assert.match(rt.leadDelegations(owner.id), /Task 0.*执行中/)
  assert.equal(scans, 1)
})

test('interruption status does not repeat its reason label', () => {
  const { rt, owner, worker } = harness()
  rt.state.tasks.task = { workspaceRef: 'w', brief: 'Task' }
  const session = { id: 'executor', source: { kind: 'lead', leadSessionId: owner.id } }
  for (const stoppedBy of ['user', 'lead']) {
    const reason = `interrupted-${stoppedBy}`
    rt.state.executions.execution = { id: 'execution', taskId: 'task', sessionId: session.id, type: 'feature', hard: false, status: 'interrupted', reason, endedAt: 2 }
    const shown = rt.delegationState(worker, session)[4]
    assert.equal(shown, stoppedBy === 'user' ? '已中断（用户）' : '已中断（主控）')
  }
})

test('directory labels distinguish execution isolation from a shared worktree workspace', () => {
  const { rt, owner, worker } = harness()
  rt.state.workspaces = { shared: { worktree: { branch: 'manual-worktree' } }, isolated: { worktree: { branch: 'nodo/task-isolated' } } }
  rt.state.tasks.task = { workspaceRef: 'shared', brief: 'Task' }
  const session = { id: 'executor', source: { kind: 'lead', leadSessionId: owner.id } }
  worker.sessions.push(session)
  rt.state.executions.execution = { id: 'execution', taskId: 'task', sessionId: session.id, type: 'feature', hard: false, status: 'queued' }
  assert.equal(rt.delegationState(worker, session).at(-1), '共享')
  rt.state.executions.execution.workspaceRef = 'isolated'
  assert.equal(rt.delegationState(worker, session).at(-1), 'nodo/task-isolated')
  for (const table of [rt.leadSnapshot(owner.id), rt.leadDelegations(owner.id)]) {
    const rows = table.split('\n').filter(line => line.startsWith('|'))
    assert.match(rows[0], /\| 目录 \|/)
    assert.ok(rows.every(row => row.split('|').length === 9))
    assert.match(rows.at(-1), /\| nodo\/task-isolated \|/)
  }
  delete rt.state.workspaces.isolated
  for (const table of [rt.leadSnapshot(owner.id), rt.leadDelegations(owner.id)]) assert.match(table, /\| 已删除 \|/)
})

test('restart recovery interrupts executions left running and logs save failures', async () => {
  const { rt, owner } = harness()
  rt.state.tasks.task = { id: 'task', coordinatorSessionId: owner.id }
  rt.state.executions.execution = { id: 'execution', taskId: 'task', sessionId: 'executor', status: 'running' }
  const warnings = [], calls = []
  Object.assign(rt, { readOnly: () => undefined, warn: (...args) => warnings.push(args),
    interruptExecution: async (...args) => { calls.push(args); throw new Error('Recovery save failed') } })
  await rt.recoverLeadDelegations()
  assert.deepEqual(calls, [['execution', { reason: 'restart' }]])
  assert.ok(warnings.some(args => args.join(' ').includes('Recovery save failed')))
})
