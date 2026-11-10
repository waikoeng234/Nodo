import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withHost } from './helpers/host.js'
import { registerClaudeFixtureEngine } from './helpers/echo-driver.js'

registerClaudeFixtureEngine()
const report = (extra = {}) => ({ outcome: 'done', summary: 'Implemented', changed: [], verified: [{ command: 'npm test', result: 'pass' }], issues: [], ...extra })
const flags = { crossModule: false, publicInterface: false, dataFormat: false, security: false }
const withReports = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Reports', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'echo' })
  const lead = await host.api('profile-create', { name: 'Leader', engine: 'claude', lead: true })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }], assign: {} }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const session = await host.api('session-create', { profile: worker.id, workspace: workspace.id, lazy: true })
  const line = rt.appendLine(owner.id, { who: 'user', kind: 'text', text: 'Implement the original' })
  const trigger = rt.triggerFromLine({ coordinatorSessionId: owner.id, line })
  rt.persistTrigger(trigger)
  const task = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Original', brief: trigger.text, source: { kind: 'lead' }, triggerId: trigger.id, scope: { quote: trigger.text }, flow: { status: 'running', stage: 'implement', round: 1 } })
  const create = async (options = {}) => {
    const saved = await rt.acceptExecution(task.id, { profileId: worker.id, sessionId: session.id, type: 'feature', hard: false,
      triggerId: trigger.id, scope: task.scope, ...options })
    await rt.startExecution(saved.id)
    return rt.state.executions[saved.id]
  }
  const clients = [], bindings = []
  const client = async (stdio = false) => {
    if (stdio) rt.serveMcp = undefined
    const binding = await rt.issueWorkerMcp(session.id)
    bindings.push(binding)
    const spec = binding.servers[0], client = new Client({ name: 'worker-fixture', version: '1' })
    clients.push(client)
    await client.connect('url' in spec
      ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } })
      : new StdioClientTransport({ command: spec.command, args: spec.args, env: Object.fromEntries(spec.env.map(({ name, value }) => [name, value])), stderr: 'pipe' }))
    return { client, binding, spec }
  }
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, undefined, result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  try { await run({ host, rt, workspace, worker, owner, session, task, trigger, create, client, call }) }
  finally { for (const client of clients) await client.close(); for (const binding of bindings) binding.revoke() }
})

for (const stdio of [false, true]) test(`worker ${stdio ? 'stdio' : 'HTTP'} fixture persists latest report, bounded history, redaction and evidence`, () => withReports(async ({ host, rt, workspace, session, create, client, call }) => {
  const execution = await create()
  const { client: worker, spec } = await client(stdio)
  assert.deepEqual((await worker.listTools()).tools.map(item => item.name), ['nodo_report', 'nodo_context'])
  assert.equal((await worker.listTools()).tools[1].annotations.readOnlyHint, true)
  const secret = 'fixture-sensitive-report-value'
  rt.retireValue(secret, 'REPORT_TEST')
  const first = await call(worker, 'nodo_report', report({ summary: secret, changed: [{ path: 'reported.js', op: 'update' }] }))
  assert.equal(first.executionId, execution.id); assert.equal(first.stage, 'implement')
  assert.equal(execution.report, null, 'legacy report remains a string/null, never an object')
  assert.equal(execution.reportData.summary.includes(secret), false)
  const ids = [first.reportId]
  for (let i = 0; i < 4; i++) ids.push((await call(worker, 'nodo_report', report({ summary: `Latest ${i}`, reviewFlags: flags,
    changed: [{ path: 'reported.js', op: 'update' }] }))).reportId)
  assert.deepEqual(execution.reportHistory.map(item => item.id), ids.slice(1, 4))
  assert.equal(execution.reportData.id, ids.at(-1))
  assert.equal(execution.reportData.summary, 'Latest 3')
  const archived = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[execution.id]
  assert.deepEqual(archived.reportData, execution.reportData)
  assert.deepEqual(archived.reportHistory, execution.reportHistory)
  assert.equal(JSON.stringify(archived).includes(secret), false)
  if (stdio) {
    const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
    assert.equal(statSync(env.NODO_WORKER_TOKEN_FILE).mode & 0o777, 0o600)
    assert.equal(statSync(env.NODO_WORKER_SOCKET).mode & 0o777, 0o600)
    assert.equal(rt.redactDeepSecrets(readFileSync(env.NODO_WORKER_TOKEN_FILE, 'utf8')).includes(readFileSync(env.NODO_WORKER_TOKEN_FILE, 'utf8')), false)
  } else {
    assert.equal((await fetch(spec.url, { headers: { authorization: 'Bearer invalid-token' } })).status, 401)
  }
  rt.state.workspaces[workspace.id].worktree = { branch: 'fixture', baseCommit: 'base' }
  rt.appendLine(session.id, { kind: 'changes', who: 'system', presentation: { details: { ref: 'changes' } } })
  rt.readStreamDetail = async () => ({ kind: 'changes', capture: 'complete', body: { files: ['reported.js', 'unreported.js'].map(path => ({ path, edits: [{ operation: 'update' }] })) } })
  await rt.finishExecution(execution.id, { final: '结论：failed\nDetails', report: 'Legacy summary' })
  assert.equal(execution.report, 'Legacy summary')
  assert.deepEqual(execution.evidence.unreported, ['unreported.js'])
  assert.deepEqual(execution.evidence.reported, ['reported.js'])
  assert.equal(execution.evidence.files.capture, 'complete')
  assert.equal(execution.evidence.branch, 'fixture')
  assert.equal(execution.evidence.baseCommit, 'base')
  assert.equal(execution.evidence.verification[0].result, 'pass')
  assert.match(rt.workerReportCard(execution), /最终回复与报告不一致/)
  assert.match(rt.workerReportCard(execution), new RegExp(`报告：report:${ids.at(-1)}`))
  assert.equal((await worker.callTool({ name: 'nodo_report', arguments: report() })).isError, true, 'ended session cannot report')
}))

test('worker rejects stage conflicts and malformed reports; missing reviewFlags is accepted', () => withReports(async ({ rt, create, client, call }) => {
  const implementation = await create(), { client: worker } = await client()
  for (const input of [report({ verdict: 'pass' }), report({ findings: [] }), report({ answers: [{ n: 1, text: 'No question' }] }),
    report({ summary: 'x'.repeat(301) }), report({ changed: [{ path: 'a', op: 'invalid' }] }), report({ reviewFlags: { security: true } }),
    report({ taskId: 'foreign' }), report({ verified: Array(21).fill({ result: 'pass' }) }), report({ issues: [{ text: 'Issue', blocking: 'yes' }] })]) {
    assert.equal((await worker.callTool({ name: 'nodo_report', arguments: input })).isError, true)
    assert.equal(implementation.reportData, undefined)
  }
  await call(worker, 'nodo_report', report())
  assert.equal(implementation.reportData.reviewFlags, undefined)
  await rt.finishExecution(implementation.id, { final: 'Done' })
  const review = await create({ stage: 'review', sourceExecutionId: implementation.id })
  for (const input of [report(), report({ verdict: 'fail' }), report({ verdict: 'fail', findings: [] }),
    report({ verdict: 'fail', findings: [{ category: 'unknown', severity: 'high', text: 'Issue' }] })]) {
    assert.equal((await worker.callTool({ name: 'nodo_report', arguments: input })).isError, true)
    assert.equal(review.reportData, undefined)
  }
  const secret = 'fixture-finding-secret'
  rt.retireValue(secret, 'FINDING_TEST')
  const finding = category => ({ category, severity: 'high', text: secret, evidence: secret })
  await call(worker, 'nodo_report', report({ verdict: 'fail', findings: [finding('security'), finding('security'), finding('other'), finding('publicInterface')] }))
  assert.deepEqual(implementation.reportData.missedFlags, ['security', 'publicInterface'])
  assert.equal(JSON.stringify(review.reportData).includes(secret), false)
  await call(worker, 'nodo_report', report({ verdict: 'pass', findings: [] }))
  assert.deepEqual(implementation.reportData.missedFlags, [])
  await rt.finishExecution(review.id, { final: '结论:不通过' })
  assert.match(rt.workerReportCard(review), /最终回复与报告不一致/)
  const answer = await create({ stage: 'answer', questions: ['Why?', 'Where?'], sourceExecutionId: implementation.id })
  for (const answers of [undefined, [{ n: 1, text: 'Only one' }], [{ n: 1, text: 'A' }, { n: 1, text: 'B' }], [{ n: 1, text: 'A' }, { n: 3, text: 'B' }]]) {
    assert.equal((await worker.callTool({ name: 'nodo_report', arguments: report({ answers }) })).isError, true)
    assert.equal(answer.reportData, undefined)
  }
  await call(worker, 'nodo_report', report({ answers: [{ n: 1, text: secret }, { n: 2, text: 'Evidence' }] }))
  assert.equal(JSON.stringify(answer.reportData.answers).includes(secret), false)
  assert.equal(answer.reportData.verdict, undefined)
}))

test('missedFlags ignores other and true implementation flags', () => withReports(async ({ rt, create, client, call }) => {
  const implementation = await create(), { client: worker } = await client()
  await call(worker, 'nodo_report', report({ reviewFlags: { ...flags, security: true } }))
  await rt.finishExecution(implementation.id, { final: 'Done' })
  await create({ stage: 'review', sourceExecutionId: implementation.id })
  await call(worker, 'nodo_report', report({ verdict: 'fail', findings: ['security', 'crossModule', 'dataFormat', 'other'].map(category => ({ category, severity: 'low', text: 'Finding' })) }))
  assert.deepEqual(implementation.reportData.missedFlags, ['crossModule', 'dataFormat'])
}))

for (const [first, expected] of [['结论:通过', 'pass'], ['# 结论：通过', 'pass'], ['* - ** 结论:不通过', 'fail'], ['  **结论：不通过', 'fail'],
  ['说明\n结论：通过', undefined], ['结论：通过，还有其他内容', undefined], ['', undefined]]) {
  test(`fallback parses only review first line ${JSON.stringify(first)}`, () => withReports(async ({ rt, create }) => {
    const execution = await create({ stage: 'review' })
    await rt.finishExecution(execution.id, { final: first, report: '结论：通过' })
    assert.equal(execution.reportData.verdict, expected)
    assert.equal(execution.reportData.source, 'final-text')
    assert.equal(execution.reportData.structured, false)
    assert.equal(execution.reportData.parse, expected ? 'first-line' : 'none')
    assert.equal(execution.reportData.reviewFlags, undefined)
    assert.equal(execution.evidence.reportCompleteness, first ? 'complete' : 'unavailable')
    assert.match(rt.workerReportCard(execution), /未结构化/)
  }))
}

test('worker whitelist permits own sources and explicit history/context; denies sibling and foreign handles', () => withReports(async ({ rt, owner, task, trigger, create, client, call }) => {
  const execution = await create(), { client: worker } = await client()
  const sibling = { id: 'sibling', taskId: 'another-task', sessionId: 'other-worker', status: 'done', reportData: { id: 'sibling-report' } }
  rt.state.tasks['another-task'] = { id: 'another-task', title: 'Sibling', coordinatorSessionId: owner.id }
  rt.state.executions.sibling = sibling
  const line = rt.appendLine(owner.id, { who: 'user', kind: 'text', text: 'History' })
  const history = rt.messageSourceId(owner.id, line)
  execution.historyHandles = [history]
  execution.contextHandles = ['execution:sibling:result']
  sibling.result = { text: 'Approved context', completeness: 'complete', preview: 'Approved context', length: 16 }
  const ownReport = await call(worker, 'nodo_report', report())
  for (const sourceId of [trigger.handle, history, 'execution:sibling:result', `report:${ownReport.reportId}`, `evidence:${execution.id}`]) {
    const result = await call(worker, 'nodo_context', { action: 'read', sourceId, limit: 5 })
    assert.ok(result.text.length <= 5)
  }
  assert.equal((await call(worker, 'nodo_context', { action: 'read', sourceId: `evidence:${execution.id}` })).completeness, 'unavailable')
  const unrelatedLine = rt.appendLine(owner.id, { who: 'user', kind: 'text', text: 'Not in history' })
  for (const sourceId of ['report:sibling-report', 'evidence:sibling', rt.messageSourceId(owner.id, unrelatedLine), 'decision:private', 'task:another-task:acceptance']) {
    assert.equal((await worker.callTool({ name: 'nodo_context', arguments: { action: 'read', sourceId } })).isError, true, sourceId)
  }
  execution.contextHandles = []
  assert.equal((await worker.callTool({ name: 'nodo_context', arguments: { action: 'read', executionId: 'sibling' } })).isError, true)
  assert.equal((await worker.callTool({ name: 'nodo_context', arguments: { action: 'list', taskId: task.id } })).isError, true)
  assert.equal((await worker.callTool({ name: 'nodo_context', arguments: { action: 'read', sourceId: history, executionId: execution.id } })).isError, true)
  const listed = await call(worker, 'nodo_context', { action: 'list' })
  assert.ok(listed.items.some(item => item.sourceId === history))
  assert.equal(listed.items.some(item => item.sourceId === 'report:sibling-report'), false)
}))

test('worker credentials bind session, follow current execution, reject rotation, revoke, archive and read-only', () => withReports(async ({ rt, owner, session, create, client, call }) => {
  const first = await create(), { client: worker, binding, spec } = await client(true)
  const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
  const token = readFileSync(env.NODO_WORKER_TOKEN_FILE, 'utf8')
  const rpc = value => new Promise((resolve, reject) => {
    const socket = connect(env.NODO_WORKER_SOCKET)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ token: value, name: 'nodo_report', arguments: report() }) + '\n'))
    let buffer = ''
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer)) } })
    socket.on('error', reject)
  })
  assert.equal((await rpc('invalid-token')).isError, true)
  await rt.finishExecution(first.id, { final: 'Done' })
  assert.equal((await rpc(token)).isError, true)
  const second = await create()
  assert.equal((await call(worker, 'nodo_report', report())).executionId, second.id)
  rt.conversationOf(session.id).session.archivedAt = Date.now()
  assert.equal((await rpc(token)).isError, true)
  delete rt.conversationOf(session.id).session.archivedAt
  const readOnly = rt.readOnly
  rt.readOnly = () => 'read only'
  assert.equal((await rpc(token)).isError, true)
  rt.readOnly = readOnly
  assert.equal(await rt.issueWorkerMcp(owner.id), undefined, 'leader never gets worker tools')
  const rotated = await rt.issueWorkerMcp(session.id)
  assert.equal((await rpc(token)).isError, true)
  binding.revoke()
  assert.equal((await rpc(token)).isError, true)
  rotated.revoke()
  assert.equal(rt.redactDeepSecrets(token).includes(token), false)
}))

test('review can overwrite a prior review and answer continue clears every awaiting source report', () => withReports(async ({ rt, owner, task, session, create }) => {
  const source = await create()
  await rt.workerReport(source, report())
  await rt.finishExecution(source.id, { final: 'Done' })
  for (const id of ['first-card', 'second-card']) await rt.registerDeliveredReport({ executionId: source.id, id, session: session.id, status: 'done' }, Date.now())
  const review = { executionId: source.id, disposition: 'continue', reason: 'Checked', basis: ['Evidence'] }
  await rt.reviewReports(task.id, review)
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
  await rt.reviewReports(task.id, { ...review, disposition: 'investigate', questions: ['Why?'] })
  assert.ok(source.reports.every(item => item.review.awaitingAnswer === true))
  assert.equal(rt.reportReviewBlockReason(owner.id).reports.length, 2)
  const answer = await create({ stage: 'answer', questions: ['Why?'], sourceExecutionId: source.id, sourceReportId: 'second-card' })
  await rt.workerReport(answer, report({ answers: [{ n: 1, text: 'Evidence' }] }))
  await rt.finishExecution(answer.id, { final: 'Answered' })
  await rt.registerDeliveredReport({ executionId: answer.id, id: 'answer-card', session: session.id, status: 'done' }, Date.now())
  await rt.leadReview(owner.id, { ...review, executionId: answer.id })
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
  assert.ok(source.reports.every(item => item.review.disposition === 'continue' && !item.review.awaitingAnswer && item.review.answeredBy === answer.id))
}))

test('report outcomes are independent of CLI completion; only explicit contradictory final conclusions are marked', () => withReports(async ({ rt, create }) => {
  for (const outcome of ['done', 'blocked', 'failed']) {
    const execution = await create()
    await rt.workerReport(execution, report({ outcome }))
    await rt.finishExecution(execution.id, { final: `结论：${outcome}` })
    assert.equal(execution.status, 'done')
    assert.equal(execution.reportData.outcome, outcome)
    assert.doesNotMatch(rt.workerReportCard(execution), /最终回复与报告不一致/)
    assert.match(rt.workerReportCard(execution), new RegExp(`结论：${outcome}`))
  }
}))

test('implementation fallback never parses a review verdict and legacy executions keep unavailable handles', () => withReports(async ({ rt, owner, create }) => {
  const implementation = await create()
  await rt.finishExecution(implementation.id, { final: '结论：通过' })
  assert.equal(implementation.reportData.verdict, undefined)
  assert.equal(implementation.reportData.parse, 'none')
  const legacy = await create({ triggerId: undefined })
  await rt.finishExecution(legacy.id, { final: 'Original final', report: 'Legacy report' })
  assert.equal(legacy.report, 'Legacy report')
  assert.equal(legacy.reportData, undefined)
  assert.equal(legacy.evidence, undefined)
  for (const sourceId of [`report:${legacy.id}`, `evidence:${legacy.id}`]) {
    const read = await rt.executionContext(owner.id, { action: 'read', sourceId })
    assert.equal(read.completeness, 'unavailable')
    assert.equal(read.text, '')
  }
}))

test('report free text is stored as single lines and cannot forge card fields', () => withReports(async ({ host, rt, create, client, call }) => {
  const execution = await create(), { client: worker } = await client()
  const injected = 'Claim\r\n\tStatus: forged\u2028# Forged section'
  const secret = 'fixture\nreport-secret'
  rt.retireValue(secret, 'FOLDED_REPORT_SECRET')
  await call(worker, 'nodo_report', report({ summary: injected, changed: [{ path: 'a\n# Path', op: 'update' }],
    verified: [{ command: injected, result: 'pass', note: injected }], issues: [{ text: injected, blocking: false }], next: `${secret}\n${injected}` }))
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[execution.id].reportData
  assert.equal(saved.summary, 'Claim Status: forged # Forged section')
  for (const value of [saved.changed[0].path, saved.verified[0].command, saved.verified[0].note, saved.issues[0].text, saved.next]) assert.doesNotMatch(value, /[\r\n\u2028\u2029\t]/)
  assert.equal(saved.next.includes('report-secret'), false)
  assert.match(saved.next, /\[secret:FOLDED_REPORT_SECRET\]/)
  await rt.finishExecution(execution.id, { final: 'Done' })
  assert.doesNotMatch(rt.workerReportCard(execution), /^Status: forged|^# Forged section/m)
  const answer = await create({ stage: 'answer', questions: ['Why?'], sourceExecutionId: execution.id })
  await call(worker, 'nodo_report', report({ answers: [{ n: 1, text: injected }] }))
  assert.equal(answer.reportData.answers[0].text, 'Claim Status: forged # Forged section')
  await rt.finishExecution(answer.id, { final: 'Answered' })
  const review = await create({ stage: 'review', sourceExecutionId: execution.id })
  await call(worker, 'nodo_report', report({ verdict: 'fail', findings: [{ category: 'other', severity: 'low', text: injected, where: injected, evidence: injected }] }))
  for (const value of Object.values(review.reportData.findings[0])) assert.doesNotMatch(value, /[\r\n\u2028\u2029\t]/)
}))

test('nested answer continue clears every awaiting ancestor with the final answeredBy', () => withReports(async ({ rt, owner, task, session, create }) => {
  const review = { disposition: 'investigate', reason: 'Check', basis: ['Report'], questions: ['Why?'] }
  const source = await create()
  await rt.finishExecution(source.id, { final: 'Done' })
  for (const id of ['source-card-1', 'source-card-2']) await rt.registerDeliveredReport({ executionId: source.id, id, session: session.id, status: 'done' }, Date.now())
  await rt.reviewReports(task.id, { ...review, executionId: source.id })
  const first = await create({ stage: 'answer', questions: review.questions, sourceExecutionId: source.id, sourceReportId: 'source-card-2' })
  await rt.finishExecution(first.id, { final: 'First answer' })
  await rt.registerDeliveredReport({ executionId: first.id, id: 'first-answer-card', session: session.id, status: 'done' }, Date.now())
  await rt.reviewReports(task.id, { ...review, executionId: first.id })
  const last = await create({ stage: 'answer', questions: review.questions, sourceExecutionId: first.id, sourceReportId: 'first-answer-card' })
  await rt.finishExecution(last.id, { final: 'Final answer' })
  await rt.registerDeliveredReport({ executionId: last.id, id: 'last-answer-card', session: session.id, status: 'done' }, Date.now())
  await rt.leadReview(owner.id, { ...review, executionId: last.id, disposition: 'continue' })
  for (const execution of [source, first]) for (const report of execution.reports) {
    assert.equal(report.review.awaitingAnswer, false)
    assert.equal(report.review.disposition, 'continue')
    assert.equal(report.review.answeredBy, last.id)
  }
  assert.equal(rt.reportReviewBlockReason(owner.id), undefined)
}))

test('a worker token cannot report or read another session execution', () => withReports(async ({ host, rt, workspace, worker, owner, create, client, call }) => {
  const otherSession = await host.api('session-create', { profile: worker.id, workspace: workspace.id, lazy: true })
  const otherTask = await rt.createTask({ workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id,
    title: 'Other', brief: 'Other', source: { kind: 'lead' } })
  const other = await rt.acceptExecution(otherTask.id, { profileId: worker.id, sessionId: otherSession.id, type: 'feature', hard: false })
  await rt.startExecution(other.id)
  const own = await create(), { client: caller } = await client()
  const receipt = await call(caller, 'nodo_report', report())
  assert.equal(receipt.executionId, own.id)
  assert.equal(rt.state.executions[other.id].reportData, undefined)
  for (const args of [{ executionId: other.id }, { sessionId: otherSession.id }]) assert.equal((await caller.callTool({ name: 'nodo_report', arguments: report(args) })).isError, true)
  for (const sourceId of [`execution:${other.id}:result`, `report:${other.id}`, `evidence:${other.id}`]) assert.equal((await caller.callTool({ name: 'nodo_context', arguments: { action: 'read', sourceId } })).isError, true)
}))

test('a leader in lead mode cannot issue a worker token even with a forged running execution', () => withReports(async ({ rt, owner, task }) => {
  rt.state.executions['forged-lead-execution'] = { id: 'forged-lead-execution', taskId: task.id, sessionId: owner.id, status: 'running' }
  const binding = await rt.issueWorkerMcp(owner.id)
  binding?.revoke()
  assert.ok(binding === undefined, 'lead mode must never issue worker credentials')
}))

test('structured cards retain resume, capture details and final preview', () => withReports(async ({ rt, create }) => {
  const execution = await create()
  await rt.workerReport(execution, report())
  await rt.finishExecution(execution.id, { final: 'Final reply' })
  execution.result = { text: 'Final reply', preview: 'Final bounded preview', completeness: 'partial', reason: 'storage-limit', length: 20, originalLength: 1200 }
  const card = rt.workerReportCard(execution, { resumed: true })
  assert.match(card, /Supplemental report after the user manually resumed this session in Nodo\./)
  assert.match(card, /Completeness: partial \(storage-limit\), 20 of 1,200 characters/)
  assert.match(card, /Result preview: Final bounded preview/)
}))

test('structured cards redact the entire card including metadata outside the stored report', () => withReports(async ({ rt, create }) => {
  const execution = await create()
  await rt.workerReport(execution, report())
  await rt.finishExecution(execution.id, { final: 'Final reply' })
  const secret = 'fixture-card-role-secret'
  rt.retireValue(secret, 'CARD_TEST')
  rt.conversationOf(execution.sessionId).profile.name = secret
  const card = rt.workerReportCard(execution)
  assert.equal(card.includes(secret), false)
  assert.match(card, /\[secret:CARD_TEST\]/)
}))
