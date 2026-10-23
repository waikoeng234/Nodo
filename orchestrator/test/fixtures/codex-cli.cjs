#!/usr/bin/env node
// Local executable fixture: no model/network/auth, but real stdio processes.
const { createInterface } = require('node:readline')
const { Duplex } = require('node:stream')
const { createServer } = require('node:http')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0) }
if (process.argv.includes('daemon')) process.exit(0)
let connection
const send = message => connection ? connection.send(JSON.stringify(message)) : process.stdout.write(JSON.stringify(message) + '\n')
let initialized = false
let ready = false
let thread = 'fixture-thread'
let turn = null
let next = 0
let approval = null
const note = (method, params) => send({ method, params: { threadId: thread, ...params } })
const done = (status = 'completed') => { if (turn) note('turn/completed', { turn: { id: turn, status } }); turn = null }
// One finished request reports its own usage the way the app-server does, in
// disjoint buckets with the model's context window beside them; the plugin folds
// the per-request figures into the turn's total.
const reportUsage = () => {
  const last = { inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 45, reasoningOutputTokens: 0, totalTokens: 1245 }
  note('thread/tokenUsage/updated', { turnId: turn, tokenUsage: { last, total: last, modelContextWindow: 258400 } })
}
const answer = text => {
  note('item/agentMessage/delta', { itemId: 'message-' + turn, turnId: turn, delta: text.slice(0, 3) })
  note('item/agentMessage/delta', { itemId: 'message-' + turn, turnId: turn, delta: text.slice(3) })
  note('item/completed', { turnId: turn, item: { id: 'message-' + turn, type: 'agentMessage', text } })
  reportUsage()
  done()
}
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') { initialized = true; send({ id, result: { userAgent: 'codex-cli fixture 0.159.2' } }); return }
  if (method === 'initialized') { ready = initialized; return }
  if (!ready) { send({ id, error: { message: 'initialize first' } }); return }
  if (!method && message.error) return
  if (!method && approval !== null && message.id === approval) {
    const resolved = approval
    approval = null
    // The real daemon confirms the client's reply with this notification before the turn continues.
    note('serverRequest/resolved', { requestId: resolved })
    if (message.result?.decision === 'accept') answer('Approved')
    else if (message.result?.answers) answer('Answered ' + Object.keys(message.result.answers).join(','))
    else done('interrupted')
    return
  }
  if (method === 'account/read') { send({ id, result: { account: { type: 'chatgpt', email: 'private@example.test' }, requiresOpenaiAuth: true } }); return }
  if (method === 'model/list') {
    send({ id, result: { data: [
      { id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', description: 'fixture', hidden: false, isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }, { reasoningEffort: 'medium', description: 'medium' }, { reasoningEffort: 'high', description: 'high' }] },
      { id: 'hidden-model', model: 'hidden-model', displayName: 'Hidden', description: 'fixture', hidden: true, isDefault: false,
        defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }] },
      { id: 'other-model', model: 'other-model', displayName: 'Other Model', description: 'fixture', hidden: false, isDefault: false,
        defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }] },
    ], nextCursor: null } }); return
  }
  if (method === 'project/list') { send({ id, result: { data: [] } }); return }
  if (method === 'project/create') { send({ id, result: { project: { id: 'fixture-project' } } }); return }
  if (['thread/metadata/update', 'thread/name/set'].includes(method)) { send({ id, result: {} }); return }
  if (method === 'thread/start' || method === 'thread/resume') {
    appendFileSync(join(process.cwd(), 'codex-requests.jsonl'), JSON.stringify({ method, params }) + '\n')
    if (params.developerInstructions && process.env.CODEX_FIXTURE_REJECT_INSTRUCTIONS) {
      send({ id, error: process.env.CODEX_FIXTURE_REJECT_INSTRUCTIONS === 'unsupported'
        ? { code: -32602, message: 'unknown field `developerInstructions`' }
        : process.env.CODEX_FIXTURE_REJECT_INSTRUCTIONS === 'other-field' ? { code: -32602, message: 'unknown field `sandbox`' }
        : { code: -32000, message: 'Authentication failed' } }); return
    }
    if (!params.cwd) { send({ id, error: { message: 'cwd missing' } }); return }
    thread = params.threadId ?? 'fixture-thread'
    send({ id, result: { thread: { id: thread } } }); return
  }
  if (method === 'turn/start') {
    appendFileSync(join(process.cwd(), 'codex-requests.jsonl'), JSON.stringify({ method, params }) + '\n')
    turn = 'turn-' + ++next
    const text = params.input[0].text
    send({ id, result: { turn: { id: turn, status: 'inProgress' } } })
    note('turn/started', { turn: { id: turn, status: 'inProgress' } })
    if (text.includes('FOREIGN_START')) note('turn/started', { turn: { id: 'foreign-' + next, status: 'inProgress' } })
    if (text.includes('UNSUPPORTED_ASK')) send({ id: 9000 + next, method: 'item/permissions/requestApproval', params: { threadId: thread, turnId: turn, itemId: 'x' } })
    if (text.startsWith('HANDOFF ')) {
      const [, tag, outcome] = text.split(' ')
      setTimeout(() => {
        for (const [name, phase, body] of [['progress', 'commentary', `Progress ${tag}`], ['final', 'final_answer', `Final ${tag}`]]) {
          note('item/agentMessage/delta', { turnId: turn, itemId: name, delta: body })
          note('item/completed', { turnId: turn, item: { id: name, type: 'agentMessage', phase, text: body } })
        }
        done(outcome === 'error' ? 'failed' : 'completed')
      }, 30)
      return
    }
    if (text === 'FILES_MALFORMED') {
      note('item/completed', { turnId: turn, item: { id: 'invalid', type: 'fileChange', status: 'completed', changes: 'unsupported shape' } })
      note('item/completed', { turnId: turn, item: { id: 'null-change', type: 'fileChange', status: 'completed', changes: [null] } })
      return answer('Malformed structure downgraded')
    }
    if (text === 'FILES_FLOW') {
      const paths = ['子 目录/一.md', '.agent/tmp/proof.md', '/tmp/nodo-outside-proof.md', ...Array.from({ length: 7 }, (_, i) => `file-${i + 4}.txt`)]
      const item = { id: 'files', type: 'fileChange', status: 'completed', changes: paths.map(path => ({ path, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-ES05_BEFORE\n+ES05_AFTER\n' })) }
      note('item/started', { turnId: turn, item: { ...item, status: 'inProgress' } })
      note('item/completed', { threadId: 'foreign', turnId: turn, item: { ...item, id: 'foreign', changes: [{ path: 'foreign.txt', kind: { type: 'add' }, diff: '+foreign' }] } })
      note('item/completed', { turnId: turn, item })
      note('item/completed', { turnId: turn, item })
      note('item/completed', { turnId: turn, item: { ...item, id: 'second', changes: [item.changes[0]] } })
      note('item/completed', { turnId: turn, item: { ...item, id: 'failed', status: 'declined', changes: [{ path: 'failed.txt', kind: { type: 'add' }, diff: '+failed' }] } })
      note('turn/diff/updated', { turnId: turn, diff: 'ES05_OLD_TURN_DIFF' })
      note('turn/diff/updated', { turnId: turn, diff: 'ES05_FINAL_TURN_DIFF' })
      return answer('ES05_FILES_DONE')
    }
    if (text === 'EVENTS') {
      note('item/reasoning/summaryTextDelta', { turnId: turn, itemId: 'r1', summaryIndex: 0, delta: 'Check ' })
      note('item/reasoning/summaryTextDelta', { turnId: turn, itemId: 'r1', summaryIndex: 0, delta: 'route.' })
      note('item/reasoning/summaryTextDelta', { turnId: turn, itemId: 'r1', summaryIndex: 1, delta: 'Run ' })
      note('item/reasoning/textDelta', { turnId: turn, itemId: 'r1', contentIndex: 0, delta: 'Check route.' })
      note('item/completed', { turnId: turn, item: { id: 'r1', type: 'reasoning', summary: ['Check route.', 'Run tool.'], content: ['Check route.'] } })
      for (const type of ['commandExecution', 'collabAgentToolCall']) {
        const item = { id: type, type, command: type === 'commandExecution' ? 'echo fixture' : undefined, tool: type === 'collabAgentToolCall' ? 'spawnAgent' : undefined, prompt: 'Review this', status: 'inProgress' }
        note('item/started', { turnId: turn, item })
        if (type === 'commandExecution') {
          note('item/commandExecution/outputDelta', { turnId: turn, itemId: type, delta: 'fix' })
          note('item/commandExecution/outputDelta', { turnId: turn, itemId: type, delta: 'ture' })
        }
        note('item/completed', { turnId: turn, item: { ...item, status: 'completed', aggregatedOutput: type === 'commandExecution' ? 'fixture' : undefined, agentsStates: type === 'collabAgentToolCall' ? { worker: { status: 'completed' } } : undefined } })
      }
      const mcp = { id: 'mcp', type: 'mcpToolCall', tool: 'lookup', status: 'inProgress' }
      note('item/started', { turnId: turn, item: mcp })
      note('item/mcpToolCall/progress', { turnId: turn, itemId: 'mcp', message: 'halfway' })
      note('item/completed', { turnId: turn, item: { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'mcp done' }] } } })
      return answer('Events done')
    }
    if (text === 'THOUGHT_FALLBACK') {
      note('item/completed', { turnId: turn, item: { id: 'r2', type: 'reasoning', summary: [], content: ['First paragraph.', 'Second paragraph.'] } })
      return answer('Fallback done')
    }
    if (text === 'PLAN_FLOW') {
      note('turn/plan/updated', { turnId: turn, explanation: 'Fix the bug', plan: [
        { step: 'read the file', status: 'completed' }, { step: 'edit the code', status: 'inProgress' }, { step: 'run tests', status: 'pending' }] })
      note('turn/plan/updated', { turnId: turn, explanation: 'Fix the bug', plan: [
        { step: 'read the file', status: 'completed' }, { step: 'edit the code', status: 'completed' }] })
      note('error', { turnId: turn, willRetry: true, error: { message: 'rate limited' } })
      note('item/started', { turnId: turn, item: { id: 'sub-1', type: 'subAgentActivity', kind: 'started', agentPath: '/agents/reviewer', agentThreadId: 'thread-child' } })
      note('item/completed', { turnId: turn, item: { id: 'sub-1', type: 'subAgentActivity', kind: 'completed', agentPath: '/agents/reviewer', agentThreadId: 'thread-child' } })
      note('thread/compacted', { turnId: turn })
      return answer('Plan done')
    }
    if (text === 'MEDIA_FLOW') {
      note('item/completed', { turnId: turn, item: { id: 'view', type: 'imageView', path: '/workspace/shot.png' } })
      note('item/completed', { turnId: turn, item: { id: 'gen', type: 'imageGeneration', result: 'ES08_GENERATED', status: 'completed', savedPath: '/workspace/generated.png' } })
      note('item/completed', { turnId: turn, item: { id: 'dyn', type: 'dynamicToolCall', arguments: {}, status: 'completed',
        contentItems: [{ type: 'inputText', text: '动态文本' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }] } })
      return answer('Media done')
    }
    if (text.includes('ASK_PERMISSION')) {
      approval = 1000 + next
      send({ id: approval, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, itemId: 'cmd', command: 'echo fixture', availableDecisions: ['accept', 'decline'] } })
    } else if (text.includes('ASK_QUESTIONS')) {
      approval = 1000 + next
      send({ id: approval, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, itemId: 'questions', isBlocking: true, questions: [{ id: 'q1', header: 'First', question: 'First choice?' }, { id: 'q2', header: 'Second', question: 'Second choice?' }] } })
    } else if (text.includes('EFFORT')) setTimeout(() => answer(`Effort ${params.effort ?? 'none'}`), 30)
    else if (!text.includes('WAIT')) setTimeout(() => answer(params.input[0].text.includes('FIRST') ? 'Hello world' : 'Continued'), 30)
    return
  }
  if (method === 'thread/compact/start') {
    appendFileSync(join(process.cwd(), 'codex-requests.jsonl'), JSON.stringify({ method, params }) + '\n')
    if (process.env.CODEX_FIXTURE_COMPACT_SIGNAL) {
      // The declared codex behavior: the announcement is the only completion signal.
      setTimeout(() => { note('thread/compacted', {}); send({ id, result: {} }) }, 30)
      return
    }
    turn = 'engine-compact-' + ++next
    send({ id, result: {} })
    note('turn/started', { turn: { id: turn, status: 'inProgress' } })
    setTimeout(() => {
      note('item/completed', { turnId: turn, item: { id: 'compact-item', type: 'contextCompaction' } })
      done()
    }, 100)
    return
  }
  if (method === 'turn/steer') { appendFileSync(join(process.cwd(), 'codex-requests.jsonl'), JSON.stringify({ method, params }) + '\n'); send({ id, result: { turnId: turn } }); answer('Steered'); return }
  if (method === 'turn/interrupt') { send({ id, result: {} }); if (!process.env.CODEX_IGNORE_INTERRUPT) done('interrupted'); return }
  send({ id, error: { message: 'unknown method' } })
}

if (process.argv.includes('proxy')) {
  const WebSocket = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/package.json'))('ws')
  const server = createServer()
  const wss = new WebSocket.WebSocketServer({ noServer: true })
  const stream = Duplex.from({ readable: process.stdin, writable: process.stdout })
  stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
    connection = ws
    ws.on('message', data => receive(data.toString()))
  }))
  server.emit('connection', stream)
} else createInterface({ input: process.stdin }).on('line', receive)
