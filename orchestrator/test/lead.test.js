import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX } from '../core/src/constants.js'
import { route } from '../core/src/lead.js'
import { until, withHost } from './helpers/host.js'

const delegate = (to, task = 'Implement the task\nKeep existing changes; report paths and tests.', session) => `\`\`\`nodo\n${JSON.stringify({ action: 'delegate', to, task, session })}\n\`\`\``
const delegateType = (type, hard, task = 'Implement the task\nKeep existing changes; report paths and tests.', session) => `\`\`\`nodo\n${JSON.stringify({ action: 'delegate', type, hard, task, session })}\n\`\`\``
const completed = text => ({ mode: 'turn', completion: Promise.resolve({ reason: 'done', text }) })

test('deleted roles leave the lead roster and routing, including explicit assignees', () => withHost(async ({ api, runtime }) => {
  const lead = await api('profile-create', { name: 'Lead', engine: 'echo', lead: true })
  const removed = await api('profile-create', { name: 'Removed', engine: 'echo' })
  const kept = await api('profile-create', { name: 'Kept', engine: 'echo' })
  await api('profile-delete', { id: removed.id })
  const rt = await runtime
  assert.deepEqual(rt.leadRoster(lead).map(role => role.id), [kept.id])
  assert.doesNotMatch(rt.leadBrief(lead, { id: 'lead-session' }), /Removed/)
  const roster = rt.leadRoster(lead).map(role => ({ ...role, taskTypes: ['code'] }))
  assert.equal(rt.findProfile(removed.id), undefined)
  assert.equal(route({ type: 'code', hard: false }, roster).profile.id, kept.id)
  assert.equal(route({ type: 'code', hard: true }, roster).miss, true)
  assert.equal(route({ type: 'code', hard: false }, roster, rt.findProfile(removed.id)).profile.id, kept.id)
}))

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
  const send = async (profile, conversation, text = 'User request', extra = {}) => {
    const response = await host.api('send', { profile: profile.id, session: conversation.id, text, ...extra })
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
    assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'lead' })
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
  assert.match(reports[0].text, new RegExp(`Report from Worker · Implement the task \\(session ${delegated[0].id}, ended: done\\)`))
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
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 0)
  const note = lines(conversation).find(line => line.who === 'system' && line.text.startsWith('执行未完成'))
  assert.match(note.text, new RegExp(`执行未完成：Worker · ${work.name}（会话 ${work.id}，ended: interrupted），未回报主控`))
}))

test('failed or unconfirmed executor turns leave a note instead of reporting to the lead', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  for (const outcome of [{ reason: 'error' }, { reason: 'done', unconfirmed: true }]) {
    rt.send = async (profileId, text, sessionId, ...rest) => {
      const placed = await send(profileId, text, sessionId, ...rest)
      return profileId === worker.id ? { ...placed, completion: Promise.resolve(outcome) } : placed
    }
    await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  }
  rt.send = send
  const works = rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead')
  assert.equal(works.length, 2)
  assert.deepEqual(lines(conversation).filter(line => line.who === 'system' && line.text.startsWith('执行未完成')).map(line => line.text), [
    `执行未完成：Worker · ${works[0].name}（会话 ${works[0].id}，ended: error），未回报主控。可打开该执行会话继续，或给主控发消息在原会话续跑。`,
    `执行未完成：Worker · ${works[1].name}（会话 ${works[1].id}，ended: done，未确认），未回报主控。可打开该执行会话继续，或给主控发消息在原会话续跑。`,
  ])
  assert.equal(lines(conversation).filter(line => line.who === 'user').length, 0)
}))

test('a failed executor turn leaves a one-time resume hint in the brief and stays continuable', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    await placed.completion
    return { ...placed, completion: Promise.resolve({ reason: 'error' }) }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  rt.send = send
  const failed = rt.sessionsOf(rt.findProfile(worker.id))[0]
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(brief.includes(`Your last delegation to Worker (session ${failed.id}) ended: error without a report.`))
  assert.ok(brief.includes(`delegate again with "session": "${failed.id}"`))
  assert.ok(!brief.includes('unconfirmed'))
  assert.ok(!rt.leadBrief(rt.findProfile(lead.id), conversation).includes(failed.id))
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, failed.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === failed.id).length, 2)
  assert.ok(lines(conversation).some(line => line.text === `继续派给 Worker · ${failed.name}`))
}))

test('a new user message does not extend the delegation budget of the chain already running', () => withLead(async ({ host, rt, role, session, tracked, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  let reports = 0
  rt.send = (profileId, text, sessionId, ...rest) => {
    if (profileId !== lead.id || !String(text).startsWith('Report from')) return send(profileId, text, sessionId, ...rest)
    if (++reports === 6) {
      rt.findProfile(lead.id).engineOptions.script = [{ kind: 'text', text: 'Answered without a block' }]
      void host.api('send', { profile: lead.id, session: conversation.id, text: 'A second message' })
    }
    return completed(delegate(worker.id))
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  rt.send = send
  await tracked.at(-1)
  const works = rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead')
  assert.equal(works.length, 12)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
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

test('route picks executors deterministically from the roster order', () => {
  const plain = { id: 'plain', name: 'Plain', taskTypes: ['feature'] }
  const hardCard = { id: 'hard-card', name: 'Hard card', taskTypes: ['feature'], hard: { model: 'm1', thinking: 'high' } }
  const hardEmpty = { id: 'hard-empty', name: 'Hard empty', taskTypes: ['feature'], hard: {} }
  const writer = { id: 'writer', name: 'Writer', taskTypes: ['docs'] }
  const roster = [plain, hardCard, hardEmpty, writer]
  for (const [input, candidates, assignee, expected] of [
    [{ type: 'feature', hard: true }, roster, undefined, { profile: hardCard, choices: hardCard.hard, by: 'route' }],
    [{ type: 'feature', hard: false }, roster, undefined, { profile: plain, choices: {}, by: 'route' }],
    [{ type: 'feature', hard: false }, [hardEmpty, hardCard], undefined, { profile: hardEmpty, choices: {}, by: 'route' }],
    [{ type: 'docs', hard: false }, roster, undefined, { profile: writer, choices: {}, by: 'route' }],
    [{ type: 'refactor', hard: false }, roster, undefined, { miss: true }],
    [{ type: 'docs', hard: true }, roster, undefined, { miss: true }],
    [{ type: 'feature', hard: true }, roster, hardCard, { profile: hardCard, choices: hardCard.hard, by: 'assignee' }],
    [{ type: 'feature', hard: false }, roster, hardCard, { profile: hardCard, choices: {}, by: 'assignee' }],
    [{ type: 'docs', hard: true }, roster, plain, { profile: plain, choices: {}, by: 'assignee' }],
  ]) assert.deepEqual(route(input, candidates, assignee), expected)
})

test('routing mode delegates by type, applies hard settings and records the choice', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Fixed the alignment; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the misaligned button')))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: true })
  assert.equal(work.model, 'hard-model')
  assert.equal(work.thinking, 'high')
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the misaligned button（修复 · 难题）'))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', false, 'Fix the label')))
  const regular = rt.sessionsOf(rt.findProfile(worker.id))[1]
  assert.deepEqual(regular.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'route', type: 'bug-fix', hard: false })
  assert.equal(regular.model, undefined)
  assert.equal(regular.thinking, undefined)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Fix the label（修复 · 常规）'))
}))

test('the routing brief lists task types instead of the roster', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const brief = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(brief.includes('## Task types\n- {"id":"feature","name":"功能","when":"需求和方案已明确，需要新增或改变行为，交付可运行的改动和验证结果。方案未定时先派调查。"}'))
  assert.ok(brief.includes('"type": "<task type id>"'))
  assert.ok(!brief.includes('## Roster') && !brief.includes(worker.id))
}))

for (const [name, output, expected] of [
  ['unknown type', () => delegateType('no-such-type', false), /type 必须是任务类型清单中的 id/],
  ['non-boolean hard', () => '```nodo\n{"action":"delegate","type":"feature","hard":"yes","task":"work"}\n```', /hard 必须是 true 或 false/],
]) test(`routing rejects ${name}, feeds back and stops after two errors`, () => withLead(async ({ rt, role, session, send, lines }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'] })
  const lead = await role('Lead', '', { lead: true })
  rt.findProfile(lead.id).engineOptions.script[0].text = output()
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
}))

test('routing mode ignores to and routes by type', () => withLead(async ({ rt, role, session }) => {
  const router = await role('Router', 'Feature done', { taskTypes: ['feature'] })
  const writer = await role('Writer', 'Docs done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed('```nodo\n' + JSON.stringify({ action: 'delegate', to: writer.name, type: 'feature', hard: false, task: 'Build the feature' }) + '\n```'))
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).filter(item => item.source?.kind === 'lead').length, 1)
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
}))

test('a type no role accepts pauses delegation, skips the lead and is reported once', () => withLead(async ({ rt, role, session, inputs, send, lines }) => {
  const writer = await role('Writer', 'Done', { taskTypes: ['docs'] })
  const lead = await role('Lead', delegateType('feature', false, 'Build it'), { lead: true })
  const conversation = await session(lead)
  await send(lead, conversation, 'Please build it')
  assert.equal(rt.sessionsOf(rt.findProfile(writer.id)).length, 0)
  assert.ok(lines(conversation).some(line => line.who === 'system' && line.text === '主控派活已暂停：没有承接「功能」的角色。在角色设置中勾选后再发消息。'))
  assert.equal(inputs.filter(item => item.profileId === lead.id).length, 1)
  rt.findProfile(lead.id).engineOptions.script[0].text = 'Answered'
  await send(lead, conversation, 'Second message')
  const leadInputs = inputs.filter(item => item.profileId === lead.id)
  assert.equal(leadInputs.filter(item => item.text.includes('did not run your last delegation')).length, 1)
  assert.match(leadInputs[1].text, /no role accepts "功能" tasks/)
  await send(lead, conversation, 'Third message')
  assert.ok(!inputs.filter(item => item.profileId === lead.id).at(-1).text.includes('did not run your last delegation'))
  rt.findProfile(lead.id).engineOptions.script[0].text = delegateType('docs', true, 'Rework the guide')
  await send(lead, conversation, 'Fourth message')
  assert.ok(lines(conversation).some(line => line.who === 'system' && line.text === '主控派活已暂停：没有能接「文档」难题的角色。在角色设置中勾选后再发消息。'))
}))

test('a user assignee receives every delegation of the message and routing resumes without one', () => withLead(async ({ rt, role, session, lines }) => {
  const router = await role('Router', 'Docs done', { taskTypes: ['docs'] })
  const generalist = await role('Generalist', 'Built it')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  const replies = [delegateType('docs', false, 'Write the sequel'), 'Answered']
  rt.send = (profileId, text, sessionId, ...rest) => profileId === lead.id && replies.length
    ? completed(replies.shift()) : send(profileId, text, sessionId, ...rest)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('docs', true, 'Write the guide')), generalist.id)
  rt.send = send
  const works = rt.sessionsOf(rt.findProfile(generalist.id)).filter(item => item.source?.kind === 'lead')
  assert.equal(works.length, 2)
  assert.deepEqual(works.map(work => work.source), [
    { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'assignee', type: 'docs', hard: true },
    { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'assignee', type: 'docs', hard: false },
  ])
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).length, 0)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Generalist · Write the guide（文档 · 难题 · 指定）'))
  assert.ok(lines(conversation).some(line => line.text === '已派给 Generalist · Write the sequel（文档 · 常规 · 指定）'))
  await rt.followLead(lead.id, conversation.id, completed(delegateType('docs', false, 'Write the docs')))
  assert.equal(rt.sessionsOf(rt.findProfile(router.id)).filter(item => item.source?.kind === 'lead').length, 1)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Router · Write the docs（文档 · 常规）'))
}))

test('without routing a user assignee still takes the delegation instead of the role the lead picked', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const generalist = await role('Generalist', 'Built it')
  const lead = await role('Lead', delegate(worker.id), { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)), generalist.id)
  const work = rt.sessionsOf(rt.findProfile(generalist.id))[0]
  assert.deepEqual(work.source, { kind: 'lead', leadProfileId: lead.id, leadSessionId: conversation.id, by: 'assignee' })
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
  assert.ok(lines(conversation).some(line => line.text === '已派给 Generalist · Implement the task（指定）'))
}))

test('a user assignee rides the send, shows in the brief and does not outlive the message', () => withLead(async ({ host, rt, role, session, inputs, tracked, send }) => {
  const generalist = await role('Generalist', 'Built it')
  const router = await role('Router', 'Docs done', { taskTypes: ['docs'] })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await host.api('send', { profile: lead.id, session: conversation.id, text: 'Do it', assignee: generalist.name })
  await tracked.at(-1)
  assert.ok(inputs[0].text.includes('The user assigned Generalist to this message'))
  await send(lead, conversation, 'Again')
  assert.ok(!inputs.filter(item => item.profileId === lead.id).at(-1).text.includes('The user assigned'))
}))

test('an assignee is refused for non-roster roles and on non-lead conversations', () => withLead(async ({ host, rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const other = await role('Other lead', 'Done', { lead: true })
  const conversation = await session(lead)
  for (const assignee of [lead.id, lead.name, other.name, 'Nobody']) {
    const result = await host.post('send', { profile: lead.id, session: conversation.id, text: 'Hi', assignee })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'orch/invalid')
  }
  const workerConversation = await session(worker)
  const result = await host.post('send', { profile: worker.id, session: workerConversation.id, text: 'Hi', assignee: lead.name })
  assert.equal(result.ok, false)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 0)
}))

test('an invalid assignee is refused before message files reach the workspace', () => withLead(async ({ host, role, session }) => {
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const saved = await host.api('attachment-save', { files: [{ name: 'notes.txt', data: Buffer.from('User file').toString('base64') }] })
  const result = await host.post('send', { profile: lead.id, session: conversation.id, text: 'Hi', files: saved.files, assignee: 'Nobody' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'orch/invalid')
  assert.equal(existsSync(join(host.home, 'ws', '.nodo', 'workflow-inputs')), false)
}))

test('a lead can continue its own dispatched session instead of opening a new one', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Work completed')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  const sent = inputs.filter(item => item.sessionId === work.id)
  assert.equal(sent.length, 2)
  assert.ok(sent[1].text.startsWith('Task from lead Lead (Nodo lead mode)'))
  assert.ok(sent[1].text.endsWith('Implement the task\nKeep existing changes; report paths and tests.'))
  assert.ok(lines(conversation).some(line => line.text === `继续派给 Worker · ${work.name}`))
  const report = lines(conversation).filter(line => line.who === 'user' && line.references).at(-1)
  assert.ok(report.text.startsWith(`Report from Worker · ${work.name} (session ${work.id}, ended: done).`))
  assert.equal(report.references[0].source.sessionId, work.id)
}))

test('routing mode continues a session when the type and difficulty match', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Fixed the header; tests pass.', { taskTypes: ['bug-fix'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the header')))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('bug-fix', true, 'Fix the footer', work.id)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.ok(lines(conversation).some(line => line.text === '继续派给 Router · Fix the header（修复 · 难题）'))
}))

test('continuation is refused for unknown, foreign and archived sessions', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const second = await role('Second lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const secondConversation = await session(second)
  const feedback = () => lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).at(-1).text
  const refused = async command => {
    await rt.followLead(lead.id, conversation.id, completed(command))
    return feedback()
  }
  await rt.followLead(second.id, secondConversation.id, completed(delegate(worker.id)))
  const foreign = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.match(await refused(delegate(worker.id, undefined, 'missing')), /session 必须是本主控会话派出的执行会话 id/)
  assert.match(await refused(delegate(worker.id, undefined, foreign.id)), /session 必须是本主控会话派出的执行会话 id/)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const own = rt.sessionsOf(rt.findProfile(worker.id))[1]
  rt.conversation(worker.id, own.id).session.archivedAt = Date.now()
  assert.match(await refused(delegate(worker.id, undefined, own.id)), /该执行会话已归档/)
  assert.ok(feedback().includes('去掉 session 字段新开会话'))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 2)
}))

test('continuation is refused for a foreign executor and allowed after a failed or unconfirmed result', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const other = await role('Other', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  const feedback = () => lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).at(-1).text
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegate(other.id, undefined, work.id)))
  assert.match(feedback(), /该执行会话属于其他角色/)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)), other.id)
  assert.match(feedback(), /该执行会话属于其他角色/)
  assert.equal(rt.sessionsOf(rt.findProfile(other.id)).filter(item => item.source?.kind === 'lead').length, 0)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    if (profileId !== worker.id) return placed
    const outcome = await placed.completion
    return { ...placed, completion: Promise.resolve({ ...outcome, unconfirmed: true }) }
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  rt.send = send
  const flagged = rt.sessionsOf(rt.findProfile(worker.id))[1]
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, flagged.id)))
  assert.equal(inputs.filter(item => item.sessionId === flagged.id).length, 2)
  rt.findProfile(worker.id).engineOptions.script = [{ kind: 'ask' }]
  const pending = rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const stopped = await until(() => rt.sessionsOf(rt.findProfile(worker.id))[2])
  await until(() => rt.approvalsView().some(item => item.profileId === stopped.id))
  await rt.interrupt(worker.id, stopped.id)
  await pending
  rt.conversation(worker.id, stopped.id).session.engineOptions.script[0] = { kind: 'text', text: 'Done' }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, stopped.id)))
  assert.equal(inputs.filter(item => item.sessionId === stopped.id).length, 2)
  assert.equal(lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令')).length, 2)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 3)
}))

test('routing mode refuses continuation when the difficulty differs', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Router', 'Done', { taskTypes: ['feature'], hard: { model: 'hard-model', thinking: 'high' } })
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', true, 'Fix the header')), worker.id)
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegateType('feature', false, 'Fix the footer', work.id)), worker.id)
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话的任务难度与本次不同/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
}))

test('a session can be continued at most twice', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)))
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)))
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话已续用 2 次/)
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 3)
}))

test('a busy session refuses continuation without creating a delegation', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Reviewed', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
  rt.conversation(worker.id, work.id).session.engineOptions.script[0] = { kind: 'ask' }
  const poke = rt.send(worker.id, 'Poke', work.id, [], [], undefined)
  await until(() => rt.approvalsView().some(item => item.profileId === work.id))
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, work.id)))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /该执行会话正忙/)
  assert.ok(feedback[0].text.includes('去掉 session 字段新开会话'))
  assert.ok(!lines(conversation).some(line => line.text?.startsWith('继续派给')))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 1)
  assert.equal(inputs.filter(item => item.sessionId === work.id).length, 2)
  await rt.interrupt(worker.id, work.id)
  await poke
}))

test('a rejection plus a format error exhausts the shared invalid-command budget', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', '```nodo\n{bad}\n```', { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, 'missing')))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 0)
}))

test('two continuation rejections in the same chain exhaust the shared invalid-command budget', () => withLead(async ({ rt, role, session, lines }) => {
  const worker = await role('Worker')
  const lead = await role('Lead', delegate(worker.id, undefined, 'missing'), { lead: true })
  const conversation = await session(lead)
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id, undefined, 'missing')))
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).length, 0)
}))

test('two rejections after a successful dispatch still exhaust the invalid-command budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  rt.send = async (profileId, text, sessionId, ...rest) => {
    const placed = await send(profileId, text, sessionId, ...rest)
    return profileId === lead.id ? completed(delegate(worker.id, undefined, 'missing')) : placed
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  rt.send = send
  const feedback = lines(conversation).filter(line => line.who === 'user' && line.text.startsWith('Nodo 没有执行你的派活指令'))
  assert.equal(feedback.length, 1)
  assert.match(feedback[0].text, /session 必须是本主控会话派出的执行会话 id/)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /连续 2 次/.test(line.text)))
  const sessions = rt.sessionsOf(rt.findProfile(worker.id))
  assert.equal(sessions.length, 1)
  assert.equal(inputs.filter(item => item.sessionId === sessions[0].id).length, 1)
}))

test('continuations count toward the 12-delegation budget', () => withLead(async ({ rt, role, session, inputs, lines }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', delegate(worker.id), { lead: true })
  const conversation = await session(lead)
  const send = rt.send
  let reports = 0
  rt.send = (profileId, text, sessionId, ...rest) => {
    if (profileId !== lead.id || !String(text).startsWith('Report from')) return send(profileId, text, sessionId, ...rest)
    const work = rt.sessionsOf(rt.findProfile(worker.id))[0]
    return completed(++reports <= 3 ? delegate(worker.id, undefined, work.id) : delegate(worker.id))
  }
  await rt.followLead(lead.id, conversation.id, completed(delegate(worker.id)))
  rt.send = send
  const continued = rt.sessionsOf(rt.findProfile(worker.id))[0]
  assert.equal(rt.sessionsOf(rt.findProfile(worker.id)).filter(item => item.source?.kind === 'lead').length, 10)
  assert.equal(inputs.filter(item => item.sessionId === continued.id).length, 3)
  assert.equal(inputs.filter(item => item.text.startsWith('Task from lead Lead')).length, 12)
  assert.ok(lines(conversation).some(line => line.who === 'system' && /12 次派活上限/.test(line.text)))
}))

test('both lead briefs explain session continuation', () => withLead(async ({ rt, role, session }) => {
  const worker = await role('Worker', 'Done')
  const lead = await role('Lead', 'Answered', { lead: true })
  const conversation = await session(lead)
  const direct = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(direct.includes('To rework the same goal or have the executor re-check its own findings'))
  assert.ok(direct.includes('"session": "<session id from its report>"'))
  assert.ok(direct.includes('at most twice per session'))
  assert.ok(direct.indexOf('Delegate only one task at a time') < direct.indexOf('To rework the same goal'))
  await role('Router', 'Done', { taskTypes: ['feature'] })
  const routed = rt.leadBrief(rt.findProfile(lead.id), conversation)
  assert.ok(routed.includes('"session": "<session id from its report>"'))
  assert.ok(routed.includes('at most twice per session'))
  assert.ok(routed.indexOf('Delegate only one task at a time') < routed.indexOf('To rework the same goal'))
}))
