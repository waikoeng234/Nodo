import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient } from './helpers/client-module.js'
import { withHost } from './helpers/host.js'

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
    const loaded = await loadClient('live.js', {
      stubs: process.env.NODO_PHASE3_BEFORE ? { 'live.js': readFileSync('/tmp/nodo-phase3-before/live.js', 'utf8') } : {},
      globals: { AbortController, URLSearchParams, TextDecoder,
        setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, ms }); return id },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => {
          if (options.body) {
            const { endpoint, payload } = JSON.parse(options.body)
            requests.push(endpoint)
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
    first.controller.enqueue(encode({ type: 'live', work: { [session]: { active: true } }, sessions: { [session]: { updatedAt: 123 } } }))
    await flush()
    assert.equal(loaded.getLive().work[session].active, true)
    assert.equal(loaded.getLive().profiles[0].sessions.find(row => row.id === session).updatedAt, 123)
    const initial = JSON.parse(first.query.get('watch'))[0].since
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
    assert.deepEqual(requests, ['state', 'transcript'], 'connected updates issue no polling requests')
    assert.equal(timers.size, 0)
    resumed.controller.enqueue(encode({ type: 'structure', struct: loaded.getLive().struct + 1 }))
    await flush()
    assert.deepEqual(requests, ['state', 'transcript', 'state'], 'a structure notification reads the full view once')
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
    const loaded = await loadClient('live.js', { globals: { AbortController, URLSearchParams, TextDecoder,
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
