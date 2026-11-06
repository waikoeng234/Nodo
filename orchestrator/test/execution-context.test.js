import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withHost, boot, until } from './helpers/host.js'
import { echoEntry, registerClaudeFixtureEngine } from './helpers/echo-driver.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { CONTEXT_LIST_MAX, CONTEXT_PAGE_DEFAULT, CONTEXT_PAGE_MAX } from '../core/src/constants.js'

registerClaudeFixtureEngine()
const final = 'Outcome and evidence\n' + 'result🙂\n'.repeat(5000)
registerEngine('result-fixture', { ...echoEntry, info: { ...echoEntry.info, id: 'result-fixture', name: 'Result fixture' },
  create: options => echoEntry.create({ ...options, script: [{ kind: 'text', text: final }],
    onEvent: event => options.onEvent({ ...event, ...(event.type === 'turn/end' ? { text: final } : {}) }) }) })

const withResults = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Results', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine: 'result-fixture' })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'code', name: 'Code', when: '' }],
    assign: { code: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  await host.api('send', { profile: lead.id, session: owner.id, text: 'Verify results' })
  await until(() => !rt.workView()[owner.id]?.active)
  const clients = [], bindings = []
  const connect = async (runtime, session) => {
    const binding = await runtime.issueLeadMcp(session.id), spec = binding.servers[0]
    bindings.push(binding)
    const client = new Client({ name: 'result-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { authorization: `Bearer ${spec.token}` } } }))
    return client
  }
  const call = async (client, name, args) => {
    const response = await client.callTool({ name, arguments: args })
    assert.equal(response.isError, undefined, response.content[0].text)
    return JSON.parse(response.content[0].text)
  }
  try { await run({ host, rt, workspace, owner, other, final, connect, call, clients, bindings }) }
  finally { for (const client of clients) await client.close(); for (const binding of bindings) binding.revoke() }
})

test('reference failure leaves report, context read, review, Decision and complete working across restart', () => withResults(async ({ host, rt, owner, other, final, connect, call, clients, bindings }) => {
  const client = await connect(rt, owner), outsider = await connect(rt, other)
  let referenceCalls = 0
  rt.createReference = async () => { referenceCalls++; throw new Error('Automatic references must not be needed') }
  const send = rt.send
  let reported = false
  rt.send = async (...args) => {
    if (args[5]?.origin?.kind === 'report') {
      const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
      assert.equal(saved.executions[args[5].origin.executionId].result.text, final, 'result is persisted before report delivery')
      reported = true
    }
    return send(...args)
  }
  const { tools } = await client.listTools()
  assert.equal(tools.find(tool => tool.name === 'nodo_context').annotations.readOnlyHint, true)
  const receipt = await call(client, 'nodo_delegate', { type: 'code', hard: false, task: 'Implement result archive' })
  assert.equal(receipt.status, 'queued')
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'done' }) })
  await until(() => rt.state.executions[receipt.executionId].status === 'done')
  await until(() => reported)
  await until(() => !rt.workView()[owner.id]?.active)
  const execution = rt.state.executions[receipt.executionId]
  await until(() => execution.reports?.length === 1)
  const report = rt.transcriptOf(owner.id).find(line => line.origin?.executionId === execution.id)
  assert.match(report.text, /Result preview:/)
  assert.ok(report.text.includes(execution.result.preview))
  assert.equal(report.text.includes(final), false)
  assert.ok(report.text.includes(`nodo_context read executionId ${execution.id}`))
  assert.equal(report.references, undefined)
  assert.deepEqual(execution.references, [])
  assert.equal(execution.result.text, final)
  assert.equal(execution.result.completeness, 'complete')
  const sourceId = `execution:${receipt.executionId}:result`
  const board = await call(client, 'nodo_board', { table: 'tasks' })
  assert.equal(board[0].latestResult.sourceId, sourceId)
  assert.equal(JSON.stringify(board).includes(final), false)
  const detail = await call(client, 'nodo_board', { taskId: receipt.taskId })
  assert.equal(detail.executions[0].result.text, undefined)
  assert.equal(detail.executions[0].result.preview.length, 200)
  let body = '', offset = 0
  do {
    const page = await call(client, 'nodo_context', { action: 'read', sourceId, offset })
    assert.ok(page.text.length <= CONTEXT_PAGE_DEFAULT)
    assert.equal(page.status, 'done')
    body += page.text
    offset = page.nextOffset
  } while (offset !== null)
  assert.equal(body, final)
  const firstPage = await call(client, 'nodo_context', { action: 'read', sourceId })
  assert.deepEqual(await call(client, 'nodo_context', { action: 'read', executionId: receipt.executionId }), firstPage)
  for (const args of [{ action: 'read' }, { action: 'read', sourceId, executionId: receipt.executionId }, { action: 'list', executionId: receipt.executionId }]) {
    const refused = await client.callTool({ name: 'nodo_context', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, /只能指定一个|不接受/)
  }
  const before = JSON.stringify(rt.state.executions)
  for (const args of [{ action: 'read', sourceId }, { action: 'list', taskId: receipt.taskId }]) {
    const denied = await outsider.callTool({ name: 'nodo_context', arguments: args })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /不属于本主控会话/)
  }
  assert.deepEqual((await call(outsider, 'nodo_context', { action: 'list' })).items, [])
  assert.equal(JSON.stringify(rt.state.executions), before, 'reads do not review, accept or rewrite results')
  assert.equal(execution.reports[0].review, undefined)
  assert.equal(rt.state.tasks[receipt.taskId].status, 'review')
  await call(client, 'nodo_task', { action: 'review', taskId: receipt.taskId, executionId: execution.id,
    disposition: 'continue', reason: 'Checked archived final', basis: [sourceId, 'Actual verification in final'] })
  assert.equal(execution.reports[0].review.disposition, 'continue')
  assert.equal(rt.state.tasks[receipt.taskId].status, 'review', 'review does not complete')
  const acceptance = { action: 'complete', taskId: receipt.taskId, executionIds: [execution.id], reason: 'Verified result', basis: [sourceId] }
  for (const changes of [{ executionIds: [] }, { basis: [] }, { reason: ' ' }, { references: ['old'] }]) {
    assert.equal((await client.callTool({ name: 'nodo_task', arguments: { ...acceptance, ...changes } })).isError, true)
  }
  const decision = await call(client, 'nodo_decision', { taskIds: [receipt.taskId], executionIds: [execution.id], stopExecutionIds: [],
    questions: [{ id: 'accept', question: 'Accept this result?', whyUser: 'Fixture user choice' }] })
  assert.deepEqual(decision.decision.sourceExecutionIds, [execution.id])
  assert.equal(execution.reports[0].review.disposition, 'ask')
  const blocked = await client.callTool({ name: 'nodo_task', arguments: acceptance })
  assert.equal(JSON.parse(blocked.content[0].text).code, 'orch/decision-pending')
  await host.api('decision-answer', { profile: rt.conversationOf(owner.id).profile.id, session: owner.id,
    decisionId: decision.decisionId, answers: { accept: { text: 'Accept the verified result' } } })
  await until(() => rt.state.decisions[decision.decisionId].status === 'delivered' && !rt.workView()[owner.id]?.active)
  const accepted = await call(client, 'nodo_task', acceptance)
  assert.equal(accepted.status, 'done')
  assert.deepEqual(accepted.acceptances[0].executionIds, [execution.id])
  assert.deepEqual(accepted.acceptances[0].basis, [sourceId])
  assert.equal(referenceCalls, 0)
  assert.equal(execution.result.text, final)
  await rt.saveStrict()
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(saved.version, 5)
  assert.equal(saved.executions[execution.id].result.text, final)
  for (const value of clients.splice(0)) await value.close()
  for (const binding of bindings.splice(0)) binding.revoke()
  await host.dispose()
  const restarted = boot(host.home)
  try {
    const runtime = await restarted.runtime
    const reader = await connect(runtime, owner)
    assert.equal(runtime.state.executions[execution.id].result.text, final)
    const page = await call(reader, 'nodo_context', { action: 'read', sourceId, offset: 17000, limit: CONTEXT_PAGE_MAX })
    assert.equal(page.text, final.slice(17000, 17000 + CONTEXT_PAGE_MAX))
    await reader.close()
  } finally { await restarted.dispose() }
}))

test('context directory paginates metadata and task/query only narrow existing results', () => withResults(async ({ rt, workspace, owner, other, connect, call }) => {
  const client = await connect(rt, owner)
  for (let index = 0; index < CONTEXT_LIST_MAX + 7; index++) {
    const id = `task-${index}`
    rt.state.tasks[id] = { id, workspaceRef: workspace.id, teamId: 'team', coordinatorSessionId: owner.id, title: `Task ${index}`, status: 'review' }
    rt.state.executions[id] = { id, taskId: id, status: index === 0 ? 'failed' : 'done', reason: 'driver-end', references: [],
      result: { text: 'body'.repeat(10000), preview: `Preview ${index}`, completeness: 'complete', reason: null, length: 40000 } }
  }
  rt.state.tasks.foreign = { id: 'foreign', coordinatorSessionId: other.id, title: 'Foreign' }
  rt.state.executions.foreign = { id: 'foreign', taskId: 'foreign', status: 'done', result: { text: 'private' } }
  const first = await call(client, 'nodo_context', { action: 'list' })
  assert.equal(first.items.length, CONTEXT_LIST_MAX)
  assert.ok(first.items.every(item => item.text === undefined))
  assert.equal(first.items[0].status, 'failed', 'directory status is never inferred from successful prose')
  assert.equal(JSON.stringify(first).includes('bodybody'), false)
  const second = await call(client, 'nodo_context', { action: 'list', cursor: first.nextCursor })
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items].map(item => item.sourceId)).size, CONTEXT_LIST_MAX + 7 + 1, 'pages stay unique across the merged categories')
  const message = second.items.at(-1)
  assert.equal(message.source, 'message', 'directory merges execution results with the session messages')
  assert.match(message.sourceId, /^message:[^:]+:\d+:[0-9a-f]{8}$/)
  assert.equal(message.completeness, 'complete')
  assert.equal(message.sessionId, owner.id)
  assert.ok(first.items.every(item => item.source === 'execution-result'), 'executions fill the first page in category order')
  const selected = await call(client, 'nodo_context', { action: 'list', taskId: 'task-0', query: 'preview 0' })
  assert.equal(selected.items.length, 1)
  assert.equal(selected.items[0].taskId, 'task-0')
  assert.equal((await call(client, 'nodo_context', { action: 'list', query: 'bodybody' })).items.length, 0)
  assert.equal((await client.callTool({ name: 'nodo_context', arguments: { action: 'list', taskId: 'foreign' } })).isError, true)
}))
