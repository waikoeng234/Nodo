import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordTracker, createStreamDetailStore, normalizePresentation, previewRecord, STREAM_LIMITS } from '../src/host/stream-records.js'
import { RESOURCE_LIMITS, materializeResources, projectContent } from '../src/host/resources.js'
import { createPump } from '../src/host/adapter/pump.js'
import { registerMirrorTool } from '../src/host/adapter/mirror-tools.js'
import { redactDeep, redactor } from '../src/host/secrets.js'
import { registerEngine } from '../agent-drivers/dist/index.js'
import { boot, until, withHost } from './helpers/host.js'

const presentation = (body = {}, revision) => ({ version: 1, kind: 'tool', mode: 'snapshot', body, ...(revision !== undefined ? { revision } : {}) })
const tracker = () => createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's' })
const event = (phase, value, callId = 'a') => ({ type: 'tool', name: 'Fixture', callId, phase, ...(value ? { presentation: value } : {}) })
const record = (body = {}) => tracker().accept(event('end', presentation(body)))
const withStore = async (run, limits) => {
  const home = await mkdtemp(join(tmpdir(), 'nodo-stream-'))
  const state = { profiles: { p: { id: 'p' } } }
  const rt = { home, state, ctx: { attachments: { validateImage: async () => {} } }, load: async () => {}, loadSecrets: async () => {}, readOnly: () => undefined,
    redactDeepSecrets: value => value, save: async () => writeFile(join(home, 'state.json'), JSON.stringify(state)),
    conversationOf: id => ['s', 's2'].includes(id) ? { profile: { id: 'p' }, session: { id, engine: 'fixture' } } : undefined,
    conversation: (p, s) => { if (p !== 'p' || !['s', 's2'].includes(s)) throw new Error('no owner'); return { profile: { id: p }, session: { id: s } } },
    sessionsOf: () => [{ id: 's', nativeSessionId: 'native-s' }, { id: 's2', nativeSessionId: 'native-s2' }],
  }
  try { await run({ home, rt, store: createStreamDetailStore(rt, limits) }) }
  finally { await rm(home, { recursive: true, force: true }) }
}

test('structured tool input admits only supported snapshots and confirmed diff before-images', () => {
  for (const value of [null, { ...presentation(), version: 2 }, { ...presentation(), mode: 'delta' }, presentation({ exitCode: 0, signal: 'SIGTERM' }),
    presentation({ diffs: [{ path: 'x', oldText: null, newText: 'text' }] }), presentation({}, -1)]) assert.equal(normalizePresentation(value), null)
  assert.deepEqual(normalizePresentation(presentation({ input: { path: 'x' }, diffs: [{ path: 'x', oldText: null, newText: 'text', created: true }] })).body,
    { input: { path: 'x' }, diffs: [{ path: 'x', oldText: null, newText: 'text', created: true }] })
  const run = tracker()
  run.accept(event('start', presentation({ inputText: 'known input' })))
  const fallback = run.accept({ ...event('end', { ...presentation(), version: 2 }), output: 'known plain output' })
  assert.equal(fallback.reason, 'unsupported')
  assert.equal(fallback.capture, 'partial')
  assert.equal(fallback.body.outputText, 'known plain output')
})

test('a key split across tool deltas is redacted in the folded record', () => {
  const redact = redactor([{ name: 'FIXTURE', value: 'fake-sensitive-fixture' }])
  const run = createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's', redact: value => redactDeep(value, redact) })
  run.accept(event('start', presentation({})))
  run.accept({ type: 'tool', callId: 'a', phase: 'update', inputDelta: 'echo fake-sens', outputDelta: 'fake-sensitive-' })
  const folded = run.accept({ type: 'tool', callId: 'a', phase: 'update', inputDelta: 'itive-fixture', outputDelta: 'fixture\n' })
  assert.equal(folded.body.inputText, 'echo [secret:FIXTURE]')
  assert.equal(folded.body.outputText, '[secret:FIXTURE]\n')
})

test('records isolate host runs, merge by call identity and reject stale or conflicting snapshots', () => {
  const run = tracker()
  const first = run.accept(event('start', presentation({ inputText: 'A' }, 3)))
  assert.equal(run.accept(event('start', presentation({ inputText: 'A' }, 3))), first)
  assert.equal(run.accept(event('start', presentation({ inputText: 'older' }, 2))), first)
  assert.equal(run.accept(event('start', presentation({ inputText: 'conflict' }, 3))).reason, 'conflict')
  assert.equal(first.capture, 'complete', 'an already published snapshot must remain immutable')
  const b = run.accept(event('start', presentation({ inputText: 'B' }, 0), 'b'))
  const finished = run.accept(event('end', presentation({ outputText: 'done' }, 4)))
  assert.equal(finished.status, 'done')
  assert.equal(run.accept(event('start', presentation({ inputText: 'late' }, 5))), finished)
  assert.equal(b.status, 'running')
  assert.notEqual(tracker().accept(event('start', presentation())).runId, first.runId)
  assert.equal(run.accept({ ...event('start', presentation()), callId: undefined }), null)
  assert.equal(run.accept(event('start', presentation(), 'x'.repeat(16000))), null)
})

test('previews are bounded while full input and output remain outside model metadata', () => {
  const full = record({ input: { command: 'echo ' + 'x'.repeat(12000) }, outputText: 'y'.repeat(30000) })
  const preview = previewRecord(full)
  assert.ok(JSON.stringify(preview).length <= 16000)
  assert.equal(preview.body.input, undefined)
  assert.equal(preview.truncated, true)
  assert.equal(full.body.outputText.length, 30000)
  assert.equal(normalizePresentation(presentation({ outputText: 'x'.repeat(STREAM_LIMITS.detailBytes + 1) })).capture, 'partial')
})

test('unconfirmed tools close without success and cannot be resurrected by late events', () => {
  const run = tracker()
  run.accept(event('start', presentation({ outputText: 'partial' })))
  const [closed] = run.close('unknown')
  assert.equal(closed.status, 'unknown')
  assert.equal(closed.capture, 'partial')
  assert.equal(closed.body.outputText, 'partial')
  assert.equal(run.accept(event('end', presentation({ outputText: 'late' }))), closed)
})

test('a burst of structured calls cannot retain unbounded bodies or identities in memory', () => {
  const run = createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's', limits: { sessionBytes: 100, entries: 2 } })
  run.accept(event('start', presentation({ outputText: 'x'.repeat(40) }), 'a'))
  const limited = run.accept(event('start', presentation({ outputText: 'y'.repeat(100) }), 'b'))
  assert.equal(limited.capture, 'partial')
  assert.equal(limited.reason, 'source-limit')
  assert.equal(run.accept(event('start', presentation(), 'c')), null)
})

test('a record trimmed by the session budget reports the budget instead of invalid image data', () => {
  const data = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(3000)]).toString('base64')
  const run = createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's', limits: { ...STREAM_LIMITS, sessionBytes: 1000 } })
  const value = run.accept({ ...event('end', presentation()), output: [{ type: 'image', mimeType: 'image/png', data }] })
  assert.equal(value.capture, 'partial')
  assert.equal(value.reason, 'source-limit')
  assert.deepEqual([value.body.resources[0].state, value.body.resources[0].reason], ['unavailable', 'source-limit'])
  assert.equal(value.body.resources[0].data, undefined)
})

test('detail limits refuse media records before creating attachment files', async () => {
  await withStore(async ({ rt, store }) => {
    let saves = 0
    rt.saveImages = async images => { saves += images.length; return images.map(image => ({ id: randomUUID(), mediaType: image.mediaType })) }
    const value = tracker().accept({ ...event('end', presentation()),
      output: [{ type: 'text', text: 'readable output.\n'.repeat(100) }, { type: 'image', mimeType: 'image/png', data: PNG }] })
    const result = await store.save('s', value)
    assert.equal(result.details.reason, 'detail-limit')
    assert.deepEqual([result.body.resources[0].state, result.body.resources[0].reason], ['unavailable', 'storage-unavailable'])
    assert.equal(saves, 0)
  }, { ...STREAM_LIMITS, detailBytes: 500 })
  await withStore(async ({ rt, store }) => {
    let saves = 0
    rt.saveImages = async images => { saves += images.length; return images.map(image => ({ id: randomUUID(), mediaType: image.mediaType })) }
    assert.equal((await store.save('s', record({ outputText: 'first' }))).details.state, 'stored')
    const value = tracker().accept({ ...event('end', presentation()), output: [{ type: 'image', mimeType: 'image/png', data: PNG }] })
    const result = await store.save('s', value)
    assert.equal(result.details.reason, 'quota')
    assert.deepEqual([result.body.resources[0].state, result.body.resources[0].reason], ['unavailable', 'storage-unavailable'])
    assert.equal(saves, 0)
  }, { ...STREAM_LIMITS, entries: 1 })
})

test('details persist immutable versions, deduplicate saves and survive a new store instance', async () => {
  await withStore(async ({ home, rt, store }) => {
    const r = record({ outputText: 'original' })
    const saved = await store.save('s', r)
    assert.equal(saved.details.state, 'stored')
    assert.equal((await store.save('s', r)).details.ref, saved.details.ref)
    assert.equal((await stat(join(home, 'stream-details', `${saved.details.ref}.json`))).mode & 0o777, 0o600)
    const restored = createStreamDetailStore({ ...rt, state: JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) })
    assert.equal((await restored.read({ profile: 'p', session: 's', ref: saved.details.ref })).body.outputText, 'original')
    assert.equal((await store.save('s', { ...r, body: { outputText: 'different' } })).details.reason, 'conflict')
    const next = await store.save('s', { ...r, revision: 1, body: { outputText: 'newer' } })
    assert.notEqual(next.details.ref, saved.details.ref)
    assert.equal((await store.read({ profile: 'p', session: 's', ref: saved.details.ref })).body.outputText, 'original')
  })
})

test('detail storage redacts before persistence and applies new secrets on every read', async () => {
  await withStore(async ({ home, rt, store }) => {
    let redact = redactor([{ name: 'FIRST', value: 'fixture-sensitive-first' }])
    rt.redactDeepSecrets = value => redactDeep(value, redact)
    const saved = await store.save('s', record({ outputText: 'fixture-sensitive-first fixture-sensitive-later' }))
    const disk = await readFile(join(home, 'stream-details', `${saved.details.ref}.json`), 'utf8')
    assert.doesNotMatch(disk, /fixture-sensitive-first/)
    redact = redactor([{ name: 'LATER', value: 'fixture-sensitive-later' }])
    assert.doesNotMatch(JSON.stringify(await store.read({ profile: 'p', session: 's', ref: saved.details.ref })), /fixture-sensitive-later/)
  })
})

test('details reject foreign owners, tampering and path references, including native-session targets', async () => {
  await withStore(async ({ home, store }) => {
    const saved = await store.save('s', record({ outputText: 'owned' }))
    const ref = saved.details.ref
    for (const request of [{ profile: 'p', session: 's2', ref }, { profile: 'other', session: 's', ref }, { target: 'native-s2', ref }, { profile: 'p', session: 's', ref: '../state' }]) {
      await assert.rejects(store.read(request), /不属于此会话/)
    }
    assert.equal((await store.read({ target: 'native-s', ref })).body.outputText, 'owned')
    await writeFile(join(home, 'stream-details', `${ref}.json`), '{}')
    await assert.rejects(store.read({ profile: 'p', session: 's', ref }), /不可用/)
  })
})

test('quota and concurrent saves never overrun per-session limits or erase retained details', async () => {
  await withStore(async ({ rt, store }) => {
    const [a, b] = await Promise.all([store.save('s', record()), store.save('s', record())])
    assert.equal(a.details.state, 'stored')
    assert.equal(b.details.reason, 'quota')
    assert.equal(Object.keys(rt.state.streamDetails).length, 1)
    assert.equal((await store.read({ profile: 'p', session: 's', ref: a.details.ref })).status, 'done')
  }, { detailBytes: 2048, sessionBytes: 2048, entries: 1 })
  await withStore(async ({ store }) => {
    assert.equal((await store.save('s', record({ outputText: 'large'.repeat(1000) }))).details.reason, 'detail-limit')
  }, { detailBytes: 100, sessionBytes: 2000, entries: 5 })
})

test('read-only, filesystem and index failures cannot publish stored references or change operation success', async () => {
  await withStore(async ({ rt, store }) => {
    rt.readOnly = () => 'another writer'
    const result = await store.save('s', record())
    assert.equal(result.status, 'done')
    assert.equal(result.details.reason, 'read-only')
  })
  await withStore(async ({ home, rt, store }) => {
    await writeFile(join(home, 'stream-details'), 'not a directory')
    assert.equal((await store.save('s', record())).details.reason, 'write-failed')
    assert.deepEqual(rt.state.streamDetails, {})
  })
  await withStore(async ({ rt, store }) => {
    rt.save = async () => { throw new Error('fixed failure') }
    const result = await store.save('s', record())
    assert.equal(result.details.ref, undefined)
    assert.equal(result.details.reason, 'write-failed')
    assert.deepEqual(rt.state.streamDetails, {})
  })
})

test('pump carries structured details through the same tool claim without inventing an execution', async () => {
  const output = 'long output '.repeat(3000)
  let pump
  pump = createPump({ createRecords: tracker, driver: { sendTurn: async () => {
    pump.receive(event('start', presentation({ command: 'echo fixture', inputText: 'fixture' }, 0)))
    pump.receive({ ...event('end', presentation({ command: 'echo fixture', outputText: output, exitCode: 0 }, 1)), output })
    pump.receive({ type: 'turn/end', reason: 'done' })
  } } })
  const chunks = []
  for await (const chunk of pump.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run' }] }] })) chunks.push(chunk)
  const call = chunks.find(chunk => chunk.block?.type === 'tool-call').block
  assert.equal(JSON.parse(call.arguments).presentation.body.command, 'echo fixture')
  const result = await pump.takeMirror().done
  assert.equal(result.presentation.body.outputText, output)
  assert.ok(result.detail.length < output.length)
  let definition
  registerMirrorTool({ tools: { register: value => { definition = value } } }, () => {})
  const projected = { ...result, presentation: previewRecord(result.presentation) }
  const meta = definition.output.presentationMeta({}, projected)
  assert.equal(meta.nodoRecord.status, 'done')
  assert.doesNotMatch(JSON.stringify(definition.output.render({ name: 'Fixture' }, { status: 'done', presentation: projected.presentation })), /long output/)
  assert.equal(definition.presentResult({}, { meta }).card, 'terminal')
  pump.dispose()
})

test('legacy API retains structured detail across archive and restart, then revokes it on role deletion', async () => {
  registerEngine('stream-fixture', { info: { id: 'stream-fixture', label: 'Stream fixture', requiresCwd: true }, validate: () => ({}),
    create: ({ onEvent }) => ({ openSession: async () => {}, hasSession: () => true, onEvent() {}, steer: async () => 'refused', interruptTurn: async () => {}, respondToRequest: async () => false, dispose() {},
      async sendTurn(text) {
        onEvent({ type: 'turn/start', turnId: 'fixture-turn' })
        onEvent(event('start', presentation({ inputText: 'original input' }, 0)))
        if (!text.includes('UNCONFIRMED')) onEvent(event('end', presentation({ outputText: 'retained output' }, 1)))
        onEvent({ type: 'turn/end', reason: 'done' })
      },
    }) })
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Fixture', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Fixture', engine: 'stream-fixture', workspace: workspace.id })
    await host.api('send', { profile: profile.id, text: 'run' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    const lines = await host.api('transcript', { profile: profile.id })
    const ref = lines.find(line => line.phase === 'end').presentation.details.ref
    const session = (await host.api('state')).profiles.find(p => p.id === profile.id).activeSessionId
    assert.equal((await host.api('stream-detail', { profile: profile.id, session, ref })).body.outputText, 'retained output')
    await host.api('send', { profile: profile.id, session, text: 'UNCONFIRMED' })
    await until(async () => !(await host.api('state')).work[session].active)
    const partial = (await host.api('transcript', { profile: profile.id, session })).findLast(line => line.phase === 'end')
    assert.equal(partial.presentation.status, 'unknown')
    assert.equal(partial.presentation.capture, 'partial')
    assert.equal(partial.presentation.details.state, 'stored')
    await host.api('session-archive', { profile: profile.id, session, archived: true })
    host.dispose()
    const restored = boot(host.home)
    try {
      assert.equal((await restored.api('stream-detail', { profile: profile.id, session, ref })).body.outputText, 'retained output')
      await restored.api('profile-delete', { id: profile.id })
      await assert.rejects(restored.api('stream-detail', { profile: profile.id, session, ref }), /不可用/)
    } finally { restored.dispose() }
  })
})

test('tool updates merge by start identity, keep delta and snapshot semantics, and never revive', () => {
  const run = tracker()
  assert.equal(run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', outputDelta: 'no start' }), null)
  const start = run.accept(event('start', presentation({ inputText: 'in' }, 0)))
  const u1 = run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', outputDelta: 'one', progress: { elapsedMs: 1000, stdoutTail: 'tail' } })
  assert.equal(u1.status, 'running')
  assert.equal(u1.body.outputText, 'one')
  assert.deepEqual(u1.body.progress, { elapsedMs: 1000, stdoutTail: 'tail' })
  assert.ok(u1.revision > start.revision)
  const u2 = run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', inputDelta: 'put', outputText: 'snapshot' })
  assert.equal(u2.body.inputText, 'input')
  assert.equal(u2.body.outputText, 'snapshot')
  const u3 = run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', outputDelta: '!' })
  assert.equal(u3.body.outputText, 'snapshot!')
  const u4 = run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', input: { command: 'x' }, output: [{ type: 'text', text: 'final text' }] })
  assert.deepEqual(u4.body.input, { command: 'x' })
  assert.equal(u4.body.inputText, 'input')
  assert.equal(u4.body.outputText, 'final text')
  const end = run.accept({ ...event('end'), output: 'final', progress: { elapsedMs: 9 } })
  assert.equal(end.status, 'done')
  assert.equal(end.body.progress, undefined)
  assert.equal(end.body.outputText, 'final')
  assert.equal(run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', outputDelta: 'late' }), end)
})

test('a running update stays bounded and finish removes live progress', () => {
  const run = createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's', limits: { detailBytes: 20, sessionBytes: 1000, entries: 5 } })
  const start = run.accept(event('start', presentation({ inputText: 'in' }, 0)))
  const update = run.accept({ type: 'tool', name: 'Fixture', callId: 'a', phase: 'update', outputDelta: 'x'.repeat(60), progress: { elapsedMs: 500 } })
  assert.equal(update.body.outputText.length, 20)
  assert.equal(update.capture, 'partial')
  assert.equal(update.reason, 'source-limit')
  assert.deepEqual(update.body.progress, { elapsedMs: 500 })
  const finished = run.finish(update, 'done')
  assert.equal(finished.body.progress, undefined)
  assert.ok(finished.revision > update.revision)
  assert.equal(start.status, 'running')
})

test('legacy host shows tool updates before the tool ends and keeps the final line', async () => {
  const gate = Promise.withResolvers()
  registerEngine('progress-fixture', {
    info: { id: 'progress-fixture', label: 'Progress fixture', requiresCwd: true }, validate: () => ({}),
    create: ({ onEvent }) => ({ openSession: async () => {}, hasSession: () => true, onEvent() {}, steer: async () => 'refused', interruptTurn: async () => {}, respondToRequest: async () => false, dispose() {},
      async sendTurn() {
        onEvent({ type: 'turn/start', turnId: 'progress-turn' })
        onEvent({ type: 'tool', turnId: 'progress-turn', callId: 'live', name: 'Bash', phase: 'start', input: 'echo one' })
        onEvent({ type: 'tool', turnId: 'progress-turn', callId: 'live', name: 'Bash', phase: 'update', outputDelta: 'first output', progress: { elapsedMs: 1200 } })
        await gate.promise
        onEvent({ type: 'tool', turnId: 'progress-turn', callId: 'live', name: 'Bash', phase: 'end', output: 'final output' })
        onEvent({ type: 'turn/end', reason: 'done' })
      },
    }),
  })
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Progress', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Progress', engine: 'progress-fixture', workspace: workspace.id })
    await host.api('send', { profile: profile.id, text: 'run' })
    await until(async () => {
      const line = (await host.api('transcript', { profile: profile.id })).find(item => item.callId === 'live' && item.phase === 'start')
      return line?.output === 'first output'
    })
    const live = (await host.api('transcript', { profile: profile.id })).find(item => item.callId === 'live' && item.phase === 'start')
    assert.deepEqual(live.progress, { elapsedMs: 1200 })
    assert.equal((await host.api('state')).work[profile.id].active, true, 'the tool is still running while its output is visible')
    gate.resolve()
    await until(async () => !(await host.api('state')).work[profile.id].active)
    const lines = await host.api('transcript', { profile: profile.id })
    assert.equal(lines.find(item => item.callId === 'live' && item.phase === 'end').output, 'final output')
  })
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('confirmed media projects to bounded resources and keeps image bytes out of readable text', () => {
  const output = [
    { type: 'text', text: '截图如下' },
    { type: 'image', mimeType: 'image/png', data: PNG, name: 'shot.png' },
    { type: 'content', content: { type: 'resource_link', name: 'notes.txt', uri: 'file:///workspace/notes.txt', mimeType: 'text/plain', size: 12 } },
    { type: 'resource', resource: { uri: 'file:///workspace/inner.txt', mimeType: 'text/plain', text: 'embedded text' } },
    { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
    { type: 'image', mimeType: 'image/svg+xml', data: '<svg/>' },
    { type: 'inputImage', imageUrl: 'https://example.test/shot.png' },
    { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
  ]
  const value = tracker().accept({ type: 'tool', name: 'Fixture', callId: 'media', phase: 'end', presentation: presentation(), output })
  assert.equal(value.body.outputText, '截图如下\nembedded text')
  assert.doesNotMatch(value.body.outputText, /iVBORw0KGgo/)
  assert.deepEqual(value.body.resources.map(item => [item.kind, item.state]), [
    ['image', 'pending'], ['link', 'reference'], ['text', 'reference'], ['audio', 'unsupported'],
    ['image', 'unsupported'], ['link', 'reference'], ['audio', 'unsupported']])
  assert.equal(value.body.resources[0].bytes, 68)
  assert.equal(value.body.resources[1].uri, 'file:///workspace/notes.txt')
  const preview = previewRecord(value)
  assert.equal(preview.body.resources[0].data, undefined)
  assert.doesNotMatch(JSON.stringify(preview), /iVBORw0KGgo/)
  assert.equal(normalizePresentation(presentation({ resources: [{ kind: 'image', state: 'stored', ref: { id: 'not-a-ref', mediaType: 'image/png' } }] })).body.resources[0].state, 'unavailable')
  assert.equal(normalizePresentation(presentation({ resources: [{ kind: 'image', state: 'pending', data: PNG }] })).body.resources[0].data, undefined)
})

test('detail save stores inline images once as attachment references and never writes their bytes', async () => {
  await withStore(async ({ home, rt, store }) => {
    const saved = []
    rt.saveImages = async images => images.map(image => {
      const id = randomUUID()
      saved.push({ id, ...image })
      return { id, mediaType: image.mediaType, name: image.name }
    })
    const value = tracker().accept({ type: 'tool', name: 'Fixture', callId: 'media', phase: 'end', presentation: presentation(),
      output: [{ type: 'text', text: '图' }, { type: 'image', mimeType: 'image/png', data: PNG, name: 'shot.png' }] })
    const result = await store.save('s', value)
    assert.equal(result.body.resources[0].state, 'stored')
    assert.equal(result.body.resources[0].ref.mediaType, 'image/png')
    assert.equal(result.body.resources[0].data, undefined)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].data, PNG)
    const disk = await readFile(join(home, 'stream-details', `${result.details.ref}.json`), 'utf8')
    assert.doesNotMatch(disk, /iVBORw0KGgo/)
    const restored = createStreamDetailStore({ ...rt, state: JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) })
    const read = await restored.read({ profile: 'p', session: 's', ref: result.details.ref })
    assert.equal(read.body.resources[0].ref.id, result.body.resources[0].ref.id)
    assert.equal(read.body.outputText, '图')
    const old = await store.save('s', tracker().accept({ type: 'tool', name: 'Old', callId: 'old', phase: 'end', presentation: presentation(), outputText: 'plain' }))
    assert.equal(old.body.resources, undefined)
  })
})

test('media duplicate saves reuse immutable references even at quota and after reopening the store', async () => {
  await withStore(async ({ rt, store }) => {
    let saves = 0
    rt.saveImages = async images => { saves += images.length; return images.map(image => ({ id: randomUUID(), mediaType: image.mediaType })) }
    const value = tracker().accept({ ...event('end', presentation()), output: [{ type: 'image', mimeType: 'image/png', data: PNG }] })
    const first = await store.save('s', value)
    assert.equal(first.details.state, 'stored')
    assert.deepEqual(await store.save('s', value), first)
    assert.deepEqual(await createStreamDetailStore(rt, { ...STREAM_LIMITS, entries: 1 }).save('s', value), first)
    assert.equal(saves, 1, 'duplicate media does not create orphaned images')
    const conflict = await store.save('s', { ...value, body: { ...value.body, outputText: 'different result' } })
    assert.equal(conflict.details.reason, 'conflict')
    assert.equal(saves, 1, 'a conflicting revision is refused before saving images')
  }, { ...STREAM_LIMITS, entries: 1 })
})

test('all projected text paths omit binary-like strings and folded base64 images are normalized', async () => {
  const binary = Buffer.from('binary fixture\0'.repeat(150)).toString('base64')
  for (const value of [binary, { rawOutput: binary }, { type: 'text', text: binary },
    { type: 'content', content: { type: 'text', text: binary } }, { type: 'resource', resource: { text: binary } }]) {
    const projected = projectContent(value)
    assert.match(projected.text, /binary-like text omitted/)
    assert.ok(!projected.text.includes(binary))
  }
  const prose = 'long output '.repeat(3000)
  assert.equal(projectContent({ type: 'text', text: prose }).text, prose)
  const folded = PNG.match(/.{1,20}/g).join('\r\n')
  const value = tracker().accept({ ...event('end', presentation()), output: [{ type: 'image', mimeType: 'image/png', data: folded }] })
  assert.equal(value.body.resources[0].state, 'pending')
  let saved
  const result = await materializeResources(value, { saveImage: async image => { saved = image; return { id: randomUUID(), mediaType: image.mediaType } } })
  assert.equal(saved.data, PNG)
  assert.equal(result.body.resources[0].state, 'stored')
})

test('media limits and unreadable sources stay visible without pretending to display', async () => {
  const huge = 'A'.repeat(Math.ceil((RESOURCE_LIMITS.imageBytes + 1) * 4 / 3) + 8)
  const limited = tracker().accept({ type: 'tool', name: 'Fixture', callId: 'limits', phase: 'end', presentation: presentation(), output: [
    { type: 'image', mimeType: 'image/png', data: huge },
    { type: 'image', mimeType: 'image/avif', data: PNG },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'resource', resource: { uri: 'file:///bin.dat', mimeType: 'application/octet-stream', blob: 'AAAA' } },
    { type: 'file', attachment: { attachmentId: 'fixed-file', name: 'x.bin', bytes: 3 } },
  ] })
  assert.deepEqual(limited.body.resources.map(item => [item.kind, item.state, item.reason]), [
    ['image', 'unavailable', 'image-too-large'], ['image', 'unsupported', 'unsupported-type'],
    ['image', 'unavailable', 'invalid-image'], ['file', 'reference', 'no-reader'], ['file', 'reference', 'no-reader']])
  const invalid = tracker().accept({ type: 'tool', name: 'Fixture', callId: 'invalid', phase: 'end', presentation: presentation(),
    output: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] })
  assert.deepEqual([invalid.body.resources[0].state, invalid.body.resources[0].reason], ['unavailable', 'invalid-image'])
  await withStore(async ({ rt, store }) => {
    rt.saveImages = async () => { throw new Error('fixture write failure') }
    const failed = await store.save('s', tracker().accept({ type: 'tool', name: 'Fixture', callId: 'bad', phase: 'end', presentation: presentation(),
      output: [{ type: 'image', mimeType: 'image/png', data: PNG }] }))
    assert.equal(failed.body.resources[0].state, 'unavailable')
    assert.equal(failed.body.resources[0].reason, 'storage-unavailable')
    assert.equal(failed.details.state, 'stored')
  })
  await withStore(async ({ rt, store }) => {
    rt.saveImages = async images => images.map(image => ({ id: randomUUID(), mediaType: image.mediaType }))
    rt.ctx = { attachments: { readImage: async () => { throw new Error('gone') } } }
    const unreadable = await store.save('s', tracker().accept({ type: 'tool', name: 'Native', callId: 'dsh', phase: 'end', presentation: presentation(),
      output: [{ type: 'image', attachment: { attachmentId: 'fixed-attachment', mediaType: 'image/png', bytes: 68, width: 96, height: 64 } }] }))
    assert.equal(unreadable.body.resources[0].state, 'unavailable')
    assert.equal(unreadable.body.resources[0].reason, 'attachment-unavailable')
    assert.doesNotMatch(JSON.stringify(unreadable), /fixed-attachment/)
  })
  await withStore(async ({ home, rt, store }) => {
    const reads = []
    rt.saveImages = async images => images.map(image => ({ id: randomUUID(), mediaType: image.mediaType, name: image.name }))
    rt.ctx = { attachments: { validateImage: async () => {}, readImage: async ref => { reads.push(ref); return { ref: { mediaType: 'image/png', name: 'native.png' }, data: Buffer.from(PNG, 'base64') } } } }
    const reference = { attachmentId: 'sha256:fixed', mediaType: 'image/png', bytes: 68, width: 96, height: 64, name: 'native.png' }
    const conversationOf = rt.conversationOf
    rt.conversationOf = id => ({ ...conversationOf(id), session: { id, nativeSessionId: 'native-s' } })
    rt.ctx.sessionController = { inspect: async id => {
      assert.equal(id, 'native-s')
      return { events: [{ type: 'tool/result', data: { message: { content: [{ type: 'image', attachment: reference }] } } }] }
    } }
    const native = await store.save('s', tracker().accept({ type: 'tool', name: 'Native', callId: 'dsh', phase: 'end', presentation: presentation(),
      output: [{ type: 'image', attachment: reference }] }))
    assert.deepEqual(reads, [reference], 'the engine attachment reference reaches the store unchanged')
    assert.equal(native.body.resources[0].state, 'stored')
    assert.equal(native.body.resources[0].name, 'native.png')
    const disk = await readFile(join(home, 'stream-details', `${native.details.ref}.json`), 'utf8')
    assert.doesNotMatch(disk, /fixed-attachment|iVBORw0KGgo/)
  })
})

test('host attachments must be present in the owning session before their bytes can be read', async () => {
  await withStore(async ({ rt, store }) => {
    const reference = { attachmentId: 'sha256:foreign', mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
    const conversationOf = rt.conversationOf
    rt.conversationOf = id => ({ ...conversationOf(id), session: { id, nativeSessionId: `native-${id}` } })
    let reads = 0
    rt.ctx = {
      sessionController: { inspect: async id => ({ events: id === 'native-s2'
        ? [{ type: 'user/message', data: { content: [{ type: 'image', attachment: reference }] } }] : [] }) },
      attachments: { validateImage: async () => {}, readImage: async () => { reads += 1; return { ref: reference, data: Buffer.from(PNG, 'base64') } } },
    }
    rt.saveImages = async images => images.map(image => ({ id: randomUUID(), mediaType: image.mediaType }))
    const denied = await store.save('s', tracker().accept({ ...event('end', presentation()), output: [{ type: 'image', attachment: reference }] }))
    assert.equal(denied.body.resources[0].reason, 'attachment-unavailable')
    assert.equal(reads, 0, 'an attachment from another session never reaches the global store')
    const run = createRecordTracker({ engine: 'fixture', profileId: 'p', conversationId: 's2' })
    const allowed = await store.save('s2', run.accept({ ...event('end', presentation()), output: [{ type: 'image', attachment: reference }] }))
    assert.equal(allowed.body.resources[0].state, 'stored')
    assert.equal(reads, 1)
  })
})

test('an oversized source attachment is refused before it is copied', async () => {
  const huge = 'A'.repeat(Math.ceil((RESOURCE_LIMITS.imageBytes + 1) * 4 / 3) + 8)
  let saved = 0
  const value = { body: { resources: [{ kind: 'image', state: 'pending', mimeType: 'image/png', bytes: 68,
    attachment: { attachmentId: 'sha256:' + '0'.repeat(64), mediaType: 'image/png', bytes: 68, width: 96, height: 64 } }] } }
  const result = await materializeResources(value, {
    readAttachment: async () => ({ mediaType: 'image/png', data: huge }),
    saveImage: async () => { saved += 1 },
  })
  assert.deepEqual([result.body.resources[0].state, result.body.resources[0].reason], ['unavailable', 'image-too-large'])
  assert.equal(saved, 0)
})

test('legacy transcript, saved detail and attachment route expose a confirmed tool image after restart', async () => {
  registerEngine('media-fixture', {
    info: { id: 'media-fixture', label: 'Media fixture', requiresCwd: true }, validate: () => ({}),
    create: ({ onEvent }) => ({ openSession: async () => {}, hasSession: () => true, onEvent() {}, steer: async () => 'refused', interruptTurn: async () => {}, respondToRequest: async () => false, dispose() {},
      async sendTurn() {
        onEvent({ type: 'turn/start', turnId: 'media-turn' })
        onEvent({ type: 'tool', turnId: 'media-turn', callId: 'media', name: 'Read image', phase: 'start', presentation: presentation(), input: { path: '/tmp/shot.png' } })
        onEvent({ type: 'tool', turnId: 'media-turn', callId: 'media', name: 'Read image', phase: 'end', presentation: presentation(),
          output: [{ type: 'text', text: '图片如下' }, { type: 'image', mimeType: 'image/png', data: PNG, name: 'shot.png' }] })
        onEvent({ type: 'turn/end', reason: 'done' })
      },
    }),
  })
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Media', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Media', engine: 'media-fixture', workspace: workspace.id })
    await host.api('send', { profile: profile.id, text: 'show' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    const lines = await host.api('transcript', { profile: profile.id })
    const end = lines.find(line => line.kind === 'tool' && line.phase === 'end')
    assert.equal(end.output, '图片如下')
    assert.equal(end.presentation.body.resources[0].state, 'stored')
    assert.doesNotMatch(JSON.stringify(lines), /iVBORw0KGgo/)
    const ref = end.presentation.body.resources[0].ref
    assert.deepEqual(await host.api('attachment', { id: ref.id, mediaType: ref.mediaType }), { mediaType: 'image/png', data: PNG })
    const session = (await host.api('state')).profiles.find(item => item.id === profile.id).activeSessionId
    const detail = await host.api('stream-detail', { profile: profile.id, session, ref: end.presentation.details.ref })
    assert.equal(detail.body.outputText, '图片如下')
    assert.equal(detail.body.resources[0].ref.id, ref.id)
    assert.doesNotMatch(JSON.stringify(detail), /iVBORw0KGgo/)
    assert.doesNotMatch(await readFile(join(host.home, 'state.json'), 'utf8'), /iVBORw0KGgo/)
    host.dispose()
    const restored = boot(host.home)
    try {
      const replayed = await restored.api('transcript', { profile: profile.id })
      const again = replayed.find(line => line.kind === 'tool' && line.phase === 'end')
      assert.equal(again.presentation.body.resources[0].ref.id, ref.id)
      assert.deepEqual(await restored.api('attachment', { id: ref.id, mediaType: ref.mediaType }), { mediaType: 'image/png', data: PNG })
      assert.equal((await restored.api('stream-detail', { profile: profile.id, session, ref: again.presentation.details.ref })).body.outputText, '图片如下')
    } finally { restored.dispose() }
  }, { attachments: { validateImage: async () => {} } })
})

test('image validation failures and hosts without a decoder cannot publish stored image references', async () => {
  await withStore(async ({ rt, store }) => {
    let writes = 0
    rt.saveImages = async () => { writes += 1; return [{ id: randomUUID(), mediaType: 'image/png' }] }
    const value = () => tracker().accept({ ...event('end', presentation()), output: [{ type: 'image', mimeType: 'image/png', data: PNG }] })
    rt.ctx.attachments.validateImage = async () => { throw new Error('truncated raster') }
    const corrupt = await store.save('s', value())
    assert.equal(corrupt.body.resources[0].reason, 'invalid-image')
    delete rt.ctx.attachments.validateImage
    const unsupported = await store.save('s', value())
    assert.equal(unsupported.body.resources[0].reason, 'no-reader')
    assert.equal(writes, 0)
  })
})
