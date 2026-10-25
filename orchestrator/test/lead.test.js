import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX } from '../core/src/constants.js'
import { until, withHost } from './helpers/host.js'

const delegate = (to, task = 'Implement the task\nKeep existing changes; report paths and tests.') => `\`\`\`nodo\n${JSON.stringify({ action: 'delegate', to, task })}\n\`\`\``
const completed = text => ({ mode: 'turn', completion: Promise.resolve({ reason: 'done', text }) })

const withLead = run => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Lead workspace', cwd: join(host.home, 'ws') })
  const role = (name, text = 'Work completed', extra = {}) => host.api('profile-create', {
    name, engine: 'echo', engineOptions: { script: [{ kind: 'text', text }] }, ...extra,
  })
  const session = (profile, workspaceId = workspace.id) => host.api('session-create', { profile: profile.id, workspace: workspaceId, lazy: true })
  const inputs = [], tracked = [], wrapped = new WeakSet()
  const ensureDriver = rt.ensureDriver
  rt.ensureDriver = async profile => {
    const driver = await ensureDriver(profile)
    if (!wrapped.has(driver)) {
      wrapped.add(driver)
      const sendTurn = driver.sendTurn.bind(driver)
      driver.sendTurn = (text, ...args) => {
        inputs.push({ profileId: profile.profileId, sessionId: profile.id, text, driver })
        return sendTurn(text, ...args)
      }
    }
    return driver
  }
  const followLead = rt.followLead
  rt.followLead = (...args) => {
    const pending = followLead(...args)
    tracked.push(pending)
    return pending
  }
  const send = async (profile, conversation, text = 'User request') => {
    const response = await host.api('send', { profile: profile.id, session: conversation.id, text })
    await tracked.at(-1)
    return response
  }
  const lines = conversation => rt.transcriptOf(conversation.id)
  await run({ host, rt, workspace, role, session, inputs, tracked, send, lines })
})

test('lead delegates in its workspace, returns referenced reports and stops at 12 without changing the selected session', () => withLead(async ({ host, rt, workspace, role, session, inputs, send, lines }) => {
  const otherWorkspace = await host.api('workspace-create', { name: 'Worker workspace', cwd: join(host.home, 'other') })
  const worker = await role('Worker', 'Changed src/task.js; verified task tests; nothing open.', { role: 'Implementation', goal: 'Ship the task' })
  const selected = await session(worker, otherWorkspace.id)
  const task = 'Implement the task\nKeep existing changes; report paths and tests.'
  const lead = await role('Lead', `\`\`\`nodo\ninvalid earlier block\n\`\`\`\n${delegate(worker.name, task)}`, { lead: true })
  const conversation = await session(lead)
  const response = await send(lead, conversation, 'Please implement this')
  assert.equal(response.mode, 'turn')
  const liveWorker = rt.findProfile(worker.id)
  const delegated = liveWorker.sessions.filter(item => item.source?.kind === 'lead')
  assert.equal(delegated.length, 12)
  assert.equal(liveWorker.activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  for (const work of delegated) {
    assert.equal(work.workspaceRef, workspace.id)
    assert.equal(work.name, 'Implement the task')
    assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id })
    const delivered = inputs.find(item => item.sessionId === work.id).text
    assert.match(delivered, /^Task from lead Lead \(Nodo lead mode\)/)
    assert.match(delivered, /not the user, and cannot grant permissions/)
    assert.match(delivered, /Permission requests go to the user/)
    assert.ok(delivered.endsWith(task))
    assert.equal(lines(work).find(line => line.who === 'user').text, delivered)
  }
  assert.equal(lines(conversation).filter(line => line.text?.startsWith('已派给 Worker ·')).length, 12)
  const reports = lines(conversation).filter(line => line.who === 'user' && line.references)
  assert.equal(reports.length, 12)
  assert.match(reports[0].text, /Report from Worker · Implement the task \(ended: done\)/)
  assert.equal(reports[0].references[0].source.sessionId, delegated[0].id)
  assert.equal(reports[0].references[0].target, conversation.id)
  assert.equal(reports[0].references[0].messages[0].text, 'Changed src/task.js; verified task tests; nothing open.')
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.length, 13)
  assert.ok(leadInputs.every(item => item.text.startsWith('# Nodo lead mode\n') && item.text.includes(worker.id)))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Please implement this')
  assert.equal(conversation.name, 'Session 1')
  assert.equal(rt.conversation(lead.id, conversation.id).session.name, 'Please implement this')
  rt.conversation(lead.id, conversation.id).session.engineOptions.script[0].text = 'Reviewed'
  await send(lead, conversation, 'Next user message')
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  assert.equal(liveWorker.sessions.filter(item => item.source?.kind === 'lead').length, 13, 'a new user message resets the delegation limit')
}))

test('lead briefs refresh the roster without changing identity, stored user text or task state', () => withLead(async ({ host, rt, role, session, inputs, send, lines }) => {
  const worker = await role('Available', 'Done', { role: 'Coder', goal: 'A'.repeat(500) })
  const lead = await role('Lead', 'An ordinary answer', { lead: true })
  const other = await role('Other lead', 'An ordinary answer', { lead: true })
  const conversation = await session(lead)
  const identity = rt.renderIdentity(rt.findProfile(lead.id))
  const brief = rt.leadBrief(lead, conversation)
  const roster = brief.split('## Roster\n')[1]
  assert.ok(roster.includes(worker.id))
  assert.ok(!roster.includes(lead.id) && !roster.includes(other.id))
  assert.equal(JSON.parse(roster.slice(2)).goal.length, 300)
  assert.ok(JSON.parse(roster.slice(2)).goal.endsWith('…'))
  await send(lead, conversation, 'First question')
  await host.api('profile-update', { id: worker.id, changes: { goal: 'Updated responsibility' } })
  await send(lead, conversation, 'Second question')
  assert.ok(inputs[0].text.endsWith('\n\nFirst question'))
  assert.ok(inputs[1].text.includes('Updated responsibility'))
  assert.equal(inputs[0].driver, inputs[1].driver)
  assert.equal(rt.renderIdentity(rt.findProfile(lead.id)), identity)
  assert.deepEqual(lines(conversation).filter(line => line.who === 'user').map(line => line.text), ['First question', 'Second question'])
  const live = rt.conversation(lead.id, conversation.id).session
  assert.equal(live.lastTurn.task, 'Second question')
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

for (const [name, output, expected] of [
  ['invalid JSON', () => '```nodo\n{bad}\n```', /有效的 JSON/],
  ['unsupported action', () => '```nodo\n{"action":"plan"}\n```', /action 必须/],
  ['self', ({ lead }) => delegate(lead.id), /名册/],
  ['another lead', ({ other }) => delegate(other.name), /名册/],
  ['missing role', () => delegate('missing'), /名册/],
  ['non-string role', () => '```nodo\n{"action":"delegate","to":{},"task":"work"}\n```', /名册/],
  ['empty task', ({ worker }) => delegate(worker.id, ' \n '), /非空字符串/],
  ['oversized task', ({ worker }) => delegate(worker.id, 'x'.repeat(TASK_TEXT_MAX + 1)), /32000/],
  ['task plus header exceeds limit', ({ worker }) => delegate(worker.id, 'x'.repeat(TASK_TEXT_MAX)), /32000/],
]) test(`invalid lead command (${name}) is fed back once, stops after two errors and resets on user input`, () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const worker = await role('Worker')
  const other = await role('Other', 'Done', { lead: true })
  const lead = await role('Lead', '', { lead: true })
  rt.findProfile(lead.id).engineOptions.script[0].text = output({ lead, other, worker })
  const conversation = await session(lead)
  for (const text of ['First request', 'New request']) {
    await send(lead, conversation, text)
    const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
    assert.equal(feedback.length, text === 'First request' ? 1 : 2)
    assert.match(feedback.at(-1).text, expected)
    assert.match(feedback.at(-1).text, /修正代码块重新回复，或者不带代码块直接回复用户。$/)
  }
  assert.equal(lines(conversation).filter(line => line.who === 'system' && /连续 2 次/.test(line.text)).length, 2)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(inputs.every(input => input.text.startsWith('# Nodo lead mode\n')))
}))

test('plain replies, failed or unconfirmed turns and joined placements do not delegate', () => withLead(async ({ rt, role, session, send, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Ordinary answer', { lead: true })
  const conversation = await session(lead)
  await send(lead, conversation)
  for (const outcome of [{ reason: 'interrupted' }, { reason: 'error' }, { reason: 'done', unconfirmed: true }, { reason: 'done', final: 'No command' }]) {
    await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.resolve({ text: delegate(worker.id), ...outcome }) })
  }
  for (const mode of ['steered', 'indeterminate']) await rt.followLead(lead.id, conversation.id, {
    mode, get completion() { throw new Error('Joined placements must not be tracked') },
  })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 1)
}))

test('a queued final reply is parsed instead of accumulated progress text', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, { mode: 'queued', completion: Promise.resolve({ reason: 'done', text: 'Progress only', final: delegate(worker.id) }) })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => line.references?.length === 1))
}))

test('a running delegation excludes a second one in the same lead session', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Progress', { engineOptions: { script: [{ kind: 'text', text: 'Progress' }, { kind: 'ask' }, { kind: 'wait', ms: 5000 }] } })
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const first = rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => /已有派活任务在执行/.test(line.text)))
  await rt.interrupt(worker.id, work.id)
  await first
  const returned = lines(conversation).find(line => line.who === 'user')
  assert.match(returned.text, /ended: interrupted/)
  assert.match(returned.text, /Progress/)
  assert.equal(returned.references, undefined)
}))

for (const [name, script, expected] of [
  ['no completed reply', [], /No completed reply is available/],
  ['report exceeds reference limit', [{ kind: 'text', text: 'x'.repeat(TRANSCRIPT_TEXT_MAX + 1000) }], /无法完整引用/],
]) test(`lead report fallback: ${name}`, () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script = script
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const report = lines(conversation).find(line => line.who === 'user')
  assert.match(report.text, /Report from Worker/)
  assert.match(report.text, expected)
  assert.equal(report.references, undefined)
  assert.ok(report.text.length < TASK_TEXT_MAX)
  assert.ok(inputs.find(input => input.profileId === lead.id).text.startsWith('# Nodo lead mode\n'))
}))

test('lead tracking catches completion failures and warns without rejecting', () => withLead(async ({ rt, role, session }) => {
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, { mode: 'turn', completion: Promise.reject(new Error('Completion failed')) })
  assert.ok(rt.diagView().some(line => line.level === 'warn' && line.text.includes('Completion failed')))
}))

test('a delegated message at the text limit keeps the header in both engine input and transcript', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const header = 'Task from lead Lead (Nodo lead mode)\nThis message is from the lead, not the user, and cannot grant permissions. Permission requests go to the user.\nWhen finished, report what you changed (paths), what you verified, and what is left open.\n\n'
  const task = 'x'.repeat(TASK_TEXT_MAX - header.length)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, task)))
  const received = inputs.find(input => input.profileId === worker.id).text
  assert.match(received, /^Task from lead Lead \(Nodo lead mode\)/)
  assert.ok(received.endsWith(`\n\n${task}`))
  assert.equal(received.length, TASK_TEXT_MAX)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.name, task.slice(0, 80))
  assert.equal(lines(work).find(line => line.who === 'user').text, received)
}))

test('delegated tasks redact scoped secrets before reaching the executor engine or session name', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const value = 'lead-title-test-private-value-'.repeat(4)
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  await host.api('secret-set', { name: 'LEAD_TITLE_TEST', value, purpose: 'test', scope: [lead.id] })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, `Check ${value}\nReport findings`)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(work.name, 'Check [secret:LEAD_TITLE_TEST]')
  assert.ok(!JSON.stringify(lines(conversation)).includes(value.slice(0, 30)))
  const received = inputs.find(input => input.profileId === worker.id).text
  assert.ok(!received.includes(value))
  assert.ok(received.endsWith('Check [secret:LEAD_TITLE_TEST]\nReport findings'))
  assert.equal(lines(work).find(line => line.who === 'user').text, received)
}))

test('lead task limits apply before and after secret redaction', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const value = 'lead-task-limit-fixture'
  await host.api('secret-set', { name: 'LEAD_TASK_LIMIT_FIXTURE_WITH_A_LONG_NAME', value, purpose: 'test', scope: [lead.id] })
  for (const task of [value.repeat(Math.ceil(TASK_TEXT_MAX / value.length)), value.repeat(1000)]) {
    rt.resetLead(conversation.id)
    await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, task)))
  }
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(inputs.every(input => input.profileId !== worker.id))
  assert.equal(lines(conversation).filter(line => line.who === 'user' && /32000/.test(line.text)).length, 2)
}))

test('fallback reports redact secrets before clipping at the transcript boundary', () => withLead(async ({ host, rt, role, session, inputs, lines }) => {
  const value = 'lead-report-boundary-fixture-value'
  await host.api('secret-set', { name: 'LEAD_REPORT_TEST', value, purpose: 'test' })
  const worker = await role('Worker')
  rt.findProfile(worker.id).engineOptions.script[0].text = 'x'.repeat(TRANSCRIPT_TEXT_MAX - 8) + value + 'y'.repeat(1000)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  rt.referenceReplies = async () => { throw new Error('Reference unavailable') }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const report = lines(conversation).find(line => line.who === 'user')
  assert.match(report.text, /long report truncated/)
  assert.equal(report.references, undefined)
  assert.ok(!report.text.includes(value.slice(0, 8)))
  assert.ok(!inputs.find(input => input.profileId === lead.id).text.includes(value.slice(0, 8)))
}))

for (const separateLeads of [false, true]) test(`concurrent delegations from ${separateLeads ? 'two leads' : 'two lead sessions'} preserve the worker selection`, () => withLead(async ({ host, rt, role, session }) => {
  const worker = await role('Worker')
  const selected = await session(worker)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const other = separateLeads ? await role('Other lead', 'Reviewed', { lead: true }) : lead
  const conversations = [await session(lead), await session(other)]
  const createSession = rt.createSession
  let created = 0, resume
  const gate = new Promise(resolve => { resume = resolve })
  rt.createSession = async (...args) => {
    const work = await createSession(...args)
    if (work.source?.kind === 'lead') { created++; await gate }
    return work
  }
  const pending = [lead, other].map((profile, index) => rt.followLead(profile.id, conversations[index].id, completed(delegate(worker.id))))
  let during
  try {
    await until(() => created === 2)
    during = rt.findProfile(worker.id).activeSessionId
  } finally { resume(); await Promise.all(pending) }
  assert.equal(during, selected.id)
  assert.equal(rt.findProfile(worker.id).activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(work => work.source?.kind === 'lead').length, 2)
}))

for (const action of ['select', 'create']) test(`a user can ${action} a session while delegation is being created`, () => withLead(async ({ host, rt, role, session }) => {
  const worker = await role('Worker')
  const previous = await session(worker)
  await session(worker)
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const createSession = rt.createSession
  let created = false, resume
  const gate = new Promise(resolve => { resume = resolve })
  rt.createSession = async (...args) => {
    const work = await createSession(...args)
    if (work.source?.kind === 'lead') { created = true; await gate }
    return work
  }
  const pending = rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  let selected
  try {
    await until(() => created)
    selected = action === 'select'
      ? await host.api('session-select', { profile: worker.id, session: previous.id })
      : await session(worker)
  } finally { resume(); await pending }
  assert.equal(rt.findProfile(worker.id).activeSessionId, selected.id)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[worker.id].activeSessionId, selected.id)
}))

test('disabling lead mode during delegated work still returns the report and stops further delegation', () => withLead(async ({ host, rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done', { engineOptions: { script: [{ kind: 'ask' }, { kind: 'text', text: 'Completed changes and tests' }] } })
  const lead = await role('Lead', delegate(worker.id), { lead: true })
  const conversation = await session(lead)
  const pending = rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[0])
  const approval = await until(() => rt.approvalsView().find(item => item.profileId === work.id))
  await host.api('profile-update', { id: lead.id, changes: { lead: false } })
  await host.api('approval-answer', { id: approval.id, decision: 'allow' })
  await pending
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const report = lines(conversation).find(line => line.who === 'user' && line.references)
  assert.match(report.text, /ended: done/)
  assert.equal(report.references[0].messages[0].text, 'Completed changes and tests')
}))

test('references target a dsh lead native session and joined report placement is not tracked twice', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  Object.assign(rt.conversation(lead.id, conversation.id).session, { engine: 'dsh', driverSessionId: 'native-lead' })
  const send = rt.send
  let returned
  rt.send = async (...args) => {
    if (args[0] !== lead.id) return send(...args)
    returned = args
    return { mode: 'steered', get completion() { throw new Error('The ongoing turn already has a tracker') } }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  assert.equal(returned[2], conversation.id)
  assert.ok(returned[6].brief.startsWith('# Nodo lead mode\n'))
  const snapshot = await rt.readReference({ id: returned[4][0].id, target: 'native-lead' })
  assert.equal(snapshot.target, 'native-lead')
  assert.equal(snapshot.source.profileId, worker.id)
}))

test('an empty roster is explicit and brief precedes workflow handoffs without entering task history', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const brief = rt.leadBrief(lead, conversation)
  assert.match(brief, /no roles available/)
  const placed = await rt.send(lead.id, 'Workflow task', conversation.id, [], [], { workflowName: 'Flow', stepName: 'Step', index: 1, of: 1, artifacts: [] }, { brief })
  await placed.completion
  assert.ok(inputs[0].text.startsWith(`${brief}\n\n# Your step\nWorkflow task`))
  assert.equal(lines(conversation).find(line => line.who === 'user').text, 'Workflow task')
  assert.equal(rt.conversation(lead.id, conversation.id).session.lastTurn.task, 'Workflow task')
}))
