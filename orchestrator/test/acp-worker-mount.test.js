import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriver } from '../agent-drivers/dist/index.js'
import { withHost, until } from './helpers/host.js'
import { routeUserTask } from './helpers/route.js'

const helper = fileURLToPath(new URL('./fixtures/acp-worker.cjs', import.meta.url))
const mounted = transport => transport === 'http' || transport === 'stdio'

for (const engine of ['dsh', 'opencode', 'codebuddy']) {
  for (const transport of ['http', 'stdio', 'unsupported-http', 'unknown-field']) {
    test(`${engine} worker ${transport} mount controls reporting through the host`, () => withHost(async host => {
      const rt = await host.runtime
      const bin = join(host.home, engine), leadBin = join(host.home, 'lead-claude')
      copyFileSync(new URL(`./fixtures/${engine}-cli.cjs`, import.meta.url), bin)
      copyFileSync(new URL('./fixtures/claude-cli.cjs', import.meta.url), leadBin)
      chmodSync(bin, 0o755); chmodSync(leadBin, 0o755)
      rt.secretEnv = () => ({ HOME: host.home, ACP_WORKER_HELPER: helper,
        ...(transport === 'unsupported-http' ? { ACP_FIXTURE_NO_HTTP: '1' } : {}),
        ...(transport === 'unknown-field' ? { ACP_FIXTURE_NO_MCP_FIELD: '1' } : {}) })
      if (transport === 'stdio') rt.serveMcp = undefined
      const workspace = await host.api('workspace-create', { name: 'ACP worker', cwd: host.home })
      const worker = await host.api('profile-create', { name: 'Worker', engine, engineOptions: { bin } })
      const leader = await host.api('profile-create', { name: 'Leader', engine: 'claude', lead: true, engineOptions: { bin: leadBin } })
      await rt.updateTeams([{ id: 'team', name: 'Team', lead: leader.id, members: [worker.id],
        types: [{ id: 'feature', name: 'Feature', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }])
      const owner = await host.api('session-create', { profile: leader.id, workspace: workspace.id, lazy: true })
      const original = 'Implement the original\n完成后用 nodo_report 回报。'
      const receipt = await routeUserTask(rt, owner.id, { type: 'feature', hard: false, task: original })
      await rt.followLead(owner.id, { mode: 'turn', completion: Promise.resolve({ reason: 'done' }) })
      const execution = rt.state.executions[receipt.executionId]
      await until(() => execution.reports?.length)
      assert.equal(execution.status, 'done', execution.result?.text)
      const requests = readFileSync(join(host.home, `${engine}-requests.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
      const attach = requests.filter(item => item.method === 'session/new')
      const prompt = requests.find(item => item.method === 'session/prompt').text
      assert.ok(prompt.includes(`# 本轮要求（用户原话，逐字，唯一需求来源）\n${original}\n\n`))
      assert.equal(rt.driverOf(execution.sessionId).workerMcpMounted, mounted(transport))
      if (!mounted(transport)) {
        assert.ok(prompt.endsWith(rt.workerReportMethod({ stage: 'implement', degraded: true })))
        assert.equal(execution.reportData.source, 'final-text')
        assert.equal(execution.reportData.structured, false)
        if (transport === 'unsupported-http') assert.deepEqual(attach[0].mcpServers, [])
        else {
          assert.ok(attach[0].mcpServers.some(server => server.name === 'nodo_worker'))
          assert.equal('mcpServers' in attach[1], false, 'the fallback retry drops the field instead of sending it empty')
        }
      } else {
        const mountedWorker = attach[0].mcpServers.find(server => server.name === 'nodo_worker')
        assert.equal(mountedWorker.type, transport === 'http' ? 'http' : undefined)
        const report = requests.find(item => item.method === 'worker/report')
        assert.deepEqual(report.tools, ['nodo_report', 'nodo_context'])
        assert.equal(execution.reportData.source, 'nodo_report')
        assert.equal(execution.reportData.id, report.reportId)
        assert.equal(execution.reportData.summary, 'Latest ACP report')
        assert.equal(execution.reportHistory[0].summary, 'First ACP report')
        assert.ok(prompt.endsWith(rt.workerReportMethod({ stage: 'implement' })))
        const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).executions[execution.id]
        assert.deepEqual(saved.reportData, execution.reportData)
        assert.deepEqual(saved.evidence, execution.evidence)
        const card = rt.transcriptOf(owner.id).find(line => line.origin?.executionId === execution.id && line.origin?.kind === 'report')
        assert.ok(card.text.includes(`报告：report:${report.reportId}`))
      }
      assert.equal(await rt.issueWorkerMcp(owner.id), undefined, 'a leader session never receives a worker credential')
      await until(() => !rt.workView()[owner.id]?.active && !rt.conversationOf(owner.id).session.reportQueue)
    }))
  }

  // dsh resumes through session/resume and falls back to session/load; the other
  // two engines can only load a saved session.
  for (const [method, env] of engine === 'dsh' ? [['session/resume', {}], ['session/load', { DSH_FIXTURE_LEGACY: '1' }]] : [['session/load', {}]]) {
    test(`${engine} restores its worker MCP mount on ${method}`, () => withHost(async host => {
      const bin = join(host.home, engine)
      copyFileSync(new URL(`./fixtures/${engine}-cli.cjs`, import.meta.url), bin)
      chmodSync(bin, 0o755)
      const servers = [{ name: 'nodo_worker', command: process.execPath, args: ['worker.js'], env: [] }]
      let sessionId
      for (let round = 0; round < 2; round++) {
        const driver = createDriver(engine, { bin, cwd: host.home, driverSessionId: sessionId, leadMcpServers: servers, env,
          onEvent: event => { if (event.state === 'ready') sessionId = event.sessionId } })
        try {
          assert.equal(driver.workerMcpMounted, false)
          await driver.openSession()
          assert.equal(driver.workerMcpMounted, true)
        } finally { driver.dispose() }
        assert.equal(driver.workerMcpMounted, false)
      }
      const requests = readFileSync(join(host.home, `${engine}-requests.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
      const attach = requests.filter(item => ['session/new', 'session/load', 'session/resume'].includes(item.method))
      assert.deepEqual(attach.map(item => item.method), ['session/new', method])
      for (const request of attach) assert.deepEqual(request.mcpServers, servers)
    }))
  }
}

test('a native DSH worker gets no worker credential, keeping it on the final-text path', () => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Native', cwd: host.home })
  const profile = await host.api('profile-create', { name: 'Native DSH', engine: 'dsh' })
  const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
  const issued = []
  rt.issueWorkerMcp = async id => { issued.push(id); return { servers: [{ name: 'nodo_worker', url: 'http://127.0.0.1:1/mcp', token: 'fixture' }], revoke() {} } }
  rt.state.executions.queued = { id: 'queued', sessionId: session.id, status: 'queued', stage: 'implement', taskId: 'task' }
  const driver = await rt.ensureDriver(await rt.prepareConversation(session.id))
  assert.deepEqual(issued, [], 'the native session controller takes no MCP input, so no worker token is issued')
  assert.notEqual(driver.workerMcpMounted, true)
}, {
  on: () => () => {},
  workspaceRegistry: { resolveByPath: async cwd => ({ id: 'w1', cwd }), create: async cwd => ({ id: 'w1', cwd }) },
  sessionController: { create: async () => ({ sessionId: 'native-1' }) },
}))
