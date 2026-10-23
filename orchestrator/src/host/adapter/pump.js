// The mirror pump (handoff §3.2): one engine session per native session. Each
// host stream() call consumes driver events up to the next boundary — engine
// tool activity or an approval ask — relays text and reasoning verbatim, emits
// the boundary as one mirror tool-call and ends the stream; the mirror tool's
// result re-enters as the next stream() and consumption resumes. The engine
// stays the authority: nothing here assembles prompts (the newest human message
// is relayed verbatim) or executes anything engine-side.
import { randomUUID } from 'node:crypto'
import { UnsupportedCapabilityError } from '../../../agent-drivers/dist/spi.js'
import { MIRROR_TOOL_NAME } from './mirror-tools.js'
import { human, promptKey, newestUserInput, newestUserPrompt, engineInput } from './input.js'
import { clip } from '../text.js'
import { projectContent } from '../resources.js'
import { TRANSCRIPT_TEXT_MAX, UNCONFIRMED_STEER } from '../constants.js'
import { activityRow, changesTool, planObservation, previewRecord } from '../stream-records.js'
export { newestUserPrompt } from './input.js'

const readable = (value, imageOutput = false) => projectContent(value, imageOutput).text

export function createPump({ driver, attachments, createRecords, saveReplyImages }) {
  const queue = []
  const mirrored = new WeakSet()
  // The latest accepted record per call id: an update may be queued before the
  // tool's boundary is consumed, so the claim must adopt it when it opens.
  const livePresentations = new Map()
  const startedCalls = new Set()
  const runningTools = new Map()
  let wake = null
  let active = false
  let run = 0
  let interrupting = null
  let usage
  let replyText = ''
  let pending = null
  let records = null
  let planState = null
  const activityTitles = new Map()
  const delivered = new Set()
  let started = false
  let lastEventAt = Date.now()
  let phase = 'running'
  let retrying = null
  let compacting = false
  let disposed = false
  const closedRequests = new Set()
  const openRequests = new Map()

  const steer = async message => {
    if (delivered.has(promptKey(message))) return 'steered'
    if (!active || !human(message) || !Array.isArray(message.content)) return 'refused'
    if (message.content.some(block => block.type !== 'text')) {
      // Engines take steer input as text only; say why the insert falls back to
      // the queue instead of failing the click silently.
      push({ type: 'note', text: '[Nodo] 消息含图片，无法插入本轮，已转为排队。' })
      return 'refused'
    }
    const text = message.content.map(block => block.text).join('')
    const outcome = (text.trim() ? await driver.steer?.(text) : undefined) ?? 'refused'
    if (outcome !== 'refused') delivered.add(promptKey(message))
    if (outcome === 'indeterminate') push({ type: 'note', text: UNCONFIRMED_STEER })
    return outcome
  }

  const push = event => { queue.push(event); wake?.() }
  // A settled claim stays reachable until the next boundary replaces it: the
  // engine may finish the item before the host gets around to executing the
  // mirror tool, and the claim must still be there when it does.
  const settlePending = result => {
    if (!pending || pending.settled) return
    pending.settled = true
    pending.settle({ ...result, ...(pending.presentation ? { presentation: records.finish(pending.presentation, result.status) } : {}) })
  }
  const openPending = (request, tool) => {
    let settle, requestReady
    const done = new Promise(resolve => { settle = resolve })
    const requested = new Promise(resolve => { requestReady = resolve })
    const live = tool?.callId === undefined ? undefined : livePresentations.get(String(tool.callId))
    pending = { phase: 'item', callId: tool?.callId ?? request?.callId, input: readable(tool?.input), presentation: live ?? tool?.presentation, itemStarted: !request, request: null, requests: [], approvalId: null, answered: null, claimed: false, settled: false, done, settle, requested, requestReady }
    if (request) attachRequest(request)
  }
  const attachRequest = event => {
    if (!pending || pending.settled || mirrored.has(event) || closedRequests.has(event.id) || !['permission', 'question'].includes(event.kind)) return false
    pending.requests.push(event)
    if (!pending.request) {
      pending.request = event
      pending.approvalId = event.kind === 'permission' ? event.id : null
      pending.phase = 'awaiting'
    }
    mirrored.add(event)
    pending.requestReady(event)
    return true
  }
  // A new boundary must adopt outcomes already queued for its item: the engine
  // may have ended it (or the whole turn) before the boundary was emitted.
  const settleQueuedAhead = () => {
    if (!pending || pending.settled) return
    for (const queued of queue) {
      if (queued?.type === 'request/opened') attachRequest(queued)
      if (queued?.type === 'turn/end') { mirrorSemantics(queued); return }
      if (queued?.type === 'tool' && matchesTool(queued) && queued.phase === 'end') {
        mirrorSemantics(queued)
        return
      }
    }
  }

  // Mirror semantics for one event, applied at live arrival AND at consume
  // time: an event may sit in the queue across a boundary, so both paths must
  // settle the pending claim (the next item can end before its boundary is
  // even emitted).
  const matchesTool = event => !pending?.callId || !event.callId || pending.callId === event.callId
  const mirrorSemantics = event => {
    if (event.type === 'tool' && pending && matchesTool(event)) {
      if (event.presentation) pending.presentation = event.presentation
      if (event.phase === 'end') {
        const input = event.input !== undefined && readable(event.input) !== pending.input ? `输入:\n${readable(event.input)}\n\n输出:\n` : ''
        const detail = clip(input + readable(event.output ?? event.brief, event.name === 'imageGeneration'), TRANSCRIPT_TEXT_MAX, 'long tool output')
        settlePending({ status: pending.answered === 'deny' ? 'denied' : event.isError ? 'error' : 'done', ...(detail ? { detail } : {}) })
      } else if (pending.phase === 'granted' && event.phase === 'start') { pending.phase = 'item'; pending.itemStarted = true; pending.callId = event.callId }
    }
    if (event.type === 'turn/end') {
      usage = event.usage ?? usage
      // Only the item's own end event may report a tool done; a turn that
      // finishes first must not upgrade the missing outcome into a success.
      const unreported = pending && !pending.settled && ['item', 'granted'].includes(pending.phase)
      const status = pending?.answered === 'deny' ? 'denied'
        : event.reason === 'interrupted' ? 'interrupted'
        : event.reason === 'done' && !unreported ? 'done' : 'error'
      const detail = event.error ? String(event.error)
        : unreported && event.reason === 'done' ? 'Agent 已结束本轮，但未回报该操作的执行结果' : undefined
      settlePending({ status, ...(detail ? { detail } : {}), ...(event.unconfirmed ? { unconfirmed: true } : {}) })
    }
  }

  // The engine settles an ask behind the card when it resolves (or drops) the
  // request itself; watchers let the host card close instead of eating a click
  // that can no longer land.
  const closeWatchers = new Map()
  const watchRequestClose = (id, watcher) => {
    if (!id) return () => {}
    if (closedRequests.has(id)) { watcher(); return () => {} }
    const watchers = closeWatchers.get(id) ?? new Set()
    closeWatchers.set(id, watchers)
    watchers.add(watcher)
    return () => { watchers.delete(watcher); if (!watchers.size) closeWatchers.delete(id) }
  }

  const receive = event => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'changes') {
      const tool = changesTool(event)
      if (tool) { receive({ ...tool, phase: 'start', presentation: undefined }); receive(tool) }
      return
    }
    // The native surface has no live plan/subagent views (the engine_action
    // card has no refresh hook), so plans keep only their last snapshot —
    // emitted as one final row when the turn ends — a subtask surfaces as one
    // card at its end, and transient statuses stay bounded notes. None of it
    // is model-visible thinking content.
    if (event.type === 'plan') { planState = event; lastEventAt = Date.now(); return }
    if (event.type === 'activity') {
      lastEventAt = Date.now()
      if (typeof event.title === 'string' && event.title) activityTitles.set(String(event.entityId), event.title)
      const key = String(event.entityId ?? '')
      const title = typeof event.title === 'string' && event.title ? event.title : activityTitles.get(key)
      if (event.phase === 'end') {
        const row = activityRow({ ...event, ...(title ? { title } : {}) })
        activityTitles.delete(key)
        if (row) { receive({ ...row, phase: 'start', presentation: undefined }); receive(row) }
      }
      return
    }
    if (event.type === 'lifecycle') {
      lastEventAt = Date.now()
      // Retry waits and compaction are work statuses: they ride the running
      // animation's phase, never the text feed.
      if (event.kind === 'retry') retrying = event.phase === 'start' ? (typeof event.detail === 'string' && event.detail ? event.detail : true) : null
      else if (event.kind === 'compaction') compacting = event.phase === 'start'
      return
    }
    if (event.type === 'turn/end' && planState) {
      const plan = planObservation(planState)
      planState = null
      if (plan && event.reason === 'done') { receive({ ...plan, phase: 'start', presentation: undefined }); receive(plan) }
      else if (plan) push({ type: 'note', text: `[Nodo] 本轮计划（${event.reason === 'interrupted' ? '已停止' : '失败'}时快照）：\n${clip(plan.output, TRANSCRIPT_TEXT_MAX, 'long plan')}` })
    }
    if (event.type === 'tool') event = { ...event, presentation: records?.accept(event) ?? undefined }
    if (event.type === 'tool' && event.callId !== undefined && event.presentation) livePresentations.set(String(event.callId), event.presentation)
    if (event.type === 'thinking') phase = 'thinking'
    if (event.type === 'delta' || event.type === 'text') phase = 'responding'
    if (event.type === 'tool' && event.callId !== undefined) {
      if (event.phase === 'end') runningTools.delete(String(event.callId))
      else runningTools.set(String(event.callId), event.name ?? runningTools.get(String(event.callId)) ?? 'tool')
      phase = 'running'
    }
    // Output or tool work after a retry wait is the recovery itself; the next
    // wait reports its own phase again.
    if (retrying && ['thinking', 'delta', 'text', 'tool'].includes(event.type)) retrying = null
    lastEventAt = Date.now()
    mirrorSemantics(event)
    // A turn can end while no consumer is attached (the loop sits in a mirror
    // tool, or the host cancelled it there): the loop may never come back, so
    // idleness must not wait for a stream() that only clears it in consume().
    if (event.type === 'turn/end') {
      active = false
      runningTools.clear()
      for (const id of openRequests.keys()) {
        closedRequests.add(id)
        for (const watcher of closeWatchers.get(id) ?? []) watcher()
      }
      openRequests.clear()
    }
    if (event.type === 'request/opened') { openRequests.set(event.id, event.kind); attachRequest(event) }
    if (event.type === 'request/closed') {
      openRequests.delete(event.id)
      closedRequests.add(event.id)
      for (const watcher of closeWatchers.get(event.id) ?? []) watcher()
    }
    push(event)
  }

  const takeMirror = () => {
    if (!pending || pending.claimed) return null
    pending.claimed = true
    return pending
  }

  const takeRequest = claim => {
    let request
    do { request = claim.requests.shift() } while (request && closedRequests.has(request.id))
    if (!claim.requests.length) claim.requested = new Promise(resolve => { claim.requestReady = resolve })
    return request
  }

  const respondApproval = (claim, decision, request = claim.request) => {
    if (request === claim.request && (!claim.callId || !request.callId || request.callId === claim.callId)) {
      claim.answered = decision
      claim.phase = decision === 'allow' ? claim.itemStarted ? 'item' : 'granted' : 'denied'
    }
    if (request) return driver.respondToRequest(request.id, { decision })
  }

  const respondQuestion = async (claim, answer, request = claim.request) => {
    if (!await driver.respondToRequest(request.id, { decision: 'answer', ...answer })) throw new Error('The engine question is no longer pending')
    if (pending === claim && !claim.itemStarted && request === claim.request) settlePending({ status: 'done' })
  }

  const titleStream = async function* (options) {
    const text = (newestUserPrompt(options.messages) || 'Session').split('\n')[0].slice(0, 80)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  // The host's usage shape carries the token buckets only — context and timing
  // have no fields in it — and every bucket is optional: a turn that knows just
  // one of them still says that one instead of nothing.
  // The host reads one sample as one request and meters context from its prompt
  // side, while a turn sums every model call; with the engine's own occupancy
  // known, the prompt buckets shrink to it in proportion, so the cache hit holds.
  const usageChunk = () => {
    if (!usage) return null
    const pick = key => (Number.isFinite(usage[key]) ? { [key]: usage[key] } : {})
    const buckets = { ...pick('inputTokens'), ...pick('outputTokens'), ...pick('cacheReadTokens'), ...pick('cacheWriteTokens') }
    const prompt = (buckets.inputTokens ?? 0) + (buckets.cacheReadTokens ?? 0) + (buckets.cacheWriteTokens ?? 0)
    if (Number.isFinite(usage.contextUsed) && usage.contextUsed < prompt) {
      const share = usage.contextUsed / prompt
      for (const key of ['cacheReadTokens', 'cacheWriteTokens']) if (key in buckets) buckets[key] = Math.round(buckets[key] * share)
      const rest = usage.contextUsed - (buckets.cacheReadTokens ?? 0) - (buckets.cacheWriteTokens ?? 0)
      if ('inputTokens' in buckets) buckets.inputTokens = Math.max(0, rest)
    }
    return Object.keys(buckets).length > 0 ? { type: 'usage', usage: buckets } : null
  }

  // The stop forwarder: the loop only reaches stream() once per model step, so
  // a host cancel landing between steps would never reach the engine. The
  // latest request signal's abort listener therefore stays attached after its
  // stream returns (request signals abort with the turn) until the turn ends
  // or the next stream replaces it.
  let forwarder = null
  const interrupt = () => {
    if (interrupting) return interrupting
    const stoppingRun = run
    const finish = event => {
      if (run !== stoppingRun) return
      if (active || (pending && !pending.settled)) receive(event)
      releaseForwarder()
    }
    interrupting = Promise.resolve().then(() => driver.interruptTurn()).then(() => {
      finish({ type: 'turn/end', reason: 'interrupted', unconfirmed: true })
    }, error => {
      finish({ type: 'turn/end', reason: 'error', error: 'Agent 取消失败，请检查该会话的 Agent 连接', unconfirmed: true })
      throw error
    }).finally(() => { interrupting = null })
    return interrupting
  }
  const releaseForwarder = () => {
    if (forwarder) { forwarder.signal?.removeEventListener('abort', forwarder.onAbort); forwarder = null }
  }
  const forwardAbort = signal => {
    if (forwarder?.signal === signal) return
    releaseForwarder()
    if (!signal) return
    const onAbort = () => { void interrupt().catch(() => {}); wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    forwarder = { signal, onAbort }
  }

  async function* stream(options) {
    const signal = options.signal
    if (options.purpose === 'session-title') { yield* titleStream(options); return }
    if (options.purpose) throw new Error(`the engine manages its own ${options.purpose}; this auxiliary request is not relayed`)
    if (interrupting) await interrupting
    if (signal?.aborted) {
      // The host cancelled between stream calls while the engine turn ran on:
      // forward the stop before giving up, so the engine learns of it.
      if (active || (pending && !pending.settled)) await interrupt().catch(() => {})
      throw new Error('adapter stream aborted before start')
    }
    forwardAbort(signal)
    try {
      if (!active) {
        const messages = options.messages ?? []
        const fresh = messages.filter(message => human(message) && !delivered.has(promptKey(message)))
        const inputs = started ? fresh.map(message => newestUserInput(messages, messages.indexOf(message))).filter(Boolean) : [newestUserInput(messages)].filter(Boolean)
        if (!inputs.length) {
          if (!started) throw new Error('no user prompt in the adapter request')
          // Continuation re-entry onto an already ended turn: relay its queued
          // tail so the loop sees the real finish instead of a silent stop.
          if (queue.some(event => event?.type === 'turn/end')) { yield* consume(signal); return }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const content = inputs.flatMap((input, index) => index ? [{ type: 'text', text: '\n\n' }, ...input] : input)
        const input = await engineInput(content, attachments, signal)
        signal?.throwIfAborted()
        queue.length = 0
        closedRequests.clear()
        openRequests.clear()
        livePresentations.clear()
        startedCalls.clear()
        runningTools.clear()
        lastEventAt = Date.now()
        phase = 'running'
        retrying = null
        compacting = false
        planState = null
        activityTitles.clear()
        active = true
        run++
        usage = undefined
        replyText = ''
        records = createRecords?.() ?? null
        try { await driver.sendTurn(input.text, input.images) } catch (error) {
          active = false
          if (error instanceof UnsupportedCapabilityError) throw error
          throw new Error(input.images.length && /does not accept images$/.test(error?.message) ? error.message : 'engine session failed to start')
        }
        started = true
        for (const message of messages.filter(human)) delivered.add(promptKey(message))
      }
      // The loop re-enters after each mirror result; a thrown stream always
      // ends the engine turn bookkeeping so the next stream starts a new turn.
      try {
        yield* consume(signal)
      } catch (error) {
        if (signal?.aborted) active = false
        throw error
      }
    } finally {
      if (signal?.aborted) releaseForwarder()
    }
  }

  async function* consume(signal) {
    let index = 0
    let open = null
    const startBlock = blockType => { open = { type: blockType, index, text: '' }; return { type: 'block-start', index, blockType } }
    const deltaChunk = text => (open.type === 'reasoning' ? { type: 'reasoning-delta', index: open.index, text } : { type: 'text-delta', index: open.index, text })
    const closeBlock = () => {
      const block = open.type === 'reasoning' ? { type: 'reasoning', text: open.text } : { type: 'text', text: open.text }
      const chunk = { type: 'block-end', index: open.index, block }
      index += 1
      open = null
      return chunk
    }
    const boundaryChunks = (kind, name, brief, input, presentation, parentCallId) => {
      const id = `mirror-${randomUUID()}`
      const arguments_ = JSON.stringify({ kind, name, brief: String(brief ?? '').slice(0, 2000),
        ...(input !== undefined ? { input: clip(readable(input), TRANSCRIPT_TEXT_MAX, 'long tool input') } : {}),
        ...(parentCallId !== undefined ? { parentCallId: String(parentCallId) } : {}),
        ...(presentation ? { presentation: previewRecord(presentation) } : {}) })
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: MIRROR_TOOL_NAME, argumentsDelta: arguments_ },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: MIRROR_TOOL_NAME, arguments: arguments_ } },
      ]
    }
    while (true) {
      if (signal?.aborted) throw new Error('adapter stream aborted by host')
      if (disposed) throw new Error('engine session disposed')
      if (queue.length === 0) {
        await new Promise(resolve => { wake = resolve })
        wake = null
        continue
      }
      const event = queue.shift()
      mirrorSemantics(event)
      switch (event?.type) {
        case 'note':
          if (typeof event.text === 'string' && event.text !== '') {
            if (open?.type !== 'text') { if (open) yield closeBlock(); yield startBlock('text') }
            const body = open.text ? `\n${event.text}` : event.text
            open.text += body
            yield deltaChunk(body)
          }
          break
        case 'thinking':
          if (typeof event.text === 'string' && event.text !== '') {
            if (open?.type !== 'reasoning') { if (open) yield closeBlock(); yield startBlock('reasoning') }
            open.text += event.text
            yield deltaChunk(event.text)
          }
          break
        case 'delta':
        case 'text':
          if (typeof event.text === 'string' && event.text !== '') {
            replyText = (replyText + event.text).slice(0, TRANSCRIPT_TEXT_MAX)
            if (open?.type !== 'text') { if (open) yield closeBlock(); yield startBlock('text') }
            open.text += event.text
            yield deltaChunk(event.text)
          }
          break
        case 'tool':
          // A repeated start for an already-opened call is the same execution,
          // not another mirror boundary.
          if (event.phase === 'start' && event.callId !== undefined && startedCalls.has(String(event.callId))) break
          if (event.phase === 'start' && !mirrored.has(event)) {
            mirrored.add(event)
            if (event.callId !== undefined) startedCalls.add(String(event.callId))
            if (open) yield closeBlock()
            for (const chunk of boundaryChunks(event.observation ? 'changes' : 'tool', event.name ?? 'action', event.brief, event.input ?? event.inputText, event.presentation, event.parentCallId)) yield chunk
            index += 1
            openPending(null, event)
            settleQueuedAhead()
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          break
        case 'request/opened':
          if (['permission', 'question'].includes(event.kind) && !mirrored.has(event) && !closedRequests.has(event.id)) {
            if (open) yield closeBlock()
            for (const chunk of boundaryChunks(event.kind === 'question' ? 'question' : 'approval', event.tool ?? event.kind, event.reason)) yield chunk
            index += 1
            openPending(event)
            settleQueuedAhead()
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          break
        case 'turn/end':
          if (open) yield closeBlock()
          active = false
          releaseForwarder()
          if (!signal?.aborted && !disposed && saveReplyImages) {
            const images = await saveReplyImages(event.text || replyText).catch(() => [])
            for (const attachment of images) {
              signal?.throwIfAborted()
              if (disposed) break
              yield { type: 'block-start', index, blockType: 'image' }
              yield { type: 'block-end', index, block: { type: 'image', attachment } }
              index += 1
            }
          }
          // A failed turn still consumed what its usage reports; the figures go
          // out before the stream signals the failure.
          {
            const chunk = usageChunk()
            if (chunk) yield chunk
          }
          if (event.reason === 'error') throw new Error(event.error || 'The engine turn failed')
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        default:
          break
      }
    }
  }

  return {
    receive,
    steer,
    interrupt,
    stream,
    takeMirror,
    takeRequest,
    respondApproval,
    respondQuestion,
    watchRequestClose,
    get active() { return active },
    get status() {
      if (!active) return null
      const waits = [...openRequests.values()]
      return { lastEventAt, phase: waits.includes('question') ? 'waiting-question' : waits.includes('permission') ? 'waiting-approval'
        : retrying ? 'retrying' : compacting ? 'compacting' : runningTools.size ? 'tool' : phase,
        ...(typeof retrying === 'string' ? { detail: retrying } : {}), tool: [...runningTools.values()].at(-1) ?? null }
    },
    dispose() { disposed = true; active = false; settlePending({ status: 'interrupted' }); pending = null; releaseForwarder(); queue.length = 0; livePresentations.clear(); planState = null; wake?.() },
  }
}
