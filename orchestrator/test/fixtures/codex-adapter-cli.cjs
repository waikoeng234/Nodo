#!/usr/bin/env node
// Adapter-route fixture: a fake codex CLI for the native adapter bench and unit
// tests (handoff P1). Scripted per-turn output selected by markers in the prompt:
//   FLOW        text → thinking → command ×2 → final text + usage
//   ASK_FLOW    thinking → command approval ask → (accept: command + text / decline: interrupted)
//   HANG        command → hang CODEX_FIXTURE_HANG_MS → command → final text
//   RESUME      answers with the thread id it resumed on
// Approval replies, thread ops and interrupts are logged to codex-requests.jsonl
// in the process cwd for bench assertions. No model, network or auth.
const { createInterface } = require('node:readline')
const { Duplex } = require('node:stream')
const { createServer } = require('node:http')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('codex-adapter fixture'); process.exit(0) }
if (process.argv.includes('daemon')) process.exit(0)
let connection
const send = message => connection ? connection.send(JSON.stringify(message)) : process.stdout.write(JSON.stringify(message) + '\n')
const HANG_MS = Number(process.env.CODEX_FIXTURE_HANG_MS) || 60000
let initialized = false
let ready = false
let thread = 'fixture-thread'
let turn = null
let next = 0
let approval = null
let question = null
const timers = new Set()
const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer }
const note = (method, params) => send({ method, params: { threadId: thread, ...params } })
const log = entry => { try { appendFileSync(join(process.cwd(), 'codex-requests.jsonl'), JSON.stringify(entry) + '\n') } catch {} }
const done = (status = 'completed') => {
  if (!turn) return
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  note('turn/completed', { turn: { id: turn, status } })
  turn = null
}
const reportUsage = () => {
  const last = { inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 45, totalTokens: 1245 }
  note('thread/tokenUsage/updated', { turnId: turn, tokenUsage: { last, total: last, modelContextWindow: 258400 } })
}
const say = (text, id) => {
  note('item/agentMessage/delta', { itemId: id, turnId: turn, delta: text.slice(0, 4) })
  note('item/agentMessage/delta', { itemId: id, turnId: turn, delta: text.slice(4) })
  note('item/completed', { turnId: turn, item: { id, type: 'agentMessage', text } })
}
const think = text => note('item/completed', { turnId: turn, item: { id: 'reason-' + turn, type: 'reasoning', text } })
const command = (command_, name) => {
  note('item/started', { turnId: turn, item: { id: name, type: 'commandExecution', command: command_, status: 'inProgress' } })
  note('item/completed', { turnId: turn, item: { id: name, type: 'commandExecution', command: command_, status: 'completed' } })
}
const finish = text => { say(text, 'message-' + turn); reportUsage(); done() }
const begin = params => {
  turn = 'turn-' + ++next
  send({ id: params.id, result: { turn: { id: turn, status: 'inProgress' } } })
  note('turn/started', { turn: { id: turn, status: 'inProgress' } })
}
const receive = line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') { initialized = true; send({ id, result: { userAgent: 'codex-adapter-fixture' } }); return }
  if (method === 'initialized') { ready = initialized; return }
  if (!ready) { send({ id, error: { message: 'initialize first' } }); return }
  if (!method && question !== null && message.id === question) {
    question = null
    log({ method: 'question-reply', answers: message.result?.answers })
    later(10, () => finish('QUESTION done'))
    return
  }
  if (!method && approval !== null && message.id === approval) {
    approval = null
    log({ method: 'approval-reply', decision: message.result?.decision })
    if (message.result?.decision === 'accept') {
      note('item/completed', { turnId: turn, item: { id: 'cmd-ask', type: 'commandExecution', command: 'echo fixture-ask', status: 'completed' } })
      later(30, () => finish('ASK done'))
    }
    else done('interrupted')
    return
  }
  if (method === 'account/read') { send({ id, result: { account: { type: 'chatgpt', requiresOpenaiAuth: true } } }); return }
  if (method === 'model/list') {
    send({ id, result: { data: [
      { id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', hidden: false, isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
    ], nextCursor: null } }); return
  }
  if (method === 'project/list') { send({ id, result: { data: [] } }); return }
  if (method === 'project/create') { send({ id, result: { project: { id: 'fixture-project' } } }); return }
  if (['thread/metadata/update', 'thread/name/set'].includes(method)) { send({ id, result: {} }); return }
  if (method === 'thread/start' || method === 'thread/resume') {
    log({ method, threadId: params.threadId ?? null, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, identity: params.developerInstructions })
    if (!params.cwd) { send({ id, error: { message: 'cwd missing' } }); return }
    thread = params.threadId ?? 'fixture-thread'
    send({ id, result: { thread: { id: thread } } }); return
  }
  if (method === 'turn/start') {
    log({ method, input: params.input })
    const text = params.input.filter(item => item.type === 'text').map(item => item.text).join('')
    begin({ id })
    if (text.includes('QUESTION')) {
      later(10, () => {
        question = 3000 + next
        send({ id: question, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, questions: [
          { id: 'color', header: 'Color', question: 'Choose a color', options: [{ label: 'Blue', description: 'Cool' }, { label: 'Red', description: 'Warm' }] },
          { id: 'name', header: 'Name', question: 'Choose a name' },
        ] } })
      })
    } else if (text.includes('STREAM_HANG')) {
      later(10, () => say('Waiting for cancellation', 'stream-hang'))
    } else if (text.includes('TOOL_HANG')) {
      later(10, () => note('item/started', { turnId: turn, item: { id: 'hanging-tool', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' } }))
    } else if (text.includes('ASK_FLOW')) {
      later(10, () => {
        think('Asking before touching the workspace')
        note('item/started', { turnId: turn, item: { id: 'cmd-ask', type: 'commandExecution', command: 'echo fixture-ask', status: 'inProgress' } })
        approval = 2000 + next
        send({ id: approval, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, itemId: 'cmd-ask', command: 'echo fixture-ask', availableDecisions: ['accept', 'decline'] } })
      })
    } else if (text.includes('HANG')) {
      later(10, () => {
        command('echo before-hang', 'cmd-hang-a')
        later(HANG_MS, () => {
          command('echo after-hang', 'cmd-hang-b')
          later(10, () => finish('HANG done'))
        })
      })
    } else if (text.includes('RESUME')) {
      later(10, () => finish(`Resumed on thread ${thread}`))
    } else if (text.includes('FLOW')) {
      later(10, () => {
        say('FLOW part one', 'msg-early-' + turn)
        think('Fixture reasoning about ' + text.trim().slice(0, 20))
        command('echo one', 'cmd-one')
        command('echo two', 'cmd-two')
        later(10, () => finish('FLOW done'))
      })
    } else {
      later(10, () => finish('Adapter fixture: ' + text.split('\n')[0].slice(0, 40)))
    }
    return
  }
  if (method === 'thread/compact/start') {
    log({ method })
    turn = 'compact-' + ++next
    send({ id, result: {} })
    note('turn/started', { turn: { id: turn, status: 'inProgress' } })
    later(150, () => { log({ method: 'compact-completed' }); done() })
    return
  }
  if (method === 'turn/interrupt') { log({ method }); send({ id, result: {} }); done('interrupted'); return }
  send({ id, error: { message: 'unknown method' } })
}

const loadWs = () => {
  for (const anchor of [join(__dirname, 'package.json'), join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/package.json'), join(process.cwd(), 'package.json')]) {
    try { return createRequire(anchor)('ws') } catch {}
  }
  throw new Error('codex-adapter fixture requires the ws library; seed node_modules/ws next to the fixture')
}

if (process.argv.includes('proxy')) {
  const WebSocket = loadWs()
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
