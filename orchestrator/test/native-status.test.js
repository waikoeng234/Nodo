import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { install } from '../src/host/native-status.js'
import { install as installDispatch } from '../core/src/dispatch.js'
import { install as installSessions } from '../core/src/sessions.js'
import { boot } from './helpers/host.js'

function nativeHost() {
  const listeners = new Map()
  const agents = new Map()
  const logs = new Map()
  const reads = []
  const workspaces = new Map()
  const emit = (type, ...args) => { for (const callback of listeners.get(type) ?? []) callback(...args) }
  const add = id => {
    const agent = { id, status: 'idle', session: { id, header: {} }, inbox: { nextTurn: [], nextStep: [] },
      ctx: { systemPrompt: { section: () => () => {} } } }
    agents.set(id, agent)
    logs.set(id, [])
    return agent
  }
  const event = (id, type, data) => {
    const log = logs.get(id)
    const event = { type, data, seq: log.length, time: 1000 + log.length }
    log.push(event)
    emit('session/event', agents.get(id)?.session ?? { id }, event)
    return event
  }
  const ask = (type, id, answer, signal) => {
    const handlers = [...(listeners.get(type) ?? [])]
    const request = { agent: agents.get(id), signal, answer }
    const next = index => index < handlers.length ? handlers[index](request, () => next(index + 1)) : answer()
    return next(0)
  }
  return {
    agents, logs, listeners, reads, emit, add, event, ask,
    on(type, callback, options) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.set(type, new Set(options?.prepend ? [callback, ...listeners.get(type)] : [...listeners.get(type), callback]))
      return () => listeners.get(type).delete(callback)
    },
    workspaceRegistry: {
      async resolveByPath(path) { return workspaces.get(path) },
      async create(path) { const workspace = { id: path, path }; workspaces.set(path, workspace); return workspace },
    },
    sessionController: {
      async create({ workspaceId }) { const agent = add(`native-${agents.size}`); agent.session.header.cwd = workspaceId; return { sessionId: agent.id } },
      async rename() {},
      async resolveAgent(id) { return { agent: agents.get(id) } },
      async inspect(id) { reads.push(id); return { events: [...logs.get(id)] } },
    },
  }
}

function setup() {
  const host = nativeHost()
  host.on('user-questions/request', (request, next) => request.answer ? request.answer() : next())
  const disposers = []
  const sessions = ['dsh', 'codex', 'claude', 'zcode', 'opencode'].map(id => ({ id: `nodo-${id}`, engine: 'dsh', driverSessionId: id }))
  const rt = { ctx: { ...host, effect: factory => disposers.push(factory()) },
    state: { profiles: { role: { id: 'role', sessions } } }, sessionsOf: profile => profile.sessions, isCompacting: () => false,
    redactSecrets: text => text, redactDeepSecrets: value => value }
  for (const session of sessions) host.add(session.driverSessionId)
  installDispatch(rt)
  install(rt)
  return { rt, host, sessions, dispose: () => disposers.reverse().forEach(stop => stop()) }
}

test('native sends from multiple DSH sessions drive the existing work view and remain session-scoped', async () => {
  const { rt, host, sessions, dispose } = setup()
  try {
    host.add('ordinary')
    rt.state.profiles.external = { id: 'external', sessions: [{ id: 'external-conv', engine: 'codex', nativeSessionId: 'ordinary' }] }
    host.agents.get('ordinary').status = 'running'
    host.event('ordinary', 'turn/start', { turn: 1 })
    for (const session of sessions) {
      const agent = host.agents.get(session.driverSessionId)
      agent.status = 'running'
      host.event(agent.id, 'turn/start', { turn: 1 })
      host.event(agent.id, 'tool/call', { turn: 1, callId: 'same-id', name: `${agent.id}-tool` })
      agent.inbox.nextTurn.push({})
    }
    await rt.refreshNativeStatus()
    assert.deepEqual(host.reads.sort(), sessions.map(session => session.driverSessionId).sort())
    for (const session of sessions) {
      const work = rt.workView()[session.id]
      assert.equal(work.active, true)
      assert.equal(work.status, 'running')
      assert.equal(work.source, 'native')
      assert.equal(work.tool, `${session.driverSessionId}-tool`)
      assert.equal(work.queued, 1)
      assert.equal(work.since, 1000)
    }
    host.event('codex', 'tool/result', { turn: 1, message: { toolCallId: 'same-id' } })
    host.event('codex', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    host.agents.get('codex').status = 'idle'
    assert.equal(rt.workView()['nodo-codex'].status, 'completed')
    assert.equal(rt.workView()['nodo-codex'].active, false)
    assert.equal(rt.workView()['nodo-claude'].active, true)
    assert.equal(rt.workView()['nodo-claude'].tool, 'claude-tool')
    assert.equal(rt.workView().ordinary, undefined)
    assert.equal(rt.nativeWork(rt.state.profiles.external.sessions[0]), null)
    await rt.refreshNativeStatus()
    assert.equal(host.reads.length, 5, 'polling does not reread complete histories')
  } finally { dispose() }
})

test('the first native user message names a fallback session and retitles its native twin', async () => {
  const { rt, host, dispose } = setup()
  try {
    installSessions(rt)
    const renames = []
    host.sessionController.rename = async ({ sessionId, title }) => { renames.push(`${sessionId}: ${title}`) }
    rt.save = async () => {}
    const session = rt.state.profiles.role.sessions[1]
    Object.assign(session, { name: '新会话', draftedAt: 123, profileName: 'Coder' })
    await rt.titleSessionFromNative('codex', { role: 'user', content: [{ type: 'text', text: '修复登录页\n的报错' }] })
    assert.equal(session.name, '修复登录页 的报错')
    assert.equal(session.draftedAt, undefined)
    assert.deepEqual(renames, ['codex: Coder · 修复登录页 的报错'])
    await rt.titleSessionFromNative('codex', { role: 'user', content: [{ type: 'text', text: '另一条' }] })
    assert.equal(session.name, '修复登录页 的报错', 'a named session keeps its name')
    assert.equal(renames.length, 1)
  } finally { dispose() }
})

test('a native send stamps the session activity and live turns date it for the rail', async () => {
  const { rt, host, sessions, dispose } = setup()
  try {
    installSessions(rt)
    rt.save = async () => {}
    const session = rt.state.profiles.role.sessions[1]
    const before = Date.now()
    host.event('codex', 'user/message', { role: 'user', content: [{ type: 'text', text: '继续' }] })
    assert.ok(session.lastActiveAt >= before && session.lastActiveAt <= Date.now(), 'the send stamps the rail time')
    host.event('codex', 'turn/start', { turn: 1 })
    host.event('codex', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal(rt.nativeWork(session).lastAt, 1002, 'the latest turn boundary becomes the native time')
  } finally { dispose() }
})

test('native approvals and questions delegate unchanged, close on answers and abort, and never create Nodo cards', async () => {
  const { rt, host, dispose } = setup()
  try {
    const agent = host.agents.get('codex')
    agent.status = 'running'
    host.event(agent.id, 'turn/start', { turn: 1 })
    host.event(agent.id, 'approval/asked', { id: 'approval' })
    let resolve
    const waiting = new Promise(done => { resolve = done })
    const result = host.ask('approval/request', agent.id, () => waiting)
    assert.equal(rt.workView()['nodo-codex'].status, 'waiting-approval')
    resolve('rejected')
    assert.equal(await result, 'rejected')
    host.event(agent.id, 'approval/decided', { id: 'approval', outcome: 'rejected' })
    assert.equal(rt.workView()['nodo-codex'].status, 'running')
    const signal = new AbortController()
    const question = host.ask('user-questions/request', agent.id, () => new Promise(done => { resolve = done }), signal.signal)
    assert.equal(rt.workView()['nodo-codex'].status, 'waiting-question')
    signal.abort()
    assert.equal(rt.workView()['nodo-codex'].status, 'running')
    const answer = { answers: [{ id: 'q', selected: ['Blue'] }] }
    resolve(answer)
    assert.equal(await question, answer)
    await assert.rejects(host.ask('user-questions/request', agent.id, () => Promise.reject(new Error('unavailable'))), /unavailable/)
    assert.equal(rt.workView()['nodo-codex'].status, 'running')
    host.add('ordinary')
    assert.equal(await host.ask('approval/request', 'ordinary', async () => 'allowed-once'), 'allowed-once')
    assert.equal(rt.workView().ordinary, undefined)
    assert.equal(rt.openApproval, undefined)
  } finally { dispose() }
})

test('stops, errors, blocked turns and later sends follow host outcomes instead of engine completion', async () => {
  const { rt, host, dispose } = setup()
  try {
    const agent = host.agents.get('codex')
    let turn = 0
    for (const [kind, expected] of [['aborted', 'stopped'], ['error', 'error'], ['blocked', 'blocked'], ['max-tokens', 'blocked'], ['completed', 'completed']]) {
      agent.status = 'running'
      host.event(agent.id, 'turn/start', { turn: ++turn })
      assert.equal(rt.workView()['nodo-codex'].status, 'running')
      host.event(agent.id, 'turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      assert.equal(rt.workView()['nodo-codex'].status, 'running', 'a stale turn must not close the current one')
      host.event(agent.id, 'turn/end', { turn, reason: { kind } })
      assert.equal(rt.workView()['nodo-codex'].active, true, 'host stays authoritative until its driver retires')
      agent.status = 'idle'
      const work = rt.workView()['nodo-codex']
      assert.equal(work.status, expected)
      assert.equal(work.active, false)
      assert.equal(work.tool, null)
      assert.equal(work.since, null)
      assert.ok(work.finishedAt)
    }
  } finally { dispose() }
})

test('cold status comes from public inspection without activating agents or copying messages and usage', async () => {
  const { rt, host, dispose } = setup()
  try {
    host.logs.set('dsh', [
      { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'host-owned' }], usage: { outputTokens: 7 } } } },
      { seq: 2, time: 12, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    host.logs.set('codex', [
      { seq: 0, time: 20, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 21, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
    ])
    host.agents.clear()
    await rt.refreshNativeStatus()
    assert.equal(rt.workView()['nodo-dsh'].status, 'completed')
    assert.equal(rt.workView()['nodo-codex'].status, 'stopped')
    assert.equal(rt.workView()['nodo-dsh'].lastAt, 12, 'replayed turns date the session from the recorded times')
    assert.equal(rt.workView()['nodo-codex'].lastAt, 21)
    assert.equal(host.agents.size, 0)
    assert.equal(rt.state.transcripts, undefined)
    assert.equal(rt.state.stats, undefined)
    assert.ok(!JSON.stringify(rt.workView()).includes('host-owned'))
  } finally { dispose() }
})

test('native status leaves the existing dispatch stream and queued work visible', () => {
  const { rt, dispose } = setup()
  try {
    rt.statsOutput = () => {}
    rt.driverSink('nodo-dsh', { type: 'turn/start', turnId: 'legacy' })
    rt.driverSink('nodo-dsh', { type: 'delta', text: 'existing stream' })
    assert.equal(rt.workView()['nodo-dsh'].active, true)
    assert.equal(rt.workView()['nodo-dsh'].status, 'running')
    assert.equal(rt.workView()['nodo-dsh'].buffer, 'existing stream')
  } finally { dispose() }
})

test('inspection races preserve live events and concurrent polls share the same read', async () => {
  const { rt, host, dispose } = setup()
  try {
    let release
    const original = rt.ctx.sessionController.inspect
    rt.ctx.sessionController.inspect = async id => {
      const snapshot = await original(id)
      if (id === 'dsh') await new Promise(resolve => { release = resolve })
      return snapshot
    }
    const first = rt.refreshNativeStatus()
    const second = rt.refreshNativeStatus()
    await Promise.resolve()
    host.agents.get('dsh').status = 'running'
    host.event('dsh', 'turn/start', { turn: 1 })
    host.event('dsh', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    host.agents.get('dsh').status = 'idle'
    release()
    await Promise.all([first, second])
    assert.equal(host.reads.filter(id => id === 'dsh').length, 1)
    assert.equal(rt.workView()['nodo-dsh'].status, 'stopped')
  } finally { dispose() }
})

test('missing history is explicit and idle or disposed agents cannot remain running from old log events', async () => {
  const { rt, host, dispose } = setup()
  try {
    rt.ctx.sessionController.inspect = async () => { throw new Error('missing') }
    await rt.refreshNativeStatus()
    assert.equal(rt.workView()['nodo-codex'].status, 'unavailable')
    const agent = host.agents.get('codex')
    agent.status = 'running'
    host.event(agent.id, 'turn/start', { turn: 1 })
    assert.equal(rt.workView()['nodo-codex'].active, true)
    agent.status = 'idle'
    assert.equal(rt.workView()['nodo-codex'].active, false)
    assert.equal(rt.workView()['nodo-codex'].status, 'stopped')
    host.agents.delete(agent.id)
    host.emit('agent/disposed', { agent })
    assert.equal(rt.workView()['nodo-codex'].active, false)
  } finally { dispose() }
  assert.equal(host.listeners.get('session/event').size, 0)
  assert.equal(host.listeners.get('approval/request').size, 0)
  assert.equal(host.listeners.get('user-questions/request').size, 1, 'the pre-existing host answerer is retained')
})

test('state polling and busy guards use native status without duplicating transcript or stats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-native-status-'))
  const native = nativeHost()
  const host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'Status', cwd: home })
    const role = await host.api('profile-create', { name: 'Observer', engine: 'dsh' })
    const opened = await host.api('session-open', { profile: role.id, workspace: workspace.id })
    const before = await host.api('state')
    const transcript = await host.api('transcript', { profile: role.id, session: opened.conversationId })
    const agent = native.agents.get(opened.sessionId)
    agent.status = 'running'
    native.event(agent.id, 'turn/start', { turn: 1 })
    const active = await host.api('state', { since: before.revision })
    assert.equal(active.unchanged, true)
    assert.equal(active.work[opened.conversationId].active, true)
    for (const [endpoint, payload] of [
      ['session-archive', { profile: role.id, session: opened.conversationId, archived: true }],
      ['session-update', { profile: role.id, session: opened.conversationId, changes: { taskState: {} } }],
      ['profile-update', { id: role.id, changes: { name: 'Busy' } }],
      ['profile-delete', { id: role.id }],
    ]) assert.equal((await host.post(endpoint, payload)).error.code, 'orch/busy')
    native.event(agent.id, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'native reply' }], usage: { outputTokens: 9 } } })
    native.event(agent.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.status = 'idle'
    const finished = await host.api('state', { since: before.revision })
    assert.equal(finished.work[opened.conversationId].status, 'completed')
    assert.equal(finished.unchanged, true, 'native turns alone do not bump the revision')
    assert.equal((await host.api('state')).profiles.find(item => item.id === role.id).sessions.find(item => item.id === opened.conversationId).updatedAt, 1002,
      'a native turn dates the session for the rail even without a transcript')
    assert.deepEqual(finished.stats, before.stats)
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: opened.conversationId }), transcript)
    assert.equal((await host.post('session-archive', { profile: role.id, session: opened.conversationId, archived: true })).ok, true)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})
