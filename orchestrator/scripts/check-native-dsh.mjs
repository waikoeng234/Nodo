import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
// The codex driver and its fixture bridge the CLI over ws, resolved from the
// profile directory; a fresh DSH_HOME bootstraps none, so seed it from the
// runtime the host itself runs on.
try {
  const wsRoot = join(realpathSync(runtime.resolve('ws')), '..')
  mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  symlinkSync(wsRoot, join(home, 'profiles', 'node_modules', 'ws'), 'dir')
} catch { /* an engine needing ws reports the missing library itself */ }
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
const adapterProbe = process.argv.includes('--native-adapter')
  ? (await import('./native-adapter-probe.mjs')).createNativeAdapterProbe()
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
  ...(adapterProbe?.patch ?? []),
  { insert: [{ id: 'nodo', name: fileURLToPath(new URL('../index.js', import.meta.url)), config: { home: join(home, 'nodo') } }] },
]))
let child
let log = ''
const start = () => {
  log = ''
  child = spawn(executable, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, ORCH_DSH_MOCK_KEY: 'local-test-only', ...(process.env.ADAPTER_TIMEOUT_MS ? { ADAPTER_TIMEOUT_MS: process.env.ADAPTER_TIMEOUT_MS } : {}), ...(process.argv.includes('--adapter-long') ? { CODEX_FIXTURE_HANG_MS: '120000' } : {}), ...(uiProbe ? { ZDOTDIR: uiProbe.workspace, HISTFILE: join(uiProbe.workspace, '.history') } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
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
  } else if (process.argv.includes('--native-steering')) {
    await (await import('./native-steering-probe.mjs')).checkNativeSteering({ api, nativeCall, observe, until, home })
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
  if (adapterProbe) {
    const install = adapterProbe.readLog().find(entry => entry.kind === 'install')
    assert.ok(install, 'the adapter probe plugin never applied (no install log)')
    console.log(`Adapter probe service reachability: ${JSON.stringify(install.reach)}`)
    assert.equal(install.reach.llm, true, 'ctx.llm is not reachable from a third-party plugin')
    assert.ok(adapterProbe.readLog().some(entry => entry.kind === 'registered'), 'ctx.llm.registerAdapter did not complete')
    const before = requests.length
    const catalog = await nativeCall('session/modelCatalog', {})
    const group = catalog.groups.find(item => item.id === 'echo-probe')
    assert.ok(group?.models.some(model => model.id === 'echo-model'), `echo-probe missing from the native model catalog: ${JSON.stringify(catalog.groups.map(item => item.id))}`)
    mkdirSync(join(home, 'adapter-workspace'), { recursive: true })
    const adapterWorkspace = (await nativeCall('workspace/create', { request: { path: join(home, 'adapter-workspace') } })).workspace.workspaceId
    const adapterSession = await nativeCall('session/create', { request: { workspaceId: adapterWorkspace } })
    const selected = await nativeCall('session/selectModel', { request: { sessionId: adapterSession.sessionId, provider: 'echo-probe', model: 'echo-model' } })
    assert.equal(selected.selected.provider, 'echo-probe')
    const observer = await observe(adapterSession.sessionId)
    await nativeCall('session/prompt', { request: { requestId: 'adapter-echo-1', sessionId: adapterSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'ECHO_ONE' }] } })
    await until(() => observer.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
    assert.equal(requests.length, before, 'the mock host model must not receive adapter-session traffic')
    const message = observer.frames.find(frame => frame?.type === 'event' && frame.event.type === 'assistant/message')
    if (!message) console.log(`FRAMES_DEBUG: ${JSON.stringify(observer.frames.map(frame => frame?.type === 'event' ? frame.event.type : frame?.type))}`)
    const reply = JSON.stringify(message?.event.data?.message?.content) ?? ''
    assert.ok(reply.includes('ECHO:'), 'the echo reply did not reach the native assistant message')
    assert.equal(observer.frames.find(frame => frame?.type === 'event' && frame.event.type === 'turn/end').event.data.reason.kind, 'completed')
    const echoStart = adapterProbe.readLog().find(entry => entry.kind === 'stream-start' && entry.marker === 'echo')
    assert.ok(echoStart, 'the adapter stream was never invoked')
    assert.ok(echoStart.userMessages.some(text => text.includes('ECHO_ONE')), 'the user prompt never reached the adapter request')
    assert.equal(echoStart.purpose, null, 'the agent-loop request must not carry an auxiliary purpose')
    console.log(`Echo adapter turn: native send, stream chunks and usage (${JSON.stringify(message.event.data.usage ?? null)}) passed with the mock host model untouched`)
    const cancelMark = observer.frames.length
    await nativeCall('session/prompt', { request: { requestId: 'adapter-echo-2', sessionId: adapterSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'ECHO_HANG_ABORT' }] } })
    await until(() => adapterProbe.readLog().some(entry => entry.kind === 'stream-start' && entry.marker === 'abort'))
    await nativeCall('session/cancel', { request: { sessionId: adapterSession.sessionId } })
    await until(() => observer.frames.slice(cancelMark).some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
    const cancelEnd = observer.frames.slice(cancelMark).find(frame => frame?.type === 'event' && frame.event.type === 'turn/end')
    assert.equal(cancelEnd.event.data.reason.kind, 'aborted', `a cancelled adapter turn must end aborted, got ${JSON.stringify(cancelEnd.event.data.reason)}`)
    assert.equal(requests.length, before, 'the mock host model must stay untouched across cancellation')
    assert.ok(adapterProbe.readLog().some(entry => entry.kind === 'stream-end' && entry.marker === 'abort' && entry.outcome === 'aborted'), 'the adapter stream never observed the abort')
    console.log('Echo adapter cancellation: native cancel ends the hung stream as aborted on both sides')
    if (process.argv.includes('--adapter-timeout')) {
      const timeoutMark = observer.frames.length
      const began = Date.now()
      await nativeCall('session/prompt', { request: { requestId: 'adapter-echo-3', sessionId: adapterSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'ECHO_HANG_TIMEOUT' }] } })
      let timeoutEnd
      const deadline = Date.now() + 300000
      while (Date.now() < deadline) {
        timeoutEnd = observer.frames.slice(timeoutMark).find(frame => frame?.type === 'event' && frame.event.type === 'turn/end')
        if (timeoutEnd || child.exitCode !== null) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const elapsed = Math.round((Date.now() - began) / 1000)
      console.log(`TIMEOUT_FRAMES: ${JSON.stringify(observer.frames.slice(timeoutMark).map(frame => frame?.type === 'event' ? `${frame.event.type}@${Math.round((frame.event.time - began) / 1000)}s` : frame?.type))} STREAMS: ${JSON.stringify(adapterProbe.readLog().filter(entry => entry.kind.startsWith('stream')).map(entry => `${entry.kind}:${entry.marker}:${entry.outcome ?? entry.purpose}@call${entry.call}`))}`)
      console.log(timeoutEnd
        ? `Timeout probe: hung stream survived ${elapsed}s total and ended with ${JSON.stringify(timeoutEnd.event.data.reason)}`
        : `Timeout probe: no turn end within 300s for a ${Math.round((Number(process.env.ADAPTER_TIMEOUT_MS) || 180000) / 1000)}s hung stream (elapsed ${elapsed}s)`)
      assert.ok(adapterProbe.readLog().some(entry => entry.kind === 'stream-end' && entry.marker === 'timeout'), 'the timeout-probe stream never closed')
    }
    observer.close()
    console.log('P0 RESULT: GO — echo adapter registration, routing, streaming and cancellation all passed')
    // ---- P1: codex adapter route over the fixture CLI (.agent/context/native-adapter-handoff.md §4 P1) ----
    const fixtureDir = mkdtempSync(join(tmpdir(), 'orch-codex-adapter-'))
    const fixtureBin = join(fixtureDir, 'codex')
    copyFileSync(new URL('../test/fixtures/codex-adapter-cli.cjs', import.meta.url), fixtureBin)
    chmodSync(fixtureBin, 0o755)
    // The fixture bridges over ws too; seed it next to the fixture so nothing
    // else manages that directory.
    mkdirSync(join(fixtureDir, 'node_modules'), { recursive: true })
    symlinkSync(join(realpathSync(runtime.resolve('ws')), '..'), join(fixtureDir, 'node_modules', 'ws'), 'dir')
    try {
      await api('engine-config-set', { engine: 'codex', engineOptions: { bin: fixtureBin } })
      const scan = await api('engine-scan', { engine: 'codex' })
      assert.ok(scan.models.some(model => model.id === 'fixture-model'), 'fixture model missing from the codex scan')
      const nativeCatalog = await nativeCall('session/modelCatalog', {})
      assert.ok(!nativeCatalog.groups.some(group => ['codex', 'claude', 'zcode', 'opencode'].includes(group.id) || group.id.startsWith('nodo:')), 'Nodo engine models must not be advertised in the native catalog')
      mkdirSync(join(home, 'codex-workspace'), { recursive: true })
      const codexWorkspacePath = realpathSync(join(home, 'codex-workspace'))
      await nativeCall('workspace/create', { request: { path: join(home, 'codex-workspace') } })
      const roleWorkspace = await api('workspace-create', { name: 'Adapter workspace', cwd: codexWorkspacePath })
      const codexRole = await api('profile-create', { name: 'Adapter Codex', engine: 'codex', workspace: roleWorkspace.id, model: 'fixture-model', thinking: 'medium', instructions: 'ADAPTER_ROLE_IDENTITY' })
      assert.equal((await api('profile-update', { id: codexRole.id, changes: { role: 'P2 verification role' } })).role, 'P2 verification role')
      const codexSession = await api('adapter-session-open', { profile: codexRole.id, workspace: roleWorkspace.id })
      const selectedCodex = await api('adapter-model-select', { sessionId: codexSession.sessionId, provider: 'nodo:codex', model: 'fixture-model' })
      assert.equal(selectedCodex.current.provider, 'nodo:codex')
      assert.ok(selectedCodex.groups[0].models.some(model => model.id === 'fixture-model'))
      assert.ok(!(await nativeCall('session/modelCatalog', {})).groups.some(group => group.id.startsWith('nodo:')), 'private selection must not publish engine models')
      const codexObserver = await observe(codexSession.sessionId)
      const fixtureLog = () => {
        try {
          const raw = readFileSync(join(codexWorkspacePath, 'codex-requests.jsonl'), 'utf8')
          return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        } catch (error) { throw new Error(`fixture log unreadable under ${codexWorkspacePath}: ${error.code ?? error.message}`) }
      }
      const nativeReasonOf = frames => frames.find(frame => frame?.type === 'event' && frame.event.type === 'turn/end')?.event.data.reason
      // A second WebSocket acts as the approval client the browser would be:
      // '$events' downstream frames + the '$events/result' RPC per waterfall.
      const decisions = []
      const approvalsSeen = []
      const questionsSeen = []
      let holdQuestions = false
      let eventsClientId = null
      const eventSocket = new WebSocket(`${url.replace('http:', 'ws:')}${REMOTE_STREAM_MUX_PATH}`, { headers: { Origin: url, Cookie: cookie } })
      observers.add(eventSocket)
      eventSocket.on('message', async data => {
        try {
          const frame = parseRemoteStreamServerMessage(data.toString())
          if (frame.type !== 'item' || frame.streamId !== 'events') return
          if (frame.value?.type === 'ready') eventsClientId = frame.value.clientId
          if (frame.value?.type === 'waterfall' && frame.value.event === 'approval/request') {
            await assertNativeWork(codexSession, 'waiting-approval')
            const decision = decisions.shift() ?? 'deny'
            approvalsSeen.push({ request: frame.value.request, agentId: frame.value.agentId, decision })
            if (decision === 'wait') return
            const response = await fetch(`${url}/api/$events/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: 'approval-answer', method: '$events/result', payload: { args: { clientId: eventsClientId, eventId: frame.value.eventId, outcome: { kind: 'result', value: decision === 'allow' ? 'allowed-once' : 'rejected' } } } }) })
            assert.ok(response.ok, `the $events/result RPC failed with HTTP ${response.status}`)
          }
          if (frame.value?.type === 'waterfall' && frame.value.event === 'user-questions/request') {
            await assertNativeWork(codexSession, 'waiting-question')
            questionsSeen.push({ request: frame.value.request, agentId: frame.value.agentId })
            if (holdQuestions) return
            const answers = frame.value.request.questions.map(question => ({ id: question.id, selected: question.id === 'color' ? ['Blue'] : [], ...(question.id === 'name' ? { custom: 'Native answer' } : {}) }))
            const response = await fetch(`${url}/api/$events/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: 'question-answer', method: '$events/result', payload: { args: { clientId: eventsClientId, eventId: frame.value.eventId, outcome: { kind: 'result', value: { answers } } } } }) })
            assert.ok(response.ok)
          }
        } catch { /* the assertions below catch a missing answer */ }
      })
      await once(eventSocket, 'open')
      eventSocket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
      await until(() => eventsClientId !== null)

      const codexMark = requests.length
      await nativeCall('session/prompt', { request: { requestId: 'codex-flow-1', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'RUN_FLOW' }] } })
      await until(() => codexObserver.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
      const flowMessages = codexObserver.frames.filter(frame => frame?.type === 'event' && frame.event.type === 'assistant/message')
      const flowText = flowMessages.map(frame => JSON.stringify(frame.event.data?.message?.content)).join('')
      assert.ok(flowText.includes('FLOW part one') && flowText.includes('FLOW done'), `the relayed text did not reach the native message stream: ${flowText.slice(0, 600)}`)
      assert.ok(flowText.includes('"reasoning"'), 'no reasoning block reached the native message stream')
      const flowResults = codexObserver.frames.filter(frame => frame?.type === 'event' && frame.event.type === 'tool/result')
      const flowCalls = codexObserver.frames.filter(frame => frame?.type === 'event' && frame.event.type === 'tool/call')
      assert.ok(flowResults.length >= 2 && flowCalls.length >= 2, `expected two mirrored tool calls and results, got ${flowCalls.length}/${flowResults.length}`)
      assert.ok(flowResults.every(frame => !frame.event.data?.message?.isError), 'mirrored tools must execute successfully')
      assert.ok(flowCalls.every(frame => frame.event.data?.name === 'engine_action') && flowCalls.every(frame => JSON.parse(frame.event.data.arguments).kind === 'tool'), 'the tool calls are not engine_action mirrors')
      assert.equal(nativeReasonOf(codexObserver.frames).kind, 'completed')
      await assertNativeWork(codexSession, 'completed')
      const flowUsage = flowMessages.map(frame => frame.event.data?.usage).find(Boolean)
      assert.ok(flowUsage?.inputTokens > 0 && flowUsage?.outputTokens > 0, `usage missing from the adapter turn: ${JSON.stringify(flowUsage)}`)
      assert.equal(requests.length, codexMark, 'the mock host model must not receive adapter-session traffic')
      const flowLog = fixtureLog()
      assert.equal(flowLog.filter(entry => entry.method === 'thread/start').length, 1, `the engine thread must start exactly once: ${JSON.stringify(flowLog.map(entry => entry.method))}`)
      assert.ok(flowLog.some(entry => entry.method === 'turn/start'))
      assert.ok(flowLog.find(entry => entry.method === 'thread/start').identity.includes('ADAPTER_ROLE_IDENTITY'))
      assert.ok(flowLog.find(entry => entry.method === 'turn/start').input[0].text === 'RUN_FLOW', 'host prompt assembly must not enter the engine turn')
      assert.ok(adapterProbe.readLog().filter(entry => entry.kind === 'codex-request').every(entry => entry.tools.length === 1 && entry.tools[0] === 'engine_action'), 'role preset must expose only the engine mirror')
      console.log('Codex adapter flow: text, reasoning, two mirrored tool cards, usage and turn completion passed with the mock host model untouched')

      decisions.push('allow')
      const askMark = codexObserver.frames.length
      await nativeCall('session/prompt', { request: { requestId: 'codex-ask-1', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'ASK_FLOW' }] } })
      try {
        await until(() => approvalsSeen.length >= 1)
      } catch (error) {
        console.log(`ASK_DEBUG events: ${JSON.stringify(codexObserver.frames.slice(askMark).map(frame => frame?.type === 'event' ? frame.event.type : frame?.type))}`)
        throw error
      }
      const allowed = approvalsSeen[0]
      assert.equal(allowed.agentId, codexSession.sessionId, 'the approval ask must be scoped to the adapter session')
      assert.equal(allowed.request.toolName, 'commandExecution')
      assert.ok(JSON.stringify(allowed.request).includes('fixture-ask'), `the engine ask lost its reason: ${JSON.stringify(allowed.request)}`)
      await until(() => codexObserver.frames.slice(askMark).some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
      assert.equal(nativeReasonOf(codexObserver.frames.slice(askMark)).kind, 'completed')
      assert.ok(codexObserver.frames.some(frame => frame?.type === 'event' && JSON.stringify(frame.event.data).includes('ASK done')), 'the approved engine action never finished its turn text')
      assert.ok(fixtureLog().some(entry => entry.method === 'approval-reply' && entry.decision === 'accept'), 'the engine never received the accept decision')

      decisions.push('deny')
      const denyMark = codexObserver.frames.length
      await nativeCall('session/prompt', { request: { requestId: 'codex-ask-2', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'ASK_FLOW' }] } })
      await until(() => approvalsSeen.length >= 2)
      await until(() => codexObserver.frames.slice(denyMark).some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
      assert.equal(nativeReasonOf(codexObserver.frames.slice(denyMark)).kind, 'completed', 'a denied engine turn must still end cleanly')
      assert.ok(fixtureLog().some(entry => entry.method === 'approval-reply' && entry.decision === 'decline'), 'the engine never received the decline decision')
      console.log('Codex adapter approvals: native card allow and deny both settled the engine side')

      const cancelMark = codexObserver.frames.length
      await nativeCall('session/prompt', { request: { requestId: 'codex-hang-1', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'HANG_FLOW' }] } })
      await until(() => codexObserver.frames.slice(cancelMark).some(frame => frame?.type === 'event' && frame.event.type === 'tool/result'))
      await assertNativeWork(codexSession, 'running')
      await nativeCall('session/prompt', { request: { requestId: 'native-status-parallel', sessionId: firstId, mode: 'queue', content: [{ type: 'text', text: 'NATIVE_STATUS_PARALLEL' }] } })
      await assertNativeWork(nativeSession, 'completed')
      await assertNativeWork(codexSession, 'running')
      await nativeCall('session/cancel', { request: { sessionId: codexSession.sessionId } })
      await until(() => codexObserver.frames.slice(cancelMark).some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
      assert.equal(nativeReasonOf(codexObserver.frames.slice(cancelMark)).kind, 'aborted')
      await assertNativeWork(codexSession, 'stopped')
      assert.ok(fixtureLog().some(entry => entry.method === 'turn/interrupt'), 'the engine never received the interrupt')
      assert.equal(requests.length, codexMark + 1, 'only the explicit parallel DSH turn may reach the mock host model across cancellation')
      console.log('Codex adapter cancellation: native stop interrupts the engine and ends the turn aborted')
      const command = line => nativeCall('commands/execute', { agentId: codexSession.sessionId, line, submittedAttachments: [] })
      assert.ok((await nativeCall('commands/list', { agentId: codexSession.sessionId })).some(item => item.name === 'compact' && item.definitionId === '@deepseek-ai/dsh-command-compact'), 'native compact controls must discover the engine command')
      const run = async text => {
        const mark = codexObserver.frames.length
        await nativeCall('session/prompt', { request: { requestId: `p2-${text}`, sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
        await until(() => nativeReasonOf(codexObserver.frames.slice(mark)))
        assert.equal(nativeReasonOf(codexObserver.frames.slice(mark)).kind, 'completed')
        await assertNativeWork(codexSession, 'completed')
      }
      await run('AFTER_CANCEL')
      assert.ok(fixtureLog().some(entry => entry.method === 'turn/start' && entry.input[0].text === 'AFTER_CANCEL'), 'a cancelled turn must not swallow the next prompt')
      for (const [preset, sandbox, approvalPolicy] of [['read-only', 'read-only', undefined], ['danger-full-access', 'danger-full-access', 'never'], ['workspace-write', 'workspace-write', undefined]]) {
        assert.equal((await command(`/permission ${preset}`)).result.kind, 'success')
        await run(`PERMISSION_${preset}`)
        const settings = fixtureLog().findLast(entry => ['thread/start', 'thread/resume'].includes(entry.method))
        assert.equal(settings.sandbox, sandbox)
        assert.equal(settings.approvalPolicy, approvalPolicy)
      }
      console.log('P2 permissions: native selection reached Codex read-only/workspace-write/full options, with same-thread resume')
      await run('QUESTION_FLOW')
      assert.equal(questionsSeen[0].agentId, codexSession.sessionId)
      assert.equal(questionsSeen[0].request.questions.length, 2)
      assert.deepEqual(fixtureLog().find(entry => entry.method === 'question-reply').answers, { color: { answers: ['Blue'] }, name: { answers: ['Native answer'] } })
      console.log('P2 questions: native waterfall returned both selected and custom answers to Codex')
      const compactMark = codexObserver.frames.length
      const compacted = await command('/compact')
      assert.equal(compacted.result.kind, 'success', compacted.result.text)
      assert.ok(fixtureLog().some(entry => entry.method === 'compact-completed'), 'compact must wait for engine completion after the RPC acknowledgement')
      assert.ok(!codexObserver.frames.slice(compactMark).some(frame => frame?.type === 'event' && frame.event.type === 'compaction/summary'), 'engine compact must not replace the DSH mirror history')
      console.log('P2 compact: native /compact waited for Codex completion without summarizing host history')
      for (const marker of ['STREAM_HANG', 'TOOL_HANG', 'ASK_FLOW', 'QUESTION_HANG']) {
        const mark = codexObserver.frames.length
        const approvalCount = approvalsSeen.length
        const questionCount = questionsSeen.length
        const interrupts = fixtureLog().filter(entry => entry.method === 'turn/interrupt').length
        if (marker === 'ASK_FLOW') decisions.push('wait')
        holdQuestions = marker === 'QUESTION_HANG'
        await nativeCall('session/prompt', { request: { requestId: `p2-stop-${marker}`, sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
        try {
          await until(() => marker === 'ASK_FLOW' ? approvalsSeen.length > approvalCount : marker === 'QUESTION_HANG' ? questionsSeen.length > questionCount
            : codexObserver.frames.slice(mark).some(frame => marker === 'TOOL_HANG' ? frame?.event?.type === 'tool/call' : JSON.stringify(frame).includes('ing for cancellation')))
        } catch { throw new Error(`The engine did not reach the expected wait during ${marker}`) }
        await nativeCall('session/cancel', { request: { sessionId: codexSession.sessionId } })
        await until(() => nativeReasonOf(codexObserver.frames.slice(mark)))
        assert.equal(nativeReasonOf(codexObserver.frames.slice(mark)).kind, 'aborted')
        await assertNativeWork(codexSession, 'stopped')
        try { await until(() => fixtureLog().filter(entry => entry.method === 'turn/interrupt').length > interrupts) }
        catch { throw new Error(`The engine did not receive interrupt during ${marker}`) }
        holdQuestions = false
        await run(`AFTER_STOP_${interrupts}`)
      }
      console.log('P2 stops: model stream, mirror wait, approval wait and question wait all interrupted and accepted the next turn')
      if (process.argv.includes('--adapter-long')) {
        const longMark = codexObserver.frames.length
        const began = Date.now()
        const hangSeconds = 120
        await nativeCall('session/prompt', { request: { requestId: 'codex-hang-long', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'HANG_FLOW' }] } })
        let longEnd
        const deadline = Date.now() + 300000
        while (Date.now() < deadline) {
          longEnd = codexObserver.frames.slice(longMark).find(frame => frame?.type === 'event' && frame.event.type === 'turn/end')
          if (longEnd || child.exitCode !== null) break
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        console.log(`Long-step probe: a ${hangSeconds}s gap between engine steps ended ${JSON.stringify(longEnd?.event.data.reason ?? null)} after ${Math.round((Date.now() - began) / 1000)}s`)
        assert.ok(longEnd, 'the long-step turn never completed')
        assert.equal(longEnd.event.data.reason.kind, 'completed')
      }
      codexObserver.close()
      eventSocket.terminate()
      await stop()
      start()
      await authorize()
      await assertNativeWork(codexSession, 'completed')
      const resumedObserver = await observe(codexSession.sessionId)
      const reopened = await api('adapter-session-open', { profile: codexRole.id, session: codexSession.conversationId, workspace: roleWorkspace.id })
      assert.equal(reopened.sessionId, codexSession.sessionId, 'reopening a role must retain its native session')
      const coldCompact = await nativeCall('commands/execute', { agentId: codexSession.sessionId, line: '/compact', submittedAttachments: [] })
      assert.equal(coldCompact.result.kind, 'success', coldCompact.result.text)
      await nativeCall('session/prompt', { request: { requestId: 'codex-resume-1', sessionId: codexSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'RESUME_FLOW' }] } })
      await until(() => resumedObserver.frames.some(frame => frame?.type === 'event' && frame.event.type === 'turn/end'))
      const resumedText = resumedObserver.frames.filter(frame => frame?.type === 'event' && frame.event.type === 'assistant/message').map(frame => JSON.stringify(frame.event.data?.message?.content)).join('')
      assert.ok(resumedText.includes('Resumed on thread fixture-thread'), `cold resume did not reach the same engine thread: ${resumedText.slice(0, 400)}`)
      const resumedLog = fixtureLog()
      assert.ok(resumedLog.some(entry => entry.method === 'thread/resume' && entry.threadId === 'fixture-thread'), 'no thread/resume after the host restart')
      assert.equal(resumedLog.filter(entry => entry.method === 'thread/start').length, 1, 'cold resume must not start a second engine thread')
      resumedObserver.close()
      console.log('Codex adapter restart: native session mapped to the same engine thread and continued')
      console.log('P1/P2 fixture RESULT: GO — role scope, permissions, questions, compact, stops and resume all passed')
      if (process.argv.includes('--adapter-ui')) {
        writeFileSync('/private/tmp/orch-native-dsh-ui.json', JSON.stringify({ url: `http://127.0.0.1:${mock.address().port}/bench/login`, profileId: codexRole.id, sessionId: codexSession.sessionId }), { mode: 0o600 })
        console.log('P2 adapter UI bench ready; send input to finish')
        await new Promise(resolve => process.stdin.once('data', resolve))
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
    // ---- P3: claude / zcode / opencode adapters over their fixtures (.agent/context/native-adapter-handoff.md §4 P3) ----
    const p3Specs = [
      { engine: 'claude', model: 'sonnet', fixture: 'claude-adapter-cli.cjs', logFile: 'claude-requests.jsonl',
        tiers: [['read-only', 'plan'], ['workspace-write', undefined], ['danger-full-access', 'bypassPermissions']] },
      { engine: 'zcode', model: 'fixture$fixture-model', fixture: 'zcode-adapter-cli.cjs', logFile: 'zcode-requests.jsonl',
        tiers: [['read-only', 'plan'], ['workspace-write', 'build'], ['danger-full-access', 'yolo']] },
      { engine: 'opencode', model: 'fixture/fixture-model', fixture: 'opencode-adapter-cli.cjs', logFile: 'opencode-requests.jsonl',
        tiers: [['read-only', 'plan'], ['workspace-write', 'build']] },
    ]
    for (const spec of p3Specs) {
      const fixtureDir = mkdtempSync(join(tmpdir(), `orch-${spec.engine}-adapter-`))
      const fixtureBin = join(fixtureDir, spec.engine)
      copyFileSync(new URL(`../test/fixtures/${spec.fixture}`, import.meta.url), fixtureBin)
      chmodSync(fixtureBin, 0o755)
      try {
        await api('engine-config-set', { engine: spec.engine, engineOptions: { bin: fixtureBin } })
        const scan = await api('engine-scan', { engine: spec.engine })
        assert.ok(scan.models.length > 0, `${spec.engine} scan returned no models`)
        const p3Catalog = await nativeCall('session/modelCatalog', {})
        assert.ok(!p3Catalog.groups.some(group => group.id === spec.engine || group.id.startsWith('nodo:')), `${spec.engine} adapter models leaked into the native catalog`)
        const engineWorkspacePath = realpathSync(mkdirSync(join(home, `${spec.engine}-workspace`), { recursive: true }))
        await nativeCall('workspace/create', { request: { path: engineWorkspacePath } })
        const roleWorkspace = await api('workspace-create', { name: `${spec.engine} adapter workspace`, cwd: engineWorkspacePath })
        const role = await api('profile-create', { name: `Adapter ${spec.engine}`, engine: spec.engine, workspace: roleWorkspace.id, model: spec.model, instructions: `ADAPTER_IDENTITY_${spec.engine.toUpperCase()}` })
        const opened = await api('adapter-session-open', { profile: role.id, workspace: roleWorkspace.id })
        const selected = await api('adapter-model-select', { sessionId: opened.sessionId, provider: `nodo:${spec.engine}`, model: spec.model })
        assert.equal(selected.current.provider, `nodo:${spec.engine}`)
        const observer = await observe(opened.sessionId)
        const fixtureLog = () => {
          try {
            const raw = readFileSync(join(engineWorkspacePath, spec.logFile), 'utf8')
            return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          } catch (error) { throw new Error(`${spec.engine} fixture log unreadable under ${engineWorkspacePath}: ${error.code ?? error.message}`) }
        }
        const reasonOf = frames => frames.find(frame => frame?.type === 'event' && frame.event.type === 'turn/end')?.event.data.reason
        const decisions = []
        const questionsSeen = []
        let eventsClientId = null
        const eventSocket = new WebSocket(`${url.replace('http:', 'ws:')}${REMOTE_STREAM_MUX_PATH}`, { headers: { Origin: url, Cookie: cookie } })
        observers.add(eventSocket)
        eventSocket.on('message', async data => {
          try {
            const frame = parseRemoteStreamServerMessage(data.toString())
            if (frame.type !== 'item' || frame.streamId !== 'events') return
            if (frame.value?.type === 'ready') eventsClientId = frame.value.clientId
            const value = frame.value?.type === 'waterfall' ? frame.value : null
            if (value?.event === 'approval/request') {
              await assertNativeWork(opened, 'waiting-approval')
              const decision = decisions.shift() ?? 'deny'
              if (decision === 'wait') return
              const response = await fetch(`${url}/api/$events/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
                body: JSON.stringify({ type: 'client-request', rpcId: 'p3-approval', method: '$events/result', payload: { args: { clientId: eventsClientId, eventId: value.eventId, outcome: { kind: 'result', value: decision === 'allow' ? 'allowed-once' : 'rejected' } } } }) })
              assert.ok(response.ok)
            }
            if (value?.event === 'user-questions/request') {
              await assertNativeWork(opened, 'waiting-question')
              questionsSeen.push(value)
              const answers = value.request.questions.map(question => {
                const blue = (question.options ?? []).find(option => option.label === 'Blue')
                return { id: question.id, ...(blue ? { selected: ['Blue'] } : { custom: 'Native answer' }) }
              })
              const response = await fetch(`${url}/api/$events/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
                body: JSON.stringify({ type: 'client-request', rpcId: 'p3-question', method: '$events/result', payload: { args: { clientId: eventsClientId, eventId: value.eventId, outcome: { kind: 'result', value: { answers } } } } }) })
              assert.ok(response.ok)
            }
          } catch { /* the assertions below catch a missing answer */ }
        })
        await once(eventSocket, 'open')
        eventSocket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
        await until(() => eventsClientId !== null)
        let sequence = 0
        const run = async text => {
          const mark = observer.frames.length
          const before = requests.length
          await nativeCall('session/prompt', { request: { requestId: `p3-${spec.engine}-${++sequence}`, sessionId: opened.sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
          await until(() => reasonOf(observer.frames.slice(mark)))
          const kind = reasonOf(observer.frames.slice(mark)).kind
          await assertNativeWork(opened, kind === 'completed' ? 'completed' : kind === 'error' ? 'error' : 'stopped')
          assert.equal(requests.length, before, `the mock host model must not receive ${spec.engine} adapter traffic`)
          return mark
        }
        const flowMark = await run('RUN_FLOW')
        assert.equal(reasonOf(observer.frames.slice(flowMark)).kind, 'completed')
        const flowMessages = observer.frames.slice(flowMark).filter(frame => frame?.type === 'event' && frame.event.type === 'assistant/message')
        const flowText = flowMessages.map(frame => JSON.stringify(frame.event.data?.message?.content)).join('')
        assert.ok(flowText.includes('FLOW part one') && flowText.includes('FLOW done'), `the relayed text did not reach the native message stream: ${flowText.slice(0, 600)}`)
        const flowCalls = observer.frames.slice(flowMark).filter(frame => frame?.type === 'event' && frame.event.type === 'tool/call')
        assert.ok(flowCalls.length >= 2 && flowCalls.every(frame => frame.event.data?.name === 'engine_action' && JSON.parse(frame.event.data.arguments).kind === 'tool'), `the tool calls are not engine_action mirrors: ${JSON.stringify(flowCalls.map(frame => [frame.event.data?.name, frame.event.data?.arguments?.slice(0, 120)]))}`)
        const flowUsage = flowMessages.map(frame => frame.event.data?.usage).find(Boolean)
        assert.ok(flowUsage?.inputTokens > 0 && flowUsage?.outputTokens > 0, `usage missing from the ${spec.engine} adapter turn: ${JSON.stringify(flowUsage)}`)
        const flowLog = fixtureLog()
        const flowPrompt = flowLog.find(entry => ['prompt', 'session/send', 'session/prompt'].includes(entry.method))
        assert.equal(flowPrompt.text, 'RUN_FLOW', 'host prompt assembly must not enter the engine turn')
        if (spec.engine === 'claude') assert.ok(flowPrompt.identity?.includes('ADAPTER_IDENTITY_CLAUDE'), 'the role identity never reached the engine channel')
        console.log(`P3 ${spec.engine}: text, mirrored tool cards, usage and turn completion passed with the mock host model untouched`)
        decisions.push('allow')
        const allowMark = await run('ASK_FLOW')
        assert.equal(reasonOf(observer.frames.slice(allowMark)).kind, 'completed')
        assert.ok(questionsSeen.length === 0)
        assert.ok(fixtureLog().some(entry => ['ask-reply', 'approval-reply'].includes(entry.method) && /allow/i.test(JSON.stringify(entry))), `the engine never received the allow decision: reason ${JSON.stringify(reasonOf(observer.frames.slice(allowMark)))} results ${JSON.stringify(observer.frames.slice(allowMark).filter(frame => frame?.type === 'event' && frame.event.type === 'tool/result').map(frame => frame.event.data?.message?.content))} fixture ${JSON.stringify(fixtureLog().slice(-3))}`)
        decisions.push('deny')
        const denyMark = await run('ASK_FLOW')
        assert.equal(reasonOf(observer.frames.slice(denyMark)).kind, 'completed', 'a denied engine turn must still end cleanly')
        assert.ok(fixtureLog().some(entry => ['ask-reply', 'approval-reply'].includes(entry.method) && /deny|reject/i.test(JSON.stringify(entry))), 'the engine never received the deny decision')
        console.log(`P3 ${spec.engine}: native approval card allow and deny both settled the engine side`)
        const questionMark = await run('QUESTION_FLOW')
        assert.equal(questionsSeen.at(-1)?.agentId, opened.sessionId, `the question ask must be scoped to the adapter session: seen ${JSON.stringify(questionsSeen)} reason ${JSON.stringify(reasonOf(observer.frames.slice(questionMark)))} results ${JSON.stringify(observer.frames.slice(questionMark).filter(frame => frame?.type === 'event' && frame.event.type === 'tool/result').map(frame => frame.event.data?.message?.content))} fixture ${JSON.stringify(fixtureLog().slice(-2))}`)
        assert.ok(observer.frames.slice(questionMark).some(frame => frame?.type === 'event' && JSON.stringify(frame.event.data).includes('QUESTION done')), 'the answered question never finished its turn')
        assert.ok(fixtureLog().some(entry => entry.method === 'question-reply' || (entry.method === 'ask-reply' && (entry.answers || entry.content))), 'the engine never received the answers')
        console.log(`P3 ${spec.engine}: native question card returned the answer to the engine`)
        const stopMark = observer.frames.length
        await nativeCall('session/prompt', { request: { requestId: `p3-${spec.engine}-stop`, sessionId: opened.sessionId, mode: 'queue', content: [{ type: 'text', text: 'HANG_FLOW' }] } })
        await until(() => observer.frames.slice(stopMark).some(frame => frame?.type === 'event' && frame.event.type === 'tool/result'))
        await nativeCall('session/cancel', { request: { sessionId: opened.sessionId } })
        await until(() => reasonOf(observer.frames.slice(stopMark)))
        assert.equal(reasonOf(observer.frames.slice(stopMark)).kind, 'aborted')
        assert.ok(fixtureLog().some(entry => entry.method === 'interrupt'), 'the engine never received the interrupt')
        await run('AFTER_STOP')
        assert.ok(fixtureLog().some(entry => ['prompt', 'session/send', 'session/prompt'].includes(entry.method) && entry.text === 'AFTER_STOP'), 'a cancelled turn must not swallow the next prompt')
        console.log(`P3 ${spec.engine}: native stop interrupts the engine and the next turn continues`)
        const command = line => nativeCall('commands/execute', { agentId: opened.sessionId, line, submittedAttachments: [] })
        const tierSeen = () => {
          const entries = fixtureLog()
          if (spec.engine === 'claude') return entries.filter(entry => entry.method === 'prompt').at(-1).permissionMode
          if (spec.engine === 'zcode') return entries.filter(entry => entry.mode !== undefined).at(-1).mode
          return entries.filter(entry => entry.method === 'session/set_config_option' && entry.configId === 'mode').at(-1)?.value
        }
        for (const [preset, expected] of spec.tiers) {
          assert.equal((await command(`/permission ${preset}`)).result.kind, 'success')
          const tierMark = await run(`PERMISSION_${preset}`)
          assert.equal(reasonOf(observer.frames.slice(tierMark)).kind, 'completed')
          assert.equal(tierSeen(), expected, `native tier ${preset} did not reach the ${spec.engine} engine settings`)
        }
        if (spec.engine === 'opencode') {
          assert.equal((await command('/permission danger-full-access')).result.kind, 'success')
          const entries = fixtureLog().length
          const refused = await run('PERMISSION_danger-full-access')
          assert.equal(reasonOf(observer.frames.slice(refused)).kind, 'error', 'the missing tier must refuse the turn, not run without it')
          assert.equal(fixtureLog().length, entries, 'the engine must never see a tier it does not offer')
          assert.equal((await command('/permission workspace-write')).result.kind, 'success', 'a supported tier must be selectable again after the refusal')
        }
        console.log(`P3 ${spec.engine}: native tiers reached the engine settings${spec.engine === 'opencode' ? ' and the missing full tier refused cleanly' : ''}`)
        const compacted = await command('/compact')
        if (spec.engine === 'opencode') {
          assert.equal(compacted.result.kind, 'error', 'an engine without a compaction channel must refuse /compact')
          assert.match(compacted.result.text, /compaction channel/)
        } else {
          assert.equal(compacted.result.kind, 'success', compacted.result.text)
          if (spec.engine === 'zcode') assert.ok(fixtureLog().some(entry => entry.method === 'compact-completed'), 'compact must wait for engine completion')
        }
        console.log(`P3 ${spec.engine}: compact routed to the engine capability honestly`)
        observer.close()
        eventSocket.terminate()
        await stop()
        start()
        await authorize()
        await assertNativeWork(opened, spec.engine === 'opencode' ? 'error' : 'completed')
        const resumedObserver = await observe(opened.sessionId)
        const reopened = await api('adapter-session-open', { profile: role.id, session: opened.conversationId, workspace: roleWorkspace.id })
        assert.equal(reopened.sessionId, opened.sessionId, 'reopening a role must retain its native session')
        await nativeCall('session/prompt', { request: { requestId: `p3-${spec.engine}-resume`, sessionId: opened.sessionId, mode: 'queue', content: [{ type: 'text', text: 'RESUME_FLOW' }] } })
        await until(() => reasonOf(resumedObserver.frames))
        const resumedText = resumedObserver.frames.filter(frame => frame?.type === 'event' && frame.event.type === 'assistant/message').map(frame => JSON.stringify(frame.event.data?.message?.content)).join('')
        assert.ok(resumedText.includes('Resumed on session'), `cold resume did not reach the same engine session: ${resumedText.slice(0, 400)}`)
        const resumedLog = fixtureLog()
        if (spec.engine === 'zcode') assert.ok(resumedLog.some(entry => entry.method === 'session/resume'), 'no engine session resume after the host restart')
        if (spec.engine === 'opencode') assert.ok(resumedLog.some(entry => entry.method === 'session/load'), 'no engine session load after the host restart')
        resumedObserver.close()
        console.log(`P3 ${spec.engine}: restart kept the native session mapped to the same engine session`)
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true })
      }
    }
    if (process.argv.includes('--adapter-real')) {
      const { checkRealAdapter } = await import('./native-adapter-real.mjs')
      await checkRealAdapter({ home, api, nativeCall, observe, until, stop, start, authorize, WebSocket, streamPath: REMOTE_STREAM_MUX_PATH,
        parseFrame: parseRemoteStreamServerMessage, url, headers: () => ({ Origin: url, Cookie: cookie }), observers })
    }
    if (process.argv.includes('--adapter-real-p3')) {
      const { checkRealAdapterP3 } = await import('./native-adapter-real.mjs')
      await checkRealAdapterP3({ home, api, nativeCall, observe, until, stop, start, authorize, WebSocket, streamPath: REMOTE_STREAM_MUX_PATH,
        parseFrame: parseRemoteStreamServerMessage, url, headers: () => ({ Origin: url, Cookie: cookie }), observers })
    }
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
  adapterProbe?.dispose()
  process.stdin.pause()
  if (process.argv.includes('--preview') || process.argv.includes('--adapter-ui') || uiProbe) rmSync('/private/tmp/orch-native-dsh-ui.json', { force: true })
}
