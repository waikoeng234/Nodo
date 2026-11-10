import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withHost, until } from './helpers/host.js'
import { routeUserTask } from './helpers/route.js'

for (const { engine, project, unsupported } of [
  ...['claude', 'codex', 'zcode'].map(engine => ({ engine })),
  { engine: 'zcode', project: 'zcode.json' }, { engine: 'zcode', project: '.zcode/config.json' }, { engine: 'zcode', unsupported: true },
]) test(`${engine} fake CLI mounts worker tools and delivers the latest persisted report card${project ? ` with project ${project}` : unsupported ? ' with unsupported MCP fallback' : ''}`, () => withHost(async host => {
  const rt = await host.runtime
  const bin = join(host.home, engine), leadBin = join(host.home, 'lead-claude')
  copyFileSync(new URL(`./fixtures/${engine}-cli.cjs`, import.meta.url), bin)
  copyFileSync(new URL('./fixtures/claude-cli.cjs', import.meta.url), leadBin)
  chmodSync(bin, 0o755); chmodSync(leadBin, 0o755)
  rt.secretEnv = () => ({ HOME: host.home, ...(unsupported ? { FIXTURE_NO_ROLE_MCP: '1' } : {}) })
  if (project) {
    mkdirSync(join(host.home, '.zcode/cli'), { recursive: true })
    writeFileSync(join(host.home, '.zcode/cli/config.json'), JSON.stringify({ mcp: { servers: { global: { type: 'stdio', command: process.execPath, args: ['global-tool.js'] } } } }))
    writeFileSync(join(host.home, project), JSON.stringify({ mcp: { servers: { project: { type: 'stdio', command: process.execPath, args: ['project-tool.js'] } } } }))
  }
  const workspace = await host.api('workspace-create', { name: 'Mount', cwd: host.home })
  const worker = await host.api('profile-create', { name: 'Worker', engine, engineOptions: { bin } })
  const lead = await host.api('profile-create', { name: 'Leader', engine: 'claude', lead: true, engineOptions: { bin: leadBin } })
  await rt.updateTeams([{ id: 'team', name: 'Team', lead: lead.id, members: [worker.id], types: [{ id: 'feature', name: 'Feature', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const issue = rt.issueWorkerMcp
  let latest, mounted
  rt.issueWorkerMcp = async id => {
    const binding = await issue(id)
    if (!binding) return
    mounted = binding.servers[0]
    if (unsupported) return binding
    const client = new Client({ name: 'worker-mount-fixture', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(mounted.url), { requestInit: { headers: { authorization: `Bearer ${mounted.token}` } } }))
      for (const summary of ['First report', 'Latest report']) {
        const result = await client.callTool({ name: 'nodo_report', arguments: { outcome: 'done', summary,
          changed: [], verified: [{ result: 'pass' }], issues: [], reviewFlags: { crossModule: false, publicInterface: false, dataFormat: false, security: false } } })
        assert.equal(result.isError, undefined, result.content[0].text)
        latest = JSON.parse(result.content[0].text)
      }
    } finally { await client.close() }
    return binding
  }
  const requirement = unsupported ? 'Implement the original\n完成后用 nodo_report 回报。' : 'Implement the original'
  const receipt = await routeUserTask(rt, owner.id, { type: 'feature', hard: false, task: requirement })
  await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'done' }) })
  const execution = rt.state.executions[receipt.executionId]
  await until(() => execution.reports?.length)
  assert.equal(execution.status, 'done')
  if (unsupported) {
    assert.equal(execution.reportData.source, 'final-text')
    assert.equal(execution.reportData.structured, false)
    const turns = readFileSync(join(host.home, 'zcode-turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(turns[0].content.includes(`# 本轮要求（用户原话，逐字，唯一需求来源）\n${requirement}\n\n`), 'fallback must preserve the user original verbatim')
    assert.match(turns[0].content, /# 回报方式\n简短总结结果、改动、验证和未决项。/)
    assert.doesNotMatch(turns[0].content, /nodo_report 工具/)
    const requests = readFileSync(join(host.home, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(requests.some(item => item.params.mcpServers.some(server => server.name === 'nodo_worker')))
    await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
    return
  }
  assert.equal(execution.reportData.id, latest.reportId)
  assert.equal(execution.reportData.summary, 'Latest report')
  assert.equal(execution.reportHistory[0].summary, 'First report')
  const card = rt.transcriptOf(owner.id).find(line => line.origin?.executionId === execution.id && line.origin?.kind === 'report')
  assert.match(card.text, /\[回报\] Worker · Implement the original · 阶段 implement（第 1 轮）/)
  assert.match(card.text, /结论：done —— Latest report/)
  assert.ok(card.text.includes(`报告：report:${latest.reportId}`))
  assert.ok(card.text.includes(`证据：evidence:${execution.id}`))
  assert.doesNotMatch(card.text, /First report/)
  assert.equal(execution.reports[0].summary, 'Latest report')
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[execution.id]
  assert.deepEqual(saved.reportData, execution.reportData)
  assert.deepEqual(saved.evidence, execution.evidence)
  if (engine === 'claude') {
    const requests = readFileSync(join(host.home, 'claude-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const spawn = requests.find(item => item.spawn && JSON.parse(item.mcpConfig ?? '{}').mcpServers?.nodo_worker)
    assert.deepEqual(spawn.allowedTools, ['mcp__nodo_worker__nodo_report', 'mcp__nodo_worker__nodo_context'])
    assert.equal(spawn.spawn.includes('--tools'), false, 'worker keeps its execution tools')
    assert.equal(spawn.spawn.includes('--strict-mcp-config'), false, 'worker stays outside the leader lockdown')
    const config = JSON.parse(spawn.mcpConfig).mcpServers.nodo_worker
    assert.equal(config.headers.Authorization, 'Bearer ${NODO_LEAD_TOKEN}')
    assert.ok(spawn.leadTokenEnv === mounted.token, 'Claude must receive the mounted HTTP credential in its environment')
    const configured = new Client({ name: 'claude-config-fixture', version: '1' })
    try {
      await configured.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: {
        authorization: config.headers.Authorization.replace('${NODO_LEAD_TOKEN}', spawn.leadTokenEnv),
      } } }))
      assert.deepEqual((await configured.listTools()).tools.map(item => item.name), ['nodo_report', 'nodo_context'])
    } finally { await configured.close() }
  } else if (engine === 'codex') {
    const requests = readFileSync(join(host.home, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const thread = requests.find(item => item.method === 'thread/start')
    assert.deepEqual(Object.keys(thread.params.config), ['mcp_servers.nodo_worker'], 'a worker must never receive the leader lockdown keys')
    assert.equal(thread.params.sandbox, 'workspace-write', 'a worker keeps its tier sandbox')
    const config = thread.params.config['mcp_servers.nodo_worker']
    assert.deepEqual(config.enabled_tools, ['nodo_report', 'nodo_context'])
    assert.deepEqual(Object.keys(config.tools), ['nodo_report', 'nodo_context'])
  } else {
    const requests = readFileSync(join(host.home, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(requests.find(item => item.params.mcpServers.some(server => server.name === 'nodo_worker' && server.type === 'http' && server.isolation === 'session')))
    if (project) assert.deepEqual(requests[0].params.mcpServers.filter(server => server.name !== 'nodo_role').map(server => server.name).sort(), ['global', 'nodo_worker', 'project'])
  }
  await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
}))
