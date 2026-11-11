import { routeUserTask, userRoute } from './helpers/route.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { withHost, until, boot } from './helpers/host.js'
import { loadClient } from './helpers/client-module.js'

const entry = {
  info: { id: 'decision-fixture', label: 'Decision fixture', capabilities: { resume: true, steer: true } }, validate: raw => raw,
  create({ onEvent }) {
    let turn = 0
    const driver = {
      calls: [], steers: [], active: false, interrupted: 0, workerMcpMounted: true,
      hasSession: () => true, dispose() {}, onEvent() {},
      async respondToRequest() { return false },
      async openSession() { if (driver.failOpen) throw new Error('Fixture open failure') },
      async sendTurn(text) {
        driver.calls.push(text)
        if (driver.failSend) throw new Error('Fixture send failure')
        driver.active = true
        driver.start = () => onEvent({ type: 'turn/start', turnId: `turn-${turn}` })
        turn++
        if (!driver.deferStart) driver.start()
        if (driver.failAfterStart) throw new Error('Fixture acceptance failure')
        if (driver.deferAccept) await new Promise(resolve => { driver.accept = resolve })
      },
      async steer(text) { driver.steers.push(text); return 'steered' },
      async interruptTurn() { driver.interrupted++; if (!driver.unconfirmedStop) driver.finish('interrupted') },
      finish(reason = 'done', retryable = false, unconfirmed = false) {
        driver.active = false
        onEvent({ type: 'text', turnId: `turn-${turn}`, messageId: `reply-${turn}`, text: 'Fixture result' })
        onEvent({ type: 'turn/end', turnId: `turn-${turn}`, reason, text: 'Fixture result', retryable, unconfirmed })
      },
    }
    return driver
  },
}
registerEngine('decision-fixture', entry)
registerEngine('claude', entry)
const request = { questions: [{ id: 'direction', question: '选择兼容性方案？', whyUser: '需要用户确认兼容性取舍',
  options: [{ id: 'keep', label: '保持兼容', consequence: '保留旧接口' }, { id: 'break', label: '修改接口', consequence: '调用方需要升级' }],
  recommendation: { optionId: 'keep', reason: '升级成本较低' } }, { id: 'constraints', question: '附加约束？', whyUser: '需要明确范围' }], stopExecutionIds: [] }
const answers = { direction: { optionId: 'break' }, constraints: { text: '只修改内部调用，保留原始标点。' } }
const turn = (reason = 'done') => ({ mode: 'turn', completion: Promise.resolve({ reason }) })
const withDecisions = (run, repository = false) => withHost(async host => {
  const rt = await host.runtime
  const cwd = repository ? join(host.home, 'repo') : host.home
  if (repository) {
    mkdirSync(cwd)
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Nodo Test'); git('config', 'user.email', 'nodo@example.test')
    writeFileSync(join(cwd, 'base.txt'), 'base'); git('add', 'base.txt'); git('commit', '-qm', 'base')
  }
  const workspace = await host.api('workspace-create', { name: 'Decision', cwd })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'decision-fixture' })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }],
    assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const api = (name, body = {}) => host.api(name, { profile: lead.id, session: owner.id, ...body })
  const delegate = (changes = {}) => routeUserTask(rt, owner.id, { type: 'feature', hard: false, task: 'Implement', ...changes })
  const bindings = [], clients = []
  const client = async (id = owner.id) => {
    const binding = await rt.issueLeadMcp(id), spec = binding.servers[0]
    bindings.push(binding)
    const value = new Client({ name: 'decision-test', version: '1' })
    clients.push(value)
    await value.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } }))
    return value
  }
  const createTask = changes => rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Task', brief: 'Brief', source: { kind: 'lead' }, ...changes })
  try { await run({ host, rt, workspace, worker, lead, owner, other, api, delegate, client, createTask }) }
  finally { for (const value of clients) await value.close(); for (const binding of bindings) binding.revoke() }
})

test('MCP open questions omit options and accept a user text answer', () => withDecisions(async ({ rt, owner, api, client }) => {
  const mcp = await client()
  const question = { id: 'scope', question: '需要支持哪些调用方？', whyUser: '当前用户指令没有说明新增支持范围' }
  const empty = await mcp.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...{ questions: [{ ...question, options: [] }], stopExecutionIds: [] }  }})
  assert.equal(empty.isError, true)
  assert.match(empty.content[0].text, /options 不能为空/)
  const result = await mcp.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...{ questions: [question], stopExecutionIds: [] }  }})
  assert.notEqual(result.isError, true)
  const { decisionId } = JSON.parse(result.content[0].text)
  assert.deepEqual(rt.getDecision(owner.id, decisionId).questions, [question])
  await api('decision-answer', { decisionId, answers: { scope: { text: '只支持现有调用方' } } })
  await until(() => rt.driverOf(owner.id)?.active)
  assert.deepEqual(rt.getDecision(owner.id, decisionId).answer.values, { scope: { text: '只支持现有调用方' } })
  rt.driverOf(owner.id).finish()
}))

test('MCP decision file-path references report actionable errors and allow retry without references', () => withDecisions(async ({ rt, owner, client }) => {
  const mcp = await client()
  const result = await mcp.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...{ ...request, references: ['src/ledger.js'] }  }})
  assert.equal(result.isError, true)
  const message = result.content[0].text
  assert.match(message, /references/)
  assert.match(message, /src\/ledger\.js/)
  assert.match(message, /本会话已有的引用 id.*附件.*board/)
  assert.match(message, /不是文件路径.*没有.*省略/)
  assert.deepEqual(rt.state.decisions, {})
  assert.equal(rt.sessionBlockReason(owner.id), undefined)
  const retry = await mcp.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...request  }})
  assert.notEqual(retry.isError, true)
  assert.equal(rt.sessionBlockReason(owner.id).decisionId, JSON.parse(retry.content[0].text).decisionId)
}))

test('a pending decision holds dependent tasks while running work advances; cancelling it starts them', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  const first = await delegate()
  await rt.followLead(owner.id, turn())
  const worker = await until(() => rt.driverOf(first.session)?.active && rt.driverOf(first.session))
  const waiting = await delegate({ task: 'Follow-up', dependsOn: [first.taskId] })
  assert.equal(waiting.status, 'pending')
  const { decisionId } = await rt.createDecision(owner.id, request)
  await rt.workerReport(rt.state.executions[first.executionId], { outcome: 'done', summary: 'Done', changed: [], verified: [{ command: 'check', result: 'pass' }], issues: [],
    reviewFlags: { crossModule: false, publicInterface: false, dataFormat: false, security: false } })
  worker.finish()
  await until(() => rt.state.executions[first.executionId].flowContinued)
  assert.equal(rt.state.tasks[first.taskId].flow.status, 'done')
  assert.equal(rt.state.tasks[waiting.taskId].flow.status, 'pending')
  await api('decision-cancel', { decisionId })
  await until(() => Object.values(rt.state.executions).some(item => item.taskId === waiting.taskId && item.status === 'running'))
  assert.equal(rt.state.tasks[waiting.taskId].flow.status, 'running')
  assert.equal(rt.driverOf(owner.id), undefined, 'neither the finished work nor the release ran a leader turn')
}))

test('a decision established during worker preparation cancels unsent work without a failure report and cleans its worktree', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  const receipt = await delegate({ worktree: true })
  const execution = rt.state.executions[receipt.executionId]
  const workspaceId = execution.workspaceRef, cwd = rt.state.workspaces[workspaceId].cwd
  let opening, release
  const opened = new Promise(resolve => { opening = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const prepare = rt.prepareConversation
  rt.prepareConversation = async id => {
    if (id === receipt.session) { opening(); await blocked }
    return prepare(id)
  }
  await rt.followLead(owner.id, turn())
  await opened
  assert.equal(execution.status, 'running')
  assert.ok(execution.startedAt)
  try { await rt.createDecision(owner.id, request) } finally { release() }
  await until(() => !rt.workView()[receipt.session]?.active
    && !rt.leadDecisionExecutions(owner.id).some(item => item.executionId === execution.id && item.active))
  assert.equal(execution.status, 'cancelled', 'a pre-send decision refusal must cancel instead of failing the execution')
  assert.equal(execution.reason, 'orch/decision-pending')
  assert.equal(execution.startedAt, null)
  assert.equal(rt.state.tasks[receipt.taskId].status, 'blocked')
  assert.equal(rt.state.tasks[receipt.taskId].flow.stalled.reason, 'execution-failed')
  assert.equal(rt.driverOf(receipt.session).calls.length, 0)
  assert.equal(rt.transcriptOf(receipt.session).some(line => line.kind === 'error'), false)
  assert.equal(rt.leadRetryWaiting(receipt.session), false)
  await until(() => !existsSync(cwd))
  await until(() => rt.transcriptOf(owner.id).some(line => line.delegation?.executionId === execution.id && line.delegation.ended === 'cancelled'))
  assert.equal(rt.state.workspaces[workspaceId], undefined)
  assert.equal(rt.conversationOf(owner.id).session.reportQueue, undefined)
  assert.equal(execution.reports, undefined)
  assert.equal(execution.report, null)
  const { decisionId } = rt.sessionBlockReason(owner.id)
  await api('decision-cancel', { decisionId })
  for (let index = 0; index < 5; index++) await delegate()
  await rt.followLead(owner.id, turn('interrupted'))
  await rt.saveStrict()
}, true))

test('a failed answer save does not render a fake user answer in the team round', () => withDecisions(async ({ rt, owner, api }) => {
  const { roundLines } = await loadClient('round.js')
  const { decisionId } = await rt.createDecision(owner.id, request)
  const save = rt.saveStrict
  rt.saveStrict = async () => { throw new Error('Fixture answer save failure') }
  try { await assert.rejects(api('decision-answer', { decisionId, answers }), /Fixture answer save failure/) }
  finally { rt.saveStrict = save }
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  assert.equal(rt.state.decisions[decisionId].answer, undefined)
  assert.equal(roundLines(rt.transcriptOf(owner.id)).some(line => line.who === 'user'), false,
    'a failed answer must not appear as a submitted user message')
}))

test('a saved cancel leaves one system note; failed, repeat or answered cancels leave none', () => withDecisions(async ({ rt, owner, api }) => {
  const notes = () => rt.transcriptOf(owner.id).filter(line => line.origin?.kind === 'decision-cancel')
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('decision-cancel', { decisionId })
  const written = notes()
  assert.equal(written.length, 1)
  assert.equal(written[0].who, 'system')
  assert.equal(written[0].origin.decisionId, decisionId)
  assert.match(written[0].text, /已撤销决策「选择兼容性方案？」：未批准推荐方案，也不会恢复旧派活。/)
  assert.equal((await api('decision-cancel', { decisionId })).status, 'cancelled')
  assert.equal(notes().length, 1, 'a repeat cancel writes no second note')
  const answered = await rt.createDecision(owner.id, request)
  await api('decision-answer', { decisionId: answered.decisionId, answers })
  assert.equal((await api('decision-cancel', { decisionId: answered.decisionId })).status, 'answered')
  assert.equal(notes().length, 1, 'cancelling an answered decision writes no note')
  await until(() => rt.driverOf(owner.id)?.active)
  rt.driverOf(owner.id).finish()
  await until(() => rt.state.decisions[answered.decisionId].status === 'delivered')
  const save = rt.saveStrict
  const failed = await rt.createDecision(owner.id, request)
  rt.saveStrict = async () => { throw new Error('Fixture cancel save failure') }
  try { await assert.rejects(rt.cancelDecision(owner.id, { decisionId: failed.decisionId }), /Fixture cancel save failure/) }
  finally { rt.saveStrict = save }
  assert.equal(rt.state.decisions[failed.decisionId].status, 'pending')
  assert.equal(notes().length, 1, 'a failed cancel save writes no note')
}))

test('decision ask links source executions atomically; board and snapshots stay within the calling session', () => withDecisions(async ({ rt, owner, other, api, delegate, client }) => {
  const primary = { callTool: async args => (await client()).callTool(args) }, foreign = await client(other.id)
  const first = await delegate()
  await rt.followLead(owner.id, turn())
  const executor = await until(() => rt.driverOf(first.session)?.active && rt.driverOf(first.session))
  executor.finish()
  await until(() => rt.state.tasks[first.taskId].flow.status === 'stalled')
  const save = rt.saveStrict
  rt.saveStrict = async () => { throw new Error('Decision save failed') }
  await assert.rejects(rt.createDecision(owner.id, { ...request, executionIds: [first.executionId] }), /Decision save failed/)
  assert.deepEqual(rt.state.decisions, {})
  rt.saveStrict = save
  const result = await primary.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...{ ...request, executionIds: [first.executionId], taskIds: [first.taskId] }  }})
  assert.equal(result.isError, undefined, result.content[0].text)
  const { decisionId } = JSON.parse(result.content[0].text)
  const detail = await primary.callTool({ name: 'nodo_board', arguments: { decisionId } })
  assert.deepEqual(JSON.parse(detail.content[0].text).sourceExecutionIds, [first.executionId])
  assert.equal(JSON.parse((await primary.callTool({ name: 'nodo_board', arguments: { table: 'decisions' } })).content[0].text)[0].id, decisionId)
  assert.deepEqual(JSON.parse((await foreign.callTool({ name: 'nodo_board', arguments: { table: 'decisions' } })).content[0].text), [])
  for (const args of [{ decisionId }, { table: 'tasks', decisionId }, { table: 'decisions', session: owner.id }]) {
    assert.equal((await foreign.callTool({ name: 'nodo_board', arguments: args })).isError, true)
  }
  const snapshot = rt.leadSnapshot(owner.id)
  assert.match(snapshot, /等待原因/)
  assert.ok(snapshot.includes(decisionId) && snapshot.includes(first.taskId))
  assert.ok(!rt.leadSnapshot(other.id).includes(decisionId))
  for (const name of ['decision-answer', 'decision-cancel']) assert.equal((await primary.callTool({ name, arguments: { decisionId, answers } })).isError, true)
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  await api('decision-cancel', { decisionId })
  await delegate({ task: 'Replan within original authorization' })
}))

test('snapshot and state views cap finished decisions but always keep unfinished ones', () => withDecisions(async ({ rt, owner, other }) => {
  const cancelOne = async session => { const { decisionId } = await rt.createDecision(session, request); await rt.cancelDecision(session, { decisionId }) }
  for (let index = 0; index < 12; index++) await cancelOne(owner.id)
  for (let index = 0; index < 2; index++) await cancelOne(other.id)
  const finished = Object.values(rt.state.decisions).filter(item => item.status === 'cancelled' && item.coordinatorSessionId === owner.id).map(item => item.id)
  const { decisionId } = await rt.createDecision(owner.id, request)
  await rt.answerDecision(owner.id, { decisionId, answers })
  const view = rt.decisionsView().map(item => item.id)
  assert.ok(view.includes(decisionId), 'an answered decision stays in the state view')
  assert.deepEqual(view.filter(id => finished.includes(id)), finished.slice(-10), 'each session keeps only its ten most recent finished decisions')
  assert.equal(view.length, 13)
  const snapshot = rt.leadSnapshot(owner.id)
  assert.ok(snapshot.includes(decisionId))
  assert.ok(finished.slice(-3).every(id => snapshot.includes(id)), 'the snapshot keeps the three most recent finished decisions')
  assert.ok(finished.slice(0, -3).every(id => !snapshot.includes(id)), 'older finished decisions drop out of the snapshot')
}))

test('pending is durable before queued cancellation; old worktree is removed and dispatch consumes no slots or budget', () => withDecisions(async ({ host, rt, owner, worker, delegate, client, api }) => {
  const queued = await delegate({ worktree: true })
  const cwd = rt.state.workspaces[rt.state.executions[queued.executionId].workspaceRef].cwd
  assert.equal(existsSync(cwd), true)
  const primary = await client()
  const cancel = rt.cancelExecution
  let observed = false
  rt.cancelExecution = async (...args) => {
    const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
    observed = Object.values(saved.decisions)[0].status === 'pending'
    return cancel(...args)
  }
  const result = await primary.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...request  }})
  assert.equal(result.isError, undefined, result.content[0].text)
  const decision = JSON.parse(result.content[0].text)
  assert.equal(observed, true)
  assert.deepEqual(decision.cancelledQueuedExecutionIds, [queued.executionId])
  assert.equal(rt.state.executions[queued.executionId].status, 'cancelled')
  assert.equal(existsSync(cwd), false)
  await rt.followLead(owner.id, turn())
  assert.equal(rt.driverOf(queued.session), undefined)
  const count = rt.state.profiles[worker.id].sessions.length
  for (let index = 0; index < 26; index++) await assert.rejects(delegate({ worktree: true }), { code: 'orch/decision-pending', decisionId: decision.decisionId })
  assert.equal(rt.state.profiles[worker.id].sessions.length, count)
  assert.equal(Object.keys(rt.state.executions).length, 1)
  const blocked = await primary.callTool({ name: 'nodo_route', arguments: userRoute(rt, owner.id, { type: 'feature', hard: false, task: 'Forbidden' } )})
  assert.equal(JSON.parse(blocked.content[0].text).code, 'orch/decision-pending')
  await api('decision-cancel', { decisionId: decision.decisionId })
  for (let index = 0; index < 5; index++) await delegate()
  await rt.followLead(owner.id, turn('interrupted'))
}, true))

test('leader boundary validates schema, ownership, references and forbids answering; identical requests reuse one record', () => withDecisions(async ({ rt, owner, other, client, createTask, api }) => {
  const primary = await client(), foreign = await createTask({ coordinatorSessionId: other.id })
  for (const args of [
    { questions: request.questions }, { ...request, action: 'answer' }, { ...request, questions: [] },
    { ...request, questions: [request.questions[0], request.questions[0]] },
    { ...request, questions: [{ ...request.questions[0], recommendation: { optionId: 'missing', reason: 'Why' } }] },
    { ...request, taskIds: [foreign.id] }, { ...request, executionIds: ['missing'] },
    { ...request, stopExecutionIds: ['missing'] }, { ...request, references: ['missing'] },
  ]) assert.equal((await primary.callTool({ name: 'nodo_route', arguments: { action: 'ask', ...args  }})).isError, true)
  assert.deepEqual(rt.state.decisions, {})
  const first = await rt.createDecision(owner.id, request)
  assert.equal((await rt.createDecision(owner.id, request)).decisionId, first.decisionId)
  const changed = await rt.createDecision(owner.id, { ...request, questions: [request.questions[1]] })
  assert.equal(changed.decisionId, first.decisionId)
  assert.match(changed.message, /不能覆盖/)
  assert.equal(Object.keys(rt.state.decisions).length, 1)
  for (const name of ['decision-answer', 'decision-cancel', `nodo_${'decision_answer'}`]) assert.equal((await primary.callTool({ name, arguments: { decisionId: first.decisionId, answers } })).isError, true)
  await assert.rejects(api('decision-get', { session: other.id, decisionId: first.decisionId }), /不属于本会话/)
  await assert.rejects(api('decision-answer', { session: other.id, decisionId: first.decisionId, answers }), /不属于本会话/)
  await assert.rejects(api('decision-cancel', { session: other.id, decisionId: first.decisionId }), /不属于本会话/)
  assert.deepEqual(await api('decision-list', { session: other.id }), [])
  assert.equal((await api('decision-list'))[0].id, first.decisionId)
  assert.equal((await api('state')).decisions[0].status, 'pending')
}))

test('parallel identical submissions with task ownership checks retain one decision', () => withDecisions(async ({ rt, owner, createTask }) => {
  const task = await createTask()
  const args = { ...request, taskIds: [task.id] }
  const results = await Promise.all([rt.createDecision(owner.id, args), rt.createDecision(owner.id, args)])
  assert.equal(results[0].decisionId, results[1].decisionId)
  assert.equal(Object.keys(rt.state.decisions).length, 1)
}))

test('incomplete, invalid, duplicate and expired answers preserve state; ordinary discussion never approves', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  const { decisionId } = await rt.createDecision(owner.id, request)
  for (const values of [{}, { direction: { optionId: 'keep' } }, { ...answers, extra: { text: 'Unknown' } },
    { ...answers, direction: { optionId: 'missing' } }, { ...answers, constraints: { text: ' ' } }]) {
    const result = await api('decision-answer', { decisionId, answers: values })
    assert.equal(result.status, 'pending'); assert.ok(result.message)
  }
  await api('send', { text: '好的，继续讨论' })
  await until(() => rt.driverOf(owner.id)?.active)
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  await api('decision-answer', { decisionId, answers })
  assert.equal(rt.state.decisions[decisionId].status, 'answered')
  const duplicate = await api('decision-answer', { decisionId, answers: { ...answers, direction: { optionId: 'keep' } } })
  assert.equal(duplicate.status, 'answered')
  assert.deepEqual(duplicate.decision.answer.values, answers)
  assert.equal((await api('decision-cancel', { decisionId })).status, 'answered')
  await api('interrupt')
  await until(() => !rt.workView()[owner.id]?.active)
  const { decisionId: expired } = await rt.createDecision(rt.conversationOf(owner.id).session.id, request)
  assert.equal(expired, decisionId, 'an answered decision cannot be replaced')
}))

test('answers queue behind the old turn without steering, then enter a new confirmed turn before dispatch', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  await api('send', { text: 'Plan' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  const queued = await delegate()
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('decision-answer', { decisionId, answers })
  await until(() => rt.workView()[owner.id]?.queued === 1)
  assert.equal(rt.state.decisions[decisionId].status, 'answered')
  assert.equal(leader.steers.length, 0)
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  leader.deferAccept = true
  leader.finish()
  await until(() => leader.calls.length === 2 && leader.accept)
  assert.equal(rt.state.decisions[decisionId].status, 'answered', 'turn/start without accepted send is insufficient')
  const dispatched = delegate()
  leader.accept()
  const fresh = await dispatched
  assert.equal(rt.state.decisions[decisionId].status, 'delivered')
  assert.match(leader.calls[1], /"optionId":"break"/)
  assert.match(leader.calls[1], /只修改内部调用，保留原始标点。/)
  assert.match(leader.calls[1], new RegExp(queued.executionId))
  const decision = rt.getDecision(owner.id, decisionId)
  assert.equal(decision.delivery.turnId, 'turn-2')
  assert.ok(rt.transcriptOf(owner.id).some(line => line.id === decision.answer.userMessageId))
  assert.equal(rt.state.executions[queued.executionId].status, 'cancelled')
  leader.deferAccept = false
  leader.finish()
  await until(() => rt.driverOf(fresh.session)?.active)
  rt.driverOf(fresh.session).finish()
  await until(() => rt.transcriptOf(owner.id).some(line => line.delegation?.executionId === fresh.executionId && line.delegation.ended === 'done'))
  assert.equal(rt.workView()[owner.id]?.active ?? false, false, 'the finished execution starts no leader turn')
}))

test('sending a queued message after the leader goes idle writes at and id back, so trigger handles stay resolvable', () => withDecisions(async ({ rt, owner, lead, api }) => {
  await api('send', { text: 'Plan' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  const placed = await rt.send(lead.id, 'Queued original', owner.id, [], [], { queue: true, userInput: true, origin: { kind: 'user' } })
  assert.equal(placed.mode, 'queued')
  const compacting = rt.isCompacting
  let liveNotifications = 0
  const notifyLive = rt.notifyLive
  rt.notifyLive = (...args) => { liveNotifications++; return notifyLive?.(...args) }
  rt.isCompacting = () => true
  leader.finish()
  // The end handler runs its final stretch (drain included) after an async
  // save; notifyLive fires right after that drain, so an extra notification
  // proves the patched-off drain already ran and kept the item queued.
  const baseline = liveNotifications
  await until(() => liveNotifications > baseline)
  rt.isCompacting = compacting
  rt.notifyLive = notifyLive
  assert.equal(rt.workView()[owner.id]?.queued, 1, 'drain skipped while compacting, so the item stays queued while idle')
  await rt.queuedMessage(lead.id, owner.id, placed.seq, 'send')
  await until(() => rt.driverOf(owner.id)?.active)
  const pending = rt.pendingTriggerOf(owner.id)
  assert.match(pending.handle, new RegExp(`^message:${owner.id}:\\d+:[0-9a-f]{8}$`))
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
}))

for (const mode of ['open', 'send', 'after-start', 'before-start']) test(`answer handoff requires accepted send and actual turn start (${mode})`, () => withDecisions(async ({ rt, owner, api, delegate }) => {
  await api('send', { text: 'Initial plan' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
  if (mode === 'open') leader.failOpen = true
  if (mode === 'send') leader.failSend = true
  if (mode === 'after-start') leader.failAfterStart = true
  if (mode === 'before-start') leader.deferStart = true
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('decision-answer', { decisionId, answers })
  await until(() => mode === 'before-start' ? leader.calls.length === 2 : !rt.workView()[owner.id]?.active)
  assert.equal(rt.state.decisions[decisionId].status, 'answered')
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  if (mode === 'before-start') {
    leader.start()
    await until(() => rt.state.decisions[decisionId].status === 'delivered')
    leader.finish()
  }
}))

test('waiting stops retry timers, preserves other running results and interrupts only named executions', t => withDecisions(async ({ rt, owner, delegate, api }) => {
  const retry = await delegate(), stopped = await delegate(), running = await delegate()
  await rt.followLead(owner.id, turn())
  await until(() => [retry, stopped, running].every(item => rt.driverOf(item.session)?.active))
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => schedule(fn, ms === 30_000 ? 200 : ms, ...args))
  rt.driverOf(retry.session).finish('error', true)
  await until(() => rt.leadRetryWaiting(retry.session))
  const stopDriver = rt.driverOf(stopped.session), otherDriver = rt.driverOf(running.session)
  const { decisionId } = await rt.createDecision(owner.id, { ...request, stopExecutionIds: [stopped.executionId] })
  await until(() => rt.state.executions[stopped.executionId].status === 'interrupted')
  await until(() => rt.state.executions[retry.executionId].status === 'failed')
  assert.equal(rt.leadRetryWaiting(retry.session), false)
  assert.equal(stopDriver.interrupted, 1)
  assert.equal(otherDriver.interrupted, 0)
  otherDriver.finish()
  await until(() => rt.state.executions[running.executionId].status === 'done')
  assert.equal(rt.driverOf(owner.id), undefined)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(rt.driverOf(retry.session).calls.length, 1)
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  await api('decision-answer', { decisionId, answers })
  await until(() => rt.state.decisions[decisionId].status === 'delivered')
  const leader = rt.driverOf(owner.id)
  assert.match(leader.calls[0], /用户已回答决策/)
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
  assert.equal(leader.calls.length, 1, 'ended executions send the leader no reports')
}))

test('stop request stays stopping until confirmation', () => withDecisions(async ({ rt, host, owner, delegate }) => {
  const receipt = await delegate()
  await rt.followLead(owner.id, turn())
  const driver = await until(() => rt.driverOf(receipt.session)?.active && rt.driverOf(receipt.session))
  driver.unconfirmedStop = true
  const result = await rt.createDecision(owner.id, { ...request, stopExecutionIds: [receipt.executionId] })
  assert.equal(result.runningExecutions[0].status, 'running')
  assert.equal(result.runningExecutions[0].stopping, true)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).decisions[result.decisionId].status, 'pending')
  await until(() => driver.interrupted === 1)
  driver.finish('interrupted')
  await until(() => rt.state.executions[receipt.executionId].status === 'interrupted')
  assert.equal(rt.getDecision(owner.id, result.decisionId).runningExecutions.length, 0)
}))

test('task decisions block related tasks and original or current ancestors after relation edits; session decisions block all acceptance', () => withDecisions(async ({ rt, owner, createTask }) => {
  const parent = await createTask(), newParent = await createTask(), child = await createTask({ parentId: parent.id }), unrelated = await createTask()
  const { decisionId } = await rt.createDecision(owner.id, { ...request, taskIds: [child.id] })
  await rt.reviseTask(child.id, { parentId: newParent.id, brief: 'Updated' })
  for (const task of [parent, newParent, child]) await assert.rejects(rt.completeTask(task.id, { reason: 'Checked', references: [] }), { code: 'orch/decision-pending' })
  await assert.rejects(rt.completeTask(unrelated.id, { reason: 'Checked', references: [] }), /Acceptance evidence/)
  await rt.cancelDecision(owner.id, { decisionId })
  const sessionDecision = await rt.createDecision(owner.id, request)
  await assert.rejects(rt.completeTask(unrelated.id, { reason: 'Checked', references: [] }), { code: 'orch/decision-pending' })
  await rt.cancelDecision(owner.id, { decisionId: sessionDecision.decisionId })
}))

test('interrupt failure records unconfirmed execution and keeps pending blocking visible', () => withDecisions(async ({ rt, owner, delegate }) => {
  const receipt = await delegate()
  await rt.followLead(owner.id, turn())
  await until(() => rt.driverOf(receipt.session)?.active)
  rt.interrupt = async () => { throw new Error('Fixture interrupt failure') }
  const { decisionId } = await rt.createDecision(owner.id, { ...request, stopExecutionIds: [receipt.executionId] })
  await until(() => rt.state.executions[receipt.executionId].status === 'unconfirmed')
  assert.equal(rt.getDecision(owner.id, decisionId).runningExecutions[0].status, 'unconfirmed')
  assert.equal(rt.getDecision(owner.id, decisionId).dispatchBlocked, true)
  rt.driverOf(receipt.session).finish('interrupted')
}))

test('deleting a queued answer does not deliver it; a later explicit resume retries in a new round', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  await api('send', { text: 'Plan' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('decision-answer', { decisionId, answers })
  const queued = await until(() => rt.workView()[owner.id]?.pending?.[0])
  assert.equal((await api('queued-message', { seq: queued.seq, action: 'send' })).mode, 'queued')
  assert.equal(leader.steers.length, 0)
  await api('queued-message', { seq: queued.seq, action: 'delete' })
  assert.equal(rt.state.decisions[decisionId].status, 'answered')
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
  await api('send', { text: '重新交接已保存答案' })
  await until(() => leader.calls.length === 2)
  leader.finish()
  await until(() => rt.state.decisions[decisionId].status === 'delivered')
  assert.match(leader.calls.at(-1), /用户已回答决策/)
  leader.finish()
}))

test('failed delivery persistence keeps dispatch blocked and permits a later handoff', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  const { decisionId } = await rt.createDecision(owner.id, request)
  const save = rt.saveStrict
  rt.saveStrict = async () => {
    if (rt.state.decisions[decisionId].status === 'delivered') throw new Error('Fixture delivery save failure')
    return save()
  }
  await api('decision-answer', { decisionId, answers })
  await until(() => rt.transcriptOf(owner.id).some(line => line.kind === 'decision-delivery-failed'))
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  assert.deepEqual(rt.state.decisions[decisionId].answer.values, answers)
  const leader = rt.driverOf(owner.id)
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
  rt.saveStrict = save
  await rt.deliverDecision(owner.id)
  await until(() => rt.state.decisions[decisionId].status === 'delivered')
  leader.finish()
}))

test('stopping an unconfirmed answer send keeps the answer and never unlocks on late acceptance', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  await api('send', { text: 'Initial plan' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  leader.finish()
  await until(() => !rt.workView()[owner.id]?.active)
  leader.deferAccept = true
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('decision-answer', { decisionId, answers })
  await until(() => leader.accept)
  await api('interrupt')
  await until(() => !rt.workView()[owner.id]?.active)
  leader.accept()
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  assert.equal(rt.state.decisions[decisionId].status, 'answered')
  assert.equal(rt.state.decisions[decisionId].handoffStopped, true)
  assert.equal(rt.transcriptOf(owner.id).some(line => line.kind === 'decision-delivery'), false)
}))

test('explicit discussion resumes a stopped leader without approving pending questions and permits later answer delivery', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  await api('send', { text: 'Plan' })
  await until(() => rt.driverOf(owner.id)?.active)
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('interrupt')
  await until(() => !rt.workView()[owner.id]?.active)
  await api('send', { text: '先讨论约束' })
  const leader = await until(() => rt.driverOf(owner.id)?.active && rt.driverOf(owner.id))
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  await assert.rejects(delegate(), { code: 'orch/decision-pending' })
  await api('decision-answer', { decisionId, answers })
  await until(() => rt.workView()[owner.id]?.queued === 1)
  leader.finish()
  await until(() => rt.state.decisions[decisionId].status === 'delivered')
  leader.finish()
}))

test('pending and answered refuse archive; explicit cancel keeps history and expired cards cannot answer', () => withDecisions(async ({ rt, owner, api }) => {
  const { decisionId } = await rt.createDecision(owner.id, request)
  await assert.rejects(api('session-archive', { archived: true }), { code: 'orch/decision-pending' })
  const cancelled = await api('decision-cancel', { decisionId })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await api('decision-answer', { decisionId, answers })).status, 'cancelled')
  assert.equal((await api('decision-cancel', { decisionId })).status, 'cancelled')
  await api('session-archive', { archived: true })
  assert.equal((await api('decision-get', { decisionId })).status, 'cancelled')
  assert.equal(rt.getDecision(owner.id, decisionId).answer, undefined)
}))

test('save failure rolls back unsaved requests and answers; cancellation failure preserves blocking and releases the slot', () => withDecisions(async ({ rt, owner, api, delegate }) => {
  const queued = await delegate()
  const save = rt.saveStrict
  rt.saveStrict = async () => { throw new Error('Fixture save failure') }
  await assert.rejects(rt.createDecision(owner.id, request), /Fixture save failure/)
  assert.deepEqual(rt.state.decisions, {})
  assert.equal(rt.state.executions[queued.executionId].status, 'queued')
  rt.saveStrict = save
  const cancel = rt.cancelExecution
  rt.cancelExecution = async () => { throw new Error('Fixture cancel failure') }
  const { decisionId } = await rt.createDecision(owner.id, request)
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  assert.equal(rt.leadDecisionExecutions(owner.id)[0].active, false)
  assert.equal(rt.getDecision(owner.id, decisionId).runningExecutions[0].status, 'queued')
  assert.equal(rt.getDecision(owner.id, decisionId).cancellationErrors.length, 1)
  assert.deepEqual(rt.getDecision(owner.id, decisionId).cancelledQueuedExecutionIds, [])
  rt.cancelExecution = cancel
  rt.saveStrict = async () => { throw new Error('Fixture save failure') }
  await assert.rejects(api('decision-answer', { decisionId, answers }), /Fixture save failure/)
  assert.equal(rt.state.decisions[decisionId].status, 'pending')
  assert.equal(rt.state.decisions[decisionId].answer, undefined)
  rt.saveStrict = save
  await api('decision-cancel', { decisionId })
  for (let index = 0; index < 5; index++) await delegate()
  await rt.followLead(owner.id, turn('interrupted'))
}))

for (const status of ['pending', 'answered', 'delivered']) test(`restart restores ${status}, preserves answers and never repeats delivered work`, () => withDecisions(async ({ rt, host, owner, lead, api }) => {
  const { decisionId } = await rt.createDecision(owner.id, request)
  if (status === 'answered') await api('interrupt')
  if (status !== 'pending') await api('decision-answer', { decisionId, answers })
  if (status === 'delivered') {
    await until(() => rt.state.decisions[decisionId].status === 'delivered')
    rt.driverOf(owner.id).finish()
    await until(() => !rt.workView()[owner.id]?.active)
  }
  await rt.saveStrict()
  const directory = join(host.home, 'restart')
  mkdirSync(directory)
  for (const path of ['state.json', 'activity.json', 'transcripts']) if (existsSync(join(host.home, path))) cpSync(join(host.home, path), join(directory, path), { recursive: true })
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    assert.equal(recovered.state.decisions[decisionId].status, status)
    assert.equal(recovered.driverOf(owner.id), undefined)
    if (status !== 'pending') assert.deepEqual(recovered.state.decisions[decisionId].answer.values, answers)
    if (status === 'answered') {
      await assert.rejects(restarted.api('session-archive', { profile: lead.id, session: owner.id, archived: true }), { code: 'orch/decision-pending' })
      await restarted.api('send', { profile: lead.id, session: owner.id, text: '恢复并按已提交答案继续' })
      await until(() => recovered.driverOf(owner.id)?.active)
      recovered.driverOf(owner.id).finish()
      await until(() => recovered.state.decisions[decisionId].status === 'delivered')
      recovered.driverOf(owner.id).finish()
    }
  } finally { await restarted.dispose() }
}))

for (const mode of ['retry', 'evidence', 'archived', 'read-only']) test(`answered recovery follows persisted turn evidence and host availability (${mode})`, () => withDecisions(async ({ rt, host, owner, lead, api }) => {
  const { decisionId } = await rt.createDecision(owner.id, request)
  await api('interrupt')
  await api('decision-answer', { decisionId, answers })
  delete rt.state.decisions[decisionId].handoffStopped
  if (mode === 'evidence') {
    await rt.deliverDecision(owner.id)
    await until(() => rt.state.decisions[decisionId].status === 'delivered')
    rt.driverOf(owner.id).finish()
    await until(() => !rt.workView()[owner.id]?.active)
    rt.state.decisions[decisionId].status = 'answered'
    delete rt.state.decisions[decisionId].delivery
  }
  if (mode === 'archived') rt.conversationOf(owner.id).session.archivedAt = Date.now()
  await rt.saveStrict()
  const directory = join(host.home, 'recovery')
  mkdirSync(directory)
  for (const path of ['state.json', 'activity.json', 'transcripts']) if (existsSync(join(host.home, path))) cpSync(join(host.home, path), join(directory, path), { recursive: true })
  if (mode === 'read-only') writeFileSync(join(directory, 'state.lock'), JSON.stringify({ host: 'other-fixture-host', token: 'fixture' }))
  const restarted = boot(directory)
  try {
    const recovered = await restarted.runtime
    if (mode === 'retry' || mode === 'evidence') {
      await until(() => recovered.state.decisions[decisionId].status === 'delivered')
      if (mode === 'retry') {
        const driver = recovered.driverOf(owner.id)
        assert.equal(driver.calls.length, 1)
        assert.match(driver.calls[0], /只修改内部调用/)
        driver.finish()
      } else assert.equal(recovered.driverOf(owner.id), undefined)
      assert.equal(recovered.transcriptOf(owner.id).filter(line => line.kind === 'decision-delivery').length, 1)
    } else {
      assert.equal(recovered.state.decisions[decisionId].status, 'answered')
      assert.equal(recovered.driverOf(owner.id), undefined)
      const view = await restarted.api('decision-get', { profile: lead.id, session: owner.id, decisionId })
      assert.deepEqual(view.answer.values, answers)
      assert.equal(view.dispatchBlocked, true)
      if (mode === 'read-only') await assert.rejects(restarted.api('decision-cancel', { profile: lead.id, session: owner.id, decisionId }), { code: 'orch/read-only' })
    }
  } finally { await restarted.dispose() }
}))
