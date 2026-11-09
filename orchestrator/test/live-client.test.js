// The shared poll in live.js: one timer for any number of subscribers, the
// structure version decides full vs unchanged, and a transcript delta keeps
// unchanged line objects identical across pulls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'
import { withHost } from './helpers/host.js'

const timers = []
const fakeTimers = () => {
  let serial = 0
  return {
    AbortController, URLSearchParams, TextDecoder,
    crypto: { randomUUID: () => `stream-${++serial}` },
    setTimeout: (callback, ms) => { const id = ++serial; timers.push({ callback, ms, id, run() { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1); callback() } }); return id },
    clearTimeout: id => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1) },
  }
}
const flush = async () => { for (let round = 0; round < 20; round++) await new Promise(resolve => setImmediate(resolve)) }

// live.js 用全局 fetch 访问 /api/nodo；answers[i]() 依次应答。
const load = async answers => {
  let at = 0
  return loadClient('live.js', {
    globals: fakeTimers(),
    call: endpoint => { if (!endpoint) throw new Error('stream disconnected'); return answers[Math.min(at++, answers.length - 1)]() },
  })
}

test('one fallback poll timer serves every subscriber, and only structure changes fetch a full view', async () => {
  timers.length = 0
  const { subscribeLive, getLive } = await load([
    () => ({ struct: 1, activity: 0, work: {}, profiles: [], tasks: [{ id: 'task', status: 'open' }] }),
    () => ({ struct: 1, activity: 0, unchanged: true, work: { s: { active: true } }, approvals: [], stats: {} }),
    () => ({ struct: 2, activity: 5, work: {}, profiles: [], tasks: [{ id: 'task', status: 'review' }] }),
  ])
  const stopA = subscribeLive(() => {})
  const stopB = subscribeLive(() => {})
  await flush()
  assert.equal(getLive().tasks[0].status, 'open')
  assert.equal(timers.filter(timer => timer.ms === 1200).length, 1, 'two subscribers share one fallback poll timer')
  // 手动走一拍定时器：unchanged 应答合并 live 数据、结构版本不动。
  timers.find(timer => timer.ms === 1200).run()
  await flush()
  assert.equal(getLive().struct, 1)
  assert.deepEqual(getLive().work.s, { active: true })
  assert.equal(getLive().tasks[0].status, 'open')
  timers.find(timer => timer.ms === 400).run()
  await flush()
  assert.equal(getLive().tasks[0].status, 'review')
  assert.ok(timers.length >= 1, 'the timer reschedules itself')
  stopA(); stopB()
  assert.equal(timers.length, 0)
})

test('failed stream connections back off exponentially while sharing the fallback timer', async () => {
  timers.length = 0
  const { subscribeLive } = await load([() => ({ struct: 1, activity: 0, work: {}, profiles: [] })])
  const stop = subscribeLive(() => {})
  await flush()
  for (const delay of [1000, 2000, 4000]) {
    assert.equal(timers.filter(timer => timer.ms === 1200).length, 1)
    const retry = timers.find(timer => timer.ms === delay)
    assert.ok(retry, `reconnect delay ${delay}`)
    retry.run(); await flush()
  }
  stop(); assert.equal(timers.length, 0)
})

test('fallback state merges runtime session metadata without needing a structure change', async () => {
  timers.length = 0
  const { subscribeLive, getLive } = await load([
    () => ({ struct: 1, activity: 0, work: {}, profiles: [{ id: 'p', sessions: [{ id: 's', updatedAt: 1 }] }] }),
    () => ({ struct: 1, activity: 1, unchanged: true, work: {}, sessions: { s: { updatedAt: 2, briefSent: true } } }),
  ])
  const stop = subscribeLive(() => {})
  await flush()
  timers.find(timer => timer.ms === 1200).run(); await flush()
  assert.equal(getLive().profiles[0].sessions[0].updatedAt, 2)
  assert.equal(getLive().profiles[0].sessions[0].briefSent, true)
  stop()
})

test('a dsh update install drops the stream, holds reconnects and keeps the fallback poll serving', async () => {
  timers.length = 0
  let installing = null, streams = 0
  const { subscribeLive, getLive, liveError } = await loadClient('live.js', {
    globals: { ...fakeTimers(), crypto: { randomUUID: () => 'stream' }, dshDesktop: { updates: { subscribe: listener => { installing = listener; return () => { installing = null } } } } },
    call: endpoint => {
      if (!endpoint) { streams++; throw new Error('stream disconnected') }
      return { struct: 1, activity: 0, work: {}, profiles: [], tasks: [{ id: 'task', status: 'open' }] }
    },
  })
  const stop = subscribeLive(() => {})
  await flush()
  assert.equal(streams, 1, 'the stream retry is pending')
  const errorBefore = liveError()
  installing?.({ phase: 'installing' })
  await flush()
  assert.equal(streams, 1, 'no reconnect is attempted while installing')
  assert.ok(timers.find(timer => timer.ms === 1200), 'the fallback poll keeps running')
  assert.equal(liveError(), errorBefore, 'pausing surfaces no new error')
  timers.find(timer => timer.ms === 1200).run(); await flush()
  assert.equal(getLive().tasks[0].status, 'open', 'polls still serve the view during the install')
  assert.equal(streams, 1, 'the poll does not restart the stream while installing')
  installing?.({ phase: 'ready' })
  await flush()
  assert.equal(streams, 2, 'leaving installing reconnects the stream')
  assert.ok(timers.length >= 1, 'the reconnect reschedules its own retry')
  stop()
  assert.equal(timers.length, 0)
  assert.equal(installing, null, 'unsubscribing releases the dshDesktop.updates listener')
})

test('an open live stream is aborted the moment dsh enters installing and reopens after it leaves', async () => {
  timers.length = 0
  let installing = null
  const streams = []
  const fetch = async (url, options) => {
    if (String(url).includes('/live')) {
      let rejectRead, cancelled = false
      const pending = new Promise((resolve, reject) => { rejectRead = reject })
      options.signal.addEventListener('abort', () => rejectRead(new Error('aborted')), { once: true })
      const reader = { read: () => pending, cancel: async () => { cancelled = true }, releaseLock: () => {} }
      streams.push({ signal: options.signal, get open() { return !options.signal.aborted && !cancelled } })
      return { ok: true, body: { getReader: () => reader } }
    }
    return { json: async () => ({ ok: true, value: { struct: 1, activity: 0, work: {}, profiles: [] } }) }
  }
  const { subscribeLive, liveError } = await loadClient('live.js', {
    globals: { ...fakeTimers(), crypto: { randomUUID: () => 'stream' }, fetch, dshDesktop: { updates: { subscribe: listener => { installing = listener; return () => { installing = null } } } } },
  })
  const stop = subscribeLive(() => {})
  await flush()
  assert.equal(streams.length, 1, 'the stream is connected')
  installing?.({ phase: 'installing' })
  await flush()
  assert.equal(streams[0].signal.aborted, true, 'the open request is aborted, not left hanging')
  assert.equal(streams.filter(stream => stream.open).length, 0, 'no stream stays open while installing')
  assert.equal(streams.length, 1, 'no reconnect fires while installing')
  assert.equal(liveError(), '', 'the abort is not surfaced as an error')
  assert.ok(timers.find(timer => timer.ms === 1200), 'the fallback poll takes over')
  installing?.({ phase: 'idle' })
  await flush()
  assert.equal(streams.length, 2, 'leaving installing opens the stream again')
  assert.equal(streams[1].open, true, 'the resumed stream is live')
  stop()
  assert.equal(timers.length, 0)
  assert.equal(installing, null)
})

test('a transcript delta merges in place: unchanged lines keep their identity', async () => {
  const requests = []
  const first = { full: true, token: 't1', base: 1, dirty: 5, lines: [{ n: 1, line: { who: 'user', kind: 'text', text: 'one' } }, { n: 2, line: { who: 'agent', kind: 'text', text: 'two' } }] }
  const second = { token: 't1', base: 1, dirty: 6, appended: [{ n: 3, line: { who: 'agent', kind: 'text', text: 'three' } }], changed: [{ n: 2, line: { who: 'agent', kind: 'text', text: 'two!' } }] }
  let at = 0
  const { pullTranscript, transcriptOf } = await loadClient('live.js', {
    globals: fakeTimers(),
    call: (endpoint, payload) => { requests.push(payload ?? null); return at++ === 0 ? first : second },
  })
  const key = 'p:s'
  await pullTranscript('p', 's')
  const initial = transcriptOf(key)
  assert.deepEqual(initial.map(line => line.text), ['one', 'two'])
  await pullTranscript('p', 's')
  const after = transcriptOf(key)
  assert.deepEqual(after.map(line => line.text), ['one', 'two!', 'three'])
  assert.equal(after[0], initial[0], 'an unchanged line keeps its object identity')
  assert.notEqual(after[1], initial[1], 'a changed line is a new object')
  // 第二次请求带上下文里的位置。
  assert.deepEqual(requests[0].since, {}, 'the first pull asks for a numbered full answer')
  assert.deepEqual(requests[1].since, { token: 't1', base: 1, n: 2, dirty: 5 })
})

test('watched transcripts pull once on mount and again only when the activity count moves', async () => {
  timers.length = 0
  const pulls = []
  let activity = 1
  const { subscribeLive, watchTranscript, getStoreVersion } = await loadClient('live.js', {
    globals: fakeTimers(),
    call: (endpoint, payload) => {
      if (!endpoint) throw new Error('stream disconnected')
      if (endpoint === 'state') return { struct: 1, activity, unchanged: payload !== undefined, work: {}, approvals: [], stats: {} }
      pulls.push(payload.since ?? null)
      return pulls.length === 1
        ? { full: true, token: 't', base: 1, dirty: 1, lines: [{ n: 1, line: { who: 'agent', kind: 'text', text: 'a' } }] }
        : { token: 't', base: 1, dirty: activity, appended: [], changed: [] }
    },
  })
  const stopLive = subscribeLive(() => {})
  const stopWatch = watchTranscript('p', 's')
  await flush()
  assert.equal(pulls.length, 1, 'mounting pulls once and the landed pull does not trigger another')
  const version = getStoreVersion()
  timers.find(timer => timer.ms === 1200).run()
  await flush()
  assert.equal(pulls.length, 1, 'an unchanged activity count pulls nothing')
  activity = 2
  timers.find(timer => timer.ms === 1200).run()
  await flush()
  assert.equal(pulls.length, 2, 'a moved activity count pulls the watched session')
  assert.equal(getStoreVersion(), version, 'an empty delta does not bump the store')
  stopWatch()
  activity = 3
  timers.find(timer => timer.ms === 1200).run()
  await flush()
  assert.equal(pulls.length, 2, 'an unwatched session is not pulled')
  stopLive()
})

test('a pull asked for while one is in flight runs once after it lands', async () => {
  const pulls = []
  let release
  const { pullTranscript } = await loadClient('live.js', {
    globals: fakeTimers(),
    call: async (endpoint, payload) => {
      pulls.push(payload.since ?? null)
      if (pulls.length === 1) await new Promise(resolve => { release = resolve })
      return { full: true, token: 't', base: 1, dirty: pulls.length, lines: [] }
    },
  })
  const first = pullTranscript('p', 's')
  await flush()
  void pullTranscript('p', 's')
  void pullTranscript('p', 's')
  release()
  await first
  await flush()
  assert.equal(pulls.length, 2)
})

test('a forced refresh during an in-flight state poll follows up once instead of racing a second', async () => {
  timers.length = 0
  let release
  const states = []
  const { subscribeLive, refreshLive } = await loadClient('live.js', {
    globals: fakeTimers(),
    call: async (endpoint, payload) => {
      if (!endpoint) throw new Error('stream disconnected')
      states.push(payload ?? null)
      if (states.length === 1) await new Promise(resolve => { release = resolve })
      return { struct: 1, activity: 0, work: {}, profiles: [] }
    },
  })
  const stop = subscribeLive(() => {})
  await flush()
  assert.equal(states.length, 1, 'the initial poll is in flight')
  const refresh = refreshLive(true)
  await flush()
  assert.equal(states.length, 1, 'no second request starts while one is in flight')
  release({ struct: 1, activity: 0, work: {}, profiles: [] })
  await refresh
  assert.equal(states.length, 2, 'the forced refresh runs once, after the flight lands')
  await flush()
  assert.equal(states.length, 2, 'no further polls follow')
  stop()
})

test('watch set changes ride the open stream: adds and removes never reconnect it', async () => {
  timers.length = 0
  const connections = [], posts = []
  const fetch = async (url, options) => {
    if (String(url).includes('/live')) {
      let rejectRead
      const pending = new Promise((resolve, reject) => { rejectRead = reject })
      options.signal.addEventListener('abort', () => rejectRead(new Error('aborted')), { once: true })
      const reader = { read: () => pending, cancel: async () => {}, releaseLock: () => {} }
      connections.push(new URL(url, 'http://test').searchParams)
      return { ok: true, body: { getReader: () => reader } }
    }
    const { endpoint, payload } = JSON.parse(options.body)
    posts.push({ endpoint, payload })
    const value = endpoint === 'transcript' ? { full: true, token: 't', base: 1, dirty: 1, lines: [] } : true
    return { json: async () => ({ ok: true, value }) }
  }
  const { subscribeLive, watchTranscript } = await loadClient('live.js', {
    globals: { ...fakeTimers(), crypto: { randomUUID: () => 'stream' }, fetch },
  })
  const stopLive = subscribeLive(() => {})
  await flush()
  assert.equal(connections.length, 1)
  const stopWatch = watchTranscript('p', 's')
  await flush()
  assert.equal(connections.length, 1, 'watching a session keeps the stream open')
  assert.deepEqual(posts.map(post => post.endpoint), ['state', 'live-watch', 'transcript', 'live-watch'],
    'the watch add goes out at once, and the landed pull supplies the positions in a second add')
  assert.deepEqual(posts[1].payload, { id: 'stream', add: [{ profile: 'p', session: 's' }], remove: [] },
    'the first add carries no since: the pull owns the first full copy')
  assert.deepEqual(posts[3].payload.add, [{ profile: 'p', session: 's', since: { token: 't', base: 1, n: 0, dirty: 1 } }])
  stopWatch()
  await flush()
  assert.equal(connections.length, 1, 'unwatching keeps the stream open too')
  assert.deepEqual(posts.at(-1).payload, { id: 'stream', add: [], remove: ['p:s'] })
  stopLive()
})

test('a failed first pull is retried on the next activity move even while the stream stays up', async () => {
  timers.length = 0
  const pulls = [], connections = [], posts = []
  let controller, states = 0
  const encode = frame => new TextEncoder().encode(JSON.stringify(frame) + '\n')
  const fetch = async (url, options) => {
    if (String(url).includes('/live')) {
      const stream = new Response(new ReadableStream({ start(value) { controller = value }, cancel() {} }))
      options.signal.addEventListener('abort', () => controller.close(), { once: true })
      connections.push(url)
      return stream
    }
    const { endpoint, payload } = JSON.parse(options.body)
    posts.push({ endpoint, payload })
    if (endpoint === 'transcript') {
      pulls.push(payload)
      // The first pull dies on the relay; the retry succeeds.
      return pulls.length === 1
        ? { json: async () => ({ ok: false, error: { message: 'relay dropped' } }) }
        : { json: async () => ({ ok: true, value: { full: true, token: 't', base: 1, dirty: 1,
            lines: [{ n: 1, line: { who: 'agent', kind: 'text', text: 'late' } }] } }) }
    }
    if (endpoint === 'state') { states++; return { json: async () => ({ ok: true, value: { struct: states, activity: states, work: {}, profiles: [] } }) } }
    return { json: async () => ({ ok: true, value: true }) }
  }
  const { subscribeLive, watchTranscript, transcriptOf, transcriptError } = await loadClient('live.js', {
    globals: { ...fakeTimers(), crypto: { randomUUID: () => 'stream' }, fetch },
  })
  const stopLive = subscribeLive(() => {})
  const stopWatch = watchTranscript('p', 's')
  await flush()
  assert.equal(connections.length, 1, 'the stream is connected')
  assert.equal(pulls.length, 1)
  assert.equal(transcriptError('p:s'), 'relay dropped', 'the failed first pull surfaces its error')
  // An activity move reaches the client as a structure change; its poll must re-pull.
  controller.enqueue(encode({ type: 'structure', struct: 2 }))
  await flush()
  assert.equal(pulls.length, 2, 'the activity move re-pulls the session whose first pull never landed')
  assert.deepEqual(transcriptOf('p:s').map(line => line.text), ['late'])
  assert.equal(transcriptError('p:s'), '')
  // The retry's positions must reach the host, or the stream stays silent forever.
  assert.deepEqual(posts.filter(post => post.endpoint === 'live-watch').at(-1).payload.add,
    [{ profile: 'p', session: 's', since: { token: 't', base: 1, n: 1, dirty: 1 } }])
  assert.equal(connections.length, 1, 'the retry keeps the stream open')
  // The next activity move pulls nothing: the session holds positions now.
  controller.enqueue(encode({ type: 'structure', struct: 3 }))
  await flush()
  assert.equal(pulls.length, 2, 'a session with positions is not re-pulled again')
  stopWatch(); stopLive()
})

test('the page drops the head the host trimmed, so rows stay aligned past the line cap', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    for (let index = 1; index <= 800; index++) rt.appendLine('s', { who: 'agent', kind: 'text', text: `L${index}` })
    const { pullTranscript, transcriptOf } = await loadClient('live.js', {
      globals: fakeTimers(),
      call: (_endpoint, payload) => structuredClone(rt.transcriptDelta('s', payload.since)),
    })
    await pullTranscript('p', 's')
    for (let index = 801; index <= 810; index++) rt.appendLine('s', { who: 'agent', kind: 'text', text: `L${index}` })
    await pullTranscript('p', 's')
    assert.deepEqual(transcriptOf('p:s').map(line => line.text), rt.state.transcripts.s.map(line => line.text))
  })
})

test('an archived transcript held only by dsh is kept after its first answer', async () => {
  const requests = []
  const { pullTranscript, transcriptOf } = await loadClient('live.js', {
    globals: fakeTimers(),
    call: (_endpoint, payload) => {
      requests.push(payload.since)
      return requests.length === 1 ? { archived: true, lines: [{ who: 'agent', kind: 'text', text: 'from dsh' }] } : { unchanged: true }
    },
  })
  await pullTranscript('p', 's')
  const held = transcriptOf('p:s')
  await pullTranscript('p', 's')
  assert.deepEqual(requests[1], { archived: true })
  assert.equal(transcriptOf('p:s'), held)
  assert.deepEqual(held.map(line => line.text), ['from dsh'])
})
