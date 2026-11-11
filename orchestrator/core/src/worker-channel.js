import { createServer } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerMcp, workerServer } from '../../agent-drivers/dist/worker-mcp.js'
import { leadModeOf } from '../shared/lead.js'
import { invalid } from './errors.js'

export function install(rt) {
  const tokens = new Map(), credentials = new Map(), clients = new Set()
  let server, directory, socket, starting, closed = false
  const current = token => {
    const id = tokens.get(token), found = id && rt.conversationOf(id)
    if (closed || !found || leadModeOf(found.profile, found.session) || found.profile.deletedAt || found.session.archivedAt) throw invalid('无效或已撤销的 worker 凭据')
    if (rt.readOnly?.()) throw invalid('Nodo 当前只读')
    rt.assertSessionWritable(found.profile, found.session)
    const execution = Object.values(rt.state.executions).find(item => item.sessionId === id && item.status === 'running')
    if (!execution) throw invalid('worker 会话当前没有在跑的执行')
    return execution
  }
  const handle = async request => {
    const execution = current(request.token), args = request.arguments ?? {}
    if (request.name === 'nodo_report') return rt.workerReport(execution, args)
    if (request.name !== 'nodo_context') throw invalid('未知 worker 工具')
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['action', 'sourceId', 'executionId', 'offset', 'limit'].includes(key))) throw invalid('包含不支持的参数')
    const task = rt.state.tasks[execution.taskId], handles = new Set([...(execution.historyHandles ?? []), ...(execution.contextHandles ?? [])])
    const own = Object.values(rt.state.executions).filter(item => item.taskId === task.id)
    for (const item of own) {
      handles.add(`execution:${item.id}:result`)
      handles.add(`report:${item.reportData?.id ?? item.id}`)
      handles.add(`evidence:${item.id}`)
      for (const id of [item.triggerId, ...(item.supplements ?? [])]) {
        const trigger = rt.state.triggers[id]
        if (trigger?.handle) handles.add(trigger.handle)
      }
      for (const line of rt.transcriptOf(item.sessionId)) {
        if (line.at >= item.startedAt && (item.endedAt == null || line.at <= item.endedAt) && line.kind === 'text') handles.add(rt.messageSourceId(item.sessionId, line))
      }
    }
    for (const id of [task.triggerId, execution.triggerId, ...(execution.supplements ?? [])]) {
      const trigger = rt.state.triggers[id]
      if (trigger?.handle) handles.add(trigger.handle)
    }
    if (args.action === 'list') {
      if (Object.keys(args).some(key => key !== 'action')) throw invalid('list 不接受其他参数')
      return { items: [...handles].map(sourceId => ({ sourceId })) }
    }
    if (args.action !== 'read' || (args.sourceId !== undefined) === (args.executionId !== undefined)) throw invalid('read 必须且只能指定 sourceId 或 executionId')
    const sourceId = args.sourceId ?? `execution:${args.executionId}:result`
    if (!handles.has(sourceId)) throw invalid('句柄不在本工作项或白名单内')
    return rt.executionContext(task.coordinatorSessionId, { ...args, sourceId, executionId: undefined })
  }
  const answer = async request => {
    let result
    try { result = { content: [{ type: 'text', text: JSON.stringify(await handle(request)) }] } }
    catch (error) { result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: error.code ?? 'orch/invalid', message: error.message }) }] } }
    let body = JSON.stringify(result)
    for (const token of new Set([...tokens.keys(), request.token].filter(value => typeof value === 'string' && value))) body = body.replaceAll(token, '[redacted]')
    return rt.redactDeepSecrets(body)
  }
  const start = () => starting ??= (async () => {
    const root = join(rt.home, 'runtime')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    directory = mkdtempSync(join(root, 'worker-'))
    socket = join(directory, 'rpc.sock')
    if (Buffer.byteLength(socket) >= (process.platform === 'darwin' ? 104 : 108)) {
      rmSync(directory, { recursive: true })
      directory = mkdtempSync('/tmp/nodo-worker-')
      socket = join(directory, 'rpc.sock')
    }
    chmodSync(directory, 0o700)
    server = createServer(client => {
      clients.add(client)
      client.setEncoding('utf8')
      client.setTimeout(30_000, () => client.destroy())
      client.on('close', () => clients.delete(client))
      client.on('error', () => {})
      let buffer = ''
      client.on('data', async chunk => {
        buffer += chunk
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          client.removeAllListeners('data')
          client.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: '请求超过 1MB 上限' }] }) + '\n')
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
  rt.issueWorkerMcp = async id => {
    await rt.load()
    const found = rt.conversationOf(id)
    if (!found || leadModeOf(found.profile, found.session)
      || !Object.values(rt.state.executions).some(item => item.sessionId === id && ['queued', 'running'].includes(item.status))) return
    if (closed || rt.readOnly?.()) throw invalid('Nodo 当前不能开启 worker 通道')
    let token
    const served = await rt.serveMcp?.(() => workerServer(async (name, args) => JSON.parse(await answer({ token, name, arguments: args })))).catch(() => undefined)
    if (!served) await start()
    token = randomBytes(32).toString('hex')
    tokens.set(token, id)
    rt.retireValue?.(token, 'NODO_WORKER_TOKEN')
    const tokenFile = served ? undefined : join(directory, createHash('sha256').update(id).digest('hex') + '.token')
    if (tokenFile) writeFileSync(tokenFile, token, { mode: 0o600 })
    const previous = credentials.get(id)
    if (previous) tokens.delete(previous)
    credentials.set(id, token)
    return { servers: served ? [{ name: 'nodo_worker', url: served.url, token: served.token }] : workerMcp(socket, tokenFile), revoke: () => {
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
  }, 'nodo: worker channel')
}
