// The echo engine: a scripted fake agent living in test helpers, not in the
// shipped engine registry — register it with registerEchoEngine() in a test
// boot to use it. A script is a list of steps:
//
//   { kind: 'text',  text }             // emit one whole assistant message
//   { kind: 'wait',  ms }               // simulate work
//   { kind: 'tool',  name, brief?, ms? } // emit a tool start/end pair around a wait
//   { kind: 'ask' }                     // open a permission request mid-turn
//   { kind: 'ask', questions }          // open a question request instead
//                                        // (allow/answer → script continues,
//                                        //  deny → 'interrupted')
//
// steer(): accepted while a turn runs; each steered text becomes one follow-up
// turn after the current one ends on its own ('done'). interruptTurn() stops the
// script at once and drops steered texts.
import { registerEngine } from '../../agent-drivers/dist/index.js'
import { STEER } from '../../agent-drivers/dist/spi.js'
import { invalidConfig, validateWorkspace } from '../../agent-drivers/dist/cli.js'

export const echoInfo = {
  id: 'echo', label: 'Echo (test)', requiresCwd: false, description: 'Simulated agent; no model or CLI required.',
  fields: [{ name: 'steerPolicy', target: 'engineOptions', label: 'Messages during a running task', type: 'select', default: 'accept', choices: [{ value: 'accept', label: 'Accept' }, { value: 'refuse', label: 'Queue' }] }],
  capabilities: { resume: false, steer: true, permissions: true, questions: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] },
}

export function validateEchoOptions(raw = {}) {
  for (const key of Object.keys(raw)) if (!['steerPolicy', 'script'].includes(key)) throw invalidConfig(`Unsupported Echo option: ${key}`)
  if (raw.steerPolicy !== undefined && !['accept', 'refuse'].includes(raw.steerPolicy)) throw invalidConfig('Invalid Echo steer policy')
  if (raw.script !== undefined && !Array.isArray(raw.script)) throw invalidConfig('Echo script must be an array')
  return raw
}

export async function checkEcho({ cwd } = {}) {
  validateWorkspace(cwd)
  return { engine: 'echo', ok: true, checks: [{ label: 'Engine', ok: true, message: 'Built-in simulated engine is ready' }] }
}

const DEFAULT_SCRIPT = [
  { kind: 'text', text: 'Echo on. I take one task at a time.' },
  { kind: 'wait', ms: 50 },
  { kind: 'tool', name: 'bash', brief: 'echo hello', ms: 60 },
  { kind: 'ask' },
  { kind: 'text', text: 'Approved path taken; finishing.' },
]

export function createEchoDriver({ onEvent, script = DEFAULT_SCRIPT, steerPolicy = 'accept' } = {}) {
  const emit = (event) => { try { onEvent?.(event) } catch { /* a broken sink must not kill the turn */ } }
  let turnSeq = 0
  let running = null // { turnId, timers:Set, steered:string[] }
  let hasSessionFlag = false
  let disposed = false

  const later = (turn, ms, fn) => {
    const timer = setTimeout(() => {
      turn.timers.delete(timer)
      if (running === turn) fn()
    }, ms)
    timer.unref?.()
    turn.timers.add(timer)
  }

  const finishTurn = (reason, extra = {}) => {
    const turn = running
    if (turn === null) return
    running = null
    for (const timer of turn.timers) clearTimeout(timer)
    emit({ type: 'turn/end', turnId: turn.turnId, reason, ...extra })
    if (reason !== 'done') return
    for (const text of turn.steered) startTurn(`turn-${++turnSeq}`, `[steered] ${text}`)
  }

  const playStep = (turn, step) => {
    if (step.kind === 'text') emit({ type: 'text', turnId: turn.turnId, text: step.text })
    if (step.kind === 'tool') {
      emit({ type: 'tool', turnId: turn.turnId, name: step.name, phase: 'start' })
      later(turn, step.ms ?? 60, () => emit({ type: 'tool', turnId: turn.turnId, name: step.name, phase: 'end', brief: step.brief ?? `${step.name} done` }))
    }
    if (step.kind === 'ask') {
      const questions = Array.isArray(step.questions) ? step.questions : null
      // One id per gate: the host keeps one card per request id, so a turn with
      // two asks needs two.
      const id = `req-${turn.turnId}-${turn.requests.size + 1}`
      turn.requests.add(id)
      emit({
        type: 'request/opened',
        id,
        kind: questions ? 'question' : 'permission',
        tool: 'bash',
        reason: questions ? questions.map(question => question.question).join('\n') : 'echo: run a sample command?',
        ...(questions ? { detail: { questions } } : { options: ['allow', 'deny'] }),
      })
    }
  }

  const startTurn = (turnId, openingText) => {
    hasSessionFlag = true
    const turn = running = { turnId, timers: new Set(), steered: [], requests: new Set() }
    emit({ type: 'session', state: 'ready' })
    emit({ type: 'turn/start', turnId })
    if (openingText !== undefined) emit({ type: 'text', turnId, text: openingText })
    let at = 60
    for (const step of script) {
      later(turn, at, () => playStep(turn, step))
      at += (step.kind === 'wait' ? step.ms : 60) + 40
    }
    later(turn, at, () => finishTurn('done'))
  }

  return {
    async openSession() { hasSessionFlag = true; emit({ type: 'session', state: 'ready' }) },
    sendTurn(text) {
      if (disposed) return Promise.reject(new Error('echo driver disposed'))
      if (running !== null) return Promise.reject(new Error('echo driver: a turn is already running'))
      const turnId = `turn-${++turnSeq}`
      const start = setTimeout(() => { if (!disposed && running === null) startTurn(turnId) }, 0)
      start.unref?.()
      void text
      return Promise.resolve(turnId)
    },
    steer(text) {
      if (running === null) return Promise.resolve(STEER.REFUSED)
      if (steerPolicy === 'refuse') return Promise.resolve(STEER.REFUSED)
      running.steered.push(String(text ?? ''))
      return Promise.resolve(STEER.STEERED)
    },
    // Simulated engine: the call is the contract, there is no history to shrink.
    async compact() {},
    interruptTurn() {
      finishTurn('interrupted')
      return Promise.resolve()
    },
    respondToRequest(id, { decision } = {}) {
      const turn = running
      if (turn === null || !turn.requests.has(String(id))) return Promise.resolve(false)
      if (decision === 'deny') finishTurn('interrupted', { error: 'denied by the user' })
      return Promise.resolve(true)
    },
    onEvent() {
      throw new Error('echo: pass onEvent in createEchoDriver options')
    },
    hasSession() {
      return hasSessionFlag
    },
    dispose() {
      disposed = true
      finishTurn('interrupted')
      emit({ type: 'session', state: 'closed' })
    },
  }
}

// The registry entry, in the ENGINES shape; call once per test boot.
export function registerEchoEngine() {
  registerEngine('echo', { create: createEchoDriver, info: echoInfo, validate: validateEchoOptions, check: checkEcho })
}
