import { createServer } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leadMcp, leadServer } from '../../agent-drivers/dist/lead-mcp.js'
import { leadModeOf } from '../shared/lead.js'

export function install(rt) {
  const tokens = new Map(), credentials = new Map(), clients = new Set()
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
    const allowed = { nodo_context: ['action', 'taskId', 'query', 'cursor', 'sourceId', 'executionId', 'offset', 'limit'], nodo_decision: ['taskIds', 'executionIds', 'questions', 'references', 'stopExecutionIds'], nodo_board: ['table', 'session', 'taskId', 'decisionId'], nodo_delegate: ['type', 'hard', 'task', 'title', 'continues', 'taskId', 'worktree', 'parentId', 'dependsOn', 'context'], nodo_interrupt: ['session', 'executionId'], nodo_task: ['taskId', 'action', 'executionId', 'executionIds', 'disposition', 'reason', 'basis', 'references', 'title', 'brief', 'parentId', 'dependsOn'] }[request.name]
    if (!allowed) throw new Error('未知主控工具')
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('包含不支持的参数')
    if (request.name === 'nodo_context') return rt.executionContext(id, args)
    await rt.decisionDeliveryReady?.(id)
    if (request.name === 'nodo_decision') return rt.createDecision(id, args)
    for (const key of ['session', 'continues', 'taskId', 'executionId', 'decisionId']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} 必须是非空字符串`)
    if (args.parentId !== undefined && (typeof args.parentId !== 'string' || (!args.parentId.trim() && !(request.name === 'nodo_task' && args.action === 'revise' && args.parentId === '')))) throw new Error(request.name === 'nodo_delegate' ? 'parentId 必须是非空字符串' : 'parentId 必须是非空字符串；revise 可用空字符串清空')
    if (args.dependsOn !== undefined && (!Array.isArray(args.dependsOn) || args.dependsOn.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('dependsOn 必须是非空字符串数组')
    if (request.name === 'nodo_board') {
      if (args.table !== undefined && !['roles', 'delegations', 'tasks', 'decisions'].includes(args.table)) throw new Error('table 必须是 roles、delegations、tasks 或 decisions')
      if (args.table === 'decisions' || args.decisionId !== undefined) {
        if (args.session !== undefined || args.taskId !== undefined || (args.table !== undefined && args.table !== 'decisions')) throw new Error('decisions 不能同时指定 session、taskId 或其他 table')
        if (args.decisionId !== undefined) return rt.getDecision(id, args.decisionId)
        const decisions = rt.listDecisions(id)
        const recent = new Set(decisions.filter(item => !['pending', 'answered'].includes(item.status)).slice(-10).map(item => item.id))
        return decisions.filter(item => ['pending', 'answered'].includes(item.status) || recent.has(item.id))
          .map(({ id, status, taskIds, sourceExecutionIds, createdAt }) => ({ id, status, taskIds, sourceExecutionIds, createdAt }))
      }
      if (args.taskId !== undefined && args.table !== undefined && args.table !== 'tasks') throw new Error('taskId 只能查询 tasks')
      if (args.table === 'tasks' || args.taskId !== undefined) {
        if (args.session !== undefined) throw new Error('tasks 不能同时指定 session')
        return rt.leadTasks(id, args.taskId)
      }
      if (args.table === 'roles' && args.session !== undefined) throw new Error('roles 表不能同时指定 session')
      return args.table === 'roles' ? rt.leadRoles(id) : rt.leadDelegations(id, args.session)
    }
    if (request.name === 'nodo_delegate') return rt.leadDispatch.delegate(id, args)
    if (request.name === 'nodo_task') return rt.leadTask(id, args)
    if ((args.session !== undefined) === (args.executionId !== undefined)) throw new Error('session 和 executionId 必须且只能指定一个')
    return rt.leadDispatch.interrupt(id, args)
  }
  const answer = async request => {
    let result
    try {
      const value = await handle(request)
      result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
    } catch (error) { result = { isError: true, content: [{ type: 'text', text: ['orch/decision-pending', 'orch/report-unreviewed'].includes(error.code)
      ? JSON.stringify({ code: error.code, decisionId: error.decisionId, reports: error.reports, message: error.message }) : String(error.message) }] } }
    let text = JSON.stringify(result)
    for (const token of new Set([...tokens.keys(), request.token].filter(value => typeof value === 'string' && value))) text = text.replaceAll(token, '[redacted]')
    return rt.redactDeepSecrets(text)
  }
  const unavailable = { isError: true, content: [{ type: 'text', text: 'Nodo 本地通道不可用、超时或响应无效' }] }
  const call = request => new Promise(resolve => {
    const timer = setTimeout(() => resolve(unavailable), 25_000)
    answer(request).then(text => JSON.parse(text), () => unavailable).then(result => { clearTimeout(timer); resolve(result) })
  })
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
        let request
        try { request = JSON.parse(buffer.split('\n', 1)[0]) } catch {}
        client.end((request ? await answer(request) : JSON.stringify({ isError: true, content: [{ type: 'text', text: '无效请求' }] })) + '\n')
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    chmodSync(socket, 0o600)
  })()
  rt.issueLeadMcp = async id => {
    const found = rt.conversationOf(id)
    if (!leadModeOf(found?.profile, found?.session)) return undefined
    if (closed) throw new Error('Nodo 主控通道已关闭')
    let token, served
    await rt.load()
    if (!closed && !rt.readOnly?.()) served = await rt.serveMcp?.(() => leadServer((name, args) => call({ token, name, arguments: args }))).catch(() => undefined)
    if (!served) try { await start() } catch (error) {
      if (closed) throw error
      server?.close()
      if (directory) rmSync(directory, { recursive: true, force: true })
      starting = undefined
      rt.warn('nodo: lead channel unavailable; continuing without nodo_lead')
      return undefined
    }
    token = randomBytes(32).toString('hex')
    tokens.set(token, id)
    // A Bash `env` inside the lead session would echo the token into a tool result,
    // so the host redactor learns it for the token's whole life, revoke included.
    rt.retireValue?.(token, 'NODO_LEAD_TOKEN')
    try { caller(token) } catch (error) { tokens.delete(token); served?.close(); throw error }
    const tokenFile = served ? undefined : join(directory, createHash('sha256').update(id).digest('hex') + '.token')
    if (tokenFile) try { writeFileSync(tokenFile, token, { mode: 0o600 }) } catch (error) { tokens.delete(token); throw error }
    const previous = credentials.get(id)
    if (previous) tokens.delete(previous)
    credentials.set(id, token)
    return { servers: served ? [{ name: 'nodo_lead', url: served.url, token: served.token }] : leadMcp(socket, '', tokenFile), revoke: () => {
      tokens.delete(token)
      served?.close()
      if (credentials.get(id) !== token) return
      credentials.delete(id)
      if (tokenFile) rmSync(tokenFile, { force: true })
    } }
  }
  rt.ctx.effect(() => () => {
    closed = true
    tokens.clear()
    credentials.clear()
    for (const client of clients) client.destroy()
    server?.close()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }, 'nodo: lead channel')
}
