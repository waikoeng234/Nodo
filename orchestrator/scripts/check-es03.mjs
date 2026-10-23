import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findDshExecutable } from '../agent-drivers/dist/dsh/config.js'

const executable = findDshExecutable()
assert.ok(executable, 'Install DSH before running this check')
const runtime = createRequire(realpathSync(executable))
const changesProbe = process.argv.includes('--changes')
const WebSocket = runtime('ws')
const { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-api-gateway/stream-protocol')))
const home = mkdtempSync(join(tmpdir(), 'nodo-es03-'))
const plugin = join(home, 'fixture')
const cwd = join(home, 'workspace')
mkdirSync(plugin); mkdirSync(cwd)
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'nodo-es03-fixture', version: '0.0.0', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-layout'], platform: 'web' } } }))
const drivers = new URL('../agent-drivers/dist/index.js', import.meta.url).href
writeFileSync(join(plugin, 'index.js'), `
import { registerEngine } from ${JSON.stringify(drivers)}
const snapshot = (body, revision) => ({ version: 1, kind: 'tool', mode: 'snapshot', body, revision })
for (const id of ['codex', 'es03-legacy']) registerEngine(id, {
  info: { id, label: 'ES03 local fixture', requiresCwd: true, capabilities: { permissionModes: ['workspace'] } },
  validate: value => value, check: async () => ({ ok: true, checks: [] }),
  scan: async () => ({ source: 'local-fixture', defaultModel: 'es03-fixture', models: [{ id: 'es03-fixture' }] }),
  create: ({ onEvent }) => {
    let ready = false
    return { instructionMode: 'native', hasSession: () => ready, onEvent() {}, dispose() {},
      async openSession({ sessionId } = {}) { ready = true; onEvent({ type: 'session', state: 'ready', sessionId: sessionId ?? 'es03-engine-session' }) },
      async steer() { return { status: 'refused' } }, async interruptTurn() {}, async respondToRequest() {},
      async sendTurn() {
        onEvent({ type: 'turn/start', turnId: 'es03-turn' })
        const input = { command: 'printf ES03_TERMINAL', cwd: ${JSON.stringify(cwd)} }
        const tool = (callId, phase, body, isError = false) => onEvent({ type: 'tool', name: 'ES03 Fixture', callId, phase, isError,
          input, output: body.outputText ?? 'ES03_DIFF_OUTPUT', presentation: snapshot(body, phase === 'start' ? 0 : 1) })
        tool('terminal', 'start', input)
        tool('diff', 'start', { inputText: 'ES03 source-confirmed before and after' })
        tool('diff', 'end', { inputText: 'ES03 source-confirmed before and after', outputText: 'ES03_DIFF_OUTPUT',
          diffs: [{ path: 'es03-proof.txt', oldText: 'ES03_BEFORE\\n', newText: 'ES03_AFTER\\n' }] })
        tool('terminal', 'end', { ...input, outputText: 'ES03_PARTIAL_OUTPUT\\n' + 'fixture output\\n'.repeat(1400) + 'ES03_FULL_DETAIL_END', exitCode: 7 }, true)
        onEvent({ type: 'delta', text: 'ES03 fixture complete' })
        onEvent({ type: 'turn/end', reason: 'done' })
      },
    }
  },
})
export function apply() {}
`)
writeFileSync(join(plugin, 'client.js'), `window.__ModuleLoader__.load({ id: 'nodo-es03-fixture', factory: require => ({ inject: ['uiWorkspace', 'layout'], apply(ctx) {
  window.__NODO_ES03 = { openNative: id => ctx.uiWorkspace.openSession(id), openLegacy: () => ctx.layout.selectPanel('nodo') }
} }) })`)
if (changesProbe) {
  const bin = join(plugin, 'opencode.cjs')
  copyFileSync(new URL('../test/fixtures/opencode-adapter-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  writeFileSync(join(plugin, 'index.js'), `import { registerEngine, createDriver } from ${JSON.stringify(drivers)}
registerEngine('es03-legacy', { info: { id: 'es03-legacy', label: 'ES05 protocol fixture', requiresCwd: true }, validate: value => value,
  create: options => createDriver('opencode', { ...options, bin: ${JSON.stringify(bin)} }) })
export function apply() {}`)
}
let cookie, cookies = [], child, log = '', facts, detailFile, unexpectedModelCalls = 0
const relay = createServer((request, response) => {
  if (request.url === '/login') { response.writeHead(302, { 'Set-Cookie': cookies, Location: url }); response.end(); return }
  if (request.url === '/facts') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(facts)); return }
  if (request.url === '/remove-detail' && request.method === 'POST' && detailFile) {
    unlinkSync(detailFile); detailFile = undefined; response.writeHead(204); response.end(); return
  }
  unexpectedModelCalls += 1
  response.writeHead(503); response.end('ES03 fixture has no remote model')
})
relay.listen(0, '127.0.0.1'); await once(relay, 'listening')
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const url = `http://127.0.0.1:${port}`
const relayUrl = `http://127.0.0.1:${relay.address().port}`
const patch = join(home, 'es03.patch.json')
writeFileSync(patch, JSON.stringify([
  { id: 'llm-deepseek', config: { baseURL: relayUrl, apiKeyEnv: 'NODO_ES03_FIXTURE_KEY' } },
  { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'nodo-es03-fixture', name: join(plugin, 'index.js') },
    { id: 'nodo', name: fileURLToPath(new URL('../index.js', import.meta.url)), config: { home: join(home, 'nodo') } }] },
]))
const start = () => {
  log = ''
  child = spawn(executable, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, NODO_ES03_FIXTURE_KEY: 'local-fixture-only' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-32000) })
}
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
}
const until = async check => {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    if (child.exitCode !== null) throw new Error(`Isolated host exited (${child.exitCode}); raw log withheld`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('ES03 isolated-host check timed out; raw log withheld')
}
const authorize = async () => {
  const token = await until(() => log.match(/\?token=([^\s]+)/)?.[1])
  const page = await fetch(`${url}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookies = page.headers.getSetCookie()
  cookie = cookies.map(value => value.split(';')[0]).join('; ')
}
const post = async (path, body) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie }, body: JSON.stringify(body) })
  return response.json()
}
const api = async (endpoint, payload) => {
  const result = await post('nodo', { endpoint, payload })
  assert.equal(result.ok, true, `Nodo ${endpoint} failed (${result.error?.code}): ${String(result.error?.message ?? '').replaceAll(home, '<isolated-home>').slice(0, 250)}`)
  return result.value
}
const native = async (method, args) => {
  const { result } = await post(method, { type: 'client-request', rpcId: 'es03-check', method, payload: { args } })
  assert.equal(result?.ok, true, `Native ${method} failed (${result?.error?.code})`)
  return result.value
}
const observe = async sessionId => {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}${REMOTE_STREAM_MUX_PATH}`, { headers: { Origin: url, Cookie: cookie } })
  const frames = []
  socket.on('error', () => {})
  socket.on('message', data => { frames.push(parseRemoteStreamServerMessage(data.toString())) })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId: 'es03', endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } }))
  await until(() => frames.some(frame => frame.type === 'item' && frame.value.type === 'snapshot'))
  return { frames, close: () => socket.terminate() }
}
const findRecords = value => {
  if (!value || typeof value !== 'object') return []
  if (value.nodoRecord) return [value.nodoRecord]
  return Object.values(value).flatMap(findRecords)
}
try {
  start(); await authorize()
  await until(async () => (await api('state')).readOnly == null)
  const engine = changesProbe ? 'opencode' : 'codex'
  const model = changesProbe ? 'fixture/fixture-model' : 'es03-fixture'
  if (changesProbe) await api('engine-config-set', { engine, engineOptions: { bin: join(plugin, 'opencode.cjs') } })
  await api('engine-scan', { engine })
  const workspace = await api('workspace-create', { name: 'ES03 fixture workspace', cwd })
  const role = await api('profile-create', { name: changesProbe ? 'ES05 native changes' : 'ES03 native fixture', engine, workspace: workspace.id, model })
  const opened = await api('adapter-session-open', { profile: role.id, workspace: workspace.id })
  const observer = await observe(opened.sessionId)
  await native('session/prompt', { request: { requestId: 'es03-run', sessionId: opened.sessionId, mode: 'queue', content: [{ type: 'text', text: changesProbe ? 'FILES_FLOW' : 'ES03_LOCAL_FIXTURE' }] } })
  await until(() => observer.frames.some(frame => frame.value?.event?.type === 'turn/end'))
  const records = findRecords(observer.frames)
  assert.equal(records.length, changesProbe ? 1 : 2, 'Structured native results must reach public metadata')
  const terminal = records.find(record => changesProbe ? record.kind === 'changes' : record.entityId === 'terminal')
  assert.equal(terminal.status, changesProbe ? 'done' : 'error'); assert.equal(terminal.details.state, 'stored'); assert.equal(terminal.truncated, true)
  const full = await api('stream-detail', { target: opened.sessionId, ref: terminal.details.ref })
  if (changesProbe) { assert.equal(terminal.body.fileCount, 10); assert.equal(terminal.body.files.length, 3); assert.equal(full.body.files.length, 10) }
  else assert.ok(full.body.outputText.endsWith('ES03_FULL_DETAIL_END'))
  const resultFrames = observer.frames.filter(frame => frame.value?.event?.type === 'tool/result')
  assert.equal(new Set(resultFrames.map(frame => frame.value.event.data.message.toolCallId)).size, changesProbe ? 5 : 2, 'Native tools must retain independent call identities')
  assert.ok(!JSON.stringify(resultFrames.map(frame => frame.value.event.data.message.content)).includes('ES03_FULL_DETAIL_END'))
  observer.close()
  const legacyRole = await api('profile-create', { name: changesProbe ? 'ES05 legacy changes' : 'ES03 legacy fixture', engine: 'es03-legacy', workspace: workspace.id, model })
  await api('send', { profile: legacyRole.id, text: changesProbe ? 'FILES_FLOW' : 'ES03_LEGACY_FIXTURE' })
  await until(async () => !(await api('state')).work[legacyRole.id]?.active)
  const legacyLines = await api('transcript', { profile: legacyRole.id })
  assert.equal(legacyLines.filter(line => (changesProbe ? line.kind === 'changes' : line.phase === 'end') && line.presentation?.details?.state === 'stored').length, changesProbe ? 1 : 2)
  await stop(); start(); await authorize()
  const restored = await observe(opened.sessionId)
  assert.deepEqual(findRecords(restored.frames), records, 'Native replay must preserve the exact immutable references')
  restored.close()
  assert.deepEqual(await api('stream-detail', { target: opened.sessionId, ref: terminal.details.ref }), full)
  const legacyAfter = await api('transcript', { profile: legacyRole.id })
  assert.deepEqual(legacyAfter.slice(0, legacyLines.length), legacyLines)
  assert.ok(legacyAfter.slice(legacyLines.length).every(line => line.kind === 'note' && line.text === 'engine session closed'))
  const state = await api('state')
  const legacySession = state.profiles.find(profile => profile.id === legacyRole.id).activeSessionId
  const legacyRef = legacyAfter.find(line => changesProbe ? line.kind === 'changes' : line.phase === 'end' && line.presentation.entityId === 'terminal').presentation.details.ref
  const legacyFull = await api('stream-detail', { profile: legacyRole.id, session: legacySession, ref: legacyRef })
  if (changesProbe) assert.equal(legacyFull.body.files.length, 10)
  else assert.ok(legacyFull.body.outputText.endsWith('ES03_FULL_DETAIL_END'))
  const denied = await post('nodo', { endpoint: 'stream-detail', payload: { profile: legacyRole.id, session: legacySession, ref: terminal.details.ref } })
  assert.equal(denied.ok, false)
  assert.equal(unexpectedModelCalls, 0, 'This check must never call a model endpoint')
  detailFile = join(home, 'nodo', 'stream-details', `${terminal.details.ref}.json`)
  facts = { result: 'passed', login: `${relayUrl}/login`, relay: relayUrl, host: url, nativeSession: opened.sessionId, legacyProfile: legacyRole.id,
    legacySession, legacyRef, workspace: workspace.id, changesProbe, checks: ['native meta', 'bounded model content', 'full detail', 'native restart replay', 'legacy restart replay', 'owner rejection'], modelCalls: unexpectedModelCalls }
  console.log(JSON.stringify(facts))
  if (process.argv.includes('--serve')) await new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve)
    process.stdin.resume(); process.stdin.once('data', resolve)
  })
} finally {
  process.stdin.pause()
  await stop(); await new Promise(resolve => relay.close(resolve)); rmSync(home, { recursive: true, force: true })
}
