#!/usr/bin/env node
// Local executable fixture speaking ZCode Protocol v1 (NDJSON, no jsonrpc field),
// no model/network/auth. Mirrors the real app-server: storage notifications, a
// runtime-preferences round trip during session/create, event envelopes that
// carry sessionId/seq, and server requests for permissions and user input.
const { createInterface } = require('node:readline')
const { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
if (process.argv.includes('--version')) { console.log(process.env.FIXTURE_VERSION ?? (existsSync('fixture-native-role') ? '0.16.9' : 'zcode fixture')); process.exit(0) }
if (process.env.FIXTURE_EXIT_APPSERVER) { console.error('fixture: cannot locate provider config'); process.exit(1) }
if (process.argv[2] !== 'app-server' || process.argv.length !== 3) process.exit(2)
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const ledger = line => appendFileSync(join(process.cwd(), 'session-ledger'), `${line}\n`)
const SESSION = 'fixture-zcode-session'
let seq = 0
let turn = null
let turnNumber = 0
let sessionCacheRead = 0
let subscribed = false
const serverRequests = new Map()
const envelope = (type, payload, sessionId = SESSION) => ({ method: 'session/event', params: { sessionId, seq: ++seq, deliveryKind: 'desktop-continuous', eventId: `ev-${seq}`, traceId: 'fixture', timestamp: Date.now(), turnId: turn?.native, type, payload } })
const notify = (type, payload, sessionId) => send(envelope(type, payload, sessionId))

const finish = (response, resultType = 'success', usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, cacheStats) => {
  if (!turn) return
  notify('turn.completed', { response, resultType, inputId: turn.inputId, tokenCount: usage.totalTokens, usage, ...(cacheStats ? { cacheStats } : {}), duration: 10 })
  turn = null
}
const askPermission = () => {
  notify('tool.updated', { toolCallId: 'tool-1', toolName: 'Bash', schedule: { command: 'echo fixture' } })
  const id = 5000 + seq
  serverRequests.set(id, 'permission')
  send({ id, method: 'interaction/requestPermission', params: { sessionId: SESSION, requestId: 'perm-1', toolName: 'Bash', riskLevel: 'medium', reason: 'run echo fixture', options: [
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once', response: { decision: 'allow' } },
    { optionId: 'deny-once', name: 'Deny', kind: 'reject_once', response: { decision: 'deny' } },
  ] } })
}
const askQuestion = () => {
  const id = 6000 + seq
  serverRequests.set(id, 'question')
  send({ id, method: 'interaction/requestUserInput', params: { sessionId: SESSION, requestId: 'q-1', prompt: 'Favorite color?', questions: [{ header: 'Color', question: 'Favorite color?' }] } })
}
const askMulti = () => {
  const id = 6000 + seq
  serverRequests.set(id, 'multi')
  send({ id, method: 'interaction/requestUserInput', params: { sessionId: SESSION, requestId: 'q-2', questions: [
    { header: 'Color', question: 'Pick a color?', options: [{ value: 'blue', label: 'Blue' }, { value: 'red', label: 'Red' }] },
    { header: 'Size', question: 'Pick a size?', options: [{ value: 'big', label: 'Big' }] },
  ] } })
}
const runTurn = text => {
  notify('turn.started', { turnNumber, input: text })
  if (text.startsWith('HANDOFF ')) {
    const [, tag, outcome] = text.split(' ')
    return setTimeout(() => {
      for (const name of ['Progress', 'Final']) notify('model.streaming', { kind: 'text_delta', assistantMessageId: `${name}-${turnNumber}`, delta: `${name} ${tag}` })
      finish(`Final ${tag}`, outcome === 'error' ? 'error' : 'success')
    }, 30)
  }
  if (text === 'FILE_DIFFS') {
    const start = (id, path, old_string, new_string) => notify('model.streaming', { kind: 'tool_call', toolCallId: id, toolName: 'Edit', input: JSON.stringify({ file_path: path, old_string, new_string }) })
    const result = (id, success = true, foreign) => notify('tool.updated', { kind: 'result', toolCallId: id, result: { success, content: 'finished' } }, foreign)
    start('edit-1', '/proposal', 'wrong', 'proposed')
    notify('permission.resolved', { toolCallId: 'edit-1', modifiedInput: { file_path: 'edited.txt', old_string: 'before\n', new_string: 'approved\n' } })
    result('edit-1'); result('edit-1')
    start('edit-2', 'edited.txt', 'approved\n', '')
    result('edit-2')
    start('failed', 'failed.txt', 'before', 'after'); result('failed', false)
    start('foreign', 'foreign.txt', 'before', 'after'); result('foreign', true, 'other-session')
    return finish('Edits done')
  }
  if (text === 'FILES_FLOW') {
    for (let i = 0; i < 10; i++) {
      const file_path = process.cwd() + '/.agent/文件 ' + i + '.txt'
      notify('model.streaming', { kind: 'tool_call', toolCallId: 'write-' + i, toolName: 'Write', input: JSON.stringify({ file_path: i ? file_path : '/original-proposal', content: 'proposed' }) })
      if (!i) notify('permission.resolved', { toolCallId: 'write-0', modifiedInput: { file_path, content: 'owner choice' } })
      notify('tool.updated', { kind: 'result', toolCallId: 'write-' + i, result: { success: true, content: 'confirmed' } })
      notify('tool.updated', { kind: 'result', toolCallId: 'write-' + i, result: { success: true, content: 'duplicate' } })
    }
    for (const id of ['failed', 'foreign', 'unknown']) {
      notify('model.streaming', { kind: 'tool_call', toolCallId: id, toolName: 'Write', input: { file_path: process.cwd() + '/' + id } })
      notify('tool.updated', { kind: 'result', toolCallId: id, result: { ...(id !== 'unknown' ? { success: id !== 'failed' } : {}), content: 'finished' } }, id === 'foreign' ? 'other-session' : undefined)
    }
    notify('model.streaming', { kind: 'tool_call', toolCallId: 'bash', toolName: 'Bash', input: { command: 'printf x > /tmp/not-a-confirmed-file' } })
    notify('tool.updated', { kind: 'result', toolCallId: 'bash', result: { success: true, content: 'done' } })
    return finish('Files done')
  }
  if (text.includes('FILE_INPUT')) {
    notify('model.streaming', { kind: 'tool_input_start', toolCallId: 'file', toolName: 'Write' })
    notify('model.streaming', { kind: 'tool_input_delta', toolCallId: 'file', delta: '{"file_path":' })
    return setTimeout(() => {
      notify('model.streaming', { kind: 'tool_call', toolCallId: 'file', toolName: 'Write', input: { file_path: '/tmp/fixture.txt', content: 'hello' } })
      notify('tool.updated', { kind: 'result', toolCallId: 'file', result: { success: true, content: 'written' } })
      finish('File done')
    }, 80)
  }
  if (text.includes('NETWORK_RETRY')) {
    notify('session.updated', { type: 'model_retry_scheduled', _meta: { zcode: { apiRetry: { attempt: 1, maxRetries: 3, retryDelayMs: 1000 } } } })
    notify('session.updated', { type: 'model_retry_scheduled', _meta: { zcode: { apiRetry: { attempt: 2, maxRetries: 3, retryDelayMs: 2000 } } } })
    notify('model.streaming', { assistantMessageId: 'msg-retry', delta: 'Back online', kind: 'text_delta', done: false })
    notify('session.updated', { type: 'model_retry_scheduled', _meta: { zcode: { apiRetry: { attempt: 3, maxRetries: 3, retryDelayMs: 3000 } } } })
    return setTimeout(() => notify('turn.failed', { error: { message: 'network unavailable' } }), 50)
  }
  if (text.includes('EVENTS')) {
    notify('model.streaming', { kind: 'reasoning_delta', delta: 'Check ' })
    notify('model.streaming', { kind: 'reasoning_delta', delta: 'route.' })
    notify('model.streaming', { kind: 'tool_call', toolCallId: 'a', toolName: 'Read', input: { path: '/tmp/fixture' } })
    notify('tool.updated', { kind: 'scheduled', toolCallId: 'a', toolName: 'Read', inputOmitted: true, parentToolCallId: 'parent-call' })
    notify('tool.updated', { kind: 'started', toolCallId: 'a' })
    notify('tool.updated', { kind: 'progress', toolCallId: 'a', elapsedMs: 1500, stdoutTail: 'working', stdoutBytes: 7, stderrBytes: 0 })
    notify('tool.updated', { kind: 'result', toolCallId: 'a', result: { success: true, content: [{ type: 'text', text: 'file contents' }] } })
    notify('tool.updated', { kind: 'scheduled', toolCallId: 'b', toolName: 'Bash', input: { command: 'false' } })
    notify('tool.updated', { kind: 'error', toolCallId: 'b', error: { message: 'command failed' } })
    notify('tool.updated', { kind: 'result', toolCallId: 'c', toolName: 'Read', result: { success: true, content: 'result only' } })
    notify('tool.updated', { kind: 'batch', toolCallIds: ['a', 'b', 'c'], successCount: 2, errorCount: 1 })
    return setTimeout(() => finish('Events done'), 30)
  }
  if (text.includes('NOSTREAM')) return setTimeout(() => finish('Silent reply'), 30)
  // A provider that reports its own cache buckets, plus the session's context
  // occupancy snapshot: GLM-style counters, not the canonical names. `input` is
  // the whole prompt with the cache side inside, so 4000 = 900 + 3000 + 100.
  // AI SDK counters: inputTokens is the whole prompt too, 4000 = 900 + 3000 + 100;
  // SPLITCOUNT's provider reports it disjoint, which only its total reveals.
  if (text.includes('SDKCOUNT') || text.includes('SPLITCOUNT')) {
    const inputTokens = text.includes('SDKCOUNT') ? 4000 : 900
    return setTimeout(() => finish('Counted', 'success', { inputTokens, outputTokens: 12, totalTokens: 4012, cacheReadTokens: 3000, cacheWriteTokens: 100 }), 30)
  }
  if (text.includes('USAGE')) {
    notify('session.updated', { contextUsage: { used: 5000, size: 200000 } })
    notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'Counted', kind: 'text_delta', done: true })
    return setTimeout(() => finish('Counted', 'success', { input: 4000, output: 12, total: 4012, cache: { read: 3000, write: 100 } }), 30)
  }
  // A provider without per-turn cache buckets, only the session's cumulative
  // read, which each turn advances by 700 so the driver can differential it.
  if (text.includes('CUMULATIVE_CACHE')) {
    sessionCacheRead += 700
    notify('session.updated', { contextUsage: { used: 6000, size: 200000 } })
    notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'Cached', kind: 'text_delta', done: true })
    return setTimeout(() => finish('Cached', 'success', { input: 800, output: 4, total: 804 }, { cacheReadTokens: sessionCacheRead }), 30)
  }
  if (text.includes('TWO')) {
    notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'Hello', kind: 'text_delta', done: false })
    notify('model.streaming', { assistantMessageId: 'msg-2', delta: 'world', kind: 'text_delta', done: true })
    return setTimeout(() => finish('Hello\nworld'), 30)
  }
  notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'Hello ', kind: 'text_delta', done: false })
  notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'private reasoning', kind: 'reasoning_delta', done: false })
  notify('model.streaming', { assistantMessageId: 'msg-1', delta: 'world', kind: 'text_delta', done: true })
  notify('tool.updated', { toolCallId: 'tool-1', toolName: 'Bash', schedule: { command: 'echo fixture' } })
  notify('tool.updated', { toolCallId: 'tool-1', toolName: 'Bash', result: { success: true, content: 'fixture' } })
  return setTimeout(() => finish('Hello world'), 30)
}

// The real server asks for runtime preferences (and MCP auth headers) during
// session/create; a refusal picks the documented defaults. FIXTURE_BOOT_CARD
// makes the first create open a permission ask and then fail, so a card can
// outlive the boot it opened under.
const create = id => {
  serverRequests.set(9001, 'prefs')
  send({ id: 9001, method: 'session/requestRuntimePreferences', params: { sessionId: 'pending', scope: 'runtime-materialization' } })
  serverRequests.set(9002, 'mcp-auth')
  send({ id: 9002, method: 'interaction/requestOfficialMcpAuthHeaders', params: { mcpKey: 'fixture', requestId: 'official-mcp-auth:1', targetOrigin: 'https://fixture.invalid' } })
  if (process.env.FIXTURE_BOOT_CARD && !existsSync('boot-card-failed')) {
    writeFileSync('boot-card-failed', '')
    serverRequests.set(5000, 'permission')
    send({ id: 5000, method: 'interaction/requestPermission', params: { requestId: 'boot-perm', toolName: 'Bash', riskLevel: 'low', reason: 'boot card', options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once', response: { decision: 'allow' } },
      { optionId: 'deny-once', name: 'Deny', kind: 'reject_once', response: { decision: 'deny' } },
    ] } })
  }
  serverRequests.set(id, 'create')
}
const settle = { prefs: null, 'mcp-auth': null }

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === undefined) {
    const kind = serverRequests.get(message.id)
    if (!kind) process.exit(4)
    serverRequests.delete(message.id)
    if (kind === 'prefs' || kind === 'mcp-auth') {
      settle[kind] = message.error ? 'refused' : 'answered'
      if (settle.prefs !== null && settle['mcp-auth'] !== null) {
        const id = [...serverRequests.entries()].find(([, value]) => value === 'create')?.[0]
        serverRequests.delete(id)
        ledger(`create:${settle.prefs}:${settle['mcp-auth']}`)
        if (existsSync('boot-card-failed') && !existsSync('boot-card-ok')) {
          writeFileSync('boot-card-ok', '')
          return send({ id, error: { code: -32000, message: 'fixture boot failed' } })
        }
        send({ id, result: { session: { sessionId: SESSION }, protocol: { name: 'ZCode Protocol', version: 1 }, projection: { mode: 'build' },
          // The session snapshot carries the context occupancy beside the model
          // list; the driver reads it at boot and refreshes it from events.
          runtime: { contextUsage: { used: 4200, size: 128000 } },
          settings: { model: {
            current: { providerId: 'mock', modelId: 'glm-test' },
            available: [
              { ref: { providerId: 'mock', modelId: 'glm-test' }, label: 'glm-test', providerLabel: 'Mock', contextWindow: 1000,
                reasoning: { levels: [{ value: 'disabled', label: 'disabled' }, { value: 'high', label: 'high' }], defaultLevel: 'high' } },
              { ref: { providerId: 'mock', modelId: 'glm-fast' }, label: 'glm-fast', providerLabel: 'Mock', contextWindow: 1000,
                reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'max', label: 'max' }] } },
            ] },
            thoughtLevel: { enabled: true, current: 'high', defaultLevel: 'high', available: [{ value: 'high', label: 'high' }] } } } })
      }
    } else if (kind === 'permission') {
      if (!['allow', 'deny'].includes(message.result?.decision)) process.exit(5)
      if (process.env.FIXTURE_LOST_APPROVAL) return
      notify('tool.updated', { toolCallId: 'tool-1', toolName: 'Bash', result: { success: message.result.decision === 'allow' } })
      finish(message.result.decision === 'allow' ? 'Approved' : 'Denied')
    } else if (kind === 'question') {
      const content = message.result?.content ?? {}
      const value = String(content.answers?.['Favorite color?'] ?? content.answer ?? '').trim()
      if (message.result?.action !== 'accept' || !value) process.exit(6)
      finish(`Answered ${value}`)
    } else if (kind === 'multi') {
      const answers = message.result?.content?.answers ?? {}
      const first = String(answers['Pick a color?'] ?? '').trim()
      const second = String(answers['Pick a size?'] ?? '').trim()
      if (message.result?.action !== 'accept' || !first || !second) process.exit(6)
      finish(`Answered ${first}/${second}`)
    }
    return
  }
  const { id, method, params = {} } = message
  if (['session/create', 'session/resume'].includes(method) && params.mcpServers) {
    appendFileSync(join(process.cwd(), 'zcode-mcp-requests.jsonl'), JSON.stringify({ method, params }) + '\n')
    if (!process.env.FIXTURE_SKIP_ROLE_CATALOG) for (const spec of params.mcpServers) {
      const env = Object.fromEntries(spec.env.map(item => [item.name, item.value]))
      if (env.NODO_ROLE_READY_FILE) writeFileSync(env.NODO_ROLE_READY_FILE, JSON.stringify({ version: createHash('sha256').update(readFileSync(env.NODO_ROLE_FILE)).digest('hex') }))
    }
    if (process.env.FIXTURE_NO_ROLE_MCP) return send({ id, error: { code: -32602, message: 'unknown field `mcpServers`' } })
    if (process.env.FIXTURE_ROLE_MCP_FAILURE) return send({ id, error: { code: -32000, message: 'MCP connection failed' } })
  }
  if (method === 'session/create') {
    if (!['plan', 'build', 'edit', 'yolo', 'guarded', 'auto'].includes(params.mode) || !params.workspace || realpathSync(params.workspace.workspacePath) !== realpathSync(process.cwd()) || params.workspace.workspaceKey !== params.workspace.workspacePath) process.exit(6)
    ledger(`mode ${params.mode}`)
    if (process.env.FIXTURE_DEFER_EMPTY || existsSync('defer-empty')) writeFileSync('zcode-empty', '')
    create(id)
  } else if (method === 'session/resume') {
    if (process.env.FIXTURE_RESUME_FAILURE) return send({ id, error: { code: -32000, message: 'Session store unavailable' } })
    if (process.env.FIXTURE_RESUME_NOT_FOUND || existsSync('zcode-empty')) return send({ id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } })
    if (params.sessionId !== SESSION || !existsSync(join(process.cwd(), 'session-ledger'))) return send({ id, error: { code: -32010, message: 'Unknown session' } })
    ledger('session/resume')
    send({ id, result: { session: { sessionId: SESSION }, protocol: { name: 'ZCode Protocol', version: 1 }, messages: [{ info: { messageId: 'msg-0', role: 'assistant' }, parts: [{ type: 'text', text: 'Earlier reply' }] }] } })
  } else if (method === 'session/setMode') {
    if (params.sessionId !== SESSION || !['plan', 'build', 'edit', 'yolo', 'guarded', 'auto'].includes(params.mode)) process.exit(8)
    ledger(`mode ${params.mode}`)
    send({ id, result: {} })
  } else if (method === 'session/subscribe') {
    if (params.sessionId !== SESSION || params.deliveryKind !== 'desktop-continuous') process.exit(7)
    subscribed = true
    send({ id, result: { sessionId: SESSION, eventSeq: seq, events: [] } })
  } else if (method === 'session/setModel') {
    const model = params.model ?? {}
    if (params.sessionId !== SESSION || typeof model.providerId !== 'string' || !model.providerId.trim() || typeof model.modelId !== 'string' || !model.modelId.trim()) process.exit(8)
    ledger(`model ${model.providerId}$${model.modelId}`)
    const level = model.options?.reasoningLevel
    if (level !== undefined) {
      const levels = ['mock$glm-test', 'mock$glm-fast'].includes(`${model.providerId}$${model.modelId}`) ? ['disabled', 'high', 'low', 'max'] : []
      if (!levels.includes(level)) process.exit(8)
      ledger(`effort ${level}`)
    }
    send({ id, result: {} })
  } else if (method === 'session/setThoughtLevel') {
    if (params.sessionId !== SESSION || !['disabled', 'high', 'low', 'max'].includes(params.thoughtLevel)) process.exit(8)
    ledger(`thought ${params.thoughtLevel}`)
    send({ id, result: {} })
  } else if (method === 'session/compact') {
    if (params.sessionId !== SESSION) process.exit(8)
    ledger('compact')
    if (process.env.FIXTURE_ASYNC_COMPACT) {
      send({ id, result: { compact: { state: 'accepted' } } })
      setTimeout(() => {
        if (process.env.FIXTURE_COMPACT_EXIT) process.exit(10)
        notify('turn.completed', { resultType: process.env.FIXTURE_COMPACT_ERROR ? 'error_compact' : 'success' })
      }, 100)
      return
    }
    send({ id, result: {} })
  } else if (method === 'session/close') {
    if (params.sessionId !== SESSION) process.exit(8)
    ledger('session/close')
    send({ id, result: {} })
  } else if (method === 'v4/command' && process.env.FIXTURE_V4_GUIDE) {
    if (params.clientId !== 'nodo' || params.sessionId !== SESSION || !params.commandId || typeof params.issuedAt !== 'number') process.exit(13)
    ledger(`v4 ${params.type}`)
    if (params.type === 'stop') {
      send({ id, result: { commandId: params.commandId, status: 'accepted', revisionAtDecision: 1 } })
      return finish('', 'cancelled')
    }
    if (params.type !== 'sendText' || params.payload.requestedDelivery !== 'guide') process.exit(14)
    if (params.payload.text === 'REJECT') return send({ id, result: { status: 'rejected', reasonCode: 'fixture' } })
    notify('turn.steerQueued', { inputId: params.commandId, pendingInputId: 'pending-' + params.commandId, delivery: 'guide' })
    send({ id, result: { status: 'accepted', result: { type: 'inputAccepted', delivery: 'queue', inputId: params.commandId } } })
    if (params.payload.text === 'HOLD') return
    if (process.env.FIXTURE_V4_QUEUE) {
      finish('original completed')
      turn = { native: `turn-${++turnNumber}`, inputId: params.commandId }
      notify('turn.started', { turnNumber, input: params.payload.text, inputId: params.commandId })
      if (process.env.FIXTURE_V4_FAIL) return setTimeout(() => notify('turn.failed', { error: { message: 'fixture failed segment' } }), 30)
    } else notify('turn.steerDrained', { pendingInputIds: ['pending-' + params.commandId], injectedMessageIds: ['steered-message'] })
    return setTimeout(() => finish('Steered ' + params.payload.text), 50)
  } else if (method === 'session/send') {
    if (params.sessionId !== SESSION || !subscribed) process.exit(9)
    if (turn) return send({ id, error: { code: -32010, message: 'A prompt is already running for this session' } })
    appendFileSync(join(process.cwd(), 'zcode-turns.jsonl'), JSON.stringify(params) + '\n')
    const text = params.content.split('\n# Current task\n').at(-1)
    if (existsSync('zcode-empty')) unlinkSync('zcode-empty')
    turn = { native: `turn-${++turnNumber}` }
    send({ id, result: { accepted: true, sessionId: SESSION, stateRevision: 1 } })
    if (text.includes('WAIT')) {
      if (process.env.FIXTURE_HEALTH_METADATA) {
        const timer = setInterval(() => notify('session.updated', { runtime: { activeTurnId: turn?.native } }), 5)
        timer.unref()
      }
      return
    }
    if (text.includes('EXIT')) return process.exit(10)
    if (text.includes('LEAK')) {
      notify('model.streaming', { assistantMessageId: 'msg-x', delta: 'wrong session', kind: 'text_delta', done: true }, 'other-session')
      return runTurn(text)
    }
    if (text.includes('ASK_PERMISSION')) { notify('turn.started', { turnNumber, input: text }); return askPermission() }
    if (text.includes('ASK_QUESTION')) { notify('turn.started', { turnNumber, input: text }); return askQuestion() }
    if (text.includes('ASK_MULTI')) { notify('turn.started', { turnNumber, input: text }); return askMulti() }
    return runTurn(text)
  } else if (method === 'session/stop') {
    if (params.sessionId !== SESSION) process.exit(11)
    appendFileSync(join(process.cwd(), 'stop-ledger'), 'session/stop\n')
    send({ id, result: {} })
    finish('', 'cancelled', { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  } else if (method === 'session/list') {
    send({ id, result: { sessions: [{ sessionId: SESSION, workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() }, status: 'idle' }] } })
  } else if (method === 'session/read') {
    ledger('health-read')
    if (process.env.FIXTURE_HEALTH_HANG) return
    if (process.env.FIXTURE_HEALTH_LATE) {
      setTimeout(() => notify('model.streaming', { kind: 'text_delta', delta: 'still running' }), 10)
      return
    }
    if (process.env.FIXTURE_HEALTH_UNSUPPORTED) return send({ id, error: { code: -32601, message: 'Unsupported method' } })
    const idle = Boolean(process.env.FIXTURE_HEALTH_IDLE)
    send({ id, result: { session: { sessionId: SESSION, status: idle ? 'idle' : 'running' }, projection: { status: idle ? 'idle' : 'running' }, runtime: { pendingRequestIds: process.env.FIXTURE_LOST_APPROVAL ? ['perm-1'] : [], ...(!idle && turn ? { activeTurnId: turn.native } : {}) } } })
  } else if (method === 'session/compact') {
    if (params.sessionId !== SESSION) process.exit(8)
    ledger('compact')
    send({ id, result: {} })
  } else if (method === 'session/close') {
    send({ id, result: { closed: true } })
  } else if (method === 'runtime/capabilities') {
    send({ id, result: { independentPlanState: true } })
  } else send({ id, error: { code: -32601, message: 'Unsupported method' } })
}).on('close', () => process.exit(0))
