import { invalid } from '../../core/src/errors.js'

const WINDOW_MS = 100

export function install(rt) {
  const subscribers = new Set()
  // 观察中的流：id → subscriber。客户端经 /api/nodo 的 live-watch 端点对这条
  // 连接同步观察会话，不再靠断开重连改变观察集合。
  const streams = new Map()
  let timer, disposed = false
  const encode = value => new TextEncoder().encode(JSON.stringify(value) + '\n')
  const deliver = (subscriber, snapshot) => {
    try { subscriber.send(snapshot ?? rt.liveSnapshot()) } catch { subscriber.close() }
  }
  const publish = () => {
    timer = undefined
    let snapshot
    try { snapshot = rt.liveSnapshot() } catch {}
    for (const subscriber of subscribers) deliver(subscriber, snapshot)
  }
  rt.ctx.effect(() => rt.subscribeLive(() => {
    if (subscribers.size && timer === undefined) timer = setTimeout(publish, WINDOW_MS)
  }), 'nodo: live changes')
  // since 未知的会话保持沉默：首份数据由客户端的 transcript 拉取负责。
  rt.liveWatchUpdate = body => {
    const subscriber = streams.get(String(body?.id ?? ''))
    if (subscriber === undefined) throw invalid(`No live stream ${body?.id}`)
    subscriber.targets = (Array.isArray(body.watch) ? body.watch : []).flatMap(({ profile, session, since }) => {
      // A removed conversation must not discard the other entries' cursors.
      try { return [{ profile, session: rt.conversation(profile, session).session, since: since ?? undefined }] }
      catch { return [] }
    })
    deliver(subscriber)
    return true
  }
  rt.ctx.effect(() => rt.ctx.connection.fetch.register({
    path: '/api/nodo/live', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        await rt.refresh()
        await rt.loadSecrets()
        if (disposed) throw new Error('Stream unavailable')
        const query = new URL(request.url).searchParams
        const watching = JSON.parse(query.get('watch') ?? '[]')
        if (!Array.isArray(watching)) throw new Error('Invalid subscriptions')
        const streamId = String(query.get('id') ?? '')
        const targets = watching.map(({ profile, session, since }) => ({
          profile, session: rt.conversation(profile, session).session, since,
        }))
        let struct = Number(query.get('struct')), previous, closed = false, controller
        const close = () => {
          if (closed) return
          closed = true
          subscribers.delete(subscriber)
          if (streams.get(streamId) === subscriber) streams.delete(streamId)
          request.signal.removeEventListener('abort', close)
          controller?.close()
        }
        const subscriber = {
          targets,
          close,
          send(snapshot) {
            if (closed) return
            if (snapshot.struct !== struct) {
              struct = snapshot.struct
              controller.enqueue(encode({ type: 'structure', struct }))
            }
            const { struct: _, ...live } = snapshot
            const update = { type: 'live', ...(previous ? {} : { reset: true }) }
            for (const [key, value] of Object.entries(live)) {
              if (key === 'work' || key === 'stats' || key === 'sessions') {
                const before = previous?.[key] ?? {}
                const changes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(value)])]
                  .filter(id => JSON.stringify(before[id]) !== JSON.stringify(value[id])).map(id => [id, value[id] ?? null]))
                if (Object.keys(changes).length || !previous) update[key] = changes
              } else if (!previous || JSON.stringify(previous[key]) !== JSON.stringify(value)) update[key] = value
            }
            previous = live
            if (Object.keys(update).length > 1) controller.enqueue(encode(update))
            for (const target of subscriber.targets) {
              // since 未知的会话不下发：整份会话属于客户端自己的 transcript 拉取，
              // 流里再推一遍就是双份下载。
              if (target.session.archivedAt || target.since === undefined) continue
              const value = rt.transcriptDelta(target.session.id, target.since)
              const changed = value.full || value.appended.length || value.changed.length || value.base !== target.since?.base
              target.since = { token: value.token, base: value.base, dirty: value.dirty,
                n: value.full ? value.base + value.lines.length - 1 : Math.max(target.since.n, ...value.appended.map(row => row.n)) }
              if (changed) controller.enqueue(encode({ type: 'transcript', key: `${target.profile}:${target.session.id}`, value: rt.redactDeepSecrets(value) }))
            }
          },
        }
        return new Response(new ReadableStream({
          start(output) {
            controller = output
            subscribers.add(subscriber)
            if (streamId) streams.set(streamId, subscriber)
            request.signal.addEventListener('abort', close, { once: true })
            if (request.signal.aborted) close()
            else deliver(subscriber)
          },
          cancel() { controller = undefined; close() },
        }), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
      } catch {
        return Response.json({ ok: false, error: { message: 'Stream unavailable' } }, { status: 400 })
      }
    },
  }), 'nodo: live route')
  rt.ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
    for (const subscriber of subscribers) subscriber.close()
  }, 'nodo: live subscriptions')
}
