import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { connect, createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { install } from '../core/src/lead-channel.js'
import { install as installSecrets } from '../core/src/secrets.js'
import { install as installDrivers } from '../core/src/drivers.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { leadMcp } from '../agent-drivers/dist/lead-mcp.js'
import { createEchoDriver, echoInfo } from './helpers/echo-driver.js'

const rpc = (spec, request, fragmented = false) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
  const client = connect(env.NODO_LEAD_SOCKET)
  client.setEncoding('utf8')
  let buffer = ''
  client.on('connect', () => {
    const token = env.NODO_LEAD_TOKEN ?? (existsSync(env.NODO_LEAD_TOKEN_FILE) ? readFileSync(env.NODO_LEAD_TOKEN_FILE, 'utf8') : '')
    const bytes = Buffer.from(JSON.stringify({ token, ...request }) + '\n')
    if (!fragmented) return client.write(bytes)
    const split = bytes.indexOf(Buffer.from('修')) + 2
    client.write(bytes.subarray(0, split))
    setTimeout(() => client.write(bytes.subarray(split)), 20)
  })
  client.on('data', chunk => { buffer += chunk })
  client.on('end', () => resolve(JSON.parse(buffer)))
  client.on('error', reject)
})
const harness = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-lead-test-')), disposers = []
  const owner = { profile: { lead: true }, session: {} }, calls = []
  const rt = { home, ctx: { effect(fn) { disposers.push(fn()) } }, load: async () => {}, readOnly: () => undefined, warn() {},
    conversationOf: id => id === 'lead' ? owner : { profile: {}, session: {} }, assertSessionWritable() {},
    redactDeepSecrets: text => text.replaceAll('secret-value', '[redacted]'),
    leadDelegations: (id, session) => { calls.push(['delegations', id, session]); return '| 派活 | secret-value |' },
    leadRoles: id => { calls.push(['roles', id]); return '| 角色 |' },
    leadDispatch: { delegate: async (id, args) => { calls.push(['delegate', id, args]); return { session: 'work', role: 'Worker', type: args.type, hard: args.hard, reused: false } },
      interrupt: async (id, args) => ({ ...args, ended: 'interrupted', lastOutput: 'secret-value' }) },
    leadTasks: (id, taskId) => { calls.push(['tasks', id, taskId]); return { taskId } },
    leadTask: (id, args) => { calls.push(['task', id, args]); return args }, ...extra }
  install(rt)
  return { rt, home, owner, calls, dispose() { for (const fn of disposers) fn(); rmSync(home, { recursive: true, force: true }) } }
}

test('nodo_context reuses the lead credential and remains read-only while decision delivery is blocked', async () => {
  const seen = [], h = harness({ executionContext: async (id, args) => { seen.push([id, args]); return { text: 'saved result' } },
    decisionDeliveryReady: async () => { throw new Error('decision not delivered') } })
  try {
    assert.equal(await h.rt.issueLeadMcp('worker'), undefined)
    const binding = await h.rt.issueLeadMcp('lead'), spec = binding.servers[0]
    const args = { action: 'read', sourceId: 'execution:owned:result', offset: 0, limit: 30 }
    const result = await rpc(spec, { name: 'nodo_context', arguments: args })
    assert.equal(result.isError, undefined)
    assert.deepEqual(seen, [['lead', args]])
    assert.equal((await rpc(spec, { name: 'nodo_context', arguments: { ...args, token: 'fake' } })).isError, true)
    assert.equal((await rpc(spec, { name: 'nodo_context', token: 'invalid', arguments: args })).isError, true)
    binding.revoke()
    assert.equal((await rpc(spec, { name: 'nodo_context', arguments: args })).isError, true)
    assert.equal(seen.length, 1)
  } finally { h.dispose() }
})

test('failed token file writes revoke the new token and preserve the old binding', async () => {
  const issued = [], h = harness({ retireValue: token => issued.push(token) })
  try {
    const binding = await h.rt.issueLeadMcp('lead'), spec = binding.servers[0]
    const path = spec.env.find(({ name }) => name === 'NODO_LEAD_TOKEN_FILE').value
    const old = readFileSync(path, 'utf8')
    rmSync(path)
    mkdirSync(path)
    await assert.rejects(h.rt.issueLeadMcp('lead'), { code: 'EISDIR' })
    assert.equal(issued.length, 2)
    rmSync(path, { recursive: true })
    writeFileSync(path, old, { mode: 0o600 })
    assert.equal((await rpc(spec, { name: 'nodo_board', token: issued[1] })).isError, true)
    assert.equal((await rpc(spec, { name: 'nodo_board', token: old })).isError, undefined)
    binding.revoke()
    assert.equal(existsSync(path), false)
    assert.equal((await rpc(spec, { name: 'nodo_board', token: old })).isError, true)
  } finally { h.dispose() }
})

test('lead token files rotate at a fixed private path and running MCP reads each call', async () => {
  const h = harness(), client = new Client({ name: 'rotation-test', version: '1' })
  try {
    const first = await h.rt.issueLeadMcp('lead'), spec = first.servers[0]
    const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
    const path = env.NODO_LEAD_TOKEN_FILE, old = readFileSync(path, 'utf8')
    assert.equal(env.NODO_LEAD_TOKEN, undefined)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    writeFileSync(path, ` \n${old}\t\n`)
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: 'pipe' }))
    assert.equal((await client.callTool({ name: 'nodo_board' })).isError, undefined)
    const second = await h.rt.issueLeadMcp('lead')
    assert.deepEqual(second.servers, first.servers)
    assert.notEqual(readFileSync(path, 'utf8'), old)
    assert.equal((await rpc(spec, { name: 'nodo_board', token: old })).isError, true)
    first.revoke()
    assert.equal(existsSync(path), true)
    assert.equal((await client.callTool({ name: 'nodo_board' })).isError, undefined)
    second.revoke()
    assert.equal(existsSync(path), false)
    assert.equal((await client.callTool({ name: 'nodo_board' })).isError, true)
    await h.rt.issueLeadMcp('lead')
    h.dispose()
    assert.equal(existsSync(path), false)
  } finally { await client.close(); h.dispose() }
})

test('lead MCP authenticates, forwards task tools and returns sanitized MCP errors', async () => {
  const h = harness(), client = new Client({ name: 'test', version: '1' })
  try {
    assert.equal(await h.rt.issueLeadMcp('worker'), undefined)
    const binding = await h.rt.issueLeadMcp('lead'), spec = binding.servers[0]
    const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
    const token = readFileSync(env.NODO_LEAD_TOKEN_FILE, 'utf8')
    assert.equal(spec.name, 'nodo_lead')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(JSON.stringify(spec).includes(token), false)
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: 'pipe' }))
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['nodo_board', 'nodo_delegate', 'nodo_interrupt', 'nodo_task', 'nodo_decision', 'nodo_context'])
    assert.match(tools[0].description, /有界预览.*nodo_context read.*nextOffset/)
    assert.match(tools[5].description, /legacy-reference.*legacy-report.*legacy-unavailable/)
    assert.deepEqual(tools[4].inputSchema.required, ['questions', 'stopExecutionIds'])
    assert.match(tools[4].description, /结束当前轮次/)
    assert.match(tools[4].description, /不另发同一问题的原生问答/)
    assert.match(tools[4].description, /失败时修正参数后重试/)
    assert.match(tools[4].inputSchema.properties.references.description, /只接受本会话已有的引用 id.*附件.*board.*不是文件路径.*没有.*省略/)
    assert.match(tools[4].description, /不按默认或推荐方案继续/)
    assert.match(tools[4].description, /开放问题省略 options 和 recommendation，不造占位选项/)
    for (const tool of [tools[0], tools[1]]) assert.match(tool.description, /派活前先判断是否缺少用户取舍或授权；缺少时.*nodo_decision/)
    const validateDecision = new AjvJsonSchemaValidator().getValidator(tools[4].inputSchema)
    const question = { id: 'scope', question: '需要支持哪些调用方？', whyUser: '当前用户指令没有说明新增支持范围' }
    const decision = { questions: [question], stopExecutionIds: [] }
    assert.equal(validateDecision(decision).valid, true, 'open questions may omit options')
    assert.equal(validateDecision({ ...decision, questions: [{ ...question, options: [] }] }).valid, false)
    assert.equal(validateDecision({ ...decision, questions: [{ ...question, options: [{ id: 'current', label: '现有调用方', consequence: '保持现有范围' }] }] }).valid, true)
    assert.equal(tools[0].annotations.readOnlyHint, true)
    assert.deepEqual(tools[1].inputSchema.required, ['type', 'hard', 'task'])
    assert.match(tools[1].description, /本轮正常结束后发送/)
    assert.match(tools[1].description, /停止或出错则取消/)
    assert.match(tools[1].description, /同一批文件、需要隔离时用 worktree/)
    assert.match(tools[1].description, /有先后顺序要求用 dependsOn，依赖未验收时拒绝派活/)
    assert.match(tools[1].description, /上下文要写全/)
    assert.match(tools[1].description, /Nodo 不会自动合并/)
    assert.equal(tools[1].inputSchema.properties.worktree.type, 'boolean')
    for (const tool of [tools[1], tools[3]]) {
      assert.equal(tool.inputSchema.properties.parentId.type, 'string')
      assert.deepEqual(tool.inputSchema.properties.dependsOn.items, { type: 'string', minLength: 1 })
    }
    assert.deepEqual(tools[2].inputSchema.oneOf, [{ required: ['executionId'] }, { required: ['session'] }])
    assert.deepEqual(tools[3].inputSchema.oneOf, [
      { properties: { action: { const: 'complete' } }, required: ['reason'], oneOf: [
        { required: ['executionIds', 'basis'], not: { required: ['references'] } },
        { required: ['references'], not: { anyOf: [{ required: ['executionIds'] }, { required: ['basis'] }] } },
      ] },
      { properties: { action: { const: 'reopen' } } },
      { properties: { action: { const: 'revise' } }, anyOf: [{ required: ['title'] }, { required: ['brief'] }, { required: ['parentId'] }, { required: ['dependsOn'] }] },
      { properties: { action: { const: 'review' } }, required: ['executionId', 'disposition', 'reason', 'basis'] },
    ])
    assert.deepEqual(tools[3].inputSchema.properties.action.enum, ['complete', 'reopen', 'revise', 'review'])
    assert.deepEqual(tools[3].inputSchema.properties.basis, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'review/complete：可追溯依据，记录适用用户要求、决定、结果段落、代码或验证位置；是 leader 判断，不是系统证明。' })
    assert.deepEqual(tools[0].inputSchema.properties.table.enum, ['roles', 'delegations', 'tasks', 'decisions'])
    const board = await client.callTool({ name: 'nodo_board', arguments: {} })
    assert.match(board.content[0].text, /派活/)
    assert.doesNotMatch(board.content[0].text, /secret-value|角色/)
    assert.deepEqual(h.calls[0], ['delegations', 'lead', undefined])
    await client.callTool({ name: 'nodo_board', arguments: { table: 'roles' } })
    await client.callTool({ name: 'nodo_board', arguments: { session: 'older' } })
    assert.deepEqual(h.calls[2], ['delegations', 'lead', 'older'])
    assert.match(tools[1].inputSchema.properties.title.description, /新开执行会话的名称.*省略时取 task 首行/)
    const args = { type: 'feature', hard: false, task: 'Complete task', title: 'Task title', worktree: true, parentId: 'goal', dependsOn: ['investigation'] }
    const receipt = await client.callTool({ name: 'nodo_delegate', arguments: args })
    assert.deepEqual(JSON.parse(receipt.content[0].text), { session: 'work', role: 'Worker', type: 'feature', hard: false, reused: false })
    assert.deepEqual(h.calls.at(-1), ['delegate', 'lead', args])
    assert.equal((await rpc(spec, { name: 'nodo_delegate', arguments: { ...args, session: 'work' } })).isError, true)
    const continuesArgs = { ...args, continues: 'goal' }
    await client.callTool({ name: 'nodo_delegate', arguments: continuesArgs })
    assert.deepEqual(h.calls.at(-1), ['delegate', 'lead', continuesArgs])
    const stopped = await client.callTool({ name: 'nodo_interrupt', arguments: { session: 'work' } })
    assert.deepEqual(JSON.parse(stopped.content[0].text), { session: 'work', ended: 'interrupted', lastOutput: '[redacted]' })
    assert.equal((await client.callTool({ name: 'nodo_interrupt', arguments: { executionId: 'execution' } })).isError, undefined)
    await client.callTool({ name: 'nodo_board', arguments: { table: 'tasks', taskId: 'task' } })
    assert.deepEqual(h.calls.at(-1), ['tasks', 'lead', 'task'])
    const acceptance = { taskId: 'task', action: 'complete', reason: 'Verified', references: ['ref'] }
    await client.callTool({ name: 'nodo_task', arguments: acceptance })
    assert.deepEqual(h.calls.at(-1), ['task', 'lead', acceptance])
    const archivedAcceptance = { taskId: 'task', action: 'complete', reason: 'Verified', executionIds: ['execution'], basis: ['file and test'] }
    await client.callTool({ name: 'nodo_task', arguments: archivedAcceptance })
    assert.deepEqual(h.calls.at(-1), ['task', 'lead', archivedAcceptance])
    assert.deepEqual(tools[3].inputSchema.properties.executionIds, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'complete：本任务已归档结果的执行 id，非空。' })
    const revision = { taskId: 'task', action: 'revise', title: 'Renamed', brief: 'Revised', parentId: '', dependsOn: [] }
    await client.callTool({ name: 'nodo_task', arguments: revision })
    assert.deepEqual(h.calls.at(-1), ['task', 'lead', revision])
    for (const request of [
      { name: 'unknown' }, { name: 'nodo_board', arguments: { table: 'bad' } },
      { name: 'nodo_board', arguments: { leadSession: 'forged' } }, { name: 'nodo_interrupt', arguments: {} },
      { name: 'nodo_board', arguments: { session: 3 } }, { name: 'nodo_board', token: 'forged' },
      { name: 'nodo_board', arguments: { table: 'roles', session: 'work' } },
      { name: 'nodo_interrupt', arguments: { session: 'work', executionId: 'execution' } },
      { name: 'nodo_board', arguments: { table: 'roles', taskId: 'task' } },
      { name: 'nodo_task', arguments: { taskId: 'task', action: 'revise', title: 'T', status: 'done' } },
    ]) assert.equal((await rpc(spec, request)).isError, true)
    for (const name of ['nodo_delegate', 'nodo_task']) for (const changes of [
      { parentId: 2 }, { parentId: null }, { parentId: ' ' }, { dependsOn: 'task' }, { dependsOn: null },
      { dependsOn: [2] }, { dependsOn: [''] }, { dependsOn: [' '] }, { dependsOn: ['ok', null] },
    ]) {
      const before = h.calls.length
      const response = await rpc(spec, { name, arguments: { ...(name === 'nodo_delegate' ? args : revision), ...changes } })
      assert.equal(response.isError, true)
      assert.equal(h.calls.length, before, 'invalid relationship types never reach the internal handler')
    }
    const emptyParent = await rpc(spec, { name: 'nodo_delegate', arguments: { ...args, parentId: '' } })
    assert.equal(emptyParent.isError, true)
    assert.equal(emptyParent.content[0].text, 'parentId 必须是非空字符串')
    const badRevisionParent = await rpc(spec, { name: 'nodo_task', arguments: { ...revision, parentId: 2 } })
    assert.equal(badRevisionParent.isError, true)
    assert.equal(badRevisionParent.content[0].text, 'parentId 必须是非空字符串；revise 可用空字符串清空')
    h.rt.leadDispatch.delegate = async () => { throw new Error('预算已用尽') }
    assert.match((await client.callTool({ name: 'nodo_delegate', arguments: args })).content[0].text, /预算/)
    h.rt.leadRoles = () => token
    assert.equal(JSON.stringify(await client.callTool({ name: 'nodo_board', arguments: { table: 'roles' } })).includes(token), false)
    h.owner.profile.lead = false
    assert.equal((await rpc(spec, { name: 'nodo_board' })).isError, true)
    h.owner.profile.lead = true
    binding.revoke()
    assert.equal((await rpc(spec, { name: 'nodo_board' })).isError, true)
    assert.equal(statSync(dirname(env.NODO_LEAD_SOCKET)).mode & 0o777, 0o700)
    assert.equal(statSync(env.NODO_LEAD_SOCKET).mode & 0o777, 0o600)
    await client.close()
    h.dispose()
    assert.equal(existsSync(env.NODO_LEAD_SOCKET), false)
  } finally { await client.close(); h.dispose() }
})

test('read-only instances degrade gracefully and retry; long paths use a private short directory', async () => {
  const reader = harness({ readOnly: () => 'read only' })
  try {
    assert.equal(await reader.rt.issueLeadMcp('lead'), undefined)
    assert.equal(existsSync(join(reader.home, 'runtime')), false)
    reader.rt.readOnly = () => undefined
    assert.ok(await reader.rt.issueLeadMcp('lead'))
  }
  finally { reader.dispose() }
  const h = harness()
  try {
    h.rt.home = join(h.home, 'x'.repeat(120))
    const { servers } = await h.rt.issueLeadMcp('lead')
    const path = servers[0].env.find(item => item.name === 'NODO_LEAD_SOCKET').value
    assert.ok(Buffer.byteLength(path) < 104)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    h.dispose()
    assert.equal(existsSync(dirname(path)), false)
  } finally { h.dispose() }
})

test('Chinese requests and responses survive splits inside UTF-8 characters', async () => {
  const h = harness(), task = '修复'.repeat(4000)
  const client = new Client({ name: 'utf8-test', version: '1' })
  let server
  try {
    const { servers: [spec] } = await h.rt.issueLeadMcp('lead')
    h.rt.leadDispatch.delegate = async (id, args) => {
      assert.equal(args.task, task)
      return args.task
    }
    const result = await rpc(spec, { name: 'nodo_delegate', arguments: { type: 'feature', hard: false, task } }, true)
    assert.equal(result.content[0].text, task)
    const path = join(h.home, 'fragmented.sock')
    server = createServer(socket => {
      socket.once('data', () => {
        const bytes = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: task }] }) + '\n')
        const split = bytes.indexOf(Buffer.from('修')) + 2
        socket.write(bytes.subarray(0, split))
        setTimeout(() => socket.end(bytes.subarray(split)), 20)
      })
    })
    await new Promise(resolve => server.listen(path, resolve))
    const [responseSpec] = leadMcp(path, 'fixture-credential')
    await client.connect(new StdioClientTransport({ command: responseSpec.command, args: responseSpec.args, env: Object.fromEntries(responseSpec.env.map(({ name, value }) => [name, value])), stderr: 'pipe' }))
    assert.equal((await client.callTool({ name: 'nodo_board', arguments: {} })).content[0].text, task)
  } finally { await client.close(); server?.close(); h.dispose() }
})

test('oversized channel requests return isError; disconnected MCP channels run fail', async () => {
  const h = harness(), client = new Client({ name: 'failure-test', version: '1' })
  try {
    const { servers: [spec] } = await h.rt.issueLeadMcp('lead')
    const result = await rpc(spec, { name: 'nodo_delegate', arguments: { task: 'x'.repeat(1024 * 1024) } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /1MB/)
    assert.equal(h.calls.length, 0)
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: Object.fromEntries(spec.env.map(({ name, value }) => [name, value])), stderr: 'pipe' }))
    h.dispose()
    const failed = await client.callTool({ name: 'nodo_board', arguments: {} })
    assert.equal(failed.isError, true)
    assert.match(failed.content[0].text, /通道不可用/)
  } finally { await client.close(); h.dispose() }
})

test('lead drivers start without MCP when read-only or startup fails, then rebuild after recovery', async () => {
  registerEngine('lead-channel-fixture', { info: echoInfo, validate: raw => raw,
    create: options => Object.assign(createEchoDriver(options), { leadMcpServers: options.leadMcpServers }) })
  for (const cause of ['read-only', 'filesystem']) {
    const warnings = [], h = harness({ warn: message => warnings.push(message) })
    h.rt.ctx.effect = () => {}
    Object.assign(h.rt, { renderIdentity: () => 'Lead', secretEnv: () => ({}), secretStamp: () => '', state: { profiles: {} } })
    installDrivers(h.rt)
    if (cause === 'read-only') h.rt.readOnly = () => 'read only'
    else writeFileSync(join(h.home, 'runtime'), 'blocked')
    const profile = { id: 'lead', lead: true, engine: 'lead-channel-fixture' }
    try {
      const first = await h.rt.ensureDriver(profile)
      assert.equal(first.leadMcpServers, undefined)
      assert.equal(await h.rt.ensureDriver(profile), first)
      assert.equal(warnings.length, 2)
      if (cause === 'read-only') assert.equal(existsSync(join(h.home, 'runtime')), false)
      h.rt.readOnly = () => undefined
      if (cause === 'filesystem') rmSync(join(h.home, 'runtime'))
      const recovered = await h.rt.ensureDriver(profile)
      assert.notEqual(recovered, first)
      assert.equal(recovered.leadMcpServers[0].name, 'nodo_lead')
      assert.equal(await h.rt.ensureDriver(profile), recovered)
      h.rt.releaseDriver('lead')
    } finally { h.dispose() }
    await assert.rejects(h.rt.issueLeadMcp('lead'), /通道已关闭/)
  }
})

test('issued lead tokens enter the host redactor and stay redacted after revoke', async () => {
  const h = harness()
  try {
    installSecrets(h.rt)
    await h.rt.issueLeadMcp('worker')
    const binding = await h.rt.issueLeadMcp('lead')
    const token = readFileSync(binding.servers[0].env.find(({ name }) => name === 'NODO_LEAD_TOKEN_FILE').value, 'utf8')
    assert.match(h.rt.redactDeepSecrets(`$ env\nNODO_LEAD_TOKEN=${token}`), /\[secret:NODO_LEAD_TOKEN\]/)
    assert.equal(h.rt.redactDeepSecrets(`NODO_LEAD_TOKEN=${token}`).includes(token), false)
    binding.revoke()
    assert.equal(h.rt.redactDeepSecrets(`NODO_LEAD_TOKEN=${token}`).includes(token), false, 'a revoked token stays redacted')
  } finally { h.dispose() }
})

test('a 1:1 chat session of a lead card neither mounts the channel nor accepts its credentials', async () => {
  const h = harness()
  try {
    h.owner.session.leadMode = false
    assert.equal(await h.rt.issueLeadMcp('lead'), undefined)
    h.owner.session.leadMode = true
    const { servers: [spec] } = await h.rt.issueLeadMcp('lead')
    h.owner.session.leadMode = false
    assert.equal((await rpc(spec, { name: 'nodo_board' })).isError, true, 'a token issued for lead mode dies with the chat downgrade')
    delete h.owner.session.leadMode
    assert.ok(await h.rt.issueLeadMcp('lead'), 'a session saved before the flag keeps lead mode')
  } finally { h.dispose() }
})
