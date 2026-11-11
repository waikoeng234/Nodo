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
    leadRoute: async (id, args) => { calls.push(['route', id, args]); return { ok: true, taskId: 'task', executionId: 'execution', role: 'Worker', type: args.type, hard: args.hard } },
    leadCards: id => { calls.push(['cards', id]); return [] },
    leadTasks: (id, taskId) => { calls.push(['tasks', id, taskId]); return { taskId } }, ...extra }
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

test('lead MCP authenticates, exposes exactly three schemas and forwards route', async () => {
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
    assert.deepEqual(tools.map(t => t.name), ['nodo_board', 'nodo_context', 'nodo_route'])
    assert.deepEqual(tools.map(({ name, inputSchema }) => ({ name, inputSchema })), JSON.parse(readFileSync(new URL('./fixtures/lead-tools.json', import.meta.url))))
    assert.equal(tools[0].annotations.readOnlyHint, true)
    assert.equal(tools[1].annotations.readOnlyHint, true)
    const validate = new AjvJsonSchemaValidator().getValidator(tools[2].inputSchema)
    const args = { action: 'new', type: 'feature', hard: false, scope: { quote: 'Complete task' }, title: 'Task title', worktree: true, parentId: 'goal', dependsOn: ['investigation'] }
    assert.equal(validate(args).valid, true)
    for (const changes of [{ task: 'body' }, { context: {} }, { scope: {} }, { scope: { quote: 'x', note: 'x' } }, { continues: 'source' }]) assert.equal(validate({ ...args, ...changes }).valid, false)
    for (const invalid of [
      { action: 'attach', taskId: 'task', scope: { note: 'x' }, type: 'feature' },
      { action: 'stop', executionIds: ['e'], taskIds: ['t'] },
      { action: 'ask', questions: [], stopExecutionIds: [] },
      { action: 'new', type: 'feature', hard: false, scope: { note: 'x\ny' } },
    ]) assert.equal(validate(invalid).valid, false)
    for (const valid of [{ action: 'attach', taskId: 'task', scope: { note: 'x' } }, { action: 'stop', executionIds: ['e'] },
      { action: 'ask', questions: [{ id: 'q', question: 'Which?', whyUser: 'Preference' }], stopExecutionIds: [] }]) assert.equal(validate(valid).valid, true)
    const board = await client.callTool({ name: 'nodo_board', arguments: {} })
    assert.match(board.content[0].text, /派活/)
    assert.doesNotMatch(board.content[0].text, /secret-value/)
    await client.callTool({ name: 'nodo_board', arguments: { table: 'cards' } })
    assert.deepEqual(h.calls.at(-1), ['cards', 'lead'])
    await client.callTool({ name: 'nodo_route', arguments: args })
    assert.deepEqual(h.calls.at(-1), ['route', 'lead', args])
    for (const request of [
      { name: 'unknown' }, ...['delegate', 'task', 'interrupt', 'decision', 'review'].map(name => ({ name: `nodo_${name}` })),
      { name: 'nodo_board', arguments: { table: 'bad' } }, { name: 'nodo_board', arguments: { leadSession: 'forged' } },
      { name: 'nodo_board', arguments: { session: 3 } }, { name: 'nodo_board', token: 'forged' },
      { name: 'nodo_board', arguments: { table: 'roles', session: 'work' } },
      { name: 'nodo_board', arguments: { table: 'roles', taskId: 'task' } },
      { name: 'nodo_board', arguments: { table: 'cards', decisionId: 'd' } },
    ]) assert.equal((await rpc(spec, request)).isError, true)
    h.rt.leadRoute = async () => { throw Object.assign(new Error('预算已用尽'), { code: 'orch/busy' }) }
    const error = await client.callTool({ name: 'nodo_route', arguments: args })
    assert.deepEqual(JSON.parse(error.content[0].text), { ok: false, code: 'orch/busy', message: '预算已用尽', retry: 'wait' })
    for (const [code, retry] of Object.entries({ 'orch/no-trigger': 'ask-user', 'orch/scope-missing': 'quote-or-note',
      'orch/scope-not-quote': 'quote-or-note', 'orch/title-empty': 'quote-or-note', 'orch/scope-note-too-long': 'shorten',
      'orch/unknown-type': 'pick-type', 'orch/no-holder': undefined,
      'orch/decision-pending': 'wait', 'orch/source-busy': 'wait', 'orch/trigger-full': 'close-tasks',
      'orch/task-stalled': 'new-task', 'orch/frozen': 'new-task', 'orch/worktree-mismatch': 'drop-worktree' })) {
      h.rt.leadRoute = async () => { throw Object.assign(new Error('Refused'), { code }) }
      const result = await client.callTool({ name: 'nodo_route', arguments: args })
      assert.equal(result.isError, true)
      const body = JSON.parse(result.content[0].text)
      assert.equal(body.ok, false); assert.equal(body.code, code); assert.equal(body.retry, retry)
    }
    h.rt.leadRoles = () => token
    assert.equal(JSON.stringify(await client.callTool({ name: 'nodo_board', arguments: { table: 'roles' } })).includes(token), false)
    h.owner.profile.lead = false
    assert.equal((await rpc(spec, { name: 'nodo_board' })).isError, true)
    h.owner.profile.lead = true
    binding.revoke()
    assert.equal((await rpc(spec, { name: 'nodo_board' })).isError, true)
    assert.equal(statSync(dirname(env.NODO_LEAD_SOCKET)).mode & 0o777, 0o700)
    assert.equal(statSync(env.NODO_LEAD_SOCKET).mode & 0o777, 0o600)
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
    h.rt.leadRoute = async (id, args) => {
      assert.equal(args.scope.quote, task)
      return args.scope.quote
    }
    const result = await rpc(spec, { name: 'nodo_route', arguments: { action: 'new', type: 'feature', hard: false, scope: { quote: task } } }, true)
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
    const result = await rpc(spec, { name: 'nodo_route', arguments: { scope: { quote: 'x'.repeat(1024 * 1024) } } })
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
