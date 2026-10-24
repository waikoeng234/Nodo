import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { findDshExecutable } from '../agent-drivers/dist/dsh/config.js'

const executable = findDshExecutable()
assert.ok(executable, 'Install DSH before running the native check')
const runtime = createRequire(realpathSync(executable))
const WebSocket = runtime('ws')
const { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-api-gateway/stream-protocol')))
const home = mkdtempSync(join(tmpdir(), 'orch-dsh-native-'))
const requests = []
const changesProbe = process.argv.includes('--native-changes')
let changesSent = false
const controlsProbe = process.argv.includes('--native-controls')
const panelProbe = process.argv.includes('--native-panel')
const modeProbe = process.argv.includes('--native-mode')
const modelProbe = process.argv.includes('--model-slot')
const uiProbe = process.argv.includes('--native-ui') || panelProbe || modeProbe || modelProbe
  ? (await import('./native-ui-probe.mjs')).createNativeUiProbe({ panel: panelProbe, mode: modeProbe, model: modelProbe })
  : null
const observers = new Set()
let loginUrl
const mock = createServer(async (request, response) => {
  if (request.url === '/bench/login') { response.writeHead(302, { Location: loginUrl }); response.end(); return }
  if (uiProbe?.handle(request, response, requests)) return
  if (request.url.endsWith('/files')) {
    const upload = new Request(`http://127.0.0.1${request.url}`, { method: 'POST', headers: request.headers, body: request, duplex: 'half' })
    const file = (await upload.formData()).get('file')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: 'fixture-image-upload', type: 'file', mime_type: file.type, size_bytes: file.size, filename: file.name, created_at: new Date().toISOString() }))
    return
  }
  // DSH < 0.2 posts to /chat/completions; DSH >= 0.2 posts to <baseURL>/v1/messages.
  const openai = request.url.endsWith('/chat/completions')
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (!openai) {
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    event('message_start', { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (changesProbe && !changesSent && body.tools?.some(tool => tool.name === 'write')) {
      changesSent = true
      for (let index = 0; index < 10; index++) {
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `native-write-${index}`, name: 'write', input: {} } })
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(home, 'workspace', `file-${index}.txt`), content: 'native confirmed' }) } })
        event('content_block_stop', { type: 'content_block_stop', index })
      }
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } })
      event('message_stop', { type: 'message_stop' }); response.end(); return
    }
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Native DSH reply' } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
    event('message_stop', { type: 'message_stop' })
    response.end()
    return
  }
  const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model }
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Native DSH reply' }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`)
  response.end('data: [DONE]\n\n')
})
mock.listen(0, '127.0.0.1')
await once(mock, 'listening')
const reservation = createPortServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const patch = join(home, 'native-test.patch.json')
writeFileSync(patch, JSON.stringify([
  { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${mock.address().port}`, apiKeyEnv: 'ORCH_DSH_MOCK_KEY' } },
  { id: 'session-title-llm', disabled: true },
  ...(uiProbe?.patch ?? []),
  { insert: [{ id: 'nodo', name: fileURLToPath(new URL('../index.js', import.meta.url)), config: { home: join(home, 'nodo') } }] },
]))
let child
let log = ''
const start = () => {
  log = ''
  child = spawn(executable, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, ORCH_DSH_MOCK_KEY: 'local-test-only', ...(uiProbe ? { ZDOTDIR: uiProbe.workspace, HISTFILE: join(uiProbe.workspace, '.history') } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { log = `${log}${chunk}`.slice(-16000) })
  child.stderr.on('data', chunk => { log = `${log}${chunk}`.slice(-16000) })
}
const stop = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
}
start()
const url = `http://127.0.0.1:${port}`
const until = async check => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    if (child.exitCode !== null) throw new Error(`DSH host exited (${child.exitCode})`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Native DSH integration timed out')
}
try {
  let cookie
  const authorize = async () => {
    const token = await until(async () => log.match(/\?token=([^\s]+)/)?.[1])
    const page = await fetch(`${url}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    cookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    loginUrl = `${url}/?token=${encodeURIComponent(token)}`
  }
  await authorize()
  const nativeCall = async (method, args) => {
    const response = await fetch(`${url}/api/${method}`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'native-check', method, payload: { args } }) })
    const { result } = await response.json()
    assert.equal(result?.ok, true, `Native ${method} failed (${result?.error?.code ?? response.status})`)
    return result.value
  }
  const observe = async sessionId => {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}${REMOTE_STREAM_MUX_PATH}`, { headers: { Origin: url, Cookie: cookie } })
    observers.add(socket)
    const frames = []
    let failure
    socket.on('error', () => { failure = new Error('Native observer connection failed') })
    socket.on('message', data => {
      try {
        const frame = parseRemoteStreamServerMessage(data.toString())
        if (frame.type === 'error') failure = new Error(`Native observer failed (${frame.error.code})`)
        if (frame.type === 'item') frames.push(frame.value)
      } catch { failure = new Error('Native observer received an invalid frame') }
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId: 'observer', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } }))
    await until(() => { if (failure) throw failure; return frames.some(frame => frame?.type === 'snapshot') })
    return { frames, close() { socket.terminate(); observers.delete(socket) } }
  }
  const api = async (endpoint, payload) => {
    const response = await fetch(`${url}/api/nodo`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie }, body: JSON.stringify({ endpoint, payload }) })
      .catch(error => { throw new Error(`Nodo ${endpoint} request failed (${error.name})`) })
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const assertNativeWork = async (opened, status) => {
    const work = await until(async () => {
      const work = (await api('state')).work[opened.conversationId]
      return work?.status === status && work.active === ['running', 'waiting-approval', 'waiting-question'].includes(status) && work
    })
    assert.equal(work.source, 'native')
    return work
  }
  if (changesProbe) {
    await (await import('./native-changes-probe.mjs')).checkNativeChanges({ api, until, home, requests })
  } else if (process.argv.includes('--native-attachments')) {
    await (await import('./native-attachment-probe.mjs')).checkAttachmentEngine({ engine: process.argv[process.argv.indexOf('--native-attachments') + 1], api, nativeCall, observe, until, home, runtime, url, cookie, requests })
  } else {
  const catalog = await api('engine-catalog')
  if (uiProbe) {
    console.log(`Native DSH visible in engine catalog: ${catalog.some(item => item.id === 'dsh')}`)
    const nativeCheck = await api('engine-check', { engine: 'dsh' })
    assert.equal(nativeCheck.ok, true)
    assert.ok(nativeCheck.checks.some(check => check.label === 'Native runtime' && check.ok))
  } else assert.equal(catalog.find(item => item.id === 'dsh').label, 'DeepSeek Harness (native)')
  const workspace = await api('workspace-create', { name: 'Native', cwd: uiProbe?.workspace ?? join(home, 'workspace') })
  const profile = await api('profile-create', { name: 'Native integration', engine: 'dsh', workspace: workspace.id, instructions: 'Keep the same conversation' })
  const send = async (session, text) => {
    await api('send', { profile: profile.id, session, text })
    await until(async () => !(await api('state')).work[session].active)
    const transcript = await api('transcript', { profile: profile.id, session })
    assert.ok(!transcript.some(line => line.kind === 'error'), JSON.stringify(transcript.filter(line => line.kind === 'error')))
    assert.ok(transcript.some(line => line.text === 'Native DSH reply'))
  }
  await send(profile.id, 'FIRST')
  const currentProfile = async () => (await api('state')).profiles.find(item => item.id === profile.id)
  const firstId = (await currentProfile()).sessions[0].driverSessionId
  assert.ok((await nativeCall('session/list', { _request: {} })).items.some(item => item.sessionId === firstId), 'the native session list must contain the plugin session')
  const observer = await observe(firstId)
  await send(profile.id, 'SECOND')
  await until(() => observer.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
  assert.ok(observer.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/start'))
  assert.ok(observer.frames.some(frame => frame?.type === 'event' && frame.event.type === 'assistant/message'))
  observer.close()
  console.log('Native session list and independent live observer during the second turn passed')
  let state = await currentProfile()
  const first = state.sessions[0]
  assert.ok(first.workspaceId)
  assert.ok(first.driverSessionId)
  assert.ok(requests[1].messages.some(message => message.role === 'assistant'))
  const second = await api('session-create', { profile: profile.id })
  await send(second.id, 'THIRD')
  state = await currentProfile()
  const secondId = state.sessions[1].driverSessionId
  assert.equal(state.sessions[1].workspaceId, first.workspaceId)
  assert.notEqual(secondId, first.driverSessionId)
  await api('session-select', { profile: profile.id, session: first.id })
  await send(first.id, 'FOURTH')
  assert.equal((await currentProfile()).sessions[0].driverSessionId, first.driverSessionId)
  console.log('Real DSH host: native workspace, two sessions, multi-turn continuity and switching passed (local mock provider)')
  await stop()
  start()
  await authorize()
  const restoredObserver = await observe(first.driverSessionId)
  await send(first.id, 'AFTER_RESTART')
  await until(() => restoredObserver.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
  state = await currentProfile()
  assert.equal(state.sessions[0].driverSessionId, first.driverSessionId)
  assert.equal(state.sessions[0].workspaceId, first.workspaceId)
  assert.equal(state.sessions[1].driverSessionId, secondId)
  assert.ok(requests.at(-1).messages.filter(message => message.role === 'assistant').length >= 3)
  restoredObserver.close()
  console.log('Real DSH host restart: same native session, workspace and observer continuity passed')
  const nativeSession = { sessionId: firstId, conversationId: first.id }
  const nativeStats = (await api('state')).stats[first.id]
  const nativeTranscript = await api('transcript', { profile: profile.id, session: first.id })
  const nativeObserver = await observe(firstId)
  await nativeCall('session/prompt', { request: { requestId: 'native-status-direct', sessionId: firstId, mode: 'queue', content: [{ type: 'text', text: 'NATIVE_STATUS_DIRECT' }] } })
  await until(() => nativeObserver.frames.some(frame => frame?.event?.type === 'turn/end'))
  await assertNativeWork(nativeSession, 'completed')
  assert.deepEqual((await api('state')).stats[first.id], nativeStats, 'native observation must not count a second copy of usage')
  assert.deepEqual(await api('transcript', { profile: profile.id, session: first.id }), nativeTranscript, 'native observation must not copy host messages')
  nativeObserver.close()
  console.log('Native DSH direct send: Nodo work status follows the host without duplicating messages or usage')
  if (controlsProbe) {
    const capabilities = catalog.find(item => item.id === 'dsh').capabilities
    assert.deepEqual(capabilities.permissionModes, ['plan', 'workspace', 'full'])
    assert.equal(capabilities.compact, true)
    const controls = await observe(first.driverSessionId)
    const events = () => controls.frames.filter(frame => frame?.type === 'event').map(frame => frame.event)
    for (const [permission, sandbox, approval] of [
      ['full', 'danger-full-access', 'never'], ['plan', 'read-only', 'ask'], ['workspace', 'workspace-write', 'ask'],
    ]) {
      const mark = events().length
      await api('profile-update', { id: profile.id, changes: { permission } })
      await send(first.id, `PERMISSION_${permission}`)
      await until(() => events().slice(mark).some(event => event.type === 'turn/end'))
      assert.ok(events().slice(mark).some(event => event.type === 'sandbox/mode' && event.data.mode === sandbox), `${permission} did not update the native sandbox`)
      if (permission !== 'workspace') assert.ok(events().slice(mark).some(event => event.type === 'approval/policy' && event.data.policy === approval), `${permission} did not update native approval`)
    }
    console.log('Native permissions: full, plan and workspace changed the owning session sandbox and approval policy')
    await send(first.id, 'COMPACT_HISTORY\n' + 'Retain task evidence and role identity. '.repeat(400))
    const beforeCompact = events().length
    await api('session-compact', { profile: profile.id, session: first.id })
    await until(() => events().slice(beforeCompact).some(event => event.type === 'compaction/end'))
    const compacted = events().slice(beforeCompact)
    assert.ok(compacted.some(event => event.type === 'compaction/summary'), 'native compaction must commit a summary')
    assert.ok(!compacted.some(event => event.type === 'compaction/error'), 'native compaction must not report a failed attempt')
    await send(first.id, 'AFTER_NATIVE_COMPACT')
    const request = requests.at(-1)
    const payload = JSON.stringify(request)
    assert.ok(payload.includes('compacted-summary'), 'the next native request must use the compacted context')
    assert.ok(payload.includes('Keep the same conversation'), 'compaction must retain the role identity')
    controls.close()
    console.log('Native compact: host summary committed and the next turn retained identity and compacted context')
    await stop()
    start()
    await authorize()
    const coldControls = await observe(first.driverSessionId)
    await api('session-compact', { profile: profile.id, session: first.id })
    await until(() => coldControls.frames.some(frame => frame?.type === 'event' && frame.event.type === 'compaction/summary'))
    await send(first.id, 'AFTER_COLD_NATIVE_COMPACT')
    assert.ok(JSON.stringify(requests.at(-1)).includes('Keep the same conversation'))
    assert.equal((await currentProfile()).sessions[0].driverSessionId, first.driverSessionId)
    coldControls.close()
    console.log('Native compact after restart: restored the requested session and role before compaction, without a warm-up turn')
  }
  if (process.argv.includes('--reference-check')) {
    const sourceSession = (await currentProfile()).sessions.find(session => session.driverSessionId)
    const replies = await api('reference-replies', { profile: profile.id, session: sourceSession.id })
    assert.ok(replies.messages.length > 0)
    const targetRole = await api('profile-create', { name: 'Reference receiver', engine: 'dsh', instructions: 'REFERENCE_RECEIVER_IDENTITY' })
    const target = await api('session-open', { profile: targetRole.id, workspace: workspace.id })
    const snapshot = await api('reference-create', { target: target.sessionId, profile: profile.id, session: sourceSession.id, messageId: replies.messages.at(-1).id })
    const observer = await observe(target.sessionId)
    const events = () => observer.frames.filter(frame => frame?.type === 'event').map(frame => frame.event)
    const prompt = `REFERENCE_INTEGRATION_TASK\n[引用会话](nodo-reference:${snapshot.id})`
    await nativeCall('session/prompt', { request: { requestId: 'reference-check', sessionId: target.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] } })
    await until(() => events().some(event => event.type === 'turn/end'))
    const direct = events().find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.ok(direct)
    assert.equal(direct.data.content[0].text, 'REFERENCE_INTEGRATION_TASK')
    const injected = events().find(event => event.type === 'user/message' && event.data.source.kind === 'session-reference')
    assert.ok(injected, 'reference context must persist in native history')
    assert.ok(JSON.stringify(injected.data.content).includes(snapshot.messages[0].text))
    const modelRequest = requests.find(body => JSON.stringify(body.messages).includes('REFERENCE_INTEGRATION_TASK'))
    assert.ok(modelRequest && JSON.stringify(modelRequest.messages).includes(snapshot.id), 'the model must receive the selected snapshot')
    assert.equal((await api('reference-history', { target: target.sessionId, seq: direct.seq }))[0].id, snapshot.id)
    await stop(); start(); await authorize()
    assert.equal((await api('reference-history', { target: target.sessionId, seq: direct.seq }))[0].id, snapshot.id, 'cold history must retain the sent snapshot')
    console.log('Native session references: selected reply, model context, durable history and cold restart passed')
  }
  if (process.argv.includes('--preview') || uiProbe) {
    if (uiProbe) {
      const reviewer = await api('profile-create', { name: 'Native reviewer', engine: 'dsh', instructions: 'NATIVE_REVIEWER_IDENTITY: inspect independently' })
      await api('session-create', { profile: reviewer.id, workspace: workspace.id })
    }
    if (panelProbe || modeProbe) {
      const ordinaryWorkspace = modeProbe
        ? (await nativeCall('workspace/create', { request: { path: uiProbe.ordinaryWorkspace } })).workspace.workspaceId
        : first.workspaceId
      assert.ok(ordinaryWorkspace, 'ordinary session needs an explicit workspace')
      const ordinary = await nativeCall('session/create', { request: { workspaceId: ordinaryWorkspace } })
      await nativeCall('session/rename', { request: { sessionId: ordinary.sessionId, title: 'Native plain baseline' } })
      await nativeCall('session/prompt', { request: { requestId: 'native-panel-baseline', sessionId: ordinary.sessionId, mode: 'queue', content: [{ type: 'text', text: 'PLAIN_NATIVE_ONLY' }] } })
      await until(() => requests.some(body => JSON.stringify(body.messages).includes('PLAIN_NATIVE_ONLY')))
    }
    writeFileSync('/private/tmp/orch-native-dsh-ui.json', JSON.stringify({ url: `http://127.0.0.1:${mock.address().port}/bench/login`, profileId: profile.id }), { mode: 0o600 })
    console.log('Native UI bench ready; send input to stop')
    await new Promise(resolve => process.stdin.once('data', resolve))
    if (modeProbe) uiProbe.verifyMode(requests)
    else if (panelProbe) uiProbe.verifyPanel(requests)
    else if (modelProbe) console.log('Model seat bench ready evidence is read from the browser (window.__NODO_MODEL_PROBE)')
    else if (!process.argv.includes('--cold-only')) uiProbe?.verify(requests)
    if (uiProbe && !panelProbe && !modeProbe && !modelProbe) {
      await stop()
      start()
      await authorize()
      console.log('Cold native UI bench ready; reopen the role and send NATIVE_UI_COLD, then send input to finish')
      await new Promise(resolve => process.stdin.once('data', resolve))
      uiProbe.verifyCold(requests)
    }
  }
  }
} finally {
  for (const socket of observers) socket.terminate()
  await stop()
  mock.closeAllConnections()
  await new Promise(resolve => mock.close(resolve))
  if (!process.env.ORCH_KEEP_HOME) rmSync(home, { recursive: true, force: true })
  uiProbe?.dispose()
  process.stdin.pause()
  if (process.argv.includes('--preview') || uiProbe) rmSync('/private/tmp/orch-native-dsh-ui.json', { force: true })
}
