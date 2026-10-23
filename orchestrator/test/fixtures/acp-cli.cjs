#!/usr/bin/env node
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const reply = (id, result) => send({ id, result })
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
let session = 'acp-session'
let prompt
const finish = (stopReason, usage) => { if (prompt !== undefined) { reply(prompt, { stopReason, ...(usage ? { usage } : {}) }); prompt = undefined } }
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  appendFileSync('acp-wire.jsonl', JSON.stringify(message) + '\n')
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    const result = { protocolVersion: process.env.ACP_BAD_VERSION ? 2 : 1,
      agentCapabilities: { ...(process.env.ACP_NO_RESUME ? {} : process.env.ACP_RESUME ? { sessionCapabilities: { resume: {} } } : { loadSession: true }), promptCapabilities: { image: process.env.ACP_IMAGES === '1' } } }
    if (process.env.ACP_SLOW_BOOT) setTimeout(() => reply(id, result), 300)
    else reply(id, result)
  } else if (['session/new', 'session/load', 'session/resume'].includes(method)) {
    session = params.sessionId ?? session
    update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } })
    reply(id, method === 'session/new' ? { sessionId: session } : process.env.ACP_WRONG_SESSION ? { sessionId: 'wrong' } : {})
  } else if (method === 'session/prompt') {
    prompt = id
    const text = params.prompt.find(block => block.type === 'text')?.text ?? ''
    if (text === 'HANG') return
    if (text === 'EXIT') return process.exit(10)
    if (text === 'READ_OUTPUT') {
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read', status: 'pending', rawInput: {} })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'in_progress', rawInput: { path: '/tmp/fixture' } })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { metadata: { truncated: false } }, content: [{ type: 'content', content: { type: 'text', text: 'actual file contents' } }] })
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'failed', title: 'read', status: 'pending', rawInput: {} })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'failed', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Error: tool call aborted' } }], rawOutput: {} })
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'raw', title: 'raw', status: 'pending' })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'raw', content: [{ type: 'content', content: { type: 'text', text: 'replaced' } }] })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'raw', status: 'completed', content: [], rawOutput: { result: 'raw only' } })
      return finish('end_turn')
    }
    if (text === 'UNBOUNDED') {
      update(session, { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'Progress' } })
      update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Final' } })
      return finish('end_turn')
    }
    if (text.startsWith('STOP')) return finish(text === 'STOP' ? undefined : text.slice(5))
    if (text.startsWith('NOISE')) {
      const [count, sentinel] = text.slice(6).split(' ')
      for (let i = 0; i < Number(count); i++) send({ method: 'future/broadcast', params: { marker: i, secret: sentinel } })
      update(session, { sessionUpdate: 'hologram_display', payload: { secret: sentinel } })
      return finish('end_turn')
    }
    if (text.startsWith('PERMISSION')) {
      const options = [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }]
      send({ id: 7, method: 'session/request_permission', params: { sessionId: 'other', options } })
      for (const requestId of [7, '7']) send({ id: requestId, method: 'session/request_permission', params: { sessionId: session, options } })
      return
    }
    if (text === 'QUESTION') {
      send({ id: 9, method: 'elicitation/create', params: { sessionId: session, mode: 'form', requestedSchema: { properties: { name: { type: 'string', title: 'Name?' } } } } })
      return
    }
    if (text === 'BAD_FIELDS') {
      update(session, { sessionUpdate: 'session_info_update', _meta: 'not an object' })
      send({ method: 'session/update', params: null })
      send({ id: 11, method: 'session/request_permission', params: null })
      update(session, { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'still here' } })
      return finish('end_turn')
    }
    if (text === 'ORPHAN') {
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref()
      return setTimeout(() => process.exit(3), 50)
    }
    if (text === 'MEDIA_OPAQUE_OUTPUT') {
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'opaque', title: 'Media', status: 'pending' })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'opaque', status: 'completed',
        content: [{ type: 'resource_link', uri: 'file:///fixture.png', mimeType: 'image/png' }], rawOutput: { stdout: 'opaque companion text' } })
      return finish('end_turn')
    }
    if (text === 'RETRY_OBJECT') {
      for (const error of [{ code: 'BUSY' }, { message: 'wait for server' }, 'rate limited']) {
        update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { error } } })
      }
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } })
      return finish('end_turn')
    }
    if (text === 'PLAN') {
      update(session, { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }, { content: 'step two', priority: 'high', status: 'in_progress' }] })
      update(session, { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }, { content: 'step two edited', priority: 'high', status: 'in_progress' }] })
      update(session, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' })
      update(session, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: 'compaction boom' })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 2, nextRetryAt: 'later', error: 'rate limited' } } })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } })
      update(session, { sessionUpdate: 'plan_removed', planId: 'p1' })
      return finish('end_turn')
    }
    if (text === 'CHILD') {
      const child = { id: 'child-1', parentID: session, depth: 1, title: 'Researcher' }
      update(session, { sessionUpdate: 'agent_message_chunk', _meta: { 'opencode/child-session': child }, content: { type: 'text', text: 'child says' } })
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'ct', title: 'ChildTool', _meta: { 'opencode/child-session': child }, status: 'in_progress' })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'ct', _meta: { 'opencode/child-session': child }, status: 'failed' })
      update(session, { sessionUpdate: 'agent_message_chunk', messageId: 'main', content: { type: 'text', text: 'main' } })
      return finish('end_turn')
    }
    if (text === 'COMPACT') {
      update(session, { sessionUpdate: 'compaction_update', compactionId: 'c9', status: 'in_progress' })
      update(session, { sessionUpdate: 'compaction_update', compactionId: 'c9', status: 'cancelled' })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'started', reason: 'auto' } } })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'completed' } } })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'failed', error: { type: 'aborted', message: 'Compaction cancelled' } } } })
      update(session, { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'failed', error: { type: 'compaction.failed', message: 'disk full' } } } })
      return finish('end_turn')
    }
    if (text === 'MEDIA') {
      update(session, { sessionUpdate: 'tool_call', toolCallId: 'media', title: 'Open image', status: 'pending', rawInput: { path: '/tmp/shot.png' } })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'media', status: 'in_progress', rawOutput: { text: 'MEDIA_RAW_OUTPUT' },
        content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'content', content: { type: 'resource_link', name: 'shot.png', uri: 'file:///tmp/shot.png', mimeType: 'image/png' } }] })
      update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'media', status: 'completed', rawOutput: { text: 'MEDIA_RAW_OUTPUT_DONE' } })
      return finish('end_turn')
    }
    update('other', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'other session' } })
    update(session, { sessionUpdate: 'agent_message_chunk', _meta: { isReplay: true }, content: { type: 'text', text: 'replay' } })
    update(session, { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text } })
    update(session, { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'tail' } })
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'pending', rawInput: { path: '/tmp/fixture' } })
    update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', title: 'Changed title', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] })
    for (let i = 0; i < 2; i++) update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' })
    finish('end_turn', { inputTokens: 1245, outputTokens: 45, cachedReadTokens: 900, cachedWriteTokens: 30 })
  } else if (method === 'session/cancel') {
    if (!process.env.ACP_IGNORE_CANCEL) finish('cancelled')
  } else if (!method && id === 9) finish('end_turn')
  else if (!method && id === '7') finish('end_turn')
}).on('close', () => process.exit(0))
