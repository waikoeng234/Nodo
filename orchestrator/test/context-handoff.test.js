import { routeUserTask, userRoute } from './helpers/route.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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
  await rt.ensureDriver(await rt.prepareConversation(owner.id))
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
  const decision = await call(primary, 'nodo_route', { action: 'ask', ...{ taskIds: [taskId], stopExecutionIds: [],
    questions: [{ id: 'logs', question: '日志保留多久？', whyUser: '影响背景材料范围' }] } })
  await host.api('decision-answer', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id,
    decisionId: decision.decisionId, answers: { logs: { text: '保留 30 天，脱敏后归档' } } })
  await until(() => rt.state.decisions[decision.decisionId].status === 'delivered' && !rt.workView()[owner.id]?.active)
  return decision.decisionId
}

test('route refuses explicit leader context and fixes dependency inputs after source cleanup', () => withHandoff(async ({ host, rt, workspace, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const dependency = await call(primary, 'nodo_route', userRoute(rt, owner.id, command))
  await finish(dependency)
  await rt.completeTask(dependency.taskId, { reason: 'Checked', executionIds: [dependency.executionId], basis: ['Verified'] })
  const rejected = await primary.callTool({ name: 'nodo_route', arguments: { ...userRoute(rt, owner.id, command), context: { required: [], background: [] } } })
  assert.equal(rejected.isError, true)
  const receipt = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, dependsOn: [dependency.taskId] }))
  await finish(receipt)
  const execution = rt.state.executions[receipt.executionId]
  const background = execution.inputContext.background[0]
  assert.equal(background.sourceId, `execution:${dependency.executionId}:result`)
  assert.equal(readFileSync(join(workspace.cwd, background.path), 'utf8'), FINAL)
  const body = rt.transcriptOf(receipt.session).find(line => line.origin?.executionId === receipt.executionId).text
  rt.state.executions[dependency.executionId].result = { text: '', preview: '', completeness: 'unavailable', length: 0 }
  assert.equal(rt.transcriptOf(receipt.session).find(line => line.origin?.executionId === receipt.executionId).text, body)
  assert.equal(readFileSync(join(workspace.cwd, background.path), 'utf8'), FINAL)
}))

test('near-limit user originals reach the executor whole through the larger input budget', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const text = 'x'.repeat(31_000)
  const receipt = await call(primary, 'nodo_route', { ...userRoute(rt, owner.id, { type: 'feature', hard: false, task: text }), scope: { note: 'Process the user text' } })
  await finish(receipt)
  const body = rt.transcriptOf(receipt.session).find(line => line.origin?.executionId === receipt.executionId).text
  assert.ok(body.includes(text))
  assert.equal(rt.driverOf(receipt.session).calls[0], body)
  assert.ok(body.length < INPUT_CONTEXT_MAX)
  assert.equal(rt.state.tasks[receipt.taskId].brief, text)
}))

test('a stop during materialization cancels the dispatch without sending', () => withHandoff(async ({ host, rt, owner, client, call }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const refs = await rt.saveFiles(rt.admitFiles([{ name: 'input.txt', data: Buffer.from('material').toString('base64') }]))
  const place = rt.place, send = rt.send, sent = []
  rt.send = (...args) => { sent.push(args[2]); return send(...args) }
  let receipt
  rt.place = async (...args) => {
    if (receipt) void rt.leadDispatch.interrupt(owner.id, { executionId: receipt.executionId }).catch(() => {})
    return place(...args)
  }
  const args = userRoute(rt, owner.id, command)
  rt.pendingTriggerOf(owner.id).files = refs
  receipt = await call(primary, 'nodo_route', args)
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

test('default collection inlines applicable decisions and dependency acceptance, and archives the last accepted dependency report', () => withHandoff(async ({ host, rt, workspace, owner, client, call, finish }) => {
  await userRequest(host, rt, owner)
  const primary = await client()
  const dependency = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Investigate storage' }))
  await finish(dependency)
  rt.state.executions.revised = { id: 'revised', taskId: dependency.taskId, status: 'done', reason: 'done', references: [],
    result: { text: 'Revised dependency report', completeness: 'complete', reason: null, preview: 'Revised dependency report', length: 25, originalLength: 25 } }
  await rt.completeTask(dependency.taskId, { reason: 'Dependency accepted after checking the archived result', executionIds: [dependency.executionId, 'revised'], basis: ['Verified dependency result'] })
  const decisionId = await answerDecision(host, rt, owner, call, primary, dependency.taskId)
  const receipt = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Apply the agreed storage', dependsOn: [dependency.taskId] }))
  await finish(receipt)
  const body = rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.executionId === receipt.executionId).text
  const result = rt.state.executions[dependency.executionId].result
  assert.equal(body.includes(USER_REQUEST), true, 'user history is retained separately from handover material')
  assert.ok(body.includes('日志保留多久') && body.includes('保留 30 天，脱敏后归档'), 'the applicable decision is injected')
  assert.ok(body.includes('验收结论：Dependency accepted after checking the archived result'))
  assert.equal(body.includes(result.preview), false, 'dependency results no longer ride inline as previews')
  assert.equal(body.includes('Report from Worker'), false, 'a delivered report never impersonates the user source')
  const inputContext = rt.state.executions[receipt.executionId].inputContext
  const required = Object.fromEntries(inputContext.required.map(item => [item.sourceId.split(':')[0], item]))
  assert.equal(required.message, undefined, 'the decision-answer round injects no user message')
  assert.equal(required.decision.sourceId, `decision:${decisionId}`)
  assert.equal(required.task.sourceId, `task:${dependency.taskId}:acceptance`)
  assert.equal(required.execution, undefined, 'dependency results are no longer previewed as required entries')
  assert.deepEqual(inputContext.background.map(entry => entry.sourceId), ['execution:revised:result'], 'only the last accepted execution is archived as background')
  assert.ok(body.includes(inputContext.background[0].path), 'the body points at the archived background file')
  assert.equal(readFileSync(join(realpathSync(workspace.cwd), inputContext.background[0].path), 'utf8'), 'Revised dependency report')
}))

test('default dispatches carry originals and user history without replaying system report rows', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  const bodyOf = receipt => rt.transcriptOf(receipt.session).find(line => line.who === 'user' && line.origin?.executionId === receipt.executionId).text
  await userRequest(host, rt, owner)
  const primary = await client()
  const first = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Investigate storage' }))
  await finish(first)
  assert.equal(bodyOf(first).includes(USER_REQUEST), true, 'a fresh worker receives prior user originals')
  assert.equal(rt.state.executions[first.executionId].inputContext.required.some(item => item.kind === 'message'), false)
  assert.equal(rt.state.tasks[first.taskId].source.request, undefined)
  const second = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Follow up on the report' }))
  await finish(second)
  assert.equal(bodyOf(second).includes(USER_REQUEST), true, 'a new user-triggered dispatch includes user history')
  assert.equal(rt.state.executions[second.executionId].inputContext.required.some(item => item.kind === 'message'), false)
  await host.api('send', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id, text: 'Retune the storage engine for writes' })
  await until(() => !rt.workView()[owner.id]?.active)
  const third = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, taskId: first.taskId, task: 'Continue the storage task' }))
  await finish(third)
  assert.ok(bodyOf(third).includes('Continue the storage task'), 'a continuation carries the current trigger verbatim')
  assert.equal(bodyOf(third).includes('Report from Worker'), false, 'system user rows are excluded from history')
  assert.deepEqual(rt.state.executions[third.executionId].inputContext.required, [])
}))

test('route refuses every explicit context selection before allocating task resources', () => withHandoff(async ({ rt, owner, client, worker }) => {
  const primary = await client()
  for (const sourceId of ['execution:unknown:result', 'decision:foreign', 'message:cleaned:1:12345678']) {
    const before = [Object.keys(rt.state.tasks).length, Object.keys(rt.state.executions).length, rt.findProfile(worker.id).sessions.length]
    const result = await primary.callTool({ name: 'nodo_route', arguments: { ...userRoute(rt, owner.id, command), context: { required: [sourceId], background: [] } } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /不支持的参数/)
    assert.deepEqual([Object.keys(rt.state.tasks).length, Object.keys(rt.state.executions).length, rt.findProfile(worker.id).sessions.length], before)
  }
}))

test('dependency background materialization failure ends dispatch unsent', () => withHandoff(async ({ rt, owner, client, call, finish }) => {
  const primary = await client()
  const dependency = await call(primary, 'nodo_route', userRoute(rt, owner.id, command))
  await finish(dependency)
  await rt.completeTask(dependency.taskId, { reason: 'Checked', executionIds: [dependency.executionId], basis: ['Verified'] })
  const receipt = await call(primary, 'nodo_route', userRoute(rt, owner.id, { ...command, dependsOn: [dependency.taskId] }))
  rt.place = async () => { throw new Error('Fixture materialization failed') }
  await rt.followLead(owner.id, turn('done'))
  await until(() => rt.state.executions[receipt.executionId].status === 'failed')
  assert.equal(rt.state.executions[receipt.executionId].startedAt, null)
  assert.equal(rt.driverOf(receipt.session), undefined)
}))

test('nodo_context directory and read cover decisions, messages, tool records and acceptances', () => withHandoff(async ({ host, rt, owner, client, call, finish }) => {
  const bootstrap = await client()
  const receipt = await call(bootstrap, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Run a tool' }))
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
  const receipt = await call(bootstrap, 'nodo_route', userRoute(rt, owner.id, { ...command, task: 'Run a tool' }))
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
      const refused = await foreign.callTool({ name: 'nodo_route', arguments: userRoute(rt, owner.id, { ...command, task: 'Use foreign material', context: selection } )})
      assert.equal(refused.isError, true)
      assert.match(refused.content[0].text, /不支持的参数/)
    }
    assert.deepEqual(snapshot(), before, 'a refused cross-lead selection allocates no resources')
  }
  assert.equal((await rt.executionContext(owner.id, { action: 'read', sourceId: message.sourceId })).text.length > 0, true, 'the owning lead still reads its own material')
}))
