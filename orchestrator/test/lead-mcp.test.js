import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { connect, createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
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
    const bytes = Buffer.from(JSON.stringify({ token: env.NODO_LEAD_TOKEN, ...request }) + '\n')
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
      interrupt: async (id, session) => ({ session, ended: 'interrupted', lastOutput: 'secret-value' }) }, ...extra }
  install(rt)
  return { rt, home, owner, calls, dispose() { for (const fn of disposers) fn(); rmSync(home, { recursive: true, force: true }) } }
}

test('lead MCP authenticates, forwards three tools and returns sanitized MCP errors', async () => {
  const h = harness(), client = new Client({ name: 'test', version: '1' })
  try {
    assert.equal(await h.rt.issueLeadMcp('worker'), undefined)
    const binding = await h.rt.issueLeadMcp('lead'), spec = binding.servers[0]
    const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]))
    assert.equal(spec.name, 'nodo_lead')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(spec.args.join('').includes(env.NODO_LEAD_TOKEN), false)
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: 'pipe' }))
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['nodo_board', 'nodo_delegate', 'nodo_interrupt'])
    assert.equal(tools[0].annotations.readOnlyHint, true)
    assert.deepEqual(tools[1].inputSchema.required, ['type', 'hard', 'task'])
    assert.match(tools[1].description, /本轮正常结束后发送/)
    assert.match(tools[1].description, /停止或出错则取消/)
    assert.deepEqual(tools[2].inputSchema.required, ['session'])
    const board = await client.callTool({ name: 'nodo_board', arguments: {} })
    assert.match(board.content[0].text, /派活/)
    assert.doesNotMatch(board.content[0].text, /secret-value|角色/)
    assert.deepEqual(h.calls[0], ['delegations', 'lead', undefined])
    await client.callTool({ name: 'nodo_board', arguments: { table: 'roles' } })
    await client.callTool({ name: 'nodo_board', arguments: { session: 'older' } })
    assert.deepEqual(h.calls[2], ['delegations', 'lead', 'older'])
    const args = { type: 'feature', hard: false, task: 'Complete task' }
    const receipt = await client.callTool({ name: 'nodo_delegate', arguments: args })
    assert.deepEqual(JSON.parse(receipt.content[0].text), { session: 'work', role: 'Worker', type: 'feature', hard: false, reused: false })
    const stopped = await client.callTool({ name: 'nodo_interrupt', arguments: { session: 'work' } })
    assert.deepEqual(JSON.parse(stopped.content[0].text), { session: 'work', ended: 'interrupted', lastOutput: '[redacted]' })
    for (const request of [
      { name: 'unknown' }, { name: 'nodo_board', arguments: { table: 'bad' } },
      { name: 'nodo_board', arguments: { leadSession: 'forged' } }, { name: 'nodo_interrupt', arguments: {} },
      { name: 'nodo_board', arguments: { session: 3 } }, { name: 'nodo_board', token: 'forged' },
      { name: 'nodo_board', arguments: { table: 'roles', session: 'work' } },
    ]) assert.equal((await rpc(spec, request)).isError, true)
    h.rt.leadDispatch.delegate = async () => { throw new Error('预算已用尽') }
    assert.match((await client.callTool({ name: 'nodo_delegate', arguments: args })).content[0].text, /预算/)
    h.rt.leadRoles = () => env.NODO_LEAD_TOKEN
    assert.equal(JSON.stringify(await client.callTool({ name: 'nodo_board', arguments: { table: 'roles' } })).includes(env.NODO_LEAD_TOKEN), false)
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
    const token = binding.servers[0].env.find(({ name }) => name === 'NODO_LEAD_TOKEN').value
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
