import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient } from './helpers/client-module.js'
import { until, withHost } from './helpers/host.js'

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
const encode = frame => new TextEncoder().encode(JSON.stringify(frame) + '\n')
const positions = value => ({ token: value.token, base: value.base, dirty: value.dirty, n: value.base + value.lines.length - 1 })
const frames = async reader => JSON.parse(new TextDecoder().decode((await reader.read()).value))
const nextFrame = async (reader, type) => { let frame; do { frame = await frames(reader) } while (frame.type !== type); return frame }

test('a shared stream resumes changed and appended rows, stays idle, and cancels on unmount', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Stream', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Stream', engine: 'echo', workspace: workspace.id })
    const session = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    const requests = [], connections = [], timers = new Map()
    let serial = 0
    let watchUpdate = null
    const loaded = await loadClient('live.js', {
      stubs: process.env.NODO_PHASE3_BEFORE ? { 'live.js': readFileSync('/tmp/nodo-phase3-before/live.js', 'utf8') } : {},
      globals: { AbortController, URLSearchParams, TextDecoder, crypto: { randomUUID: () => `stream-${++serial}` },
        setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, ms }); return id },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => {
          if (options.body) {
            const { endpoint, payload } = JSON.parse(options.body)
            requests.push(endpoint)
            if (endpoint === 'live-watch') watchUpdate = payload
            return Response.json(await rt.handle(endpoint, payload))
          }
          const query = new URL(url, 'http://test').searchParams
          let controller
          const response = new Response(new ReadableStream({ start(value) { controller = value }, cancel() {} }))
          const entry = { query, controller, signal: options.signal }
          options.signal.addEventListener('abort', () => { if (!entry.ended) { entry.ended = true; controller.close() } }, { once: true })
          connections.push(entry)
          return response
        },
      },
    })
    const stopA = loaded.subscribeLive(() => {}), stopB = loaded.subscribeLive(() => {})
    await flush()
    assert.equal(connections.length, 1)
    assert.equal(timers.size, 0, 'a healthy stream has no polling or retry timer')
    const stopWatch = loaded.watchTranscript(profile.id, session)
    await flush()
    const key = `${profile.id}:${session}`
    const first = connections.at(-1)
    assert.equal(connections.length, 1, 'watching a session keeps the stream open')
    assert.equal(requests.at(-1), 'live-watch')
    first.controller.enqueue(encode({ type: 'live', work: { [session]: { active: true } }, sessions: { [session]: { updatedAt: 123 } } }))
    await flush()
    assert.equal(loaded.getLive().work[session].active, true)
    assert.equal(loaded.getLive().profiles[0].sessions.find(row => row.id === session).updatedAt, 123)
    // The watch update carries the positions the transcript pull landed with.
    const initial = watchUpdate.add[0].since
    // Only a running turn's rows change; a background save settles the rows of an idle session.
    const workView = rt.workView
    rt.workView = () => ({ ...workView(), [session]: { active: true } })
    const line = rt.appendLine(session, { who: 'agent', kind: 'text', text: 'one', open: true })
    const value = structuredClone(rt.transcriptDelta(session, initial))
    first.controller.enqueue(encode({ type: 'transcript', key, value }))
    await flush()
    assert.deepEqual(loaded.transcriptOf(key).map(row => row.text), ['one'])
    first.ended = true; first.controller.close()
    await flush()
    assert.ok([...timers.values()].some(timer => timer.ms === 1000), 'disconnect schedules retry')
    const retry = [...timers].find(([, timer]) => timer.ms === 1000)
    timers.delete(retry[0]); retry[1].callback()
    await flush()
    const resumed = connections.at(-1)
    const since = JSON.parse(resumed.query.get('watch'))[0].since
    assert.equal(since.n, initial.n + 1)
    line.text = 'one!'; rt.touchLine(session, line)
    rt.appendLine(session, { who: 'agent', kind: 'text', text: 'two' })
    resumed.controller.enqueue(encode({ type: 'transcript', key, value: structuredClone(rt.transcriptDelta(session, since)) }))
    resumed.controller.enqueue(encode({ type: 'live', work: { [session]: null } }))
    await flush()
    assert.deepEqual(loaded.transcriptOf(key).map(row => row.text), ['one!', 'two'])
    assert.equal(loaded.getLive().work[session], undefined)
    assert.deepEqual(requests, ['state', 'live-watch', 'transcript', 'live-watch'],
      'connected updates issue no polling requests: one watch add at mount, one with the positions the pull landed')
    assert.equal(timers.size, 0)
    resumed.controller.enqueue(encode({ type: 'structure', struct: loaded.getLive().struct + 1 }))
    await flush()
    assert.deepEqual(requests, ['state', 'live-watch', 'transcript', 'live-watch', 'state'], 'a structure notification reads the full view once')
    stopA(); assert.equal(resumed.signal.aborted, false)
    stopWatch(); stopB(); await flush()
    assert.equal(resumed.signal.aborted, true)
    assert.equal(timers.size, 0)
  })
})

test('host batches events, resumes positions, redacts rows, and releases aborted and unloaded streams', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Stream', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Stream', engine: 'echo', workspace: workspace.id })
    const session = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    rt.workView = () => ({ [session]: { active: true } })
    await host.api('secret-set', { name: 'PUSH_FIXTURE', value: 'fake-push-secret-value' })
    const route = host.routes.find(route => route.path === '/api/nodo/live')
    assert.equal(route.requestBody, 'buffered')
    const initial = rt.transcriptDelta(session, {})
    let since = positions(initial)
    const connect = async signal => (await route.fetch(new Request(`http://test/api/nodo/live?${new URLSearchParams({ struct: String(rt.versions().struct), watch: JSON.stringify([{ profile: profile.id, session, since }]) })}`, { signal }))).body.getReader()
    const abort = new AbortController(), reader = await connect(abort.signal)
    assert.equal((await frames(reader)).type, 'live')
    const line = rt.appendLine(session, { who: 'agent', kind: 'text', text: 'a' })
    line.text = 'ab fake-push-secret-value'; rt.touchLine(session, line)
    const first = await nextFrame(reader, 'transcript')
    assert.equal(first.type, 'transcript')
    assert.deepEqual(first.value.appended.map(row => row.line.text), ['ab [secret:PUSH_FIXTURE]'])
    since = { ...since, dirty: first.value.dirty, n: first.value.appended.at(-1).n }
    abort.abort(); while (!(await reader.read()).done) {}
    line.text = 'abc'; rt.touchLine(session, line)
    const resumed = await connect()
    await nextFrame(resumed, 'live')
    const delta = await nextFrame(resumed, 'transcript')
    assert.equal(delta.value.appended.length, 0)
    assert.deepEqual(delta.value.changed.map(row => row.line.text), ['abc'])
    const version = rt.versions().struct
    await rt.saveRuntime(session)
    assert.equal(rt.versions().struct, version)
    await rt.save()
    assert.equal((await frames(resumed)).type, 'structure')
    await host.dispose()
    // Disposal closes even a subscriber waiting for the next update.
    while (!(await resumed.read()).done) {}
  })
})

test('a reconnected stream replaces running state instead of keeping entries that ended while it was down', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Stream', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Stream', engine: 'echo', workspace: workspace.id })
    const session = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    let work = { [session]: { active: true } }
    rt.workView = () => work
    const route = host.routes.find(route => route.path === '/api/nodo/live')
    const timers = new Map(), streams = []
    let serial = 0
    const loaded = await loadClient('live.js', { globals: { AbortController, URLSearchParams, TextDecoder, crypto: { randomUUID: () => `stream-${++serial}` },
      setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, ms }); return id },
      clearTimeout: id => timers.delete(id),
      fetch: async (url, options) => {
        if (options.body) { const { endpoint, payload } = JSON.parse(options.body); return Response.json(await rt.handle(endpoint, payload)) }
        const abort = new AbortController()
        streams.push(abort)
        options.signal.addEventListener('abort', () => abort.abort(), { once: true })
        return route.fetch(new Request(new URL(url, 'http://test'), { signal: abort.signal }))
      } } })
    const stop = loaded.subscribeLive(() => {})
    await flush()
    assert.equal(loaded.getLive().work[session]?.active, true)
    streams.at(-1).abort()
    await flush()
    work = {}
    const retry = [...timers].find(([, timer]) => timer.ms === 1000)
    timers.delete(retry[0]); retry[1].callback()
    await flush()
    assert.equal(streams.length, 2)
    assert.equal(loaded.getLive().work[session], undefined)
    stop()
  })
})

test('a failing push closes its subscribers instead of throwing from the timer', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const route = host.routes.find(route => route.path === '/api/nodo/live')
    const reader = (await route.fetch(new Request(`http://test/api/nodo/live?struct=${rt.versions().struct}`))).body.getReader()
    assert.equal((await frames(reader)).type, 'live')
    rt.liveSnapshot = () => { throw new Error('snapshot failed') }
    rt.notifyLive()
    assert.equal((await reader.read()).done, true)
  })
})

test('live-watch rewrites a stream watch set in place, and a cold entry stays silent until it holds positions', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Watch', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Watch', engine: 'echo', workspace: workspace.id })
    const one = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    const two = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    rt.appendLine(one, { who: 'agent', kind: 'text', text: 'a1' })
    const route = host.routes.find(route => route.path === '/api/nodo/live')
    const since = positions(rt.transcriptDelta(one, {}))
    const abort = new AbortController()
    const query = new URLSearchParams({ struct: String(rt.versions().struct), watch: JSON.stringify([{ profile: profile.id, session: one, since }]), id: 'watch-test' })
    const reader = (await route.fetch(new Request(`http://test/api/nodo/live?${query}`, { signal: abort.signal }))).body.getReader()
    assert.equal((await frames(reader)).type, 'live', 'the initial deliver carries no transcript for an unchanged position')
    assert.equal(await host.api('live-watch', { id: 'watch-test', add: [{ profile: profile.id, session: two }], remove: [] }), true)
    rt.appendLine(one, { who: 'agent', kind: 'text', text: 'a2' })
    rt.appendLine(two, { who: 'agent', kind: 'text', text: 'b1' })
    const cold = await nextFrame(reader, 'transcript')
    assert.equal(cold.key, `${profile.id}:${one}`, 'the cold entry is not pushed: its first copy belongs to the transcript pull')
    assert.equal(await Promise.race([frames(reader).then(() => 'frame'), new Promise(resolve => setTimeout(() => resolve('idle'), 250))]), 'idle',
      'no second transcript frame follows for the since-less entry')
    // Positions land: the follow-up add switches the entry on.
    const landed = positions(rt.transcriptDelta(two, {}))
    assert.equal(await host.api('live-watch', { id: 'watch-test', add: [{ profile: profile.id, session: two, since: landed }], remove: [] }), true)
    rt.appendLine(two, { who: 'agent', kind: 'text', text: 'b2' })
    const warm = await nextFrame(reader, 'transcript')
    assert.equal(warm.key, `${profile.id}:${two}`)
    assert.deepEqual(warm.value.appended.map(row => row.line.text), ['b2'])
    // Removing drops the target without touching the connection.
    assert.equal(await host.api('live-watch', { id: 'watch-test', add: [], remove: [`${profile.id}:${one}`] }), true)
    rt.appendLine(one, { who: 'agent', kind: 'text', text: 'a3' })
    rt.appendLine(two, { who: 'agent', kind: 'text', text: 'b3' })
    const kept = await nextFrame(reader, 'transcript')
    assert.equal(kept.key, `${profile.id}:${two}`, 'only the kept session still streams')
    assert.equal(await Promise.race([frames(reader).then(() => 'frame'), new Promise(resolve => setTimeout(() => resolve('idle'), 250))]), 'idle',
      'the removed session no longer produces frames')
    await assert.rejects(host.api('live-watch', { id: 'missing', add: [], remove: [] }), /No live stream/, 'an unknown stream id is refused')
    abort.abort()
  })
})

test('a cold switch downloads the transcript once: the stream never pushes a full copy', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Cold', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Cold', engine: 'echo', workspace: workspace.id })
    const session = (await host.api('session-create', { profile: profile.id, lazy: true })).id
    for (let index = 1; index <= 20; index++) rt.appendLine(session, { who: 'agent', kind: 'text', text: `L${index}` })
    const route = host.routes.find(route => route.path === '/api/nodo/live')
    const connections = [], pulls = [], handled = [], pushed = []
    const tap = new TransformStream({ transform(chunk, control) { pushed.push(chunk); control.enqueue(chunk) } })
    const loaded = await loadClient('live.js', {
      globals: { AbortController, URLSearchParams, TextDecoder, crypto: { randomUUID: () => 'stream' },
        setTimeout(callback, ms) { return setTimeout(callback, ms) }, clearTimeout: id => clearTimeout(id),
        fetch: async (url, options) => {
          if (options.body) {
            const { endpoint, payload } = JSON.parse(options.body)
            if (endpoint === 'transcript') pulls.push(payload)
            const done = rt.handle(endpoint, payload); handled.push(done)
            return Response.json(await done)
          }
          connections.push(url)
          const response = await route.fetch(new Request(new URL(url, 'http://test'), { signal: options.signal }))
          return new Response(response.body.pipeThrough(tap))
        } },
    })
    const stop = loaded.subscribeLive(() => {})
    const key = `${profile.id}:${session}`
    // A switch happens on a connected stream: hold the watch until the connect landed.
    await until(() => connections.length >= 1)
    await flush(); await flush()
    const stopWatch = loaded.watchTranscript(profile.id, session)
    await until(() => loaded.transcriptOf(key).length === 20)
    // state + watch add + transcript pull + the follow-up watch add carrying positions
    await until(() => handled.length >= 4)
    await handled.at(-1)
    rt.appendLine(session, { who: 'agent', kind: 'text', text: 'L21' })
    const streamFrames = []
    let buffer = ''
    const drain = () => {
      buffer += pushed.splice(0).map(chunk => new TextDecoder().decode(chunk)).join('')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) { streamFrames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    }
    await until(() => { drain(); return streamFrames.some(frame => frame.type === 'transcript') })
    assert.deepEqual(streamFrames.filter(frame => frame.type === 'transcript').map(frame => frame.value.appended.map(row => row.line.text)), [['L21']],
      'the only streamed transcript frame is the small delta after the positions landed')
    assert.ok(streamFrames.every(frame => frame.type !== 'transcript' || frame.value.full !== true), 'no full transcript rides the stream')
    assert.equal(pulls.length, 1, 'the cold switch pulls the transcript exactly once')
    assert.equal(connections.length, 1, 'the switch opens no second stream')
    stopWatch(); stop()
  })
})
