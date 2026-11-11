import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { registerEngine } from '../../agent-drivers/dist/index.js'
import { registerClaudeFixtureEngine } from './echo-driver.js'
import { withHost, until } from './host.js'

registerClaudeFixtureEngine()
registerEngine('flow-fixture', {
  info: { id: 'flow-fixture', label: 'Flow fixture', capabilities: { resume: true, steer: true } }, validate: raw => raw,
  create({ onEvent }) {
    let turn = 0
    const driver = { calls: [], guides: [], hasSession: () => true, openSession: async () => {}, dispose() {}, onEvent() {}, respondToRequest: async () => false,
      sendTurn: async text => { driver.calls.push(text); onEvent({ type: 'turn/start', turnId: `t${++turn}` }) },
      steer: async text => { driver.guides.push(text); return 'steered' },
      interruptTurn: async () => driver.finish('Stopped', 'interrupted'),
      finish(text = 'Completed', reason = 'done') { onEvent({ type: 'turn/end', turnId: `t${turn}`, reason, text }) },
    }
    return driver
  },
})
export const flags = { crossModule: false, publicInterface: false, dataFormat: false, security: false }
export const reportOf = (extra = {}) => ({ outcome: 'done', summary: 'Implemented and verified', changed: [],
  verified: [{ command: 'fixture check', result: 'pass' }], issues: [], reviewFlags: { ...flags }, ...extra })

export const reportFixtureCompletions = rt => {
  const sink = rt.driverSink
  rt.driverSink = (id, event) => {
    const execution = Object.values(rt.state.executions).findLast(item => item.sessionId === id)
    // Only a turn that is still running reports: a repeated end event on an
    // execution that already settled must not replace its delivered report.
    if (event.type === 'turn/end' && event.reason === 'done' && !event.unconfirmed && execution?.triggerId
      && execution.status === 'running' && ['implement', 'rework'].includes(execution.stage)) {
      void rt.workerReport(execution, reportOf({ summary: (event.text || 'Fixture turn completed').trim().replace(/\s+/g, ' ').slice(0, 200) }))
        .then(() => sink(id, event))
      return
    }
    sink(id, event)
  }
}

export const withFlow = (run, repository = false) => withHost(async host => {
  const rt = await host.runtime
  let cwd = host.home
  if (repository) {
    cwd = join(host.home, 'repo'); mkdirSync(cwd)
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(cwd, 'base'), 'base'); git('add', 'base'); git('commit', '-qm', 'Initialize fixture')
  }
  const workspace = await host.api('workspace-create', { name: 'Flow', cwd })
  const worker = await host.api('profile-create', { name: 'Implementer', engine: 'flow-fixture' })
  const reviewer = await host.api('profile-create', { name: 'Reviewer', engine: 'flow-fixture' })
  const lead = await host.api('profile-create', { name: 'Lead', engine: 'claude', lead: true, engineOptions: { script: [] } })
  const team = { id: 'team', name: 'Team', lead: lead.id, members: [worker.id, reviewer.id],
    types: [{ id: 'feature', name: 'Feature', when: '' }, { id: 'review', name: 'Review', when: '', independent: true }],
    assign: { feature: { normal: { profile: worker.id } }, review: { normal: { profile: reviewer.id } } } }
  await rt.updateTeams([team])
  const owner = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const other = await host.api('session-create', { profile: lead.id, workspace: workspace.id, lazy: true })
  const trigger = text => {
    const line = rt.appendLine(owner.id, { who: 'user', kind: 'text', text })
    return rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: owner.id, line }))
  }
  const create = async (extra = {}) => {
    trigger('Original exact requirement')
    const receipt = await rt.leadRoute(owner.id, { action: 'new', type: 'feature', hard: false, scope: { quote: 'Original' }, ...extra })
    return rt.state.executions[receipt.executionId]
  }
  const start = async execution => {
    await rt.startFlowExecution(execution.id)
    assert.equal(execution.status, 'running', execution.reason)
    await until(() => (rt.driverOf(execution.sessionId)?.calls.length ?? 0) >= Object.values(rt.state.executions)
      .filter(item => item.sessionId === execution.sessionId && item.startedAt != null).length)
  }
  const finish = async (execution, report = reportOf(), text = 'Completed', reason = 'done') => {
    await start(execution)
    if (report) await rt.workerReport(execution, report)
    rt.driverOf(execution.sessionId).finish(text, reason)
    await advanced(execution)
    return execution
  }
  const advanced = execution => until(() => execution.endedAt != null
    && (execution.flowContinued || ['stalled', 'stopped'].includes(rt.state.tasks[execution.taskId].flow.status)))
  // The program advances the flow itself; this returns the task's latest execution.
  const review = async execution => {
    await advanced(execution)
    return Object.values(rt.state.executions).filter(item => item.taskId === execution.taskId).at(-1)
  }
  const card = taskId => Object.values(rt.state.cards).find(item => item.taskId === taskId && item.status === 'open')
  const answer = (item, action, reason) => host.api('card-answer', { profile: lead.id, session: owner.id, cardId: item.id, action, ...(reason ? { reason } : {}) })
  const assertState = (execution, status, taskStatus) => {
    assert.equal(rt.state.tasks[execution.taskId].flow.status, status)
    assert.equal(rt.state.tasks[execution.taskId].status, taskStatus)
  }
  await run({ host, rt, workspace, worker, reviewer, lead, owner, other, team, trigger, create, start, finish, review, card, answer, assertState })
})
