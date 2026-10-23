// Session statistics: how many rounds and tool steps a conversation ran, how
// long the model and its tools took, how fast it decoded and how many tokens each
// bucket holds. Drivers report the token side (the SPI `usage`, and their own
// `timing` where the engine's host already times turns); the rest is measured
// here from the event stream and the host clock, because no engine protocol
// reports a first-token latency. One JSON-plain record per session id, kept in
// state.json next to the transcripts so the figures survive a restart.
const FIELDS = Object.freeze([
  'turns', 'steps',
  'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'contextUsed', 'contextSize',
])

const empty = () => Object.fromEntries(FIELDS.map(key => [key, 0]))
const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function install(rt) {
  const { state } = rt
  // The turn in flight: its start, its first output, the open decode burst and
  // the open tool call. Nothing here is persisted — only the closed totals are.
  const open = new Map()

  const recordOf = (sessionId) => (state.stats[sessionId] ??= empty())

  const closeBurst = (turn) => {
    if (turn.burstStart === null) return
    turn.burstMs += turn.burstEnd - turn.burstStart
    turn.burstStart = null
    turn.burstEnd = null
  }

  /** A message became a turn: start the clock the engine's events are timed against. */
  const statsRound = (sessionId) => {
    open.set(sessionId, { start: Date.now(), first: null, burstStart: null, burstEnd: null, burstMs: 0, toolStart: null, toolMs: 0 })
  }

  /** Any output the engine produced (text, delta or reasoning) marks first token and decode. */
  const statsOutput = (sessionId) => {
    const turn = open.get(sessionId)
    if (turn === undefined) return
    const now = Date.now()
    if (turn.first === null) turn.first = now
    if (turn.burstStart === null) turn.burstStart = now
    turn.burstEnd = now
  }

  /** One tool call: its start closes the decode burst, its end closes the call's own span. */
  const statsTool = (sessionId, phase) => {
    const turn = open.get(sessionId)
    if (turn === undefined) return
    const now = Date.now()
    if (phase === 'start') {
      closeBurst(turn)
      turn.toolStart = now
      recordOf(sessionId).steps += 1
      return
    }
    if (turn.toolStart !== null) {
      turn.toolMs += now - turn.toolStart
      turn.toolStart = null
    }
  }

  /**
   * The turn ended: close what is open, fold its usage in and count it. Per
   * timing key the engine's own number (from `timing`) wins; a key the engine
   * did not report falls back to what this host measured for the same turn —
   * the two never add up on the same key. The ratio pairs (first-token
   * average, decode speed) are stricter: both their keys must come from the
   * same measurer, so a pair the engine reported only in half is left out
   * rather than stretched over this host's counts.
   */
  const statsEnd = (sessionId, usage, timing) => {
    const turn = open.get(sessionId)
    open.delete(sessionId)
    if (turn === undefined) return
    const record = recordOf(sessionId)
    const now = Date.now()
    if (turn.toolStart !== null) turn.toolMs += now - turn.toolStart
    closeBurst(turn)
    record.turns += 1
    const measured = { ttftMs: 0, ttftSteps: 0, llmMs: Math.max(0, now - turn.start - turn.toolMs), toolMs: turn.toolMs, decodeMs: turn.burstMs, decodeTokens: 0 }
    if (turn.first !== null) { measured.ttftMs = turn.first - turn.start; measured.ttftSteps = 1 }
    // Speed is only meaningful where the engine streamed its output, so the
    // measured token count only pairs with a window measured here as well.
    if (timing?.decodeMs === undefined && timing?.decodeTokens === undefined && turn.burstMs > 0 && isNumber(usage?.outputTokens)) measured.decodeTokens = usage.outputTokens
    for (const [a, b] of [['ttftMs', 'ttftSteps'], ['decodeMs', 'decodeTokens']]) {
      if (isNumber(timing?.[a]) === isNumber(timing?.[b])) {
        const source = isNumber(timing?.[a]) ? timing : measured
        record[a] += source[a]
        record[b] += source[b]
      }
    }
    for (const key of ['llmMs', 'toolMs']) record[key] += isNumber(timing?.[key]) ? timing[key] : measured[key]
    if (usage !== undefined) {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        if (isNumber(usage[key])) record[key] += usage[key]
      }
      // The context figures are the newest request's, so they replace the old ones.
      for (const key of ['contextUsed', 'contextSize']) if (isNumber(usage[key])) record[key] = usage[key]
    }
    void rt.save().catch(() => {})
  }

  const statsDrop = (sessionId) => {
    open.delete(sessionId)
    delete state.stats[sessionId]
  }

  /** What the client polls: one small record per session that has run a turn. */
  const statsView = () => Object.fromEntries(Object.entries(state.stats).map(([sessionId, record]) => [sessionId, { ...record }]))

  Object.assign(rt, { statsRound, statsOutput, statsTool, statsEnd, statsDrop, statsView })
}
