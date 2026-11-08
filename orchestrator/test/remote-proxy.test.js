import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { startMobileProxy } from '../remote-access/proxy.js'

test('mobile gateway preserves authentication, streams, and WebSockets', { skip: process.platform !== 'darwin' }, async t => {
  const mobileOrigin = 'https://fixture.tail0000.ts.net'
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie })
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"first":true}\n')
      setTimeout(() => res.end('{"last":true}\n'), 300)
    } else {
      res.writeHead(req.url === '/login' ? 303 : 200, {
        'set-cookie': 'fixture=value; Path=/; HttpOnly; SameSite=Strict',
        ...(req.url === '/login' ? { location: './' } : {}),
      })
      res.end('ok')
    }
  })
  const wsServer = new WebSocketServer({ server: upstream, path: '/ws' })
  wsServer.on('connection', socket => socket.on('message', value => socket.send(value)))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => { wsServer.close(); upstream.closeAllConnections(); upstream.close() })
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const { port, stop } = await startMobileProxy(origin, mobileOrigin)
  t.after(stop)
  assert.notEqual(port, 43819)

  const read = (path = '/', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, method }, response => {
      let text = ''
      let firstAt
      const startedAt = Date.now()
      response.on('data', value => { firstAt ??= Date.now() - startedAt; text += value })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, firstAt, duration: Date.now() - startedAt }))
    })
    req.on('error', reject)
    req.end()
  })
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await read(); ready = true; break } catch {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  assert(ready, 'Apache did not start')
  const headers = { host: new URL(mobileOrigin).host, origin: mobileOrigin, cookie: 'fixture=value' }
  const result = await read('/', headers)
  assert.equal(result.status, 200)
  assert.match(result.headers['set-cookie'][0], /; Secure$/)
  assert.equal(result.headers['referrer-policy'], 'no-referrer')
  assert.deepEqual(seen.at(-1), { host: new URL(origin).host, origin, cookie: 'fixture=value' })
  const login = await read('/login', headers)
  assert.equal(login.status, 303)
  assert.match(login.headers['set-cookie'][0], /; Secure$/)
  assert.equal(login.headers.location, './')
  assert.equal((await read('/', { ...headers, host: 'other.invalid' })).status, 403)
  assert.equal((await read('/', { ...headers, origin: 'https://other.invalid' })).status, 403)
  assert.equal((await read('/', { ...headers, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await read('/', { ...headers, host: `${new URL(mobileOrigin).host}:443`, origin: `${mobileOrigin}:443` })).status, 200)
  const navigation = { ...headers, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  assert.equal((await read('/?fixture=1', navigation)).status, 200)
  assert.equal((await read('/api/nodo/live', navigation)).status, 403)
  assert.equal((await read('/', navigation, 'POST')).status, 403)
  const stream = await read('/stream', headers)
  assert.equal(stream.text, '{"first":true}\n{"last":true}\n')
  assert(stream.duration >= 200)
  assert(stream.firstAt < 150, 'initial stream chunk was buffered')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  ws.send('fixture')
  const [value] = await once(ws, 'message')
  assert.equal(value.toString(), 'fixture')
  ws.close()
  await once(ws, 'close')
})

const crashedHost = async (upstream, mobileOrigin) => {
  const before = new Set(readdirSync(tmpdir()))
  const crashed = spawn(process.execPath, ['--input-type=module', '-e', `
    const { startMobileProxy } = await import(${JSON.stringify(new URL('../remote-access/proxy.js', import.meta.url).href)})
    console.log((await startMobileProxy(${JSON.stringify(upstream)}, ${JSON.stringify(mobileOrigin)})).port)`], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = Number(String((await once(crashed.stdout, 'data'))[0]))
  crashed.kill('SIGKILL')
  await once(crashed, 'exit')
  const name = readdirSync(tmpdir()).find(name => name.startsWith('nodo-mobile-') && !before.has(name))
  return { port, directory: join(tmpdir(), name) }
}

test('a proxy orphaned by a crashed host is replaced while other processes survive', { skip: process.platform !== 'darwin' }, async t => {
  const mobileOrigin = 'https://fixture.tail0000.ts.net'
  const upstream = 'http://127.0.0.1:9'
  const answers = port => fetch(`http://127.0.0.1:${port}/`, { headers: { host: new URL(mobileOrigin).host }, signal: AbortSignal.timeout(1000) })
    .then(response => response.headers.has('x-nodo-remote-instance'), () => false)
  const alive = pid => spawnSync('/bin/ps', ['-p', String(pid)]).status === 0

  const live = await startMobileProxy(upstream, mobileOrigin)
  t.after(live.stop)
  const decoy = mkdtempSync(join(tmpdir(), 'nodo-mobile-'))
  const decoyPid = Number(String(spawnSync('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout).trim())
  writeFileSync(join(decoy, 'httpd.pid'), String(decoyPid))
  t.after(() => { process.kill(decoyPid); rmSync(decoy, { recursive: true, force: true }) })

  const { port } = await crashedHost(upstream, mobileOrigin)
  assert(await answers(port), 'orphaned proxy should still be listening')

  const next = await startMobileProxy(upstream, mobileOrigin, port)
  t.after(next.stop)
  assert.equal(next.port, port)
  assert(await answers(port))
  assert(await answers(live.port))
  assert(alive(decoyPid))
})

test('one leftover that cannot be cleaned or inspected does not block a new proxy', { skip: process.platform !== 'darwin' }, async t => {
  const mobileOrigin = 'https://fixture.tail0000.ts.net'
  const upstream = 'http://127.0.0.1:9'
  const stale = mkdtempSync(join(tmpdir(), 'nodo-mobile-'))
  writeFileSync(join(stale, 'httpd.pid'), String(spawnSync('/usr/bin/true').pid))
  t.after(() => rmSync(stale, { recursive: true, force: true }))
  const { port, directory } = await crashedHost(upstream, mobileOrigin)
  chmodSync(directory, 0o500)
  t.after(() => { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }) })

  const next = await startMobileProxy(upstream, mobileOrigin, port)
  t.after(next.stop)
  assert.equal(next.port, port)
  assert(existsSync(stale))
})
