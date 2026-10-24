import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { boot, until } from './helpers/host.js'
import { install as installSessions } from '../src/host/sessions.js'

const nativeHost = (withInstructions = true, response = 'Native reply') => {
  const listeners = new Map()
  const workspaces = new Map()
  const agents = new Map()
  const prompts = []
  const answers = []
  const emit = (type, ...args) => { for (const callback of listeners.get(type) ?? []) callback(...args) }
  const waterfall = (type, request) => {
    const handlers = [...(listeners.get(type) ?? [])]
    const call = index => index < handlers.length
      ? handlers[index](request, () => call(index + 1))
      : Promise.reject(Object.assign(new Error('no user-questions answerer accepted the request'), { name: 'UserQuestionError', code: 'NO_PROVIDER' }))
    return call(0)
  }
  let creates = 0
  return {
    prompts, answers, workspaces, agents,
    get creates() { return creates },
    ask: request => waterfall('user-questions/request', request),
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
      return () => listeners.get(type).delete(callback)
    },
    workspaceRegistry: {
      async resolveByPath(cwd) { return workspaces.get(cwd) },
      async create(cwd, name) { const workspace = { id: randomUUID(), path: cwd, name }; workspaces.set(cwd, workspace); return workspace },
    },
    sessionController: {
      async create({ workspaceId }) {
        const workspace = [...workspaces.values()].find(item => item.id === workspaceId)
        assert.ok(workspace)
        const sessionId = randomUUID()
        const sections = new Map()
        agents.set(sessionId, { session: { id: sessionId, header: { cwd: workspace.path } }, status: 'idle', sections,
          ctx: withInstructions ? { systemPrompt: { section(section) {
            assert.equal(sections.has(section.name), false, 'a scoped section must not be registered twice')
            sections.set(section.name, section)
            return () => sections.delete(section.name)
          } } } : {}, async whenIdle() {} })
        creates++
        return { sessionId }
      },
      async rename({ sessionId, title }) { agents.get(sessionId).session.header.title = title },
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: { message: 'Unknown session' } } },
      async prompt(request) {
        prompts.push(request)
        const agent = agents.get(request.sessionId)
        const turn = prompts.length
        agent.status = 'running'
        emit('session/event', agent.session, { type: 'user/message', data: { role: 'user', content: request.content } })
        emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
        let reply = response
        if (String(request.content[0]?.text ?? '').includes('ASK')) {
          answers.push(await waterfall('user-questions/request', {
            agent,
            questions: [{ id: 'color', question: 'Favorite color?', options: [{ label: 'red' }, { label: 'blue' }] }],
          }))
          reply = 'Answered'
        }
        if (String(request.content[0]?.text ?? '').includes('TOOL')) {
          emit('session/event', agent.session, { type: 'tool/call', data: { turn, callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'npm run build' }) } })
          emit('session/event', agent.session, { type: 'tool/result', data: { turn, message: { role: 'tool', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'boom' }] } } })
        }
        emit('session/event', agent.session, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: reply }] } } })
        agent.status = 'idle'
        emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
        return { accepted: true }
      },
      async cancel() {},
    },
  }
}

test('a fresh role shows no session; a nameless new session is a reusable draft named by its first task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-draft-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Drafts', cwd: home })
    const role = await host.api('profile-create', { name: 'Drafter', engine: 'dsh', workspace: workspace.id })
    const roles = async () => (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.deepEqual((await roles()).sessions, [], 'a fresh role must not show a session')
    const opened = await host.api('session-open', { profile: role.id, workspace: workspace.id })
    let mine = await roles()
    assert.equal(mine.sessions.length, 1)
    assert.equal(mine.sessions[0].name, '新会话')
    assert.ok(mine.sessions[0].draftedAt > 0, 'the placeholder session is marked as a draft')
    assert.match(native.agents.get(opened.sessionId).session.header.title, /Drafter · 新会话/)
    const again = await host.api('session-open', { profile: role.id, workspace: workspace.id })
    assert.equal(again.conversationId, opened.conversationId, 'an abandoned draft is reused, not multiplied')
    assert.equal(native.creates, 1, 'the reused draft keeps its native session')
    const spare = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true, name: 'Spare' })
    mine = await roles()
    assert.deepEqual(mine.sessions.map(item => item.name), ['Spare'], 'the abandoned draft leaves the rail to the used session')
    assert.equal(mine.activeSessionId, spare.id)
    await host.api('session-open', { profile: role.id, workspace: workspace.id })
    mine = await roles()
    assert.deepEqual(mine.sessions.map(item => item.name), ['新会话', 'Spare'], 'the draft reappears only while it is in use')
    await host.api('send', { profile: role.id, session: opened.conversationId, text: '帮我修复登录页\n的报错' })
    await until(async () => !(await host.api('state')).work[opened.conversationId].active)
    mine = await roles()
    assert.equal(mine.sessions[0].name, '帮我修复登录页 的报错')
    assert.equal(mine.sessions[0].draftedAt, undefined)
    assert.match(native.agents.get(opened.sessionId).session.header.title, /Drafter · 帮我修复登录页 的报错/)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('opening a DSH role resolves a native session without sending a turn and reopens the same session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-open-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Native sidebar', cwd: home })
    const role = await host.api('profile-create', { name: 'Sidebar role', engine: 'dsh', instructions: 'SIDEBAR_IDENTITY' })
    const opened = await host.api('session-open', { profile: role.id, workspace: workspace.id })
    assert.ok(opened.sessionId)
    assert.equal(native.creates, 1)
    assert.equal(native.prompts.length, 0)
    assert.match(native.agents.get(opened.sessionId).sections.get('deployment:persona-prefix').text, /SIDEBAR_IDENTITY/)
    const reopened = await host.api('session-open', { profile: role.id, session: opened.conversationId })
    assert.deepEqual(reopened, opened)
    assert.equal(native.creates, 1)
    const other = await host.api('profile-create', { name: 'Legacy sidebar role', engine: 'echo' })
    assert.equal((await host.post('session-open', { profile: other.id, workspace: workspace.id })).ok, false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('reopening a running native DSH session after reload only selects its existing window', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-running-open-'))
  const native = nativeHost()
  let host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Running', cwd: home })
    const role = await host.api('profile-create', { name: 'Busy role', engine: 'dsh', instructions: 'RUNNING_IDENTITY' })
    const opened = await host.api('session-open', { profile: role.id, workspace: workspace.id })
    await until(() => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[role.id].sessions
      .some(session => session.id === opened.conversationId && session.driverSessionId === opened.sessionId))
    host.dispose()
    host = boot(home, native)
    const agent = native.agents.get(opened.sessionId)
    const section = agent.ctx.systemPrompt.section
    agent.status = 'running'
    agent.ctx.systemPrompt.section = () => assert.fail('viewing must not install identity during a turn')
    agent.whenIdle = async () => assert.fail('viewing must not wait for the running turn')
    for (const method of ['resolveAgent', 'rename', 'selectModel', 'prompt', 'cancel']) {
      native.sessionController[method] = async () => assert.fail(`viewing must not call ${method}`)
    }
    const reopened = await host.api('session-open', { profile: role.id, session: opened.conversationId })
    assert.deepEqual(reopened, opened)
    assert.equal(native.creates, 1)
    assert.equal(native.prompts.length, 0)
    assert.equal(agent.status, 'running')
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).activeSessionId, opened.conversationId)
    agent.session.header.cwd = join(home, 'foreign')
    const foreign = await host.post('session-open', { profile: role.id, session: opened.conversationId })
    assert.equal(foreign.ok, false)
    assert.match(foreign.error.message, /another workspace/)
    agent.ctx.systemPrompt.section = section
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('native identity stays scoped, preserves literal templates and restores the original session snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-identity-native-'))
  const native = nativeHost()
  let host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Identity', cwd: home })
    const instructions = 'Check evidence. '.repeat(150) + 'TAIL_RULE {{literal}}'
    const role = await host.api('profile-create', { name: 'Fixture Reviewer', engine: 'dsh', workspace: workspace.id, role: 'review-only', instructions, goal: 'Original goal' })
    await host.api('secret-set', { name: 'READ_ONLY', value: 'fixture-read-only', purpose: 'read the repo', scope: [role.id] })
    const send = async (profile, session, text) => {
      await host.api('send', { profile, session, text })
      await until(async () => !(await host.api('state')).work[session].active)
    }
    await send(role.id, role.id, 'FIRST')
    await send(role.id, role.id, 'SECOND')
    const oldAgent = native.agents.get(native.prompts[0].sessionId)
    const identity = oldAgent.sections.get('deployment:persona-prefix')
    assert.match(identity.text, /TAIL_RULE \{\{literal\}\}/)
    assert.match(identity.text, /\$ORCH_SECRET_READ_ONLY \(read the repo\)/)
    assert.equal(identity.interpolate, false)
    assert.ok(!identity.text.includes('# The task'))
    assert.equal(native.prompts[0].content[0].text, 'FIRST')
    assert.equal(native.prompts[1].content[0].text, 'SECOND')
    const other = await host.api('profile-create', { name: 'Writer', engine: 'dsh', workspace: workspace.id, instructions: 'Write clearly' })
    await send(other.id, other.id, 'OTHER')
    const otherAgent = native.agents.get(native.prompts.at(-1).sessionId)
    assert.match(otherAgent.sections.get('deployment:persona-prefix').text, /Write clearly/)
    assert.ok(!otherAgent.sections.get('deployment:persona-prefix').text.includes('TAIL_RULE'))
    assert.ok(!otherAgent.sections.get('deployment:persona-prefix').text.includes('ORCH_SECRET_READ_ONLY'))
    const updated = await host.api('profile-update', { id: role.id, changes: { name: 'Builder', role: 'implementer', instructions: 'New identity', goal: 'New goal' } })
    const next = updated.sessions.at(-1)
    assert.notEqual(next.id, role.id)
    await send(role.id, next.id, 'NEW')
    const newAgent = native.agents.get(native.prompts.at(-1).sessionId)
    assert.match(newAgent.sections.get('deployment:persona-prefix').text, /You are Builder/)
    assert.ok(!newAgent.sections.get('deployment:persona-prefix').text.includes('TAIL_RULE'))
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[role.id]
    assert.equal(saved.sessions.find(item => item.id === role.id).profileName, 'Fixture Reviewer')
    assert.equal(saved.sessions.find(item => item.id === role.id).instructions, instructions)
    assert.equal(saved.sessions.find(item => item.id === role.id).goal, 'Original goal')
    const version = saved.sessions.find(item => item.id === role.id).identityVersion
    assert.match(version, /^[a-f0-9]{64}$/)
    assert.notEqual(saved.sessions.find(item => item.id === next.id).identityVersion, version)
    host.dispose()
    assert.equal(oldAgent.sections.size, 0)
    assert.equal(newAgent.sections.size, 0)
    assert.equal(otherAgent.sections.size, 0)
    host = boot(home, native)
    await send(role.id, role.id, 'RESTORED')
    assert.equal(oldAgent.sections.get('deployment:persona-prefix').text, identity.text)
    const restored = native.prompts.at(-1).content[0].text
    assert.match(restored, /# Saved task context/)
    assert.match(restored, /# Current task\nRESTORED$/)
    assert.ok(!restored.includes('TAIL_RULE'))
    assert.match(oldAgent.sections.get('deployment:persona-prefix').text, /Original goal/)
    assert.ok(!oldAgent.sections.get('deployment:persona-prefix').text.includes('New goal'))
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).sessions.find(item => item.id === role.id).identityVersion, version)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('card edits adopt in place until the first message starts the conversation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-adopt-card-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Adopt', cwd: join(home, 'w') })
    const role = await host.api('profile-create', { name: 'Writer', engine: 'echo', workspace: workspace.id })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true, choices: { permission: 'workspace' } })
    const before = (await host.api('state')).profiles.find(item => item.id === role.id)
    await host.api('profile-update', { id: role.id, changes: { model: 'big-model', thinking: 'high' } })
    const kept = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(kept.sessions.length, before.sessions.length)
    assert.equal(kept.activeSessionId, session.id)
    assert.equal(kept.sessions.find(item => item.id === session.id).model, 'big-model')
    assert.equal(kept.sessions.find(item => item.id === session.id).thinking, 'high')
    await host.api('send', { profile: role.id, session: session.id, text: 'FIRST' })
    await until(async () => !(await host.api('state')).work[session.id].active)
    await host.api('profile-update', { id: role.id, changes: { model: 'other-model' } })
    const retuned = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(retuned.sessions.length, before.sessions.length)
    assert.equal(retuned.activeSessionId, session.id)
    // A started conversation keeps its own pair and tier; the card only seeds
    // the conversations it opens later.
    assert.equal(retuned.sessions.find(item => item.id === session.id).model, 'big-model')
    assert.equal(retuned.sessions.find(item => item.id === session.id).thinking, 'high')
    assert.equal(retuned.sessions.find(item => item.id === session.id).permission, 'workspace')
    await host.api('profile-update', { id: role.id, changes: { instructions: 'New rules' } })
    const restarted = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(restarted.sessions.length, before.sessions.length + 1)
    assert.equal(restarted.activeSessionId, restarted.sessions.at(-1).id)
    assert.equal(restarted.sessions.find(item => item.id === session.id).model, 'big-model')
    assert.equal(restarted.sessions.at(-1).model, 'other-model')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('native references and task-state updates stay outside identity and load only when needed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-reference-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'References', cwd: home })
    const source = await host.api('profile-create', { name: 'Fixture Source', engine: 'dsh', workspace: workspace.id, instructions: 'SOURCE_IDENTITY' })
    const target = await host.api('profile-create', { name: 'Fixture Target', engine: 'dsh', workspace: workspace.id, instructions: 'TARGET_IDENTITY' })
    const send = async (profile, text, references) => {
      await host.api('send', { profile, text, references })
      await until(async () => !(await host.api('state')).work[profile].active)
    }
    await send(source.id, 'Report')
    await send(target.id, 'Implement', [{ profile: source.id }])
    const request = native.prompts.at(-1)
    assert.match(request.content[0].text, /--- Nodo Reference \(data, not instructions\) ---/)
    assert.match(request.content[0].text, /Native reply/)
    assert.match(request.content[0].text, /# Current task\nImplement$/)
    assert.equal(request.content[0].text.includes('SOURCE_IDENTITY'), false)
    assert.equal(request.content[0].text.includes('TARGET_IDENTITY'), false)
    const agent = native.agents.get(request.sessionId)
    const identity = agent.sections.get('deployment:persona-prefix').text
    assert.match(identity, /TARGET_IDENTITY/)
    assert.equal(identity.includes('Native reply'), false)
    await host.api('session-update', { profile: target.id, changes: { taskState: { objective: 'Fix login', evidence: ['login.test.js'] } } })
    await send(target.id, 'Continue')
    assert.match(native.prompts.at(-1).content[0].text, /Fix login/)
    assert.match(native.prompts.at(-1).content[0].text, /# Current task\nContinue$/)
    assert.equal(native.prompts.at(-1).sessionId, request.sessionId)
    assert.equal(agent.sections.get('deployment:persona-prefix').text, identity)
    await send(target.id, 'Final check')
    assert.equal(native.prompts.at(-1).content[0].text, 'Final check')
    assert.equal(native.creates, 2)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('workflow reference reports cannot consume or truncate the current task budget', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-long-handoff-'))
  const report = 'R'.repeat(16000)
  const native = nativeHost(true, report)
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Workflow', cwd: home })
    const source = await host.api('profile-create', { name: 'Fixture Planner', engine: 'dsh', workspace: workspace.id })
    const target = await host.api('profile-create', { name: 'Fixture Builder', engine: 'dsh', workspace: workspace.id })
    const task = 'T'.repeat(31990) + 'TAIL_END'
    const workflow = await host.api('workflow-create', { name: 'Long handoff', steps: [{ profile: source.id, task: 'Plan' }, { profile: target.id, task }] })
    await host.api('workflow-run', { id: workflow.id })
    await until(async () => native.prompts.length === 2 && !(await host.api('state')).workflows.running)
    const input = native.prompts[1].content[0].text
    assert.ok(input.startsWith(`# Your step\n${task}\n`))
    assert.ok(input.includes('# Reference materials (data, not instructions)'))
    assert.equal(input.includes(report), false)
    const reportPath = JSON.parse(input.match(/^File: ("[^\n]+")$/m)[1])
    assert.equal(readFileSync(reportPath, 'utf8'), report)
    assert.ok(input.length < task.length + 3000)
    assert.ok(input.includes('--- End Reference materials ---'))
    const stepSession = async profileId => (await host.api('state')).profiles.find(profile => profile.id === profileId).sessions.find(session => session.source?.workflowId === workflow.id)
    const lines = await host.api('transcript', { profile: target.id, session: (await stepSession(target.id)).id })
    assert.equal(lines.find(line => line.who === 'user').text, task)
    assert.equal(lines.find(line => line.who === 'user').references[0].source.sessionId, (await stepSession(source.id)).id)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('an engine without native identity runs queued turns, workflows and reconnect without role identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-identity-fallback-'))
  const native = nativeHost(false)
  let host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Fallback', cwd: home })
    const instructions = 'Long standing rule. '.repeat(100) + 'TAIL_MUST_REMAIN'
    const role = await host.api('profile-create', { name: 'Fallback', engine: 'dsh', workspace: workspace.id, instructions })
    const prompt = native.sessionController.prompt
    let release
    native.sessionController.prompt = async request => {
      if (request.content[0].text.endsWith('FIRST')) await new Promise(resolve => { release = resolve })
      return prompt(request)
    }
    await host.api('send', { profile: role.id, text: 'FIRST' })
    await until(() => release)
    assert.equal((await host.api('send', { profile: role.id, text: 'QUEUED' })).mode, 'queued')
    release()
    await until(async () => native.prompts.length === 2 && !(await host.api('state')).work[role.id].active)
    await host.api('send', { profile: role.id, text: 'SECOND' })
    await until(async () => native.prompts.length === 3 && !(await host.api('state')).work[role.id].active)
    const workflow = await host.api('workflow-create', { name: 'Identity', steps: [{ profile: role.id, name: 'Review', task: 'WORKFLOW' }] })
    await host.api('workflow-run', { id: workflow.id })
    await until(async () => native.prompts.length === 4 && !(await host.api('state')).workflows.running)
    const step = (await host.api('state')).profiles.find(profile => profile.id === role.id).sessions.find(session => session.source?.workflowId === workflow.id)
    assert.equal(step.name, 'WORKFLOW')
    assert.equal(native.agents.get(step.driverSessionId).session.header.title, `${role.name} · WORKFLOW`)
    host.dispose()
    host = boot(home, native)
    await host.api('send', { profile: role.id, text: 'RESTORED' })
    await until(async () => native.prompts.length === 5 && !(await host.api('state')).work[role.id].active)
    for (const request of native.prompts) {
      const text = request.content[0].text
      assert.equal(text.includes('TAIL_MUST_REMAIN'), false)
      assert.equal(text.includes('# Your role'), false)
    }
    assert.deepEqual(native.prompts.slice(0, 3).map(request => request.content[0].text), ['FIRST', 'QUEUED', 'SECOND'])
    assert.match(native.prompts[3].content[0].text, /^# Your step\nWORKFLOW\n/)
    const notes = (await host.api('transcript', { profile: role.id })).filter(item => item.kind === 'note' && item.text.includes('不带角色身份'))
    assert.equal(notes.length, 1)
    const userLines = (await host.api('transcript', { profile: role.id })).filter(item => item.who === 'user').map(item => item.text)
    assert.deepEqual(userLines.slice(0, 3), ['FIRST', 'QUEUED', 'SECOND'])
    assert.ok(userLines.every(text => !text.includes('TAIL_MUST_REMAIN')))
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('an exclusive send is refused while its session is busy and never reaches the transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-exclusive-'))
  const native = nativeHost(false)
  const host = boot(home, native)
  try {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Exclusive', cwd: home })
    const role = await host.api('profile-create', { name: 'Exclusive', engine: 'dsh', workspace: workspace.id })
    const prompt = native.sessionController.prompt
    let release
    native.sessionController.prompt = async request => {
      if (request.content[0].text.endsWith('FIRST')) await new Promise(resolve => { release = resolve })
      return prompt(request)
    }
    await host.api('send', { profile: role.id, text: 'FIRST' })
    await until(() => release)
    await assert.rejects(rt.send(role.id, 'BLOCKED', undefined, undefined, [], undefined, { exclusive: true }), { code: 'orch/busy' })
    assert.equal((await host.api('send', { profile: role.id, text: 'QUEUED' })).mode, 'queued')
    release()
    await until(async () => native.prompts.length === 2 && !(await host.api('state')).work[role.id].active)
    const placed = await rt.send(role.id, 'IDLE', undefined, undefined, [], undefined, { exclusive: true })
    assert.equal(placed.mode, 'turn')
    assert.equal((await placed.completion).reason, 'done')
    assert.equal(typeof (await placed.turn), 'string')
    const userLines = (await host.api('transcript', { profile: role.id })).filter(item => item.who === 'user').map(item => item.text)
    assert.deepEqual(userLines, ['FIRST', 'QUEUED', 'IDLE'])
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a failed first send is retried as a first turn, and legacy snapshots remain frozen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-identity-retry-'))
  const native = nativeHost()
  let host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Retry', cwd: home })
    const role = await host.api('profile-create', { name: 'Legacy', engine: 'dsh', workspace: workspace.id, instructions: 'Old instructions' })
    const prompt = native.sessionController.prompt
    native.sessionController.prompt = async () => { throw new Error('Fixture send failed') }
    await host.api('send', { profile: role.id, text: 'FAIL' })
    await until(async () => !(await host.api('state')).work[role.id].active)
    assert.notEqual((await host.api('state')).profiles.find(item => item.id === role.id).sessions[0].briefSent, true)
    native.sessionController.prompt = prompt
    await host.api('send', { profile: role.id, text: 'RETRY' })
    await until(async () => !(await host.api('state')).work[role.id].active)
    assert.equal(native.prompts[0].content[0].text, 'RETRY')
    host.dispose()
    const path = join(home, 'state.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    delete saved.profiles[role.id].sessions
    writeFileSync(path, JSON.stringify(saved))
    host = boot(home, native)
    await host.api('profile-update', { id: role.id, changes: { instructions: 'New instructions' } })
    await host.api('send', { profile: role.id, session: role.id, text: 'LEGACY' })
    await until(async () => !(await host.api('state')).work[role.id].active)
    const old = (await host.api('state')).profiles.find(item => item.id === role.id).sessions.find(item => item.id === role.id)
    assert.equal(old.instructions, 'Old instructions')
    assert.equal(old.profileName, 'Legacy')
    const persona = native.agents.get(native.prompts.at(-1).sessionId).sections.get('deployment:persona-prefix').text
    assert.match(persona, /Old instructions/)
    assert.ok(!persona.includes('New instructions'))
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('interrupting native instruction setup never sends the cancelled task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-identity-interrupt-'))
  const native = nativeHost()
  const host = boot(home, native)
  let release
  try {
    const workspace = await host.api('workspace-create', { name: 'Interrupted', cwd: home })
    const role = await host.api('profile-create', { name: 'Interrupted', engine: 'dsh', workspace: workspace.id, instructions: 'Keep identity' })
    const resolveAgent = native.sessionController.resolveAgent
    native.sessionController.resolveAgent = async id => {
      const result = await resolveAgent(id)
      await new Promise(resolve => { release = resolve })
      return result
    }
    await host.api('send', { profile: role.id, text: 'CANCELLED' })
    await until(() => release)
    await host.api('interrupt', { profile: role.id })
    assert.equal((await host.api('state')).work[role.id].active, false)
    release()
    await until(() => [...native.agents.values()].some(agent => agent.sections.size === 1))
    assert.equal(native.prompts.length, 0)
    native.sessionController.resolveAgent = resolveAgent
    await host.api('send', { profile: role.id, text: 'RETRY' })
    await until(async () => native.prompts.length === 1 && !(await host.api('state')).work[role.id].active)
    assert.equal(native.prompts[0].content[0].text, 'RETRY')
    assert.ok(!native.prompts[0].content[0].text.includes('CANCELLED'))
  } finally { release?.(); host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('native workspace is created on first dialogue, multiple sessions reuse it and survive reconnect', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-sessions-'))
  const native = nativeHost()
  let host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Native', cwd: join(home, 'site') })
    const profile = await host.api('profile-create', { name: 'Native', engine: 'dsh', workspace: workspace.id, role: 'reviewer', instructions: 'Check evidence' })
    assert.equal(native.workspaces.size, 0)
    assert.equal(existsSync(join(home, 'workspaces', profile.id)), false)
    const first = async text => {
      await host.api('send', { profile: profile.id, text })
      await until(async () => !(await host.api('state')).work[profile.id].active)
    }
    await first('FIRST')
    await first('SECOND')
    assert.equal(native.creates, 1)
    assert.equal(native.workspaces.size, 1)
    assert.equal(native.prompts[0].sessionId, native.prompts[1].sessionId)
    assert.equal(native.prompts[0].content[0].text, 'FIRST')
    assert.equal(native.prompts[1].content[0].text, 'SECOND')
    const second = await host.api('session-create', { profile: profile.id })
    assert.equal(native.creates, 2, 'new window must have a native session before its first message')
    await host.api('send', { profile: profile.id, session: second.id, text: 'THIRD' })
    await until(async () => !(await host.api('state')).work[second.id].active)
    assert.notEqual(native.prompts[2].sessionId, native.prompts[0].sessionId)
    assert.equal(native.prompts[2].content[0].text, 'THIRD')
    assert.equal(native.workspaces.size, 1)
    const state = await host.api('state')
    const value = state.profiles.find(item => item.id === profile.id)
    assert.equal(value.sessions.length, 2)
    assert.equal(value.sessions[0].workspaceId, value.sessions[1].workspaceId)
    assert.equal((await host.api('transcript', { profile: profile.id, session: profile.id })).filter(line => line.who === 'user').length, 2)
    assert.equal((await host.api('transcript', { profile: profile.id, session: second.id })).filter(line => line.who === 'user').length, 1)
    host.dispose()
    host = boot(home, native)
    await host.api('session-select', { profile: profile.id, session: profile.id })
    await first('AFTER_RESTART')
    assert.equal(native.creates, 2, 'reconnect must reuse the original native agent')
    assert.equal(native.prompts.at(-1).sessionId, native.prompts[0].sessionId)
    assert.match(native.prompts.at(-1).content[0].text, /# Current task\nAFTER_RESTART$/)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('native ask_user_question surfaces as a question card; other agents fall through', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-questions-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Native', cwd: join(home, 'site') })
    const profile = await host.api('profile-create', { name: 'Native', engine: 'dsh', workspace: workspace.id })
    await host.api('send', { profile: profile.id, text: 'ASK' })
    const card = await until(async () => (await host.api('state')).approvals[0])
    assert.equal(card.kind, 'question')
    assert.equal(card.detail.questions[0].id, 'color')
    await assert.rejects(() => native.ask({ agent: {}, questions: [{ id: 'x', question: 'Foreign?' }], signal: undefined }), /no user-questions answerer/)
    await host.api('approval-answer', { id: card.id, decision: 'answer', value: 'blue' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.deepEqual(native.answers[0], { answers: [{ id: 'color', selected: ['blue'] }] })
    await host.api('send', { profile: profile.id, text: 'ASK' })
    const second = await until(async () => (await host.api('state')).approvals[0])
    await host.api('approval-answer', { id: second.id, decision: 'answer', value: 'teal' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.deepEqual(native.answers[1], { answers: [{ id: 'color', selected: [], custom: 'teal' }] })
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a native tool call is one named pair in the transcript, not a call id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-tools-'))
  const native = nativeHost()
  const host = boot(home, native)
  const workspace = await host.api('workspace-create', { name: 'Tools', cwd: join(home, 'tools') })
  const profile = await host.api('profile-create', { name: 'Tools', engine: 'dsh', workspace: workspace.id })
  await host.api('send', { profile: profile.id, text: 'TOOL please' })
  await until(async () => !(await host.api('state')).work[profile.id].active)
  const tools = (await host.api('transcript', { profile: profile.id, session: profile.id })).filter(line => line.kind === 'tool')
  assert.deepEqual(tools.map(line => [line.name, line.phase, line.isError === true]),
    [['bash', 'start', false], ['bash', 'end', true]])
  assert.equal(tools[0].brief, 'npm run build', 'the collapsed row summarizes the call arguments')
  host.dispose()
})

test('generic sessions keep workspace, busy state and transcripts independent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-multiple-sessions-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Parallel', cwd: join(home, 'new-workspace') })
    const profile = await host.api('profile-create', { name: 'Parallel', engine: 'echo', workspace: workspace.id, engineOptions: { steerPolicy: 'refuse', script: [{ kind: 'wait', ms: 300 }, { kind: 'text', text: 'Done' }] } })
    await host.api('send', { profile: profile.id, text: 'FIRST' })
    const second = await host.api('session-create', { profile: profile.id })
    await host.api('send', { profile: profile.id, session: second.id, text: 'SECOND' })
    await until(async () => { const state = await host.api('state'); return state.work[profile.id].active && state.work[second.id].active })
    assert.equal((await host.post('profile-update', { id: profile.id, changes: { name: 'Unsafe edit' } })).error.code, 'orch/busy')
    await host.api('interrupt', { profile: profile.id, session: second.id })
    assert.equal((await host.api('state')).work[profile.id].active, true)
    await until(async () => !(await host.api('state')).work[profile.id].active)
    const first = await host.api('transcript', { profile: profile.id, session: profile.id })
    const next = await host.api('transcript', { profile: profile.id, session: second.id })
    assert.deepEqual(first.filter(line => line.who === 'user').map(line => line.text), ['FIRST'])
    assert.deepEqual(next.filter(line => line.who === 'user').map(line => line.text), ['SECOND'])
    assert.equal(existsSync(join(home, 'new-workspace')), true)
    assert.equal((await host.post('session-select', { profile: profile.id, session: 'foreign' })).ok, false)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('one global role opens independent conversations in multiple workspaces and preserves them after restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-shared-role-'))
  let host = boot(home)
  try {
    const a = await host.api('workspace-create', { name: 'A', cwd: join(home, 'a') })
    const b = await host.api('workspace-create', { name: 'B', cwd: join(home, 'b') })
    const role = await host.api('profile-create', { name: 'Fixture Coder', engine: 'echo', instructions: 'Original identity', engineOptions: { script: [{ kind: 'wait', ms: 80 }, { kind: 'text', text: 'Done' }] } })
    assert.deepEqual(role.sessions, [])
    const first = await host.api('session-create', { profile: role.id, workspace: a.id, lazy: true })
    const second = await host.api('session-create', { profile: role.id, workspace: b.id, lazy: true })
    assert.equal(first.workspaceRef, a.id)
    assert.equal(second.workspaceRef, b.id)
    assert.equal(existsSync(a.cwd), false, 'blank sessions must not launch an engine or create the directory')
    const bad = await host.post('session-create', { profile: role.id, workspace: 'missing', lazy: true })
    assert.equal(bad.ok, false)
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).sessions.length, 2)
    await host.api('send', { profile: role.id, session: first.id, text: 'Task A' })
    await host.api('send', { profile: role.id, session: second.id, text: 'Task B' })
    await until(async () => { const state = await host.api('state'); return !state.work[first.id].active && !state.work[second.id].active })
    const view = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(view.sessions.find(item => item.id === first.id).cwd, realpathSync(a.cwd))
    assert.equal(view.sessions.find(item => item.id === second.id).cwd, realpathSync(b.cwd))
    const lines = await host.api('transcript', { profile: role.id, session: first.id })
    assert.deepEqual(lines.filter(line => line.who === 'user').map(line => line.text), ['Task A'])
    assert.deepEqual((await host.api('transcript', { profile: role.id, session: second.id })).filter(line => line.who === 'user').map(line => line.text), ['Task B'])
    await host.api('profile-update', { id: role.id, changes: { instructions: 'New identity' } })
    const updated = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(updated.sessions.find(item => item.id === first.id).instructions, 'Original identity')
    assert.equal(updated.sessions.at(-1).instructions, 'New identity')
    assert.equal(await host.api('workspace-delete', { id: a.id }), true)
    host.dispose()
    host = boot(home)
    const reopened = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal((await host.api('state')).workspaces.some(item => item.id === a.id), false)
    assert.equal(reopened.sessions.find(item => item.id === first.id).workspaceRef, a.id)
    assert.equal(reopened.sessions.find(item => item.id === second.id).workspaceRef, b.id)
    assert.equal(reopened.sessions.find(item => item.id === first.id).cwd, realpathSync(a.cwd))
    assert.deepEqual((await host.api('transcript', { profile: role.id, session: first.id })).filter(line => line.who === 'user').map(line => line.text), ['Task A'])
    const third = await host.api('session-create', { profile: role.id, workspace: b.id, lazy: true })
    assert.equal(third.workspaceRef, b.id, 'the retained role can still start conversations elsewhere')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('archiving hides a session without deleting it, refuses running work and moves the active pointer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-archive-session-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Archive', cwd: join(home, 'archive') })
    const role = await host.api('profile-create', { name: 'Archiver', engine: 'echo', engineOptions: { steerPolicy: 'refuse', script: [{ kind: 'wait', ms: 300 }, { kind: 'text', text: 'Done' }] } })
    const first = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const second = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const sessionOf = async id => (await host.api('state')).profiles.find(item => item.id === role.id).sessions.find(item => item.id === id)
    await host.api('send', { profile: role.id, session: first.id, text: 'Running' })
    await until(async () => (await host.api('state')).work[first.id].active)
    assert.equal((await host.post('session-archive', { profile: role.id, session: first.id, archived: true })).error.code, 'orch/busy')
    await host.api('interrupt', { profile: role.id, session: first.id })
    await until(async () => !(await host.api('state')).work[first.id].active)
    await host.api('session-archive', { profile: role.id, session: second.id, archived: true })
    assert.equal(typeof (await sessionOf(second.id)).archivedAt, 'number')
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).activeSessionId, first.id)
    assert.ok(await sessionOf(second.id), 'the archived transcript and session stay in the role')
    await host.api('session-archive', { profile: role.id, session: second.id, archived: false })
    assert.equal((await sessionOf(second.id)).archivedAt, undefined)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a session can be renamed and pinned, and an empty name is refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-update-session-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Update', cwd: join(home, 'update') })
    const role = await host.api('profile-create', { name: 'Updater', engine: 'echo' })
    const first = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const second = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    await host.api('session-update', { profile: role.id, session: first.id, changes: { name: '  Renamed  ' } })
    await host.api('session-update', { profile: role.id, session: first.id, changes: { pinned: true } })
    const sessions = () => host.api('state').then(state => state.profiles.find(item => item.id === role.id).sessions)
    const renamed = (await sessions()).find(item => item.id === first.id)
    assert.equal(renamed.name, 'Renamed')
    assert.equal(typeof renamed.pinnedAt, 'number')
    assert.equal((await host.post('session-update', { profile: role.id, session: first.id, changes: { name: '   ' } })).error.code, 'orch/invalid')
    await host.api('session-update', { profile: role.id, session: first.id, changes: { pinned: false } })
    assert.equal((await sessions()).find(item => item.id === first.id).pinnedAt, undefined)
    assert.equal((await sessions()).find(item => item.id === second.id).name, second.name)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

// The card seeds model and thinking for every new conversation; only the
// permission tier carries over from the conversation before it.
test('a new conversation starts from the role card and carries the previous tier', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-session-memory-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Memory', cwd: join(home, 'memory') })
    const role = await host.api('profile-create', { name: 'Rememberer', engine: 'dsh', workspace: workspace.id, model: 'm1', thinking: 'high' })
    const first = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    assert.deepEqual({ model: first.model, thinking: first.thinking }, { model: 'm1', thinking: 'high' },
      'the card seeds the role\'s first conversation')
    const picked = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true,
      choices: { model: 'm2', thinking: 'low', permission: 'workspace' } })
    assert.equal(picked.permission, 'workspace')
    const second = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    assert.equal(second.model, 'm1', 'the previous conversation\'s own pick stays with that conversation')
    assert.equal(second.thinking, 'high')
    assert.equal(second.permission, 'workspace', 'the tier still carries over')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a conversation-level model pick updates the session without touching the role card', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-session-model-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Picker', cwd: join(home, 'picker') })
    const role = await host.api('profile-create', { name: 'Picker', engine: 'echo' })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    await host.api('session-update', { profile: role.id, session: session.id, changes: { model: 'm1', thinking: 'high' } })
    let state = await host.api('state')
    let profile = state.profiles.find(item => item.id === role.id)
    assert.equal(profile.sessions.find(item => item.id === session.id).model, 'm1')
    assert.equal(profile.sessions.find(item => item.id === session.id).thinking, 'high')
    assert.equal(profile.model, undefined, 'the conversation pick never rewrites the role card')
    assert.equal(profile.thinking, undefined)
    await host.api('session-update', { profile: role.id, session: session.id, changes: { model: 'm1', thinking: '' } })
    state = await host.api('state')
    profile = state.profiles.find(item => item.id === role.id)
    assert.equal(profile.sessions.find(item => item.id === session.id).thinking, undefined, 'an empty level reads the model default again')
    const refused = await host.post('session-update', { profile: role.id, session: session.id, changes: { model: 'bad\nname' } })
    assert.equal(refused.error.code, 'orch/invalid')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('first-send choices belong to the fresh session and leave the role defaults unchanged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-first-send-'))
  const host = boot(home)
  try {
    const workspace = await host.api('workspace-create', { name: 'Choices', cwd: home })
    const role = await host.api('profile-create', { name: 'Choice', engine: 'echo', workspace: workspace.id, model: 'default' })
    const before = (await host.api('state')).profiles.find(item => item.id === role.id)
    const created = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true,
      choices: { model: 'chosen', thinking: 'high', permission: 'plan' } })
    assert.equal(created.model, 'chosen')
    assert.equal(created.thinking, 'high')
    assert.equal(created.permission, 'plan')
    const after = (await host.api('state')).profiles.find(item => item.id === role.id)
    assert.equal(after.model, before.model)
    assert.equal(after.thinking, before.thinking)
    assert.equal(after.permission, before.permission)
    for (const choices of [null, { model: 'bad\nmodel' }, { thinking: 'bad level' }, { permission: 'invented' }, { engine: 'other' }]) {
      const refused = await host.post('session-create', { profile: role.id, workspace: workspace.id, lazy: true, choices })
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'orch/invalid')
    }
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).sessions.length, after.sessions.length)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('external model picks ignore stale native pointers and update only the conversation', async () => {
  const state = { profiles: { role: { id: 'role', name: 'Rho', engine: 'claude', sessions: [{ id: 'conv', name: 'S', nativeSessionId: 'native-1' }] } } }
  const rt = { state, workView: () => ({}), save: async () => {}, findProfile: () => state.profiles.role }
  installSessions(rt)
  await rt.updateSession('role', 'conv', { model: 'sonnet', thinking: 'medium' })
  const session = state.profiles.role.sessions[0]
  assert.equal(session.model, 'sonnet')
  assert.equal(session.thinking, 'medium')
  assert.equal(session.nativeSessionId, 'native-1')
  assert.equal(state.profiles.role.model, undefined)
  await assert.rejects(rt.openNativeSession({ profile: 'role', session: 'conv' }), /This engine does not expose a native host session/)
})

test('shared native DSH role keeps plugin workspace references separate from native workspace IDs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-shared-role-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const a = await host.api('workspace-create', { name: 'A', cwd: join(home, 'a') })
    const b = await host.api('workspace-create', { name: 'B', cwd: join(home, 'b') })
    const role = await host.api('profile-create', { name: 'Fixture Coder', engine: 'dsh' })
    const first = await host.api('session-create', { profile: role.id, workspace: a.id, lazy: true })
    const second = await host.api('session-create', { profile: role.id, workspace: b.id, lazy: true })
    assert.equal(native.creates, 0)
    for (const session of [first, second]) {
      await host.api('send', { profile: role.id, session: session.id, text: 'Check workspace' })
      await until(async () => !(await host.api('state')).work[session.id].active)
    }
    const sessions = (await host.api('state')).profiles.find(item => item.id === role.id).sessions
    assert.equal(native.workspaces.size, 2)
    for (const [id, workspace] of [[first.id, a], [second.id, b]]) {
      const session = sessions.find(item => item.id === id)
      assert.equal(session.workspaceRef, workspace.id)
      assert.notEqual(session.workspaceId, workspace.id)
      assert.equal(native.workspaces.get(realpathSync(workspace.cwd)).name, workspace.name)
      assert.equal(native.agents.get(session.driverSessionId).session.header.title, `Fixture Coder · ${session.name}`)
      assert.equal(native.agents.get(session.driverSessionId).session.header.cwd, realpathSync(workspace.cwd))
    }
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})
