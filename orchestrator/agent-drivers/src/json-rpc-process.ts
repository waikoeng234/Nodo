// Reusable stdio JSON-RPC transport. Protocol methods and event translation
// belong to adapters, so another JSONL CLI need not duplicate process plumbing.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { Duplex } from 'node:stream'
import type { HostWebSocketConstructor } from './websocket.js'

export type RpcId = string | number
export type JsonRpcMessage<Params = unknown> = { id?: RpcId; method: string; params?: Params }
export type JsonRpcRequest<Params = unknown> = JsonRpcMessage<Params> & { id: RpcId }
export type JsonRpcProcessOptions<Params = unknown> = {
  bin: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  jsonrpc?: string
  WebSocket?: HostWebSocketConstructor
  onNotification?: (message: JsonRpcMessage<Params>) => void
  onRequest?: (message: JsonRpcRequest<Params>) => void
  onClose?: (error: Error) => void
}
export interface JsonRpcPeer {
  request<Result = unknown>(method: string, params?: unknown, timeout?: number | null): Promise<Result>
  notify(method: string, params?: unknown): void
  reply(id: RpcId, result: unknown): void
  refuse(id: RpcId, message?: string): void
  dispose(): void
}
type PendingRequest = { resolve: (result: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | null; method: string }
type RpcMessage = { method?: unknown; id?: unknown; error?: unknown; result?: unknown }
type RpcError = { message?: string; code?: unknown; data?: unknown }

export function jsonRpcProcess<Params = unknown>({ bin, args, cwd, env, jsonrpc, WebSocket, onNotification = () => {}, onRequest = () => {}, onClose = () => {} }: JsonRpcProcessOptions<Params>): JsonRpcPeer {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map<unknown, PendingRequest>()
  let sequence = 0
  let closed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let lines: Interface | undefined
  const socket = WebSocket ? new WebSocket('ws://localhost/', { createConnection: () => Duplex.from({ readable: child.stdout, writable: child.stdin }) }) : null
  const write = (message: Record<string, unknown>) => {
    if (closed || child.stdin.destroyed) throw new Error('CLI connection is closed')
    const encoded = JSON.stringify({ ...(jsonrpc ? { jsonrpc } : {}), ...message })
    if (!socket) child.stdin.write(`${encoded}\n`)
    else if (socket.readyState === WebSocket!.OPEN) socket.send(encoded)
    else socket.once('open', () => { if (!closed) socket.send(encoded) })
  }
  const finish = (error: Error) => {
    if (closed) return
    closed = true
    for (const { reject, timer } of pending.values()) { clearTimeout(timer!); reject(error) }
    pending.clear()
    try { onClose(error) } finally {
      socket?.terminate()
      lines?.close()
      child.stdin.end()
      child.stdout.destroy()
      child.stderr.destroy()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1000)
        killTimer.unref()
      }
    }
  }
  child.on('error', error => finish(new Error(`Cannot start CLI (${(error as NodeJS.ErrnoException).code ?? 'spawn failed'})`)))
  child.stdin.on('error', () => finish(new Error('Cannot write to CLI')))
  // CLI stderr can contain provider credentials or configuration diagnostics.
  // Keep only a short tail to explain exit failures, dropping lines that name
  // secrets, and never return raw output to the browser or transcripts.
  let stderrTail = ''
  child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024) })
  const stderrHint = () => {
    const text = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-400).trim()
    return text ? `: ${text}` : ''
  }
  const exited = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`CLI exited (${code ?? signal})${stderrHint()}`))
  child.on('close', (code, signal) => { clearTimeout(killTimer); clearTimeout(exitTimer); exited(code, signal) })
  // A descendant that inherited stdout keeps `close` from firing after the CLI itself exits.
  child.on('exit', (code, signal) => {
    clearTimeout(killTimer)
    exitTimer = setTimeout(exited, 1000, code, signal)
    exitTimer.unref()
  })
  const receive = (line: string) => {
    if (closed) return
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object') return
    if ((message as RpcMessage).method) {
      try {
        if ((message as RpcMessage).id !== undefined) onRequest(message as JsonRpcRequest<Params>)
        else onNotification(message as JsonRpcMessage<Params>)
      } catch { finish(new Error('Invalid CLI protocol event')) }
      return
    }
    const request = pending.get((message as RpcMessage).id)
    if (!request) return
    pending.delete((message as RpcMessage).id)
    clearTimeout(request.timer!)
    if ((message as RpcMessage).error) request.reject(Object.assign(new Error(((message as RpcMessage).error as RpcError).message ?? 'CLI request failed'), { code: ((message as RpcMessage).error as RpcError).code, data: ((message as RpcMessage).error as RpcError).data, method: request.method }))
    else request.resolve((message as RpcMessage).result)
  }
  if (socket) {
    socket.on('message', body => receive(body.toString()))
    socket.on('error', () => finish(new Error('Shared CLI WebSocket connection failed')))
    socket.on('close', () => finish(new Error('Shared CLI connection closed')))
  } else lines = createInterface({ input: child.stdout }).on('line', receive)

  return {
    request<Result = unknown>(method: string, params: unknown = {}, timeout: number | null = 15_000) {
      return new Promise<unknown>((resolve, reject) => {
        const id = ++sequence
        // ACP session/prompt settles only at turn completion; null leaves its
        // lifetime to the Agent's result or explicit cancel/dispose; host idle checks only warn.
        const timer = timeout === null ? null : setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`CLI request timed out: ${method}`), { name: 'TimeoutError' })) }, timeout)
        pending.set(id, { resolve, reject, timer, method })
        try { write({ id, method, params }) }
        catch (error) { pending.delete(id); clearTimeout(timer!); reject(error) }
      }) as Promise<Result>
    },
    notify(method, params = {}) { write({ method, params }) },
    reply(id, result) { write({ id, result }) },
    refuse(id, message = 'Unsupported client request') { write({ id, error: { code: -32601, message } }) },
    dispose() {
      finish(new Error('CLI connection disposed'))
    },
  }
}
