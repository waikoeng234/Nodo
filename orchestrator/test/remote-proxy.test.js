import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
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
  const stop = await startMobileProxy(origin, mobileOrigin, 43820)
  t.after(stop)

  const read = (path = '/', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 43820, path, headers, method }, response => {
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
  const ws = new WebSocket('ws://127.0.0.1:43820/ws', { headers })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  ws.send('fixture')
  const [value] = await once(ws, 'message')
  assert.equal(value.toString(), 'fixture')
  ws.close()
  await once(ws, 'close')
})
