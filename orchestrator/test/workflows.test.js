import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { STEER } from '../agent-drivers/dist/spi.js'
import { checkEcho, echoInfo, validateEchoOptions } from './helpers/echo-driver.js'
import { boot, until } from './helpers/host.js'
import { advance, halt } from '../core/src/workflows.js'
import { workflowSessionTitle } from '../core/shared/task-titles.js'

// An engine whose every turn ends in an error.
registerEngine('broken', {
  info: { ...echoInfo, id: 'broken', label: 'Broken (test)' },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    return {
      async openSession() {},
      sendTurn() {
        const turnId = `broken-${++n}`
        setTimeout(() => { onEvent({ type: 'turn/start', turnId }); onEvent({ type: 'turn/end', turnId, reason: 'error', error: 'boom' }) }, 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})

// An engine that reports a progress message, then `final` apart on turn/end.
const registerFinalEngine = (id, final) => registerEngine(id, {
  info: { ...echoInfo, id, label: `${id} (test)` },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    return {
      async openSession() {},
      sendTurn() {
        const turnId = `${id}-${++n}`
        setTimeout(() => {
          onEvent({ type: 'turn/start', turnId })
          for (const text of ['Progress notes', 'Final notes']) onEvent({ type: 'text', turnId, text })
          onEvent({ type: 'turn/end', turnId, reason: 'done', text: final })
        }, 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})
registerFinalEngine('finalist', 'Final notes')
registerFinalEngine('blank-final', '   ')
const LONG_WORKFLOW_REPORT = `# Implementation\n${'Large upstream details '.repeat(12_000)}\n## Evidence\nTAIL_END`
registerFinalEngine('workflow-long-report', LONG_WORKFLOW_REPORT)

// A turn that runs until it is interrupted; `confirm` decides what the engine
// reports then: nothing, an interrupted end, or a finished turn with its text.
const registerStopEngine = (id, confirm) => registerEngine(id, {
  info: { ...echoInfo, id, label: `${id} (test)` },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    let turnId = null
    return {
      async openSession() {},
      sendTurn() {
        turnId = `${id}-${++n}`
        setTimeout(() => onEvent({ type: 'turn/start', turnId }), 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {
        if (confirm === 'interrupted') onEvent({ type: 'turn/end', turnId, reason: 'interrupted' })
        if (confirm === 'done') { onEvent({ type: 'text', turnId, text: 'Late copy' }); onEvent({ type: 'turn/end', turnId, reason: 'done' }) }
      },
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})
// Engines whose delivery fails at a given point: before the message is sent
// (`unsent`), after the engine took it but its receipt failed (`lost-ack`), after
// the engine already finished the turn (`ended-ack`), or in the host's save right
// after a send that worked (`save-fails`, through `failNextSave`).
const failNextSave = { armed: false }
const registerDeliveryEngine = (id, mode) => registerEngine(id, {
  info: { ...echoInfo, id, label: `${id} (test)` },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    return {
      async openSession() { if (mode === 'unsent') throw new Error('engine did not start') },
      async sendTurn() {
        const turnId = `${id}-${++n}`
        onEvent({ type: 'turn/start', turnId })
        if (mode === 'ended-ack') {
          onEvent({ type: 'text', turnId, text: 'Done copy' })
          onEvent({ type: 'turn/end', turnId, reason: 'done' })
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (mode === 'save-fails') { failNextSave.armed = true; return turnId }
        throw new Error('turn/start receipt timed out')
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})
registerDeliveryEngine('unsent', 'unsent')
registerDeliveryEngine('lost-ack', 'lost-ack')
registerDeliveryEngine('ended-ack', 'ended-ack')
registerDeliveryEngine('save-fails', 'save-fails')
registerStopEngine('stoppable', 'interrupted')
registerStopEngine('stubborn', 'none')
registerStopEngine('finisher', 'done')

const withRuntime = async (run) => {
  const home = mkdtempSync(join(tmpdir(), 'orch-workflows-'))
  const host = boot(home)
  try {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Flow', cwd: join(home, 'ws') })
    const role = (name, text, extra = {}) => host.api('profile-create', { name, engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'text', text }] }, ...extra })
    await run({ host, rt, home, role, workspace })
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
}

const sessionsOf = async (host, profileId) => (await host.api('state')).profiles.find(profile => profile.id === profileId).sessions
const userLine = async (host, profileId, sessionId) => (await host.api('transcript', { profile: profileId, session: sessionId })).find(line => line.who === 'user')
const runFile = (home, id) => JSON.parse(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'))

test('a two-step run hands the first report to the second step and persists every record', async () => withRuntime(async ({ host, rt, home, role }) => {
  const researcher = await role('Researcher', 'Research notes')
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Brief', steps: [{ profile: researcher.id, name: 'research', task: 'Find sources' }, { profile: writer.id, name: 'write', task: 'Write it up' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  const saved = runFile(home, run.id)
  assert.deepEqual(saved, run)
  assert.deepEqual(Object.values(saved.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'done'], ['s2', 'done'], ['end', 'done']])
  assert.equal(saved.artifacts[saved.final].text, 'Final copy')
  const attempts = Object.values(saved.attempts)
  assert.deepEqual(attempts.map(attempt => [attempt.phase, attempt.end.reason, typeof attempt.turn.turnId]), [['ended', 'done', 'string'], ['ended', 'done', 'string']])

  // Each task ran in a new conversation; the roles keep the one the user had open.
  const [research] = (await sessionsOf(host, researcher.id)).filter(session => session.source?.workflowId === workflow.id)
  const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
  assert.deepEqual([run.title, research.name, write.name], ['Find sources', 'Find sources', 'Write it up'])
  assert.deepEqual([attempts[0].sessionId, attempts[1].sessionId], [research.id, write.id])
  assert.equal((await host.api('state')).profiles.find(profile => profile.id === writer.id).activeSessionId ?? writer.id, writer.id)
  const input = await userLine(host, writer.id, write.id)
  assert.equal(input.text, 'Write it up')
  assert.deepEqual(input.references[0].messages, [{ text: 'Research notes' }])
  assert.equal(input.references[0].source.sessionId, research.id)
}))

test('a launch title reaches the run views and supplies context for a generic step task', async () => withRuntime(async ({ host, rt, home, role }) => {
  const coder = await role('Title writer', 'Done')
  const workflow = await host.api('workflow-create', { name: '开发', steps: [{ profile: coder.id, task: '修复登录后白屏' }, { profile: coder.id, task: '审查上一步' }] })
  assert.equal((await host.post('workflow-run', { id: workflow.id, title: ' ' })).error.code, 'orch/invalid')
  assert.equal(rt.workflowsView().running, null)
  const { runId } = await host.api('workflow-run', { id: workflow.id, title: '  登录白屏修复  ' })
  const run = await settled(rt, home, runId)
  const sessions = (await sessionsOf(host, coder.id)).filter(session => session.source?.runId === runId)
  assert.deepEqual(sessions.map(session => session.name), ['修复登录后白屏', '登录白屏修复 · 审查上一步'])
  assert.equal((await host.api('run-get', { id: runId })).title, '登录白屏修复')
  assert.equal((await host.api('run-list')).find(item => item.id === runId).title, '登录白屏修复')
  assert.equal(run.workflowName, '开发')
  assert.deepEqual(sessions.map(session => session.source.nodeId), ['s1', 's2'])
}))

test('session titles redact a secret registered after the run snapshot was created', async () => withRuntime(async ({ host, rt, home, role }) => {
  const writer = await role('Writer', 'Done')
  const value = 'test-workflow-title-credential-that-crosses-the-forty-character-title-boundary'
  const workflow = await host.api('workflow-create', { name: 'Title redaction', nodes: [
    { id: 'start', kind: 'start' },
    { id: 'gate', kind: 'human', question: 'Continue?', options: [{ id: 'go', label: 'Go' }] },
    { id: 'write', kind: 'agent', profile: writer.id, task: `Check ${value}` },
    { id: 'end', kind: 'end', deliver: 'write' },
  ], edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'write' }, { from: 'write', exit: 'done', to: 'end' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host), runId = card.id.split(':')[1]
  assert.equal(runFile(home, runId).snapshot.graph.nodes.find(node => node.id === 'write').task, `Check ${value}`)
  assert.equal((await host.api('run-list')).find(item => item.id === runId).title, `Check ${value}`.slice(0, 40), 'warm the unredacted summary before registering the secret')
  const path = join(home, 'runs', `${runId}.json`), before = readFileSync(path, 'utf8')
  const frozen = (await rt.loadRun(runId)).snapshot
  await host.api('secret-set', { name: 'TITLE_REDACTION_TEST', value, purpose: 'test' })
  const expected = 'Check [secret:TITLE_REDACTION_TEST]'
  assert.equal((await host.api('run-list')).find(item => item.id === runId).title, expected)
  const shown = await host.api('run-get', { id: runId })
  assert.equal(shown.title, expected)
  assert.equal(shown.graph.nodes.find(node => node.id === 'write').task, expected)
  assert.equal(readFileSync(path, 'utf8'), before, 'display redaction does not rewrite the historical run file')
  assert.deepEqual((await rt.loadRun(runId)).snapshot, frozen, 'display redaction preserves the frozen snapshot')
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'go' })
  assert.equal((await pending).status, 'done')
  const session = (await sessionsOf(host, writer.id)).find(item => item.source?.runId === runId)
  assert.equal(session.name, expected)
  const doneView = await host.api('run-get', { id: runId })
  assert.equal(doneView.tasks.find(task => task.kind === 'agent').input.text, expected)
  assert.equal(JSON.stringify(doneView).includes(value.slice(0, 25)), false)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.profiles[writer.id].sessions.find(item => item.id === session.id).name, session.name)
  await rt.commit(runId, draft => { delete draft.title })
  const legacyFile = readFileSync(path, 'utf8')
  assert.equal((await host.api('run-get', { id: runId })).title, expected)
  assert.equal(readFileSync(path, 'utf8'), legacyFile)
}))

test('attachment, question and topic title boundaries redact before persisting session names', async () => withRuntime(async ({ host, rt, home, role, workspace }) => {
  const writer = await role('Boundary writer', 'Done')
  const value = 'synthetic-boundary-credential-value-0123456789'
  const topic = `${'T'.repeat(30)} ${value}`
  const refs = await host.api('attachment-save', {
    files: [{ name: `Check ${value}.txt`, data: Buffer.from('requirements').toString('base64') }],
    images: [{ name: `Check ${value}.png`, mediaType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }],
  })
  const relative = `根据上面报告 ${'x'.repeat(20)} ${value}`
  const workflow = await host.api('workflow-create', { name: 'Boundary titles', nodes: [
    { id: 'start', kind: 'start' }, { id: 'gate', kind: 'human', options: [{ id: 'go', label: 'Go' }] },
    { id: 'document', kind: 'agent', profile: writer.id, task: '', files: refs.files },
    { id: 'image', kind: 'agent', profile: writer.id, task: '', images: refs.images },
    { id: 'relative', kind: 'agent', profile: writer.id, task: relative }, { id: 'end', kind: 'end', deliver: 'relative' },
  ], edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'document' },
    { from: 'document', exit: 'done', to: 'image' }, { from: 'image', exit: 'done', to: 'relative' }, { from: 'relative', exit: 'done', to: 'end' }] })
  const pending = rt.runWorkflow(workflow.id, { title: topic })
  const card = await questionCard(host), runId = card.id.split(':')[1]
  await host.api('run-list')
  await host.api('secret-set', { name: 'BOUNDARY', value, purpose: 'test' })
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'go' })
  const run = await pending
  // A file-only step dispatches instead of stopping for a person.
  assert.deepEqual([run.status, run.reason], ['done', undefined])
  const expectedTopic = `${'T'.repeat(30)} [secret:BOUNDARY]`
  const expectedRelative = `${expectedTopic.slice(0, 40)} · ${`根据上面报告 ${'x'.repeat(20)} [secret:BOUNDARY]`.slice(0, 40)}`.slice(0, 80)
  const sessions = (await sessionsOf(host, writer.id)).filter(item => item.source?.runId === runId)
  assert.deepEqual(sessions.map(item => item.name), ['Check [secret:BOUNDARY].txt', 'Check [secret:BOUNDARY].png', expectedRelative])
  assert.equal(sessions[2].name.length, 80)
  const question = await rt.createSession(writer.id, workflowSessionTitle({ question: `Check ${value}` }, topic, rt.redactSecrets), workspace.id, true, false, {})
  await rt.save()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[writer.id].sessions
  for (const session of [...sessions, question]) {
    const name = saved.find(item => item.id === session.id).name
    assert.equal(name.includes(value.slice(0, 8)), false, 'persisted names contain no truncated credential prefix')
  }
  assert.equal(saved.find(item => item.id === question.id).name, 'Check [secret:BOUNDARY]')
  const shown = await host.api('run-get', { id: runId })
  assert.equal(shown.title, expectedTopic)
  assert.equal(JSON.stringify(shown).includes(value.slice(0, 8)), false, 'graph attachment names and task inputs use current redaction too')
}))

test('run output previews apply current redaction before the 400-character cut', async () => withRuntime(async ({ host, rt, home, role }) => {
  const value = 'synthetic-report-credential-that-crosses-the-preview-character-boundary'
  const output = `${'x'.repeat(390)} ${value}`
  const writer = await role('Preview writer', output)
  const workflow = await host.api('workflow-create', { name: 'Preview', steps: [{ profile: writer.id, task: 'Write' }] })
  const run = await rt.runWorkflow(workflow.id)
  await host.api('secret-set', { name: 'PREVIEW', value, purpose: 'test' })
  const path = join(home, 'runs', `${run.id}.json`), before = readFileSync(path, 'utf8')
  let task = (await host.api('run-get', { id: run.id })).tasks.find(task => task.kind === 'agent')
  assert.equal(task.output, `${'x'.repeat(390)} [secret:PREVIEW]`.slice(0, 400))
  assert.equal(task.more, true)
  assert.equal(readFileSync(path, 'utf8'), before)
  await rt.commit(run.id, draft => { draft.artifacts[draft.final].text = `${'x'.repeat(350)} ${value}` })
  task = (await host.api('run-get', { id: run.id })).tasks.find(task => task.kind === 'agent')
  assert.equal(task.output, `${'x'.repeat(350)} [secret:PREVIEW]`)
  assert.equal(task.more, false, 'the more marker describes the redacted output')
}))

test('a real run exceeding the handoff budget stops before dispatch and keeps its snapshot on retry', async () => withRuntime(async ({ host, rt, home, role }) => {
  const writer = await role('Writer', 'Draft'), reviewer = await role('Budget critic', 'Approved\nNEXT: approve')
  const nodes = [{ id: 'start', kind: 'start' }, { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
    { id: 'review', kind: 'agent', profile: reviewer.id, task: 'Review', exits: ['approve', 'revise', 'other_a', 'other_b', 'other_c', 'other_d', 'other_e', 'other_f'].map(id => ({ id, when: `${id}: ${'a'.repeat(2000)}` })) },
    { id: 'end', kind: 'end', deliver: 'write' }]
  const edges = [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'review' },
    { from: 'review', exit: 'approve', to: 'end' }, { from: 'review', exit: 'revise', to: 'write', back: { max: 1 } },
    ...nodes[2].exits.slice(2).map(exit => ({ from: 'review', exit: exit.id, to: 'end' }))]
  const workflow = await host.api('workflow-create', { name: 'Over budget', nodes, edges })
  const stopped = await rt.runWorkflow(workflow.id)
  assert.equal(stopped.status, 'waiting_human')
  assert.match(stopped.reason, /^not sent: Workflow handoff context exceeds 16000 characters;/)
  const task = Object.values(stopped.tasks).find(item => item.nodeId === 'review')
  assert.equal(task.status, 'waiting_human')
  assert.deepEqual(stopped.attempts[task.current].end, { reason: 'error' })
  const session = stopped.attempts[task.current].sessionId
  assert.equal(await userLine(host, reviewer.id, session), undefined, 'no task reaches the reviewer transcript or engine')
  nodes[2].exits.forEach(exit => { exit.when = `Choose ${exit.id}` })
  await host.api('workflow-update', { id: workflow.id, revision: workflow.revision, name: workflow.name, nodes, edges })
  const retried = await rt.reconcileRun(stopped.id, { action: 'retry', reason: 'Retry after editing flow' })
  assert.match(retried.reason, /^not sent: Workflow handoff context exceeds 16000 characters;/)
  assert.equal(retried.snapshot.graph.nodes.find(node => node.id === 'review').exits[0].when.length, 2000)
  assert.equal(await userLine(host, reviewer.id, Object.values(retried.attempts).at(-1).sessionId), undefined)
  const accepted = await rt.reconcileRun(stopped.id, { action: 'accept', text: 'Manually checked the draft\nNEXT: approve', reason: 'Reviewed the task and output myself' })
  assert.equal(accepted.status, 'done')
  const persisted = runFile(home, stopped.id)
  assert.equal(Object.values(persisted.tasks).find(item => item.nodeId === 'review').provenance, 'human')
}))

test('a flow with its own workspace runs every step there, and saving one that does not exist is refused', async () => withRuntime(async ({ host, rt, home, role }) => {
  const other = await host.api('workspace-create', { name: 'Other', cwd: join(home, 'other') })
  const writer = await role('Writer', 'Final copy')
  const steps = [{ profile: writer.id, name: 'write', task: 'Write it up' }]
  await assert.rejects(host.api('workflow-create', { name: 'Lost', workspaceId: 'missing', steps }), error => error.code === 'orch/invalid')
  const workflow = await host.api('workflow-create', { name: 'Elsewhere', workspaceId: other.id, steps })
  assert.equal(workflow.workspaceId, other.id)
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.equal(run.snapshot.input.workspaceId, other.id)
  assert.equal(Object.values(run.attempts)[0].workspaceId, other.id)
  const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
  assert.equal(write.workspaceRef, other.id, 'the step runs in the flow\'s workspace, not the role\'s')
  const { workspaceId, ...cleared } = await host.api('workflow-update', { id: workflow.id, revision: workflow.revision, name: 'Elsewhere', steps })
  assert.equal(workspaceId, undefined, 'saving without a workspace goes back to each role\'s conversation')
  assert.equal(cleared.revision, 2)
}))

test('a step whose engine reports its last message hands on that message alone', async () => withRuntime(async ({ host, rt, workspace, role }) => {
  const researcher = await host.api('profile-create', { name: 'Researcher', engine: 'finalist', workspace: workspace.id })
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Brief', steps: [{ profile: researcher.id, name: 'research', task: 'Find sources' }, { profile: writer.id, name: 'write', task: 'Write it up' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  const [research, write] = Object.values(run.tasks).filter(task => task.output).map(task => run.artifacts[task.output].text)
  assert.deepEqual([research, write], ['Final notes', 'Final copy'])
  const [session] = (await sessionsOf(host, writer.id)).filter(item => item.source?.workflowId === workflow.id)
  assert.deepEqual((await userLine(host, writer.id, session.id)).references[0].messages, [{ text: 'Final notes' }])
}))

const delivered = []
  registerEngine('workflow-input-proof', {
    info: { ...echoInfo, id: 'workflow-input-proof' }, validate: validateEchoOptions, check: checkEcho,
    create: options => ({
      async openSession() {}, hasSession: () => true, dispose() {}, onEvent() {},
      async sendTurn(text, images) {
        const path = /^File: ("[^\n]+")$/m.exec(text)
        const report = path ? readFileSync(JSON.parse(path[1]), 'utf8') : undefined
        delivered.push({ text, images, report, cwd: options.cwd, model: options.model, thinking: options.thinking, permission: options.permission })
        const turnId = `input-${delivered.length}`
        setTimeout(() => {
          options.onEvent({ type: 'turn/start', turnId })
          options.onEvent({ type: 'text', turnId, text: '完成' })
          options.onEvent({ type: 'turn/end', turnId, reason: 'done' })
        }, 0)
        return turnId
      },
      steer: async () => STEER.REFUSED, async compact() {}, async interruptTurn() {}, async respondToRequest() { return false },
    }),
  })
test('node attachments and model choices survive saving and reach only their own execution step', async () => withRuntime(async ({ host, rt, home, workspace }) => {
  delivered.length = 0
  const profile = await host.api('profile-create', { name: 'Inputs', engine: 'workflow-input-proof', workspace: workspace.id, model: 'role-default' })
  const data = Buffer.from('Workflow attached requirements').toString('base64')
  const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const refs = await host.api('attachment-save', { images: [{ name: 'shot.png', mediaType: 'image/png', data: image }], files: [{ name: 'requirements.txt', data }] })
  const workflow = await host.api('workflow-create', { name: 'Node inputs', nodes: [
    { id: 'start', name: '开始', kind: 'start' },
    { id: 'first', name: '输入任务', kind: 'agent', profileId: profile.id, task: '/review @project.md', ...refs, choices: { model: 'first-model', thinking: 'high', permission: 'plan' } },
    { id: 'second', name: '独立任务', kind: 'agent', profileId: profile.id, task: 'Second', choices: { model: 'second-model', thinking: 'low', permission: 'full' } },
    { id: 'end', name: '完成', kind: 'end', deliver: 'second' },
  ], edges: [{ from: 'start', exit: 'done', to: 'first' }, { from: 'first', exit: 'done', to: 'second' }, { from: 'second', exit: 'done', to: 'end' }] })
  assert.equal(workflow.nodes[1].images[0].id, refs.images[0].id)
  assert.equal(workflow.nodes[1].files[0].name, 'requirements.txt')
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8').includes(data), false, 'definitions keep file references, not bytes')
  const run = await rt.runWorkflow(workflow.id)
  const diagnostic = run.status === 'done' ? [] : await host.api('transcript', { profile: profile.id, session: Object.values(run.attempts)[0]?.sessionId })
  assert.equal(run.status, 'done', JSON.stringify(diagnostic.filter(line => line.kind === 'error' || line.kind === 'note').map(line => line.text)))
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered.map(({ model, thinking, permission }) => [model, thinking, permission]), [
    ['first-model', 'high', 'plan'], ['second-model', 'low', 'full'],
  ])
  assert.match(delivered[0].text, /\/review @project\.md/)
  const path = JSON.parse(delivered[0].text.match(/^- ("[^\n]+")$/m)[1])
  assert.ok(path.startsWith(join(realpathSync(workspace.cwd), '.nodo', 'workflow-inputs')))
  assert.equal(readFileSync(path, 'utf8'), 'Workflow attached requirements')
  assert.equal(delivered[0].images[0].data, image)
  assert.equal(delivered[0].images[0].name, 'shot.png')
  assert.equal(delivered[1].images.length, 0)
  assert.equal((await host.api('state')).profiles.find(item => item.id === profile.id).model, 'role-default')
  assert.equal(run.snapshot.graph.nodes[1].choices.model, 'first-model')
}))

test('a run saved with a legacy default thinking choice lets the engine pick when it resumes', async () => withRuntime(async ({ host, rt, workspace }) => {
  delivered.length = 0
  const profile = await host.api('profile-create', { name: 'Legacy', engine: 'workflow-input-proof', workspace: workspace.id })
  const workflow = await host.api('workflow-create', { name: 'Legacy thinking', nodes: [
    { id: 'start', name: '开始', kind: 'start' }, { id: 'gate', kind: 'human', options: [{ id: 'go', label: 'Go' }] },
    { id: 'only', name: '任务', kind: 'agent', profileId: profile.id, task: 'Only', choices: { thinking: 'high' } },
    { id: 'end', name: '完成', kind: 'end', deliver: 'only' },
  ], edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'only' }, { from: 'only', exit: 'done', to: 'end' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  await rt.commit(card.id.split(':')[1], (draft) => { draft.snapshot.graph.nodes.find(node => node.id === 'only').choices.thinking = 'default' })
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'go' })
  const run = await pending
  assert.equal(run.status, 'done')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].thinking, undefined)
}))

test('a long upstream report reaches an engine as a readable workspace file, survives restart, and stays out of the prompt', async () => withRuntime(async ({ host, rt, home, workspace, role }) => {
  delivered.length = 0
  const report = LONG_WORKFLOW_REPORT
  const source = await host.api('profile-create', { name: 'Source', engine: 'workflow-long-report', workspace: workspace.id })
  const other = await host.api('workspace-create', { name: 'Reader workspace', cwd: join(home, 'reader') })
  const reader = await host.api('profile-create', { name: 'Reader', engine: 'workflow-input-proof', workspace: other.id })
  const workflow = await host.api('workflow-create', { name: 'Files', steps: [{ profile: source.id, task: 'Implement' }, { profile: reader.id, task: 'Check code and docs' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.equal(delivered.length, 1)
  const input = delivered[0]
  assert.ok(input.text.startsWith('# Your step\nCheck code and docs\n'))
  assert.ok(input.text.length < 3000)
  assert.equal(input.text.includes('Large upstream details'), false)
  assert.equal(input.report, report, 'the receiving engine reads the whole report, including text beyond the old cap')
  const reportPath = JSON.parse(input.text.match(/^File: ("[^\n]+")$/m)[1])
  assert.ok(reportPath.startsWith(join(realpathSync(other.cwd), '.nodo', 'workflow-runs', run.id)))
  assert.notEqual(other.id, workspace.id)
  const first = Object.values(run.tasks).find(task => task.nodeId === 's1')
  assert.equal(run.artifacts[first.output].text, report)
  assert.equal(run.artifacts[first.output].truncated, undefined)
  host.dispose()
  const reopened = boot(home)
  try {
    const runtime = await reopened.runtime
    assert.equal((await runtime.loadRun(run.id)).artifacts[first.output].text, report)
    assert.equal(readFileSync(reportPath, 'utf8'), report, 'completed runs keep their material files')
    await reopened.api('workflow-delete', { id: workflow.id })
    assert.equal(readFileSync(reportPath, 'utf8'), report, 'deleting a definition keeps its historical materials')
  } finally { reopened.dispose() }
}))

test('an unavailable material directory stops before dispatching the receiving engine', async () => withRuntime(async ({ host, rt, home, role }) => {
  delivered.length = 0
  const source = await role('Source', 'Saved report')
  const blocked = join(home, 'blocked')
  mkdirSync(blocked)
  writeFileSync(join(blocked, '.nodo'), 'An existing file must stay intact')
  const workspace = await host.api('workspace-create', { name: 'Blocked', cwd: blocked })
  const reader = await host.api('profile-create', { name: 'Reader', engine: 'workflow-input-proof', workspace: workspace.id })
  const workflow = await host.api('workflow-create', { name: 'Blocked materials', steps: [{ profile: source.id, task: 'Produce' }, { profile: reader.id, task: 'Read' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'waiting_human')
  assert.match(run.reason, /^not sent:/)
  assert.equal(delivered.length, 0)
  assert.equal(readFileSync(join(blocked, '.nodo'), 'utf8'), 'An existing file must stay intact')
}))

test('a blank last message falls back to the turn text', async () => withRuntime(async ({ host, rt, workspace }) => {
  const researcher = await host.api('profile-create', { name: 'Researcher', engine: 'blank-final', workspace: workspace.id })
  const workflow = await host.api('workflow-create', { name: 'Blank', steps: [{ profile: researcher.id, task: 'Find sources' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.equal(run.artifacts[run.final].text, 'Progress notes\nFinal notes')
}))

test('saving node inputs refuses missing attachments and invalid engine choices before persisting', async () => withRuntime(async ({ host, role }) => {
  const profile = await role('Input checks', 'done')
  const body = changes => ({ name: 'Invalid input', nodes: [
    { id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', profileId: profile.id, task: 'work', ...changes }, { id: 'end', kind: 'end', deliver: 'work' },
  ], edges: [{ from: 'start', exit: 'done', to: 'work' }, { from: 'work', exit: 'done', to: 'end' }] })
  const missing = '00000000-0000-0000-0000-000000000000'
  for (const changes of [
    { images: [{ id: '../secret', mediaType: 'image/png' }] }, { images: [{ id: missing, mediaType: 'image/png' }] },
    { files: [{ id: missing, name: 'missing' }] }, { choices: { thinking: 'bad level' } }, { choices: { permission: 'invented' } }, { choices: { engine: 'other' } },
  ]) {
    const result = await host.post('workflow-create', body(changes))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'orch/invalid')
  }
  assert.equal((await host.api('state')).workflows.definitions.length, 0)
}))

test('a step that ends in an error stops the run for a person and dispatches nothing after it', async () => withRuntime(async ({ host, rt, workspace, role }) => {
  const broken = await host.api('profile-create', { name: 'Broken', engine: 'broken', workspace: workspace.id })
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Fails', steps: [{ profile: broken.id, task: 'Try' }, { profile: writer.id, task: 'Never' }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'waiting_human')
  assert.equal(run.reason, 'ended error')
  assert.match(Object.values(run.attempts)[0].turn.turnId, /^broken-/)
  assert.deepEqual(Object.values(run.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'waiting_human']])
  assert.equal(run.final, undefined)
  assert.equal((await workflowSessions(host, writer.id, 'Fails')).length, 0)
}))

test('a repeated completion does not create a second successor', () => {
  const run = { snapshot: { graph: { edges: [{ from: 's1', exit: 'done', to: 's2' }] } }, tasks: { t1: { id: 't1', nodeId: 's1', status: 'active' } } }
  const events = []
  const event = (type, fields) => events.push({ type, ...fields })
  advance(run, event, run.tasks.t1, 'done')
  advance(run, event, run.tasks.t1, 'done')
  assert.deepEqual(Object.values(run.tasks).map(task => [task.nodeId, task.key]), [['s1', undefined], ['s2', 't1:done']])
  assert.equal(events.filter(item => item.type === 'task/create').length, 1)
})

test('editing the definition during a run does not change the run', async () => withRuntime(async ({ host, rt, home, role }) => {
  const slow = await host.api('profile-create', { name: 'Slow', engine: 'echo', workspace: (await host.api('state')).workspaces[0].id, engineOptions: { script: [{ kind: 'wait', ms: 300 }, { kind: 'text', text: 'Slow notes' }] } })
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Frozen', steps: [{ profile: slow.id, task: 'Think' }, { profile: writer.id, name: 'write', task: 'Original task' }] })
  const pending = rt.runWorkflow(workflow.id)
  await until(() => rt.workflowsView().running?.runId)
  rt.state.workflows[workflow.id].steps[1].task = 'Edited task'
  await host.api('workflow-delete', { id: workflow.id })
  const run = await pending
  assert.equal(run.status, 'done')
  assert.equal(runFile(home, run.id).snapshot.graph.nodes.find(node => node.id === 's2').task, 'Original task')
  const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
  assert.equal((await userLine(host, writer.id, write.id)).text, 'Original task')
}))

test('saving over a definition bumps its revision, refuses a stale one, and leaves a started run its own graph and input', async () => withRuntime(async ({ host, rt, role }) => {
  const slow = await host.api('profile-create', { name: 'Slow', engine: 'echo', workspace: (await host.api('state')).workspaces[0].id, engineOptions: { script: [{ kind: 'wait', ms: 300 }, { kind: 'text', text: 'Slow notes' }] } })
  const graph = task => ({ name: 'Reused', nodes: [{ id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', name: 'work', profileId: slow.id, task }, { id: 'end', kind: 'end', deliver: 'work' }],
    edges: [{ from: 'start', exit: 'done', to: 'work' }, { from: 'work', exit: 'done', to: 'end' }] })
  const workflow = await host.api('workflow-create', graph('First task'))
  const pending = rt.runWorkflow(workflow.id)
  await until(() => rt.workflowsView().running?.runId)
  const saved = await host.api('workflow-update', { id: workflow.id, revision: 1, ...graph('') })
  assert.equal(saved.id, workflow.id); assert.equal(saved.revision, 2); assert.equal(saved.createdAt, workflow.createdAt)
  assert.equal(rt.state.workflows[workflow.id].nodes[1].task, '')
  const stale = await host.post('workflow-update', { id: workflow.id, revision: 1, ...graph('Lost') })
  assert.equal(stale.error.code, 'orch/conflict')
  assert.equal((await host.post('workflow-update', { id: 'gone', revision: 1, ...graph('x') })).error.code, 'orch/not-found')
  assert.equal((await host.post('workflow-create', graph('Copy'))).error.code, 'orch/invalid', 'a second flow cannot take a used name')
  const other = await host.api('workflow-create', { ...graph('Other'), name: 'Other' })
  assert.equal((await host.post('workflow-update', { id: other.id, revision: 1, ...graph('Other') })).error.code, 'orch/invalid', 'nor be renamed onto one')
  assert.equal((await host.api('workflow-update', { id: other.id, revision: 1, ...graph('Kept'), name: 'Other' })).revision, 2, 'a flow keeps its own name')
  const run = await pending
  assert.equal(run.status, 'done')
  const detail = await host.api('run-get', { id: run.id })
  assert.deepEqual(detail.tasks.find(task => task.kind === 'agent').input, { text: 'First task' })
  assert.equal(detail.graph.nodes.find(node => node.id === 'work').task, 'First task')
}))

test('a definition saved before node graphs runs without being rewritten', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Old copy')
  const legacy = { id: 'legacy-flow', name: 'Legacy', steps: [{ name: 'write', profileId: writer.id, profileName: 'Writer', task: 'Write' }], createdAt: 1 }
  rt.state.workflows[legacy.id] = structuredClone(legacy)
  const run = await rt.runWorkflow(legacy.id)
  assert.equal(run.status, 'done')
  assert.equal(run.workflowRevision, 0)
  assert.deepEqual(run.snapshot.graph.nodes.map(node => node.id), ['start', 's1', 'end'])
  assert.deepEqual(rt.state.workflows[legacy.id], legacy)
  assert.equal(run.artifacts[run.final].text, 'Old copy')
}))

test('a legacy definition without a revision saves in place and survives the run-then-clear round trip', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const step = task => ({ name: 'write', profile: writer.id, task })
  const legacy = { id: 'legacy-flow', name: 'Legacy', steps: [step('Write')], createdAt: 1 }
  rt.state.workflows[legacy.id] = structuredClone(legacy)
  const saved = await host.api('workflow-update', { id: legacy.id, name: 'Legacy', steps: [step('Rewrite')] })
  assert.equal(saved.revision, 1, 'a missing revision counts as 0, so the first save lands instead of writing null')
  assert.equal((await host.api('workflow-update', { id: legacy.id, revision: 1, name: 'Legacy', steps: [step('Again')] })).revision, 2)
  rt.state.workflows[legacy.id].revision = null // what the pre-fix bug left on disk
  assert.equal((await host.api('workflow-update', { id: legacy.id, name: 'Legacy', steps: [step('Write')] })).revision, 1)
  assert.equal((await host.post('workflow-update', { id: legacy.id, revision: 9, name: 'Legacy', steps: [step('Late')] })).error.code, 'orch/conflict', 'a stale revision is still refused')
  const graph = task => ({ name: 'Legacy', nodes: [{ id: 'start', kind: 'start' }, { id: 's1', kind: 'agent', name: 'write', profileId: writer.id, task }, { id: 'end', kind: 'end', deliver: 's1' }],
    edges: [{ from: 'start', exit: 'done', to: 's1' }, { from: 's1', exit: 'done', to: 'end' }] })
  const run = await rt.runWorkflow((await host.api('workflow-update', { id: legacy.id, revision: 1, ...graph('Write') })).id)
  assert.deepEqual([run.status, run.workflowRevision], ['done', 2])
  const cleared = await host.api('workflow-update', { id: legacy.id, revision: 2, ...graph('') })
  assert.equal(cleared.revision, 3, 'the automatic clear after a run saves instead of conflicting')
}))

test('a flow whose fixed workspace vanishes mid-run stops the next step for a person', async () => withRuntime(async ({ host, rt, workspace, role }) => {
  const slow = await host.api('profile-create', { name: 'Slow', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'wait', ms: 200 }, { kind: 'text', text: 'Slow notes' }] } })
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Vanish', workspaceId: workspace.id, steps: [{ profile: slow.id, task: 'Think' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  await until(() => rt.workflowsView().running?.runId)
  delete rt.state.workspaces[workspace.id]
  const run = await pending
  assert.deepEqual([run.status, run.reason], ['waiting_human', 'workspace_missing'])
  assert.equal(Object.values(run.tasks).find(task => task.nodeId === 's2').reason, 'workspace_missing')
}))

test('a role edited before its step is dispatched stops the run for a person', async () => withRuntime(async ({ host, rt, role }) => {
  const researcher = await role('Researcher', 'Research notes')
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Gate', steps: [{ profile: researcher.id, task: 'Find' }, { decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question'))
  await host.api('profile-update', { id: writer.id, changes: { instructions: 'A new rule' } })
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const run = await pending
  assert.equal(run.status, 'waiting_human')
  assert.equal(run.reason, 'profile_changed')
  const gate = Object.values(run.tasks).find(task => task.nodeId === 's2')
  assert.equal(run.artifacts[gate.output].text, 'Decision "gate": 继续')
  assert.equal(run.requests[gate.requestId].status, 'answered')
  assert.equal(Object.values(run.tasks).find(task => task.nodeId === 's3').status, 'waiting_human')
  assert.equal((await workflowSessions(host, writer.id, 'Gate')).length, 0)
}))

test('a deleted role is rejected by new workflows and cannot execute a pending step', async () => withRuntime(async ({ host, rt, role }) => {
  const researcher = await role('Researcher', 'Research notes')
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Deleted role', steps: [{ profile: researcher.id, task: 'Find' }, { decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question'))
  await host.api('profile-delete', { id: writer.id })
  assert.equal((await host.post('workflow-create', { name: 'Invalid', steps: [{ profile: writer.id, task: 'Write' }] })).ok, false)
  assert.equal((await host.post('workflow-run', { id: workflow.id })).ok, false)
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const run = await pending
  assert.deepEqual([run.status, run.reason], ['waiting_human', 'profile_missing'])
  assert.equal((await workflowSessions(host, writer.id, 'Deleted role')).length, 0)
  assert.ok(rt.state.profiles[writer.id].deletedAt)
}))

test('a run keeps the model, thinking and permission its roles had when it started', async () => withRuntime(async ({ host, rt, role }) => {
  const researcher = await role('Researcher', 'Research notes')
  const writer = await role('Writer', 'Final copy')
  Object.assign(rt.state.profiles[writer.id], { model: 'model-a', thinking: 'low' })
  Object.assign(rt.conversation(writer.id).session, { permission: 'workspace' })
  const workflow = await host.api('workflow-create', { name: 'Pinned', steps: [{ profile: researcher.id, task: 'Find' }, { decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, name: 'write', task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question'))
  Object.assign(rt.state.profiles[writer.id], { model: 'model-b', thinking: 'high' })
  Object.assign(rt.conversation(writer.id).session, { permission: 'full' })
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const run = await pending
  assert.equal(run.status, 'done')
  const { model, thinking, permission } = run.snapshot.profiles[writer.id]
  assert.deepEqual({ model, thinking, permission }, { model: 'model-a', thinking: 'low', permission: 'workspace' })
  const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
  assert.deepEqual([write.model, write.thinking, write.permission], ['model-a', 'low', 'workspace'])
}))

test('a step stopped by its engine cancels the run', async () => withRuntime(async ({ host, rt, workspace }) => {
  const asker = await host.api('profile-create', { name: 'Asker', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'ask' }, { kind: 'text', text: 'never' }] } })
  const workflow = await host.api('workflow-create', { name: 'Stop', steps: [{ profile: asker.id, task: 'Ask first' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'permission'))
  await host.api('approval-answer', { id: card.id, decision: 'deny' })
  const run = await pending
  assert.equal(run.status, 'cancelled')
  const attempt = Object.values(run.attempts)[0]
  assert.deepEqual(attempt.end, { reason: 'interrupted' })
}))

const questionCard = async host => until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question'))

test('a decision card survives a restart and its answer carries the run on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-workflows-'))
  let host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Flow', cwd: join(home, 'ws') })
    const writer = await host.api('profile-create', { name: 'Writer', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'text', text: 'Final copy' }] } })
    const workflow = await host.api('workflow-create', { name: 'Restart', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, name: 'write', task: 'Write' }] })
    void (await host.runtime).runWorkflow(workflow.id)
    const card = await questionCard(host)
    host.dispose()
    host = boot(home)
    const restored = await questionCard(host)
    assert.deepEqual([restored.id, restored.reason, restored.name], [card.id, 'Go on?', 'Restart'])
    await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
    const runId = card.id.split(':')[1]
    const run = await until(() => { const saved = runFile(home, runId); return saved.status === 'done' && saved })
    assert.equal(run.artifacts[run.final].text, 'Final copy')
    assert.deepEqual((await host.api('state')).approvals, [])
    assert.equal((await host.api('state')).workflows.running, null)
    const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
    assert.deepEqual((await userLine(host, writer.id, write.id)).references[0], { source: { kind: 'user', step: 'gate' }, messages: [{ text: 'Decision "gate": 继续' }], decision: { question: 'Go on?', choice: '继续' } })
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('an old run waiting on a text-only question returns marked legacy and takes no answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-workflows-'))
  let host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Flow', cwd: join(home, 'ws') })
    const writer = await host.api('profile-create', { name: 'Writer', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'text', text: 'Final copy' }] } })
    const workflow = await host.api('workflow-create', { name: 'Old', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, name: 'write', task: 'Write' }] })
    void (await host.runtime).runWorkflow(workflow.id)
    const card = await questionCard(host)
    const runId = card.id.split(':')[1]
    host.dispose()
    // Rewind the run file to the text-only shape an older host wrote.
    const saved = runFile(home, runId)
    const gate = saved.snapshot.graph.nodes.find(node => node.kind === 'human')
    delete gate.options
    gate.allowText = true
    saved.snapshot.graph.edges.find(edge => edge.from === gate.id).exit = 'answered'
    const request = saved.requests[Object.values(saved.tasks).find(task => task.nodeId === gate.id).requestId]
    delete request.options
    request.allowText = true
    writeFileSync(join(home, 'runs', `${runId}.json`), JSON.stringify(saved))
    host = boot(home)
    const restored = await questionCard(host)
    assert.equal(restored.id, card.id)
    assert.deepEqual(restored.detail.exits, [])
    assert.equal(restored.detail.legacy, true)
    const refused = await host.post('approval-answer', { id: card.id, decision: 'answer', value: '继续吧' })
    assert.equal(refused.error.code, 'orch/invalid')
    await host.api('run-cancel', { id: runId })
    assert.deepEqual((await host.api('state')).approvals, [], 'cancelling the run is the way out')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('the same answer twice is taken once and a different one is refused', async () => withRuntime(async ({ host, rt, home, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Twice', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const run = await pending
  assert.equal(run.status, 'done')
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const conflict = await host.post('approval-answer', { id: card.id, decision: 'answer', exit: 'continue', value: 'no' })
  assert.equal(conflict.error.code, 'orch/stale')
  const saved = runFile(home, run.id)
  assert.equal(saved.revision, run.revision)
  assert.equal(saved.events.filter(event => event.type === 'request/answer').length, 1)
}))

test('an answer to an older version of the question is refused', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Versions', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const runId = card.id.split(':')[1]
  await rt.commit(runId, (draft) => { Object.values(draft.requests)[0].version = 2 })
  const old = await host.post('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  assert.equal(old.error.code, 'orch/stale')
  const current = await questionCard(host)
  assert.equal(current.id, card.id.replace(/:1$/, ':2'))
  assert.equal((await host.api('state')).approvals.length, 1)
  await host.api('approval-answer', { id: current.id, decision: 'answer', exit: 'continue' })
  assert.equal((await pending).status, 'done')
}))

test('a cancelled decision voids its question and refuses a later answer', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Cancel', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const runId = card.id.split(':')[1]
  await rt.commit(runId, (draft, event) => halt(draft, event, Object.values(draft.tasks).find(task => task.requestId), 'cancelled', 'cancelled'))
  const late = await host.post('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  assert.equal(late.error.code, 'orch/stale')
  const run = await pending
  assert.equal(run.status, 'cancelled')
  assert.equal(Object.values(run.requests)[0].status, 'void')
  assert.deepEqual((await host.api('state')).approvals, [])
  assert.equal((await workflowSessions(host, writer.id, 'Cancel')).length, 0)
}))

const flowOf = async (host, workspace, engine, name, extra = []) => {
  const step = await host.api('profile-create', { name: `${name} role`, engine, workspace: workspace.id })
  return host.api('workflow-create', { name, steps: [{ profile: step.id, name: 'work', task: 'Work' }, ...extra] })
}
const attemptOf = run => Object.values(run.attempts)[0]

test('cancelling a step in progress interrupts it and dispatches nothing after it', async () => withRuntime(async ({ host, rt, home, workspace, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await flowOf(host, workspace, 'stoppable', 'Stop', [{ profile: writer.id, task: 'Never' }])
  const pending = rt.runWorkflow(workflow.id)
  const runId = await until(() => rt.workflowsView().running?.runId)
  await until(() => Object.values(runFile(home, runId).attempts)[0]?.phase === 'running')
  const run = await rt.cancelRun(runId)
  assert.equal(run.status, 'cancelled')
  assert.deepEqual(await pending, run)
  assert.deepEqual([attemptOf(run).phase, attemptOf(run).end], ['ended', { reason: 'interrupted' }])
  assert.ok(run.events.some(event => event.type === 'attempt/phase' && event.data.phase === 'cancelling'))
  assert.deepEqual(Object.values(run.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'cancelled']])
  assert.equal(rt.workflowsView().running, null)
  assert.equal((await workflowSessions(host, writer.id, 'Stop')).length, 0)
  assert.equal((await rt.cancelRun(runId)).revision, run.revision)
}))

test('a stop the engine never confirms leaves the step to be reconciled', async () => withRuntime(async ({ host, rt, home, workspace }) => {
  const workflow = await flowOf(host, workspace, 'stubborn', 'Stuck')
  const pending = rt.runWorkflow(workflow.id, { limits: { cancelConfirmMs: 100 } })
  const runId = await until(() => rt.workflowsView().running?.runId)
  await until(() => Object.values(runFile(home, runId).attempts)[0]?.phase === 'running')
  const run = await rt.cancelRun(runId)
  assert.deepEqual(await pending, run)
  assert.deepEqual([run.status, run.reason], ['needs_reconcile', 'stop_unconfirmed'])
  assert.deepEqual([attemptOf(run).phase, attemptOf(run).end], ['cancelling', undefined])
  assert.equal(Object.values(run.tasks).find(task => task.nodeId === 's1').status, 'needs_reconcile')
  await assert.rejects(rt.cancelRun(runId), error => error.code === 'orch/invalid')
}))

test('a reply arriving after the cancel took effect is kept for audit only', async () => withRuntime(async ({ host, rt, home, workspace }) => {
  const workflow = await flowOf(host, workspace, 'finisher', 'Race')
  const pending = rt.runWorkflow(workflow.id)
  const runId = await until(() => rt.workflowsView().running?.runId)
  await until(() => Object.values(runFile(home, runId).attempts)[0]?.phase === 'running')
  const run = await rt.cancelRun(runId)
  await pending
  assert.equal(run.status, 'cancelled')
  assert.deepEqual(attemptOf(run).end, { reason: 'interrupted' })
  assert.equal(attemptOf(run).reply, undefined)
  assert.deepEqual(Object.keys(run.artifacts), [])
  assert.deepEqual(run.events.filter(event => event.type === 'audit/late').map(event => event.data), [{ reason: 'done' }])
}))

test('a cancel after a step completed keeps its output and cancels what follows', async () => withRuntime(async ({ host, rt, home, workspace, role }) => {
  const researcher = await role('Researcher', 'Research notes')
  const workflow = await host.api('workflow-create', { name: 'After', steps: [{ profile: researcher.id, task: 'Find' }, { decide: true, name: 'gate', question: 'Go on?' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const runId = card.id.split(':')[1]
  const run = await rt.cancelRun(runId)
  assert.deepEqual(await pending, run)
  const [first, gate] = ['s1', 's2'].map(nodeId => Object.values(run.tasks).find(task => task.nodeId === nodeId))
  assert.equal(first.status, 'done')
  assert.equal(run.artifacts[first.output].text, 'Research notes')
  assert.equal(gate.status, 'cancelled')
  assert.equal(runFile(home, runId).status, 'cancelled')
}))

test('cancelling a run waiting on a person voids the question without an answer', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Wait', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const run = await rt.cancelRun(card.id.split(':')[1])
  assert.equal(run.status, 'cancelled')
  assert.deepEqual(await pending, run)
  assert.equal(Object.values(run.requests)[0].status, 'void')
  assert.deepEqual((await host.api('state')).approvals, [])
  assert.equal(rt.workflowsView().running, null)
  const late = await host.post('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  assert.equal(late.error.code, 'orch/stale')
  assert.equal((await workflowSessions(host, writer.id, 'Wait')).length, 0)
  const other = await host.api('workflow-create', { name: 'Next', steps: [{ profile: writer.id, task: 'Write' }] })
  assert.equal((await rt.runWorkflow(other.id)).status, 'done')
}))

test('a question restored after a restart can be cancelled without an answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-workflows-'))
  let host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Flow', cwd: join(home, 'ws') })
    const writer = await host.api('profile-create', { name: 'Writer', engine: 'echo', workspace: workspace.id })
    const workflow = await host.api('workflow-create', { name: 'Restored', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
    void (await host.runtime).runWorkflow(workflow.id)
    const card = await questionCard(host)
    host.dispose()
    host = boot(home)
    await questionCard(host)
    const run = await (await host.runtime).cancelRun(card.id.split(':')[1])
    assert.equal(run.status, 'cancelled')
    assert.equal(Object.values(run.requests)[0].status, 'void')
    assert.deepEqual((await host.api('state')).approvals, [])
    assert.equal((await host.post('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })).error.code, 'orch/stale')
    assert.equal((await workflowSessions(host, writer.id, 'Restored')).length, 0)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a role edited before dispatch leaves a run that can be cancelled', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Held', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  await host.api('profile-update', { id: writer.id, changes: { instructions: 'A new rule' } })
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  const held = await pending
  assert.equal(held.status, 'waiting_human')
  const run = await rt.cancelRun(held.id)
  assert.equal(run.status, 'cancelled')
  assert.equal(Object.values(run.tasks).find(task => task.nodeId === 's2').status, 'cancelled')
}))

test('a cancel that cannot be saved keeps the question and the wait for it', async () => withRuntime(async ({ host, rt, home, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Kept', steps: [{ decide: true, name: 'gate', question: 'Go on?' }, { profile: writer.id, task: 'Write' }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  chmodSync(join(home, 'runs'), 0o500)
  try {
    await assert.rejects(rt.cancelRun(card.id.split(':')[1]))
  } finally { chmodSync(join(home, 'runs'), 0o700) }
  assert.equal((await questionCard(host)).id, card.id)
  await host.api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
  assert.equal((await pending).status, 'done')
}))

const deliver = async ({ host, rt, workspace, role }, engine) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await flowOf(host, workspace, engine, engine, [{ profile: writer.id, task: 'Write' }])
  const run = await rt.runWorkflow(workflow.id)
  const nextSent = (await sessionsOf(host, writer.id)).some(session => session.source?.workflowId === workflow.id)
  return { run, attempt: attemptOf(run), task: Object.values(run.tasks).find(task => task.nodeId === 's1'), nextSent }
}

test('a step whose message never reached the engine stops the run for a person', async () => withRuntime(async (context) => {
  const { run, attempt, nextSent } = await deliver(context, 'unsent')
  assert.deepEqual([run.status, run.reason, attempt.end], ['waiting_human', 'ended error', { reason: 'error' }])
  assert.equal(nextSent, false)
}))

test('a step whose send receipt failed is left to be reconciled, not failed', async () => withRuntime(async (context) => {
  const { run, attempt, task, nextSent } = await deliver(context, 'lost-ack')
  assert.deepEqual([run.status, run.reason, task.status], ['needs_reconcile', 'end_unconfirmed', 'needs_reconcile'])
  assert.deepEqual(attempt.end, { reason: 'error', unconfirmed: true })
  assert.deepEqual(Object.values(run.tasks).map(item => item.nodeId), ['start', 's1'])
  assert.equal(nextSent, false)
  await assert.rejects(context.rt.cancelRun(run.id), error => error.code === 'orch/invalid')
}))

test('a host save failing after the send leaves the step to be reconciled', async () => withRuntime(async (context) => {
  const save = context.rt.save
  context.rt.save = (...args) => {
    if (!failNextSave.armed) return save(...args)
    failNextSave.armed = false
    return Promise.reject(new Error('disk full'))
  }
  try {
    const { run, attempt, nextSent } = await deliver(context, 'save-fails')
    assert.deepEqual([run.status, run.reason, attempt.end], ['needs_reconcile', 'end_unconfirmed', { reason: 'error', unconfirmed: true }])
    assert.equal(nextSent, false)
  } finally { context.rt.save = save }
}))

test('an end the engine reported stands when the send receipt fails afterwards', async () => withRuntime(async (context) => {
  const { run, attempt } = await deliver(context, 'ended-ack')
  assert.equal(run.status, 'done')
  assert.deepEqual(attempt.end, { reason: 'done' })
  assert.equal(run.artifacts[attempt.reply].text, 'Done copy')
  const lines = await context.host.api('transcript', { profile: attempt.profileId, session: attempt.sessionId })
  assert.equal(lines.some(line => line.kind === 'error'), false)
}))

// Like withRuntime, with `restart(between)`: the host stops, `between` runs, and a new host boots on the same home.
const withRestarts = async (run) => {
  const home = mkdtempSync(join(tmpdir(), 'orch-workflows-'))
  const context = { home, host: boot(home) }
  context.restart = async (between) => {
    context.host.dispose()
    await between?.()
    context.host = boot(home)
    context.rt = await context.host.runtime
  }
  try {
    context.rt = await context.host.runtime
    context.workspace = await context.host.api('workspace-create', { name: 'Flow', cwd: join(home, 'ws') })
    context.role = (name, text) => context.host.api('profile-create', { name, engine: 'echo', workspace: context.workspace.id, engineOptions: { script: [{ kind: 'text', text }] } })
    await run(context)
  } finally { context.host.dispose(); rmSync(home, { recursive: true, force: true }) }
}
const settled = (rt, home, id) => until(() => rt.workflowsView().running === null && runFile(home, id))
const workflowSessions = async (host, profileId, name) => {
  const view = await host.api('state'), workflow = view.workflows.definitions.find(item => item.name === name)
  return view.profiles.find(profile => profile.id === profileId).sessions.filter(session => session.source?.workflowId === workflow?.id && session.source?.kind === 'workflow')
}
const userLines = async (host, profileId, sessionId) => (await host.api('transcript', { profile: profileId, session: sessionId })).filter(line => line.who === 'user')

test('old run views derive a task title from their snapshot without renaming their sessions', async () => withRestarts(async context => {
  const writer = await context.role('Writer', 'Final copy')
  const workflow = await context.host.api('workflow-create', { name: '开发', steps: [{ profile: writer.id, name: '执行', task: '修复登录白屏' }] })
  const run = await context.rt.runWorkflow(workflow.id)
  const sessionId = Object.values(run.attempts)[0].sessionId
  await context.host.api('session-update', { profile: writer.id, session: sessionId, changes: { name: '人工标题' } })
  await context.restart(() => {
    const legacy = runFile(context.home, run.id)
    delete legacy.title
    writeFileSync(join(context.home, 'runs', `${run.id}.json`), JSON.stringify(legacy))
  })
  await context.host.api('workflow-delete', { id: workflow.id })
  assert.equal((await context.host.api('run-get', { id: run.id })).title, '修复登录白屏')
  assert.equal((await context.host.api('run-list')).find(item => item.id === run.id).title, '修复登录白屏')
  assert.equal((await sessionsOf(context.host, writer.id)).find(session => session.id === sessionId).name, '人工标题')
  assert.equal(runFile(context.home, run.id).title, undefined)
}))

test('a crash before the step reached its conversation is reconciled, and holds its workspace until then', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const other = await context.role('Other', 'Other copy')
  const workflow = await context.host.api('workflow-create', { name: 'Crash', steps: [{ profile: writer.id, name: 'write', task: 'Write' }] })
  context.rt.createSession = () => new Promise(() => {})
  void context.rt.runWorkflow(workflow.id)
  const runId = await until(() => context.rt.workflowsView().running?.runId)
  await until(() => attemptOf(runFile(context.home, runId))?.phase === 'dispatching')
  await context.restart()
  const { host, rt, home } = context
  const run = runFile(home, runId)
  assert.deepEqual([run.status, run.reason, attemptOf(run).phase, attemptOf(run).workspaceId], ['needs_reconcile', 'interrupted', 'interrupted', context.workspace.id])
  assert.equal(Object.values(run.tasks).find(task => task.nodeId === 's1').status, 'needs_reconcile')
  assert.deepEqual(await workflowSessions(host, writer.id, 'Crash'), [])

  const blocked = await rt.runWorkflow((await host.api('workflow-create', { name: 'Next', steps: [{ profile: other.id, task: 'Go' }] })).id)
  assert.deepEqual([blocked.status, blocked.reason], ['waiting_human', 'workspace_occupied'])
  assert.deepEqual(await workflowSessions(host, other.id, 'Next'), [])

  await rt.reconcileRun(runId, { action: 'retry', reason: 'It never started' })
  const done = await settled(rt, home, runId)
  assert.equal(done.status, 'done')
  assert.deepEqual(Object.values(done.attempts).map(attempt => attempt.phase), ['interrupted', 'ended'])
  assert.equal(done.artifacts[done.final].text, 'Final copy')
  await rt.reconcileRun(blocked.id, { action: 'retry', reason: 'The workspace is free' })
  assert.equal((await settled(rt, home, blocked.id)).status, 'done')
}))

test('a conversation made but not bound before a crash is bound at restart and reused by the retry', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const workflow = await context.host.api('workflow-create', { name: 'Made', steps: [{ profile: writer.id, name: 'write', task: 'Write' }] })
  const create = context.rt.createSession
  context.rt.createSession = async (...args) => { await create(...args); return new Promise(() => {}) }
  void context.rt.runWorkflow(workflow.id)
  const [session] = await until(async () => { const found = await workflowSessions(context.host, writer.id, 'Made'); return found.length > 0 && found })
  const decoy = await create(writer.id, session.name, context.workspace.id, true)
  await context.host.api('session-update', { profile: writer.id, session: session.id, changes: { name: '人工改过的会话标题' } })
  const runId = context.rt.workflowsView().running.runId
  await context.restart()
  const { host, rt, home } = context
  const run = runFile(home, runId)
  assert.deepEqual([run.status, attemptOf(run).phase, attemptOf(run).sessionId, attemptOf(run).unsent], ['needs_reconcile', 'interrupted', session.id, true])
  const done = await rt.reconcileRun(runId, { action: 'retry', reason: 'Nothing was sent' })
  assert.equal(done.status, 'done')
  assert.deepEqual(Object.values(done.attempts).map(attempt => attempt.sessionId), [session.id, session.id])
  assert.deepEqual((await workflowSessions(host, writer.id, 'Made')).map(item => item.id), [session.id])
  assert.notEqual(attemptOf(run).sessionId, decoy.id, 'a conversation with the same task title is not bound')
  assert.equal((await workflowSessions(host, writer.id, 'Made'))[0].name, '人工改过的会话标题')
  assert.equal((await userLines(host, writer.id, session.id)).length, 1)
}))

test('a crash after the send but before its receipt was saved sends nothing again', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const workflow = await context.host.api('workflow-create', { name: 'Sent', steps: [{ profile: writer.id, name: 'write', task: 'Write' }] })
  const send = context.rt.send
  let placed
  context.rt.send = (...args) => { placed = send(...args); return new Promise(() => {}) }
  void context.rt.runWorkflow(workflow.id)
  const runId = await until(() => context.rt.workflowsView().running?.runId)
  await (await until(() => placed)).completion
  const [session] = await workflowSessions(context.host, writer.id, 'Sent')
  await context.restart()
  const run = runFile(context.home, runId)
  assert.deepEqual([run.status, run.reason, attemptOf(run).phase, attemptOf(run).sessionId], ['needs_reconcile', 'interrupted', 'interrupted', session.id])
  await context.restart()
  assert.equal(runFile(context.home, runId).revision, run.revision)

  const { host, rt, home } = context
  await rt.reconcileRun(runId, { action: 'accept', text: 'Copy I read in its conversation', reason: 'The engine had replied' })
  const done = await settled(rt, home, runId)
  const s1 = Object.values(done.tasks).find(task => task.nodeId === 's1')
  assert.deepEqual([done.status, s1.provenance, done.artifacts[done.final].provenance, done.artifacts[done.final].text], ['done', 'human', 'human', 'Copy I read in its conversation'])
  assert.deepEqual((await workflowSessions(host, writer.id, 'Sent')).map(item => item.id), [session.id])
  assert.equal((await userLines(host, writer.id, session.id)).length, 1)
}))

test('a crash after a step was saved but before its successor gets the successor once', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const workflow = await context.host.api('workflow-create', { name: 'Gap', steps: [{ profile: writer.id, name: 'write', task: 'Write' }] })
  const { id: runId } = await context.rt.runWorkflow(workflow.id)
  await context.restart(() => {
    const saved = runFile(context.home, runId)
    delete saved.tasks[Object.values(saved.tasks).find(task => task.nodeId === 'end').id]
    delete saved.final
    delete saved.endedAt
    writeFileSync(join(context.home, 'runs', `${runId}.json`), JSON.stringify({ ...saved, status: 'running' }))
  })
  await context.restart()
  const { host, rt, home } = context
  const run = runFile(home, runId)
  assert.deepEqual(Object.values(run.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'done'], ['end', 'needs_reconcile']])
  assert.deepEqual([run.status, run.reason], ['needs_reconcile', 'host_restarted'])
  const shown = await host.api('run-get', { id: runId })
  const end = Object.values(run.tasks).find(task => task.nodeId === 'end')
  assert.deepEqual(shown.tasks.map(task => [task.kind, task.status]), [['agent', 'done'], ['end', 'needs_reconcile']], 'the end task a person must settle is shown')
  assert.equal(shown.settle, end.id)
  await assert.rejects(rt.reconcileRun(runId, { action: 'accept', text: 'x', reason: 'y' }), error => error.code === 'orch/invalid')

  await rt.reconcileRun(runId, { action: 'retry', reason: 'Go on' })
  const done = await settled(rt, home, runId)
  assert.deepEqual(Object.values(done.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'done'], ['end', 'done']])
  assert.equal(done.artifacts[done.final].text, 'Final copy')
  assert.equal((await workflowSessions(host, writer.id, 'Gap')).length, 1)
}))

test('a step ended unconfirmed holds its workspace after its run let go, until a person accepts it', async () => withRuntime(async (context) => {
  const { host, rt, home } = context
  const { run } = await deliver(context, 'lost-ack')
  const other = await context.role('Other', 'Other copy')
  const elsewhere = await host.api('workspace-create', { name: 'Elsewhere', cwd: join(home, 'ws2') })
  const outside = await host.api('profile-create', { name: 'Outside', engine: 'echo', workspace: elsewhere.id })
  const next = async profileId => rt.runWorkflow((await host.api('workflow-create', { name: `Next ${++nexts}`, steps: [{ profile: profileId, task: 'Go' }] })).id)
  const blocked = await next(other.id)
  assert.deepEqual([blocked.status, blocked.reason], ['waiting_human', 'workspace_occupied'])
  assert.equal((await next(outside.id)).status, 'done')

  await assert.rejects(rt.reconcileRun(run.id, { action: 'accept', reason: 'Checked' }), error => error.code === 'orch/invalid')
  await assert.rejects(rt.reconcileRun(run.id, { action: 'retry' }), error => error.code === 'orch/invalid')
  const still = await rt.reconcileRun(blocked.id, { action: 'retry', reason: 'Too early' })
  assert.deepEqual([still.status, still.reason], ['waiting_human', 'workspace_occupied'])
  await host.api('secret-set', { name: 'GITHUB_TOKEN', value: 'ghp_supersecret123', purpose: 'test' })
  const done = await rt.reconcileRun(run.id, { action: 'accept', text: 'Draft I checked', reason: 'The engine did finish, ghp_supersecret123' })
  assert.equal(done.status, 'done')
  assert.equal(readFileSync(join(home, 'runs', `${run.id}.json`), 'utf8').includes('ghp_supersecret123'), false)
  const write = Object.values(done.attempts).at(-1)
  assert.deepEqual((await userLine(host, write.profileId, write.sessionId)).references[0], { source: { kind: 'user', step: 'work' }, messages: [{ text: 'Draft I checked' }] })
  const freed = await rt.reconcileRun(blocked.id, { action: 'retry', reason: 'The workspace is free' })
  assert.deepEqual([freed.status, freed.reason, Object.values(freed.tasks).find(task => task.nodeId === 's1').reason], ['done', undefined, undefined])
}))

test('a step whose stop was never confirmed cannot be settled while it still runs', async () => withRuntime(async ({ host, rt, home, workspace }) => {
  const workflow = await flowOf(host, workspace, 'stubborn', 'Stuck')
  void rt.runWorkflow(workflow.id, { limits: { cancelConfirmMs: 100 } })
  const runId = await until(() => rt.workflowsView().running?.runId)
  await until(() => attemptOf(runFile(home, runId))?.phase === 'running')
  await rt.cancelRun(runId)
  for (const action of [{ action: 'retry', reason: 'Again' }, { action: 'accept', text: 'Copy', reason: 'Fine' }]) {
    await assert.rejects(rt.reconcileRun(runId, action), error => error.code === 'orch/busy')
  }
  await assert.rejects(rt.cancelRun(runId, { reason: 'Give up' }), error => error.code === 'orch/busy')
  assert.equal(runFile(home, runId).status, 'needs_reconcile')
}))

test('a step saved before attempts kept their workspace still holds the one of its conversation', async () => withRestarts(async (context) => {
  const lost = await context.host.api('profile-create', { name: 'Lost', engine: 'lost-ack', workspace: context.workspace.id })
  const { id: runId } = await context.rt.runWorkflow((await context.host.api('workflow-create', { name: 'Old', steps: [{ profile: lost.id, task: 'Work' }] })).id)
  const other = await context.role('Other', 'Other copy')
  const elsewhere = await context.host.api('workspace-create', { name: 'Elsewhere', cwd: join(context.home, 'ws2') })
  const outside = await context.host.api('profile-create', { name: 'Outside', engine: 'echo', workspace: elsewhere.id })
  const strip = (...keys) => () => {
    const saved = runFile(context.home, runId)
    for (const key of keys) delete attemptOf(saved)[key]
    writeFileSync(join(context.home, 'runs', `${runId}.json`), JSON.stringify(saved))
  }
  const next = async profileId => context.rt.runWorkflow((await context.host.api('workflow-create', { name: `Next ${++nexts}`, steps: [{ profile: profileId, task: 'Go' }] })).id)

  await context.restart(strip('workspaceId'))
  assert.equal(runFile(context.home, runId).status, 'needs_reconcile')
  assert.equal((await next(other.id)).reason, 'workspace_occupied')
  assert.equal((await next(outside.id)).status, 'done')

  await context.restart(strip('sessionId'))
  assert.equal((await next(outside.id)).reason, 'workspace_occupied')
  assert.equal((await context.rt.reconcileRun(runId, { action: 'accept', text: 'Checked copy', reason: 'Read it' })).status, 'done')
  assert.equal((await next(outside.id)).status, 'done')
}))

test('an unreadable run file neither stops other runs nor is changed', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const workflow = await context.host.api('workflow-create', { name: 'Fine', steps: [{ profile: writer.id, task: 'Write' }] })
  const broken = join(context.home, 'runs', '00000000-0000-4000-8000-000000000000.json')
  await context.restart(() => { mkdirSync(join(context.home, 'runs'), { recursive: true }); writeFileSync(broken, '{ not json') })
  assert.equal((await context.rt.runWorkflow(workflow.id)).status, 'done')
  assert.equal(readFileSync(broken, 'utf8'), '{ not json')
  assert.equal((await context.rt.listRuns()).find(run => run.id === '00000000-0000-4000-8000-000000000000').status, 'unreadable')
}))

test('a run waiting to be reconciled is given up only with a reason, which frees its workspace', async () => withRuntime(async (context) => {
  const { host, rt, home, role } = context
  const { run } = await deliver(context, 'lost-ack')
  const other = await role('Other', 'Other copy')
  const next = async () => rt.runWorkflow((await host.api('workflow-create', { name: `Next ${++nexts}`, steps: [{ profile: other.id, task: 'Go' }] })).id)
  assert.equal((await next()).reason, 'workspace_occupied')
  await assert.rejects(rt.cancelRun(run.id), error => error.code === 'orch/invalid')
  assert.equal(runFile(home, run.id).revision, run.revision)
  const given = await rt.cancelRun(run.id, { reason: 'Checked the engine: it stopped' })
  assert.deepEqual([given.status, given.reason], ['cancelled', 'cancelled: Checked the engine: it stopped'])
  assert.deepEqual(Object.values(given.tasks).map(task => [task.nodeId, task.status]), [['start', 'done'], ['s1', 'cancelled']])
  assert.equal((await next()).status, 'done')
}))

test('the channel starts, lists, shows, cancels and reconciles runs without waiting for them', async () => withRuntime(async ({ host, rt, home, workspace, role }) => {
  const writer = await role('Writer', 'Final copy')
  const stop = await host.api('profile-create', { name: 'Stop role', engine: 'stoppable', workspace: workspace.id })
  const workflow = await host.api('workflow-create', { name: 'Slow', steps: [{ profile: stop.id, name: 'work', task: 'Work' }, { profile: writer.id, task: 'Never' }] })
  const { started, runId } = await host.api('workflow-run', { id: workflow.id })
  assert.equal(started, true)
  assert.equal(runFile(home, runId).status, 'running', 'the answer comes while the run still runs')
  await assert.rejects(host.api('workflow-run', { id: workflow.id }), error => error.code === 'orch/busy')
  await until(() => attemptOf(runFile(home, runId))?.phase === 'running')
  assert.deepEqual((await host.api('state')).runs.map(item => [item.id, item.status]), [[runId, 'running']])
  const shown = await host.api('run-get', { id: runId })
  assert.deepEqual(shown.tasks.map(task => [task.name, task.kind, task.status]), [['work', 'agent', 'active']])
  const [attempt] = shown.tasks[0].attempts
  assert.deepEqual([attempt.n, attempt.phase, attempt.profileId, attempt.profileName], [1, 'running', stop.id, 'Stop role'])
  assert.equal(attempt.sessionId, attemptOf(runFile(home, runId)).sessionId)
  assert.equal('snapshot' in shown || 'events' in shown, false)
  const cancelled = await host.api('run-cancel', { id: runId })
  assert.deepEqual([cancelled.status, cancelled.tasks[0].status], ['cancelled', 'cancelled'])
  assert.deepEqual((await host.api('state')).runs, [])
  assert.deepEqual((await host.api('run-list')).map(item => [item.id, item.status]), [[runId, 'cancelled']])

  const gate = await host.api('workflow-create', { name: 'Gate', steps: [{ decide: true, name: 'gate', question: 'Go?' }, { profile: writer.id, name: 'write', task: 'Write' }] })
  const { runId: gated } = await host.api('workflow-run', { id: gate.id })
  const asked = await until(async () => (await host.api('run-get', { id: gated })).tasks.find(task => task.card))
  assert.equal(asked.card, (await host.api('state')).approvals.find(card => card.kind === 'question').id)
  await host.api('run-cancel', { id: gated })
  for (const [payload, code] of [[{ id: gated, action: 'skip', reason: 'x' }, 'orch/invalid'], [{ id: gated, action: 'retry' }, 'orch/invalid'],
    [{ id: gated, action: 'accept', reason: 'x' }, 'orch/invalid'], [{ id: gated, action: 'retry', reason: 'x' }, 'orch/stale'], [{ id: 'nope', action: 'retry', reason: 'x' }, 'orch/not-found']]) {
    await assert.rejects(host.api('run-reconcile', payload), error => error.code === code)
  }
  await assert.rejects(host.api('run-get', { id: 'nope' }), error => error.code === 'orch/not-found')

  const lost = await host.api('profile-create', { name: 'Lost', engine: 'lost-ack', workspace: workspace.id })
  const { runId: unknown } = await host.api('workflow-run', { id: (await host.api('workflow-create', { name: 'Lost', steps: [{ profile: lost.id, task: 'Work' }, { profile: writer.id, name: 'write', task: 'Write' }] })).id })
  await until(() => runFile(home, unknown).status === 'needs_reconcile' && rt.workflowsView().running === null)
  const accepted = await host.api('run-reconcile', { id: unknown, action: 'accept', text: 'Copy I checked', reason: 'Read the session' })
  assert.equal(accepted.tasks[0].provenance, 'human')
  assert.equal(accepted.tasks[0].output, 'Copy I checked')
  const done = await until(async () => { const item = await host.api('run-get', { id: unknown }); return item.status === 'done' && item })
  assert.deepEqual(done.tasks.map(task => [task.name, task.status]), [['Lost', 'done'], ['write', 'done']])
  assert.equal(done.tasks[1].output, 'Final copy')
}))

test('a run file with missing references still shows what it has', async () => withRestarts(async (context) => {
  const writer = await context.role('Writer', 'Final copy')
  const { id: runId } = await context.rt.runWorkflow((await context.host.api('workflow-create', { name: 'Holes', steps: [{ profile: writer.id, name: 'write', task: 'Write' }] })).id)
  await context.restart(() => {
    const saved = runFile(context.home, runId)
    for (const id of Object.keys(saved.attempts)) delete saved.attempts[id]
    delete saved.snapshot.profiles
    writeFileSync(join(context.home, 'runs', `${runId}.json`), JSON.stringify(saved))
  })
  const shown = await context.host.api('run-get', { id: runId })
  assert.deepEqual(shown.tasks.map(task => [task.name, task.status, task.attempts.length]), [['write', 'done', 0]])
}))

// An engine that writes a valid exit line and then ends the turn in an error.
registerEngine('chooser-error', {
  info: { ...echoInfo, id: 'chooser-error', label: 'Chooser error (test)' },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    return {
      async openSession() {},
      sendTurn() {
        const turnId = `chooser-${++n}`
        setTimeout(() => {
          onEvent({ type: 'turn/start', turnId })
          onEvent({ type: 'text', turnId, text: 'Looks fine\nNEXT: approve' })
          onEvent({ type: 'turn/end', turnId, reason: 'error', error: 'boom' })
        }, 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})

// start → review (approve | revise) → publish | fix → their own end.
const reviewFlow = (host, name, reviewer, writer, change = graph => graph) => host.api('workflow-create', { name, ...change({
  nodes: [
    { id: 'start', kind: 'start' },
    { id: 'review', kind: 'agent', profile: reviewer.id, task: 'Review', exits: [{ id: 'approve', when: 'The draft is ready' }, { id: 'revise', when: 'It needs changes' }] },
    { id: 'publish', kind: 'agent', profile: writer.id, task: 'Publish' },
    { id: 'fix', kind: 'agent', profile: writer.id, task: 'Fix' },
    { id: 'end', kind: 'end', deliver: 'publish' },
    { id: 'end_fix', kind: 'end', deliver: 'fix' },
  ],
  edges: [
    { from: 'start', exit: 'done', to: 'review' },
    { from: 'review', exit: 'approve', to: 'publish' },
    { from: 'review', exit: 'revise', to: 'fix' },
    { from: 'publish', exit: 'done', to: 'end' },
    { from: 'fix', exit: 'done', to: 'end_fix' },
  ],
}) })
const pathOf = run => Object.values(run.tasks).map(task => [task.nodeId, task.status])

test('an agent takes the exit its last line names, and only a multi-exit step is told to choose', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  for (const [text, path] of [['Fine.\nNEXT: approve', ['publish', 'end']], ['Needs work.\n\n  NEXT:  revise  \n', ['fix', 'end_fix']]]) {
    const reviewer = await role(`Reviewer ${path[0]}`, text)
    const run = await rt.runWorkflow((await reviewFlow(host, `Review ${path[0]}`, reviewer, writer)).id)
    assert.equal(run.status, 'done')
    assert.deepEqual(pathOf(run), [['start', 'done'], ['review', 'done'], [path[0], 'done'], [path[1], 'done']])
    assert.equal(run.artifacts[run.final].text, 'Final copy')
    const review = Object.values(run.tasks).find(task => task.nodeId === 'review')
    assert.equal(run.artifacts[review.output].text, text.trim(), 'the report is kept whole')
  }
  assert.deepEqual(handoffs.map(handoff => handoff.exits?.map(exit => exit.id)), [['approve', 'revise'], undefined, ['approve', 'revise'], undefined])
}))

test('a step that reports blocked, or no exit that can be read, stops for a person', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const cases = [['Stuck: no draft\nNEXT: blocked', 'blocked'], ['No line at all', 'no_exit'], ['NEXT approve', 'no_exit'], ['**NEXT: approve**', 'no_exit'],
    ['NEXT: publish', 'no_exit'], ['NEXT: approve\nThen more text', 'no_exit']]
  const runs = []
  for (const [index, [text, reason]] of cases.entries()) {
    const reviewer = await role(`Reviewer ${index}`, text)
    const run = await rt.runWorkflow((await reviewFlow(host, `Stops ${index}`, reviewer, writer)).id)
    assert.deepEqual([run.status, run.reason], ['waiting_human', reason], text)
    assert.deepEqual(pathOf(run), [['start', 'done'], ['review', 'waiting_human']], text)
    const review = Object.values(run.tasks).find(task => task.nodeId === 'review')
    assert.equal(run.artifacts[review.output].text, text)
    runs.push(run)
  }
  assert.equal((await sessionsOf(host, writer.id)).some(session => session.source?.kind === 'workflow'), false)

  const stopped = runs[1]
  await assert.rejects(rt.reconcileRun(stopped.id, { action: 'accept', text: 'Read it myself', reason: 'Checked' }), error => error.code === 'orch/invalid' && /approve, revise/.test(error.message))
  await assert.rejects(rt.reconcileRun(stopped.id, { action: 'accept', text: 'Read it\nNEXT: blocked', reason: 'Checked' }), error => error.code === 'orch/invalid')
  const done = await rt.reconcileRun(stopped.id, { action: 'accept', text: 'Read it myself\nNEXT: revise', reason: 'Checked' })
  assert.equal(done.status, 'done')
  assert.deepEqual(pathOf(done), [['start', 'done'], ['review', 'done'], ['fix', 'done'], ['end_fix', 'done']])
}))

test('a turn that ends in an error does not take the exit its text names', async () => withRuntime(async ({ host, rt, workspace, role }) => {
  const writer = await role('Writer', 'Final copy')
  const reviewer = await host.api('profile-create', { name: 'Chooser', engine: 'chooser-error', workspace: workspace.id })
  const run = await rt.runWorkflow((await reviewFlow(host, 'Errs', reviewer, writer)).id)
  assert.deepEqual([run.status, run.reason], ['waiting_human', 'ended error'])
  assert.deepEqual(pathOf(run), [['start', 'done'], ['review', 'waiting_human']])
}))

test('a person\'s option sends the run down its own exit, and an answer that is none is refused', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const gated = async name => (await host.api('workflow-create', { name,
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'gate', kind: 'human', question: 'Publish?', options: [{ id: 'go', label: 'Go ahead' }, { id: 'stop', label: 'Stop here' }], allowText: false },
      { id: 'publish', kind: 'agent', profile: writer.id, task: 'Publish' },
      { id: 'end', kind: 'end', deliver: 'publish' },
      { id: 'end_stop', kind: 'end', deliver: 'gate' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'publish' }, { from: 'gate', exit: 'stop', to: 'end_stop' }, { from: 'publish', exit: 'done', to: 'end' }],
  })).id
  for (const [answer, path] of [['Stop here', ['end_stop']], ['Go ahead', ['publish', 'end']]]) {
    const pending = rt.runWorkflow(await gated(`Gate ${path[0]}`))
    const card = await questionCard(host)
    assert.deepEqual(card.detail, { exits: [{ id: 'go', label: 'Go ahead' }, { id: 'stop', label: 'Stop here' }] })
    const refused = await host.post('approval-answer', { id: card.id, decision: 'answer', value: 'Maybe' })
    assert.equal(refused.error.code, 'orch/invalid')
    assert.equal((await host.post('approval-answer', { id: card.id, decision: 'answer', exit: '$back', value: 'Again' })).error.code, 'orch/invalid', 'nothing before the question to send back to')
    assert.equal((await questionCard(host)).id, card.id)
    await host.api('approval-answer', { id: card.id, decision: 'answer', value: answer })
    const run = await pending
    assert.equal(run.status, 'done')
    assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'gate', ...path])
    assert.equal(run.artifacts[run.final].text, path[0] === 'end_stop' ? 'Decision "gate": Stop here' : 'Final copy')
  }
}))

test('a draft is saved however incomplete; a run needs one start, every exit wired, no loop and existing roles', async () => withRuntime(async ({ host, role }) => {
  const reviewer = await role('Critic', 'NEXT: approve')
  const writer = await role('Writer', 'Final copy')
  const edit = change => graph => { change(graph); return graph }
  const edge = (graph, from, exit) => graph.edges.find(item => item.from === from && item.exit === exit)
  const broken = {
    'no end': graph => ({ nodes: graph.nodes.filter(node => node.kind !== 'end'), edges: graph.edges.filter(item => !item.to.startsWith('end')) }),
    'two starts': edit(graph => graph.nodes.push({ id: 'again', kind: 'start' })),
    'a declared exit without an edge': edit(graph => graph.edges.splice(graph.edges.indexOf(edge(graph, 'review', 'revise')), 1)),
    'an edge from an undeclared exit': edit(graph => graph.edges.push({ from: 'review', exit: 'maybe', to: 'fix' })),
    'an exit wired twice': edit(graph => graph.edges.push({ from: 'review', exit: 'approve', to: 'fix' })),
    'a declared blocked exit': edit(graph => graph.nodes[1].exits.push({ id: 'blocked', when: 'Stuck' })),
    'an edge to no node': edit(graph => { edge(graph, 'fix', 'done').to = 'nowhere' }),
    'a loop': edit(graph => { edge(graph, 'fix', 'done').to = 'review' }),
    'a back edge as the only exit': edit(graph => Object.assign(edge(graph, 'fix', 'done'), { to: 'review', back: { max: 2 } })),
    'an end delivering nothing': edit(graph => { graph.nodes.find(node => node.id === 'end').deliver = 'start' }),
    'a missing role': edit(graph => { graph.nodes[2].profile = 'nobody' }),
    'a bad node id': edit(graph => { graph.nodes[2].id = 'Publish' }),
    'a work node without a task': edit(graph => { graph.nodes[2].task = '' }),
  }
  for (const [label, change] of Object.entries(broken)) {
    const saved = await host.api('workflow-create', { name: label, ...change(structuredClone((await reviewFlowGraph(reviewer, writer)))) })
    await assert.rejects(host.api('workflow-run', { id: saved.id }), error => error.code === 'orch/invalid', label)
  }
  assert.equal((await host.api('state')).workflows.definitions.length, Object.keys(broken).length)
  assert.deepEqual(await host.api('run-list'), [])
  const draft = await host.api('workflow-create', { name: 'Draft', nodes: [{ id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', profile: writer.id }, { id: 'end', kind: 'end', deliver: '' }], edges: [] })
  assert.deepEqual(draft.nodes[1], { id: 'work', kind: 'agent', name: 'Writer', profileId: writer.id, task: '', completion: 'text', session: 'new' })
  await assert.rejects(host.api('workflow-run', { id: draft.id }), error => error.code === 'orch/invalid' && /needs a task/.test(error.message))
  const saved = await reviewFlow(host, 'Saved', reviewer, writer)
  assert.equal(saved.steps, undefined)
  assert.deepEqual(saved.nodes.find(node => node.id === 'review'), { id: 'review', kind: 'agent', name: 'Critic', profileId: reviewer.id, task: 'Review', completion: 'text', session: 'new',
    exits: [{ id: 'approve', when: 'The draft is ready' }, { id: 'revise', when: 'It needs changes' }] })
}))
const reviewFlowGraph = async (reviewer, writer) => {
  let graph
  await reviewFlow({ api: async (endpoint, body) => { graph = body } }, '', reviewer, writer)
  return { nodes: graph.nodes, edges: graph.edges }
}

test('after a crash between a choice and its successor, the successor follows the exit chosen', async () => withRestarts(async (context) => {
  const reviewer = await context.role('Critic', 'Needs work\nNEXT: revise')
  const writer = await context.role('Writer', 'Final copy')
  const { id: runId } = await context.rt.runWorkflow((await reviewFlow(context.host, 'Gap', reviewer, writer)).id)
  await context.restart(() => {
    const saved = runFile(context.home, runId)
    for (const task of Object.values(saved.tasks)) if (['fix', 'end_fix'].includes(task.nodeId)) delete saved.tasks[task.id]
    delete saved.final
    delete saved.endedAt
    writeFileSync(join(context.home, 'runs', `${runId}.json`), JSON.stringify({ ...saved, status: 'running' }))
  })
  const { rt, home } = context
  assert.deepEqual(pathOf(runFile(home, runId)), [['start', 'done'], ['review', 'done'], ['fix', 'needs_reconcile']])
  await rt.reconcileRun(runId, { action: 'retry', reason: 'Go on' })
  const done = await settled(rt, home, runId)
  assert.deepEqual(pathOf(done), [['start', 'done'], ['review', 'done'], ['fix', 'done'], ['end_fix', 'done']])
}))

test('a start node under another id starts the run, and a single declared exit needs no NEXT line', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Begin',
    nodes: [{ id: 'begin', kind: 'start' }, { id: 'start', kind: 'agent', profile: writer.id, task: 'Write', exits: [{ id: 'only', when: 'Always,  first\n\n  when   done ' }] }, { id: 'end', kind: 'end', deliver: 'start' }],
    edges: [{ from: 'begin', exit: 'done', to: 'start' }, { from: 'start', exit: 'only', to: 'end' }] })
  assert.deepEqual(workflow.nodes[1].exits, [{ id: 'only', when: 'Always, first\nwhen done' }], 'each condition keeps its own line')
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.deepEqual(pathOf(run), [['begin', 'done'], ['start', 'done'], ['end', 'done']])
  assert.equal(run.artifacts[run.final].text, 'Final copy')
  assert.equal(handoffs[0].exits, undefined)
}))

test('an end reached without its deliverable fails the run instead of finishing it', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Off path',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'gate', kind: 'human', question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowText: false },
      { id: 'work_a', kind: 'agent', profile: writer.id, task: 'A' },
      { id: 'work_b', kind: 'agent', profile: writer.id, task: 'B' },
      { id: 'end_a', kind: 'end', deliver: 'work_b' },
      { id: 'end_b', kind: 'end', deliver: 'work_b' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'a', to: 'work_a' }, { from: 'gate', exit: 'b', to: 'work_b' },
      { from: 'work_a', exit: 'done', to: 'end_a' }, { from: 'work_b', exit: 'done', to: 'end_b' }] })
  const pending = rt.runWorkflow(workflow.id)
  await host.api('approval-answer', { id: (await questionCard(host)).id, decision: 'answer', value: 'A' })
  const run = await pending
  assert.deepEqual([run.status, run.reason, run.final], ['failed', 'missing_deliverable', undefined])
  assert.deepEqual(pathOf(run), [['start', 'done'], ['gate', 'done'], ['work_a', 'done'], ['end_a', 'failed']])
}))

test('a note travels with the chosen option as the user\'s decision, and a person may accept an option named blocked', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const workflow = await host.api('workflow-create', { name: 'Text',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'gate', kind: 'human', question: 'Go?', options: [{ id: 'go', label: 'Go' }, { id: 'blocked', label: 'Hold' }] },
      { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
      { id: 'end', kind: 'end', deliver: 'write' },
      { id: 'end_hold', kind: 'end', deliver: 'gate' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'go', to: 'write' }, { from: 'gate', exit: 'blocked', to: 'end_hold' }, { from: 'write', exit: 'done', to: 'end' }] })
  const pending = rt.runWorkflow(workflow.id)
  await host.api('approval-answer', { id: (await questionCard(host)).id, decision: 'answer', exit: 'go', value: 'Use the short title' })
  assert.deepEqual(pathOf(await pending).map(([nodeId]) => nodeId), ['start', 'gate', 'write', 'end'])
  const [write] = (await sessionsOf(host, writer.id)).filter(session => session.source?.workflowId === workflow.id)
  assert.deepEqual((await userLine(host, writer.id, write.id)).references[0].decision, { question: 'Go?', choice: 'Go', note: 'Use the short title' })

  const held = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const runId = card.id.split(':')[1]
  await rt.commit(runId, (draft, event) => halt(draft, event, Object.values(draft.tasks).find(task => task.nodeId === 'gate'), 'needs_reconcile', 'interrupted'))
  assert.equal((await host.post('approval-answer', { id: card.id, decision: 'answer', value: 'Hold' })).error.code, 'orch/stale')
  assert.equal((await held).status, 'needs_reconcile')
  const done = await rt.reconcileRun(runId, { action: 'accept', text: 'Hold', reason: 'Asked in person' })
  assert.equal(done.status, 'done')
  assert.deepEqual(pathOf(done).map(([nodeId]) => nodeId), ['start', 'gate', 'end_hold'])
}))

// Engines whose turn ends `done` with text but without the engine confirming it stopped.
const registerUnsureEngine = (id, text) => registerEngine(id, {
  info: { ...echoInfo, id, label: `${id} (test)` },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => {
    let n = 0
    return {
      async openSession() {},
      sendTurn() {
        const turnId = `${id}-${++n}`
        setTimeout(() => {
          onEvent({ type: 'turn/start', turnId })
          onEvent({ type: 'text', turnId, text })
          onEvent({ type: 'turn/end', turnId, reason: 'done', unconfirmed: true })
        }, 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }
  },
})
registerUnsureEngine('unsure-next', 'Report\nNEXT: approve')
registerUnsureEngine('unsure-blocked', 'Stuck\nNEXT: blocked')
registerUnsureEngine('unsure-none', 'Report without a line')

test('an end the engine did not confirm stops for reconciling whatever exit its text names', async () => withRuntime(async ({ host, rt, home, role }) => {
  const writer = await role('Writer', 'Final copy')
  for (const [engine, single] of [['unsure-next'], ['unsure-blocked'], ['unsure-none'], ['unsure-next', true]]) {
    const name = `${engine}${single ? ' single' : ''}`
    const own = await host.api('workspace-create', { name, cwd: join(home, name) })
    const reviewer = await host.api('profile-create', { name, engine, workspace: own.id })
    const workflow = single
      ? await host.api('workflow-create', { name, steps: [{ profile: reviewer.id, task: 'Work' }, { profile: writer.id, task: 'Write' }] })
      : await reviewFlow(host, name, reviewer, writer)
    const run = await rt.runWorkflow(workflow.id)
    assert.deepEqual([run.status, run.reason], ['needs_reconcile', 'end_unconfirmed'], name)
    assert.deepEqual(pathOf(run), [['start', 'done'], [single ? 's1' : 'review', 'needs_reconcile']], name)
    assert.deepEqual(attemptOf(run).end, { reason: 'done', unconfirmed: true })
    assert.equal(run.final, undefined)
    const neighbour = await host.api('profile-create', { name: `${name} neighbour`, engine: 'echo', workspace: own.id, engineOptions: { script: [{ kind: 'text', text: 'x' }] } })
    const next = await rt.runWorkflow((await host.api('workflow-create', { name: `After ${name}`, steps: [{ profile: neighbour.id, task: 'Go' }] })).id)
    assert.deepEqual([next.status, next.reason], ['waiting_human', 'workspace_occupied'], name)
  }
  assert.deepEqual((await sessionsOf(host, writer.id)).filter(session => session.source?.kind === 'workflow'), [])
}))

// An engine replying with the next text of `replies` on each turn, in any conversation.
const registerSequenceEngine = (id, replies) => {
  let n = 0
  registerEngine(id, {
    info: { ...echoInfo, id, label: `${id} (test)` },
    validate: validateEchoOptions,
    check: checkEcho,
    create: ({ onEvent }) => ({
      async openSession() {},
      sendTurn() {
        const turnId = `${id}-${++n}`
        const reply = replies[Math.min(n, replies.length) - 1]
        const text = reply !== null && typeof reply === 'object' ? reply.text : reply
        setTimeout(() => { onEvent({ type: 'turn/start', turnId }); if (text !== null) onEvent({ type: 'text', turnId, text }); onEvent({ type: 'turn/end', turnId, reason: text === null ? 'error' : 'done', ...(reply?.unconfirmed ? { unconfirmed: true } : {}) }) }, 0)
        return Promise.resolve(turnId)
      },
      steer: async () => STEER.REFUSED,
      async compact() {},
      async interruptTurn() {},
      async respondToRequest() { return false },
      onEvent() {},
      hasSession: () => true,
      dispose() {},
    }),
  })
}
registerSequenceEngine('drafts', ['Draft 1', 'Draft 2', 'Draft 3', 'Draft 4'])
registerSequenceEngine('critic-once', ['Too long\nNEXT: revise', 'Good now\nNEXT: approve'])
registerSequenceEngine('critic-never', ['Too long\nNEXT: revise'])
registerSequenceEngine('redrafts', ['Draft A', 'Draft B', 'Draft C'])
registerSequenceEngine('flaky', [null, 'Recovered'])
registerSequenceEngine('flaky-moved', [null, 'Fresh copy'])

// A writer whose message "HOLD" runs until released; workflow turns cycle through
// a draft, an error, and a second draft, in any conversation.
let gatedTurns = 0
const held = { release: null }
registerEngine('gated-review', {
  info: { ...echoInfo, id: 'gated-review', label: 'gated-review (test)' },
  validate: validateEchoOptions,
  check: checkEcho,
  create: ({ onEvent }) => ({
    async openSession() {},
    sendTurn(text) {
      if (text === 'HOLD') {
        onEvent({ type: 'turn/start', turnId: 'gated-hold' })
        return new Promise(resolve => { held.release = () => { onEvent({ type: 'text', turnId: 'gated-hold', text: 'Held' }); onEvent({ type: 'turn/end', turnId: 'gated-hold', reason: 'done' }); resolve() } })
      }
      const n = ++gatedTurns, turnId = `gated-${n}`, phase = n % 3
      setTimeout(() => {
        onEvent({ type: 'turn/start', turnId })
        if (phase === 2) onEvent({ type: 'turn/end', turnId, reason: 'error', error: 'boom' })
        else { onEvent({ type: 'text', turnId, text: phase === 1 ? 'Draft 1' : 'Draft 2' }); onEvent({ type: 'turn/end', turnId, reason: 'done' }) }
      }, 0)
      return Promise.resolve(turnId)
    },
    steer: async () => STEER.REFUSED,
    async compact() {},
    async interruptTurn() {},
    async respondToRequest() { return false },
    onEvent() {},
    hasSession: () => true,
    dispose() {},
  }),
})

// start → write → review (approve → end | revise → back to write).
let nexts = 0
const loopFlow = (host, name, writer, reviewer, back = {}) => host.api('workflow-create', { name,
  nodes: [
    { id: 'start', kind: 'start' },
    { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
    { id: 'review', kind: 'agent', profile: reviewer.id, task: 'Review', exits: [{ id: 'approve', when: 'The draft is ready' }, { id: 'revise', when: 'It needs changes' }] },
    { id: 'end', kind: 'end', deliver: 'write' },
  ],
  edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'review' }, { from: 'review', exit: 'approve', to: 'end' }, { from: 'review', exit: 'revise', to: 'write', back }] })
const roleOn = (host, workspace, name, engine) => host.api('profile-create', { name, engine, workspace: workspace.id })
const outputsOf = (run, nodeId) => Object.values(run.tasks).filter(task => task.nodeId === nodeId).map(task => run.artifacts[task.output]?.text)

test('a step that ends in an error waits for a person, and a retry goes on in its conversation with their reason', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Flaky', 'flaky')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Retry', nodes: [{ id: 'start', kind: 'start' }, { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' }, { id: 'end', kind: 'end', deliver: 'write' }],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'end' }] })
  const stopped = await rt.runWorkflow(workflow.id)
  assert.deepEqual([stopped.status, stopped.reason], ['waiting_human', 'ended error'])
  const done = await rt.reconcileRun(stopped.id, { action: 'retry', reason: '继续任务' })
  assert.equal(done.status, 'done')
  assert.equal(done.artifacts[done.final].text, 'Recovered')
  const write = Object.values(done.tasks).find(task => task.nodeId === 'write')
  const [first, second] = write.attempts.map(id => done.attempts[id].sessionId)
  assert.equal(second, first, 'the retry goes on in the conversation the error ended')
  assert.deepEqual(handoffs.map(handoff => handoff.retry), [undefined, { note: '继续任务', resumed: true }])
  assert.match(render(handoffs[1]), /Your earlier turn on this step, above in this conversation, stopped before finishing it\. The user asked to try again: 继续任务\nContinue the step from where it stopped/)

  const mover = await roleOn(host, workspace, 'Mover', 'flaky-moved')
  const moved = await rt.runWorkflow((await host.api('workflow-create', { name: 'Moved', nodes: [{ id: 'start', kind: 'start' }, { id: 'write', kind: 'agent', profile: mover.id, task: 'Write' }, { id: 'end', kind: 'end', deliver: 'write' }],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'end' }] })).id)
  const gone = attemptOf(moved).sessionId
  await host.api('session-archive', { profile: mover.id, session: gone, archived: true })
  const fresh = await rt.reconcileRun(moved.id, { action: 'retry', reason: '换个会话继续' })
  assert.equal(fresh.status, 'done')
  assert.notEqual(Object.values(fresh.attempts).at(-1).sessionId, gone, 'an archived conversation is not reused')
  assert.deepEqual(handoffs.at(-1).retry, { note: '换个会话继续', resumed: false })
  assert.match(render(handoffs.at(-1)), /An earlier attempt at this step stopped before finishing it\. The user asked to try again: 换个会话继续\nCheck what it already left in the files/)

  const send = rt.send
  rt.send = () => { rt.send = send; throw new Error('没发出去') }
  const silent = await rt.runWorkflow((await host.api('workflow-create', { name: 'Silent', nodes: [{ id: 'start', kind: 'start' }, { id: 'write', kind: 'agent', profile: mover.id, task: 'Write' }, { id: 'end', kind: 'end', deliver: 'write' }],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'end' }] })).id)
  assert.match(silent.reason, /^not sent: 没发出去$/)
  const quiet = await rt.reconcileRun(silent.id, { action: 'retry', reason: '再试一次' })
  assert.equal(quiet.status, 'done')
  const [unsent, resent] = Object.values(quiet.attempts)
  assert.equal(resent.sessionId, unsent.sessionId, 'a message that was never sent keeps its empty conversation')
  assert.deepEqual(handoffs.at(-1).retry, { note: '再试一次', resumed: false }, 'without an earlier turn the retry cannot claim one above')
  assert.match(render(handoffs.at(-1)), /An earlier attempt at this step stopped before finishing it\. The user asked to try again: 再试一次\nCheck what it already left in the files/)
}))

test('a retry after a failed fresh rework stays in the rework conversation, or starts another once it is archived', async () => withRuntime(async ({ host, rt, home, workspace }) => {
  const writer = await roleOn(host, workspace, 'Gated', 'gated-review')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const boundSession = async runId => {
    const file = runFile(home, runId)
    const task = Object.values(file.tasks).filter(item => item.nodeId === 'write').at(-1)
    return task.current && file.attempts[task.current]?.sessionId
  }
  // The first conversation is held busy, so answering 返工 starts the rework afresh,
  // and that rework attempt dies in an engine error before the hold is released.
  const busyRework = async name => {
    const workflow = await host.api('workflow-create', { name, nodes: [
      { id: 'start', kind: 'start' },
      { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
      { id: 'review', kind: 'human', options: [{ id: 'accept', label: '接受' }, { id: 'revise', label: '返工' }] },
      { id: 'end', kind: 'end', deliver: 'write' } ],
      edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'review' }, { from: 'review', exit: 'accept', to: 'end' }, { from: 'review', exit: 'revise', to: 'write', back: {} }] })
    const started = rt.runWorkflow(workflow.id)
    const [first] = await until(async () => { const found = await workflowSessions(host, writer.id, name); return found.length > 0 && found })
    await host.api('send', { profile: writer.id, text: 'HOLD', session: first.id })
    await until(async () => (await host.api('state')).work[first.id]?.active === true)
    await host.api('approval-answer', { id: (await questionCard(host)).id, decision: 'answer', exit: 'revise', value: '请修改' })
    const stopped = await started
    assert.deepEqual([stopped.status, stopped.reason], ['waiting_human', 'ended error'])
    const second = (await workflowSessions(host, writer.id, name)).find(session => session.id !== first.id)
    assert.equal(Object.values(stopped.attempts).at(-1).sessionId, second.id, 'the busy first conversation made the rework start afresh')
    return { first, second, stopped }
  }
  const answerAccept = async pending => {
    await host.api('approval-answer', { id: (await questionCard(host)).id, decision: 'answer', exit: 'accept' })
    return pending
  }

  let { first, second, stopped } = await busyRework('Rework')
  held.release()
  await until(async () => (await host.api('state')).work[first.id]?.active !== true)
  const seen = handoffs.length
  const retried = answerAccept(rt.reconcileRun(stopped.id, { action: 'retry', reason: '继续返工' }))
  await until(async () => handoffs.length > seen)
  assert.equal(await until(boundSession.bind(null, stopped.id)), second.id, 'the retry stays in the conversation the failed rework used')
  const [rework, retry] = handoffs.slice(-2)
  assert.deepEqual([rework.rework, retry.rework], ['fresh', 'fresh'])
  assert.deepEqual(retry.retry, { note: '继续返工', resumed: true })
  assert.deepEqual([rework, retry].map(handoff => handoff.artifacts.map(artifact => artifact.messages[0].text)),
    [['Draft 1', 'Decision "review": 返工\n请修改'], ['Draft 1', 'Decision "review": 返工\n请修改']])
  assert.match(render(retry), /Your earlier turn on this step, above in this conversation, stopped before finishing it\. The user asked to try again: 继续返工\nContinue the step from where it stopped/)
  const done = await retried
  assert.equal(done.artifacts[done.final].text, 'Draft 2')

  ;({ first, second, stopped } = await busyRework('Rework Gone'))
  await host.api('session-archive', { profile: writer.id, session: second.id, archived: true })
  held.release()
  await until(async () => (await host.api('state')).work[first.id]?.active !== true)
  const again = handoffs.length
  const restarted = answerAccept(rt.reconcileRun(stopped.id, { action: 'retry', reason: '换会话返工' }))
  await until(async () => handoffs.length > again)
  const third = await until(boundSession.bind(null, stopped.id))
  assert.notEqual(third, first.id)
  assert.notEqual(third, second.id, 'an archived rework conversation is not reused either')
  assert.deepEqual(handoffs.at(-1).retry, { note: '换会话返工', resumed: false })
  assert.equal((await restarted).status, 'done')
}))

for (const target of ['write', 'middle', 'review']) {
  for (const node of ['write', 'middle', 'review']) {
    const engine = `retry-${target}-${node}`
    const texts = node === 'review' ? ['Needs changes\nNEXT: revise', 'Approved\nNEXT: approve', 'Approved\nNEXT: approve'] : ['First report', 'Unconfirmed rework', 'Confirmed rework']
    registerSequenceEngine(engine, texts.map((text, index) => node === target && index === 1 ? { text, unconfirmed: true } : text))
  }
  test(`an unconfirmed ${target} after send-back retries without returning to its earlier report conversation`, async () => withRuntime(async ({ host, rt, workspace }) => {
    const roles = {}
    for (const node of ['write', 'middle', 'review']) roles[node] = await roleOn(host, workspace, `${target} ${node}`, `retry-${target}-${node}`)
    const workflow = await host.api('workflow-create', { name: `Unconfirmed ${target}`, nodes: [
      { id: 'start', kind: 'start' },
      ...['write', 'middle'].map(id => ({ id, kind: 'agent', profile: roles[id].id, task: id })),
      { id: 'review', kind: 'agent', profile: roles.review.id, task: 'Review', exits: [{ id: 'approve', when: 'Ready' }, { id: 'revise', when: 'Needs changes' }] },
      { id: 'end', kind: 'end', deliver: 'write' },
    ], edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'middle' }, { from: 'middle', exit: 'done', to: 'review' },
      { from: 'review', exit: 'approve', to: 'end' }, { from: 'review', exit: 'revise', to: 'write', back: { max: 1 } }] })
    const send = rt.send
    let first, sends = 0
    rt.send = async (...args) => {
      const placed = await send(...args)
      if (args[0] !== roles[target].id || ++sends !== 1) return placed
      first = args[2]
      return { ...placed, completion: placed.completion.then(async outcome => {
        await host.api('session-archive', { profile: roles[target].id, session: first, archived: true })
        return outcome
      }) }
    }
    const stopped = await rt.runWorkflow(workflow.id)
    assert.deepEqual([stopped.status, stopped.reason], ['needs_reconcile', 'end_unconfirmed'])
    const task = Object.values(stopped.tasks).filter(item => item.nodeId === target).at(-1)
    const second = stopped.attempts[task.current].sessionId
    assert.notEqual(second, first, 'the archived earlier report forces a fresh rework or rerun conversation')
    await host.api('session-archive', { profile: roles[target].id, session: first, archived: false })
    const done = await rt.reconcileRun(stopped.id, { action: 'retry', reason: 'Confirmed the earlier execution stopped' })
    assert.equal(done.status, 'done')
    const retried = done.attempts[done.tasks[task.id].current]
    assert.notEqual(retried.sessionId, first, 'retry must not return to the earlier report now that it is available again')
    assert.notEqual(retried.sessionId, second, 'an unconfirmed attempt starts a fresh conversation')
    assert.equal(done.tasks[task.id].attempts.length, 2)
    assert.equal((await userLine(host, roles[target].id, retried.sessionId)).text, target === 'review' ? 'Review' : target)
  }))
}

test('a step sent back reworks in its earlier conversation with only the feedback, and the step that sent it back reads the new output in its own', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'drafts')
  const reviewer = await roleOn(host, workspace, 'Critic', 'critic-once')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const send = rt.send
  let renamed = false
  rt.send = async (...args) => {
    if (args[0] === reviewer.id && !renamed) {
      const [session] = await workflowSessions(host, writer.id, 'Loop')
      await host.api('session-update', { profile: writer.id, session: session.id, changes: { name: '人工保留的修复记录' } })
      renamed = true
    }
    return send(...args)
  }
  const workflow = await loopFlow(host, 'Loop', writer, reviewer, { max: 1 })
  assert.deepEqual(workflow.edges.at(-1), { from: 'review', exit: 'revise', to: 'write', back: { max: 1 } })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'write', 'review', 'write', 'review', 'end'])
  assert.deepEqual(outputsOf(run, 'write'), ['Draft 1', 'Draft 2'])
  assert.equal(run.artifacts[run.final].text, 'Draft 2')

  const writes = Object.values(run.tasks).filter(task => task.nodeId === 'write')
  const [first, again] = writes.map(task => run.attempts[task.current].sessionId)
  assert.equal(again, first, 'the rework goes on in the earlier conversation')
  assert.equal((await workflowSessions(host, writer.id, 'Loop')).length, 1)
  assert.equal((await workflowSessions(host, writer.id, 'Loop'))[0].name, '人工保留的修复记录')
  const lines = await userLines(host, writer.id, first)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[1].references.map(reference => reference.messages[0].text), ['Too long\nNEXT: revise'])
  const reviews = Object.values(run.tasks).filter(task => task.nodeId === 'review').map(task => run.attempts[task.current].sessionId)
  assert.equal(reviews[1], reviews[0], 'the step that sent it back reviews again in its own conversation')
  assert.equal((await workflowSessions(host, reviewer.id, 'Loop'))[0].name, 'Write · Review')
  assert.deepEqual(handoffs.map(handoff => [handoff.stepName, handoff.rework ?? handoff.rerun, handoff.artifacts.map(artifact => artifact.messages[0].text)]), [
    ['Writer', undefined, []],
    ['Critic', undefined, ['Draft 1']],
    ['Writer', 'resumed', ['Too long\nNEXT: revise']],
    ['Critic', 'resumed', ['Draft 2']],
  ])
  assert.match(render(handoffs[2]), /This step was sent back: your earlier report/)
  assert.match(render(handoffs[3]), /Your earlier report for this step is above in this conversation\.\nReports updated since then: Writer;/)
}))

test('a back edge taken as often as it may be stops for a person, who can still send the run on', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'drafts')
  const reviewer = await roleOn(host, workspace, 'Critic', 'critic-never')
  for (const [back, rounds] of [[{ max: 1 }, 2], [{}, 3]]) {
    const run = await rt.runWorkflow((await loopFlow(host, `Limit ${rounds}`, writer, reviewer, back)).id)
    assert.deepEqual([run.status, run.reason], ['waiting_human', 'back_limit'])
    assert.equal(outputsOf(run, 'write').length, rounds)
    assert.deepEqual(pathOf(run).at(-1), ['review', 'waiting_human'])
    if (rounds === 3) {
      const done = await rt.reconcileRun(run.id, { action: 'accept', text: 'Fine as it is\nNEXT: approve', reason: 'Enough rounds' })
      assert.equal(done.status, 'done')
      assert.equal(done.artifacts[done.final].text, outputsOf(run, 'write').at(-1))
    }
  }
}))

test('a step sent back by a person starts afresh, with its earlier output, when its conversation is gone', async () => withRuntime(async ({ host, rt, role }) => {
  const writer = await role('Writer', 'Final copy')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Gate',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
      { id: 'gate', kind: 'human', question: 'Good?', options: [{ id: 'ok', label: 'Ship it' }, { id: 'again', label: 'Again' }], allowText: false },
      { id: 'end', kind: 'end', deliver: 'write' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'ok', to: 'end' }, { from: 'gate', exit: 'again', to: 'write', back: {} }] })
  const pending = rt.runWorkflow(workflow.id)
  const card = await questionCard(host)
  const [earlier] = await workflowSessions(host, writer.id, 'Gate')
  await host.api('session-archive', { profile: writer.id, session: earlier.id, archived: true })
  await host.api('approval-answer', { id: card.id, decision: 'answer', value: 'Again' })
  await host.api('approval-answer', { id: (await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question' && entry.id !== card.id))).id, decision: 'answer', value: 'Ship it' })
  const run = await pending
  assert.equal(run.status, 'done')
  assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'write', 'gate', 'write', 'gate', 'end'])
  const sessions = Object.values(run.tasks).filter(task => task.nodeId === 'write').map(task => run.attempts[task.current].sessionId)
  assert.notEqual(sessions[1], sessions[0])
  assert.deepEqual([handoffs[1].rework, handoffs[1].artifacts.map(artifact => artifact.messages[0].text)], ['fresh', ['Final copy', 'Decision "gate": Again']])
  assert.match(render(handoffs[1]), /its earlier report and what came after it are available through the report index below/)
}))

test('a person sends a step back without a wire, with a note it reworks from in its own conversation, as often as the limit allows', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'redrafts')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Check',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
      { id: 'gate', kind: 'human', options: [{ id: 'ok', label: 'Ship it' }] },
      { id: 'end', kind: 'end', deliver: 'write' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'gate' }, { from: 'gate', exit: 'ok', to: 'end' }] })
  const pending = rt.runWorkflow(workflow.id)
  const asked = new Set()
  const next = async () => {
    const card = await until(async () => (await host.api('state')).approvals.find(entry => entry.kind === 'question' && !asked.has(entry.id)))
    asked.add(card.id)
    return card
  }
  const first = await next()
  assert.equal(first.reason, '查看「Writer」的产出，选择下一步', 'a question with no prompt is titled after the report it shows')
  assert.deepEqual(first.detail, { exits: [{ id: 'ok', label: 'Ship it' }], back: 'Writer', report: { step: 'Writer', text: 'Draft A', more: false } })
  assert.equal((await host.post('approval-answer', { id: first.id, decision: 'answer', exit: '$back' })).error.code, 'orch/invalid', 'sending back needs a note')
  await host.api('approval-answer', { id: first.id, decision: 'answer', exit: '$back', value: 'Shorter title' })
  const second = await next()
  assert.equal(second.detail.report.text, 'Draft B')
  await host.api('approval-answer', { id: second.id, decision: 'answer', exit: '$back', value: 'Even shorter' })
  await host.api('approval-answer', { id: (await next()).id, decision: 'answer', exit: '$back', value: 'Once more' })
  const run = await pending
  assert.deepEqual([run.status, run.reason], ['waiting_human', 'back_limit'])
  assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'write', 'gate', 'write', 'gate', 'write', 'gate'])
  const sessions = Object.values(run.tasks).filter(task => task.nodeId === 'write').map(task => run.attempts[task.current].sessionId)
  assert.equal(new Set(sessions).size, 1)
  assert.deepEqual([handoffs[1].rework, handoffs[1].artifacts.map(artifact => artifact.decision)], ['resumed', [{ choice: '退回上一步', note: 'Shorter title' }]])
  assert.match(render(handoffs[1]), /^# Your step\nWrite[\s\S]*## User decisions[\s\S]*Note:\nShorter title/)
  assert.doesNotMatch(render(handoffs[1]), /## Reports so far/)
}))

test('a back edge runs only to a node that leads to it, within its limit, beside a way forward; its shape is checked when saved', async () => withRuntime(async ({ host, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'drafts')
  const reviewer = await roleOn(host, workspace, 'Critic', 'critic-once')
  const graph = async () => {
    let body
    await loopFlow({ api: async (endpoint, sent) => { body = sent } }, 'x', writer, reviewer)
    return body
  }
  const incomplete = {
    'a limit above five': body => { body.edges[3].back = { max: 6 } },
    'a limit of zero': body => { body.edges[3].back = { max: 0 } },
    'a loop not marked back': body => { delete body.edges[3].back },
    'a back edge forward': body => { body.edges[1].back = {} },
    'a node with only a back exit': body => { body.nodes[2].exits = undefined; body.edges.splice(2, 2, { from: 'review', exit: 'done', to: 'write', back: {} }) },
  }
  for (const [label, change] of Object.entries(incomplete)) {
    const body = await graph()
    change(body)
    body.name = label
    const saved = await host.api('workflow-create', body)
    await assert.rejects(host.api('workflow-run', { id: saved.id }), error => error.code === 'orch/invalid', label)
  }
  for (const value of [true, null, 'yes', 1, []]) {
    const body = await graph()
    body.edges[3].back = value
    assert.equal((await host.post('workflow-create', body)).error?.code, 'orch/invalid', `back as ${JSON.stringify(value)}`)
  }
  assert.equal((await host.api('state')).workflows.definitions.length, Object.keys(incomplete).length)
}))

registerSequenceEngine('notes', ['Middle note'])
registerSequenceEngine('critic-twice', ['Needs work\nNEXT: revise', 'Good now\nNEXT: approve'])
registerSequenceEngine('self-critic', ['First pass\nNEXT: again', 'Second pass\nNEXT: ok'])

test('a step resumed in its conversation gets only the report that sent it back, past any step between, and the steps after it go on in theirs', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'drafts')
  const middle = await roleOn(host, workspace, 'Middle', 'notes')
  const reviewer = await roleOn(host, workspace, 'Critic', 'critic-twice')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Between',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'write', kind: 'agent', profile: writer.id, task: 'Write' },
      { id: 'middle', kind: 'agent', profile: middle.id, task: 'Note' },
      { id: 'review', kind: 'agent', profile: reviewer.id, task: 'Review', exits: [{ id: 'approve', when: 'Ready' }, { id: 'revise', when: 'Needs changes' }] },
      { id: 'end', kind: 'end', deliver: 'write' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'write' }, { from: 'write', exit: 'done', to: 'middle' }, { from: 'middle', exit: 'done', to: 'review' },
      { from: 'review', exit: 'approve', to: 'end' }, { from: 'review', exit: 'revise', to: 'write', back: {} }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'write', 'middle', 'review', 'write', 'middle', 'review', 'end'])
  const resumed = handoffs.find(handoff => handoff.rework === 'resumed')
  assert.equal(resumed.stepName, 'Writer')
  assert.deepEqual(resumed.artifacts.map(artifact => artifact.messages[0].text), ['Needs work\nNEXT: revise'])
  assert.match(render(resumed), /the referenced report or user decision sent it back/)
  for (const nodeId of ['write', 'middle', 'review']) {
    const sessions = Object.values(run.tasks).filter(task => task.nodeId === nodeId).map(task => run.attempts[task.current].sessionId)
    assert.equal(sessions[1], sessions[0], `${nodeId} runs again in its own conversation`)
  }
  const redrafted = outputsOf(run, 'write')[1]
  assert.deepEqual(handoffs.slice(4).map(handoff => [handoff.stepName, handoff.rerun, handoff.artifacts.map(artifact => artifact.messages[0].text)]), [
    ['Middle', 'resumed', ['Needs work\nNEXT: revise', redrafted]],
    ['Critic', 'resumed', [redrafted, 'Middle note']],
  ])
}))

registerSequenceEngine('critic-gone', ['Too long\nNEXT: revise', 'Good now\nNEXT: approve'])

test('a step after a send-back starts afresh with every report when its conversation is gone', async () => withRuntime(async ({ host, rt, workspace }) => {
  const writer = await roleOn(host, workspace, 'Writer', 'drafts')
  const reviewer = await roleOn(host, workspace, 'Critic', 'critic-gone')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => {
    handoffs.push(handoff)
    if (handoffs.length === 3) {
      const [review] = rt.sessionsOf(rt.state.profiles[reviewer.id]).filter(session => session.source?.kind === 'workflow')
      review.archivedAt = Date.now()
    }
    return render(handoff)
  }
  const run = await rt.runWorkflow((await loopFlow(host, 'Gone', writer, reviewer, { max: 1 })).id)
  assert.equal(run.status, 'done')
  assert.deepEqual(pathOf(run).map(([nodeId]) => nodeId), ['start', 'write', 'review', 'write', 'review', 'end'])
  const reviews = Object.values(run.tasks).filter(task => task.nodeId === 'review').map(task => run.attempts[task.current].sessionId)
  assert.notEqual(reviews[1], reviews[0])
  assert.deepEqual([handoffs[3].rerun, handoffs[3].artifacts.map(artifact => artifact.messages[0].text)], [undefined, ['Too long\nNEXT: revise', outputsOf(run, 'write')[1]]])
}))

test('a step sent back to itself goes on in its own conversation with its own report', async () => withRuntime(async ({ host, rt, workspace }) => {
  const worker = await roleOn(host, workspace, 'Worker', 'self-critic')
  const handoffs = []
  const render = rt.renderHandoff
  rt.renderHandoff = (handoff) => { handoffs.push(handoff); return render(handoff) }
  const workflow = await host.api('workflow-create', { name: 'Self',
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'work', kind: 'agent', profile: worker.id, task: 'Work', exits: [{ id: 'ok', when: 'Done' }, { id: 'again', when: 'Another pass' }] },
      { id: 'end', kind: 'end', deliver: 'work' },
    ],
    edges: [{ from: 'start', exit: 'done', to: 'work' }, { from: 'work', exit: 'ok', to: 'end' }, { from: 'work', exit: 'again', to: 'work', back: { max: 1 } }] })
  const run = await rt.runWorkflow(workflow.id)
  assert.equal(run.status, 'done')
  assert.equal(run.artifacts[run.final].text, 'Second pass\nNEXT: ok')
  const sessions = Object.values(run.tasks).filter(task => task.nodeId === 'work').map(task => run.attempts[task.current].sessionId)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[1], sessions[0])
  assert.deepEqual([handoffs[1].rework, handoffs[1].artifacts.map(artifact => artifact.messages[0].text)], ['resumed', ['First pass\nNEXT: again']])
}))
