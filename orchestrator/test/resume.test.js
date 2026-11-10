import { routeUserTask, userRoute } from './helpers/route.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withHost, until } from './helpers/host.js'

for (const [engine, resultFirst] of [['claude', false], ['claude', true], ['codex', false]]) test(`${engine} hands off lead and executor contexts and delivers the queued report${resultFirst ? ' (result before close)' : ''}`, () => withHost(async ({ api, runtime, home }) => {
  const bin = join(home, engine)
  copyFileSync(new URL(`./fixtures/${engine}-cli.cjs`, import.meta.url), bin)
  chmodSync(bin, 0o755)
  const errorEnv = engine === 'claude' ? 'CLAUDE_FIXTURE_RESUME_ERROR' : 'CODEX_FIXTURE_RESUME_ERROR'
  const error = engine === 'claude' ? 'No conversation found with session ID: {id}' : 'no rollout found for thread with id {id}'
  process.env[errorEnv] = error
  if (resultFirst) process.env.CLAUDE_FIXTURE_RESUME_RESULT = '1'
  try {
    const workspace = await api('workspace-create', { name: 'Project', cwd: home })
    const worker = await api('profile-create', { name: 'Worker', engine, workspace: workspace.id, engineOptions: { bin } })
    const lead = await api('profile-create', { name: 'Lead', engine, lead: true, workspace: workspace.id, engineOptions: { bin } })
    await api('teams-update', { teams: [{ name: 'Team', lead: lead.id, members: [worker.id],
      types: [{ id: 'feature', name: '功能', when: '' }], assign: { feature: { normal: { profile: worker.id } } } }] })
    const rt = await runtime
    const leadSession = rt.conversation(lead.id, lead.id).session
    rt.state.profiles[lead.id].driverSessionId = leadSession.driverSessionId = 'missing-lead'
    leadSession.taskState = { objective: 'Keep the original task' }
    leadSession.lastTurn = { task: 'Earlier request', report: 'Earlier evidence', reason: 'done' }
    const first = await rt.send(lead.id, 'Continue the task', leadSession.id, [], [], { userInput: true })
    assert.equal((await first.completion).reason, 'done')
    const freshId = engine === 'claude' ? 'fixture-claude-session' : 'fixture-thread'
    assert.equal(leadSession.driverSessionId, freshId)
    assert.equal(rt.state.profiles[lead.id].driverSessionId, freshId)
    assert.equal(leadSession.restoreContext, false)

    const receipt = await routeUserTask(rt, leadSession.id, { type: 'feature', hard: false, task: 'Implement the task' })
    const work = rt.conversationOf(receipt.session).session
    work.driverSessionId = 'missing-worker'
    work.lastTurn = { task: 'Prior work', report: 'Worker evidence', reason: 'done' }
    const source = structuredClone(work.source)
    const task = structuredClone(rt.state.tasks[receipt.taskId])
    rt.releaseDriver(leadSession.id)
    rt.state.profiles[lead.id].driverSessionId = leadSession.driverSessionId = 'missing-report-recipient'
    await rt.followLead(leadSession.id, first)
    await until(() => rt.state.executions[receipt.executionId].status === 'done')
    await until(() => rt.transcriptOf(leadSession.id).some(line => line.origin?.reportId) && !rt.workView()[leadSession.id]?.active && !leadSession.reportQueue?.length)
    assert.equal(work.driverSessionId, freshId)
    assert.equal(work.restoreContext, false)
    assert.deepEqual(work.source, source)
    const finished = rt.state.tasks[receipt.taskId]
    assert.ok(finished.updatedAt >= task.updatedAt)
    assert.deepEqual(finished, { ...task, status: 'review', updatedAt: finished.updatedAt })
    assert.equal(rt.state.executions[receipt.executionId].sessionId, receipt.session)
    const leadLines = rt.transcriptOf(leadSession.id)
    assert.deepEqual(leadLines.filter(line => line.kind === 'note' && line.text.includes('旧引擎历史')).map(line => line.text),
      ['missing-lead', 'missing-report-recipient'].map(id => `已更换后台上下文：旧引擎历史不再带入，任务与结果经 nodo_board 接续。（原引擎会话：${id}）`))
    assert.deepEqual(rt.transcriptOf(work.id).filter(line => line.kind === 'note' && line.text.includes('旧引擎历史')).map(line => line.text),
      ['已更换后台上下文：旧引擎历史不再带入。（原引擎会话：missing-worker）'])
    assert.equal(leadLines.filter(line => line.origin?.reportId).length, 1)
    assert.equal(leadLines.some(line => line.kind === 'error'), false)
    assert.equal(rt.transcriptOf(work.id).some(line => line.kind === 'error'), false)
    const requests = readFileSync(join(home, `${engine}-requests.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
    const inputs = engine === 'claude' ? requests.filter(item => item.user).map(item => item.user)
      : requests.filter(item => item.method === 'turn/start').map(item => item.params.input[0].text)
    assert.ok(inputs.some(text => text.includes('Earlier evidence') && text.includes('Check nodo_board / <nodo-status>')))
    assert.ok(inputs.some(text => text.includes('Worker evidence') && text.includes('Implement the task')))
    assert.ok(inputs.some(text => text.includes('Report from Worker') && text.includes('Check nodo_board / <nodo-status>')))
    const stateText = readFileSync(join(home, 'state.json'), 'utf8')
    for (const oldId of ['missing-lead', 'missing-worker', 'missing-report-recipient']) assert.equal(stateText.includes(oldId), false)
    const saved = JSON.parse(stateText)
    assert.equal(saved.version, 6)
    assert.equal(saved.profiles[lead.id].driverSessionId, freshId)
  } finally {
    delete process.env[errorEnv]
    if (resultFirst) delete process.env.CLAUDE_FIXTURE_RESUME_RESULT
  }
}))
