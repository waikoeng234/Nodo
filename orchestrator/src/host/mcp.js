import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const BODY_MAX = 1024 * 1024
const reply = (response, status, message) => response.writeHead(status, { 'content-type': 'application/json' })
  .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))

// One loopback MCP endpoint for every engine session; each mount has its own
// bearer token and only reaches the server it was registered with.
export function install(rt) {
  const services = new Map()
  let http, listening, Transport, closed = false
  const read = request => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => { size += chunk.length; if (size <= BODY_MAX) chunks.push(chunk) })
    request.on('end', () => {
      if (size > BODY_MAX) return reject(Object.assign(new Error('Request exceeds 1MB'), { status: 413 }))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
    request.on('error', reject)
  })
  const handle = async (request, response) => {
    // Browsers resolving a rebinding hostname still send that hostname here.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host ?? '')) return reply(response, 403, 'Forbidden')
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/mcp') return reply(response, 404, 'Not found')
    const service = services.get(/^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1])
    if (!service) return reply(response, 401, 'Unauthorized')
    let body
    if (request.method === 'POST') {
      try { body = await read(request) } catch (error) { return reply(response, error.status ?? 400, error.message) }
    }
    const id = request.headers['mcp-session-id']
    let transport = id ? service.transports.get(id) : undefined
    if (id && !transport) return reply(response, 404, 'Session not found')
    if (!transport) {
      if (request.method !== 'POST' || body?.method !== 'initialize') return reply(response, 400, 'Session required')
      transport = new Transport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: session => { service.transports.set(session, transport) },
        onsessionclosed: session => { service.transports.delete(session) } })
      try { await (await service.create()).connect(transport) } catch { return reply(response, 500, 'Server unavailable') }
    }
    await transport.handleRequest(request, response, body)
  }
  const start = () => listening ??= import('@modelcontextprotocol/sdk/server/streamableHttp.js').then(sdk => new Promise((resolve, reject) => {
    if (closed) throw new Error('Nodo MCP endpoint closed')
    Transport = sdk.StreamableHTTPServerTransport
    http = createServer((request, response) => {
      handle(request, response).catch(() => { if (!response.headersSent) reply(response, 500, 'Internal error') })
    })
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${http.address().port}/mcp`))
  })).catch(error => {
    http?.close()
    listening = undefined
    if (!closed) rt.warn('nodo: MCP endpoint unavailable; engines use MCP child processes: %s', error.message)
    throw error
  })
  rt.serveMcp = async create => {
    if (closed) throw new Error('Nodo MCP endpoint closed')
    const url = await start()
    const token = randomBytes(32).toString('hex')
    rt.retireValue?.(token, 'NODO_MCP_TOKEN')
    const service = { create, transports: new Map() }
    services.set(token, service)
    return { url, token, close: () => {
      if (services.get(token) !== service) return
      services.delete(token)
      for (const transport of service.transports.values()) void transport.close().catch(() => {})
    } }
  }
  rt.ctx.effect(() => () => {
    closed = true
    for (const service of services.values()) for (const transport of service.transports.values()) void transport.close().catch(() => {})
    services.clear()
    http?.close()
    http?.closeAllConnections()
  }, 'nodo: MCP endpoint')
}
