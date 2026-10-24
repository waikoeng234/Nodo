const empty = () => ({ seq: -1, turn: null, status: 'idle', since: null, finishedAt: null, completionSeq: null, lastAt: null, tools: new Map(), approvals: new Set() })
const observed = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided'])
const outcome = kind => kind === 'completed' ? 'completed'
  : ['aborted', 'interrupted', 'forked'].includes(kind) ? 'stopped'
    : ['blocked', 'max-tokens'].includes(kind) ? 'blocked' : 'error'

// The latest turn boundary dates the session in the rail. Replayed history only
// stamps what the host recorded a time for (at = 0); live events arrive.
const stampTurnAt = (state, event, at) => {
  const time = Number.isFinite(event.time) ? event.time : at
  if (time > 0) state.lastAt = time
}

function fold(state, event, at = Date.now()) {
  if (Number.isInteger(event.seq) && event.seq <= state.seq) return
  if (Number.isInteger(event.seq)) state.seq = event.seq
  const data = event.data
  if (event.type === 'turn/start') {
    Object.assign(state, { turn: data.turn, status: 'running', since: event.time ?? null, finishedAt: null, completionSeq: null })
    stampTurnAt(state, event, at)
    state.tools.clear()
    state.approvals.clear()
  } else if (event.type === 'turn/end' && data.turn === state.turn) {
    Object.assign(state, { turn: null, status: outcome(data.reason.kind), finishedAt: event.time ?? null, completionSeq: event.seq ?? null })
    stampTurnAt(state, event, at)
    state.tools.clear()
    state.approvals.clear()
  } else if (event.type === 'tool/call' && data.turn === state.turn) state.tools.set(data.callId, data.name)
  else if (event.type === 'tool/result' && data.turn === state.turn) state.tools.delete(data.message.toolCallId)
  else if (event.type === 'approval/asked' && state.turn !== null) state.approvals.add(data.id)
  else if (event.type === 'approval/decided') state.approvals.delete(data.id)
}

export function install(rt) {
  const { ctx } = rt
  const entries = new Map()
  const stops = []
  let disposed = false
  const nativeId = session => session.engine === 'dsh' ? session.driverSessionId : undefined
  const bound = id => typeof id === 'string' && Object.values(rt.state.profiles).some(profile => rt.sessionsOf(profile).some(session => nativeId(session) === id))
  const entryOf = id => {
    if (!entries.has(id)) entries.set(id, { state: empty(), requests: new Map(), loaded: false })
    return entries.get(id)
  }
  const on = (event, callback, options) => { const stop = ctx.on?.(event, callback, options); if (typeof stop === 'function') stops.push(stop) }
  // The host rename face: plugin code may only retitle a native session it owns.
  rt.renameHostSession = (id, title) => { try { void ctx.sessionController?.rename?.({ sessionId: id, title })?.catch?.(() => {}) } catch {} }
  on('session/event', (session, event) => {
    if (!bound(session.id)) return
    if (event.type === 'user/message') { void rt.titleSessionFromNative?.(session.id, event.data); return }
    if (!observed.has(event.type)) return
    const entry = entryOf(session.id)
    entry.pending?.push(event)
    fold(entry.state, event)
    if (event.type === 'turn/end') for (const close of [...entry.requests.values()]) close()
  })
  // Observe the answerer chain without claiming or answering its requests.
  for (const [event, status] of [['approval/request', 'waiting-approval'], ['user-questions/request', 'waiting-question']]) {
    on(event, async (request, next) => {
      const id = request.agent?.id ?? request.agent?.session?.id
      if (!bound(id)) return next()
      const entry = entryOf(id)
      const token = Symbol(status)
      const close = () => { entry.requests.delete(token); request.signal?.removeEventListener('abort', close) }
      close.status = status
      entry.requests.set(token, close)
      if (request.signal?.aborted) close()
      else request.signal?.addEventListener('abort', close, { once: true })
      try { return await next() }
      finally { close() }
    }, { prepend: true })
  }
  on('agent/disposed', ({ agent }) => {
    const entry = entries.get(agent.id)
    if (!entry) return
    for (const close of [...entry.requests.values()]) close()
    if (entry.state.turn !== null) { entry.state.turn = null; entry.state.status = 'stopped' }
  })

  const refreshNativeStatus = async () => {
    const ids = new Set(Object.values(rt.state.profiles).flatMap(profile => rt.sessionsOf(profile).map(nativeId).filter(Boolean)))
    for (const [id, entry] of entries) if (!ids.has(id)) {
      for (const close of [...entry.requests.values()]) close()
      entries.delete(id)
    }
    for (const id of ids) {
      if (disposed) return
      const entry = entryOf(id)
      if (entry.loaded || Date.now() < (entry.retryAt ?? 0) || typeof ctx.sessionController?.inspect !== 'function') continue
      if (!entry.reading) {
        entry.pending = []
        entry.reading = (async () => {
          try {
            const inspection = await ctx.sessionController.inspect(id)
            if (disposed) return
            const state = empty()
            for (const event of inspection.events) if (observed.has(event.type)) fold(state, event, 0)
            for (const event of entry.pending) fold(state, event)
            entry.state = state
            entry.loaded = true
            entry.unavailable = false
          } catch {
            entry.unavailable = true
            entry.retryAt = Date.now() + 5000
          } finally { entry.pending = null; entry.reading = null }
        })()
      }
      await entry.reading
    }
  }

  const nativeWork = session => {
    const id = nativeId(session)
    if (!id) return null
    const entry = entryOf(id)
    const agent = ctx.agents?.get(id)
    const state = entry.state
    const active = agent ? agent.status === 'running' : false
    const waits = [...entry.requests.values()].map(close => close.status)
    const status = active ? waits.includes('waiting-question') ? 'waiting-question'
      : waits.includes('waiting-approval') || state.approvals.size > 0 ? 'waiting-approval' : 'running'
      : state.turn !== null ? 'stopped' : entry.unavailable ? 'unavailable' : state.status
    return { source: 'native', active, status, since: active ? state.since : null, finishedAt: state.finishedAt, completionSeq: state.completionSeq, lastAt: state.lastAt,
      tool: active ? [...state.tools.values()].at(-1) ?? null : null,
      buffer: null, queued: (agent?.inbox?.nextTurn.length ?? 0) + (agent?.inbox?.nextStep.length ?? 0) }
  }
  ctx.effect(() => () => {
    disposed = true
    for (const stop of stops) stop()
    for (const entry of entries.values()) for (const close of [...entry.requests.values()]) close()
    entries.clear()
  }, 'nodo: native session status')
  Object.assign(rt, { refreshNativeStatus, nativeWork })
}
