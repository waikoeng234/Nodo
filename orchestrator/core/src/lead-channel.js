import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { leadMcp } from '../../agent-drivers/dist/lead-mcp.js'
import { leadModeOf } from '../shared/lead.js'

export function install(rt) {
  const tokens = new Map(), clients = new Set()
  let server, directory, socket, starting, closed = false
  const caller = token => {
    if (closed) throw new Error('Nodo 主控通道已关闭')
    if (rt.readOnly?.()) throw new Error('Nodo 当前只读')
    const id = tokens.get(token), found = id && rt.conversationOf(id)
    if (!found || !leadModeOf(found.profile, found.session) || found.profile.deletedAt || found.session.archivedAt) throw new Error('无效或已撤销的主控凭据')
    rt.assertSessionWritable(found.profile, found.session)
    return id
  }
  const handle = async request => {
    const id = caller(request.token), args = request.arguments ?? {}
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象')
    const allowed = { nodo_board: ['table', 'session'], nodo_delegate: ['type', 'hard', 'task', 'session'], nodo_interrupt: ['session'] }[request.name]
    if (!allowed) throw new Error('未知主控工具')
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('包含不支持的参数')
    if (args.session !== undefined && (typeof args.session !== 'string' || !args.session.trim())) throw new Error('session 必须是非空字符串')
    if (request.name === 'nodo_board') {
      if (args.table !== undefined && !['roles', 'delegations'].includes(args.table)) throw new Error('table 必须是 roles 或 delegations')
      if (args.table === 'roles' && args.session !== undefined) throw new Error('roles 表不能同时指定 session')
      return args.table === 'roles' ? rt.leadRoles(id) : rt.leadDelegations(id, args.session)
    }
    if (request.name === 'nodo_delegate') return rt.leadDispatch.delegate(id, args)
    if (!args.session) throw new Error('session 必须是非空字符串')
    return rt.leadDispatch.interrupt(id, args.session)
  }
  const start = () => starting ??= (async () => {
    await rt.load()
    if (closed || rt.readOnly?.()) throw new Error('Nodo 当前不能开启主控通道')
    const root = join(rt.home, 'runtime')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    directory = mkdtempSync(join(root, 'lead-'))
    socket = join(directory, 'rpc.sock')
    if (Buffer.byteLength(socket) >= (process.platform === 'darwin' ? 104 : 108)) {
      rmSync(directory, { recursive: true })
      directory = mkdtempSync('/tmp/nodo-lead-')
      socket = join(directory, 'rpc.sock')
    }
    chmodSync(directory, 0o700)
    server = createServer(client => {
      client.setEncoding('utf8')
      client.setTimeout(30_000, () => client.destroy())
      clients.add(client)
      client.on('close', () => clients.delete(client))
      client.on('error', () => {})
      let buffer = ''
      client.on('data', async chunk => {
        buffer += chunk
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          client.removeAllListeners('data')
          client.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: '请求超过 1MB 上限' }] }) + '\n', () => client.destroy())
          return
        }
        if (!buffer.includes('\n')) return
        client.removeAllListeners('data')
        let request, result
        try {
          request = JSON.parse(buffer.split('\n', 1)[0])
          const value = await handle(request)
          result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
        } catch (error) { result = { isError: true, content: [{ type: 'text', text: request ? String(error.message) : '无效请求' }] } }
        let text = JSON.stringify(result)
        for (const token of new Set([...tokens.keys(), request?.token].filter(value => typeof value === 'string' && value))) text = text.replaceAll(token, '[redacted]')
        client.end(rt.redactDeepSecrets(text) + '\n')
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    chmodSync(socket, 0o600)
  })()
  rt.issueLeadMcp = async id => {
    const found = rt.conversationOf(id)
    if (!leadModeOf(found?.profile, found?.session)) return undefined
    if (closed) throw new Error('Nodo 主控通道已关闭')
    try { await start() } catch (error) {
      if (closed) throw error
      server?.close()
      if (directory) rmSync(directory, { recursive: true, force: true })
      starting = undefined
      rt.warn('nodo: lead channel unavailable; continuing without nodo_lead')
      return undefined
    }
    const token = randomBytes(32).toString('hex')
    tokens.set(token, id)
    // A Bash `env` inside the lead session would echo the token into a tool result,
    // so the host redactor learns it for the token's whole life, revoke included.
    rt.retireValue?.(token, 'NODO_LEAD_TOKEN')
    try { caller(token) } catch (error) { tokens.delete(token); throw error }
    return { servers: leadMcp(socket, token), revoke: () => tokens.delete(token) }
  }
  rt.ctx.effect(() => () => {
    closed = true
    tokens.clear()
    for (const client of clients) client.destroy()
    server?.close()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }, 'nodo: lead channel')
}
