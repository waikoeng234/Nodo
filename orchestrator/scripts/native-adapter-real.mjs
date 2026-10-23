import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'

export async function checkRealAdapter({ home, api, nativeCall, observe, until, stop, start, authorize, WebSocket, streamPath, parseFrame, url, headers, observers }) {
  await api('engine-config-set', { engine: 'codex', engineOptions: {} })
  const catalog = await api('engine-scan', { engine: 'codex' })
  assert.equal(catalog.source, 'Codex app-server model/list', 'Real Codex app-server must be reachable; config-file fallback is not smoke evidence')
  const model = catalog.models.find(item => item.id === catalog.defaultModel) ?? catalog.models[0]
  assert.ok(model, 'The real engine must advertise a model')
  const cwd = join(home, 'real-codex-workspace')
  mkdirSync(cwd, { recursive: true })
  const workspace = await api('workspace-create', { name: 'Real adapter smoke', cwd })
  const role = await api('profile-create', { name: 'Real Codex smoke', engine: 'codex', workspace: workspace.id, model: model.id,
    thinking: model.thinking?.find(item => item.id === 'low')?.id, permission: 'workspace',
    instructions: 'Perform only the requested smoke task in this temporary workspace. Never inspect login, configuration, credentials, or environment variables.' })
  const session = await api('adapter-session-open', { profile: role.id, workspace: workspace.id })
  const observer = await observe(session.sessionId)
  const events = () => observer.frames.filter(frame => frame?.type === 'event').map(frame => frame.event)
  let clientId
  let approved = 0
  let unsafe = false
  const socket = new WebSocket(url.replace('http:', 'ws:') + streamPath, { headers: headers() })
  observers.add(socket)
  socket.on('message', async data => {
    try {
      const frame = parseFrame(data.toString())
      if (frame.type !== 'item' || frame.streamId !== 'real-events') return
      if (frame.value?.type === 'ready') clientId = frame.value.clientId
      if (frame.value?.type !== 'waterfall' || frame.value.event !== 'approval/request' || frame.value.agentId !== session.sessionId) return
      const reason = frame.value.request.reason ?? ''
      const allowed = reason.includes('P2_NATIVE_SMOKE_OK') && reason.includes('proof.txt')
      if (!allowed) unsafe = true
      const response = await fetch(url + '/api/$events/result', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'real-approval', method: '$events/result', payload: { args: { clientId, eventId: frame.value.eventId,
          outcome: { kind: 'result', value: allowed ? 'allowed-once' : 'rejected' } } } }) })
      if (response.ok && allowed) approved++
    } catch { unsafe = true }
  })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId: 'real-events', endpoint: '$events', payload: { args: {} } }))
  await until(() => clientId)
  try {
    const task = 'This is one small integration smoke task. Use exec_command once, with sandbox_permissions="require_escalated" and a short justification, to run exactly this command in the current workspace: python3 -c "from pathlib import Path; import time; Path(\'proof.txt\').write_text(\'P2_NATIVE_SMOKE_OK\'); time.sleep(30)". Do not inspect anything else or run other commands. After the command finishes, report the marker.'
    await nativeCall('session/prompt', { request: { requestId: 'real-smoke', sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: task }] } })
    const deadline = Date.now() + 180000
    let written = false
    while (Date.now() < deadline) {
      try { written = readFileSync(join(cwd, 'proof.txt'), 'utf8') === 'P2_NATIVE_SMOKE_OK' } catch {}
      if (written || events().some(event => event.type === 'turn/end')) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await nativeCall('session/cancel', { request: { sessionId: session.sessionId } })
    await until(() => events().some(event => event.type === 'turn/end'))
    assert.ok(!unsafe, 'An unexpected real engine approval was denied')
    assert.ok(written, 'Real Codex did not write the smoke marker')
    assert.ok(events().some(event => event.type === 'tool/call' && event.data.name === 'engine_action'), 'Real engine action did not produce a native tool card')
    assert.equal(events().find(event => event.type === 'turn/end').data.reason.kind, 'aborted')
    assert.ok(approved > 0, 'The real engine did not request approval; that part of smoke is unverified')
    console.log('P2 real Codex: one small task wrote the marker, native approval was granted, and native stop aborted the engine')
    const mapped = JSON.parse(readFileSync(join(home, 'nodo', 'state.json'), 'utf8')).adapterSessions[session.sessionId].threadId
    assert.ok(mapped)
    observer.close()
    socket.terminate()
    await stop()
    start()
    await authorize()
    const resumed = await observe(session.sessionId)
    try {
      await nativeCall('session/prompt', { request: { requestId: 'real-resume', sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Continue the same smoke task: read proof.txt only and reply with its exact contents. Do not change any files or run other commands.' }] } })
      const end = await until(() => resumed.frames.find(frame => frame?.event?.type === 'turn/end'))
      assert.equal(end.event.data.reason.kind, 'completed')
      const text = resumed.frames.filter(frame => frame?.event?.type === 'assistant/message').map(frame => JSON.stringify(frame.event.data.message.content)).join('')
      assert.ok(text.includes('P2_NATIVE_SMOKE_OK'))
      assert.equal(JSON.parse(readFileSync(join(home, 'nodo', 'state.json'), 'utf8')).adapterSessions[session.sessionId].threadId, mapped)
      console.log('P2 real Codex restart: the same native session resumed the same engine thread and read the marker')
    } finally { resumed.close() }
  } finally {
    observer.close()
    socket.terminate()
  }
}

// P3 real smoke (handoff §4 P3): one small marker task per real engine over the
// adapter route — a genuine engine approval gate is expected at the workspace
// tier and native stop must abort the engine. An engine advertising no models
// is reported and skipped instead of pretending.
export async function checkRealAdapterP3({ home, api, nativeCall, observe, until, stop, start, authorize, WebSocket, streamPath, parseFrame, url, headers, observers }) {
  // Engines advertise their approval reasons differently: codex/claude relay
  // the command text, zcode only its own risk wording. The one-task session is
  // the real boundary, so a shell-class ask from this session belongs to the
  // smoke task; anything else fails closed.
  const engines = (process.env.ORCH_REAL_ENGINES ?? 'claude,zcode,opencode').split(',')
  for (const engine of engines) {
    const marker = `P3_${engine.toUpperCase()}_SMOKE_OK`
    const file = `proof-${engine}.txt`
    await api('engine-config-set', { engine, engineOptions: {} })
    const catalog = await api('engine-scan', { engine })
    if (!catalog.models.length) {
      console.log(`P3 real ${engine}: scan advertises no models (${catalog.source}); smoke skipped and recorded as unverified`)
      continue
    }
    console.log(`P3 real ${engine}: scan source "${catalog.source}" offers ${catalog.models.length} models`)
    // ORCH_REAL_MODEL_<ENGINE> pins a model the user trusts (e.g. past a
    // workspace privacy gate); otherwise the scan default, else the first.
    const wanted = process.env[`ORCH_REAL_MODEL_${engine.toUpperCase()}`]
    const model = catalog.models.find(item => item.id === wanted)
      ?? catalog.models.find(item => item.id === catalog.defaultModel) ?? catalog.models[0]
    if (wanted && catalog.models.find(item => item.id === wanted)?.id !== model.id) {
      console.log(`P3 real ${engine}: requested model "${wanted}" is not in the scan; falling back to "${model.id}"`)
    }
    const cwd = join(home, `real-${engine}-workspace`)
    mkdirSync(cwd, { recursive: true })
    const workspace = await api('workspace-create', { name: `Real ${engine} smoke`, cwd })
    const role = await api('profile-create', { name: `Real ${engine} smoke`, engine, workspace: workspace.id, model: model.id, permission: 'workspace',
      instructions: 'Perform only the requested smoke task in this temporary workspace. Never inspect login, configuration, credentials, or environment variables.' })
    const session = await api('adapter-session-open', { profile: role.id, workspace: workspace.id })
    await nativeCall('session/selectModel', { request: { sessionId: session.sessionId, provider: engine, model: model.id } })
    const observer = await observe(session.sessionId)
    const events = () => observer.frames.filter(frame => frame?.type === 'event').map(frame => frame.event)
    let clientId
    let approved = 0
    let unsafe = false
    const socket = new WebSocket(url.replace('http:', 'ws:') + streamPath, { headers: headers() })
    observers.add(socket)
    socket.on('message', async data => {
      try {
        const frame = parseFrame(data.toString())
        if (frame.type !== 'item' || frame.streamId !== `real-${engine}`) return
        if (frame.value?.type === 'ready') clientId = frame.value.clientId
        if (frame.value?.type !== 'waterfall' || frame.value.agentId !== session.sessionId) return
        if (frame.value.event !== 'approval/request' && frame.value.event !== 'user-questions/request') return
        const reason = JSON.stringify(frame.value.request)
        const allowed = reason.includes(marker) || reason.includes(file)
          || (frame.value.event === 'approval/request' && /^(bash|shell|command|write|edit|terminal|str_replace)/i.test(String(frame.value.request.toolName ?? frame.value.request.tool ?? '')))
        if (!allowed) { unsafe = true; console.log(`P3 real ${engine}: denying an unexpected ask (${frame.value.event}): ${reason.slice(0, 300)}`) }
        if (frame.value.event === 'user-questions/request') {
          const answers = (frame.value.request.questions ?? []).map(question => ({ id: question.id, selected: [], custom: marker }))
          await fetch(url + '/api/$events/result', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'real-question', method: '$events/result', payload: { args: { clientId, eventId: frame.value.eventId, outcome: { kind: 'result', value: { answers } } } } }) })
          return
        }
        const response = await fetch(url + '/api/$events/result', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'real-approval', method: '$events/result', payload: { args: { clientId, eventId: frame.value.eventId,
            outcome: { kind: 'result', value: allowed ? 'allowed-once' : 'rejected' } } } }) })
        if (response.ok && allowed) approved++
      } catch { unsafe = true }
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId: `real-${engine}`, endpoint: '$events', payload: { args: {} } }))
    await until(() => clientId)
    try {
      const task = `This is one small integration smoke task. Run exactly one shell command in the current workspace that writes exactly the text ${marker} into the file ${file} (for example with printf). Give the command a description mentioning ${marker}. Do not inspect anything else or run other commands. After it finishes, report the marker text.`
      await nativeCall('session/prompt', { request: { requestId: `real-${engine}-smoke`, sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: task }] } })
      const deadline = Date.now() + 240000
      let written = false
      while (Date.now() < deadline) {
        try { written = readFileSync(join(cwd, file), 'utf8').includes(marker) } catch {}
        if (written || events().some(event => event.type === 'turn/end')) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      await nativeCall('session/cancel', { request: { sessionId: session.sessionId } })
      await until(() => events().some(event => event.type === 'turn/end'))
      if (!written) console.log(`P3 real ${engine}: DIAG events ${JSON.stringify(events().map(event => event.type))} reason ${JSON.stringify(events().find(event => event.type === 'turn/end')?.data?.reason)} text ${events().filter(event => event.type === 'assistant/message').map(event => JSON.stringify(event.data?.message?.content)).join(' | ').slice(0, 600)}`)
      assert.ok(!unsafe, `Real ${engine} raised an unexpected ask; it was denied fail-closed`)
      assert.ok(written, `Real ${engine} did not write the smoke marker`)
      assert.ok(events().some(event => event.type === 'tool/call' && event.data.name === 'engine_action'), `Real ${engine} action did not produce a native tool card`)
      assert.equal(events().find(event => event.type === 'turn/end').data.reason.kind, 'aborted')
      if (approved > 0) console.log(`P3 real ${engine}: the task wrote the marker through ${approved} native approval grant(s), and native stop aborted the engine`)
      else console.log(`P3 real ${engine}: the task wrote the marker without an approval ask (engine ran it inside its sandbox), and native stop aborted the engine`)
    } finally {
      observer.close()
      socket.terminate()
    }
  }
}
