import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { boot, until, withHost } from './helpers/host.js'
import { echoEntry, registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { INPUT_CONTEXT_MAX, TASK_TEXT_MAX } from '../core/src/constants.js'
import { reviewDeliveredReports } from './helpers/report-review.js'

registerClaudeFixtureEngine()
const FINAL = 'Dependency final report with evidence'
const USER_REQUEST = 'Use PostgreSQL 16 and keep the CLI output in English'
const command = { type: 'feature', hard: false, task: 'Implement and verify\nPreserve existing changes.' }
const turn = reason => ({ mode: 'turn', completion: Promise.resolve({ reason }) })
registerEngine('capture-fixture', { ...echoEntry, info: { ...echoEntry.info, id: 'capture-fixture', name: 'Capture fixture' }, create(options) {
  const sink = options.onEvent
  const driver = echoEntry.create({ ...options, onEvent: event => {
    if (event.type === 'tool' && event.callId === undefined) event = { ...event, callId: 'fixture-call' }
    if (event.type === 'tool' && event.phase === 'end') event = { ...event,
      presentation: { version: 1, kind: 'tool', mode: 'snapshot', body: { outputText: String(event.brief ?? `${event.name ?? 'tool'} done`) }, capture: 'complete' } }
    if (event.type === 'turn/end') event = { ...event, text: FINAL }
    sink(event)
  } })
  const send = driver.sendTurn
  return Object.assign(driver, { calls: [], sendTurn(text) { driver.calls.push(text); return send(text) } })
} })
registerEngine('large-fixture', { ...echoEntry, info: { ...echoEntry.info, id: 'large-fixture', name: 'Large fixture' },
  create: options => echoEntry.create({ ...options, script: [{ kind: 'text', text: 'x'.repeat(INPUT_CONTEXT_MAX) }],
    onEvent: event => options.onEvent({ ...event, ...(event.type === 'turn/end' ? { text: 'x'.repeat(INPUT_CONTEXT_MAX) } : {}) }) }) })

const withHandoff = (run, workerEngine = 'capture-fixture') => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Handoff', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine: workerEngine,
    engineOptions: { script: [{ kind: 'tool', name: 'bash', brief: 'echo hello', ms: 20 }, { kind: 'text', text: FINAL }] } })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }],
    assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const clients = [], bindings = []
  const client = async (session = owner.id) => {
    const binding = await rt.issueLeadMcp(session), spec = binding.servers[0]
    bindings.push(binding)
    const value = new Client({ name: 'handoff-test', version: '1' })
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
    await until(() => rt.state.executions[receipt.executionId].result && rt.transcriptOf(owner.id).some(line => line.origin?.executionId === receipt.executionId))
    await until(() => !rt.workView()[owner.id]?.active)
    await reviewDeliveredReports(rt, owner.id)
  }
  try { await run({ host, rt, workspace, worker, lead, owner, other, client, call, finish }) }
  finally { for (const value of clients) await value.close(); for (const binding of bindings) binding.revoke() }
})
const userRequest = async (host, rt, owner) => {
  await host.api('send', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id, text: USER_REQUEST })
  await until(() => !rt.workView()[owner.id]?.active)
}
const messageSourceId = async (rt, owner, fragment) => {
  const directory = await rt.executionContext(owner.id, { action: 'list' })
  const item = directory.items.find(entry => entry.source === 'message' && entry.sessionId === owner.id && entry.description.includes(fragment))
  assert.ok(item, 'the directory lists the user message handle')
  return item.sourceId
}
const answerDecision = async (host, rt, owner, call, primary, taskId) => {
  const decision = await call(primary, 'nodo_decision', { taskIds: [taskId], stopExecutionIds: [],
    questions: [{ id: 'logs', question: '日志保留多久？', whyUser: '影响背景材料范围' }] })
  await host.api('decision-answer', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id,
    decisionId: decision.decisionId, answers: { logs: { text: '保留 30 天，脱敏后归档' } } })
  await until(() => rt.state.decisions[decision.decisionId].status === 'delivered' && !rt.workView()[owner.id]?.active)
  return decision.decisionId
}

test('explicit context inlines required material, archives background files and keeps the input fixed after source cleanup', () => withHandoff(async ({ host, rt, workspace, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const dependency = await call(primary, 'nodo_delegate', { ...command, task: 'Investigate storage' })
  await finish(dependency)
  await rt.completeTask(dependency.taskId, { reason: 'Checked', executionIds: [dependency.executionId], basis: ['Verified dependency result'] })
  const decisionId = await answerDecision(host, rt, owner, call, primary, dependency.taskId)
  const resultSourceId = `execution:${dependency.executionId}:result`
  const requiredText = rt.state.executions[dependency.executionId].result.text
  let body
  const send = rt.send
  rt.send = async (...args) => {
    if (args[5]?.origin?.kind === 'delegation') {
      body = args[1]
      const stored = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[args[5].origin.executionId]
      assert.ok(stored.inputContext, 'inputContext is persisted before the engine receives the dispatch')
    }
    return send(...args)
  }
  const receipt = await call(primary, 'nodo_delegate', { ...command, context: { required: [resultSourceId], background: [`decision:${decisionId}`] } })
  await finish(receipt)
  const execution = rt.state.executions[receipt.executionId]
  const inputContext = execution.inputContext
  assert.ok(body.startsWith('Task from lead Lead.'), 'running notes open the dispatch body')
  assert.ok(body.includes(requiredText) && body.includes(`（${resultSourceId}）`), 'the required source rides inline with its handle')
  assert.ok(body.indexOf('Implement and verify') < body.indexOf(requiredText), 'required content follows the current task')
  assert.ok(body.includes('## 必需上下文') && body.includes('## 背景材料'))
  assert.match(body, /Background material for this task is archived as files under \.nodo\/workflow-inputs\//)
  assert.deepEqual(inputContext.required, [{ sourceId: resultSourceId, kind: 'execution', role: 'required',
    description: 'Investigate storage', completeness: 'complete', length: requiredText.length }])
  const background = inputContext.background[0]
  assert.equal(background.sourceId, `decision:${decisionId}`)
  assert.equal(background.completeness, 'complete')
  assert.ok(background.path.startsWith(realpathSync(workspace.cwd)) && background.path.includes('.nodo/workflow-inputs'))
  assert.equal(readFileSync(background.path, 'utf8').includes('保留 30 天，脱敏后归档'), true, 'the executor can read the archived background file')
  assert.equal(inputContext.length, body.length)
  assert.equal(rt.driverOf(receipt.session).calls[0], body, 'the engine receives exactly the composed input')
  assert.equal(rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.kind === 'delegation').text, body)

  const sourceId = await messageSourceId(rt, owner, USER_REQUEST)
  const cleanup = await call(primary, 'nodo_delegate', { ...command, task: 'Reuse the user constraint', context: { required: [sourceId], background: [] } })
  await finish(cleanup)
  const preserved = structuredClone(rt.state.executions[cleanup.executionId].inputContext)
  assert.equal(rt.transcriptOf(cleanup.session).find(line => line.who === 'user' && line.origin?.kind === 'delegation').text.includes(USER_REQUEST), true)
  await rt.saveStrict()
  const copy = join(host.home, 'cleanup-copy')
  mkdirSync(copy)
  copyFileSync(join(host.home, 'state.json'), join(copy, 'state.json'))
  cpSync(join(host.home, 'transcripts'), join(copy, 'transcripts'), { recursive: true })
  rmSync(join(copy, 'transcripts', `${encodeURIComponent(owner.id)}.jsonl`), { force: true })
  rmSync(join(copy, 'transcripts', `${encodeURIComponent(owner.id)}.open`), { force: true })
  const restarted = boot(copy)
  try {
    const recovered = await restarted.runtime
    await recovered.load()
    assert.deepEqual(recovered.state.executions[cleanup.executionId].inputContext, preserved, 'cleaning the source transcript does not alter the recorded input')
    assert.ok(recovered.transcriptOf(cleanup.session).find(line => line.who === 'user' && line.origin?.kind === 'delegation').text.includes(USER_REQUEST))
    const read = await recovered.executionContext(owner.id, { action: 'read', sourceId })
    assert.equal(read.completeness, 'unavailable')
    assert.equal(read.reason, 'cleaned')
    assert.equal(read.text, '')
  } finally { await restarted.dispose() }
}))

test('delegation bodies between the plain send limit and the input budget reach the executor whole', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const dependency = await call(primary, 'nodo_delegate', { ...command, task: 'Investigate storage' })
  await finish(dependency)
  rt.state.executions.wide = { id: 'wide', taskId: dependency.taskId, status: 'done', reason: 'done', references: [],
    result: { text: 'y'.repeat(40_000), completeness: 'complete', reason: null, preview: 'Wide result', length: 40_000, originalLength: 40_000 } }
  const receipt = await call(primary, 'nodo_delegate', { ...command, task: 'Carry the wide result', context: { required: ['execution:wide:result'], background: [] } })
  await finish(receipt)
  const body = rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.executionId === receipt.executionId).text
  assert.ok(body.length > TASK_TEXT_MAX, 'the composed delegation passes the plain 32k send limit')
  assert.ok(body.includes('y'.repeat(40_000)), 'the executor receives the required excerpt whole')
  assert.equal(rt.driverOf(receipt.session).calls[0], body)
  await host.api('send', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id, text: 'K'.repeat(5000) })
  await until(() => !rt.workView()[owner.id]?.active)
  const wide = await call(primary, 'nodo_delegate', { type: 'feature', hard: false, task: 'x'.repeat(31_000) })
  await finish(wide)
  const wideBody = rt.transcriptOf(wide.session).find(line => line.who === 'user' && line.origin?.executionId === wide.executionId).text
  assert.ok(wideBody.length > TASK_TEXT_MAX, 'a near-limit task plus the defaulted user request still exceeds the plain limit')
  assert.ok(wideBody.includes('x'.repeat(31_000)) && wideBody.includes('K'.repeat(5000)))
}))

test('a stop during materialization cancels the dispatch without sending', () => withHandoff(async ({ host, rt, owner, client, call }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const sourceId = await messageSourceId(rt, owner, USER_REQUEST)
  const place = rt.place, send = rt.send, sent = []
  rt.send = (...args) => { sent.push(args[2]); return send(...args) }
  let receipt
  rt.place = async (...args) => {
    if (receipt) void rt.leadDispatch.interrupt(owner.id, { executionId: receipt.executionId }).catch(() => {})
    return place(...args)
  }
  receipt = await call(primary, 'nodo_delegate', { ...command, context: { required: [], background: [sourceId] } })
  await rt.followLead(owner.id, turn('done'))
  const execution = await until(() => rt.state.executions[receipt.executionId].status === 'cancelled' ? rt.state.executions[receipt.executionId] : null)
  assert.equal(execution.startedAt, null, 'the stop lands before the execution starts')
  assert.equal(execution.inputContext, undefined, 'no input is recorded for a stopped dispatch')
  assert.equal(sent.includes(receipt.session), false, 'sendTurn is never called after the stop')
  assert.equal(rt.driverOf(receipt.session), undefined)
  rt.place = place
  rt.send = send
  await until(() => !rt.workView()[owner.id]?.active)
  await reviewDeliveredReports(rt, owner.id)
}))

test('default collection inlines the user request, applicable decisions and dependency acceptance, and archives dependency reports', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const dependency = await call(primary, 'nodo_delegate', { ...command, task: 'Investigate storage' })
  await finish(dependency)
  await rt.completeTask(dependency.taskId, { reason: 'Dependency accepted after checking the archived result', executionIds: [dependency.executionId], basis: ['Verified dependency result'] })
  const decisionId = await answerDecision(host, rt, owner, call, primary, dependency.taskId)
  const receipt = await call(primary, 'nodo_delegate', { ...command, task: 'Apply the agreed storage', dependsOn: [dependency.taskId] })
  await finish(receipt)
  const body = rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.executionId === receipt.executionId).text
  const result = rt.state.executions[dependency.executionId].result
  assert.equal(body.includes(USER_REQUEST), false, 'a decision-answer round never falls back to an earlier user message')
  assert.ok(body.includes('日志保留多久') && body.includes('保留 30 天，脱敏后归档'), 'the applicable decision is injected')
  assert.ok(body.includes('验收结论：Dependency accepted after checking the archived result'))
  assert.ok(body.includes('仅结果预览') && body.includes(result.preview))
  assert.equal(body.includes('Report from Worker'), false, 'a delivered report never impersonates the user source')
  const inputContext = rt.state.executions[receipt.executionId].inputContext
  const required = Object.fromEntries(inputContext.required.map(item => [item.sourceId.split(':')[0] + (item.previewOnly ? ':preview' : ''), item]))
  assert.equal(required.message, undefined, 'the decision-answer round injects no user message')
  assert.equal(required.decision.sourceId, `decision:${decisionId}`)
  assert.equal(required.task.sourceId, `task:${dependency.taskId}:acceptance`)
  assert.equal(required['execution:preview'].sourceId, `execution:${dependency.executionId}:result`)
  assert.equal(inputContext.background[0].sourceId, `execution:${dependency.executionId}:result`, 'the full dependency report is archived as background alongside the preview')
  assert.equal(readFileSync(inputContext.background[0].path, 'utf8'), result.text)
}))

test('default user request follows the triggering line and the owning task record', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  const bodyOf = receipt => rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.executionId === receipt.executionId).text
  await userRequest(host, rt, owner)
  const primary = await client()
  const first = await call(primary, 'nodo_delegate', { ...command, task: 'Investigate storage' })
  await finish(first)
  assert.ok(bodyOf(first).includes(USER_REQUEST), 'a user-triggered round injects that user message')
  assert.equal(rt.state.tasks[first.taskId].source.request.text, USER_REQUEST)
  const second = await call(primary, 'nodo_delegate', { ...command, task: 'Follow up on the report' })
  await finish(second)
  assert.equal(bodyOf(second).includes(USER_REQUEST), false, 'a report-triggered round never looks back to the earlier user message')
  assert.equal(rt.state.executions[second.executionId].inputContext.required.some(item => item.kind === 'message'), false)
  await host.api('send', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id, text: 'Retune the storage engine for writes' })
  await until(() => !rt.workView()[owner.id]?.active)
  const third = await call(primary, 'nodo_delegate', { ...command, taskId: first.taskId, task: 'Continue the storage task' })
  await finish(third)
  assert.ok(bodyOf(third).includes(USER_REQUEST), 'a continuation injects the request recorded at acceptance')
  assert.equal(bodyOf(third).includes('Retune the storage engine for writes'), false, 'the continuation ignores the newer user message')
  const required = rt.state.executions[third.executionId].inputContext.required
  assert.deepEqual(required.map(item => [item.kind, item.role, item.completeness]), [['message', 'required', 'complete']])
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: required[0].sourceId })).text, USER_REQUEST)
}))

test('unknown, unauthorized, cleaned and over-budget required sources are refused before any resource is allocated', () => withHandoff(async ({ host, rt, owner, other, worker, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client(), foreign = await client(other.id)
  const { tools } = await primary.listTools()
  const delegateSchema = tools.find(tool => tool.name === 'nodo_delegate').inputSchema.properties.context
  assert.deepEqual(delegateSchema.required, ['required', 'background'])
  assert.equal(delegateSchema.properties.required.maxItems, 20)
  assert.equal(delegateSchema.properties.background.maxItems, 20)
  assert.match(tools.find(tool => tool.name === 'nodo_context').description, /message:<sessionId>:<at>:<hash>/)
  const dependency = await call(primary, 'nodo_delegate', { ...command, task: 'Investigate storage' })
  await finish(dependency)
  const resultSourceId = `execution:${dependency.executionId}:result`
  rt.state.profiles[worker.id].engine = 'large-fixture'
  const large = await call(primary, 'nodo_delegate', { ...command, task: 'Produce a large report' })
  await finish(large)
  rt.state.profiles[worker.id].engine = 'capture-fixture'
  assert.equal(rt.state.executions[large.executionId].result.text.length, INPUT_CONTEXT_MAX)
  for (let index = 0; index < 5; index++) rt.state.executions[`bulk-${index}`] = { id: `bulk-${index}`, taskId: dependency.taskId,
    status: 'done', reason: 'done', references: [], result: { text: 'z'.repeat(900_000), completeness: 'complete', reason: null, preview: 'bulk', length: 900_000 } }
  const stale = `message:${owner.id}:123:deadbeef`
  const snapshot = () => [Object.keys(rt.state.executions).length, Object.keys(rt.state.tasks).length, rt.findProfile(worker.id).sessions.length]
  const before = snapshot()
  for (const [client_, args, message] of [
    [primary, { context: { required: ['execution:missing:result'], background: [] } }, /No such execution/],
    [primary, { context: { required: ['decision:missing'], background: [] } }, /决策不存在/],
    [primary, { context: { required: ['foo:bar'], background: [] } }, /无效的 sourceId/],
    [primary, { context: { required: [stale], background: [] } }, /不可用或已清理/],
    [primary, { context: { required: [`execution:${large.executionId}:result`], background: [] } }, /必需上下文超过派活输入预算/],
    [primary, { context: { required: Array.from({ length: 21 }, () => 'execution:missing:result'), background: [] } }, /context.required 最多 20 个 sourceId/],
    [primary, { context: { required: [], background: [0, 1, 2, 3, 4].map(index => `execution:bulk-${index}:result`) } }, /背景材料合计约 \d+ 字符超过上限 4000000/],
    [foreign, { context: { required: [resultSourceId], background: [] } }, /任务不属于本主控会话/],
    [primary, { context: { required: [], background: 'decision:missing' } }, /context.background 必须是非空字符串数组/],
  ]) {
    const response = await client_.callTool({ name: 'nodo_delegate', arguments: { ...command, ...args } })
    assert.equal(response.isError, true, response.content[0].text)
    assert.match(response.content[0].text, message)
    assert.deepEqual(snapshot(), before, 'a refused delegation allocates no task, execution or session')
  }
  const mixed = await call(primary, 'nodo_delegate', { ...command, task: 'Archive what survives', context: { required: [], background: [resultSourceId, stale] } })
  await finish(mixed)
  const mixedBody = rt.transcriptOf(mixed.session).find(line => line.who === 'user' && line.origin?.executionId === mixed.executionId).text
  assert.ok(mixedBody.includes('；不可用：cleaned') && mixedBody.includes('（未写入文件）'), 'an unavailable background entry is listed in the body, not dropped silently')
  assert.ok(mixedBody.includes('## 背景材料'))
  const mixedInput = rt.state.executions[mixed.executionId].inputContext
  assert.equal(mixedInput.background.length, 1)
  assert.deepEqual(mixedInput.omitted, [{ sourceId: stale, kind: 'message', description: '已清理的会话消息', reason: 'cleaned' }])
  rt.state.executions.legacy = { id: 'legacy', taskId: dependency.taskId, status: 'done', reason: 'done', report: 'Legacy retained summary', references: [] }
  const partial = await call(primary, 'nodo_delegate', { ...command, task: 'Reuse the legacy summary', context: { required: ['execution:legacy:result'], background: [] } })
  await finish(partial)
  const body = rt.transcriptOf(partial.session).find(line => line.who === 'user' && line.origin?.executionId === partial.executionId).text
  assert.ok(body.includes('Legacy retained summary'))
  assert.ok(body.includes('部分内容：legacy-report'), 'a partial required source keeps its marker inline')
  assert.equal(rt.state.executions[partial.executionId].inputContext.required[0].completeness, 'partial')
}))

test('background materialization failure ends the dispatch unsent without calling sendTurn', () => withHandoff(async ({ host, rt, owner, client, call }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const sourceId = await messageSourceId(rt, owner, USER_REQUEST)
  const place = rt.place, send = rt.send, sent = []
  rt.send = (...args) => { sent.push(args[2]); return send(...args) }
  rt.place = async () => { throw new Error('place failed') }
  const receipt = await call(primary, 'nodo_delegate', { ...command, context: { required: [], background: [sourceId] } })
  await rt.followLead(owner.id, turn('done'))
  const execution = await until(() => rt.state.executions[receipt.executionId].status === 'failed' ? rt.state.executions[receipt.executionId] : null)
  assert.equal(execution.startedAt, null, 'materialization fails before the execution starts')
  assert.equal(execution.inputContext, undefined, 'no input is recorded for an unsent dispatch')
  assert.match(execution.reason, /place failed/)
  assert.equal(sent.includes(receipt.session), false, 'sendTurn is never called for the failed dispatch')
  assert.equal(rt.driverOf(receipt.session), undefined)
  rt.place = place
  rt.send = send
  await until(() => !rt.workView()[owner.id]?.active)
  await reviewDeliveredReports(rt, owner.id)
}))

test('nodo_context directory and read cover decisions, messages, tool records and acceptances', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  const bootstrap = await client()
  const receipt = await call(bootstrap, 'nodo_delegate', { ...command, task: 'Run a tool' })
  await finish(receipt)
  // The first lead-driver start rotates the MCP credential, so re-issue before the decision step.
  const primary = await client()
  await until(() => Object.keys(rt.state.streamDetails ?? {}).length > 0)
  // A running re-execution keeps its session messages in the narrowed directory.
  const again = await rt.acceptExecution(receipt.taskId, { profileId: rt.conversationOf(receipt.session).profile.id,
    sessionId: receipt.session, type: 'feature', hard: false })
  await rt.startExecution(again.id)
  const narrowed = await rt.executionContext(owner.id, { action: 'list', taskId: receipt.taskId })
  assert.ok(narrowed.items.some(item => item.source === 'message' && item.sessionId === receipt.session),
    'sessions of running executions stay listed when narrowing by task')
  await rt.cancelUnsentExecution(again.id, { reason: 'fixture-cleanup' })
  await rt.completeTask(receipt.taskId, { reason: 'Accepted the tool run', executionIds: [receipt.executionId], basis: ['Tool evidence'] })
  const decisionId = await answerDecision(host, rt, owner, call, primary, receipt.taskId)
  const directory = await rt.executionContext(owner.id, { action: 'list' })
  const bySource = source => directory.items.filter(item => item.source === source)
  assert.ok(bySource('execution-result').some(item => item.executionId === receipt.executionId))
  const message = bySource('message').find(item => item.sessionId === receipt.session && item.who === 'user')
  assert.ok(message, 'executor session messages are listed for owned tasks')
  const tool = bySource('tool-record')[0]
  assert.equal(tool.description, 'bash')
  assert.equal(tool.completeness, 'complete')
  assert.equal(tool.sessionId, receipt.session)
  const acceptance = bySource('task-acceptance')[0]
  assert.equal(acceptance.sourceId, `task:${receipt.taskId}:acceptance`)
  assert.equal(acceptance.completeness, 'complete')
  const decisionRead = await rt.executionContext(owner.id, { action: 'read', sourceId: `decision:${decisionId}` })
  assert.equal(decisionRead.completeness, 'complete')
  assert.ok(decisionRead.text.includes('问题：日志保留多久') && decisionRead.text.includes('回答：保留 30 天，脱敏后归档'))
  const toolRead = await rt.executionContext(owner.id, { action: 'read', sourceId: tool.sourceId })
  assert.ok(toolRead.text.includes('工具：bash'))
  rt.driverSink(receipt.session, { type: 'tool', callId: 'input-only', name: 'Read', phase: 'start',
    presentation: { version: 1, kind: 'tool', mode: 'snapshot', body: { input: { path: '/tmp/wide' } }, capture: 'complete' } })
  rt.driverSink(receipt.session, { type: 'tool', callId: 'input-only', name: 'Read', phase: 'end',
    presentation: { version: 1, kind: 'tool', mode: 'snapshot', body: { input: { path: '/tmp/wide' } }, capture: 'complete' } })
  const inputOnly = await until(() => Object.values(rt.state.streamDetails ?? {}).find(entry => entry.entityId === 'input-only'))
  const inputRead = await rt.executionContext(owner.id, { action: 'read', sourceId: `tool:${receipt.session}:${inputOnly.ref}` })
  assert.ok(inputRead.text.includes('输入：') && inputRead.text.includes('/tmp/wide'), 'a stored input object is serialized when inputText is absent')
  const acceptanceRead = await rt.executionContext(owner.id, { action: 'read', sourceId: acceptance.sourceId })
  assert.ok(acceptanceRead.text.includes('验收结论：Accepted the tool run') && acceptanceRead.text.includes('- Tool evidence'))
  const messageRead = await rt.executionContext(owner.id, { action: 'read', sourceId: message.sourceId })
  assert.ok(messageRead.text.length > 0)
  let body = '', offset = 0
  do {
    const page = await rt.executionContext(owner.id, { action: 'read', sourceId: `execution:${receipt.executionId}:result`, offset, limit: 50 })
    body += page.text
    offset = page.nextOffset
  } while (offset !== null)
  assert.equal(body, FINAL, 'paged reassembly equals the archived result')
}))

test('a foreign lead cannot read or select message, tool and decision sources of another lead', () => withHandoff(async ({ host, rt, worker, owner, other, client, call, finish }) => {
  const bootstrap = await client()
  const receipt = await call(bootstrap, 'nodo_delegate', { ...command, task: 'Run a tool' })
  await finish(receipt)
  // The first lead-driver start rotates the MCP credential, so re-issue before the decision step.
  const primary = await client()
  const decisionId = await answerDecision(host, rt, owner, call, primary, receipt.taskId)
  await until(() => Object.keys(rt.state.streamDetails ?? {}).length > 0)
  const directory = await rt.executionContext(owner.id, { action: 'list' })
  const message = directory.items.find(item => item.source === 'message' && item.sessionId === receipt.session)
  const tool = directory.items.find(item => item.source === 'tool-record')
  assert.ok(message && tool, 'the owning lead lists its executor message and tool record')
  const foreign = await client(other.id)
  const snapshot = () => [Object.keys(rt.state.executions).length, Object.keys(rt.state.tasks).length, rt.findProfile(worker.id).sessions.length]
  const before = snapshot()
  for (const [sourceId, refusedMessage] of [
    [message.sourceId, /消息不属于本主控会话/],
    [tool.sourceId, /工具记录不属于本主控会话/],
    [`decision:${decisionId}`, /决策不存在或不属于本主控会话/],
  ]) {
    const denied = await foreign.callTool({ name: 'nodo_context', arguments: { action: 'read', sourceId } })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, refusedMessage)
    for (const role of ['required', 'background']) {
      const selection = role === 'required' ? { required: [sourceId], background: [] } : { required: [], background: [sourceId] }
      const refused = await foreign.callTool({ name: 'nodo_delegate', arguments: { ...command, task: 'Use foreign material', context: selection } })
      assert.equal(refused.isError, true)
      assert.match(refused.content[0].text, refusedMessage)
    }
    assert.deepEqual(snapshot(), before, 'a refused cross-lead selection allocates no resources')
  }
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: message.sourceId })).text.length > 0, true, 'the owning lead still reads its own material')
}))
