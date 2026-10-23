// ES-08 isolated-host check: confirmed tool media must be saved as bounded
// resource metadata plus attachment references, displayed from the saved view,
// survive a restart, and never expose raw image bytes to transcripts, detail
// files, native metadata or the model-facing tool result.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findDshExecutable } from '../agent-drivers/src/dsh/config.js'

const executable = findDshExecutable()
assert.ok(executable, 'Install DSH before running this check')
const runtime = createRequire(realpathSync(executable))
const WebSocket = runtime('ws')
const sharp = runtime('sharp')
const { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-api-gateway/stream-protocol')))

const home = mkdtempSync(join(tmpdir(), 'nodo-es08-'))
const pixels = Buffer.alloc(96 * 64 * 3)
for (let index = 0; index < 96 * 64; index += 1) {
  const blue = index % 96 >= 48
  pixels[index * 3] = blue ? 40 : 220
  pixels[index * 3 + 1] = 40
  pixels[index * 3 + 2] = blue ? 220 : 40
}
const PNG = (await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer()).toString('base64')
const nativePixels = Buffer.alloc(96 * 64 * 3)
for (let index = 0; index < 96 * 64; index += 1) {
  const yellow = index % 96 >= 48
  nativePixels[index * 3] = yellow ? 230 : 40
  nativePixels[index * 3 + 1] = 200
  nativePixels[index * 3 + 2] = yellow ? 40 : 80
}
const NATIVE_PNG = (await sharp(nativePixels, { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer()).toString('base64')
const nativeRefFile = join(home, 'native-ref.json')
const plugin = join(home, 'fixture')
const cwd = join(home, 'workspace')
mkdirSync(plugin)
mkdirSync(cwd)
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'nodo-es08-fixture', version: '0.0.0', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './package.json': './package.json' } }))
const drivers = new URL('../agent-drivers/src/index.js', import.meta.url).href
writeFileSync(join(plugin, 'index.js'), `
import { writeFileSync } from 'node:fs'
import { registerEngine } from ${JSON.stringify(drivers)}
const PNG = ${JSON.stringify(PNG)}
const NATIVE_PNG = ${JSON.stringify(NATIVE_PNG)}
const nativeRefFile = ${JSON.stringify(nativeRefFile)}
const snapshot = { version: 1, kind: 'tool', mode: 'snapshot', body: {} }
let nativeRef
export const inject = ['attachments']
export async function apply(ctx) {
  try {
    const [saved] = await ctx.attachments.saveImages([{ data: Buffer.from(NATIVE_PNG, 'base64'), mediaType: 'image/png', name: 'native-shot.png' }])
    nativeRef = saved
    writeFileSync(nativeRefFile, JSON.stringify({ ref: saved }))
  } catch (error) {
    writeFileSync(nativeRefFile, JSON.stringify({ error: String(error?.message ?? error) }))
  }
}
registerEngine('codex', {
  info: { id: 'codex', label: 'ES08 media fixture', requiresCwd: true },
  validate: value => value, check: async () => ({ ok: true, checks: [] }),
  scan: async () => ({ source: 'local-fixture', defaultModel: 'es08-fixture', models: [{ id: 'es08-fixture' }] }),
  create: ({ onEvent }) => {
    let ready = false
    return { instructionMode: 'native', hasSession: () => ready, onEvent() {}, dispose() {},
      async openSession({ sessionId } = {}) { ready = true; onEvent({ type: 'session', state: 'ready', sessionId: sessionId ?? 'es08-engine-session' }) },
      async steer() { return 'refused' }, async interruptTurn() {}, async respondToRequest() {},
      async sendTurn() {
        if (!nativeRef) throw new Error('ES08 fixture attachment is not ready')
        onEvent({ type: 'turn/start', turnId: 'es08-turn' })
        onEvent({ type: 'tool', name: 'Read image', callId: 'media', phase: 'start', presentation: snapshot, input: { path: '/tmp/shot.png' } })
        onEvent({ type: 'tool', name: 'Read image', callId: 'media', phase: 'end', presentation: snapshot,
          output: [
            { type: 'text', text: '图片如下' },
            { type: 'image', mimeType: 'image/png', data: PNG, name: 'shot.png' },
            { type: 'image', attachment: nativeRef },
            { type: 'content', content: { type: 'resource_link', name: 'notes.txt', uri: 'file:///workspace/notes.txt', mimeType: 'text/plain', size: 12 } },
            { type: 'resource', resource: { uri: 'file:///workspace/inner.txt', mimeType: 'text/plain', text: 'embedded text' } },
            { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
            { type: 'image', mimeType: 'image/svg+xml', data: '<svg/>' },
            { type: 'image', attachment: { attachmentId: 'sha256:${'0'.repeat(64)}', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } },
            { type: 'image', mimeType: 'image/png', data: Buffer.from(PNG, 'base64').subarray(0, 150).toString('base64') },
          ] })
        onEvent({ type: 'tool', name: 'Plain tool', callId: 'plain', phase: 'start', presentation: snapshot, input: 'echo old' })
        onEvent({ type: 'tool', name: 'Plain tool', callId: 'plain', phase: 'end', presentation: snapshot, outputText: '旧记录输出' })
        onEvent({ type: 'turn/end', reason: 'done' })
      } }
  },
})
`)
const relay = createServer((request, response) => {
  if (request.url === '/login') { response.writeHead(302, { 'Set-Cookie': cookies, Location: url }); response.end(); return }
  if (request.url === '/facts') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(facts)); return }
  unexpectedModelCalls += 1
  response.writeHead(503); response.end('ES08 fixture has no remote model')
})
relay.listen(0, '127.0.0.1')
await once(relay, 'listening')
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const url = `http://127.0.0.1:${port}`
const relayUrl = `http://127.0.0.1:${relay.address().port}`
const patch = join(home, 'es08.patch.json')
writeFileSync(patch, JSON.stringify([
  { id: 'llm-deepseek', config: { baseURL: relayUrl, apiKeyEnv: 'NODO_ES08_FIXTURE_KEY' } },
  { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'nodo-es08-fixture', name: join(plugin, 'index.js') },
    { id: 'nodo', name: fileURLToPath(new URL('../index.js', import.meta.url)), config: { home: join(home, 'nodo') } }] },
]))
let cookie, cookies = [], child, log = '', facts, unexpectedModelCalls = 0
const start = () => {
  log = ''
  child = spawn(executable, ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, NODO_ES08_FIXTURE_KEY: 'local-fixture-only' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  throw new Error('ES08 isolated-host check timed out; raw log withheld')
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
  const { result } = await post(method, { type: 'client-request', rpcId: 'es08-check', method, payload: { args } })
  assert.equal(result?.ok, true, `Native ${method} failed (${result?.error?.code})`)
  return result.value
}
const observe = async sessionId => {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}${REMOTE_STREAM_MUX_PATH}`, { headers: { Origin: url, Cookie: cookie } })
  const frames = []
  socket.on('error', () => {})
  socket.on('message', data => { frames.push(parseRemoteStreamServerMessage(data.toString())) })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId: 'es08', endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } }))
  await until(() => frames.some(frame => frame.type === 'item' && frame.value.type === 'snapshot'))
  return { frames, close: () => socket.terminate() }
}
const findRecords = value => {
  if (!value || typeof value !== 'object') return []
  if (value.nodoRecord) return [value.nodoRecord]
  return Object.values(value).flatMap(findRecords)
}
const PREVIEW_RESOURCES = [['image', 'stored'], ['image', 'stored'], ['link', 'reference'], ['text', 'reference']]
const FULL_RESOURCES = [...PREVIEW_RESOURCES, ['audio', 'unsupported'], ['image', 'unsupported'], ['image', 'unavailable'], ['image', 'unavailable']]
let nativeRef
const assertMedia = (record, label, full = false, scoped = false) => {
  assert.equal(record.body.outputText, '图片如下\nembedded text', `${label} keeps text and embedded text readable`)
  const expected = (full ? FULL_RESOURCES : PREVIEW_RESOURCES).map(([kind, state], index) => [kind, index === 1 && !scoped ? 'unavailable' : state])
  assert.deepEqual(record.body.resources.map(item => [item.kind, item.state]), expected,
    `${label} declares supported and degraded resources within its display budget`)
  assert.equal(record.body.resources[0].ref.mediaType, 'image/png')
  if (scoped) assert.equal(record.body.resources[1].ref.mediaType, 'image/png')
  else assert.equal(record.body.resources[1].reason, 'attachment-unavailable', `${label} refuses an unowned host reference`)
  if (full) {
    assert.equal(record.body.resources[1].bytes, nativeRef.bytes, `${label} keeps the verified native attachment size`)
    assert.equal(record.body.resources[6].reason, 'attachment-unavailable')
    assert.equal(record.body.resources[7].reason, 'invalid-image', `${label} refuses truncated PNG bytes through the public decoder`)
  }
  assert.doesNotMatch(JSON.stringify(record), /iVBORw0KGgo/, `${label} never carries inline image bytes`)
}
try {
  start()
  await authorize()
  await until(async () => (await api('state')).readOnly == null)
  await until(() => existsSync(nativeRefFile))
  const savedNative = JSON.parse(readFileSync(nativeRefFile, 'utf8'))
  assert.ok(savedNative.ref?.attachmentId, `fixture native attachment failed: ${savedNative.error ?? 'no reference'}`)
  nativeRef = savedNative.ref
  assert.deepEqual([nativeRef.width, nativeRef.height], [96, 64], 'the fixture attachment carries verified dimensions')
  assert.equal(nativeRef.name, 'native-shot.png')
  await api('engine-scan', { engine: 'codex' })
  const workspace = await api('workspace-create', { name: 'ES08 media workspace', cwd })
  const role = await api('profile-create', { name: 'ES08 Media fixture', engine: 'codex', workspace: workspace.id, model: 'es08-fixture' })
  await api('send', { profile: role.id, text: 'ES08_MEDIA' })
  await until(async () => !(await api('state')).work[role.id]?.active)
  const legacyLines = await api('transcript', { profile: role.id })
  const legacy = legacyLines.find(line => line.callId === 'media' && line.phase === 'end').presentation
  assertMedia(legacy, 'legacy transcript')
  const plain = legacyLines.find(line => line.callId === 'plain' && line.phase === 'end').presentation
  assert.equal(plain.body.resources, undefined, 'a record without resources keeps the old shape')
  const legacyRef = legacy.body.resources[0].ref
  assert.deepEqual(await api('attachment', { id: legacyRef.id, mediaType: legacyRef.mediaType }), { mediaType: 'image/png', data: PNG })
  const legacySession = (await api('state')).profiles.find(item => item.id === role.id).activeSessionId
  const legacyDetail = await api('stream-detail', { profile: role.id, session: legacySession, ref: legacy.details.ref })
  assertMedia(legacyDetail, 'legacy saved detail', true)
  assert.equal(legacyDetail.body.resources[0].ref.id, legacyRef.id)
  assert.equal(legacyDetail.body.resources[1].ref, undefined, 'a legacy engine cannot read an arbitrary global host attachment')
  assert.equal(legacyDetail.body.resources[1].name, 'native-shot.png')
  assert.doesNotMatch(JSON.stringify(legacyDetail), /iVBORw0KGgo/)
  assert.doesNotMatch(readFileSync(join(home, 'nodo', 'state.json'), 'utf8'), /iVBORw0KGgo/, 'state.json keeps references only')

  const opened = await api('adapter-session-open', { profile: role.id, workspace: workspace.id })
  const observer = await observe(opened.sessionId)
  await native('session/prompt', { request: { requestId: 'es08-run', sessionId: opened.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'ES08_NATIVE_MEDIA' }, { type: 'image', mediaType: 'image/png', data: NATIVE_PNG, name: 'native-shot.png' }] } })
  await until(() => observer.frames.some(frame => frame.value?.event?.type === 'turn/end'))
  const records = findRecords(observer.frames)
  assert.equal(records.length, 2, 'native metadata carries both tools')
  const media = records.find(record => record.entityId === 'media')
  assertMedia(media, 'native engine_action', false, true)
  assert.equal(media.details.state, 'stored')
  assert.deepEqual(await api('attachment', { id: media.body.resources[0].ref.id, mediaType: 'image/png' }), { mediaType: 'image/png', data: PNG })
  assert.equal(Buffer.from((await api('attachment', { id: media.body.resources[1].ref.id, mediaType: 'image/png' })).data, 'base64').length,
    nativeRef.bytes, 'the native card points at the saved DSH image')
  const nativeDetail = await api('stream-detail', { target: opened.sessionId, ref: media.details.ref })
  assertMedia(nativeDetail, 'native saved detail', true, true)
  assert.equal(nativeDetail.body.resources[0].ref.id, media.body.resources[0].ref.id)
  assert.equal(nativeDetail.body.resources[1].ref.id, media.body.resources[1].ref.id)
  const resultFrames = observer.frames.filter(frame => frame.value?.event?.type === 'tool/result')
  assert.ok(!JSON.stringify(resultFrames.map(frame => frame.value.event.data.message.content)).includes(PNG.slice(0, 24)),
    'the model-facing tool result never receives raw image bytes')
  observer.close()

  await stop()
  start()
  await authorize()
  const restored = await observe(opened.sessionId)
  assert.deepEqual(findRecords(restored.frames), records, 'native replay keeps the exact saved references')
  restored.close()
  assert.deepEqual(await api('attachment', { id: legacyRef.id, mediaType: legacyRef.mediaType }), { mediaType: 'image/png', data: PNG })
  const restoredLines = await api('transcript', { profile: role.id, session: legacySession })
  const restoredMedia = restoredLines.find(line => line.callId === 'media' && line.phase === 'end').presentation
  assert.equal(restoredMedia.body.resources[0].ref.id, legacyRef.id, 'legacy transcript keeps the saved image reference')
  assert.equal(restoredMedia.body.resources[1].reason, 'attachment-unavailable', 'legacy restore preserves the ownership refusal')
  const restoredDetail = await api('stream-detail', { profile: role.id, session: legacySession, ref: restoredMedia.details.ref })
  assert.equal(restoredDetail.body.resources[0].ref.id, legacyRef.id)
  assert.equal(restoredDetail.body.resources[1].reason, 'attachment-unavailable')
  assert.equal(Buffer.from((await api('attachment', { id: media.body.resources[1].ref.id, mediaType: media.body.resources[1].ref.mediaType })).data, 'base64').length,
    nativeRef.bytes, 'restart keeps the saved native image bytes')
  assert.doesNotMatch(JSON.stringify(restoredLines), /iVBORw0KGgo/)
  assert.equal(unexpectedModelCalls, 0, 'this check must never call a model endpoint')
  facts = { result: 'passed', checkedAt: new Date().toISOString(), login: `${relayUrl}/login`, host: url, nativeSession: opened.sessionId,
    legacyProfile: role.id, legacySession, legacyRef: legacyRef.id, workspace: workspace.id,
    checks: ['legacy transcript resources', 'saved attachment bytes', 'session-scoped DSH native attachment and foreign-reference refusal', 'saved detail resources', 'no inline bytes in state',
      'native engine_action resources', 'bounded model-facing tool result', 'restart replay', 'restart legacy restore'],
    modelCalls: unexpectedModelCalls }
  console.log(JSON.stringify(facts))
  if (process.argv.includes('--serve')) {
    console.log(`ES08 UI ready: open ${relayUrl}/login, then the Nodo sidebar entry`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); process.stdin.resume(); process.stdin.once('data', resolve) })
  }
} finally {
  process.stdin.pause()
  await stop()
  await new Promise(resolve => relay.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
