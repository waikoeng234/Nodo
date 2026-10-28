import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'

const BUFFER_MAX = 256 * 1024
const INPUT_MAX = 1024 * 1024
const dimensions = ({ cols, rows }) => {
  if (![cols, rows].every(value => Number.isInteger(value) && value > 0 && value <= 32767)) throw new Error('Invalid terminal dimensions')
  return { cols, rows }
}
const describe = entry => ({ id: entry.id, cols: entry.cols, rows: entry.rows, shell: entry.shell, ...(entry.exited ? { exited: entry.exited } : {}) })
const notFound = () => Object.assign(new Error('Terminal not found'), { code: 'terminal/not-found' })

export function install(rt) {
  const { ctx } = rt
  const entries = new Map(), pending = new Set(), cleanup = new Set()
  let allocation = new AbortController(), subprocess
  let disposed = false
  const available = () => !disposed && typeof subprocess?.spawnTerminal === 'function'
  const notify = entry => { for (const wake of entry.listeners) wake(); entry.listeners.clear() }
  const terminate = entry => entry.closing ??= Promise.resolve().then(() => entry.handle.terminate()).then(() => {
    cleanup.delete(entry)
  }).catch(() => {
    entry.closing = undefined
    throw new Error('Terminal cleanup failed')
  })
  const close = entry => {
    if (entry.closed) return
    entries.delete(entry.id)
    entry.closed = true
    entry.buffer = Buffer.alloc(0)
    notify(entry)
    cleanup.add(entry)
    void terminate(entry).catch(() => {})
  }
  const active = entry => {
    const profile = rt.state.profiles[entry.profile]
    const session = profile && rt.sessionsOf(profile).find(session => session.id === entry.session)
    return session && !session.archivedAt && !profile.deletedAt
  }
  const sweep = async () => {
    for (const entry of entries.values()) if (!active(entry)) close(entry)
    await Promise.allSettled([...cleanup].map(terminate))
  }
  const terminateAll = async () => {
    allocation.abort()
    await Promise.allSettled([...pending])
    for (const entry of entries.values()) close(entry)
    await Promise.all([...cleanup].map(terminate))
  }
  // This Cordis version treats every static inject key as required.
  if (typeof ctx.inject === 'function') ctx.inject(['subprocess'], scoped => {
    subprocess = scoped.subprocess
    allocation = new AbortController()
    return async () => { subprocess = undefined; await terminateAll() }
  })
  else subprocess = ctx.subprocess
  for (const name of ['save', 'refresh']) {
    const original = rt[name]
    rt[name] = async (...args) => { const value = await original(...args); void sweep().catch(() => {}); return value }
  }
  const findEntry = ({ profile: ref, session: id, id: terminalId }) => {
    if (typeof ref !== 'string' || !ref || typeof id !== 'string' || !id) throw notFound()
    let conversation
    try { conversation = rt.conversation(ref, id) } catch { throw notFound() }
    const entry = entries.get(terminalId)
    if (!entry || entry.profile !== conversation.profile.id || entry.session !== conversation.session.id) throw notFound()
    return entry
  }

  const create = async body => {
    if (!available() || rt.readOnly() != null) throw new Error('Terminal unavailable')
    const { profile, session } = rt.conversation(body.profile, body.session)
    rt.assertSessionWritable(profile, session)
    const cwd = session.cwd ?? rt.sessionWorkspace(profile, session)?.cwd
    if (!cwd || !isAbsolute(cwd)) throw new Error('Workspace unavailable')
    const size = dimensions(body)
    const provider = subprocess, signal = allocation.signal
    const environment = await provider.terminalEnvironment?.(signal)
    const shell = environment?.defaultShell ?? process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const executable = await provider.resolveExecutable?.(shell, undefined, signal) ?? shell
    if (disposed || signal.aborted) throw new Error('Terminal unavailable')
    const terminal = await provider.spawnTerminal({ argv: [executable, '-l', '-i'], cwd, ...size,
      terminalType: 'xterm-256color', graceMs: 1500, signal })
    const entry = { id: randomUUID(), profile: profile.id, session: session.id, handle: terminal, shell: basename(executable), ...size,
      buffer: Buffer.alloc(0), seq: 0, listeners: new Set() }
    entries.set(entry.id, entry)
    // Drain output before publishing exit; done may settle before its final bytes arrive.
    const output = (async () => {
      for await (const chunk of terminal.output) {
        if (entry.closed) continue
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        entry.seq += bytes.length
        const buffer = bytes.length >= BUFFER_MAX ? bytes : Buffer.concat([entry.buffer, bytes])
        let start = Math.max(0, buffer.length - BUFFER_MAX)
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
        entry.buffer = Buffer.from(buffer.subarray(start))
        notify(entry)
      }
    })()
    const observed = promise => Promise.resolve(promise).catch(async () => {
      entry.exited = { code: null, signal: null, failed: true }
      notify(entry)
      await terminate(entry).catch(() => {})
      throw new Error('Terminal interrupted')
    })
    void Promise.allSettled([observed(output), observed(terminal.done)]).then(results => {
      const outcome = results[1].status === 'fulfilled' ? results[1].value : undefined
      entry.exited = { code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null,
        failed: results.some(result => result.status === 'rejected') }
      notify(entry)
    })
    if (disposed || signal.aborted || !active(entry)) { close(entry); throw new Error('Terminal unavailable') }
    return describe(entry)
  }

  const stream = (entry, since, signal) => {
    let cursor = Math.min(since, entry.seq), cancelled = false, wake
    const stop = () => { cancelled = true; if (wake) { entry.listeners.delete(wake); wake() } }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const finish = () => { stop(); signal.removeEventListener('abort', stop) }
    const encode = frame => new TextEncoder().encode(JSON.stringify(frame) + '\n')
    return new Response(new ReadableStream({
      async pull(controller) {
        while (!cancelled) {
          if (entry.closed) {
            controller.enqueue(encode({ type: 'exit', seq: cursor, code: null, signal: null }))
            finish(); controller.close(); return
          }
          const start = entry.seq - entry.buffer.length
          if (cursor < start) { cursor = start; controller.enqueue(encode({ type: 'reset', seq: start })); return }
          if (cursor < entry.seq) {
            const from = cursor, bytes = entry.buffer.subarray(cursor - start)
            cursor = entry.seq
            controller.enqueue(encode({ type: 'output', from, seq: cursor, data: bytes.toString('base64') }))
            return
          }
          if (entry.exited) {
            controller.enqueue(encode({ type: 'exit', seq: cursor, ...entry.exited }))
            finish(); controller.close(); return
          }
          await new Promise(resolve => { wake = resolve; entry.listeners.add(wake) })
        }
        finish(); controller.close()
      },
      cancel: finish,
    }), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/nodo/terminal', methods: ['POST', 'GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        await rt.refresh()
        if (disposed) throw new Error('Terminal unavailable')
        if (request.method === 'GET') {
          const query = new URL(request.url).searchParams
          const entry = findEntry({ id: query.get('id'), profile: query.get('profile'), session: query.get('session') })
          const since = Number(query.get('since') ?? 0)
          if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid terminal stream')
          return stream(entry, since, request.signal)
        }
        const body = await request.json()
        let value
        if (body.op === 'create') {
          const operation = create(body)
          pending.add(operation)
          try { value = await operation } finally { pending.delete(operation) }
        } else if (body.op === 'list') {
          const { profile, session } = rt.conversation(body.profile, body.session)
          value = { available: available() && rt.readOnly() == null && !profile.deletedAt && !session.archivedAt,
            terminals: [...entries.values()].filter(entry => entry.profile === profile.id && entry.session === session.id).map(describe) }
        } else {
          const entry = findEntry(body)
          if (body.op === 'close') close(entry)
          else if (body.op === 'write' && !entry.exited && typeof body.data === 'string' && Buffer.byteLength(body.data) <= INPUT_MAX) await entry.handle.write(body.data)
          else if (body.op === 'resize' && !entry.exited) {
            const size = dimensions(body)
            await entry.handle.resize(size.cols, size.rows)
            Object.assign(entry, size)
          }
          else throw new Error('Invalid terminal operation')
          value = null
        }
        return Response.json({ ok: true, value })
      } catch (error) {
        // Provider errors can contain command output; keep them out of diagnostics and responses.
        const missing = error?.code === 'terminal/not-found'
        return Response.json({ ok: false, error: { code: missing ? 'terminal/not-found' : 'terminal/failed', message: missing ? '终端不存在' : '终端操作失败' } }, { status: missing ? 404 : 400 })
      }
    },
  }), 'nodo: terminal route')
  ctx.effect(() => async () => {
    disposed = true
    await terminateAll()
  }, 'nodo: terminals')
}
