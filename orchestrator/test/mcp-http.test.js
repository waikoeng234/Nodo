import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { install as installMcp } from '../src/host/mcp.js'
import { install as installLead } from '../core/src/lead-channel.js'
import { roleServer } from '../agent-drivers/dist/role-mcp.js'
import { LEAD_TOOLS } from '../agent-drivers/dist/lead-mcp.js'
import { claudeArgs, leadMcpEnv } from '../agent-drivers/dist/claude/native.js'

const host = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-mcp-http-test-')), disposers = [], retired = [], calls = []
  const rt = { home, ctx: { effect(fn) { disposers.push(fn()) } }, load: async () => {}, readOnly: () => undefined, warn() {},
    retireValue: value => retired.push(value),
    conversationOf: id => id === 'lead' ? { profile: { lead: true }, session: {} } : { profile: {}, session: {} }, assertSessionWritable() {},
    redactDeepSecrets: text => text.replaceAll('secret-value', '[redacted]'),
    leadDelegations: (id, session) => { calls.push(['delegations', id, session]); return '| 派活 | secret-value |' },
    leadRoles: () => '| 角色 |', leadDispatch: {}, ...extra }
  installMcp(rt)
  installLead(rt)
  return { rt, home, retired, calls, dispose() { for (const fn of disposers.splice(0)) fn(); rmSync(home, { recursive: true, force: true }) } }
}
const connect = async ({ url, token }) => {
  const client = new Client({ name: 'mcp-http-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}
const raw = (url, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { agent: false, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, response => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { text += chunk })
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }))
  })
  request.on('error', reject)
  request.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
})
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }

test('lead tools reach the host over loopback HTTP with redaction, and revoke ends access', async () => {
  const h = host()
  let client
  try {
    const binding = await h.rt.issueLeadMcp('lead'), [spec] = binding.servers
    assert.deepEqual(Object.keys(spec).sort(), ['name', 'token', 'url'])
    assert.match(spec.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(join(h.home, 'runtime')), false, 'no socket or token file is created')
    assert.equal(h.retired.length, 2, 'both the mount token and the lead token are redacted')
    assert.ok(h.retired.includes(spec.token))
    client = await connect(spec)
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), LEAD_TOOLS)
    const result = await client.callTool({ name: 'nodo_board' })
    assert.deepEqual(result.content, [{ type: 'text', text: '| 派活 | [redacted] |' }])
    assert.deepEqual(h.calls, [['delegations', 'lead', undefined]])
    binding.revoke()
    assert.equal((await raw(spec.url, { headers: { authorization: `Bearer ${spec.token}` }, body: initialize })).status, 401)
  } finally { await client?.close(); h.dispose() }
})

test('lead falls back to the stdio channel when the HTTP endpoint is unavailable', async () => {
  const h = host()
  h.rt.serveMcp = async () => { throw new Error('listen EPERM') }
  try {
    const binding = await h.rt.issueLeadMcp('lead'), [spec] = binding.servers
    assert.equal(spec.url, undefined)
    assert.ok(spec.env.some(({ name }) => name === 'NODO_LEAD_TOKEN_FILE'))
    binding.revoke()
  } finally { h.dispose() }
})

test('the endpoint rejects foreign hosts, wrong paths, wrong tokens, oversize bodies and cross-mount sessions', async () => {
  const h = host()
  try {
    const a = await h.rt.serveMcp(() => roleServer('Role A')), b = await h.rt.serveMcp(() => roleServer('Role B'))
    assert.equal(a.url, b.url, 'every mount shares one listener')
    const auth = token => ({ authorization: `Bearer ${token}` })
    const { port } = new URL(a.url)
    assert.equal((await raw(a.url, { headers: { ...auth(a.token), host: `evil.example:${port}` }, body: initialize })).status, 403)
    assert.equal((await raw(a.url.replace('/mcp', '/other'), { headers: auth(a.token), body: initialize })).status, 404)
    assert.equal((await raw(a.url, { body: initialize })).status, 401)
    assert.equal((await raw(a.url, { headers: auth('0'.repeat(64)), body: initialize })).status, 401)
    assert.equal((await raw(a.url, { headers: auth(a.token), body: 'x'.repeat(1024 * 1024 + 1) })).status, 413)
    assert.equal((await raw(a.url, { headers: auth(a.token), body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).status, 400)
    const opened = await raw(a.url, { headers: auth(a.token), body: initialize })
    assert.equal(opened.status, 200)
    const session = { 'mcp-session-id': opened.headers['mcp-session-id'] }
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    assert.equal((await raw(a.url, { headers: { ...auth(b.token), ...session }, body: list })).status, 404, 'a session belongs to the mount that opened it')
    assert.equal((await raw(a.url, { headers: { ...auth(a.token), ...session }, body: list })).status, 200)
    const other = host()
    try {
      const c = await other.rt.serveMcp(() => roleServer('Role C'))
      assert.notEqual(c.url, a.url)
      assert.equal((await raw(c.url, { headers: auth(a.token), body: initialize })).status, 401, 'another host never serves this host\'s tokens')
    } finally { other.dispose() }
    a.close()
    assert.equal((await raw(a.url, { headers: { ...auth(a.token), ...session }, body: list })).status, 401)
    h.dispose()
    await assert.rejects(raw(b.url, { headers: auth(b.token), body: initialize }), { code: 'ECONNREFUSED' })
    await assert.rejects(h.rt.serveMcp(() => roleServer('Role C')), /closed/)
  } finally { h.dispose() }
})

test('role MCP over HTTP serves instructions, get_role and the tool catalog receipt', async () => {
  const h = host(), instructions = 'Coder\n{{literal}}', readyFile = join(h.home, 'catalog.json')
  let client
  try {
    const mount = await h.rt.serveMcp(() => roleServer(instructions, { toolIdentity: true, readyFile }))
    client = await connect(mount)
    assert.equal(client.getInstructions(), instructions)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name), ['get_role'])
    assert.equal(JSON.parse(readFileSync(readyFile, 'utf8')).version, createHash('sha256').update(instructions).digest('hex'))
    assert.deepEqual((await client.callTool({ name: 'get_role', arguments: {} })).content, [{ type: 'text', text: instructions }])
  } finally { await client?.close(); h.dispose() }
})

test('Claude mounts an HTTP lead with the token only in the child env', () => {
  const servers = [{ name: 'nodo_lead', url: 'http://127.0.0.1:4100/mcp', token: 'http-token-secret' }]
  const args = claudeArgs({ leadMcpServers: servers })
  assert.equal(JSON.stringify(args).includes('http-token-secret'), false)
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
  assert.deepEqual(config.mcpServers.nodo_lead, { type: 'http', url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer ${NODO_LEAD_TOKEN}' } })
  assert.deepEqual(leadMcpEnv(servers), { NODO_LEAD_TOKEN: 'http-token-secret' })
  assert.ok(LEAD_TOOLS.every(tool => args.join(' ').includes(`mcp__nodo_lead__${tool}`)))
})
