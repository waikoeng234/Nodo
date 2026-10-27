import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    redactSecrets: text => text, redactDeepSecrets: value => value, appendLine: (_id, line) => line, save: async () => {} }
  for (const session of sessions) host.add(session.driverSessionId)
  installDispatch(rt)
  install(rt)
  return { rt, host, sessions, dispose: () => disposers.reverse().forEach(stop => stop()) }
}

for (const kind of ['profile', 'workspace']) {
  test(`${kind} deletion rolls back native archival when a task starts during the host await`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'nodo-archive-race-'))
    const native = nativeHost(), calls = []
    native.add('racing-native')
    Object.assign(native.workspaceRegistry, {
      async archiveSession(id) {
        calls.push(['archive', id])
        await Promise.resolve()
        native.agents.get(id).status = 'running'
      },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
    })
    const host = boot(home, native)
    try {
      const workspace = await host.api('workspace-create', { name: 'Race', cwd: home })
      const role = await host.api('profile-create', { name: 'Racing role', engine: 'dsh' })
      const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
      const rt = await host.runtime
      rt.conversation(role.id, session.id).session.driverSessionId = 'racing-native'
      const before = JSON.stringify(rt.state), disk = readFileSync(join(home, 'state.json'), 'utf8')
      const result = await host.post(`${kind}-delete`, { id: kind === 'profile' ? role.id : workspace.id })
      assert.equal(result.error.code, 'orch/busy')
      assert.equal(result.error.message, kind === 'profile' ? 'Stop or finish the running task before deleting this profile' : '请先停止或完成此工作区中正在运行的任务，再删除工作区')
      assert.deepEqual(calls, [['archive', 'racing-native'], ['unarchive', 'racing-native']])
      assert.equal(JSON.stringify(rt.state), before)
      assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), disk)
    } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
  })

  test(`${kind} deletion archives only dsh twins before changing local state and rolls back a host refusal`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'nodo-native-archive-'))
    const native = nativeHost(), calls = [], archived = new Set(['already'])
    let fail = true, rt, before
    Object.assign(native.workspaceRegistry, {
      get archivedSessionIds() { return [...archived] },
      async archiveSession(...args) {
        assert.equal(args.length, 1, 'default options keep the host activity check')
        assert.equal(JSON.stringify(rt.state), before, 'host archival precedes every local mutation')
        calls.push(['archive', args[0]])
        if (fail && args[0] === 'second') throw new Error('Host activity refuses archival')
        archived.add(args[0])
      },
      async unarchiveSession(id) { calls.push(['unarchive', id]); archived.delete(id) },
    })
    const host = boot(home, native)
    try {
      rt = await host.runtime
      const workspace = await host.api('workspace-create', { name: 'Archive', cwd: join(home, 'ws') })
      const role = await host.api('profile-create', { name: 'Native', engine: 'dsh' })
      for (const id of ['already', 'first', 'second']) {
        const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
        Object.assign(rt.conversation(role.id, session.id).session, { driverSessionId: id })
        native.add(id)
      }
      const external = await host.api('profile-create', { name: 'External', engine: 'echo' })
      const session = await host.api('session-create', { profile: external.id, workspace: workspace.id, lazy: true })
      rt.conversation(external.id, session.id).session.driverSessionId = 'external-thread'
      before = JSON.stringify(rt.state)
      const disk = readFileSync(join(home, 'state.json'), 'utf8')
      const payload = { id: kind === 'profile' ? role.id : workspace.id }
      const result = await host.post(`${kind}-delete`, payload)
      assert.equal(result.ok, false)
      assert.match(result.error.message, /删除未执行.*Host activity/)
      assert.equal(JSON.stringify(rt.state), before)
      assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), disk)
      assert.deepEqual(calls, [['archive', 'first'], ['archive', 'second'], ['unarchive', 'first']])
      assert.deepEqual([...archived], ['already'])
      fail = false; calls.length = 0
      await host.api(`${kind}-delete`, payload)
      assert.deepEqual(calls, [['archive', 'first'], ['archive', 'second']])
      assert.deepEqual([...archived], ['already', 'first', 'second'])
      assert.ok(rt.state.profiles[role.id].sessions.every(session => session.archivedAt))
      if (kind === 'workspace') assert.ok(rt.state.profiles[external.id].sessions.every(session => session.archivedAt))
    } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
  })
}

test('old hosts without archiveSession skip native sync', async () => {
  const { rt, dispose } = setup()
  try { await rt.archiveHostSessions(rt.state.profiles.role.sessions) }
  finally { dispose() }
})

test('a rollback failure is reported and does not stop the remaining rollback requests', async () => {
  const { rt, host, dispose } = setup()
  const calls = [], before = JSON.stringify(rt.state)
  Object.assign(host.workspaceRegistry, {
    async archiveSession(id) { if (id === 'claude') throw new Error('Cannot archive'); calls.push(['archive', id]) },
    async unarchiveSession(id) { calls.push(['unarchive', id]); if (id === 'codex') throw new Error('Cannot undo') },
  })
  try {
    await assert.rejects(rt.archiveHostSessions(rt.state.profiles.role.sessions), /删除未执行.*1 个原生会话撤回失败.*Cannot undo/)
    assert.deepEqual(calls, [['archive', 'dsh'], ['archive', 'codex'], ['unarchive', 'codex'], ['unarchive', 'dsh']])
    assert.equal(JSON.stringify(rt.state), before)
  } finally { dispose() }
})

test('archived native conversations are read through the transcript endpoint without opening an agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-native-transcript-'))
  const native = nativeHost(), host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'History', cwd: join(home, 'ws') })
    const role = await host.api('profile-create', { name: 'Native', engine: 'dsh' })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const rt = await host.runtime
    rt.conversation(role.id, session.id).session.driverSessionId = 'saved-native'
    native.add('saved-native')
    native.event('saved-native', 'user/message', { content: [{ type: 'text', text: 'Original question' }] })
    native.event('saved-native', 'assistant/message', { message: { content: [{ type: 'text', text: 'Original answer' }] } })
    await host.api('profile-delete', { id: role.id })
    const lines = await host.api('transcript', { profile: role.id, session: session.id })
    assert.deepEqual(lines.map(line => [line.who, line.text]), [['user', 'Original question'], ['agent', 'Original answer']])
    assert.equal(rt.driverOf(session.id), undefined)
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('archived native reads prefer local tool rows and fall back safely when inspect fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-archive-read-'))
  const native = nativeHost(), host = boot(home, native)
  try {
    const workspace = await host.api('workspace-create', { name: 'History', cwd: home })
    const role = await host.api('profile-create', { name: 'Native', engine: 'dsh' })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    const rt = await host.runtime
    Object.assign(rt.conversation(role.id, session.id).session, { driverSessionId: 'native-local', archivedAt: 1 })
    const lines = rt.state.transcripts[session.id] = [{ who: 'agent', kind: 'tool', name: 'read', brief: 'Retained tool details', at: 1 }]
    native.sessionController.inspect = async () => { native.reads.push('failed'); throw new TypeError('Inspection failed') }
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: session.id }), lines)
    await host.api('workspace-create', { name: 'Revision', cwd: join(home, 'other') })
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: session.id }), lines)
    assert.deepEqual(native.reads, [], 'revision changes never inspect when local history exists')
    rt.state.transcripts[session.id] = []
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: session.id }), [])
    assert.deepEqual(native.reads, ['failed'])
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

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
