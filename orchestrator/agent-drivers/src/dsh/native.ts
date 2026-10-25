import { randomUUID } from 'node:crypto'
import { STEER, addUsage, steerFailed, timingOf, usageOf } from '../spi.js'
import { nativeDshPermissions, nativeDshCompaction } from './native-services.js'
import { nativeDshChanges } from './native-changes.js'
import type { Driver, DriverEvent, PermissionMode, Usage } from '../spi.js'
import type { DshNativeRuntime } from './native-services.js'

export type NativeDshDriverOptions = {
  nativeHost: DshNativeRuntime; cwd?: string; name?: string; sessionName?: string; workspaceId?: string; workspaceName?: string
  driverSessionId?: string; model?: string; thinking?: string; permission?: PermissionMode; instructions?: string
  onEvent?: (event: DriverEvent) => void
}
type NativeAgent = Awaited<ReturnType<DshNativeRuntime['sessionController']['resolveAgent']>>['agent']
type NativeProjections = Record<string, Record<string, unknown> | undefined>
type NativeTurn = {
  id: string; controller: AbortController; pending: Set<Promise<unknown>>; opening?: Promise<void>; stopping?: Promise<void>
  started?: boolean; cancelled?: boolean; nativeTurn?: unknown; changeSeq?: number; usage?: Usage; final?: string; basis?: NativeProjections
}
type NativeQuestion = { id: string; question: string; multiSelect?: unknown; options?: { label: string }[] }
type NativeRequest = { questions?: never; resolve(value: unknown): void } | { questions: NativeQuestion[]; resolve(value: unknown): void; abort(): void }
type NativeTodo = { content?: unknown; status: string }

export function createNativeDshDriver({ nativeHost: host, cwd, name, sessionName, workspaceId, workspaceName, driverSessionId, model, thinking, permission, instructions, onEvent }: NativeDshDriverOptions = {} as NativeDshDriverOptions): Driver & { readonly instructionMode: string; watchdog: false } {
  const emit = (event: DriverEvent) => { try { onEvent?.(event) } catch {} }
  let sessionId = driverSessionId
  let agent: NativeAgent | undefined
  let ready: Promise<void> | null | undefined
  let running: NativeTurn | null | undefined
  let disposed = false
  let stopInstructions: (() => void) | undefined
  let compacting: AbortController | undefined
  let stopping: Promise<void> | undefined
  const compaction = nativeDshCompaction(host)
  const requests = new Map<string, NativeRequest>()
  const closeRequests = () => {
    for (const request of requests.values()) {
      if (request.questions) request.abort()
      else request.resolve('cancelled')
    }
    requests.clear()
  }
  // The Desktop host already projects this session's token usage, context
  // pressure and wall times for its own stats row; reading them makes the
  // plugin's figures the ones the native window shows. Every projection is
  // cumulative over the session log, so a turn reports the delta since its start,
  // and a host without the service leaves the summed per-message usage in place.
  const PROJECTIONS = ['tokenUsage', 'contextPressure', 'sessionStats']
  const projected = () => {
    try { return host.get?.('sessionProjections')?.snapshot?.(agent?.session, PROJECTIONS)?.values } catch { return undefined }
  }
  const projectedTurn = (basis?: NativeProjections) => {
    const now = projected()
    if (now === undefined) return {}
    const grew = (key: string, field: string) => {
      const from = basis?.[key]?.[field]
      const to = now[key]?.[field]
      return typeof from === 'number' && typeof to === 'number' && to >= from ? to - from : undefined
    }
    return {
      usage: usageOf({
        inputTokens: grew('tokenUsage', 'uncachedInputTokens'),
        outputTokens: grew('tokenUsage', 'outputTokens'),
        cacheReadTokens: grew('tokenUsage', 'cacheReadTokens'),
        cacheWriteTokens: grew('tokenUsage', 'cacheWriteTokens'),
        contextUsed: now.contextPressure?.pressureTokens,
        contextSize: now.contextPressure?.contextWindow,
      }),
      timing: timingOf({
        ttftMs: grew('sessionStats', 'ttftMs'),
        ttftSteps: grew('sessionStats', 'ttftSteps'),
        llmMs: grew('sessionStats', 'llmMs'),
        toolMs: grew('sessionStats', 'toolMs'),
        decodeMs: grew('sessionStats', 'decodeMs'),
        decodeTokens: grew('sessionStats', 'decodeTokens'),
      }),
    }
  }
  const end = (turn: NativeTurn, reason: 'done' | 'interrupted' | 'error', error?: unknown, unconfirmed = false) => {
    if (running !== turn) return
    const turnId = turn.id
    const changes = turn.changeSeq === undefined ? null : nativeDshChanges(host, sessionId, turn.changeSeq, turn.nativeTurn, turnId)
    const projected = turn.started ? projectedTurn(turn.basis) : {}
    const usage = usageOf({ ...turn.usage, ...projected.usage })
    const text = turn.final
    running = null
    toolNames.clear()
    closeRequests()
    const finish = () => emit({ type: 'turn/end', turnId, reason, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(projected.timing ? { timing: projected.timing } : {}), ...(unconfirmed ? { unconfirmed: true } : {}) })
    if (changes) changes.then(snapshot => { if (snapshot) emit(snapshot) }, () => {}).finally(finish)
    else finish()
  }
  const prompt = (turn: NativeTurn, request: Parameters<DshNativeRuntime['sessionController']['prompt']>[0]) => {
    const pending = Promise.resolve().then(() => {
      turn.controller.signal.throwIfAborted()
      return host.sessionController.prompt(request, AbortSignal.any([turn.controller.signal, AbortSignal.timeout(30000)]))
    })
    turn.pending.add(pending)
    const settled = () => turn.pending.delete(pending)
    pending.then(settled, settled)
    return pending
  }
  const stop = (turn: NativeTurn): Promise<void> => {
    if (turn.stopping) return turn.stopping
    turn.cancelled = true
    closeRequests()
    turn.controller.abort()
    // Native admission may finish after cancellation; wait before confirming idle.
    const operation = (async () => {
      await turn.opening?.catch(() => {})
      await Promise.allSettled([...turn.pending])
      if (turn.started) {
        await host.sessionController.cancel({ sessionId })
        await agent!.whenIdle()
      }
      end(turn, 'interrupted')
    })().catch((error: unknown) => end(turn, 'interrupted', (error as Error)?.message, true))
      .finally(() => { if (stopping === operation) stopping = undefined })
    stopping = turn.stopping = operation
    return operation
  }
  const off: (() => void)[] = []
  // One tool call is two host events; the result carries only the call id, so the
  // wire name recorded at call time keeps the transcript row named like the call.
  const toolNames = new Map<unknown, string>()
  const SUMMARY_KEYS = ['command', 'description', 'path', 'file_path', 'filePath', 'query', 'pattern', 'url', 'prompt']
  // One line for the collapsed tool row: the first summary-shaped argument.
  const briefOf = (args: unknown) => {
    if (typeof args !== 'string' || args.trim() === '') return undefined
    let parsed: unknown
    try { parsed = JSON.parse(args) } catch { return args.trim().slice(0, 200) }
    if (parsed === null || typeof parsed !== 'object') return String(parsed).slice(0, 200)
    const first = SUMMARY_KEYS.map(key => (parsed as Record<string, unknown>)[key]).find(value => typeof value === 'string' && value !== '')
      ?? Object.values(parsed).find(value => typeof value === 'string' && value !== '')
    return typeof first === 'string' ? first.slice(0, 200) : undefined
  }
  off.push(host.on('session/event', (session, event) => {
    if (disposed || session.id !== sessionId) return
    // Compaction carries its own identity and can run outside any hosted turn
    // (the host-side compact command); its lifetime never depends on `running`.
    if (event.type === 'compaction/start') {
      emit({ type: 'lifecycle', kind: 'compaction', phase: 'start', ...(event.data?.compactionId ? { entityId: String(event.data.compactionId) } : {}), ...(running ? { turnId: running.id } : {}) })
      return
    }
    if (event.type === 'compaction/end') {
      const error = typeof event.data?.error === 'string' && event.data.error ? event.data.error : undefined
      emit({ type: 'lifecycle', kind: 'compaction', phase: 'end', ...(event.data?.compactionId ? { entityId: String(event.data.compactionId) } : {}),
        ...(running ? { turnId: running.id } : {}), ...(error ? { detail: error } : {}), isError: error !== undefined })
      return
    }
    if (!running?.started) return
    if (event.type === 'turn/start') running.nativeTurn = event.data.turn
    // A late event from the previous native turn must not be attributed to the
    // new one; tool/call and tool/result carry their turn number.
    if (event.data?.turn !== undefined && running.nativeTurn !== undefined && event.data.turn !== running.nativeTurn) return
    // Retry waits and the todo list are mid-turn signals with their own ids and
    // whole-value snapshots; neither ever becomes thinking or reply text.
    if (event.type === 'llm/retry') {
      const failure = event.data?.failure
      const counts = [event.data?.retry, event.data?.maxRetries].filter(Number.isFinite)
      emit({ type: 'lifecycle', turnId: running.id, kind: 'retry', phase: 'start', ...(event.data?.retryId ? { entityId: String(event.data.retryId) } : {}),
        detail: [counts.length ? `第 ${counts.join('/')} 次` : null, Number.isFinite(event.data?.delayMs) ? `等待 ${Math.round((event.data.delayMs as number) / 1000)} 秒` : null,
          typeof failure?.message === 'string' && failure.message ? failure.message : null].filter(Boolean).join('，') || undefined })
      return
    }
    if (event.type === 'llm/retry-started') {
      emit({ type: 'lifecycle', turnId: running.id, kind: 'retry', phase: 'end', ...(event.data?.retryId ? { entityId: String(event.data.retryId) } : {}) })
      return
    }
    if (event.type === 'todo/write' && Array.isArray(event.data?.todos)) {
      emit({ type: 'plan', turnId: running.id, steps: event.data.todos.filter((todo): todo is NativeTodo & { content: string } => typeof todo?.content === 'string' && todo.content !== '').slice(0, 50)
        .map(todo => ({ text: todo.content, status: todo.status === 'in_progress' ? 'in_progress' : todo.status === 'completed' ? 'completed' : 'pending' })) })
      return
    }
    // The native sub-agent surface: one run is an activity container, each
    // member a child row keyed by runId+seq. The outcome/stopReason enums are
    // absent from the installed declarations, so both terminals stay neutral.
    if (event.type === 'tool-workflow/run-start' && event.data?.runId !== undefined) {
      emit({ type: 'activity', turnId: running.id, phase: 'start', entityId: String(event.data.runId), name: 'workflow',
        ...(typeof event.data.name === 'string' && event.data.name ? { title: event.data.name } : {}) })
      return
    }
    if (event.type === 'tool-workflow/agent-start' && event.data?.runId !== undefined && Number.isSafeInteger(event.data.seq)) {
      emit({ type: 'activity', turnId: running.id, phase: 'start', entityId: `${event.data.runId}/${event.data.seq}`, parentId: String(event.data.runId),
        name: 'subagent', ...(typeof event.data.label === 'string' && event.data.label ? { title: event.data.label } : {}),
        ...(event.data.childId ? { childId: String(event.data.childId) } : {}) })
      return
    }
    if (event.type === 'tool-workflow/agent-end' && event.data?.runId !== undefined && Number.isSafeInteger(event.data.seq)) {
      emit({ type: 'activity', turnId: running.id, phase: 'end', entityId: `${event.data.runId}/${event.data.seq}` })
      return
    }
    if (event.type === 'tool-workflow/run-end' && event.data?.runId !== undefined) {
      emit({ type: 'activity', turnId: running.id, phase: 'end', entityId: String(event.data.runId) })
      return
    }
    if (event.type === 'workspace/changes' && event.data.turn === running.nativeTurn && Number.isSafeInteger(event.seq)) running.changeSeq = event.seq as number
    if (event.type === 'assistant/message') {
      const blocks = event.data.message.content
      // One assembled message is one model call; its TokenUsage counts are
      // disjoint (uncached input, cache read, cache write, output), so a turn
      // that made several calls folds them into one usage.
      const usage = event.data.usage
      if (usage) {
        running.usage = addUsage(running.usage, usageOf({
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
          contextUsed: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        }))
      }
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text) running.final = text
      blocks.forEach((block, blockIndex) => {
        if ((block.type === 'reasoning' || block.type === 'text') && block.text) {
          emit({ type: block.type === 'reasoning' ? 'thinking' : 'text', turnId: running!.id,
            messageId: event.data.message.id, blockIndex, text: block.text, boundary: 'end' })
        }
      })
    }
    if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      emit({ type: 'tool', turnId: running.id, callId: event.data.callId, name: event.data.name, phase: 'start', input: event.data.arguments, brief: briefOf(event.data.arguments) })
    }
    if (event.type === 'tool/result') {
      const message = event.data.message
      const name = toolNames.get(message.toolCallId) ?? 'tool'
      toolNames.delete(message.toolCallId)
      emit({ type: 'tool', turnId: running.id, callId: message.toolCallId, name, phase: 'end', output: message.content, isError: message.isError === true })
    }
    if (event.type === 'turn/end' && event.data.turn === running.nativeTurn) {
      if (running.cancelled) return
      const turn = running
      const nativeTurn = event.data.turn
      const reason = event.data.reason
      const finish = () => end(turn, reason.kind === 'completed' ? 'done' : ['interrupted', 'aborted'].includes(reason.kind) ? 'interrupted' : 'error', reason.error?.message)
      if (turn.pending.size) Promise.allSettled([...turn.pending]).then(() => agent!.whenIdle()).then(() => { if (!turn.cancelled && turn.nativeTurn === nativeTurn) finish() }, (error: unknown) => end(turn, 'error', (error as Error)?.message, true))
      else finish()
    }
  }))
  off.push(host.on('agent/error', event => {
    if (event.agent === agent && running?.started && !running.cancelled
      && (event.turn === undefined || running.nativeTurn === undefined || event.turn === running.nativeTurn)) end(running, 'error', event.error?.message ?? String(event.error))
  }))
  off.push(host.on('approval/request', (request, next) => {
    if (request.agent !== agent || !running) return next()
    if (running.cancelled) return 'cancelled'
    const id = `dsh:${sessionId}:${randomUUID()}`
    return new Promise<unknown>(resolve => {
      const finish = (value: unknown) => {
        if (!requests.delete(id)) return
        request.signal?.removeEventListener('abort', abort)
        emit({ type: 'request/closed', id }); resolve(value)
      }
      const abort = () => finish('cancelled')
      requests.set(id, { resolve: finish })
      emit({ type: 'request/opened', id, kind: 'permission', tool: request.toolName, reason: request.reason })
      if (request.signal?.aborted) abort()
      else request.signal?.addEventListener('abort', abort, { once: true })
    })
  }, { prepend: true }))
  // DSH asks through the user-questions waterfall, a separate seam from
  // approval/request: answer our own live turn here, delegate the rest to the
  // host UI so other sessions' questions stay in their own window.
  off.push(host.on('user-questions/request', (request, next) => {
    if (!running || request.agent !== agent) return next()
    if (running.cancelled) throw Object.assign(new Error('ask_user_question was aborted before the user answered'), { name: 'UserQuestionError', code: 'ASK_ABORTED' })
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0 || questions.some(question => question.multiSelect)) return next()
    const id = `dsh:${sessionId}:${randomUUID()}`
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        if (!requests.delete(id)) return
        request.signal?.removeEventListener('abort', abort)
        emit({ type: 'request/closed', id })
        reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), { name: 'UserQuestionError', code: 'ASK_ABORTED' }))
      }
      const finish = (answer: unknown) => {
        if (!requests.delete(id)) return
        request.signal?.removeEventListener('abort', abort)
        emit({ type: 'request/closed', id })
        resolve(answer)
      }
      requests.set(id, { questions, resolve: finish, abort })
      emit({ type: 'request/opened', id, kind: 'question',
        reason: questions.map(question => question.question).join('\n'),
        detail: { questions } })
      if (request.signal?.aborted) abort()
      else request.signal?.addEventListener('abort', abort, { once: true })
    })
  }, { prepend: true }))
  const boot = () => ready ??= (async () => {
    if (disposed) throw new Error('DSH driver disposed')
    const workspace = await host.workspaceRegistry.resolveByPath(cwd) ?? await host.workspaceRegistry.create(cwd, workspaceName)
    workspaceId = workspace.id
    if (sessionId?.startsWith('dsh:isolated:')) throw new Error('This saved session uses the previous isolated storage. Explicitly import it before continuing in Desktop.')
    if (!sessionId) {
      sessionId = (await host.sessionController.create({ workspaceId })).sessionId
      await host.sessionController.rename({ sessionId, title: `${name} · ${sessionName ?? 'Session'}` })
    }
    const resolved = await host.sessionController.resolveAgent(sessionId)
    if (resolved.error) throw new Error(resolved.error.message)
    agent = resolved.agent
    if (agent.session.header.cwd !== cwd) throw new Error('DSH session belongs to another workspace')
    if (permission !== undefined) {
      const preset = nativeDshPermissions(host)[permission]
      if (!preset) throw new Error(`DSH native runtime does not offer permission tier "${permission}"`)
      const service = host.get('permissionPresets')
      if (service!.current(agent.session) !== preset) {
        if (agent.status !== 'idle') throw new Error('DSH is busy in its native window; wait before changing permissions')
        service!.set(agent.session, preset)
      }
    }
    if (model || thinking) {
      let route: unknown
      if (model) {
        try { route = JSON.parse(model) } catch { throw new Error('DSH model must be ["provider","model"]') }
      } else {
        const event = agent.session.snapshotEvents?.().findLast(event => event.type === 'model/selection' || event.type === 'request/header')
        const selection = (event?.type === 'model/selection' ? event.data : event?.data.header.config)
          ?? host.get?.('agentDefaultModel')?.currentSelection?.()
        if (!selection?.provider || !selection?.model) throw new Error('Choose a DSH model before setting a thinking level')
        route = [selection.provider, selection.model]
      }
      if (!Array.isArray(route) || route.length !== 2) throw new Error('DSH model must be ["provider","model"]')
      // A thinking level is a property of the selected route, so it is applied
      // with the model; the controller rejects a level the model does not list.
      await host.sessionController.selectModel({ sessionId, provider: route[0], model: route[1], ...(thinking ? { reasoningEffort: thinking } : {}) })
    }
    if (disposed) throw new Error('DSH driver disposed')
    const systemPrompt = agent.ctx?.systemPrompt
    if (instructions && typeof systemPrompt?.section === 'function' && !stopInstructions) {
      if (agent.status === 'running') throw new Error('DSH is busy in its native window; wait for that turn to finish')
      stopInstructions = systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: instructions, interpolate: false })
    }
    emit({ type: 'session', state: 'ready', sessionId, workspaceId })
  })().catch(error => { ready = null; throw error })
  return {
    get instructionMode() { return stopInstructions ? 'native' : 'none' },
    watchdog: false,
    openSession: boot,
    ...(typeof compaction?.compactNow === 'function' ? {
      async compact() {
        await boot()
        if (disposed) throw new Error('DSH driver disposed')
        if (running || stopping || compacting || agent!.status !== 'idle') throw new Error('Stop or finish the task before compacting this DSH session')
        const operation = new AbortController()
        compacting = operation
        try { return await compaction.compactNow(agent!, operation.signal) }
        finally { if (compacting === operation) compacting = undefined }
      },
    } : {}),
    async sendTurn(text, images = []) {
      if (disposed) throw new Error('DSH driver disposed')
      if (running || stopping || compacting) throw new Error('DSH already has a running turn or compaction, or is still stopping')
      const turn: NativeTurn = running = { id: randomUUID(), controller: new AbortController(), pending: new Set() }
      try {
        await (turn.opening = boot())
        if (disposed || turn.cancelled || running !== turn) return turn.id
        if (agent!.status === 'running') throw new Error('DSH is busy in its native window; wait for that turn to finish')
        turn.basis = projected()
        turn.started = true
        emit({ type: 'turn/start', turnId: turn.id })
        await prompt(turn, { requestId: turn.id, sessionId, mode: 'queue', content: [...(text === '' ? [] : [{ type: 'text', text: String(text) }]), ...images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data }))] })
      } catch (error) {
        if (turn.cancelled) return turn.id
        if (running === turn) running = null
        throw error
      }
      return turn.id
    },
    async steer(text) {
      const turn = running
      if (!turn?.started || turn.cancelled || compacting || disposed || agent?.status !== 'running') return STEER.REFUSED
      try {
        await prompt(turn, { requestId: randomUUID(), sessionId, mode: 'steer', content: [{ type: 'text', text: String(text) }] })
        return STEER.STEERED
      } catch (error) { return steerFailed(error) }
    },
    async interruptTurn() {
      compacting?.abort()
      const turn = running
      if (!turn) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([stop(turn), new Promise<void>(resolve => { timer = setTimeout(() => { end(turn, 'interrupted', undefined, true); resolve() }, 5000) })]) }
      finally { clearTimeout(timer) }
    },
    async respondToRequest(id, { decision, value } = {}) {
      const request = requests.get(id)
      if (!request) return false
      if (request.questions) {
        if (decision !== 'answer') return false
        let picks: unknown
        if (request.questions.length === 1) picks = { [request.questions[0].id]: String(value ?? '') }
        else { try { picks = JSON.parse(value!) } catch { throw new Error('Answer each question using the form') } }
        request.resolve({ answers: request.questions.map(question => {
          const pick = String((picks as Record<string, unknown> | null | undefined)?.[question.id] ?? '').trim()
          if (pick === '') throw new Error('Answer every question first')
          const chosen = (question.options ?? []).some(option => option.label === pick)
          return chosen ? { id: question.id, selected: [pick] } : { id: question.id, selected: [], custom: pick }
        }) })
        return true
      }
      if (!(['allow', 'deny'] as readonly unknown[]).includes(decision)) return false
      request.resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
      return true
    },
    onEvent() { throw new Error('Pass onEvent to createNativeDshDriver') },
    hasSession() { return !!agent },
    dispose() {
      if (disposed) return
      disposed = true
      compacting?.abort()
      const turn = running
      const cleanup = () => { stopInstructions?.(); stopInstructions = undefined }
      if (turn) {
        void stop(turn).finally(cleanup)
        end(turn, 'interrupted', undefined, true)
      } else if (stopping) void stopping.finally(cleanup)
      else cleanup()
      for (const unsubscribe of off) unsubscribe?.()
    },
  }
}
