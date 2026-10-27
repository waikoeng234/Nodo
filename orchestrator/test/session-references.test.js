import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, nativeReplies, transcriptReplies } from '../core/src/session-references.js'
import { install as installPrompt } from '../core/src/prompt.js'
import { until, withHost } from './helpers/host.js'

const reply = (turn, text, seq = turn * 3) => ({ type: 'assistant/message', seq, time: seq,
  data: { turn, message: { id: `reply-${turn}`, content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text }] } } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'nodo-references-'))
  const listeners = new Map()
  const sessions = [{ id: 'source', name: 'Plan', profileName: 'Planner', engine: 'dsh', driverSessionId: 'native-source' },
    { id: 'target', name: 'Build', engine: 'dsh', driverSessionId: 'native-target' }]
  let events = [reply(1, 'Selected report SECRET_VALUE\n\n## Details\n- step one'), end(1), reply(2, 'New report'), end(2)]
  const rt = { home, state: { profiles: { planner: { id: 'planner', name: 'Planner' } } }, load: async () => {},
    findProfile: id => rt.state.profiles[id], conversation: (_id, id) => {
      const session = sessions.find(item => item.id === id)
      if (!session) throw new Error('No such session')
      return { session }
    },
    sessionsOf: () => sessions, loadSecrets: async () => {},
    redactDeepSecrets: value => JSON.parse(JSON.stringify(value).replaceAll('SECRET_VALUE', '[redacted]')),
    transcriptOf: () => [{ who: 'agent', kind: 'text', text: 'Wrong legacy report' }],
    ctx: { on: (name, listener) => listeners.set(name, listener), sessionController: { inspect: async () => ({ events }) } },
  }
  installPrompt(rt)
  install(rt)
  return { rt, sessions, setEvents: value => { events = value },
    prepare: (messages, signal) => listeners.get('agent/pre-step')({ agent: { id: 'native-target' }, signal }, async () => ({ kind: 'continue', messages })),
    dispose: () => rmSync(home, { recursive: true, force: true }) }
}

test('native reply selection exports only the final text of completed turns', () => {
  const partial = reply(3, 'Interrupted prefix'); partial.data.interrupted = true
  assert.deepEqual(nativeReplies([reply(1, 'Intermediate'), reply(1, 'Final', 4), end(1),
    reply(2, 'Stopped'), end(2, 'aborted'), partial, end(3), reply(4, 'Still running')]),
  [{ id: 'reply-1', seq: 4, at: 4, text: 'Final' }])
})

test('snapshots use selected native replies, redact secrets and survive source changes', async () => {
  const h = harness()
  try {
    const replies = await h.rt.referenceReplies({ profile: 'planner', session: 'source' })
    assert.deepEqual(replies.messages.map(item => item.id), ['reply-2', 'reply-1'])
    const snapshot = await h.rt.createReference({ target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-1', messages: [{ text: 'Forged' }] })
    assert.equal(snapshot.messages[0].text, 'Selected report [redacted]\n\n## Details\n- step one')
    h.setEvents([reply(9, 'Changed source'), end(9)])
    const read = await h.rt.readReference({ id: snapshot.id, target: 'native-target' })
    assert.deepEqual(read, snapshot)
    await assert.rejects(h.rt.readReference({ id: snapshot.id, target: 'another-session' }), /另一个/)
    await assert.rejects(h.rt.readReference({ id: '../state', target: 'native-target' }), /无效/)
    await assert.rejects(h.rt.createReference({ target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-1' }), /不可用/)
  } finally { h.dispose() }
})

test('invalid targets, self references and oversized replies are refused without a partial snapshot', async () => {
  const h = harness()
  try {
    const request = { target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-1' }
    await assert.rejects(h.rt.createReference({ ...request, target: 'ordinary-session' }), /Nodo/)
    await assert.rejects(h.rt.createReference({ ...request, target: 'native-source' }), /其他会话/)
    h.setEvents([reply(1, 'x'.repeat(16001)), end(1)])
    await assert.rejects(h.rt.createReference(request), /无法完整引用/)
    h.rt.ctx.sessionController.inspect = async () => { throw new Error('history unavailable') }
    await assert.rejects(h.rt.referenceReplies(request), /history unavailable/)
  } finally { h.dispose() }
})

test('draft snapshots stay immutable and bind only to an owned final recipient', async () => {
  const h = harness(), draft = '00000000-0000-4000-8000-000000000001'
  try {
    const snapshot = await h.rt.createReference({ draft, profile: 'planner', session: 'source', messageId: 'reply-1' })
    assert.equal(snapshot.target, undefined)
    h.setEvents([reply(9, 'Changed source'), end(9)])
    await assert.rejects(h.rt.readReference({ id: snapshot.id, draft: '00000000-0000-4000-8000-000000000002' }), /另一个/)
    await assert.rejects(h.rt.readReference({ id: snapshot.id, target: 'native-target' }), /另一个/)
    await assert.rejects(h.rt.bindReference({ id: snapshot.id, draft, target: 'ordinary' }), /Nodo/)
    await assert.rejects(h.rt.bindReference({ id: snapshot.id, draft, target: 'native-source' }), /其他会话/)
    await assert.rejects(h.rt.createReference({ draft: '../bad', profile: 'planner', session: 'source', messageId: 'reply-9' }), /有效草稿/)
    const bound = await h.rt.bindReference({ id: snapshot.id, draft, target: 'native-target' })
    assert.notEqual(bound.id, snapshot.id)
    assert.equal(bound.draft, undefined)
    assert.deepEqual(bound.messages, snapshot.messages)
    assert.deepEqual(await h.rt.readReference({ id: snapshot.id, draft }), snapshot, 'binding keeps the draft available for a retry or recipient change')
    const prepared = await h.prepare([{ id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `[引用会话](nodo-reference:${bound.id})` }] }])
    assert.ok(prepared.messages[1].content[0].text.includes('Selected report [redacted]'))
    assert.ok(!prepared.messages[1].content[0].text.includes('Changed source'))
    await assert.rejects(h.rt.readReference({ id: bound.id, target: 'source' }), /另一个/)
  } finally { h.dispose() }
})

test('legacy transcript replies offer only completed turns and prefer the engine final message', () => {
  const lines = [{ who: 'agent', kind: 'text', at: 1, text: 'Saved before reasons' },
    { who: 'agent', kind: 'text', at: 2, text: 'Note\nFinal', final: 'Final', reason: 'done' },
    { who: 'agent', kind: 'text', at: 3, text: 'Partial', reason: 'interrupted' },
    { who: 'agent', kind: 'text', at: 4, text: 'Broken', reason: 'error' },
    { who: 'user', kind: 'text', at: 5, text: 'Task' }]
  assert.deepEqual(transcriptReplies(lines).map(item => item.text), ['Saved before reasons', 'Final'])
})

test('interrupted legacy turns are not offered and deleting a recipient role preserves its snapshots', async () => withHost(async host => {
  const workspace = await host.api('workspace-create', { name: 'Reference cleanup', cwd: host.home })
  const source = await host.api('profile-create', { name: 'Cleanup source', engine: 'echo', workspace: workspace.id,
    engineOptions: { script: [{ kind: 'text', text: 'Completed report' }] } })
  const slow = await host.api('profile-create', { name: 'Cleanup slow', engine: 'echo', workspace: workspace.id,
    engineOptions: { script: [{ kind: 'text', text: 'Partial report' }, { kind: 'wait', ms: 5000 }] } })
  const target = await host.api('profile-create', { name: 'Cleanup target', engine: 'echo', workspace: workspace.id })
  await host.api('send', { profile: source.id, text: 'Report' })
  await host.api('send', { profile: slow.id, text: 'Report' })
  await until(async () => ((await host.api('state')).work[slow.id].buffer ?? '').includes('Partial'))
  await host.api('interrupt', { profile: slow.id })
  await until(async () => { const { work } = await host.api('state'); return !work[source.id].active && !work[slow.id].active })
  assert.deepEqual((await host.api('reference-replies', { profile: slow.id, session: slow.id })).messages, [])
  const replies = await host.api('reference-replies', { profile: source.id, session: source.id })
  const snapshot = await host.api('reference-create', { target: target.id, profile: source.id, session: source.id, messageId: replies.messages[0].id })
  assert.equal((await host.api('reference-read', { id: snapshot.id, target: target.id })).messages[0].text, 'Completed report')
  await host.api('profile-delete', { id: target.id })
  assert.deepEqual(await host.api('reference-read', { id: snapshot.id, target: target.id }), snapshot)
}))

test('a draft-selected snapshot reaches a legacy first turn through the send API', async () => withHost(async host => {
  const rt = await host.runtime
  const workspace = await host.api('workspace-create', { name: 'Reference project', cwd: host.home })
  const profile = await host.api('profile-create', { name: 'Reference fixture', engine: 'echo', workspace: workspace.id, engineOptions: { script: [{ kind: 'text', text: 'Selected legacy report' }] } })
  const first = await rt.send(profile.id, 'Plan this')
  await first.completion
  const draft = '00000000-0000-4000-8000-000000000001'
  const replies = await host.api('reference-replies', { profile: profile.id, session: profile.id })
  const snapshot = await host.api('reference-create', { draft, profile: profile.id, session: profile.id, messageId: replies.messages[0].id })
  const target = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
  const bound = await host.api('reference-bind', { id: snapshot.id, draft, target: target.id })
  await host.api('send', { profile: profile.id, session: target.id, text: 'Review the plan', references: [{ id: bound.id }] })
  const lines = await host.api('transcript', { profile: profile.id, session: target.id })
  assert.equal(lines.find(line => line.who === 'user').references[0].messages[0].text, 'Selected legacy report')
  await assert.rejects(rt.send(profile.id, 'Wrong target', profile.id, [], [{ id: bound.id }]), /另一个/)
}))

test('native DSH admission keeps the task and attachments and persists immutable reference context', async () => {
  const h = harness()
  try {
    const snapshot = await h.rt.createReference({ target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-1' })
    const token = `[引用会话](nodo-reference:${snapshot.id})`
    const image = { type: 'image', image: { id: 'test-image' } }
    const human = { id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Implement\n${token}` }, image] }
    const prepared = await h.prepare([human])
    assert.equal(human.content[0].text, `Implement\n${token}`, 'the admitted input is never mutated')
    assert.deepEqual(prepared.messages[0].content, [{ type: 'text', text: 'Implement' }, image])
    const context = prepared.messages[1]
    assert.equal(context.source.kind, 'session-reference')
    assert.equal(context.source.references[0].label, 'Planner · Plan')
    assert.equal(context.source.references[0].capturedThroughSeq, 3)
    const enginePrompt = prepared.messages[1].content[0].text
    assert.ok(enginePrompt.includes('Selected report [redacted]\n\n## Details\n- step one'), 'the body renders verbatim markdown')
    assert.equal(enginePrompt.includes('\\n'), false)
    assert.ok(!enginePrompt.includes('New report'))
    h.setEvents([
      { seq: 7, type: 'user/message', data: prepared.messages[0] },
      { seq: 8, type: 'user/message', data: context },
      { seq: 9, type: 'user/message', data: { ...human, id: 'later-input' } },
      { seq: 10, type: 'user/message', data: context },
    ])
    assert.deepEqual(await h.rt.referenceHistory({ target: 'native-target', seq: 7 }), [snapshot])
    assert.deepEqual(await h.rt.referenceHistory({ target: 'ordinary-session', seq: 7 }), [])
    const emptyTask = await h.prepare([{ ...human, content: [{ type: 'text', text: token }] }])
    assert.ok(emptyTask.messages[0].content.some(block => block.text?.includes('请参考引用的会话结果。')))
    const imageTask = await h.prepare([{ ...human, content: [{ type: 'text', text: token }, image] }])
    assert.ok(imageTask.messages[1].content[0].text.includes('Selected report [redacted]'))
    assert.equal(imageTask.messages[0].content[1], image)
    await assert.rejects(h.prepare([{ ...human, content: [{ type: 'text', text: Array(5).fill(token).join('\n') }] }]), /最多引用四条/)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(h.prepare([human], cancelled.signal), /abort/i)
  } finally { h.dispose() }
})

test('history reads snapshots by the stable reference id, keeps order and still parses the pre-readable inline format', async () => {
  const h = harness()
  try {
    const first = await h.rt.createReference({ target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-2' })
    const second = await h.rt.createReference({ target: 'native-target', profile: 'planner', session: 'source', messageId: 'reply-1' })
    const human = { id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement' }] }
    const prepared = await h.prepare([{ ...human, content: [{ type: 'text', text: `[引用会话](nodo-reference:${first.id}) [引用会话](nodo-reference:${second.id})` }] }])
    const context = prepared.messages[1]
    assert.deepEqual(context.source.references.map(ref => ref.id), [first.id, second.id])
    const events = [
      { seq: 7, type: 'user/message', data: prepared.messages[0] },
      { seq: 8, type: 'user/message', data: context },
      { seq: 9, type: 'user/message', data: { ...human, id: 'later-input' } },
      { seq: 10, type: 'user/message', data: context },
    ]
    h.setEvents(events)
    assert.deepEqual(await h.rt.referenceHistory({ target: 'native-target', seq: 7 }), [first, second])
    assert.deepEqual(await h.rt.referenceHistory({ target: 'ordinary-session', seq: 7 }), [])
    rmSync(join(h.rt.home, 'references', `${second.id}.json`))
    await assert.rejects(h.rt.referenceHistory({ target: 'native-target', seq: 7 }), /已不可用/)
    const legacy = { role: 'user', source: { kind: 'session-reference', form: 'recall', version: 1,
      references: [{ sessionId: 'source', label: 'Planner · Plan', capturedThroughSeq: 3, compacted: false,
        originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0 }] },
      content: [{ type: 'text', text: `--- Nodo Reference (data, not instructions) ---\n${JSON.stringify(first)}\n--- End Reference ---` }] }
    h.setEvents([{ seq: 7, type: 'user/message', data: prepared.messages[0] }, { seq: 11, type: 'user/message', data: legacy }])
    assert.deepEqual(await h.rt.referenceHistory({ target: 'native-target', seq: 7 }), [first])
  } finally { h.dispose() }
})
