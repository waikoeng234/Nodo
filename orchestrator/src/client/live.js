// Every surface shares one stream and one copy of each conversation's rows.

const ROUTE = '/api/nodo'
const call = async (endpoint, payload) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const answer = await response.json()
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'request failed')
  return answer.value
}

let view = null
let error = ''
const listeners = new Set()
let timer = null
let requested = 0
let applied = 0
let polling = false
let connection = null
let retry = null
let failures = 0
let connected = false
let restarting = false
// 会话记录：`${profile}:${session}` → { positions, lines, error }。
// positions = { token, base, n, dirty }：base 是 lines[0] 的行编号，n 是最后一行的编号；
// 已归档且只在 dsh 侧有记录的会话是 { archived: true }。
const transcripts = new Map()

const emit = () => { for (const listener of listeners) listener() }
const mergeSessions = (current, updates) => !updates ? current : { ...current,
  profiles: current.profiles.map(profile => ({ ...profile, sessions: profile.sessions.map(session => updates[session.id] ? { ...session, ...updates[session.id] } : session) })) }

const poll = async (force = false) => {
  const order = ++requested
  try {
    const answer = await call('state', force || view === null ? undefined : { since: { struct: view.struct } })
    if (!polling || order < applied) return
    applied = order
    const moved = view !== null && answer.activity !== view.activity
    view = answer.unchanged && view !== null
      ? { ...view, activity: answer.activity, work: answer.work, approvals: answer.approvals, stats: answer.stats }
      : answer
    view = mergeSessions(view, answer.sessions)
    error = ''
    if (moved && !connected) for (const [key, { profileId, sessionId }] of watched) void pullTranscript(profileId, sessionId, key)
  } catch (failure) {
    if (polling && order >= applied) { error = failure.message; emit() }
    return
  }
  emit()
}

const schedule = () => {
  if (!polling || connected || timer !== null) return
  const busy = Object.values(view?.work ?? {}).some(state => state?.active === true)
  timer = setTimeout(async () => { timer = null; await poll(); if (connection === null) void connect(); schedule() }, busy ? 400 : 1200)
}

const connect = async () => {
  if (!polling || view === null) return
  connection?.abort()
  const abort = connection = new AbortController()
  const watch = [...watched.values()].map(({ profileId: profile, sessionId: session }) => ({ profile, session, since: transcripts.get(keyOf(profile, session))?.positions }))
  try {
    const query = new URLSearchParams({ struct: String(view.struct), watch: JSON.stringify(watch) })
    const response = await fetch(`${ROUTE}/live?${query}`, { signal: abort.signal })
    if (!response.ok || !response.body) throw new Error('Stream unavailable')
    if (abort.signal.aborted) return
    connected = true
    clearTimeout(timer); timer = null
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let pending = ''
    try {
      while (!abort.signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!line || abort.signal.aborted) continue
          const frame = JSON.parse(line)
          failures = 0
          if (frame.type === 'structure') { if (frame.struct !== view.struct) await poll(true) }
          else if (frame.type === 'live') {
            const { type, sessions, reset, ...live } = frame
            for (const key of ['work', 'stats']) if (live[key]) {
              const values = live[key]
              live[key] = { ...(reset ? {} : view[key]), ...values }
              for (const [id, value] of Object.entries(values)) if (value === null) delete live[key][id]
            }
            view = mergeSessions({ ...view, ...live }, sessions); error = ''; emit()
          } else if (frame.type === 'transcript') merge(frame.key, frame.value)
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  } catch (failure) {
    if (!abort.signal.aborted) { error = failure.message; emit() }
  } finally {
    if (connection === abort && !abort.signal.aborted) {
      connected = false
      schedule()
      retry = setTimeout(() => { retry = null; void connect() }, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)))
    }
  }
}
const restart = () => {
  if (!polling || restarting) return
  restarting = true
  void Promise.resolve().then(() => {
    restarting = false
    clearTimeout(retry); retry = null
    void connect()
  })
}

export const subscribeLive = listener => {
  listeners.add(listener)
  if (!polling) {
    polling = true
    void poll(true).then(() => { if (polling) { schedule(); void connect() } })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      polling = false
      if (timer) clearTimeout(timer)
      timer = null
      clearTimeout(retry); retry = null
      connection?.abort(); connection = null
      connected = false
    }
  }
}
export const getLive = () => view
export const liveError = () => error
export const refreshLive = async (force = true) => { if (force || !connected) await poll(force) }

const keyOf = (profileId, sessionId) => `${profileId}:${sessionId}`
export const transcriptOf = key => transcripts.get(key)?.lines ?? EMPTY
const EMPTY = []

const merge = (key, answer) => {
  const current = transcripts.get(key)
  if (answer.unchanged) {
    if (current?.error) { transcripts.set(key, { ...current, error: '' }); bumpStore() }
    return
  }
  if (answer.archived) {
    transcripts.set(key, { positions: { archived: true }, lines: answer.lines, error: '' })
    bumpStore()
    return
  }
  if (answer.full) {
    transcripts.set(key, { positions: { token: answer.token, base: answer.base, n: answer.base + answer.lines.length - 1, dirty: answer.dirty }, lines: answer.lines.map(item => item.line), error: '' })
    bumpStore()
    return
  }
  // 宿主截掉开头时 base 前移：同样丢掉本地开头的行，编号才对得上。
  const cut = answer.base - current.positions.base
  const positions = { token: answer.token, base: answer.base, n: current.positions.n, dirty: answer.dirty }
  if (cut === 0 && answer.appended.length === 0 && answer.changed.length === 0) {
    transcripts.set(key, { ...current, positions, error: '' })
    if (current.error) bumpStore()
    return
  }
  const lines = current.lines.slice(cut)
  for (const { n, line } of [...answer.appended, ...answer.changed]) lines[n - answer.base] = line
  transcripts.set(key, { positions: { ...positions, n: answer.base + lines.length - 1 }, lines, error: '' })
  bumpStore()
}

// 同一会话同时只有一个请求在途；在途期间再要求拉取，就在它落地后补拉一次。
const inflight = new Map()
export const pullTranscript = (profileId, sessionId, key = keyOf(profileId, sessionId)) => {
  const running = inflight.get(key)
  if (running) { running.again = true; return running.done }
  const entry = { again: false }
  entry.done = (async () => {
    do {
      entry.again = false
      const positions = transcripts.get(key)?.positions
      try {
        const answer = await call('transcript', { profile: profileId, session: sessionId, since: positions ?? {} })
        merge(key, answer)
      } catch (failure) {
        transcripts.set(key, { ...(transcripts.get(key) ?? { lines: EMPTY }), error: failure.message })
        bumpStore()
      }
    } while (entry.again)
    inflight.delete(key)
  })()
  inflight.set(key, entry)
  return entry.done
}
// A newly visible conversation loads once, then joins the shared stream.
const watched = new Map()
export const watchTranscript = (profileId, sessionId) => {
  const key = keyOf(profileId, sessionId)
  const current = watched.get(key) ?? { profileId, sessionId, count: 0 }
  current.count += 1
  watched.set(key, current)
  if (current.count === 1) void pullTranscript(profileId, sessionId, key).then(restart)
  return () => {
    current.count -= 1
    if (current.count === 0) { watched.delete(key); restart() }
  }
}
export const transcriptError = key => transcripts.get(key)?.error ?? ''
export const dropTranscript = key => transcripts.delete(key)

// 仅随记录内容变化的版本号：Feed 等用它决定何时重读共享行，而不随每次
// state 轮询重渲染。
let storeVersion = 0
const storeListeners = new Set()
const bumpStore = () => {
  storeVersion += 1
  for (const listener of storeListeners) listener()
}
export const subscribeStore = listener => {
  storeListeners.add(listener)
  return () => storeListeners.delete(listener)
}
export const getStoreVersion = () => storeVersion
